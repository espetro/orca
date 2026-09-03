import { useCallback, useEffect } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  canToggleNativeChat,
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute
} from './native-chat-utils'
import type { NativeChatLeafRoute } from './native-chat-leaf-route'

export type NativeChatHandlers = {
  isChatEligibleForLeaf: (leafId: string | null) => boolean
  applyNativeChatLeafRoute: (route: NativeChatLeafRoute) => void
  handleConfirmedAgentExit: (leafId: string) => void
  switchNativeChatToTerminal: () => void
  readNativeChatTerminalScreen: () => string | null
}

export function useNativeChatHandlers(args: {
  chatLeafId: string | null
  setChatLeafId: (leafId: string | null) => void
  managerRef: React.RefObject<PaneManager | null>
  onAgentExitedRef: React.MutableRefObject<(leafId: string) => void>
  nativeChatEnabled: boolean
  nativeChatTranscriptIsLocalReadable: boolean
  structuredSessionAgent: string | null | undefined
  isChatViewMode: boolean
  structuredSessionId: string | null
  unifiedTabId: string | undefined
  setTabViewMode: (tabId: string, mode: 'editor' | 'chat') => void
  tabAgentTypeByLeaf: Record<string, string | null>
  terminalTab: unknown
  getNativeChatLeafIds: () => string[]
  getTabWideAgentHintLeafId: () => string | null
  resolveTitleAgentForLeaf: (leafId: string | null) => string | undefined
}): NativeChatHandlers {
  const {
    chatLeafId,
    setChatLeafId,
    managerRef,
    onAgentExitedRef,
    nativeChatEnabled,
    nativeChatTranscriptIsLocalReadable,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    unifiedTabId,
    setTabViewMode,
    tabAgentTypeByLeaf,
    terminalTab,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    resolveTitleAgentForLeaf
  } = args

  const isChatEligibleForLeaf = useCallback(
    (leafId: string | null): boolean => {
      const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
      const launchAgent = nativeChatLaunchAgentForLeaf({
        launchAgent: (terminalTab as { launchAgent?: string | null })?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      })
      return canToggleNativeChat({
        experimentalNativeChatEnabled: nativeChatEnabled,
        contentType: 'terminal',
        launchAgent: detectedAgent ? null : launchAgent,
        detectedAgent,
        resolvedAgent: detectedAgent
          ? null
          : ((structuredSessionAgent as TuiAgent | null) ?? resolveTitleAgentForLeaf(leafId)),
        nativeChatTranscriptIsLocalReadable
      })
    },
    [
      tabAgentTypeByLeaf,
      nativeChatEnabled,
      structuredSessionAgent,
      nativeChatTranscriptIsLocalReadable,
      terminalTab,
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      resolveTitleAgentForLeaf
    ]
  )
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    [chatLeafId, setChatLeafId, setTabViewMode, unifiedTabId]
  )
  const handleConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      if (leafId !== chatLeafId) {
        return
      }
      const panes = managerRef.current?.getPanes() ?? []
      const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
      applyNativeChatLeafRoute(
        resolveNativeChatLeafRoute({
          isChatViewMode,
          chatLeafId,
          activeLeafId,
          chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
          activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId),
          chatLeafHasConfirmedAgentExit: true,
          structuredSessionId
        })
      )
    },
    [
      applyNativeChatLeafRoute,
      chatLeafId,
      isChatViewMode,
      structuredSessionId,
      isChatEligibleForLeaf
    ]
  )
  useEffect(() => {
    onAgentExitedRef.current = handleConfirmedAgentExit
  }, [handleConfirmedAgentExit, onAgentExitedRef])
  const switchNativeChatToTerminal = useCallback(() => {
    if (chatLeafId && unifiedTabId) {
      setChatLeafId(null)
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [chatLeafId, setChatLeafId, setTabViewMode, unifiedTabId])
  const readNativeChatTerminalScreen = useCallback((): string | null => {
    if (!chatLeafId) {
      return null
    }
    const pane = managerRef.current?.getPanes().find((candidate) => candidate.leafId === chatLeafId)
    return pane?.serializeAddon.serialize({ scrollback: 0 }) ?? null
  }, [chatLeafId, managerRef])

  return {
    isChatEligibleForLeaf,
    applyNativeChatLeafRoute,
    handleConfirmedAgentExit,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen
  }
}
