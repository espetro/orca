import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

import type { SnapshotFreshness } from './web-session-tabs-sync-state'
import type { WebSessionTabsSnapshotDecision } from './web-session-tabs-snapshot-decision'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-snapshot-decision'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-apply-snapshot'
export type VisibilityResumeOmission = {
  baseline: SnapshotFreshness
  environmentId: string
  inventoryReceivedFrame: number
  superseded: boolean
  visibilityGeneration: number
}
export type WebSessionTabsSnapshotOperation = {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
}

export type DecidedWebSessionTabsSnapshotOperation = WebSessionTabsSnapshotOperation & {
  decision: WebSessionTabsSnapshotDecision
}

/** Why: the settle must name the decision the apply ran on, so each operation
 *  is decided once here instead of again inside the store updater. */
export function decideWebSessionTabsSnapshotOperations(
  operations: readonly WebSessionTabsSnapshotOperation[]
): DecidedWebSessionTabsSnapshotOperation[] {
  return operations.map((operation) => ({
    ...operation,
    decision: decideWebSessionTabsSnapshot(operation.snapshot, operation.environmentId)
  }))
}

export function applyWebSessionTabsSnapshotOperations(
  state: WebSessionTabsSyncState,
  operations: readonly DecidedWebSessionTabsSnapshotOperation[]
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  let nextState = state
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const { environmentId, snapshot, decision } of operations) {
    if (!decision.apply) {
      continue
    }
    const patch = applyWebSessionTabsSnapshot(nextState, snapshot, environmentId)
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    nextState = { ...nextState, ...patch }
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}
