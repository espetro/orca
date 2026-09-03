import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { useAppStore } from '../store'
import { queueAcceptedWebSessionTerminalSnapshot } from './web-session-terminal-handle-events'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots
} from './web-session-tabs-apply-snapshot'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-store-patch'
import type { SessionTabsStreamEvent } from './web-session-tabs-stream-predicates'
import {
  shouldApplyVisibilityResumeSnapshot,
  recordVisibilityResumeSnapshotReceipt,
  recordVisibilityResumeSnapshot,
  recordVisibilityResumeInventory,
  recordVisibilityResumeInventoryReceipt
} from './web-session-tabs-visibility-resume'
import {
  WEB_SESSION_TABS_FRAME_OUTRANKED,
  isHostMirroredWorktree,
  decideWebSessionTabsSnapshot
} from './web-session-tabs-snapshot-decision'
import {
  acceptReplayedWebSessionTabsSnapshot,
  recordReceivedWebSessionTabsSnapshot,
  recordReceivedWebSessionTabsInventory,
  beginWebSessionTabsSnapshotRecovery,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-tracking'
import {
  sessionTabsFreshnessKey,
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree
} from './web-session-tabs-sync-state'
import {
  hostSessionMirrorSettleForPatchlessFrame,
  type HostSessionMirrorSettle
} from './web-session-tabs-host-mirror-settle'

// Global session-tabs stream onResponse handler (extracted from the global subscription spec).
export function handleGlobalSessionTabsOnResponse(args: {
  response: RuntimeRpcResponse<unknown>
  isCurrent: () => boolean
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  awaitingVisibilityResumeInventory: boolean
  setAwaitingVisibilityResumeInventory: (v: boolean) => void
  isVisibilityRestart: boolean
  expectedEnvironmentPairingRevision: number | undefined
  expectedTrackingGeneration: number
  visibilityGeneration: number
}) {
  const {
    response,
    isCurrent,
    environmentId,
    expectedEnvironmentConnectionGeneration,
    isVisibilityRestart,
    expectedEnvironmentPairingRevision,
    expectedTrackingGeneration,
    visibilityGeneration = 0
  } = args
  let awaitingVisibilityResumeInventory = args.awaitingVisibilityResumeInventory
  if (
    !isCurrent() ||
    getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
  ) {
    return
  }
  if (response.ok === false) {
    console.warn('[web-session-tabs-sync] global subscription failed:', response.error.message)
    return
  }
  const event = response.result as SessionTabsStreamEvent
  const replayed = isRuntimeSubscriptionReplayResponse(response)
  if (event.type === 'snapshots') {
    const skipUnchangedResumeWork = awaitingVisibilityResumeInventory && !replayed
    awaitingVisibilityResumeInventory = false
    // Why: an unchanged epoch/version proves the host published nothing while parked, so there is no missed frame to recover or replay.
    const unchangedVisibilityResumeSnapshots = event.snapshots.map((snapshot) => {
      const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      return Boolean(
        skipUnchangedResumeWork &&
        // Why: an armed replay is an outstanding repair request, so that worktree must be rebuilt even when the host looks unchanged.
        !replayableSessionTabsSnapshotByWorktree.has(key) &&
        freshness?.publicationEpoch === snapshot.publicationEpoch &&
        freshness.snapshotVersion === snapshot.snapshotVersion
      )
    })
    const receivedFrames = event.snapshots.map((snapshot) => {
      const receivedFrame = recordReceivedWebSessionTabsSnapshot(environmentId, snapshot)
      recordVisibilityResumeSnapshotReceipt(environmentId, snapshot, receivedFrame)
      return receivedFrame
    })
    const inventoryReceivedFrame = recordReceivedWebSessionTabsInventory()
    const missingWorktrees = recordVisibilityResumeInventoryReceipt(
      environmentId,
      visibilityGeneration,
      inventoryReceivedFrame,
      event.snapshots
    )
    const finishRecoveries = event.snapshots.map((snapshot, index) =>
      unchangedVisibilityResumeSnapshots[index]
        ? null
        : beginWebSessionTabsSnapshotRecovery(
            environmentId,
            snapshot.worktree,
            receivedFrames[index]!
          )
    )
    let innerSettle: (() => void) | null = null
    void Promise.all(
      event.snapshots.map((snapshot, index) =>
        unchangedVisibilityResumeSnapshots[index]
          ? Promise.resolve(snapshot)
          : recoverWebSessionTerminalOrphansBeforeApply(
              useAppStore.getState(),
              snapshot,
              environmentId
            )
      )
    )
      .then((recovered) => {
        if (isCurrent()) {
          const applicable = recovered.flatMap((snapshot, index) =>
            snapshot !== null &&
            shouldApplyRecoveredWebSessionTabsSnapshot(
              environmentId,
              snapshot,
              receivedFrames[index]!
            ) &&
            shouldApplyVisibilityResumeSnapshot(environmentId, snapshot, receivedFrames[index]!)
              ? [{ index, snapshot }]
              : []
          )
          if (isVisibilityRestart || replayed) {
            for (const { index, snapshot } of applicable) {
              if (unchangedVisibilityResumeSnapshots[index]) {
                continue
              }
              acceptReplayedWebSessionTabsSnapshot(environmentId, snapshot.worktree)
            }
          }
          // Why: an unchanged resume snapshot is never re-decided
          // — the store already holds the view it would rewrite.
          const decisions = applicable.map(({ index, snapshot }) =>
            unchangedVisibilityResumeSnapshots[index]
              ? WEB_SESSION_TABS_FRAME_OUTRANKED
              : decideWebSessionTabsSnapshot(snapshot, environmentId)
          )
          const freshSnapshots = applicable.flatMap(({ snapshot }, position) =>
            decisions[position]!.apply ? [snapshot] : []
          )
          innerSettle = applyWebSessionTabsStorePatch(
            (state) => applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId),
            {
              frames: applicable.map(({ snapshot }, position) => ({
                environmentId,
                worktreeId: snapshot.worktree,
                decision: decisions[position]!,
                expectedEnvironmentConnectionGeneration,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration
              })),
              fullInventory: {
                environmentId,
                authoritative: event.authoritative === true,
                expectedEnvironmentConnectionGeneration,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration,
                // Why: a workspace the mirror never writes is not
                // part of the inventory this verdict accounts for.
                publishedSnapshotCount: event.snapshots.filter((snapshot) =>
                  isHostMirroredWorktree(snapshot.worktree)
                ).length
              }
            },
            freshSnapshots
          )
          const freshSnapshotSet = new Set(freshSnapshots)
          for (const { index, snapshot } of applicable) {
            if (unchangedVisibilityResumeSnapshots[index]) {
              queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
            }
            if (unchangedVisibilityResumeSnapshots[index] || freshSnapshotSet.has(snapshot)) {
              recordVisibilityResumeSnapshot(environmentId, snapshot, receivedFrames[index]!)
            }
          }
          recordVisibilityResumeInventory(
            environmentId,
            visibilityGeneration,
            inventoryReceivedFrame,
            missingWorktrees
          )
        }
      })
      .catch((error) => {
        if (isCurrent()) {
          console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
        }
      })
      .finally(() => {
        for (const finishRecovery of finishRecoveries) {
          finishRecovery?.()
        }
        // Why: an inventory speaks only once its patch is in the
        // store — settling earlier, or on snapshots recovery
        // discarded, drains parked work against state nobody wrote.
        if (isCurrent()) {
          innerSettle?.()
        }
      })
    return
  }
  if (event.type !== 'snapshot' && event.type !== 'updated') {
    // Why: silence carries no frame, and a stream that stopped
    // talking has not reported a single PTY dead.
    return
  }
  const receivedFrame = recordReceivedWebSessionTabsSnapshot(environmentId, event)
  recordVisibilityResumeSnapshotReceipt(environmentId, event, receivedFrame)
  const finishRecovery = beginWebSessionTabsSnapshotRecovery(
    environmentId,
    event.worktree,
    receivedFrame
  )
  let innerSettle: HostSessionMirrorSettle | null = null
  void recoverWebSessionTerminalOrphansBeforeApply(useAppStore.getState(), event, environmentId)
    .then((recovered) => {
      if (
        isCurrent() &&
        recovered &&
        shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, recovered, receivedFrame) &&
        shouldApplyVisibilityResumeSnapshot(environmentId, recovered, receivedFrame)
      ) {
        if (replayed) {
          acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
        }
        const decision = decideWebSessionTabsSnapshot(recovered, environmentId)
        if (decision.apply) {
          innerSettle = applyWebSessionTabsStorePatch(
            (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
            {
              frames: [
                {
                  environmentId,
                  worktreeId: recovered.worktree,
                  decision,
                  expectedEnvironmentConnectionGeneration,
                  expectedEnvironmentPairingRevision,
                  expectedTrackingGeneration
                }
              ]
            },
            recovered,
            event.type === 'updated' && !replayed
          )
          recordVisibilityResumeSnapshot(environmentId, recovered, receivedFrame)
        } else {
          innerSettle = hostSessionMirrorSettleForPatchlessFrame(
            decision,
            environmentId,
            recovered.worktree,
            {
              connectionGeneration: expectedEnvironmentConnectionGeneration,
              pairingRevision: expectedEnvironmentPairingRevision,
              trackingGeneration: expectedTrackingGeneration
            }
          )
        }
      }
    })
    .catch((error) => {
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
      }
    })
    .finally(() => {
      finishRecovery()
      // Why: this frame speaks for its own worktree only, and only
      // through the receipt of what actually landed — a discarded
      // frame leaves the pane's PTY as unaccounted as before.
      if (isCurrent()) {
        innerSettle?.()
      }
    })
}
