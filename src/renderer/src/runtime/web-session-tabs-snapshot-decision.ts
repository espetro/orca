import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { queueAcceptedWebSessionTerminalSnapshot } from './web-session-terminal-handle-events'
import {
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  sessionTabsFreshnessKey
} from './web-session-tabs-sync-state'
import {
  clearWebSessionTabsTrackingForWorktree,
  recordAcceptedWebSessionTabsEnvironment,
  rememberHostTerminalTabCount,
  trackWebSessionTabsWorktree
} from './web-session-tabs-tracking'

/**
 * A frame's fate, paired with whether that fate is host evidence for the
 * worktree — the mirror latch reads the pair, never a bare boolean.
 *
 * Settling on a REJECTED frame is correct only when the store already holds an
 * equal-or-newer accepted view of that worktree, so every rejection branch has
 * to state its answer here. A `false` that meant "the mirror never writes this workspace"
 * would otherwise read as staleness and drain parked resume work — the sweep
 * would treat an undecidable pane as decidable and fork a live agent.
 */
export type WebSessionTabsSnapshotDecision = {
  readonly apply: boolean
  readonly settlesHostMirror: boolean
}

/** The frame's own store patch carries the verdict. */
export const WEB_SESSION_TABS_FRAME_APPLIED = {
  apply: true,
  settlesHostMirror: true
} as const satisfies WebSessionTabsSnapshotDecision

/** Outranked by an equal-or-newer accepted view: the host HAS answered here. */
export const WEB_SESSION_TABS_FRAME_OUTRANKED = {
  apply: false,
  settlesHostMirror: true
} as const satisfies WebSessionTabsSnapshotDecision

/** Discarded because the mirror never writes this workspace at all, so no
 *  accepted view backs the rejection and the pane stays unaccounted for. */
export const WEB_SESSION_TABS_FRAME_UNMIRRORED = {
  apply: false,
  settlesHostMirror: false
} as const satisfies WebSessionTabsSnapshotDecision

/** Why: the floating workspace is a local synthetic terminal the mirror never
 *  writes, so its frames are no evidence about any mirrored pane. */
export function isHostMirroredWorktree(worktreeId: string): boolean {
  return worktreeId !== FLOATING_TERMINAL_WORKTREE_ID
}

export function shouldApplyWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): boolean {
  return decideWebSessionTabsSnapshot(snapshot, environmentId).apply
}

export function decideWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): WebSessionTabsSnapshotDecision {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if ((snapshot as { removed?: unknown }).removed === true) {
    // Why: removed worktrees can stop publishing, so clean up their tracking now instead of waiting for a replacement snapshot that may never arrive.
    clearWebSessionTabsTrackingForWorktree(environmentId, snapshot.worktree)
    queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
    return WEB_SESSION_TABS_FRAME_APPLIED
  }
  if (!isHostMirroredWorktree(snapshot.worktree)) {
    // Why: a remote empty same-id snapshot would delete the user's local floating tabs.
    return WEB_SESSION_TABS_FRAME_UNMIRRORED
  }
  rememberHostTerminalTabCount(environmentId, snapshot)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  const replayable = replayableSessionTabsSnapshotByWorktree.get(key)
  const isExactCurrentReplay = Boolean(
    current &&
    replayable &&
    current.publicationEpoch === replayable.publicationEpoch &&
    current.snapshotVersion === replayable.snapshotVersion &&
    snapshot.publicationEpoch === replayable.publicationEpoch &&
    snapshot.snapshotVersion === replayable.snapshotVersion
  )
  // Why: reject stale snapshots only within an epoch; host restarts create a new epoch.
  if (
    current &&
    current.publicationEpoch === snapshot.publicationEpoch &&
    snapshot.snapshotVersion <= current.snapshotVersion &&
    !isExactCurrentReplay
  ) {
    return WEB_SESSION_TABS_FRAME_OUTRANKED
  }
  replayableSessionTabsSnapshotByWorktree.delete(key)
  latestSessionTabsSnapshotByWorktree.set(key, {
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion
  })
  trackWebSessionTabsWorktree(environmentId, snapshot.worktree)
  recordAcceptedWebSessionTabsEnvironment(environmentId, snapshot)
  // Why: a mounted mirror that exhausted bounded polling needs fresh host evidence without subscribing to every store write.
  queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
  return WEB_SESSION_TABS_FRAME_APPLIED
}
