import type { AppState } from '../types'
import type { RetainedAgentEntry } from './agent-status-types'
import { pruneMigrationUnsupportedEntries } from './agent-status-record-pruning'
import { retainedAgentEntryFromLive, shouldReplaceRetainedWithLive } from './agent-status-retention'
import { normalizePaneKeySet, paneKeyMatchesAnyTabPrefix } from './agent-sleeping-sessions'

type SetFn = (update: (state: AppState) => AppState | Partial<AppState>) => void

export function dropHibernatedAgentStatusPaneAction(
  worktreeId: string,
  paneKey: string,
  opts: { retainedCompletionEvidence?: RetainedAgentEntry[] } | undefined,
  get: () => AppState,
  set: SetFn
): boolean {
  let hadLive = false
  set((s) => {
    const liveEntry = s.agentStatusByPaneKey[paneKey]
    const hasLive = liveEntry !== undefined
    const hasRetained = paneKey in s.retainedAgentsByPaneKey
    const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
    const migrationUnsupported = pruneMigrationUnsupportedEntries(
      s.migrationUnsupportedByPtyId,
      (entry) => entry.paneKey === paneKey
    )
    const retainedEvidence = new Map<string, RetainedAgentEntry>()
    for (const retained of opts?.retainedCompletionEvidence ?? []) {
      if (
        retained.entry.paneKey === paneKey &&
        !liveEntry &&
        shouldReplaceRetainedWithLive(retainedEvidence.get(paneKey), retained)
      ) {
        retainedEvidence.set(paneKey, retained)
      }
    }
    if (
      liveEntry?.state === 'done' &&
      liveEntry.agentType !== undefined &&
      liveEntry.interrupted !== true
    ) {
      retainedEvidence.set(
        paneKey,
        retainedAgentEntryFromLive(s, worktreeId, liveEntry, liveEntry.agentType)
      )
    }
    const keepsCompletionEvidence = retainedEvidence.has(paneKey)
    let nextAck = s.acknowledgedAgentsByPaneKey
    if (!keepsCompletionEvidence && paneKey in nextAck) {
      nextAck = { ...nextAck }
      delete nextAck[paneKey]
    }
    if (
      !hasLive &&
      !hasRetained &&
      !hasLaunchConfig &&
      !migrationUnsupported.changed &&
      !keepsCompletionEvidence
    ) {
      if (nextAck !== s.acknowledgedAgentsByPaneKey) {
        return { acknowledgedAgentsByPaneKey: nextAck }
      }
      return s
    }
    hadLive = hasLive

    const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
    if (hasLive) {
      delete nextLive[paneKey]
    }
    const nextLaunchConfigs = hasLaunchConfig
      ? { ...s.agentLaunchConfigByPaneKey }
      : s.agentLaunchConfigByPaneKey
    if (hasLaunchConfig) {
      delete nextLaunchConfigs[paneKey]
    }

    const nextRetained =
      hasRetained || keepsCompletionEvidence
        ? { ...s.retainedAgentsByPaneKey }
        : s.retainedAgentsByPaneKey
    if (hasRetained && !keepsCompletionEvidence) {
      delete nextRetained[paneKey]
    }
    for (const [key, retained] of retainedEvidence) {
      if (shouldReplaceRetainedWithLive(nextRetained[key], retained)) {
        nextRetained[key] = retained
      }
    }

    const needsSuppressor =
      hasLive && !keepsCompletionEvidence && !(paneKey in s.retentionSuppressedPaneKeys)

    return {
      agentStatusByPaneKey: nextLive,
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      retainedAgentsByPaneKey: nextRetained,
      migrationUnsupportedByPtyId: migrationUnsupported.next,
      ...(nextAck !== s.acknowledgedAgentsByPaneKey
        ? { acknowledgedAgentsByPaneKey: nextAck }
        : {}),
      ...(needsSuppressor
        ? {
            retentionSuppressedPaneKeys: {
              ...s.retentionSuppressedPaneKeys,
              [paneKey]: true
            }
          }
        : {}),
      agentStatusEpoch:
        hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
      sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
    }
  })
  return hadLive
}

export function dropAgentStatusByWorktreeAction(
  worktreeId: string,
  opts:
    | {
        sleepingPaneKeys?: string[]
        retainedCompletionEvidence?: RetainedAgentEntry[]
        shutdownReason?: string
      }
    | undefined,
  get: () => AppState,
  set: SetFn
): boolean {
  let hadLive = false
  set((s) => {
    const tabPrefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
    const liveEntries = Object.entries(s.agentStatusByPaneKey).filter(
      ([paneKey, entry]) =>
        entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
    )
    const liveKeys = liveEntries.map(([paneKey]) => paneKey)
    const liveKeySet = new Set(liveKeys)
    const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
      (paneKey) => paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes) || liveKeySet.has(paneKey)
    )
    const retainedKeys = Object.entries(s.retainedAgentsByPaneKey)
      .filter(
        ([paneKey, retained]) =>
          retained.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
      )
      .map(([paneKey]) => paneKey)
    const retainedKeySet = new Set(retainedKeys)
    const migrationUnsupported = pruneMigrationUnsupportedEntries(
      s.migrationUnsupportedByPtyId,
      (entry) =>
        entry.worktreeId === worktreeId ||
        (entry.paneKey ? paneKeyMatchesAnyTabPrefix(entry.paneKey, tabPrefixes) : false)
    )
    const allowedPaneKeys = normalizePaneKeySet(opts?.sleepingPaneKeys)
    const preserveHibernatedEvidence =
      opts?.shutdownReason === 'auto-hibernate-completed-agent' &&
      allowedPaneKeys !== null &&
      allowedPaneKeys.size > 0
    const liveEntryByPaneKey = new Map(liveEntries)
    const retainedEvidence = new Map<string, RetainedAgentEntry>()
    if (preserveHibernatedEvidence) {
      for (const retained of opts?.retainedCompletionEvidence ?? []) {
        if (
          allowedPaneKeys.has(retained.entry.paneKey) &&
          !liveEntryByPaneKey.has(retained.entry.paneKey) &&
          shouldReplaceRetainedWithLive(retainedEvidence.get(retained.entry.paneKey), retained)
        ) {
          retainedEvidence.set(retained.entry.paneKey, retained)
        }
      }
      for (const [paneKey, entry] of liveEntries) {
        const agentType = entry.agentType
        if (
          allowedPaneKeys.has(paneKey) &&
          entry.state === 'done' &&
          agentType !== undefined &&
          entry.interrupted !== true
        ) {
          retainedEvidence.set(paneKey, retainedAgentEntryFromLive(s, worktreeId, entry, agentType))
        }
      }
    }
    const retainedEvidenceKeys = new Set(retainedEvidence.keys())
    // See removeAgentStatus for ack-cleanup rationale; auto-hibernated completion evidence keeps its read state so a slept card doesn't turn bold again.
    let nextAck = s.acknowledgedAgentsByPaneKey
    const ackKeys = Object.keys(nextAck).filter(
      (k) =>
        !retainedEvidenceKeys.has(k) &&
        (paneKeyMatchesAnyTabPrefix(k, tabPrefixes) || liveKeySet.has(k) || retainedKeySet.has(k))
    )
    if (ackKeys.length > 0) {
      nextAck = { ...nextAck }
      for (const key of ackKeys) {
        delete nextAck[key]
      }
    }
    // Mirror dropAgentStatusByTabPrefix: when nothing live/retained changed, return just the ack delta (or s) to avoid full-state re-renders.
    if (
      liveKeys.length === 0 &&
      launchConfigKeys.length === 0 &&
      retainedKeys.length === 0 &&
      retainedEvidence.size === 0 &&
      !migrationUnsupported.changed
    ) {
      if (nextAck !== s.acknowledgedAgentsByPaneKey) {
        return { acknowledgedAgentsByPaneKey: nextAck }
      }
      return s
    }
    hadLive = liveKeys.length > 0

    const nextLive = liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
    for (const key of liveKeys) {
      delete nextLive[key]
    }
    const nextLaunchConfigs =
      launchConfigKeys.length > 0
        ? { ...s.agentLaunchConfigByPaneKey }
        : s.agentLaunchConfigByPaneKey
    for (const key of launchConfigKeys) {
      delete nextLaunchConfigs[key]
    }

    const nextRetained =
      retainedKeys.length > 0 || retainedEvidence.size > 0
        ? { ...s.retainedAgentsByPaneKey }
        : s.retainedAgentsByPaneKey
    for (const key of retainedKeys) {
      if (!retainedEvidenceKeys.has(key)) {
        delete nextRetained[key]
      }
    }
    for (const [paneKey, retained] of retainedEvidence) {
      if (shouldReplaceRetainedWithLive(nextRetained[paneKey], retained)) {
        nextRetained[paneKey] = retained
      }
    }

    // Why: suppress live rows on teardown, but skip auto-hibernated `done` rows — they become retained evidence a suppressor would erase next sync.
    const suppressorAdds = liveKeys.filter(
      (k) => !retainedEvidenceKeys.has(k) && !(k in s.retentionSuppressedPaneKeys)
    )
    let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
    if (suppressorAdds.length > 0) {
      nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
      for (const key of suppressorAdds) {
        nextRetentionSuppressedPaneKeys[key] = true
      }
    }

    return {
      agentStatusByPaneKey: nextLive,
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      retainedAgentsByPaneKey: nextRetained,
      migrationUnsupportedByPtyId: migrationUnsupported.next,
      retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
      ...(nextAck !== s.acknowledgedAgentsByPaneKey
        ? { acknowledgedAgentsByPaneKey: nextAck }
        : {}),
      agentStatusEpoch:
        hadLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
      sortEpoch: hadLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
    }
  })
  return hadLive
}
