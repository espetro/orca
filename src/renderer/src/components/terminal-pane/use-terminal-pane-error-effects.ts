import { useCallback, useEffect, useRef } from 'react'
import { stripSshReconnectOwnedErrorLines } from './TerminalErrorToast'
import { resolveNativeChatLeafRoute } from './native-chat-leaf-route-resolution'
import type { PtyTransport } from './pty-transport'

export type UseTerminalPaneErrorEffectsArgs = {
  terminalError: string | null
  setTerminalError: (error: string | null) => void
  showSshReconnectOverlay: boolean
  isChatViewMode: boolean
  chatLeafId: string | null
  activeLeafId: string | null
  chatLeafStillMounted: boolean
  applyNativeChatLeafRoute: (route: unknown) => void
  isChatEligibleForLeaf: (leafId: string | null) => boolean
  structuredSessionId: string | null
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
}

export function useTerminalPaneErrorEffects({
  terminalError,
  setTerminalError,
  showSshReconnectOverlay,
  isChatViewMode,
  chatLeafId,
  activeLeafId,
  chatLeafStillMounted,
  applyNativeChatLeafRoute,
  isChatEligibleForLeaf,
  structuredSessionId,
  paneTransportsRef
}: UseTerminalPaneErrorEffectsArgs) {
  const dismissTerminalError = useCallback(() => {
    setTerminalError(null)
    for (const transport of paneTransportsRef.current.values()) {
      transport.notifyErrorSurfaceDismissed?.()
    }
  }, [setTerminalError, paneTransportsRef])

  // Strip SSH-owned error lines when SSH reconnect overlay is active.
  useEffect(() => {
    if (!showSshReconnectOverlay || terminalError == null) {
      return
    }
    const kept = stripSshReconnectOwnedErrorLines(terminalError)
    if (kept !== terminalError) {
      setTerminalError(kept)
    }
  }, [showSshReconnectOverlay, terminalError, setTerminalError])

  // Route native chat leaf based on view mode and pane eligibility.
  useEffect(() => {
    const route = resolveNativeChatLeafRoute({
      isChatViewMode,
      chatLeafId,
      activeLeafId,
      chatLeafStillMounted,
      activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId),
      structuredSessionId
    })
    applyNativeChatLeafRoute(route)
  }, [
    isChatViewMode,
    chatLeafId,
    activeLeafId,
    chatLeafStillMounted,
    applyNativeChatLeafRoute,
    isChatEligibleForLeaf,
    structuredSessionId
  ])

  return { dismissTerminalError }
}
