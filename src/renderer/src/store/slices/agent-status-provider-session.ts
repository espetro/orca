import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { resolveAgentPaneAuthorityKey } from './agent-pane-authority'
import { removePaneKeys } from './agent-status-record-pruning'
import { isRecentlyClosedAgentStatusTab } from './agent-status-retention'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key'
import { copyLaunchConfig, registryEntryMatchesStatus } from './agent-launch-config-registry'
import type {
  AgentProviderSessionRecordMetadata,
  AgentProviderSessionRouting,
  AgentProviderSessionTiming
} from './agent-status-types'
import type { AgentStatusGetFn, AgentStatusSetFn } from './agent-status-action-context'

export function recordAgentProviderSessionAction(
  paneKey: string,
  agent: ResumableTuiAgent,
  providerSession: AgentProviderSessionMetadata,
  requestAgentStatusFreshness: (acceptedInBatch: boolean) => void,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn,
  timing?: AgentProviderSessionTiming,
  routing?: AgentProviderSessionRouting,
  metadata?: AgentProviderSessionRecordMetadata
): void {
  paneKey = resolveAgentPaneAuthorityKey(paneKey)
  const updatedAt = timing?.updatedAt ?? Date.now()
  if (
    paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
    isRecentlyClosedAgentStatusTab(
      get().recentlyClosedAgentStatusTabIds,
      getTabIdFromPaneKey(paneKey)
    ) ||
    !getAgentResumeArgv(agent, providerSession)
  ) {
    return
  }
  let removedLiveStatus = false
  set((s) => {
    const existingStatus = s.agentStatusByPaneKey[paneKey]
    const existingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
    if (
      (existingStatus && updatedAt < existingStatus.updatedAt) ||
      (existingRecord && updatedAt < existingRecord.updatedAt)
    ) {
      return s
    }
    const tabId = routing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? existingRecord?.tabId
    const worktreeId =
      routing?.worktreeId ??
      existingStatus?.worktreeId ??
      existingRecord?.worktreeId ??
      findAgentPaneWorktreeId(s, paneKey)
    if (!worktreeId) {
      return s
    }
    const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
    const registryMatches = registryEntryMatchesStatus({
      entry: registryEntry,
      paneKey,
      agentType: agent,
      tabId,
      terminalHandle: undefined,
      launchToken: metadata?.launchToken,
      providerSession,
      existingProviderSession: existingRecord?.providerSession,
      providerSessionChanged: false
    })
    const existingRecordMatchesProviderSession =
      existingRecord?.agent === agent &&
      agentProviderSessionsEqual(agent, existingRecord.providerSession, providerSession)
    // Why: provider-session heartbeats can arrive after the turn is complete; preserve the
    // completed checkpoint so a late heartbeat cannot make it eligible for ghost resume.
    const preservesCompletedRecoveryRecord =
      existingRecordMatchesProviderSession && existingRecord?.state === 'done'
    // Why: an explicit quit capture must remain the resume handle until a new provider session replaces it.
    const preservesQuitOrigin =
      existingRecordMatchesProviderSession && existingRecord?.origin === 'quit'
    const launchConfig =
      (registryMatches ? registryEntry?.launchConfig : undefined) ??
      (existingRecordMatchesProviderSession ? existingRecord.launchConfig : undefined)
    const record: SleepingAgentSessionRecord = {
      paneKey,
      ...(tabId ? { tabId } : {}),
      worktreeId,
      agent,
      providerSession,
      prompt: '',
      // Why: durable process/session identity, not visible turn state; a non-done value keeps cold restore eligible.
      state: preservesCompletedRecoveryRecord ? 'done' : 'working',
      capturedAt: updatedAt,
      updatedAt,
      ...(existingStatus?.terminalTitle
        ? { terminalTitle: existingStatus.terminalTitle }
        : existingRecord?.terminalTitle
          ? { terminalTitle: existingRecord.terminalTitle }
          : {}),
      ...(routing?.connectionId !== undefined
        ? { connectionId: routing.connectionId }
        : existingRecord?.connectionId !== undefined
          ? { connectionId: existingRecord.connectionId }
          : {}),
      ...(launchConfig ? { launchConfig: copyLaunchConfig(launchConfig) } : {}),
      ...(existingRecordMatchesProviderSession &&
      existingRecord.automaticResumeBlockedBy === 'legacy-orchestration-worker'
        ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' }
        : {}),
      ...(preservesCompletedRecoveryRecord && existingRecord.interrupted !== undefined
        ? { interrupted: existingRecord.interrupted }
        : {}),
      origin: preservesQuitOrigin ? 'quit' : 'live'
    }
    removedLiveStatus = existingStatus !== undefined
    const nextLive = removedLiveStatus ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
    if (removedLiveStatus) {
      delete nextLive[paneKey]
    }
    const nextRetained =
      paneKey in s.retainedAgentsByPaneKey
        ? { ...s.retainedAgentsByPaneKey }
        : s.retainedAgentsByPaneKey
    if (nextRetained !== s.retainedAgentsByPaneKey) {
      delete nextRetained[paneKey]
    }
    // Why: on identity mismatch the sleeping record drops its launch config, so clear the stale
    // registry entry too, else a later return to the old identity reuses stale args/env.
    let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
    if (registryMatches && registryEntry) {
      nextLaunchConfigs = {
        ...nextLaunchConfigs,
        [paneKey]: {
          ...registryEntry,
          identity: { ...registryEntry.identity, providerSession }
        }
      }
    } else if (registryEntry) {
      nextLaunchConfigs = { ...nextLaunchConfigs }
      delete nextLaunchConfigs[paneKey]
    }
    return {
      agentStatusByPaneKey: nextLive,
      retainedAgentsByPaneKey: nextRetained,
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: record
      },
      agentLaunchConfigByPaneKey: nextLaunchConfigs,
      acknowledgedAgentsByPaneKey: removePaneKeys(
        s.acknowledgedAgentsByPaneKey,
        new Set([paneKey])
      ),
      unreadAgentCompletionPanes: removePaneKeys(s.unreadAgentCompletionPanes, new Set([paneKey])),
      agentStatusEpoch: removedLiveStatus ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
      sortEpoch: removedLiveStatus ? s.sortEpoch + 1 : s.sortEpoch
    }
  })
  if (removedLiveStatus) {
    requestAgentStatusFreshness(true)
  }
}
