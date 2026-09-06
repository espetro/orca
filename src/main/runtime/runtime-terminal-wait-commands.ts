import type { MessageWaitResult } from './runtime-contracts'
import type { TerminalWaiter } from './runtime-contracts'
import type { RuntimeTerminalWait, RuntimeTerminalWaitCondition } from '../../shared/runtime-types'
import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-message-wait-timeout'
import {
  TUI_IDLE_DEFAULT_TIMEOUT_MS,
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult,
  buildTerminalWaitText,
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason,
  getTerminalState,
  isKnownReadyPromptPreview
} from './runtime-tail-projection'
import type { MessageWaiter } from './orca-runtime'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export function waitForMessage(
  ctx: Ctx,
  handle: string,
  options?: {
    typeFilter?: string[]
    timeoutMs?: number
    signal?: AbortSignal
    exclusive?: boolean
  }
): Promise<MessageWaitResult> {
  return new Promise((resolve) => {
    const currentWaiters = ctx.deps.messageWaitersByHandle().get(handle)
    if (options?.exclusive && currentWaiters && currentWaiters.size > 0) {
      resolve('waiter_exists')
      return
    }
    const timeoutMs = options?.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS

    const waiter: MessageWaiter = {
      handle,
      typeFilter: options?.typeFilter,
      resolve,
      timeout: null,
      abortCleanup: null
    }

    // Why: on caller abort (RPC socket closed — design doc §3.1), resolve now to release the long-poll slot instead of waiting out timeoutMs.
    const signal = options?.signal
    const onAbort = (): void => {
      ctx.removeMessageWaiter(waiter)
      resolve('cancelled')
    }
    if (signal) {
      if (signal.aborted) {
        resolve('cancelled')
        return
      }
      waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
    }

    waiter.timeout = setTimeout(() => {
      ctx.removeMessageWaiter(waiter)
      resolve('timed_out')
    }, timeoutMs)

    let waiters = ctx.deps.messageWaitersByHandle().get(handle)
    if (!waiters) {
      waiters = new Set()
      ctx.deps.messageWaitersByHandle().set(handle, waiters)
    }
    waiters.add(waiter)
  })
}

export function waitForNewLeafInTab(
  ctx: Ctx,
  tabId: string,
  existingLeafKeys: Set<string>,
  timeoutMs = 10_000
): Promise<string> {
  const tryResolve = (): string | null => {
    for (const [key, leaf] of ctx.deps.leaves()) {
      if (leaf.tabId === tabId && !existingLeafKeys.has(key) && leaf.ptyId !== null) {
        return ctx.issueHandle(leaf)
      }
    }
    return null
  }

  const existing = tryResolve()
  if (existing) {
    return Promise.resolve(existing)
  }

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = ctx.deps.graphSyncCallbacks().indexOf(check)
      if (idx !== -1) {
        ctx.deps.graphSyncCallbacks().splice(idx, 1)
      }
      reject(new Error('Timed out waiting for split pane handle'))
    }, timeoutMs)

    const check = (): void => {
      const handle = tryResolve()
      if (handle) {
        clearTimeout(timer)
        const idx = ctx.deps.graphSyncCallbacks().indexOf(check)
        if (idx !== -1) {
          ctx.deps.graphSyncCallbacks().splice(idx, 1)
        }
        resolve(handle)
      }
    }
    ctx.deps.graphSyncCallbacks().push(check)
    check()
  })
}

export async function waitForTerminal(
  ctx: Ctx,
  handle: string,
  options?: {
    condition?: RuntimeTerminalWaitCondition
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<RuntimeTerminalWait> {
  const condition = options?.condition ?? 'exit'
  const pty = ctx.getLivePtyForHandle(handle)
  if (pty) {
    if (condition === 'exit' && !pty.pty.connected) {
      return buildPtyTerminalWaitResult(handle, condition, pty.pty)
    }
    const ptyWaitText = buildTerminalWaitText(
      pty.pty.tailBuffer,
      pty.pty.tailPartialLine,
      pty.pty.preview
    )
    const ptyBlockedReason = detectTerminalWaitBlockedReason(ptyWaitText)
    if (condition === 'tui-idle' && ptyBlockedReason) {
      return buildPtyTerminalWaitBlockedResult(handle, condition, pty.pty, ptyBlockedReason)
    }
    if (condition === 'tui-idle' && pty.pty.lastAgentStatus === 'idle') {
      return buildPtyTerminalWaitResult(handle, condition, pty.pty)
    }
    if (
      condition === 'tui-idle' &&
      (ctx.getAdoptedPtyExplicitIdleStatus(pty.pty) === 'idle' ||
        isKnownReadyPromptPreview(ptyWaitText))
    ) {
      return buildPtyTerminalWaitResult(handle, condition, pty.pty)
    }
    return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
      const effectiveTimeoutMs =
        typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : condition === 'tui-idle'
            ? TUI_IDLE_DEFAULT_TIMEOUT_MS
            : 0
      const waiter: TerminalWaiter = {
        handle,
        condition,
        resolve,
        reject,
        timeout: null,
        pollInterval: null,
        abortCleanup: null
      }
      if (!ctx.bindTerminalWaiterAbort(waiter, options?.signal)) {
        reject(new Error('request_aborted'))
        return
      }
      if (effectiveTimeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          ctx.removeWaiter(waiter)
          reject(new Error('timeout'))
        }, effectiveTimeoutMs)
      }
      let waiters = ctx.deps.waitersByHandle().get(handle)
      if (!waiters) {
        waiters = new Set()
        ctx.deps.waitersByHandle().set(handle, waiters)
      }
      waiters.add(waiter)
      const live = ctx.getLivePtyForHandle(handle)
      if (!live) {
        ctx.removeWaiter(waiter)
        reject(new Error('terminal_handle_stale'))
      } else if (condition === 'exit' && !live.pty.connected) {
        ctx.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
      } else if (condition === 'tui-idle') {
        const livePtyWaitText = buildTerminalWaitText(
          live.pty.tailBuffer,
          live.pty.tailPartialLine,
          live.pty.preview
        )
        const blockedReason = detectTerminalWaitBlockedReason(livePtyWaitText)
        if (blockedReason) {
          ctx.resolveWaiter(
            waiter,
            buildPtyTerminalWaitBlockedResult(handle, condition, live.pty, blockedReason)
          )
        } else if (live.pty.lastAgentStatus === 'idle') {
          ctx.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        } else if (
          ctx.getAdoptedPtyExplicitIdleStatus(live.pty) === 'idle' ||
          isKnownReadyPromptPreview(livePtyWaitText)
        ) {
          ctx.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        } else {
          ctx.startPtyTuiIdleFallbackPoll(waiter, live.pty, effectiveTimeoutMs)
        }
      }
    })
  }
  const { leaf } = ctx.getLiveLeafForHandle(handle)

  if (condition === 'exit' && getTerminalState(leaf) === 'exited') {
    return buildTerminalWaitResult(handle, condition, leaf)
  }

  const leafWaitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
  const leafBlockedReason = detectTerminalWaitBlockedReason(leafWaitText)
  if (condition === 'tui-idle' && leafBlockedReason) {
    return buildTerminalWaitBlockedResult(handle, condition, leaf, leafBlockedReason)
  }

  // Why: if the agent already transitioned to idle (or permission) before the
  // waiter was registered, resolve immediately. This uses the same OSC title
  // detection that powers the renderer's "Task complete" notifications.
  // Why: only 'idle' satisfies tui-idle, not 'permission'. Permission means the
  // agent is blocked on user approval, not finished with its task.
  if (condition === 'tui-idle' && leaf.lastAgentStatus === 'idle') {
    return buildTerminalWaitResult(handle, condition, leaf)
  }
  if (condition === 'tui-idle') {
    const fastPathTitle = leaf.paneTitle ?? ctx.deps.tabs().get(leaf.tabId)?.title
    if (
      (fastPathTitle && detectExplicitIdleStatusFromTitle(fastPathTitle) === 'idle') ||
      isKnownReadyPromptPreview(leafWaitText)
    ) {
      return buildTerminalWaitResult(handle, condition, leaf)
    }
  }

  return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
    // Why: tui-idle depends on OSC title transitions from a recognized agent.
    // If no agent is detected, the waiter would hang forever. Enforce a default
    // timeout so unsupported CLIs fail predictably instead of silently blocking.
    const effectiveTimeoutMs =
      typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : condition === 'tui-idle'
          ? TUI_IDLE_DEFAULT_TIMEOUT_MS
          : 0

    const waiter: TerminalWaiter = {
      handle,
      condition,
      resolve,
      reject,
      timeout: null,
      pollInterval: null,
      abortCleanup: null
    }

    if (!ctx.bindTerminalWaiterAbort(waiter, options?.signal)) {
      reject(new Error('request_aborted'))
      return
    }

    if (effectiveTimeoutMs > 0) {
      waiter.timeout = setTimeout(() => {
        ctx.removeWaiter(waiter)
        reject(new Error('timeout'))
      }, effectiveTimeoutMs)
    }

    let waiters = ctx.deps.waitersByHandle().get(handle)
    if (!waiters) {
      waiters = new Set()
      ctx.deps.waitersByHandle().set(handle, waiters)
    }
    waiters.add(waiter)

    // Why: the handle may go stale or exit in the small gap between the first
    // validation and waiter registration. Re-checking here keeps wait --for
    // exit honest instead of hanging on a terminal that already changed.
    try {
      const live = ctx.getLiveLeafForHandle(handle)
      if (getTerminalState(live.leaf) === 'exited') {
        ctx.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
      } else if (condition === 'tui-idle') {
        const liveLeafWaitText = buildTerminalWaitText(
          live.leaf.tailBuffer,
          live.leaf.tailPartialLine,
          live.leaf.preview
        )
        const blockedReason = detectTerminalWaitBlockedReason(liveLeafWaitText)
        if (blockedReason) {
          ctx.resolveWaiter(
            waiter,
            buildTerminalWaitBlockedResult(handle, condition, live.leaf, blockedReason)
          )
        } else if (live.leaf.lastAgentStatus === 'idle') {
          // Why: don't clear lastAgentStatus here. It's a factual record of the
          // last detected OSC state, not a one-shot signal. Clearing it causes
          // subsequent tui-idle waiters to hang even though the agent is idle —
          // the first waiter consumes the status and all later ones see null.
          ctx.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
        } else {
          // Why: renderer-synced previews can show a known ready prompt even
          // while the last OSC title is still "working"; keep polling the
          // preview/title until the waiter resolves or hits its timeout.
          const fastPathTitle = live.leaf.paneTitle ?? ctx.deps.tabs().get(live.leaf.tabId)?.title
          if (
            (fastPathTitle && detectExplicitIdleStatusFromTitle(fastPathTitle) === 'idle') ||
            isKnownReadyPromptPreview(liveLeafWaitText)
          ) {
            ctx.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
          } else {
            ctx.startTuiIdleFallbackPoll(waiter, live.leaf, effectiveTimeoutMs)
          }
        }
      }
    } catch (error) {
      ctx.removeWaiter(waiter)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
