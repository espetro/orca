import { useCallback, useRef, type RefObject } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../../../transport/rpc-client'
import { sendMobileTerminalQueryReply } from '../../terminal/mobile-terminal-query-reply'
import { countTerminalGestureInputSequences } from '../../terminal/terminal-gesture-input'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import {
  isGestureMouseTrackingMode,
  TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
  TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS,
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS,
  TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
} from '../mobile-session-route-helpers'
import type {
  MobileSessionTabType,
  Terminal,
  TerminalGestureInputBucket,
  TerminalGestureInputQueue
} from '../mobile-session-route-types'
import type { TerminalModes } from '../terminal/terminal-webview-contract'

type UseSessionTerminalActionsDeps = {
  client: RpcClient | null
  connState: string
  showToast: (message: string, durationMs?: number) => void
  getTerminalRef: (handle: string | null) => { clear: () => void } | null
  activeHandleRef: RefObject<string | null>
  activeSessionTabTypeRef: RefObject<MobileSessionTabType | null>
  clientRef: RefObject<RpcClient | null>
  connStateRef: RefObject<ConnectionState>
  deviceTokenRef: RefObject<string | null>
  hostQueryReplyInputSupportedRef: RefObject<boolean>
  terminalUnsubsRef: RefObject<Map<string, () => void>>
}

/**
 * Terminal-action handlers owned by the session screen: gesture-input rate
 * limiting/queuing, query replies, clear, and PTY mode tracking. Gesture queue
 * state moves with these handlers.
 */
export function useSessionTerminalActions({
  client,
  connState,
  showToast,
  getTerminalRef,
  activeHandleRef,
  activeSessionTabTypeRef,
  clientRef,
  connStateRef,
  deviceTokenRef,
  hostQueryReplyInputSupportedRef,
  terminalUnsubsRef
}: UseSessionTerminalActionsDeps) {
  const ptyModesRef = useRef<Map<string, TerminalModes>>(new Map())
  const initialModesSeenRef = useRef<Set<string>>(new Set())
  const terminalGestureInputBucketsRef = useRef<Map<string, TerminalGestureInputBucket>>(new Map())
  const terminalGestureInputQueuesRef = useRef<Map<string, TerminalGestureInputQueue>>(new Map())
  const terminalGestureInputInFlightRef = useRef<Set<string>>(new Set())

  const allowTerminalGestureInput = useCallback(
    (handle: string, sequenceCount: number): boolean => {
      const now = Date.now()
      const current = terminalGestureInputBucketsRef.current.get(handle) ?? {
        tokens: TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        lastRefillMs: now
      }
      const elapsedSeconds = Math.max(0, now - current.lastRefillMs) / 1000
      const tokens = Math.min(
        TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        current.tokens + elapsedSeconds * TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
      )

      // Why: tokens count terminal control sequences, not WebView messages; one gesture may batch up to 32 wheel/key reports.
      if (tokens < sequenceCount) {
        terminalGestureInputBucketsRef.current.set(handle, { tokens, lastRefillMs: now })
        return false
      }

      terminalGestureInputBucketsRef.current.set(handle, {
        tokens: tokens - sequenceCount,
        lastRefillMs: now
      })
      return true
    },
    []
  )

  const flushTerminalGestureInput = useCallback(async (handle: string) => {
    const queued = terminalGestureInputQueuesRef.current.get(handle)
    if (!queued) {
      return
    }
    if (queued.timer) {
      clearTimeout(queued.timer)
      queued.timer = null
    }
    if (terminalGestureInputInFlightRef.current.has(handle)) {
      return
    }

    terminalGestureInputQueuesRef.current.delete(handle)
    const isActive =
      handle === activeHandleRef.current && activeSessionTabTypeRef.current === 'terminal'
    const isFresh = Date.now() - queued.lastUpdatedMs <= TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
    const rpc = clientRef.current
    if (!rpc || connStateRef.current !== 'connected' || !isActive || !isFresh) {
      return
    }

    terminalGestureInputInFlightRef.current.add(handle)
    try {
      // Why: gesture arrows parked across a reconnect would move a TUI long after the swipe.
      await rpc.sendRequest(
        'terminal.send',
        buildTerminalSendParams({
          terminal: handle,
          text: queued.bytes,
          enter: false,
          deviceToken: deviceTokenRef.current
        }),
        TERMINAL_INPUT_SEND_OPTIONS
      )
    } catch {
      // Transient failure
    } finally {
      terminalGestureInputInFlightRef.current.delete(handle)
      const next = terminalGestureInputQueuesRef.current.get(handle)
      if (next) {
        if (Date.now() - next.lastUpdatedMs > TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS) {
          if (next.timer) {
            clearTimeout(next.timer)
          }
          terminalGestureInputQueuesRef.current.delete(handle)
        } else {
          void flushTerminalGestureInput(handle)
        }
      }
    }
  }, [])

  const enqueueTerminalGestureInput = useCallback(
    (handle: string, bytes: string, sequenceCount: number) => {
      const now = Date.now()
      const current = terminalGestureInputQueuesRef.current.get(handle)
      if (
        current &&
        current.sequenceCount + sequenceCount <= TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES
      ) {
        current.bytes += bytes
        current.sequenceCount += sequenceCount
        current.lastUpdatedMs = now
        return
      }

      if (current) {
        if (current.timer) {
          clearTimeout(current.timer)
        }
        if (!terminalGestureInputInFlightRef.current.has(handle)) {
          void flushTerminalGestureInput(handle)
        } else {
          // Why: cap is a soft guideline — append instead of dropping queued bytes; the in-flight flush picks up the merged queue.
          current.bytes += bytes
          current.sequenceCount += sequenceCount
          current.lastUpdatedMs = now
          current.timer = setTimeout(() => {
            current.timer = null
            void flushTerminalGestureInput(handle)
          }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
          return
        }
      }

      const queued: TerminalGestureInputQueue = {
        bytes,
        sequenceCount,
        timer: null,
        lastUpdatedMs: now
      }
      queued.timer = setTimeout(() => {
        queued.timer = null
        void flushTerminalGestureInput(handle)
      }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
      terminalGestureInputQueuesRef.current.set(handle, queued)
    },
    [flushTerminalGestureInput]
  )

  const handleTerminalInput = useCallback(
    async (handle: string, bytes: string) => {
      if (!client || connState !== 'connected' || bytes.length === 0) {
        return
      }
      if (handle !== activeHandleRef.current || activeSessionTabTypeRef.current !== 'terminal') {
        return
      }
      const modes = ptyModesRef.current.get(handle)
      // Why: WebView gesture bytes can become PTY input, so gate mouse reports behind validation and SSH-safe rate limiting.
      if (!modes?.altScreen && !isGestureMouseTrackingMode(modes?.mouseTrackingMode)) {
        return
      }
      const sequenceCount = countTerminalGestureInputSequences(bytes)
      if (sequenceCount == null) {
        return
      }
      if (!allowTerminalGestureInput(handle, sequenceCount)) {
        return
      }
      enqueueTerminalGestureInput(handle, bytes, sequenceCount)
    },
    [allowTerminalGestureInput, client, connState, enqueueTerminalGestureInput]
  )

  const handleTerminalQueryReply = useCallback((handle: string, bytes: string) => {
    void sendMobileTerminalQueryReply({
      bytes,
      client: clientRef.current,
      clientId: deviceTokenRef.current,
      connected: connStateRef.current === 'connected',
      handle,
      hostSupportsQueryReplyInput: hostQueryReplyInputSupportedRef.current,
      subscribedTerminals: terminalUnsubsRef.current
    })
  }, [])

  const handleClearTerminal = useCallback(
    async (target: Terminal) => {
      if (!client) {
        return
      }
      getTerminalRef(target.handle)?.clear()
      try {
        await client.sendRequest('terminal.clearBuffer', {
          terminal: target.handle
        })
        showToast('Terminal cleared')
      } catch {
        showToast("Couldn't clear terminal", 1500)
      }
    },
    [client, getTerminalRef, showToast]
  )

  const handleModesChanged = useCallback((handle: string, modes: TerminalModes) => {
    ptyModesRef.current.set(handle, modes)
    initialModesSeenRef.current.add(handle)
  }, [])

  const clearGestureInputForHandle = useCallback((handle: string) => {
    terminalGestureInputBucketsRef.current.delete(handle)
    const queued = terminalGestureInputQueuesRef.current.get(handle)
    if (queued?.timer) {
      clearTimeout(queued.timer)
    }
    terminalGestureInputQueuesRef.current.delete(handle)
    terminalGestureInputInFlightRef.current.delete(handle)
  }, [])

  const discardAllGestureInput = useCallback(() => {
    for (const queued of terminalGestureInputQueuesRef.current.values()) {
      if (queued.timer) {
        clearTimeout(queued.timer)
      }
    }
    terminalGestureInputQueuesRef.current.clear()
    terminalGestureInputInFlightRef.current.clear()
  }, [])

  return {
    ptyModesRef,
    initialModesSeenRef,
    terminalGestureInputBucketsRef,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    handleTerminalInput,
    handleTerminalQueryReply,
    handleClearTerminal,
    handleModesChanged,
    clearGestureInputForHandle,
    discardAllGestureInput
  }
}
