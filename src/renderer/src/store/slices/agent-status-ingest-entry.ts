import {
  agentSubagentsEqual,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent
} from '../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../../../shared/command-code-turn-boundary'
import { recordHibernationBoundaryResolved } from '@/lib/agent-hibernation-pane-age'
import { mergeCurrentOrchestrationContext } from './agent-status-orchestration'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key'
import { registryEntryMatchesStatus } from './agent-launch-config-registry'
import type {
  AgentStatusMetadata,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-types'
import type { AppState } from '../../types'
import type {
  AgentStatusIngestCommitInputs,
  AgentStatusIngestOut
} from './agent-status-ingest-commit'

export function isAgentCompletionState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

export function buildAgentStatusIngestEntry(
  paneKey: string,
  payload: ParsedAgentStatusPayload,
  existing: AgentStatusEntry | undefined,
  terminalTitle: string | undefined,
  updatedAt: number,
  timing: AgentStatusTiming | undefined,
  routing: AgentStatusRouting | undefined,
  metadata: AgentStatusMetadata | undefined,
  s: AppState,
  out: AgentStatusIngestOut
): AgentStatusIngestCommitInputs {
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
    out.suppressedInheritedTerminalStatus = true
    return null as unknown as AgentStatusIngestCommitInputs
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
  const statusTabId = routing?.tabId ?? existing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined
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
      payload.model ?? (existing?.agentType === identity.agentType ? existing.model : undefined),
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
  out.generatedTitleEntry = entry
  if (
    isAgentCompletionState(entry.state) &&
    entry.sessionBoundary !== true &&
    existing !== undefined &&
    !isAgentCompletionState(existing.state)
  ) {
    out.completionRefreshWorktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, paneKey)
  }
  return {
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
  }
}
