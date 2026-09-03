import {
  buildRetiredTerminalTabStateSweepPatch,
  type RetiredTerminalTabSweepState
} from '../store/slices/retired-terminal-tab-state-sweep'
import type { WebSessionTabsBatchContext } from './web-session-tabs-batch-records'
import { updateBatchAgentPaneKey } from './web-session-tabs-agent-pane-key-index'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import { isMirroredTerminalSurfaceId } from './web-session-tabs-mirrored-terminal-tabs'

// Why: the closed-tab marker has no TTL, and setAgentStatus hard-drops writes for a
// marked tab id — for a stable mirrored id that returns, that is a permanent silent
// blackhole unless presence in a snapshot lifts it.
export function buildRemirroredClosedTabMarkerLiftPatch(
  recentlyClosedAgentStatusTabIds: WebSessionTabsSyncState['recentlyClosedAgentStatusTabIds'],
  mirroredTerminalIds: ReadonlySet<string>
): Partial<WebSessionTabsSyncState> | null {
  let next: WebSessionTabsSyncState['recentlyClosedAgentStatusTabIds'] | null = null
  for (const tabId of mirroredTerminalIds) {
    if (tabId in (recentlyClosedAgentStatusTabIds ?? {})) {
      next ??= { ...recentlyClosedAgentStatusTabIds }
      delete next[tabId]
    }
  }
  return next ? { recentlyClosedAgentStatusTabIds: next } : null
}

/**
 * A host retraction owes the retracted tab closeTab's renderer-state sweep: without it,
 * client-owned rows (STA-3107-exempt in the mirror's delete loop) and retention promotions
 * outlive the tab forever (STA-4593).
 */
export function buildRetractedMirroredTabSweepPatch(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  nextTabsByWorktree: WebSessionTabsSyncState['tabsByWorktree'],
  agentStatusPatch: Pick<
    WebSessionTabsSyncState,
    'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'
  > | null,
  removedTerminalResourceIds: readonly string[],
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> | null {
  // Why: only a mirrored id the host stopped publishing is a retraction — a local or provisional
  // tab in this list is being renamed into its mirror, and a rename must keep its rows.
  const retractedTabIds = removedTerminalResourceIds.filter(isMirroredTerminalSurfaceId)
  if (retractedTabIds.length === 0) {
    return null
  }
  const sweepState: RetiredTerminalTabSweepState = {
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey ?? {},
    agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey ?? {},
    agentStatusByPaneKey: agentStatusPatch?.agentStatusByPaneKey ?? state.agentStatusByPaneKey,
    agentStatusEpoch: agentStatusPatch?.agentStatusEpoch ?? state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId ?? {},
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey ?? {},
    recentlyClosedAgentStatusTabIds: state.recentlyClosedAgentStatusTabIds ?? {},
    recentlyRetiredAgentStatusPaneKeys: state.recentlyRetiredAgentStatusPaneKeys ?? {},
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey ?? {},
    retentionSuppressedPaneKeys: state.retentionSuppressedPaneKeys ?? {},
    sortEpoch: agentStatusPatch?.sortEpoch ?? state.sortEpoch,
    // Why: the drop's completed-orphan rule reads "keyed under a tab this worktree no longer has",
    // so it must see the post-removal tab list, not the one the snapshot replaced.
    tabsByWorktree: nextTabsByWorktree
  }
  const sweep = buildRetiredTerminalTabStateSweepPatch(sweepState, retractedTabIds, worktreeId)
  if (!sweep?.agentStatusByPaneKey || !batchContext) {
    return sweep ?? null
  }
  // Why: the batch republishes its own record copy at the end, which would undo the sweep.
  const mutableState = state as unknown as Record<string, unknown>
  mutableState.agentStatusByPaneKey = sweep.agentStatusByPaneKey
  batchContext.changedRecords.add('agentStatusByPaneKey')
  for (const paneKey of Object.keys(sweepState.agentStatusByPaneKey)) {
    if (!(paneKey in sweep.agentStatusByPaneKey)) {
      updateBatchAgentPaneKey(paneKey, false, batchContext)
    }
  }
  return sweep
}
