import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { useNativeChatHandlers } from './use-terminal-pane-native-chat'
import { canContinueAgentSessionInNewSession } from './terminal-agent-session-continuation'
import { nativeChatLaunchAgentForLeaf } from '../native-chat/native-chat-send-eligibility'

type UseTerminalPaneChatSessionArgs = {
  chatLeafId: string | null
  setChatLeafId: (id: string | null) => void
  tabWideAgentHintLeafId: string | null | undefined
  setTabWideAgentHintLeafId: (id: string | null | undefined) => void
  agentSessionFork: PreparedAgentSessionFork | null
  setAgentSessionFork: (fork: PreparedAgentSessionFork | null) => void
  agentSessionContinuation: AgentSessionContinuationRequest | null
  setAgentSessionContinuation: (continuation: AgentSessionContinuationRequest | null) => void
  paneCount: number
  managerRef: React.MutableRefObject<any | null>
  nativeChatEnabled: boolean
  nativeChatTranscriptIsLocalReadable: boolean
  structuredSessionAgent: string | null
  isChatViewMode: boolean
  structuredSessionId: string | null
  unifiedTabId: string | null
  setTabViewMode: (mode: boolean) => void
  tabAgentTypeByLeaf: Record<string, string>
  terminalTab: any
  runtimePaneTitlesByPaneId: Record<number, string>
  unifiedTabLabel: string
}

type UseTerminalPaneChatSessionDeps = UseTerminalPaneChatSessionArgs & {
  expectedLayoutLeafIds: string[]
}

export function useTerminalPaneChatSession(args: UseTerminalPaneChatSessionDeps) {
  const {
    chatLeafId,
    setChatLeafId,
    tabWideAgentHintLeafId,
    setTabWideAgentHintLeafId,
    managerRef,
    nativeChatEnabled,
    nativeChatTranscriptIsLocalReadable,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    unifiedTabId,
    setTabViewMode,
    tabAgentTypeByLeaf,
    terminalTab,
    paneCount,
    runtimePaneTitlesByPaneId,
    unifiedTabLabel,
    expectedLayoutLeafIds
  } = args

  const onAgentExitedRef = useRef<(leafId: string) => void>(() => {})

  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane: ManagedPane) => pane.leafId) ?? []
    // Why: a partially hydrated manager can expose one pane of a restored split; union both sources so tab-wide evidence stays disabled.
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
  }, [managerRef, expectedLayoutLeafIds])

  const getTabWideAgentHintLeafId = useCallback((): string | null => {
    if (tabWideAgentHintLeafId !== undefined) {
      return tabWideAgentHintLeafId
    }
    const leafIds = getNativeChatLeafIds()
    return leafIds.length === 1 ? leafIds[0] : null
  }, [getNativeChatLeafIds, tabWideAgentHintLeafId])

  const getTabWideAgentHintLeafIdRef = useRef(getTabWideAgentHintLeafId)
  useEffect(() => {
    getTabWideAgentHintLeafIdRef.current = getTabWideAgentHintLeafId
  }, [getTabWideAgentHintLeafId])

  useEffect(() => {
    if (tabWideAgentHintLeafId !== undefined) {
      return
    }
    const leafIds = getNativeChatLeafIds()
    if (leafIds.length === 0) {
      return
    }
    // Why: tab-wide launch/title metadata predates leaf ownership; bind it only when the first topology proves the sole leaf it describes.
    setTabWideAgentHintLeafId(leafIds.length === 1 ? leafIds[0] : null)
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId, setTabWideAgentHintLeafId])

  const resolveTitleAgentForLeaf = useCallback(
    (leafId: string | null) => {
      const hasSingleKnownLeaf =
        getNativeChatLeafIds().length === 1 && getTabWideAgentHintLeafId() === leafId
      return resolveNativeChatLeafTitleAgent({
        leafId,
        panes: managerRef.current?.getPanes() ?? [],
        runtimePaneTitlesByPaneId,
        tabLabel: hasSingleKnownLeaf ? unifiedTabLabel : null,
        terminalTitle: hasSingleKnownLeaf ? terminalTab?.title : null
      })
    },
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel,
      managerRef
    ]
  )

  const nativeChatHandlers = useNativeChatHandlers({
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
  })

  const {
    isChatEligibleForLeaf,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen
  } = nativeChatHandlers

  // A split can host different agents, so continuation resolves the specific leaf before using tab-wide hints.
  const resolveAgentForLeaf = useCallback(
    (leafId: string | null): string | null => {
      const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
      if (detectedAgent) {
        return detectedAgent
      }
      return (
        nativeChatLaunchAgentForLeaf({
          launchAgent: terminalTab?.launchAgent,
          launchAgentLeafId: getTabWideAgentHintLeafId(),
          leafId,
          leafIds: getNativeChatLeafIds()
        }) ?? resolveTitleAgentForLeaf(leafId)
      )
    },
    [tabAgentTypeByLeaf, terminalTab?.launchAgent, getTabWideAgentHintLeafId, getNativeChatLeafIds, resolveTitleAgentForLeaf]
  )

  const activePaneCanContinueInNewSession = useMemo(
    () => {
      const activePane = managerRef.current?.getActivePane()
      return canContinueAgentSessionInNewSession(
        resolveAgentForLeaf(activePane?.leafId ?? null)
      )
    },
    [managerRef, resolveAgentForLeaf, paneCount]
  )

  const getContextMenuCanContinueInNewSession = useCallback(
    (contextMenuLeafId: string | null) => {
      return canContinueAgentSessionInNewSession(
        resolveAgentForLeaf(contextMenuLeafId)
      )
    },
    [resolveAgentForLeaf]
  )

  return {
    onAgentExitedRef,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    isChatEligibleForLeaf,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen,
    resolveAgentForLeaf,
    activePaneCanContinueInNewSession,
    getContextMenuCanContinueInNewSession,
    nativeChatHandlers
  }
}
