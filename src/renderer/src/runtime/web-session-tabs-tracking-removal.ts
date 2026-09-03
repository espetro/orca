import { isTrackedWebSessionTabsOmissionCurrent } from './web-session-tabs-tracking'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import {
  lastHostTerminalTabCountByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  latestSessionTabsSnapshotByWorktree,
  sessionTabsFreshnessKey,
  sessionTabsRecoveryStateByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  type TrackedWebSessionTabsWorktree,
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree
} from './web-session-tabs-sync-state'
export const VISIBILITY_INVENTORY_REMOVAL_EPOCH = 'visibility-inventory-removal'

// Why: a tombstone empties the whole worktree mirror — including tabs a still-live sibling environment publishes — so it is a
// visibility fact, never evidence that the host closed anything.
export function isWebSessionTabsWorktreeRemovalFrame(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  return (
    (snapshot as { removed?: unknown }).removed === true ||
    snapshot.publicationEpoch === VISIBILITY_INVENTORY_REMOVAL_EPOCH
  )
}

// Why: omission means removal only because `listAllMobileSessionTabs` publishes every worktree it knows unfiltered; if a host ever
// scopes that map, this turns live worktrees into tombstones, so the fence below is deliberately short-lived.
export function buildMissingWebSessionTabsRemovals(
  environmentId: string,
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[],
  publishedWorktrees: ReadonlySet<string>
): {
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
}[] {
  return trackedWorktrees
    .filter(
      (trackedWorktree) =>
        !publishedWorktrees.has(trackedWorktree.worktree) &&
        isTrackedWebSessionTabsOmissionCurrent(environmentId, trackedWorktree)
    )
    .map((trackedWorktree) => ({
      trackedWorktree,
      snapshot: {
        worktree: trackedWorktree.worktree,
        publicationEpoch: VISIBILITY_INVENTORY_REMOVAL_EPOCH,
        snapshotVersion: 0,
        removed: true,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    }))
}

export function rememberHostTerminalTabCount(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}

export function getLastKnownHostTerminalTabCount(
  environmentId: string,
  worktreeId: string
): number {
  return (
    lastHostTerminalTabCountByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId)) ?? 0
  )
}

export function getLatestWebSessionTabsPublicationEpoch(
  environmentId: string,
  worktreeId: string
): string | null {
  return (
    latestSessionTabsSnapshotByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId))
      ?.publicationEpoch ?? null
  )
}

// Why: a replay may repeat the current epoch/version; permit only that exact
// identity once so an older concurrent frame cannot bypass monotonic ordering.
export function acceptReplayedWebSessionTabsSnapshot(
  environmentId: string,
  worktreeId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  if (current) {
    replayableSessionTabsSnapshotByWorktree.set(key, current)
  }
}
export function _getWebSessionTabsTrackingCountsForTest(): {
  freshness: number
  hostMappings: number
  hostMappingWorktrees: number
} {
  let hostMappingWorktrees = 0
  for (const mappingKeysByWorktree of hostSessionTabMappingKeysByEnvironmentAndWorktree.values()) {
    hostMappingWorktrees += mappingKeysByWorktree.size
  }
  return {
    freshness: latestSessionTabsSnapshotByWorktree.size,
    hostMappings: hostSessionTabIdByLocalKey.size,
    // Why: the mapping index is a parallel structure, so leak tests must see it drain alongside the flat map.
    hostMappingWorktrees
  }
}

export function _getWebSessionTabsRecoveryTrackingCountsForTest(): {
  pendingRecoveries: number
  removalFrames: number
} {
  return {
    pendingRecoveries: sessionTabsRecoveryStateByWorktree.size,
    removalFrames: latestSessionTabsRemovalFenceByWorktree.size
  }
}
