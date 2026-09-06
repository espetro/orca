import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  pruneMigrationUnsupportedEntries,
  collectWorktreeIdsForConnection
} from './agent-status-record-pruning'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-tab-prefix'

type SetFn = (update: (state: AppState) => AppState | Partial<AppState>) => void

export function removeAgentStatusAction(paneKey: string, get: () => AppState, set: SetFn): boolean {
  if (
    !(paneKey in get().agentStatusByPaneKey) &&
    !(paneKey in get().agentLaunchConfigByPaneKey) &&
    !Object.values(get().migrationUnsupportedByPtyId).some((entry) => entry.paneKey === paneKey)
  ) {
    return false
  }
  let hadLive = false
  set((s) => {
    const hasLive = paneKey in s.agentStatusByPaneKey
    hadLive = hasLive
    const next = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
    if (hasLive) {
      delete next[paneKey]
    }
    const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
    const nextLaunchConfigs = hasLaunchConfig
      ? { ...s.agentLaunchConfigByPaneKey }
      : s.agentLaunchConfigByPaneKey
    if (hasLaunchConfig) {
      delete nextLaunchConfigs[paneKey]
    }
    const migrationUnsupported = pruneMigrationUnsupportedEntries(
      s.migrationUnsupportedByPtyId,
      (entry) => entry.paneKey === paneKey
    )
    // Why: drop the ack entry with the pane so a future paneKey collision can't inherit a stale ack that suppresses "unvisited" signals.
    let nextAck = s.acknowledgedAgentsByPaneKey
    if (paneKey in nextAck) {
      nextAck = { ...nextAck }
      delete nextAck[paneKey]
    }
    // Why: bump sortEpoch with agentStatusEpoch — removing an agent can change worktree sort order (same as setAgentStatus).
    return {
      agentStatusByPaneKey: next,
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      migrationUnsupportedByPtyId: migrationUnsupported.next,
      ...(nextAck !== s.acknowledgedAgentsByPaneKey
        ? { acknowledgedAgentsByPaneKey: nextAck }
        : {}),
      agentStatusEpoch: s.agentStatusEpoch + 1,
      sortEpoch: s.sortEpoch + 1
    }
  })
  return hadLive
}

export function removeAgentStatusByTabPrefixAction(
  tabIdPrefix: string,
  get: () => AppState,
  set: SetFn
): boolean {
  const prefix = `${tabIdPrefix}:`
  const currentKeys = Object.keys(get().agentStatusByPaneKey)
  const toRemove = currentKeys.filter((k) => k.startsWith(prefix))
  const launchConfigKeys = Object.keys(get().agentLaunchConfigByPaneKey).filter((k) =>
    k.startsWith(prefix)
  )
  const hasMigrationUnsupported = Object.values(get().migrationUnsupportedByPtyId).some((entry) =>
    entry.paneKey?.startsWith(prefix)
  )
  if (toRemove.length === 0 && launchConfigKeys.length === 0 && !hasMigrationUnsupported) {
    return false
  }
  let hadLive = false
  set((s) => {
    hadLive = toRemove.length > 0
    const next = { ...s.agentStatusByPaneKey }
    for (const key of toRemove) {
      delete next[key]
    }
    const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
    for (const key of launchConfigKeys) {
      delete nextLaunchConfigs[key]
    }
    const migrationUnsupported = pruneMigrationUnsupportedEntries(
      s.migrationUnsupportedByPtyId,
      (entry) => entry.paneKey?.startsWith(prefix) ?? false
    )
    // See removeAgentStatus for rationale on ack cleanup.
    let nextAck = s.acknowledgedAgentsByPaneKey
    const ackKeys = Object.keys(nextAck).filter((k) => k.startsWith(prefix))
    if (ackKeys.length > 0) {
      nextAck = { ...nextAck }
      for (const k of ackKeys) {
        delete nextAck[k]
      }
    }
    // Why: bump sortEpoch with agentStatusEpoch — removing agents can change worktree sort order (same as setAgentStatus).
    return {
      agentStatusByPaneKey: next,
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      migrationUnsupportedByPtyId: migrationUnsupported.next,
      ...(nextAck !== s.acknowledgedAgentsByPaneKey
        ? { acknowledgedAgentsByPaneKey: nextAck }
        : {}),
      agentStatusEpoch: s.agentStatusEpoch + 1,
      sortEpoch: s.sortEpoch + 1
    }
  })
  return hadLive
}

export function clearTransientAgentStatusesAction(
  connectionId: string,
  clearedAt: number,
  get: () => AppState,
  set: SetFn
): boolean {
  if (connectionId.length === 0 || !Number.isFinite(clearedAt)) {
    return false
  }
  let removed = false
  set((s) => {
    const worktreeIdsOnConnection = collectWorktreeIdsForConnection(s, connectionId)
    let next: Record<string, AgentStatusEntry> | null = null
    for (const [paneKey, existing] of Object.entries(s.agentStatusByPaneKey)) {
      if (existing.updatedAt > clearedAt) {
        continue
      }
      // Why: clear rows stamped for this connection, plus UNSTAMPED (never-stamped) worktree
      // rows unambiguously on it (#9030). An explicit stamp — another host's connectionId, or a
      // local `null` — is authoritative and never overridden by worktree inference.
      const belongsToConnection =
        existing.connectionId === connectionId ||
        (existing.connectionId === undefined &&
          existing.worktreeId !== undefined &&
          worktreeIdsOnConnection.has(existing.worktreeId))
      if (!belongsToConnection) {
        continue
      }
      next ??= { ...s.agentStatusByPaneKey }
      delete next[paneKey]
    }
    const wasAlreadyBlocked = connectionId in s.transientClearedAgentStatusConnectionIds
    if (!next && wasAlreadyBlocked) {
      return s
    }
    removed = next !== null
    // Why: transport loss is reversible. Keep launch, resume, retention,
    // and acknowledgement maps intact for same-pane relay replay.
    return {
      ...(next
        ? {
            agentStatusByPaneKey: next,
            agentStatusEpoch: s.agentStatusEpoch + 1,
            sortEpoch: s.sortEpoch + 1
          }
        : {}),
      transientClearedAgentStatusConnectionIds: wasAlreadyBlocked
        ? s.transientClearedAgentStatusConnectionIds
        : { ...s.transientClearedAgentStatusConnectionIds, [connectionId]: true }
    }
  })
  return removed
}

export function dropAgentStatusAction(paneKey: string, get: () => AppState, set: SetFn): boolean {
  // Why: zustand set is synchronous, so capture liveExisted once inside the callback instead of double-reading the store.
  let liveExisted = false
  set((s) => {
    const hasLive = paneKey in s.agentStatusByPaneKey
    liveExisted = hasLive
    const hasRetained = paneKey in s.retainedAgentsByPaneKey
    const migrationUnsupported = pruneMigrationUnsupportedEntries(
      s.migrationUnsupportedByPtyId,
      (entry) => entry.paneKey === paneKey
    )
    // See removeAgentStatus for ack-cleanup rationale; the ack entry is owned by the pane lifecycle regardless of live/retained state.
    let nextAck = s.acknowledgedAgentsByPaneKey
    if (paneKey in nextAck) {
      nextAck = { ...nextAck }
      delete nextAck[paneKey]
    }
    const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
    const nextLaunchConfigs = hasLaunchConfig
      ? { ...s.agentLaunchConfigByPaneKey }
      : s.agentLaunchConfigByPaneKey
    if (hasLaunchConfig) {
      delete nextLaunchConfigs[paneKey]
    }
    // Why: short-circuit when there's nothing to change, but still flush a pending ack or launch-config cleanup if one is present.
    if (!hasLive && !hasRetained && !migrationUnsupported.changed) {
      if (hasLaunchConfig) {
        return {
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {})
        }
      }
      if (nextAck !== s.acknowledgedAgentsByPaneKey) {
        return { acknowledgedAgentsByPaneKey: nextAck }
      }
      return s
    }

    const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
    if (hasLive) {
      delete nextLive[paneKey]
    }
    const nextRetained = hasRetained ? { ...s.retainedAgentsByPaneKey } : s.retainedAgentsByPaneKey
    if (hasRetained) {
      delete nextRetained[paneKey]
    }

    // Why: explicit teardown must not let retention sync resurrect this row — plant a one-shot suppressor, but only when hasLive (a retained-only key has no live→gone transition to consume it, so it leaks) and not already present (re-spreading spuriously re-renders subscribers).
    const needsSuppressorWrite = hasLive && !(paneKey in s.retentionSuppressedPaneKeys)

    return {
      agentStatusByPaneKey: nextLive,
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      retainedAgentsByPaneKey: nextRetained,
      migrationUnsupportedByPtyId: migrationUnsupported.next,
      ...(nextAck !== s.acknowledgedAgentsByPaneKey
        ? { acknowledgedAgentsByPaneKey: nextAck }
        : {}),
      ...(needsSuppressorWrite
        ? {
            retentionSuppressedPaneKeys: {
              ...s.retentionSuppressedPaneKeys,
              [paneKey]: true
            }
          }
        : {}),
      agentStatusEpoch:
        hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
      // Why: mirrors removeAgentStatus — dropping a live agent changes its worktree sort score, so bump sortEpoch to recompute the sidebar smart-sort.
      sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
    }
  })
  return liveExisted
}

export function dropAgentStatusByTabPrefixAction(
  tabIdPrefix: string,
  retiredAliasPaneKeys: string[],
  opts: { sleepingPaneKeys?: string[] } | undefined,
  get: () => AppState,
  set: SetFn
): boolean {
  let hadLive = false
  set((s) => {
    const dropped = buildAgentStatusTabPrefixDropPatch(s, tabIdPrefix, retiredAliasPaneKeys, opts)
    hadLive = dropped.hadLive
    return dropped.patch
  })
  return hadLive
}
