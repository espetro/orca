import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { getCachedUnifiedTerminalTabForWorktree } from './terminal-unified-tab-lookup'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { selectTerminalTabAgentTypesByLeaf } from './terminal-tab-agent-type-index'
import { EMPTY_LAYOUT } from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'

export type PaneStateSubscriptions = {
  setTabPaneExpanded: (tabId: string, paneId: number, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  suppressPtyExit: boolean
  pendingCodexPaneRestartIds: Set<number>
  consumePendingCodexPaneRestart: (paneId: number) => void
  clearCodexRestartNotice: (paneId: number) => void
  unifiedTabId: string | undefined
  structuredSessionAgent: string | null | undefined
  isChatViewMode: boolean
  structuredSessionId: string | null
  nativeChatEnabled: boolean
  effectiveChatViewMode: boolean
  chatPaneDispatchStatus: string | undefined
  unifiedTabLabel: string | undefined
  setTabViewMode: (tabId: string, mode: 'editor' | 'chat') => void
  runtimePaneTitlesByPaneId: Record<string, Record<number, string>>
  tabAgentTypeByLeaf: Record<string, string | null>
  savedLayout: ReturnType<typeof EMPTY_LAYOUT>
  terminalTab: ReturnType<typeof getCachedTerminalTabForWorktree> | undefined
}

export function usePaneStateSubscriptions(args: {
  tabId: string
  worktreeId: string
  chatLeafId: string | null
}): PaneStateSubscriptions {
  const cachedUnifiedTab = useAppStore((store) =>
    getCachedUnifiedTerminalTabForWorktree(store.unifiedTabsByWorktree, args.worktreeId, args.tabId)
  )

  const setTabPaneExpanded = useAppStore((store) => store.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((store) => store.setTabCanExpandPane)
  const suppressPtyExit = useAppStore((store) => store.suppressPtyExit)
  const pendingCodexPaneRestartIds = useAppStore((store) => store.pendingCodexPaneRestartIds)
  const consumePendingCodexPaneRestart = useAppStore(
    (store) => store.consumePendingCodexPaneRestart
  )
  const clearCodexRestartNotice = useAppStore((store) => store.clearCodexRestartNotice)
  const unifiedTabId = cachedUnifiedTab?.id
  const structuredSessionAgent = cachedUnifiedTab?.agentSessionAgent
  const isChatViewMode = cachedUnifiedTab?.viewMode === 'chat'
  const structuredSessionId = cachedUnifiedTab?.structuredSessionId ?? null
  const nativeChatEnabled = useAppStore((store) => store.settings?.experimentalNativeChat === true)
  const effectiveChatViewMode = nativeChatEnabled && isChatViewMode
  const chatPaneDispatchStatus = useAppStore((store) =>
    args.chatLeafId
      ? store.agentStatusByPaneKey[makePaneKey(args.tabId, args.chatLeafId)]?.orchestration
          ?.dispatchStatus
      : undefined
  )
  const unifiedTabLabel = cachedUnifiedTab?.label
  const setTabViewMode = useAppStore((store) => store.setTabViewMode)
  const runtimePaneTitlesByPaneId = useAppStore(
    useShallow((store) => store.runtimePaneTitlesByTabId[args.tabId] ?? {})
  )
  const tabAgentTypeByLeaf = useAppStore((store) =>
    selectTerminalTabAgentTypesByLeaf(
      store.agentStatusByPaneKey,
      args.tabId,
      store.paneForegroundAgentByPaneKey
    )
  )
  const savedLayout = useAppStore(
    (store) => store.terminalLayoutsByTabId[args.tabId] ?? EMPTY_LAYOUT
  )
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, args.worktreeId, args.tabId)
  )

  return {
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    pendingCodexPaneRestartIds,
    consumePendingCodexPaneRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    nativeChatEnabled,
    effectiveChatViewMode,
    chatPaneDispatchStatus,
    unifiedTabLabel,
    setTabViewMode,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    savedLayout,
    terminalTab
  }
}
