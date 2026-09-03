import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import type { WebSessionTabsBatchContext } from './web-session-tabs-batch-records'
import type { WebSessionTabsSnapshotApplyOptions } from './web-session-tabs-snapshot-options'
import { buildWebSessionTabsMirroredContext } from './web-session-tabs-apply-context'
import { buildWebSessionTabsFocusContext } from './web-session-tabs-apply-focus'
import { buildWebSessionTabsGroupsAndTabBarOrder } from './web-session-tabs-apply-groups'
import { buildWebSessionTabsPatchRecords } from './web-session-tabs-apply-records'
import { buildWebSessionTabsSnapshotPatch } from './web-session-tabs-apply-patch-assembly'
import { shouldApplyWebSessionTabsSnapshot } from './web-session-tabs-snapshot-decision'

export function applyWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now?: number,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return applyWebSessionTabsSnapshotWithContext(
    state,
    rawSnapshot,
    environmentId,
    now,
    undefined,
    options
  )
}

export function applyWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const nextState = { ...state }
  const batchContext: WebSessionTabsBatchContext = {
    agentPaneKeysByTabId: null,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const snapshot of snapshots) {
    const patch = applyWebSessionTabsSnapshotWithContext(
      nextState,
      snapshot,
      environmentId,
      now,
      batchContext
    )
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    Object.assign(nextState, patch)
  }
  const mutableMergedPatch = mergedPatch as Record<string, unknown>
  const mutableNextState = nextState as unknown as Record<string, unknown>
  for (const recordKey of batchContext.changedRecords) {
    mutableMergedPatch[recordKey] = mutableNextState[recordKey]
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}

export function applyFreshWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (!shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)) {
    return state
  }
  return applyWebSessionTabsSnapshot(state, snapshot, environmentId, now)
}

export function applyFreshWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const freshSnapshots = snapshots.filter((snapshot) =>
    shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
  )
  return freshSnapshots.length === 0
    ? state
    : applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId, now)
}

function applyWebSessionTabsSnapshotWithContext(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  batchContext?: WebSessionTabsBatchContext,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const mirrored = buildWebSessionTabsMirroredContext(
    state,
    rawSnapshot,
    environmentId,
    now,
    batchContext,
    options
  )
  if (!mirrored) {
    return state
  }
  const ctx = buildWebSessionTabsFocusContext(
    state,
    mirrored,
    environmentId,
    rawSnapshot.worktree,
    options
  )
  const groups = buildWebSessionTabsGroupsAndTabBarOrder(
    state,
    ctx,
    environmentId,
    rawSnapshot.worktree,
    now
  )
  const records = buildWebSessionTabsPatchRecords(
    state,
    ctx,
    environmentId,
    rawSnapshot.worktree,
    batchContext
  )
  const patch = buildWebSessionTabsSnapshotPatch(
    state,
    ctx,
    groups,
    records,
    now,
    batchContext,
    options
  )
  return patch ?? state
}
