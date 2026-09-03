import { useEffect, useLayoutEffect, useRef } from 'react'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '../store'
import { useRuntimeSessionMirrorEnvironmentKey } from './use-runtime-session-mirror-environment-key'
import { installWindowVisibilitySubscriptionParking } from './window-visibility-subscription-parking'
import { clearWebSessionCloseIntentsForOwner } from './web-session-close-intent'
import { clearWebSessionFocusIntentsForOwner } from './web-session-focus-intent'
import { clearWebSessionReorderIntentsForOwner } from './web-session-reorder-intent'
import {
  clearWebSessionTabsTrackingForEnvironment,
  getWebSessionTabsTrackingGeneration
} from './web-session-tabs-tracking'
import { shouldSyncRuntimeSessionTabs } from './web-session-tabs-stream-predicates'
import {
  clearVisibilityResumeOmissions,
  createBeginVisibilityResume,
  dropVisibilityResumeOmissionsForEnvironment
} from './web-session-tabs-visibility-resume'
import { buildGlobalSessionTabsSubscriptionSpecs } from './web-session-tabs-global-stream-subscription'
import { subscribeActiveWorktreeSessionTabs } from './web-session-tabs-active-stream-subscription'

// Re-exports keep the historical module surface stable for existing importers.
export {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyFreshWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshots
} from './web-session-tabs-apply-snapshot'
export {
  acceptReplayedWebSessionTabsSnapshot,
  clearWebSessionTabsTrackingForEnvironment,
  getLastKnownHostTerminalTabCount,
  getLatestWebSessionTabsPublicationEpoch,
  getWebSessionTabsTrackingGeneration,
  resetWebSessionTabsSnapshotFreshnessForTests,
  _getWebSessionTabsTrackingCountsForTest,
  _getWebSessionTabsRecoveryTrackingCountsForTest
} from './web-session-tabs-tracking'
export {
  decideWebSessionTabsSnapshot,
  shouldApplyWebSessionTabsSnapshot,
  type WebSessionTabsSnapshotDecision
} from './web-session-tabs-snapshot-decision'
export { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-tab-id-mapping'
export {
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs,
  shouldSyncAllRuntimeSessionTabs
} from './web-session-tabs-stream-predicates'
export { applyWebSessionTabsStorePatch } from './web-session-tabs-store-patch'
export type { WebSessionTabsSnapshotApplyOptions } from './web-session-tabs-snapshot-options'
export type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
export type {
  HostSessionMirrorSettle,
  HostSessionMirrorPatchFrame,
  HostSessionMirrorPatchVerdict
} from './web-session-tabs-host-mirror-settle'

export const WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS = 100

export function useWebSessionTabsSync(): void {
  const activeRuntimeEnvironmentIdRef = useRef<string | null>(null)
  const activeRuntimeWorktreeKeyRef = useRef<string | null>(null)
  const ownerRevisionByEnvironmentRef = useRef(new Map<string, number | undefined>())
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const runtimeSessionMirrorEnvironmentKey = useRuntimeSessionMirrorEnvironmentKey()
  const activeWorktreeRuntimeEnvironmentId = useAppStore((state) =>
    getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
  )
  const activeWorktreeRuntimeId = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId ?? null)
      : null
  })
  const activeWorktreeRuntimeConnectionGeneration = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    return environmentId
      ? (state.runtimeStatusByEnvironmentId.get(environmentId)?.connectionGeneration ?? 0)
      : 0
  })
  const activeWorktreeRuntimePairingRevision = useAppStore((state) => {
    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, state.activeWorktreeId)
    const environment = state.runtimeEnvironments.find(
      (candidate) => candidate.id === environmentId
    )
    return environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
  })
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  // Why: only resume callbacks read these refs, and resumes fire from visibilitychange or
  // stale-visibility recovery — outside React — so committing during layout leaves no window
  // where a resume could read the previous worktree's key.
  useLayoutEffect(() => {
    activeRuntimeEnvironmentIdRef.current = activeWorktreeRuntimeEnvironmentId?.trim() || null
    activeRuntimeWorktreeKeyRef.current =
      activeWorktreeRuntimeEnvironmentId && activeWorktreeId
        ? `${activeWorktreeRuntimeEnvironmentId}:${activeWorktreeId}`
        : null
  }, [activeWorktreeId, activeWorktreeRuntimeEnvironmentId])

  const ownerRevisionByEnvironment = ownerRevisionByEnvironmentRef.current

  useEffect(
    () => () => {
      for (const environmentId of ownerRevisionByEnvironment.keys()) {
        clearWebSessionTabsTrackingForEnvironment(environmentId)
        dropVisibilityResumeOmissionsForEnvironment(environmentId)
      }
      ownerRevisionByEnvironment.clear()
      clearVisibilityResumeOmissions()
    },
    [ownerRevisionByEnvironment]
  )

  useEffect(() => {
    const environments = runtimeSessionMirrorEnvironmentKey
      ? runtimeSessionMirrorEnvironmentKey
          .split('\u0000')
          .map((entry) => {
            const [environmentId = '', , rawConnectionGeneration = '0', rawRevision = ''] =
              entry.split('\u0001')
            return {
              environmentId,
              expectedEnvironmentConnectionGeneration: Number(rawConnectionGeneration),
              expectedEnvironmentPairingRevision:
                rawRevision === '' ? undefined : Number(rawRevision)
            }
          })
          .filter(({ environmentId }) => environmentId.trim())
      : []
    const mirroredEnvironmentOwnerRevisions = new Map(
      (workspaceSessionReady ? environments : []).map(
        ({ environmentId, expectedEnvironmentPairingRevision }) =>
          [environmentId, expectedEnvironmentPairingRevision] as const
      )
    )
    const previousOwnerRevisions = ownerRevisionByEnvironment
    // Why: same-owner tracking must survive effect restarts to reconcile removals missed while hidden.
    for (const [environmentId, previousRevision] of previousOwnerRevisions) {
      if (
        !mirroredEnvironmentOwnerRevisions.has(environmentId) ||
        mirroredEnvironmentOwnerRevisions.get(environmentId) !== previousRevision
      ) {
        clearWebSessionTabsTrackingForEnvironment(environmentId)
        dropVisibilityResumeOmissionsForEnvironment(environmentId)
      }
    }
    ownerRevisionByEnvironment.clear()
    for (const [key, value] of mirroredEnvironmentOwnerRevisions) {
      ownerRevisionByEnvironment.set(key, value)
    }
    // Why: mirror all paired runtimes' sessions, not just the selected worktree, so background worktrees don't look asleep (selectedness isn't liveness).
    // Why: applying the host snapshot before startup hydration writes browser-local session state clobbers it and leaves the sidebar stale.
    if (!workspaceSessionReady || environments.length === 0) {
      return
    }

    const { specs, environmentIdBySubscriptionSpec } = buildGlobalSessionTabsSubscriptionSpecs(
      environments,
      workspaceSessionReady
    )
    const beginVisibilityResume = createBeginVisibilityResume({
      getActiveRuntimeWorktreeKey: () => activeRuntimeWorktreeKeyRef.current,
      environments
    })
    // Why: pace full-host inventories while the scoped active-worktree mirror resumes immediately.
    const disposeSubscriptions = installWindowVisibilitySubscriptionParking(specs, {
      getVisibilityResumePriority: (index) =>
        environmentIdBySubscriptionSpec[index] === activeRuntimeEnvironmentIdRef.current ? 0 : 1,
      visibilityResumeStaggerMs: WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS,
      onVisibilityResume: (args: {
        visibilityGeneration: number
        restartingSpecIndexes: readonly number[]
      }) => beginVisibilityResume({ ...args, environmentIdBySubscriptionSpec })
    })

    return () => {
      disposeSubscriptions()
      for (const { environmentId, expectedEnvironmentPairingRevision } of environments) {
        const owner = {
          environmentId,
          pairingRevision: expectedEnvironmentPairingRevision
        }
        clearWebSessionCloseIntentsForOwner(owner)
        clearWebSessionFocusIntentsForOwner(owner)
        clearWebSessionReorderIntentsForOwner(owner)
      }
    }
  }, [runtimeSessionMirrorEnvironmentKey, workspaceSessionReady, ownerRevisionByEnvironment])

  useEffect(() => {
    const environmentId = activeWorktreeRuntimeEnvironmentId?.trim()
    const expectedEnvironmentPairingRevision = activeWorktreeRuntimePairingRevision
    if (
      !shouldSyncRuntimeSessionTabs({
        activeWorktreeId,
        activeWorktreeRuntimeEnvironmentId,
        workspaceSessionReady
      }) ||
      !environmentId ||
      !activeWorktreeId
    ) {
      return
    }
    const expectedTrackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
    const { subscribe } = subscribeActiveWorktreeSessionTabs({
      environmentId,
      activeWorktreeId,
      activeWorktreeRuntimeConnectionGeneration,
      expectedEnvironmentPairingRevision,
      expectedTrackingGeneration
    })
    return installWindowVisibilitySubscriptionParking([
      {
        subscribe,
        onSubscribeError: (error) => {
          console.warn(
            '[web-session-tabs-sync] failed to subscribe:',
            error instanceof Error ? error.message : String(error)
          )
        },
        onUnsubscribeError: (error) => {
          console.warn('[web-session-tabs-sync] failed to unsubscribe:', error)
        }
      }
    ])
  }, [
    activeWorktreeId,
    activeWorktreeRuntimeEnvironmentId,
    activeWorktreeRuntimeConnectionGeneration,
    activeWorktreeRuntimeId,
    activeWorktreeRuntimePairingRevision,
    workspaceSessionReady
  ])
}
