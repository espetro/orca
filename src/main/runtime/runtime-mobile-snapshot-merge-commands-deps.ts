import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

export type RuntimeMobileSnapshotMergeDeps = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  mobileSessionTabListeners: Set<{
    listener: (result: unknown, changeSequence: number) => void
    clientNavigationId: string
  }>
  mobileSessionTabsChangeSequence: { value: number }
  offscreenBrowserBackend: unknown
  mergeMobileSessionSnapshotTabs(a: unknown[], b: unknown[]): unknown[]
  mergeMobileSessionTabGroups(
    worktreeId: string,
    groups: readonly unknown[],
    terminalTabs: readonly unknown[],
    activeTab: unknown
  ): unknown[]
  getMobileSessionSnapshotTabIdentityKeys(tab: RuntimeMobileSessionSnapshotTab): string[]
  getHeadlessMobileSessionGroupId(worktreeId: string): string
  getRuntimeBrowserPageForTab(tab: RuntimeMobileSessionSnapshotTab, worktreeId: string): unknown
  sameRuntimeBrowserPlacement(a: unknown, b: unknown): boolean
  getLiveBrowserTabsByPageId(worktreeId: string): Map<string, unknown>
  hasLiveRuntimeSessionOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean
  hasLiveOrPersistedServeOrSshOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean
  toMobileSessionTabsResult(snapshot: RuntimeMobileSessionTabsSnapshot): unknown
  projectMobileSessionTabsForClient(result: unknown, clientNavigationId?: string): unknown
}
