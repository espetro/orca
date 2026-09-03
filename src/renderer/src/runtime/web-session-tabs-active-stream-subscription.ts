import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { useAppStore } from '../store'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'
import type { WindowVisibilitySubscriptionSpec } from './window-visibility-subscription-parking'
import {
  decideWebSessionTabsSnapshot,
  type WebSessionTabsSnapshotDecision
} from './web-session-tabs-snapshot-decision'
import {
  hostSessionMirrorSettleForPatchlessFrame,
  type HostSessionMirrorSettle
} from './web-session-tabs-host-mirror-settle'
import {
  acceptReplayedWebSessionTabsSnapshot,
  beginWebSessionTabsSnapshotRecovery,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-tracking'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-apply-snapshot'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-store-patch'
import {
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  type SessionTabsStreamEvent
} from './web-session-tabs-stream-predicates'
import {
  recordVisibilityResumeSnapshot,
  recordVisibilityResumeSnapshotReceipt,
  shouldApplyVisibilityResumeSnapshot
} from './web-session-tabs-visibility-resume'

export function subscribeActiveWorktreeSessionTabs(args: {
  environmentId: string
  activeWorktreeId: string
  activeWorktreeRuntimeConnectionGeneration: number
  expectedEnvironmentPairingRevision: number | undefined
  expectedTrackingGeneration: number
}): WindowVisibilitySubscriptionSpec {
  const {
    environmentId,
    activeWorktreeId,
    activeWorktreeRuntimeConnectionGeneration,
    expectedEnvironmentPairingRevision,
    expectedTrackingGeneration
  } = args

  let requestedInitialTerminal = false
  let requestedRespawnAfterWake = false
  /** Resolves the settle receipt of the evidence this frame put (or already
   *  had) in the store, or null when the frame was discarded undecided. */
  const applyActiveSnapshot = async (
    event: SessionTabsStreamEvent & { type: 'snapshot' | 'updated' },
    response: RuntimeRpcResponse<unknown>,
    isCurrent: () => boolean,
    receivedFrame: number
  ): Promise<HostSessionMirrorSettle | null> => {
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      useAppStore.getState(),
      event,
      environmentId
    )
    if (
      !isCurrent() ||
      !recovered ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, recovered, receivedFrame) ||
      !shouldApplyVisibilityResumeSnapshot(environmentId, recovered, receivedFrame)
    ) {
      return null
    }
    if (event.type === 'snapshot' || isRuntimeSubscriptionReplayResponse(response)) {
      // Why: the parallel global stream can consume an earlier replay allowance before this authoritative snapshot lands.
      acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
    }
    const recoveredEvent: SessionTabsStreamEvent = { ...recovered, type: event.type }
    const decision: WebSessionTabsSnapshotDecision = decideWebSessionTabsSnapshot(
      recovered,
      environmentId
    )
    const fresh = decision.apply
    const syncState = useAppStore.getState()
    const localWorktreeTabs = syncState.tabsByWorktree[activeWorktreeId] ?? []
    const localTerminalCount = localWorktreeTabs.length
    const hasLiveLocalPty = localWorktreeTabs.some(
      (tab) => (syncState.ptyIdsByTabId[tab.id] ?? []).length > 0
    )
    const shouldBootstrapInitialTerminal = shouldBootstrapInitialWebRuntimeTerminal({
      event: recoveredEvent,
      activeWorktreeId,
      requestedInitialTerminal,
      snapshotIsFresh: fresh,
      localTerminalCount
    })
    const shouldRespawnAfterWake = shouldRespawnWebRuntimeTerminalAfterWake({
      event: recoveredEvent,
      activeWorktreeId,
      requestedRespawnAfterWake,
      snapshotIsFresh: fresh,
      localTerminalCount,
      hasLiveLocalPty,
      skipWakeRespawn: shouldSkipWebRuntimeWakeTerminalRespawn(activeWorktreeId)
    })
    // Why: a rejected frame settles only on the accepted view that outranked it.
    let settleMirror: HostSessionMirrorSettle | null = fresh
      ? null
      : hostSessionMirrorSettleForPatchlessFrame(decision, environmentId, recovered.worktree, {
          connectionGeneration: activeWorktreeRuntimeConnectionGeneration,
          pairingRevision: expectedEnvironmentPairingRevision,
          trackingGeneration: expectedTrackingGeneration
        })
    try {
      if (fresh) {
        const replayed = isRuntimeSubscriptionReplayResponse(response)
        settleMirror = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
          {
            frames: [
              {
                environmentId,
                worktreeId: recovered.worktree,
                decision,
                expectedEnvironmentConnectionGeneration: activeWorktreeRuntimeConnectionGeneration,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration
              }
            ]
          },
          recovered,
          event.type === 'updated' && !replayed
        )
        recordVisibilityResumeSnapshot(environmentId, recovered, receivedFrame)
      }
      if (isCurrent() && shouldBootstrapInitialTerminal) {
        requestedInitialTerminal = true
        await createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId,
          activate: true
        })
      } else if (
        isCurrent() &&
        shouldRespawnAfterWake &&
        beginWebRuntimeWakeTerminalRespawn(activeWorktreeId)
      ) {
        requestedRespawnAfterWake = true
        await createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId,
          activate: true,
          selectWorktree: false
        }).finally(() => endWebRuntimeWakeTerminalRespawn(activeWorktreeId))
      }
    } catch (error) {
      // Why: the spawn is a side effect of the frame, not part of it — failing
      // after the patch landed cannot un-land it, and the host is still healthy.
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot follow-up failed:', error)
      }
    }
    return settleMirror
  }
  return {
    subscribe: (isCurrent, { visibilityGeneration: _visibilityGeneration }) =>
      window.api.runtimeEnvironments.subscribe(
        {
          selector: environmentId,
          method: 'session.tabs.subscribe',
          params: { worktree: toRuntimeWorktreeSelector(activeWorktreeId) },
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision
        },
        {
          onResponse: (response: RuntimeRpcResponse<unknown>) => {
            if (
              !isCurrent() ||
              getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
            ) {
              return
            }
            if (response.ok === false) {
              console.warn('[web-session-tabs-sync] subscription failed:', response.error.message)
              return
            }
            const event = response.result as SessionTabsStreamEvent
            if (event.type !== 'snapshot' && event.type !== 'updated') {
              // No frame to apply, and a dead stream is not a verdict about
              // this worktree — let alone about the whole environment.
              return
            }
            const receivedFrame = recordReceivedWebSessionTabsSnapshot(environmentId, event)
            recordVisibilityResumeSnapshotReceipt(environmentId, event, receivedFrame)
            const finishRecovery = beginWebSessionTabsSnapshotRecovery(
              environmentId,
              event.worktree,
              receivedFrame
            )
            void applyActiveSnapshot(event, response, isCurrent, receivedFrame)
              .catch((error) => {
                if (isCurrent()) {
                  console.warn('[web-session-tabs-sync] active snapshot recovery failed:', error)
                }
                return null
              })
              .then((settleMirror) => {
                finishRecovery()
                // Why: the active-worktree mirror is authoritative for this
                // worktree alone, and only through its landed receipt.
                if (isCurrent()) {
                  settleMirror?.()
                }
              })
          },
          onError: (error) => {
            if (isCurrent()) {
              console.warn('[web-session-tabs-sync] subscription error:', error.message)
            }
          }
        }
      )
  }
}
