import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

export type RuntimeMobileSessionTabSnapshotCommandsDeps = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  mobileSessionTabListeners: Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
    clientNavigationId?: string
  }>
  mobileSessionTabsChangeSequence: { value: number }
  offscreenBrowserBackend: unknown
  agentBrowserBridge: { tabList: (worktreeId: string) => { tabs: unknown[] } } | undefined
  notifyMobileSessionTabsChanged(worktreeId: string): void
  scheduleMobileSessionTabsChanged(worktreeId: string): void
  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | undefined
  getWorkspaceSessionForHostId(hostId: ExecutionHostId): WorkspaceSessionState | undefined
  tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null
  setWorkspaceSession(session: WorkspaceSessionState, hostId: ExecutionHostId): void
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
  canSetWorkspaceSession(): boolean
  flushOrThrow?: () => void
  hasHostAuthoritativeTerminalMembership(
    session: WorkspaceSessionState | undefined,
    worktreeId: string
  ): boolean
  terminalTopologyRevisionByRepoId: Map<string, number>
  ptysById: Map<string, { connected: boolean; paneKey: string; worktreeId: string; tabId: string }>
  parsePaneKey(key: string): { leafId: string } | null
  buildHeadlessTerminalSplitLayout(
    layout: TerminalLayoutSnapshot,
    options: {
      leafId: string
      ptyId: string
      splitFromLeafId: string
      direction: 'horizontal' | 'vertical'
    }
  ): TerminalLayoutSnapshot
  getRuntimeInstance(): unknown
  toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult
  projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
  withClientHostedPagesHold(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
}
