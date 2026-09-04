import type { WorkspaceSessionState, RuntimeMobileSessionTabsSnapshot, TerminalPaneLayoutNode } from '../../shared/worktree/types'
import type { Store } from '../../shared/store'

export type RuntimeHeadlessSessionTabPersistenceDeps = {
  getWorkspaceSessionForWorktree: (worktreeId: string) => WorkspaceSessionState | null
  setWorkspaceSessionForWorktree: (worktreeId: string, session: WorkspaceSessionState) => void
  getMobileSessionTabsByWorktree: (worktreeId: string) => RuntimeMobileSessionTabsSnapshot | undefined
  setMobileSessionTabsByWorktree: (worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot) => void
  emitMobileSessionTabsSnapshot: (snapshot: RuntimeMobileSessionTabsSnapshot) => void
  setTerminalLayoutsByTabId: (tabId: string, layout: TerminalPaneLayoutNode | null) => void
  setExpandedLeafIdByTabId: (tabId: string, leafId: string | null) => void
  store: Store | null | undefined
}
