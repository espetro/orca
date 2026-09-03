import {
  markHostSessionMirrorHydrated,
  markHostSessionMirrorWorktreeHydrated
} from './host-session-mirror-hydration'
import { probeHostLiveTerminals } from './host-live-terminal-probe'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import type { WebSessionTabsSnapshotDecision } from './web-session-tabs-snapshot-decision'
import { getWebSessionTabsTrackingGeneration } from './web-session-tabs-tracking'

/** Proof that a session-tabs store patch committed. Invoke it after the
 *  frame's finishRecovery to settle the mirror latch for its verdicts. */
export type HostSessionMirrorSettle = () => void

/** A worktree the patch carried, named with the decision its frame's fate came
 *  from. Requiring the decision is the point: a settle cannot be written for a
 *  pair whose frame was never decided, so no site can overstate its evidence. */
export type HostSessionMirrorPatchFrame = {
  environmentId: string
  worktreeId: string
  decision: WebSessionTabsSnapshotDecision
  expectedEnvironmentConnectionGeneration?: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration?: number
}

/**
 * The host verdicts a store patch carries. Every frame it touched is listed;
 * only the ones whose decision carries `settlesHostMirror` settle, so a frame
 * the patch wrote no bytes for settles ONLY when the store already holds an
 * equal/newer accepted view of it. `fullInventory` upgrades a completely
 * applied inventory to an environment-wide verdict: absence from it is itself
 * the host answering, but a partial one speaks only for the worktrees whose
 * frames reached the store — the rest wait for the next clean inventory rather
 * than read as retracted.
 */
export type HostSessionMirrorPatchVerdict = {
  frames: readonly HostSessionMirrorPatchFrame[]
  fullInventory?: {
    environmentId: string
    publishedSnapshotCount: number
    authoritative?: boolean
    expectedEnvironmentConnectionGeneration?: number
    expectedEnvironmentPairingRevision?: number
    expectedTrackingGeneration?: number
  }
}

/**
 * An inventory that published nothing is the one shape carrying no host
 * evidence at all: `settles.length === publishedSnapshotCount` is `0 === 0`, so
 * a live host answering `[]` before its renderer's first publish used to be
 * upgraded into an environment-wide "the host has spoken" — draining parked
 * resumes into forking a second agent onto a PTY the host still runs.
 *
 * The distinguisher has to be host readiness, not list emptiness: a host with
 * genuinely zero terminals must still settle or its panes park forever. Only
 * `none` settles; `live` and `unverifiable` leave waiters for the next
 * inventory or per-worktree frame.
 */
type HostSessionMirrorSettleFence = {
  environmentId: string
  connectionGeneration: number
  pairingRevision?: number
  trackingGeneration: number
}

export function captureHostSessionMirrorSettleFence(
  environmentId: string,
  expected: {
    connectionGeneration?: number
    pairingRevision?: number
    trackingGeneration?: number
  } = {}
): HostSessionMirrorSettleFence {
  return {
    environmentId,
    connectionGeneration:
      expected.connectionGeneration ?? getRuntimeEnvironmentConnectionGeneration(environmentId),
    pairingRevision: expected.pairingRevision ?? getRuntimeEnvironmentRevision(environmentId),
    trackingGeneration:
      expected.trackingGeneration ?? getWebSessionTabsTrackingGeneration(environmentId)
  }
}

export function hostSessionMirrorSettleFenceIsCurrent(
  fence: HostSessionMirrorSettleFence
): boolean {
  return (
    getRuntimeEnvironmentConnectionGeneration(fence.environmentId) === fence.connectionGeneration &&
    getRuntimeEnvironmentRevision(fence.environmentId) === fence.pairingRevision &&
    getWebSessionTabsTrackingGeneration(fence.environmentId) === fence.trackingGeneration
  )
}

export function settleEmptyHostInventoryOnlyIfHostHasNoTerminals(
  fence: HostSessionMirrorSettleFence
): void {
  void probeHostLiveTerminals(
    fence.environmentId,
    undefined,
    fence.connectionGeneration,
    fence.pairingRevision
  ).then((verdict) => {
    // Why: the probe is a round trip, and a reconnect in between would make its
    // answer speak for a connection whose PTYs nobody listed.
    if (verdict === 'none' && hostSessionMirrorSettleFenceIsCurrent(fence)) {
      markHostSessionMirrorHydrated(fence.environmentId)
    }
  })
}

export function createHostSessionMirrorSettle(
  verdict: HostSessionMirrorPatchVerdict
): HostSessionMirrorSettle {
  const fenceByEnvironment = new Map<string, HostSessionMirrorSettleFence>()
  for (const frame of verdict.frames) {
    fenceByEnvironment.set(
      frame.environmentId,
      captureHostSessionMirrorSettleFence(frame.environmentId, {
        connectionGeneration: frame.expectedEnvironmentConnectionGeneration,
        pairingRevision: frame.expectedEnvironmentPairingRevision,
        trackingGeneration: frame.expectedTrackingGeneration
      })
    )
  }
  if (verdict.fullInventory) {
    fenceByEnvironment.set(
      verdict.fullInventory.environmentId,
      captureHostSessionMirrorSettleFence(verdict.fullInventory.environmentId, {
        connectionGeneration: verdict.fullInventory.expectedEnvironmentConnectionGeneration,
        pairingRevision: verdict.fullInventory.expectedEnvironmentPairingRevision,
        trackingGeneration: verdict.fullInventory.expectedTrackingGeneration
      })
    )
  }
  return () => {
    const { frames, fullInventory } = verdict
    const settles = frames.filter(({ decision }) => decision.settlesHostMirror)
    if (fullInventory && settles.length === fullInventory.publishedSnapshotCount) {
      const fence = fenceByEnvironment.get(fullInventory.environmentId)
      if (!fence || !hostSessionMirrorSettleFenceIsCurrent(fence)) {
        return
      }
      if (fullInventory.publishedSnapshotCount === 0) {
        if (fullInventory.authoritative) {
          markHostSessionMirrorHydrated(fullInventory.environmentId)
        } else {
          settleEmptyHostInventoryOnlyIfHostHasNoTerminals(fence)
        }
        return
      }
      markHostSessionMirrorHydrated(fullInventory.environmentId)
      return
    }
    for (const { environmentId, worktreeId } of settles) {
      const fence = fenceByEnvironment.get(environmentId)
      if (fence && hostSessionMirrorSettleFenceIsCurrent(fence)) {
        markHostSessionMirrorWorktreeHydrated(environmentId, worktreeId)
      }
    }
  }
}

/** The settle a frame earns when its own patch wrote nothing — or null when it
 *  earns none. Only a decision carrying `settlesHostMirror` may stand in for a
 *  patch: it is backed by the equal/newer view already accepted into the store,
 *  so the host HAS answered for this worktree. Taking the decision as the
 *  argument is the point — a new rejection branch cannot inherit a settle by
 *  defaulting, and a transport failure is `unverifiable` and never gets here. */
export function hostSessionMirrorSettleForPatchlessFrame(
  decision: WebSessionTabsSnapshotDecision,
  environmentId: string,
  worktreeId: string,
  expected: {
    connectionGeneration?: number
    pairingRevision?: number
    trackingGeneration?: number
  } = {}
): HostSessionMirrorSettle | null {
  if (!decision.settlesHostMirror) {
    return null
  }
  const fence = captureHostSessionMirrorSettleFence(environmentId, expected)
  return () => {
    if (hostSessionMirrorSettleFenceIsCurrent(fence)) {
      markHostSessionMirrorWorktreeHydrated(environmentId, worktreeId)
    }
  }
}
