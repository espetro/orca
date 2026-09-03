import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { pruneMigrationUnsupportedEntries, removePaneKeys } from './agent-status-record-pruning'
import { capLiveAgentStatusesInPlace, classifyPaneKeyLiveness } from './agent-status-retention'
import { findAgentPaneWorktreeId } from './agent-status-pane-key'
import { recoveryRecordMatches, sleepingRecordFromEntry } from './agent-sleeping-sessions'
import type { AppState } from '../../types'

export type AgentStatusIngestCommitInputs = {
  payload: ParsedAgentStatusPayload
  existing: AgentStatusEntry | undefined
  entry: AgentStatusEntry
  identity: { agentType: AgentStatusEntry['agentType'] }
  commandCodeNewTurn: boolean
  providerSession: AgentStatusEntry['providerSession']
  providerSessionChanged: boolean
  registryEntry: AppState['agentLaunchConfigByPaneKey'][string] | undefined
  matchedRegistryLaunchConfig: unknown
  existingSleepingRecord: AppState['sleepingAgentSessionsByPaneKey'][string] | undefined
  launchConfigSource: unknown
  retainsResumableRecoveryIdentity: boolean
}

export function applyAgentStatusIngestCommit(
  paneKey: string,
  updatedAt: number,
  s: AppState,
  inputs: AgentStatusIngestCommitInputs
): Partial<AppState> {
  const {
    payload,
    existing,
    entry,
    identity,
    commandCodeNewTurn,
    providerSession,
    providerSessionChanged,
    registryEntry,
    matchedRegistryLaunchConfig,
    existingSleepingRecord,
    launchConfigSource,
    retainsResumableRecoveryIdentity
  } = inputs
  // Why: emit a global tick only when an entry appears, changes state, crosses stale→fresh,
  // or is a same-state `done` update — same-state working pings must not fan out to aggregates.
  const wasFresh =
    !!existing && isExplicitAgentStatusFresh(existing, updatedAt, AGENT_STATUS_STALE_AFTER_MS)
  // Why: a late main-process attribution stamp can change which workspace stays visible without changing agent state.
  const attributionChanged =
    existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
  // Why: main can advance stateStartedAt on a same-state turn boundary the renderer
  // missed; treat that as sort-relevant so smart sort never goes stale.
  // Non-Command-Code agents never advance stateStartedAt at a fixed state, so this stays CC-scoped.
  const sameStateStateStartedAtChanged =
    !!existing &&
    existing.state === payload.state &&
    entry.stateStartedAt !== existing.stateStartedAt
  const sameStateDoneAttentionChanged =
    existing?.state === 'done' &&
    entry.state === 'done' &&
    agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
  const workingModeChanged = existing?.workingMode !== entry.workingMode
  const sortRelevantChange =
    !existing ||
    existing.state !== payload.state ||
    !wasFresh ||
    attributionChanged ||
    commandCodeNewTurn ||
    sameStateStateStartedAtChanged ||
    sameStateDoneAttentionChanged
  const doneRetentionFieldsChanged =
    existing?.state === 'done' &&
    entry.state === 'done' &&
    (entry.prompt !== existing.prompt ||
      entry.updatedAt !== existing.updatedAt ||
      entry.stateStartedAt !== existing.stateStartedAt ||
      entry.agentType !== existing.agentType ||
      entry.model !== existing.model ||
      entry.terminalTitle !== existing.terminalTitle ||
      entry.toolName !== existing.toolName ||
      entry.toolInput !== existing.toolInput ||
      entry.lastAssistantMessage !== existing.lastAssistantMessage ||
      entry.orchestration !== existing.orchestration ||
      entry.subagents !== existing.subagents ||
      entry.providerSession !== existing.providerSession ||
      entry.interrupted !== existing.interrupted)
  const retentionRelevantChange =
    sortRelevantChange || attributionChanged || workingModeChanged || doneRetentionFieldsChanged
  // Why: a fresh status means the agent is live again — lift its one-shot retention suppressor.
  // Clone the map only when a suppressor exists, else every high-frequency ping churns the ref.
  const hasSuppressor = paneKey in s.retentionSuppressedPaneKeys
  let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
  if (hasSuppressor) {
    nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
    delete nextRetentionSuppressedPaneKeys[paneKey]
  }
  // Why: pane keys are reused across turns, so a fresh live row makes any retained snapshot stale — drop it so it doesn't render beside the live row.
  const hasRetainedSnapshot = paneKey in s.retainedAgentsByPaneKey
  const nextRetainedAgents = hasRetainedSnapshot
    ? { ...s.retainedAgentsByPaneKey }
    : s.retainedAgentsByPaneKey
  if (hasRetainedSnapshot) {
    delete nextRetainedAgents[paneKey]
  }
  const migrationUnsupported = pruneMigrationUnsupportedEntries(
    s.migrationUnsupportedByPtyId,
    (entry) => entry.paneKey === paneKey
  )
  const liveRecoveryWorktreeId =
    entry.state === 'done' && !retainsResumableRecoveryIdentity
      ? null
      : (entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey))
  const liveRecoveryRecord = liveRecoveryWorktreeId
    ? sleepingRecordFromEntry({
        state: s,
        // Why: keep the resume identity of a finished turn without its text,
        // but never restate `done` as pending work — the resume sweep reads
        // that state to tell an interrupted agent from a completed one, and
        // a lie there respawns every finished agent whose pane was killed.
        entry: retainsResumableRecoveryIdentity
          ? { ...entry, prompt: '', lastAssistantMessage: undefined }
          : entry,
        worktreeId: liveRecoveryWorktreeId,
        capturedAt: updatedAt,
        launchConfig: launchConfigSource,
        origin: 'live'
      })
    : null
  let nextSleepingAgentSessions = s.sleepingAgentSessionsByPaneKey
  let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
  if (
    matchedRegistryLaunchConfig &&
    registryEntry &&
    providerSession &&
    !agentProviderSessionsEqual(
      identity.agentType,
      registryEntry.identity.providerSession,
      providerSession
    )
  ) {
    nextLaunchConfigs = {
      ...nextLaunchConfigs,
      [paneKey]: {
        ...registryEntry,
        identity: {
          ...registryEntry.identity,
          providerSession
        }
      }
    }
  }
  // Why: launch tokens can outlive an Orca-started TUI in the shell; once the session is done they must no longer authorize config reuse.
  // A session-boundary done is the session CONNECTING (STA-3386) — deleting here would strip
  // the pane's registered-launch-agent identity evidence the moment a resumed TUI sits idle.
  if (
    (providerSessionChanged || (entry.state === 'done' && entry.sessionBoundary !== true)) &&
    paneKey in s.agentLaunchConfigByPaneKey
  ) {
    nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
    delete nextLaunchConfigs[paneKey]
  }
  if (liveRecoveryRecord) {
    if (!recoveryRecordMatches(existingSleepingRecord, liveRecoveryRecord)) {
      nextSleepingAgentSessions = {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: liveRecoveryRecord
      }
    }
  } else if (existingSleepingRecord) {
    nextSleepingAgentSessions = { ...s.sleepingAgentSessionsByPaneKey }
    delete nextSleepingAgentSessions[paneKey]
  }
  const nextLive = { ...s.agentStatusByPaneKey, [paneKey]: entry }
  // Why: cap the live map so a huge map's per-ping spread copy can't OOM the renderer (#9872).
  const evictedPaneKeys = capLiveAgentStatusesInPlace(
    nextLive,
    paneKey,
    () => classifyPaneKeyLiveness(s),
    updatedAt
  )
  const evictedOrphans = evictedPaneKeys.length > 0
  if (evictedOrphans) {
    const evictedPaneKeySet = new Set(evictedPaneKeys)
    nextSleepingAgentSessions = removePaneKeys(nextSleepingAgentSessions, evictedPaneKeySet)
    nextLaunchConfigs = removePaneKeys(nextLaunchConfigs, evictedPaneKeySet)
  }
  return {
    agentStatusByPaneKey: nextLive,
    retainedAgentsByPaneKey: nextRetainedAgents,
    sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions,
    agentLaunchConfigByPaneKey: nextLaunchConfigs,
    migrationUnsupportedByPtyId: migrationUnsupported.next,
    retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
    agentStatusEpoch:
      retentionRelevantChange || migrationUnsupported.changed || evictedOrphans
        ? s.agentStatusEpoch + 1
        : s.agentStatusEpoch,
    sortEpoch:
      sortRelevantChange || migrationUnsupported.changed || evictedOrphans
        ? s.sortEpoch + 1
        : s.sortEpoch
  }
}
