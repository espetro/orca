import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  acceptReplayedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-tracking'
import {
  advancesSessionTabsFreshness,
  latestSessionTabsSnapshotByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsFreshnessKey
} from './web-session-tabs-sync-state'
import {
  clearVisibilityResumeBatchIfIdle,
  getActiveVisibilityResumeBatch,
  visibilityResumeOmissionsByKey,
  type VisibilityResumeBatch,
  type VisibilityResumeMissing
} from './web-session-tabs-visibility-resume'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-store-patch'
import {
  applyWebSessionTabsSnapshotOperations,
  decideWebSessionTabsSnapshotOperations
} from './web-session-tabs-stream-operation-types'

export function shouldApplyVisibilityResumeSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number
): boolean {
  const omission = visibilityResumeOmissionsByKey.get(
    sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  )
  if (!omission) {
    return true
  }
  if (receivedFrame < omission.inventoryReceivedFrame) {
    return false
  }
  return (
    (snapshot as { removed?: unknown }).removed === true ||
    advancesSessionTabsFreshness(snapshot, omission.baseline)
  )
}

function isVisibilityResumeMissingCurrent(missing: VisibilityResumeMissing): boolean {
  const omission = visibilityResumeOmissionsByKey.get(
    sessionTabsFreshnessKey(missing.environmentId, missing.snapshot.worktree)
  )
  return omission?.inventoryReceivedFrame === missing.inventoryReceivedFrame && !omission.superseded
}

export function getVisibilityResumeSnapshot(
  batch: VisibilityResumeBatch,
  environmentId: string,
  worktreeId: string
): RuntimeMobileSessionTabsResult | null {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const entry = batch.reapplyableSnapshotsByKey.get(key)
  const freshness = latestSessionTabsSnapshotByWorktree.get(key)
  if (
    !entry ||
    freshness?.publicationEpoch !== entry.snapshot.publicationEpoch ||
    freshness.snapshotVersion !== entry.snapshot.snapshotVersion ||
    !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, entry.snapshot, entry.receivedFrame)
  ) {
    return null
  }
  return entry.snapshot
}

// Why: omission tombstones touch shared terminal ids, so apply them only before replaying every surviving host.
export function reconcileVisibilityResumeWorktrees(worktreeIds: Iterable<string>): void {
  const batch = getActiveVisibilityResumeBatch()
  if (!batch) {
    return
  }
  const operations: { environmentId: string; snapshot: RuntimeMobileSessionTabsResult }[] = []
  for (const worktreeId of new Set(worktreeIds)) {
    const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
    if (!pendingMissing) {
      batch.deferredRepairWorktrees.delete(worktreeId)
      continue
    }
    for (const [environmentId, missing] of pendingMissing) {
      if (isVisibilityResumeMissingCurrent(missing)) {
        continue
      }
      pendingMissing.delete(environmentId)
      batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
    }
    if (pendingMissing.size === 0) {
      batch.pendingMissingByWorktree.delete(worktreeId)
      batch.deferredRepairWorktrees.delete(worktreeId)
      continue
    }
    const missingEnvironmentIds = new Set(pendingMissing.keys())
    const survivingSnapshots: {
      environmentId: string
      snapshot: RuntimeMobileSessionTabsResult
    }[] = []
    let canRepairSharedState = true
    for (const environmentId of sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? []) {
      if (missingEnvironmentIds.has(environmentId)) {
        continue
      }
      const snapshot = getVisibilityResumeSnapshot(batch, environmentId, worktreeId)
      if (!snapshot) {
        canRepairSharedState = false
        break
      }
      survivingSnapshots.push({ environmentId, snapshot })
    }
    if (!canRepairSharedState) {
      batch.deferredRepairWorktrees.add(worktreeId)
      continue
    }
    for (const missing of pendingMissing.values()) {
      operations.push({ environmentId: missing.environmentId, snapshot: missing.snapshot })
    }
    for (const { environmentId, snapshot } of survivingSnapshots) {
      acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
      operations.push({ environmentId, snapshot })
    }
    for (const environmentId of pendingMissing.keys()) {
      batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
    }
    batch.pendingMissingByWorktree.delete(worktreeId)
    batch.deferredRepairWorktrees.delete(worktreeId)
  }
  if (operations.length > 0) {
    const decided = decideWebSessionTabsSnapshotOperations(operations)
    const settleMirror = applyWebSessionTabsStorePatch(
      (state) => applyWebSessionTabsSnapshotOperations(state, decided),
      {
        frames: decided.map(({ environmentId, snapshot, decision }) => ({
          environmentId,
          worktreeId: snapshot.worktree,
          decision,
          expectedEnvironmentConnectionGeneration:
            batch.environments.get(environmentId)?.expectedEnvironmentConnectionGeneration,
          expectedEnvironmentPairingRevision:
            batch.environments.get(environmentId)?.expectedEnvironmentPairingRevision,
          expectedTrackingGeneration:
            batch.environments.get(environmentId)?.expectedTrackingGeneration
        }))
      },
      operations.map(({ snapshot }) => snapshot)
    )
    // Why: every operation is post-recovery or inventory-absence evidence
    // with no finishRecovery of its own pending, so settle now — a deferred
    // tombstone otherwise leaves its worktree parked on a healthy host.
    settleMirror()
  }
  clearVisibilityResumeBatchIfIdle(batch)
}
