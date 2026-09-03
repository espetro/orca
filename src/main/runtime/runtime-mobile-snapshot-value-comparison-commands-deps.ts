import type { PtyControllerInventory, RuntimePtyWorktreeRecord } from '../providers/types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export type RuntimeMobileSnapshotValueComparisonDeps = {
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  tabs: Map<string, { id: string }>
  store: any // WorkspaceSessionState lookup methods
  startedAt: number
  pendingMobileTerminalCreatesByKey: Set<string>
  mobileSessionTabsByWorktree: Map<string, any>
  getWorkspaceSessionForWorktree: (worktreeId: string) => WorkspaceSessionState | null
  findPtyForMobileTerminalTab: (worktreeId: string, tab: any) => RuntimePtyWorktreeRecord | undefined
  getMobileSessionSnapshotTabIdentityKeys: (tab: any) => string[]
}
