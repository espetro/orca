import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AppState } from '../store'

// Why: one module owns the mutable mirror-tracking maps so every consumer shares
// a single instance; duplicating any of these would fork the freshness fences.

export type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

export type ReceivedSessionTabsSnapshot = SnapshotFreshness & {
  receivedFrame: number
}

export type SessionTabsRecoveryState = {
  pendingCount: number
}

export type SessionTabsRemovalFence = {
  receivedFrame: number
  recoveryState: SessionTabsRecoveryState
  pendingCount: number
}

export type TrackedWebSessionTabsWorktree = {
  worktree: string
  freshness: SnapshotFreshness
}

export const latestSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()
export const replayableSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()
export const latestReceivedSessionTabsSnapshotByWorktree = new Map<
  string,
  ReceivedSessionTabsSnapshot
>()
export const latestSessionTabsRemovalFenceByWorktree = new Map<string, SessionTabsRemovalFence>()
export const sessionTabsRecoveryStateByWorktree = new Map<string, SessionTabsRecoveryState>()
export const trackedSessionTabsWorktreeIdsByEnvironment = new Map<string, Set<string>>()
export const sessionTabsEnvironmentsByWorktree = new Map<string, Set<string>>()
export const sessionTabsTrackingGenerationByEnvironment = new Map<string, number>()
export const lastHostTerminalTabCountByWorktree = new Map<string, number>()
export const hostSessionTabIdByLocalKey = new Map<string, string>()
export const hostSessionTabMappingKeysByEnvironmentAndWorktree = new Map<
  string,
  Map<string, Set<string>>
>()

export type WebSessionTabsSyncState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeBrowserTabIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'browserPagesByWorkspace'
  | 'browserCertificateFailuresByPageId'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'ptyIdsByTabId'
  | 'remoteBrowserPageHandlesByPageId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'
  | 'sortEpoch'
> &
  Partial<
    Pick<
      AppState,
      | 'acknowledgedAgentsByPaneKey'
      | 'agentLaunchConfigByPaneKey'
      | 'automaticAgentResumeClaimsByTabId'
      | 'migrationUnsupportedByPtyId'
      | 'paneForegroundAgentByPaneKey'
      | 'pendingStartupByTabId'
      | 'recentlyClosedAgentStatusTabIds'
      | 'recentlyRetiredAgentStatusPaneKeys'
      | 'retainedAgentsByPaneKey'
      | 'retentionSuppressedPaneKeys'
    >
  >

export const HOST_WORKING_CLIENT_BOUNDARY_LIMIT = 512
// Why: a delayed host stamp belongs to the client boundary seen with its preceding ordered frame.
export const hostWorkingClientBoundaryByPaneKey = new Map<
  string,
  {
    hostStateStartedAt: number
    hostPrompt: string
    clientStateStartedAt: number
    stamped: boolean
  }
>()

export function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

let receivedSessionTabsFrameSequence = 0

export function nextReceivedSessionTabsFrame(): number {
  return (receivedSessionTabsFrameSequence += 1)
}

export function peekReceivedSessionTabsFrameSequence(): number {
  return receivedSessionTabsFrameSequence
}

export function resetReceivedSessionTabsFrameSequenceForTests(): void {
  receivedSessionTabsFrameSequence = 0
}

export function advancesSessionTabsFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  baseline: SnapshotFreshness
): boolean {
  return (
    snapshot.publicationEpoch !== baseline.publicationEpoch ||
    snapshot.snapshotVersion > baseline.snapshotVersion
  )
}
