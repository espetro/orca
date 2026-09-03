import type { AppState } from '../types'
import {
  agentSubagentsEqual,
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../../../shared/command-code-turn-boundary'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { recordHibernationBoundaryResolved } from '@/lib/agent-hibernation-pane-age'
import {
  getAgentRowGeneratedTitleText,
  getOrcaDispatchTaskId,
  isOrcaDispatchPrompt,
  orchestrationLabelsMatchLiveDispatch
} from '@/lib/agent-row-primary-text'
import { resolveAgentPaneAuthorityKey } from './agent-pane-authority'
import { pruneMigrationUnsupportedEntries, removePaneKeys } from './agent-status-record-pruning'
import {
  capLiveAgentStatusesInPlace,
  classifyPaneKeyLiveness
} from './agent-status-retention'
import { mergeCurrentOrchestrationContext } from './agent-status-orchestration'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key'
import {
  copyLaunchConfig,
  registryEntryMatchesStatus
} from './agent-launch-config-registry'
import {
  recoveryRecordMatches,
  sleepingRecordFromEntry
} from './agent-sleeping-sessions'
import type {
  AgentStatusMetadata,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-types'
import type {
  AgentProviderSessionRecordMetadata,
  AgentProviderSessionRouting,
  AgentProviderSessionTiming
} from './agent-status-types'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'
import type { AgentStatusGetFn, AgentStatusSetFn } from './agent-status-action-context'

function isAgentCompletionState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

/** True when auto-title generation would no-op without replace (custom/quick/generated). */
function agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
  state: AppState,
  tabId: string | null,
  worktreeId?: string | null
): boolean {
  if (!tabId) {
    return false
  }
  const ownerTabs = worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  if (ownerTabs) {
    const tab = ownerTabs.find((candidate) => candidate.id === tabId)
    return Boolean(
      tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.generatedTitle?.trim()
    )
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(
      tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || tab.generatedTitle?.trim()
    )
  }
  return false
}


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
      unreadAgentCompletionPanes: removePaneKeys(
        s.unreadAgentCompletionPanes,
        new Set([paneKey])
      ),
      agentStatusEpoch: removedLiveStatus ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
      sortEpoch: removedLiveStatus ? s.sortEpoch + 1 : s.sortEpoch
    }
  })
  if (removedLiveStatus) {
    requestAgentStatusFreshness(true)
  }
}

export function setAgentStatusAction(
  paneKey: string,
  payload: ParsedAgentStatusPayload,
  applyGeneratedTabTitleUpdate: (update: GeneratedTabTitleUpdate) => void,
  requestAgentStatusFreshness: (acceptedInBatch: boolean) => void,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn,
  terminalTitle?: string,
  timing?: AgentStatusTiming,
  routing?: AgentStatusRouting,
  metadata?: AgentStatusMetadata
): void {
  paneKey = resolveAgentPaneAuthorityKey(paneKey)
  const updatedAt = timing?.updatedAt ?? Date.now()
  if (
    paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
    // Why: a closed tab is no longer a valid destination for hook replays or late status events.
    isRecentlyClosedAgentStatusTab(
      get().recentlyClosedAgentStatusTabIds,
      getTabIdFromPaneKey(paneKey)
    )
  ) {
    return
  }
  let completionRefreshWorktreeId: string | null = null
  let suppressedInheritedTerminalStatus = false
  const generatedTitleEntry: { current: AgentStatusEntry | null } = { current: null }
  set((s) => {
    const existing = s.agentStatusByPaneKey[paneKey]
    // Why: snapshots and live pushes share one timestamp source, so equal timestamps carry
    // identical data; strict < preserves same-millisecond live-after-live updates.
    if (existing && updatedAt < existing.updatedAt) {
      return s
    }
    // Why: terminalTitle labels the pane itself, not the turn, so a missing title means "no update" —
    // preserve the prior value to avoid flicker (unlike tool/prompt fields, which clear on a fresh turn).
    const effectiveTitle = terminalTitle ?? existing?.terminalTitle

    // Rolling log of state transitions for the dashboard's activity blocks; push only on
    // real state changes to avoid dupes from prompt-only pings within the same state.
    // A session-boundary 'done' (idle connect, STA-3386) is not a turn event — keep it
    // out of history so activity feeds and unread counts never surface it. The inverse
    // also holds: a boundary landing on a REAL done (resume//clear right after a finish)
    // must push that completion into history, or the finished timestamp and unread badge
    // lose the turn the moment the flag overwrites the live entry.
    let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
    // Why: a batched burst can fold a whole done→working turn into one publication, so a
    // completion-reactive subscriber never sees `lastAssistantMessage` while state is `done`.
    // One slot per entry, not one per history row — 20 transcripts per live status OOMs (#9872).
    let lastCompletedAssistantMessage = existing?.lastCompletedAssistantMessage
    const boundaryLandsOnRealDone =
      existing?.state === 'done' &&
      existing.sessionBoundary !== true &&
      payload.state === 'done' &&
      payload.sessionBoundary === true
    if (
      existing &&
      (existing.state !== payload.state || boundaryLandsOnRealDone) &&
      !(existing.state === 'done' && existing.sessionBoundary === true)
    ) {
      history = [
        ...history,
        {
          state: existing.state,
          prompt: existing.prompt,
          // Why: use stateStartedAt (not updatedAt) so the row reflects when the state was first reported, not the latest within-state ping.
          startedAt: existing.stateStartedAt,
          // Why: preserve the interrupt flag on the historical `done` entry so activity-block views can render past cancellations.
          interrupted: existing.interrupted
        }
      ]
      if (history.length > AGENT_STATE_HISTORY_MAX) {
        history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
      }
      if (existing.state === 'done') {
        // The push above just moved this completion out of the live entry; a done that
        // carried no message must clear the slot, or a stale prior turn leaks forward.
        lastCompletedAssistantMessage = existing.lastAssistantMessage
      }
    }

    const identity = resolveAgentStatusIdentity({
      existing: existing
        ? {
            agentType: existing.agentType,
            state: existing.state,
            updatedAt: existing.updatedAt,
            restoredUnconfirmed: existing.restoredUnconfirmed
          }
        : undefined,
      incoming: payload.agentType,
      now: updatedAt
    })
    // Why: Command Code has no UserPromptSubmit; a fresh transcript prompt while still `working` is the smart-sort turn boundary.
    const commandCodeNewTurn =
      existing !== undefined &&
      isCommandCodeNewTurnWhileWorking({
        agentType: identity.agentType,
        previousState: existing.state,
        incomingState: payload.state,
        previousPrompt: existing.prompt,
        incomingPrompt: payload.prompt,
        previousPromptInteractionKey: existing.promptInteractionKey,
        incomingPromptInteractionKey: payload.promptInteractionKey
      })
    const promptInteractionKey =
      payload.promptInteractionKey ??
      (payload.prompt === existing?.prompt ? existing?.promptInteractionKey : undefined)
    // Why: prefer main's authoritative stateStartedAt (attachStatusTiming persists it across
    // same-state pings and restart); fall back to existing only when main sent no timing, updatedAt for a new pane.
    const stateStartedAt =
      timing?.stateStartedAt ??
      (commandCodeNewTurn
        ? updatedAt
        : existing && existing.state === payload.state
          ? existing.stateStartedAt
          : updatedAt)
    if (
      existing &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: payload.state
      })
    ) {
      suppressedInheritedTerminalStatus = true
      return s
    }

    // Why: tool/assistant fields arrive pre-merged and authoritative from main (resolveToolState
    // in server.ts), so write them through directly — no fallback — so UserPromptSubmit clears stale tool lines.
    const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[paneKey]
    const runtimeMergedOrchestration = runtimeOrchestration
      ? mergeCurrentOrchestrationContext(existing?.orchestration, runtimeOrchestration)
      : undefined
    const payloadMergedOrchestration = payload.orchestration
      ? mergeCurrentOrchestrationContext(
          runtimeMergedOrchestration ?? existing?.orchestration,
          payload.orchestration
        )
      : undefined
    const completedFallbackOrchestration =
      payload.state === 'done' ? existing?.orchestration : undefined
    const orchestration =
      payloadMergedOrchestration ?? runtimeMergedOrchestration ?? completedFallbackOrchestration
    // Why: waiting/blocked are still the same resumable turn; child permission hooks omit the root session id.
    // Completing a turn does not end the provider session either — the TUI stays alive and resumable at its
    // prompt — so `done` must carry the id through, including done→done (OSC 9999 repaints and reconnect
    // snapshot replays both re-deliver a metadata-less `done` onto an already-done row). Without that, every
    // surface keyed on the id — mobile Chat UI transcripts, the resumable recovery anchor below — loses the
    // session while the agent sits idle, which is precisely when it is read (#10630). Only a new turn
    // (done→working) still drops it, so a reused pane cannot inherit a finished session.
    const canReuseExistingProviderSession =
      existing?.agentType === identity.agentType &&
      (existing.state !== 'done' || payload.state === 'done')
    const providerSession =
      metadata?.providerSession ??
      (canReuseExistingProviderSession ? existing.providerSession : undefined)
    const existingProviderSession = canReuseExistingProviderSession
      ? existing.providerSession
      : undefined
    const providerSessionChanged =
      Boolean(metadata?.providerSession && existingProviderSession) &&
      !agentProviderSessionsEqual(
        identity.agentType,
        metadata?.providerSession,
        existingProviderSession
      )
    const statusTabId =
      routing?.tabId ?? existing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined
    const statusTerminalHandle = routing?.terminalHandle ?? existing?.terminalHandle
    const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
    const matchedRegistryLaunchConfig = registryEntryMatchesStatus({
      entry: registryEntry,
      paneKey,
      agentType: identity.agentType,
      tabId: statusTabId,
      terminalHandle: statusTerminalHandle,
      launchToken: metadata?.launchToken,
      providerSession,
      existingProviderSession,
      providerSessionChanged
    })
      ? registryEntry?.launchConfig
      : undefined
    const existingSleepingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
    // Why: a completed turn leaves the TUI session alive and resumable at its prompt for any
    // resumable agent (Claude/Codex/Pi/…), not just Pi — so keep its persisted recovery anchor
    // even when done. Else a cold restore after an abrupt app death (macOS logout, #9454) drops
    // the pane to a bare shell instead of `--resume`-ing the agent logged in.
    const retainsResumableRecoveryIdentity =
      payload.state === 'done' &&
      isResumableTuiAgent(identity.agentType) &&
      providerSession !== undefined &&
      getAgentResumeArgv(identity.agentType, providerSession) !== null
    const matchedSleepingLaunchConfig =
      (payload.state !== 'done' || retainsResumableRecoveryIdentity) &&
      existingSleepingRecord?.launchConfig &&
      existingSleepingRecord.agent === identity.agentType &&
      providerSession &&
      agentProviderSessionsEqual(
        identity.agentType,
        existingSleepingRecord.providerSession,
        providerSession
      )
        ? existingSleepingRecord.launchConfig
        : undefined
    // Why: on a reused pane key, once the provider session changes the old launch registry must not bleed options into the new session.
    const launchConfigSource =
      (payload.state !== 'done' && !providerSessionChanged && metadata?.launchToken
        ? metadata?.launchConfig
        : undefined) ??
      matchedRegistryLaunchConfig ??
      matchedSleepingLaunchConfig
    const entry: AgentStatusEntry = {
      state: payload.state,
      workingMode: payload.workingMode,
      prompt: payload.prompt,
      updatedAt,
      stateStartedAt,
      agentType: identity.agentType,
      model:
        payload.model ??
        (existing?.agentType === identity.agentType ? existing.model : undefined),
      paneKey,
      terminalHandle: statusTerminalHandle,
      worktreeId:
        routing?.worktreeId ??
        existing?.worktreeId ??
        findAgentPaneWorktreeId(s, paneKey) ??
        undefined,
      ...(routing?.connectionId !== undefined
        ? { connectionId: routing.connectionId }
        : existing?.connectionId !== undefined
          ? { connectionId: existing.connectionId }
          : s.sleepingAgentSessionsByPaneKey[paneKey]?.connectionId !== undefined
            ? { connectionId: s.sleepingAgentSessionsByPaneKey[paneKey].connectionId }
            : {}),
      tabId: statusTabId,
      terminalTitle: effectiveTitle,
      stateHistory: history,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      // Why: full untruncated AskUserQuestion JSON so mobile/web can render the live prompt
      // card; parseAgentStatusPayload clears it on tool/state change.
      interactivePrompt: payload.interactivePrompt,
      lastAssistantMessage: payload.lastAssistantMessage,
      ...(lastCompletedAssistantMessage ? { lastCompletedAssistantMessage } : {}),
      // Why: reused panes can start non-orchestrated work; only final done rows keep the
      // previous lineage fallback so completed children stay grouped.
      orchestration,
      // Why: reuse the prior array ref when the roster is unchanged so identity-comparing subscribers skip re-renders.
      subagents: agentSubagentsEqual(existing?.subagents, payload.subagents)
        ? existing?.subagents
        : payload.subagents,
      ...(providerSession ? { providerSession } : {}),
      ...(metadata?.terminalResumeEligible === false
        ? { terminalResumeEligible: false as const }
        : {}),
      ...(promptInteractionKey ? { promptInteractionKey } : {}),
      ...(payload.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
      // Why: `updatedAt` cannot order two writes inside one millisecond — and the accept check
      // above admits equal timestamps — so a deferred process-exit drop needs a token ordered by
      // construction to tell "the pane reported again" from "an unrelated field moved". Every
      // field-level rewrite of a row spreads it forward, so only a real report re-stamps it.
      //
      // Derived from the row it replaces, not from a module counter: there is then nothing for a
      // sibling teardown path to reset (the bug this replaced), and a batched burst lands the
      // same ordinals as the equivalent sequential writes.
      acceptedStatusSeq: (existing?.acceptedStatusSeq ?? 0) + 1,
      // Why: never inherited from `existing` — an unstamped write is an unstamped
      // observation, not the previous one repeated.
      ...(payload.observation ? { observation: payload.observation } : {}),
      // Why: `interrupted` is done-only; parseAgentStatusPayload already clamps it for non-done states, so write it through directly.
      interrupted: payload.interrupted,
      // Why: done→done repaints (OSC 9999, reconnect snapshot replays) re-deliver a
      // metadata-less `done`; preserving the flag there keeps completion-reactive
      // consumers from treating the still-idle session as newly finished. Turn evidence
      // (an assistant message or a changed prompt) proves a REAL completion — never
      // carry the flag over one, or a genuine finish could be silently suppressed.
      sessionBoundary:
        payload.sessionBoundary ??
        (existing?.state === 'done' &&
        payload.state === 'done' &&
        payload.lastAssistantMessage === undefined &&
        payload.prompt === existing.prompt
          ? existing.sessionBoundary
          : undefined)
    }
    // Why: a boundary `done` becoming a REAL completion does not advance
    // `stateStartedAt`, so hibernation would still judge the row by its ancient
    // anchor. Stamp it here, synchronously — sampling on the 60s coordinator tick
    // misses a boundary written and cleared between two samples.
    if (
      entry.state === 'done' &&
      entry.sessionBoundary !== true &&
      existing?.sessionBoundary === true
    ) {
      recordHibernationBoundaryResolved(paneKey, updatedAt)
    }
    generatedTitleEntry.current = entry
    if (
      isAgentCompletionState(entry.state) &&
      entry.sessionBoundary !== true &&
      existing !== undefined &&
      !isAgentCompletionState(existing.state)
    ) {
      completionRefreshWorktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, paneKey)
    }
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
      sortRelevantChange ||
      attributionChanged ||
      workingModeChanged ||
      doneRetentionFieldsChanged
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
  })
  if (suppressedInheritedTerminalStatus) {
    return
  }
  const entryForGeneratedTitle = generatedTitleEntry.current
  if (entryForGeneratedTitle) {
    // Why: sticky orchestration (~30m) can outlive the dispatch turn, so replace the title on matching labels or a re-dispatch's mismatched taskId.
    const hasMatchingOrchestrationLabels = Boolean(
      (entryForGeneratedTitle.orchestration?.displayName?.trim() ||
        entryForGeneratedTitle.orchestration?.taskTitle?.trim()) &&
      orchestrationLabelsMatchLiveDispatch(entryForGeneratedTitle)
    )
    const liveIsDispatchPrompt = isOrcaDispatchPrompt(entryForGeneratedTitle.prompt)
    const liveDispatchTaskId = liveIsDispatchPrompt
      ? getOrcaDispatchTaskId(entryForGeneratedTitle.prompt)
      : null
    const stickyOrchestrationTaskId =
      entryForGeneratedTitle.orchestration?.taskId?.trim() || null
    const isNewDispatchAgainstStickyOrchestration = Boolean(
      liveDispatchTaskId &&
      stickyOrchestrationTaskId &&
      liveDispatchTaskId !== stickyOrchestrationTaskId
    )
    const shouldReplaceGeneratedTitle =
      hasMatchingOrchestrationLabels || isNewDispatchAgainstStickyOrchestration
    // Why: setAgentStatus is high-frequency, so only parse dispatch preambles when a title write is actually possible.
    const mayWriteGeneratedTitle =
      get().settings?.tabAutoGenerateTitle === true &&
      (shouldReplaceGeneratedTitle ||
        !agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
          get(),
          entryForGeneratedTitle.tabId ?? getTabIdFromPaneKey(paneKey),
          entryForGeneratedTitle.worktreeId
        ))
    const generatedTitlePrompt =
      liveIsDispatchPrompt && mayWriteGeneratedTitle
        ? getAgentRowGeneratedTitleText(entryForGeneratedTitle)
        : entryForGeneratedTitle.prompt
    if (shouldReplaceGeneratedTitle) {
      applyGeneratedTabTitleUpdate({
        paneKey,
        prompt: generatedTitlePrompt,
        options: {
          replaceExistingGeneratedTitle: true
        }
      })
    } else {
      applyGeneratedTabTitleUpdate({ paneKey, prompt: generatedTitlePrompt })
    }
  }
  // Why: batches coalesce accepted updates; standalone calls keep their existing deferred scheduling.
  requestAgentStatusFreshness(generatedTitleEntry.current !== null)
  if (completionRefreshWorktreeId) {
    const worktreeId = completionRefreshWorktreeId
    // Why: agents can create a PR via `gh pr create`, bypassing Orca's flow and leaving a stale "no PR" cache entry in place.
    queueMicrotask(() => get().refreshGitHubForWorktreeIfStale(worktreeId))
  }
}
