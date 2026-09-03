export { shouldApplyVisibilityResumeSnapshot } from './web-session-tabs-visibility-resume-decision'

export {
  createBeginVisibilityResume,
  dropVisibilityResumeOmissionsForEnvironment,
  clearVisibilityResumeOmissions,
  hasArmedVisibilityResumeReplay
} from './web-session-tabs-visibility-resume-begin'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import {
  buildMissingWebSessionTabsRemovals,
  recordReceivedWebSessionTabsRemoval,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-tracking'
import {
  getVisibilityResumeSnapshot,
  reconcileVisibilityResumeWorktrees
} from './web-session-tabs-visibility-resume-decision'
import {
  advancesSessionTabsFreshness,
  latestSessionTabsSnapshotByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsFreshnessKey,
  type TrackedWebSessionTabsWorktree
} from './web-session-tabs-sync-state'
import type { VisibilityResumeOmission } from './web-session-tabs-stream-operation-types'

export type WebSessionTabsMirrorEnvironmentSpec = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
}

export type VisibilityResumeEnvironment = {
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[]
  inventoryReceived: boolean
  latestInventoryReceivedFrame: number
  pendingMissingWorktrees: Set<string>
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration: number
}
export type VisibilityResumeMissing = {
  environmentId: string
  inventoryReceivedFrame: number
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
}
export type VisibilityResumeBatch = {
  visibilityGeneration: number
  environments: Map<string, VisibilityResumeEnvironment>
  pendingInventoryCount: number
  pendingMissingByWorktree: Map<string, Map<string, VisibilityResumeMissing>>
  deferredRepairWorktrees: Set<string>
  trackedWorktreeIds: ReadonlySet<string>
  reapplyableSnapshotsByKey: Map<
    string,
    { snapshot: RuntimeMobileSessionTabsResult; receivedFrame: number }
  >
}

export const visibilityResumeOmissionsByKey = new Map<string, VisibilityResumeOmission>()
let visibilityResumeBatch: VisibilityResumeBatch | null = null

export function getActiveVisibilityResumeBatch(): VisibilityResumeBatch | null {
  return visibilityResumeBatch
}

export function setVisibilityResumeBatch(batch: VisibilityResumeBatch | null): void {
  visibilityResumeBatch = batch
}

export function clearVisibilityResumeBatchIfIdle(batch: VisibilityResumeBatch): void {
  if (
    batch.pendingInventoryCount === 0 &&
    batch.pendingMissingByWorktree.size === 0 &&
    visibilityResumeBatch === batch
  ) {
    visibilityResumeBatch = null
  }
}

export function recordVisibilityResumeSnapshotReceipt(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number
): void {
  const omission = visibilityResumeOmissionsByKey.get(
    sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  )
  if (
    omission &&
    receivedFrame > omission.inventoryReceivedFrame &&
    ((snapshot as { removed?: unknown }).removed === true ||
      advancesSessionTabsFreshness(snapshot, omission.baseline))
  ) {
    omission.superseded = true
    if (visibilityResumeBatch?.pendingMissingByWorktree.has(snapshot.worktree)) {
      reconcileVisibilityResumeWorktrees([snapshot.worktree])
    }
  }
}

export function recordVisibilityResumeSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number
): void {
  const batch = visibilityResumeBatch
  if (!batch || !batch.trackedWorktreeIds.has(snapshot.worktree)) {
    return
  }
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const existingIsCurrent = getVisibilityResumeSnapshot(batch, environmentId, snapshot.worktree)
  const freshness = latestSessionTabsSnapshotByWorktree.get(key)
  const repairsCrossHostCollision =
    (sessionTabsEnvironmentsByWorktree.get(snapshot.worktree)?.size ?? 0) > 1 ||
    batch.deferredRepairWorktrees.has(snapshot.worktree)
  if (
    (snapshot as { removed?: unknown }).removed === true ||
    snapshot.tabs.length === 0 ||
    !repairsCrossHostCollision ||
    freshness?.publicationEpoch !== snapshot.publicationEpoch ||
    freshness.snapshotVersion !== snapshot.snapshotVersion ||
    !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, snapshot, receivedFrame)
  ) {
    if (!existingIsCurrent) {
      batch.reapplyableSnapshotsByKey.delete(key)
    }
  } else {
    batch.reapplyableSnapshotsByKey.set(key, { snapshot, receivedFrame })
  }
  if (batch.pendingMissingByWorktree.has(snapshot.worktree)) {
    reconcileVisibilityResumeWorktrees([snapshot.worktree])
  }
}

export function recordVisibilityResumeInventory(
  environmentId: string,
  visibilityGeneration: number,
  inventoryReceivedFrame: number,
  missingWorktrees: readonly VisibilityResumeMissing[]
): void {
  if (
    visibilityGeneration === 0 ||
    visibilityResumeBatch?.visibilityGeneration !== visibilityGeneration
  ) {
    return
  }
  const environment = visibilityResumeBatch.environments.get(environmentId)
  if (!environment || environment.latestInventoryReceivedFrame !== inventoryReceivedFrame) {
    return
  }
  const batch = visibilityResumeBatch
  const affectedWorktrees = new Set(environment.pendingMissingWorktrees)
  for (const worktreeId of environment.pendingMissingWorktrees) {
    const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
    pendingMissing?.delete(environmentId)
    if (pendingMissing?.size === 0) {
      batch.pendingMissingByWorktree.delete(worktreeId)
    }
  }
  environment.pendingMissingWorktrees.clear()
  for (const missing of missingWorktrees) {
    const worktreeId = missing.snapshot.worktree
    const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId) ?? new Map()
    pendingMissing.set(environmentId, missing)
    batch.pendingMissingByWorktree.set(worktreeId, pendingMissing)
    environment.pendingMissingWorktrees.add(worktreeId)
    affectedWorktrees.add(worktreeId)
  }
  if (!environment.inventoryReceived) {
    environment.inventoryReceived = true
    batch.pendingInventoryCount -= 1
  }
  reconcileVisibilityResumeWorktrees(affectedWorktrees)
}

export function recordVisibilityResumeInventoryReceipt(
  environmentId: string,
  visibilityGeneration: number,
  inventoryReceivedFrame: number,
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): VisibilityResumeMissing[] {
  for (const snapshot of snapshots) {
    visibilityResumeOmissionsByKey.delete(sessionTabsFreshnessKey(environmentId, snapshot.worktree))
  }
  if (visibilityResumeBatch?.visibilityGeneration !== visibilityGeneration) {
    return []
  }
  const environment = visibilityResumeBatch.environments.get(environmentId)
  if (!environment) {
    return []
  }
  environment.latestInventoryReceivedFrame = Math.max(
    environment.latestInventoryReceivedFrame,
    inventoryReceivedFrame
  )
  if (environment.latestInventoryReceivedFrame !== inventoryReceivedFrame) {
    return []
  }
  const publishedWorktrees = new Set(snapshots.map((snapshot) => snapshot.worktree))
  return buildMissingWebSessionTabsRemovals(
    environmentId,
    environment.trackedWorktrees,
    publishedWorktrees
  ).map((missing) => {
    const key = sessionTabsFreshnessKey(environmentId, missing.snapshot.worktree)
    visibilityResumeOmissionsByKey.set(key, {
      baseline: missing.trackedWorktree.freshness,
      environmentId,
      inventoryReceivedFrame,
      superseded: false,
      visibilityGeneration
    })
    recordReceivedWebSessionTabsRemoval(
      environmentId,
      missing.snapshot.worktree,
      inventoryReceivedFrame
    )
    return { environmentId, inventoryReceivedFrame, ...missing }
  })
}
