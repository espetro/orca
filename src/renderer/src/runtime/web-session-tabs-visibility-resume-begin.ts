import {
  setVisibilityResumeBatch,
  visibilityResumeOmissionsByKey,
  type VisibilityResumeEnvironment,
  type WebSessionTabsMirrorEnvironmentSpec
} from './web-session-tabs-visibility-resume'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import {
  getTrackedWebSessionTabsWorktrees,
  getWebSessionTabsTrackingGeneration
} from './web-session-tabs-tracking'
import { replayableSessionTabsSnapshotByWorktree } from './web-session-tabs-sync-state'

export function createBeginVisibilityResume({
  getActiveRuntimeWorktreeKey,
  environments
}: {
  getActiveRuntimeWorktreeKey: () => string | null
  environments: readonly WebSessionTabsMirrorEnvironmentSpec[]
}) {
  return ({
    visibilityGeneration,
    restartingSpecIndexes,
    environmentIdBySubscriptionSpec
  }: {
    visibilityGeneration: number
    restartingSpecIndexes: readonly number[]
    environmentIdBySubscriptionSpec: readonly string[]
  }): void => {
    const activeRuntimeWorktreeKey = getActiveRuntimeWorktreeKey()
    for (const [key, omission] of visibilityResumeOmissionsByKey) {
      // Why: the active worktree's scoped stream resumes before its host inventory, so its fence outlives exactly one resume - never more.
      if (
        key !== activeRuntimeWorktreeKey ||
        omission.visibilityGeneration < visibilityGeneration - 1
      ) {
        visibilityResumeOmissionsByKey.delete(key)
      }
    }
    const resumedEnvironments = new Map<string, VisibilityResumeEnvironment>()
    const trackedWorktreeIds = new Set<string>()
    for (const index of restartingSpecIndexes) {
      const environmentId = environmentIdBySubscriptionSpec[index]
      if (environmentId) {
        const trackedWorktrees = getTrackedWebSessionTabsWorktrees(environmentId)
        if (trackedWorktrees.length === 0) {
          continue
        }
        for (const { worktree } of trackedWorktrees) {
          trackedWorktreeIds.add(worktree)
        }
        resumedEnvironments.set(environmentId, {
          trackedWorktrees,
          inventoryReceived: false,
          latestInventoryReceivedFrame: 0,
          pendingMissingWorktrees: new Set(),
          expectedEnvironmentConnectionGeneration:
            environments.find((environment) => environment.environmentId === environmentId)
              ?.expectedEnvironmentConnectionGeneration ??
            getRuntimeEnvironmentConnectionGeneration(environmentId),
          expectedEnvironmentPairingRevision: environments.find(
            (environment) => environment.environmentId === environmentId
          )?.expectedEnvironmentPairingRevision,
          expectedTrackingGeneration: getWebSessionTabsTrackingGeneration(environmentId)
        })
      }
    }
    setVisibilityResumeBatch(
      resumedEnvironments.size > 0
        ? {
            visibilityGeneration,
            environments: resumedEnvironments,
            pendingInventoryCount: resumedEnvironments.size,
            pendingMissingByWorktree: new Map(),
            deferredRepairWorktrees: new Set(),
            trackedWorktreeIds,
            reapplyableSnapshotsByKey: new Map()
          }
        : null
    )
  }
}

export function dropVisibilityResumeOmissionsForEnvironment(environmentId: string): void {
  for (const [key, omission] of visibilityResumeOmissionsByKey) {
    if (omission.environmentId === environmentId) {
      visibilityResumeOmissionsByKey.delete(key)
    }
  }
}

export function clearVisibilityResumeOmissions(): void {
  visibilityResumeOmissionsByKey.clear()
}

export function hasArmedVisibilityResumeReplay(key: string): boolean {
  return replayableSessionTabsSnapshotByWorktree.has(key)
}
