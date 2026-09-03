/* eslint-disable max-lines -- Why: this file owns the loopback HTTP adapter, the on-disk last-status persistence layer (hydrate, sanitize, TTL, atomic write, drop), and the relay ingest path in one place so the cache lifecycle (set → schedule → drain) lives next to the surfaces that mutate it. Splitting would force mutual `private` accessor scaffolding for a single class. */
// Why: this main-process adapter keeps listener internals in shared/ (`src/shared/agent-hook-listener.ts`) so the relay can host the same pipeline without Electron; parsing that drifts back into this file stops applying to SSH panes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LegacyPaneKeyAliasEntry } from '../../shared/persisted-state-types'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  paneHasStateClaims,
  createHookListenerState,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import {
  clearClaudeAnsweredQuestionWait,
  markClaudeLeadTurnInterrupted,
  reapRestoredClaudeSubagentsForDeadPane,
  seedClaudeLeadTurnFromPersistedStatus,
  seedClaudeSubagentRosterFromSnapshots
} from '../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../../shared/agent-hook-listener/endpoint-publication'
import {
  hasCodexTranscriptSubagents,
  markCodexLeadTurnInterrupted,
  reconcileRemoteCodexState,
  seedCodexStateFromSnapshot
} from '../../shared/agent-hook-listener/providers/codex-state'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../shared/agent-hook-listener/grok-result-discovery'
import {
  HOOK_REQUEST_SLOWLORIS_MS,
  MAX_PANE_KEY_LEN,
  normalizeClaudePromptId,
  warnOnHookEnvOrVersionMismatch
} from '../../shared/agent-hook-listener/listener-limits'
import { isNewTurnEvent } from '../../shared/agent-hook-listener/provider-event-routing'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../../shared/agent-hook-listener/hook-envelope'
import {
  parseFormEncodedBody,
  readRequestBody
} from '../../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../../shared/agent-hook-listener/source-routing'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  canAcceptClaudeCompactCompletion,
  isClaudeCompactCompletionConsumed,
  markClaudeCompactCompletionConsumed,
  resolveLegacyCompactTrigger
} from '../../shared/claude-compact-completion'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference,
  isHookRequestTruncatedError,
  type HookTransportInterferenceReport
} from '../../shared/agent-hook-transport-interference'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots
} from '../../shared/claude-subagent-roster'
import {
  isAgentHookSource,
  restoreShedStatusFields,
  type AgentHookSource
} from '../../shared/agent-hook-relay'
import {
  CLAUDE_STATUSLINE_PATHNAME,
  parseClaudeStatusLineBody,
  type ClaudeStatusLineRateLimits
} from '../../shared/claude-statusline-rate-limits'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusClearIpcPayload,
  type AgentStatusIpcPayload,
  type AgentType,
  type ParsedAgentStatusPayload,
  normalizeAgentStatusPayload
} from '../../shared/agent-status-types'
import { terminalStatusPayloadMatchesHook } from '../../shared/agent-terminal-status-equivalence'
import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId,
  type AgentStatusObservation,
  type AgentStatusObservationOrigin
} from '../../shared/agent-status-observation'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../shared/agent-status-identity'
import {
  isAgentInterruptInputIntent,
  type AgentInterruptInferenceRequest
} from '../../shared/agent-interrupt-intent'
import {
  isAskUserQuestionTool,
  type AgentQuestionAnsweredInferenceRequest
} from '../../shared/agent-question-answered-intent'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'
import { isCommandCodeNewTurnWhileWorking } from '../../shared/command-code-turn-boundary'
import {
  buildSpoolHookBody,
  drainAgentHookSpool,
  launchTokenHash,
  type SpoolRecord
} from '../../shared/agent-hook-spool'

export type { AgentHookSource }

import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  attachClaudeChildOnlyBoundary,
  attachClaudePermissionToolUseId,
  authorityCommitmentsMatch,
  CODEX_SUBAGENT_POLL_MS,
  dropHydratedIdleClaudeSubagents,
  equivalentInterruptAgentType,
  agentTypeToPromptSentAgentKind,
  HYDRATE_MAX_AGE_MS,
  INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS,
  isValidPaneKey,
  isValidPiProviderSessionOnly,
  invalidateClaudeChildOnlyBoundary,
  isToolProgressWorkingAfterInterrupt,
  LAST_STATUS_FILE_VERSION,
  LAST_STATUS_FILE_NAME,
  paneCacheKeyMatchesTab,
  readPersistedLaunchTokenHash,
  sanitizeHydratedEntry,
  sanitizePersistedAuthorityCommitment,
  shouldKeepClaudePermissionVisible,
  STATUS_PERSIST_DEBOUNCE_MS,
  toAgentStatusIpcPayload,
  trackEmptyPaneKeyHook,
  type AgentHookAuthorityAttestation,
  type AgentHookAuthorityEvidence,
  type AgentHookProviderSessionIdentity,
  type AgentHookStatusChangeEntry,
  type AgentPromptSentDedupeEntry,
  type EnrichedAgentHookEventPayload,
  type LastStatusFile,
  type NormalizedLocalHook,
  type PaneStatusClearListener,
  type PersistedAgentHookAuthorityCommitment,
  type PersistedAgentHookEventPayload,
  type ProviderSessionChangeListener,
  type StatusChangeListener
} from './agent-hook-payload-sanitize'

export {
  CLOSED_AGENT_STATUS_PANE_KEYS_MAX,
  CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  isValidPaneKey,
  type AgentHookAuthorityAttestation,
  type AgentHookAuthorityEvidence,
  type AgentHookProviderSessionIdentity,
  type AgentHookStatusChangeEntry,
  type EnrichedAgentHookEventPayload
} from './agent-hook-payload-sanitize'

import {
  PaneAuthorityRegistry,
  type AgentStatusDisposition,
  type PaneKeyAliasEntry,
  type RetiredPaneFence
} from './pane-authority-transfer'
import {
  AgentStatusIngestRegistry
} from './agent-status-ingest'

export {
  PANE_KEY_ALIASES_MAX,
  RETIRED_PANE_FENCES_MAX,
  type PaneKeyAliasEntry,
  type RetiredPaneFence
} from './pane-authority-transfer'
import { AgentStatusPersistence } from './agent-status-persistence'

// Why: server-side enrichment — receivedAt = latest event arrival, stateStartedAt = when the current state first appeared; extra fields ride the shared map untouched (it only writes/clears).

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so the server can detect dev vs. prod cross-talk; set at start() from packaged-build knowledge.
  private env = 'production'
  private onAgentStatus: ((payload: EnrichedAgentHookEventPayload) => void) | null = null
  private onClaudeStatusLine: ((event: ClaudeStatusLineRateLimits) => void) | null = null
  private onPaneStatusCleared: PaneStatusClearListener | null = null
  private paneStatusClearListeners = new Set<PaneStatusClearListener>()
  private statusChangeListeners = new Set<StatusChangeListener>()
  private providerSessionChangeListeners = new Set<ProviderSessionChangeListener>()
  // Why: setListener is a single slot owned by the main-window fanout; the
  // plugin event bus (and future consumers) need an additive subscription
  // that also works in headless serve, where no window listener exists.
  private enrichedStatusListeners = new Set<(payload: EnrichedAgentHookEventPayload) => void>()
  // Why: set via start()'s userDataPath so the class has no direct Electron dependency (mockable in vitest node env).
  private endpointDir: string | null = null
  private endpointFilePathCache: string | null = null
  private endpointFileWritten = false
  // Why: per-instance (not module-level) so tests can spin up multiple servers without state cross-contamination.
  private state: HookListenerState = createHookListenerState()
  private onTransportInterference: ((report: HookTransportInterferenceReport) => void) | null = null
  private transportInterference = createHookTransportInterferenceTracker((report) => {
    console.warn(describeHookTransportInterference(report))
    this.onTransportInterference?.(report)
  })
  // Why: hydrated rows give UI continuity but aren't evidence of live agent work in this runtime.
  private runtimeObservedStatusPaneKeys = new Set<string>()
  private hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[] = Object.freeze([])
  private hydratedLaunchTokenHashByPaneKey = new Map<string, string>()
  private persistedAuthorityCommitmentsByPaneKey = new Map<string, AgentHookAuthorityEvidence>()
  private revokedHydratedAuthorityCommitments = new WeakSet<AgentHookAuthorityEvidence>()
  private currentAuthorityObservations = new Map<string, AgentHookAuthorityEvidence>()
  // Why: on-disk last-status cache path; null without a userDataPath (tests), where persistence is a no-op and only in-memory replay applies.
  private lastStatusFilePath: string | null = null
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private codexSubagentPollTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private promptSentDedupeByPaneKey = new Map<string, AgentPromptSentDedupeEntry>()
  private activeHookTurnCompletedAtByPaneKey = new Map<string, number>()
  private promptSentHashSalt = randomBytes(16).toString('hex')
  private readonly paneAuthority = new PaneAuthorityRegistry(this)
  private connectionTimestampWatermarkById = new Map<string, number>()
  private readonly persistence: AgentStatusPersistence
  // Why: main is the pane authority for local/WSL/SSH panes — hook HTTP, relay, and its own
  // OSC parse all converge on applyNormalizedStatus, so one sequencer covers every ingress here.
  private readonly observations = new AgentStatusObservationSequencer(
    createAgentStatusAuthorityId('main-agent-hooks')
  )
  private readonly ingest: AgentStatusIngestRegistry

  constructor() {
    this.persistence = new AgentStatusPersistence(this as any)
    this.ingest = new AgentStatusIngestRegistry(this as any, this.observations)
  }
  // Pane authority tracking — required by PaneAuthorityRegistry
  closedAgentStatusTabIds = new Set<string>()
  closedAgentStatusPaneKeys = new Set<string>()
  restartedStatusLaunchTokenHashByPaneKey = new Map<string, string>()
  retiredPaneFencesByKey = new Map<string, RetiredPaneFence>()
  legacyPaneKeyAliases = new Map<string, PaneKeyAliasEntry>()

  /**
   * Notified once per process when repeated hook POSTs are cut off mid-body (#11217).
   * Why: the listener fails open on every request error, so without this the only symptom is
   * agent status quietly going stale — for every runtime at once, since they share this transport.
   */
  setTransportInterferenceListener(
    listener: ((report: HookTransportInterferenceReport) => void) | null
  ): void {
    this.onTransportInterference = listener
  }

  setListener(listener: ((payload: EnrichedAgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
    if (!listener) {
      return
    }
    // Why: replay is best-effort per pane so one throwing listener can't starve the rest.
    for (const payload of this.state.lastStatusByPaneKey.values()) {
      try {
        // Why: cache always holds enriched payloads; the map's declared type is the bare shape only because the shared module never reads it.
        listener({ ...(payload as EnrichedAgentHookEventPayload), isReplay: true })
      } catch (err) {
        console.error('[agent-hooks] replay listener threw', err)
      }
    }
  }

  // Why: statusline posts carry live Claude usage windows, not agent status; they feed RateLimitService directly.
  setClaudeStatusLineListener(
    listener: ((event: ClaudeStatusLineRateLimits) => void) | null
  ): void {
    this.onClaudeStatusLine = listener
  }

  subscribeStatusChanges(listener: StatusChangeListener): () => void {
    this.statusChangeListeners.add(listener)
    return () => {
      this.statusChangeListeners.delete(listener)
    }
  }

  subscribeProviderSessionChanges(listener: ProviderSessionChangeListener): () => void {
    this.providerSessionChangeListeners.add(listener)
    return () => {
      this.providerSessionChangeListeners.delete(listener)
    }
  }

  /** Multi-subscriber tap on every enriched status change (no replay). */
  subscribeEnrichedStatus(listener: (payload: EnrichedAgentHookEventPayload) => void): () => void {
    this.enrichedStatusListeners.add(listener)
    return () => {
      this.enrichedStatusListeners.delete(listener)
    }
  }

  /** Replay is durable evidence from a prior runtime, not a live observation. */
  private withdrawReplayObservation(paneKey: string): void {
    if (this.runtimeObservedStatusPaneKeys.delete(paneKey)) {
      this.notifyStatusChangeListeners()
    }
  }

  private ingestSpoolRecord(record: SpoolRecord): void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const normalized = this.normalizeLocalHookPayload(record.source, body)
    if (!normalized.event) {
      return
    }
    const replay = { ...normalized.event, isReplay: true as const }
    const statusDisposition = this.getAgentStatusDisposition(replay.paneKey, {
      source: record.source,
      hookEventName: replay.hookEventName,
      isReplay: true,
      hasExplicitPrompt: replay.hasExplicitPrompt,
      launchToken: replay.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    const event = statusDisposition === 'restart' ? { ...replay, launchToken: undefined } : replay
    if (statusDisposition === 'restart') {
      this.observations.rebind(event.paneKey)
    }
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(event, normalized.onAccepted)
    if (event.payload.state !== 'done') {
      this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
    }
  }

  setPaneStatusClearListener(listener: PaneStatusClearListener | null): void {
    this.onPaneStatusCleared = listener
  }

  /** Multi-subscriber tap on pane status clears. Unlike `setPaneStatusClearListener`
   *  (a single slot the main window owns and drops on close) this survives window
   *  teardown and exists at all under headless serve, which never opens one. */
  subscribePaneStatusClear(listener: PaneStatusClearListener): () => void {
    this.paneStatusClearListeners.add(listener)
    return () => {
      this.paneStatusClearListeners.delete(listener)
    }
  }

  private emitPaneStatusCleared(clear: AgentStatusClearIpcPayload): void {
    this.onPaneStatusCleared?.(clear)
    for (const listener of this.paneStatusClearListeners) {
      // Why: callers are pane/connection teardown paths; one throwing subscriber must
      // not strand the rest, matching every other fan-out here.
      try {
        listener(clear)
      } catch (err) {
        console.error('[agent-hooks] pane-status-clear listener threw', err)
      }
    }
  }

  /** Snapshot of cached statuses in IPC shape. Used by `agentStatus:getSnapshot` after tabs hydrate so the
   *  dashboard catches up on hook events that fired during startup. */
  getStatusSnapshot(): AgentStatusIpcPayload[] {
    return Array.from(this.state.lastStatusByPaneKey.values(), (entry) =>
      toAgentStatusIpcPayload(entry as EnrichedAgentHookEventPayload)
    )
  }

  /** Provider-session identities, including Pi's metadata-only rows. */
  getProviderSessionIdentities(): AgentHookProviderSessionIdentity[] {
    return this.buildStatusChangeNotification().providerSessions
  }

  getStatusSnapshotForPane(paneKey: string): AgentStatusIpcPayload[] {
    const entry = this.state.lastStatusByPaneKey.get(paneKey)
    return entry ? [toAgentStatusIpcPayload(entry as EnrichedAgentHookEventPayload)] : []
  }

  getHydratedAuthorityCommitments(): readonly AgentHookAuthorityEvidence[] {
    return this.hydratedAuthorityCommitments
  }

  getCurrentAuthorityObservations(): readonly AgentHookAuthorityEvidence[] {
    return Object.freeze(
      Array.from(this.currentAuthorityObservations.values(), (entry) => Object.freeze({ ...entry }))
    )
  }

  attestCompatibilityAuthority(candidate: {
    paneKey: string
    launchTokenHash: string
    connectionId: string | null
    terminalProvenance: 'current_runtime' | 'restored'
  }): AgentHookAuthorityAttestation | null {
    const paneKey = this.resolvePaneKeyAlias(candidate.paneKey)
    const matchesCandidate = (entry: AgentHookAuthorityEvidence): boolean =>
      entry.launchTokenHash === candidate.launchTokenHash &&
      entry.connectionId === candidate.connectionId
    const commitments = this.hydratedAuthorityCommitments.filter(
      (entry) => matchesCandidate(entry) && !this.revokedHydratedAuthorityCommitments.has(entry)
    )
    const current = Array.from(this.currentAuthorityObservations.values())
    const observations = current.filter(matchesCandidate)
    const paneObservations = current.filter(
      (entry) => this.resolvePaneKeyAlias(entry.paneKey) === paneKey
    )
    const hasUniqueCurrentObservation =
      observations.length === 1 &&
      paneObservations.length === 1 &&
      this.resolvePaneKeyAlias(observations[0]!.paneKey) === paneKey
    if (candidate.terminalProvenance === 'current_runtime') {
      return hasUniqueCurrentObservation ? Object.freeze({ paneKey, source: 'current_hook' }) : null
    }
    if (commitments.length !== 1 || this.resolvePaneKeyAlias(commitments[0]!.paneKey) !== paneKey) {
      return null
    }
    if (observations.length === 0 && paneObservations.length === 0) {
      return Object.freeze({ paneKey, source: 'hydrated_commitment' })
    }
    if (!hasUniqueCurrentObservation) {
      return null
    }
    return Object.freeze({ paneKey, source: 'current_hook' })
  }

  inferInterrupt(request: AgentInterruptInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    if (!isAgentInterruptInputIntent(request.intent)) {
      return false
    }
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return false
    }
    if (existing.providerSessionOnly) {
      return false
    }
    // Why: inference must not fabricate a `done` onto a row whose `working` was never confirmed this runtime.
    if (existing.restoredUnconfirmed) {
      return false
    }
    const payload = existing.payload
    const agentType: AgentType | undefined = payload.agentType
    // Why: Droid's Ctrl+C exits the CLI (handled by PTY lifecycle) rather than interrupting the current turn.
    if (agentType === 'droid' && request.intent === 'ctrl-c') {
      return false
    }
    // Why: these agents use the first Escape as a TUI cancel that can leave the turn running; only a double Escape infers an interrupt.
    if (
      (agentType === 'opencode' || agentType === 'copilot') &&
      request.intent === 'plain-escape' &&
      request.inputCount !== 2
    ) {
      return false
    }
    const dismissesClaudeQuestion =
      agentType === 'claude' &&
      request.intent === 'plain-escape' &&
      payload.state === 'waiting' &&
      isAskUserQuestionTool(payload.toolName)
    if (dismissesClaudeQuestion) {
      return this.inferQuestionAnswered(request)
    }
    // Why: inference is a fallback for a missing final hook; a strict baseline match keeps a delayed timer from clobbering any newer hook.
    if (
      payload.state !== 'working' ||
      !equivalentInterruptAgentType(agentType, request.baselineAgentType) ||
      payload.prompt !== request.baselinePrompt ||
      existing.receivedAt !== request.baselineUpdatedAt ||
      existing.stateStartedAt !== request.baselineStateStartedAt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    // Why: a 'working' pane can be child-driven; Ctrl+C doesn't stop background children, so inferring done would retire live child rows.
    if (payload.subagents?.some((subagent) => subagent.state !== 'idle')) {
      return false
    }
    // Why: Escape/Ctrl+C at Claude's idle prompt does not stop provider-owned shells or session crons.
    if (
      agentType === 'claude' &&
      (this.state.claudeRunningNonAgentTaskPaneKeys.has(existing.paneKey) ||
        this.state.claudeActiveSessionCronPaneKeys.has(existing.paneKey))
    ) {
      return false
    }

    // Why: keep the Claude lead-turn record in sync, or a later child event re-emits the stale 'working' state and resurrects the cancelled pane.
    if (agentType === 'claude') {
      markClaudeLeadTurnInterrupted(this.state, existing.paneKey)
    }
    if (agentType === 'codex') {
      markCodexLeadTurnInterrupted(this.state, existing.paneKey)
    }
    const inferred = this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      payload: {
        state: 'done',
        prompt: payload.prompt,
        agentType,
        ...(payload.model ? { model: payload.model } : {}),
        interrupted: true,
        // Why: idle children are display state; dropping them on an inferred interrupt blanks rows a later hook would restore.
        ...(payload.subagents ? { subagents: payload.subagents } : {})
      }
    })
    console.debug('[agent-hooks] inferred interrupted agent status', {
      paneKey: inferred.paneKey,
      agentType,
      intent: request.intent
    })
    return true
  }

  /** Guarded fallback for the hook Claude omits after answering or dismissing AskUserQuestion. */
  inferQuestionAnswered(request: AgentQuestionAnsweredInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return false
    }
    // Why: inference must not fabricate a transition onto a row whose state was never confirmed this runtime.
    if (existing.restoredUnconfirmed) {
      return false
    }
    const payload = existing.payload
    // Why: only Claude's interactive question clears on typed input — tool name (not hook event) discriminates; real permission waits stay sticky.
    if (
      payload.agentType !== 'claude' ||
      payload.state !== 'waiting' ||
      !isAskUserQuestionTool(payload.toolName)
    ) {
      return false
    }
    if (
      payload.agentType !== request.baselineAgentType ||
      payload.prompt !== request.baselinePrompt ||
      existing.receivedAt !== request.baselineUpdatedAt ||
      existing.stateStartedAt !== request.baselineStateStartedAt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    // Why: sync the listener's lead-turn record too, or a later child event re-emits the stale waiting state and resurrects the card.
    const restored = clearClaudeAnsweredQuestionWait(this.state, existing.paneKey)
    const inferred = this.applyNormalizedStatus({
      paneKey: existing.paneKey,
      tabId: existing.tabId,
      worktreeId: existing.worktreeId,
      connectionId: existing.connectionId,
      providerSession: existing.providerSession,
      payload: {
        state: restored.state,
        ...(restored.workingMode ? { workingMode: restored.workingMode } : {}),
        prompt: payload.prompt,
        agentType: payload.agentType,
        ...(restored.state === 'done' && restored.interrupted ? { interrupted: true } : {}),
        ...(restored.turnCompletedAt !== undefined
          ? { turnCompletedAt: restored.turnCompletedAt }
          : {}),
        ...(payload.subagents ? { subagents: payload.subagents } : {})
      }
    })
    console.debug('[agent-hooks] inferred resolved question status', {
      paneKey: inferred.paneKey,
      state: inferred.payload.state
    })
    return true
  }

  getStatusChangeSnapshot(): AgentHookStatusChangeEntry[] {
    return this.buildStatusChangeNotification().statuses
  }

  private buildStatusChangeNotification(): {
    statuses: AgentHookStatusChangeEntry[]
    providerSessions: AgentHookProviderSessionIdentity[]
  } {
    const statuses: AgentHookStatusChangeEntry[] = []
    const providerSessions: AgentHookProviderSessionIdentity[] = []
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      const enriched = entry as EnrichedAgentHookEventPayload
      if (enriched.providerSession) {
        providerSessions.push({
          paneKey,
          sessionId: enriched.providerSession.id,
          ...(enriched.providerSession.transcriptPath
            ? { transcriptPath: enriched.providerSession.transcriptPath }
            : {}),
          ...(enriched.worktreeId ? { worktreeId: enriched.worktreeId } : {})
        })
      }
      if (!enriched.providerSessionOnly) {
        statuses.push({
          state: enriched.payload.state,
          receivedAt: enriched.receivedAt,
          observedInCurrentRuntime: this.runtimeObservedStatusPaneKeys.has(paneKey)
        })
      }
    }
    return { statuses, providerSessions }
  }

  private notifyStatusChangeListeners(): void {
    if (this.statusChangeListeners.size === 0 && this.providerSessionChangeListeners.size === 0) {
      return
    }
    const { statuses, providerSessions } = this.buildStatusChangeNotification()
    for (const listener of this.statusChangeListeners) {
      try {
        listener(statuses)
      } catch (err) {
        console.error('[agent-hooks] status-change listener threw', err)
      }
    }
    for (const listener of this.providerSessionChangeListeners) {
      try {
        listener(providerSessions)
      } catch (err) {
        console.error('[agent-hooks] provider-session listener threw', err)
      }
    }
  }

  private attachStatusTiming(
    payload: AgentHookEventPayload,
    now = Date.now()
  ): EnrichedAgentHookEventPayload {
    const previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const commandCodeNewTurn =
      previous !== undefined &&
      isCommandCodeNewTurnWhileWorking({
        agentType: payload.payload.agentType,
        previousState: previous.payload.state,
        incomingState: payload.payload.state,
        previousPrompt: previous.payload.prompt,
        incomingPrompt: payload.payload.prompt,
        hasExplicitPrompt: payload.hasExplicitPrompt,
        previousPromptInteractionKey: previous.promptInteractionKey,
        incomingPromptInteractionKey: payload.promptInteractionKey
      })
    const stateStartedAt =
      previous && previous.payload.state === payload.payload.state && !commandCodeNewTurn
        ? previous.stateStartedAt
        : now
    return {
      ...payload,
      receivedAt: now,
      stateStartedAt
    }
  }

  private hashPromptForTelemetryDedupe(prompt: string): string {
    return createHash('sha256')
      .update(this.promptSentHashSalt)
      .update('\0')
      .update(prompt)
      .digest('hex')
  }

  private maybeTrackAgentPromptSent(
    payload: AgentHookEventPayload,
    previousStatus: EnrichedAgentHookEventPayload | undefined
  ): void {
    if (payload.isReplay === true || payload.hasExplicitPrompt !== true) {
      return
    }
    const prompt = payload.payload.prompt?.trim() ?? ''
    if (prompt.length === 0) {
      return
    }
    const agentKind = agentTypeToPromptSentAgentKind(payload.payload.agentType)
    const promptHash = this.hashPromptForTelemetryDedupe(prompt)
    const promptInteractionKey =
      typeof payload.promptInteractionKey === 'string' &&
      payload.promptInteractionKey.trim().length > 0
        ? payload.promptInteractionKey.trim()
        : undefined
    const previousDedupe = this.promptSentDedupeByPaneKey.get(payload.paneKey)
    const isCompletedTurnBoundary =
      previousStatus?.payload.state === 'done' && payload.payload.state === 'working'
    if (
      previousDedupe?.agentKind === agentKind &&
      previousDedupe.promptInteractionKey !== undefined &&
      previousDedupe.promptInteractionKey === promptInteractionKey &&
      (agentKind === 'opencode' || previousDedupe.promptHash === promptHash)
    ) {
      return
    }
    if (
      previousDedupe?.agentKind === agentKind &&
      previousDedupe.promptHash === promptHash &&
      !(
        previousStatus?.payload.state === 'done' &&
        payload.payload.state === 'done' &&
        previousDedupe.promptInteractionKey !== undefined &&
        promptInteractionKey !== undefined &&
        previousDedupe.promptInteractionKey !== promptInteractionKey
      ) &&
      !isCompletedTurnBoundary
    ) {
      return
    }
    this.promptSentDedupeByPaneKey.set(payload.paneKey, {
      agentKind,
      promptHash,
      promptInteractionKey
    })
    try {
      // Why: hooks prove a turn was submitted but not which UI launched the terminal; keep attribution low-cardinality.
      track('agent_prompt_sent', {
        agent_kind: agentKind,
        launch_source: 'unknown',
        request_kind: 'followup',
        ...getCohortAtEmit()
      })
    } catch (err) {
      console.error('[agent-hooks] prompt-sent telemetry failed', err)
    }
  }

  /** Stamp who observed this event, in what order, on main's clock. Nothing reads it yet
   *  (STA-4293) — it is stamped here because every main-side ingress funnels through
   *  applyNormalizedStatus, so no origin can silently arrive untagged. */
  private stampObservation(
    payload: AgentHookEventPayload,
    origin: AgentStatusObservationOrigin,
    observedAt: number
  ): AgentStatusObservation {
    return this.observations.observe(payload.paneKey, {
      origin,
      observedAt,
      // Why: reuse the listener's own per-provider classifier; a second list of raw event-name
      // literals here would strand the providers whose boundary event is named anything else.
      boundary:
        payload.source !== undefined && isNewTurnEvent(payload.source, payload.hookEventName),
      kind: payload.providerSessionOnly
        ? 'identity-only'
        : // Why: a replay restates a turn that already happened, and OSC 9999 repaints the
          // current state rather than announcing a change — neither is a fresh transition.
          payload.isReplay === true || origin === 'osc'
          ? 'snapshot'
          : 'transition'
    })
  }

  private applyNormalizedStatus(
    payload: AgentHookEventPayload,
    onAccepted?: () => void,
    origin: AgentStatusObservationOrigin = 'hook'
  ): EnrichedAgentHookEventPayload {
    if (payload.hookEventName === 'UserPromptSubmit') {
      // Why: the prompt boundary is authoritative even when text is unchanged; its next OSC working row must not inherit the prior cron/background turn stamp.
      this.activeHookTurnCompletedAtByPaneKey.delete(payload.paneKey)
    }
    let previous = this.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const connectionClearWatermark = payload.connectionId
      ? this.connectionTimestampWatermarkById.get(payload.connectionId)
      : undefined
    // Why: renderer ordering rejects older rows; live evidence must sort after reconnect clears and restored rows across clock rollback.
    const restoredStatusWatermark = previous?.restoredUnconfirmed ? previous.receivedAt : undefined
    const now = Math.max(
      Date.now(),
      (connectionClearWatermark ?? -1) + 1,
      (restoredStatusWatermark ?? -1) + 1
    )
    if (payload.connectionId) {
      this.connectionTimestampWatermarkById.set(payload.connectionId, now)
    }
    if (payload.providerSessionOnly) {
      // Why: identity-only rows survive replay but must not emit prompt telemetry or a fabricated status.
      onAccepted?.()
      const enriched = {
        ...this.attachStatusTiming(payload, now),
        observation: this.stampObservation(payload, origin, now)
      }
      this.clearAssistantMessageRetry(enriched.paneKey)
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
      this.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitEnrichedStatus(enriched)
      return enriched
    }
    const stateReconciledPayload =
      payload.connectionId && payload.payload.agentType === 'codex' && payload.hookEventName
        ? {
            ...payload,
            payload: reconcileRemoteCodexState(
              this.state,
              payload.paneKey,
              payload.hookEventName,
              payload.toolAgentId,
              payload.payload,
              previous?.payload
            )
          }
        : payload
    const previousCodexRoot =
      stateReconciledPayload.payload.agentType === 'codex' &&
      stateReconciledPayload.toolAgentId &&
      previous?.payload.agentType === 'codex'
        ? previous
        : undefined
    const preservedProviderSession = !stateReconciledPayload.providerSession
      ? previousCodexRoot?.providerSession
      : undefined
    const preservedRootModel = !stateReconciledPayload.payload.model
      ? previousCodexRoot?.payload.model
      : undefined
    // Why: an SSH relay restart forgets root-only fields; child hooks must not erase durable resume/model identity.
    const rootContextPreservingPayload =
      preservedProviderSession || preservedRootModel
        ? {
            ...stateReconciledPayload,
            ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
            payload: preservedRootModel
              ? { ...stateReconciledPayload.payload, model: preservedRootModel }
              : stateReconciledPayload.payload
          }
        : stateReconciledPayload
    const boundaryReconciledPrevious = invalidateClaudeChildOnlyBoundary(
      previous,
      rootContextPreservingPayload
    )
    if (boundaryReconciledPrevious !== previous) {
      previous = boundaryReconciledPrevious
      if (previous) {
        this.state.lastStatusByPaneKey.set(previous.paneKey, previous)
        this.scheduleStatusPersist()
      }
    }
    const identity = resolveAgentStatusIdentity({
      existing: previous
        ? {
            agentType: previous.payload.agentType,
            state: previous.payload.state,
            updatedAt: previous.receivedAt,
            restoredUnconfirmed: previous.restoredUnconfirmed
          }
        : undefined,
      incoming: rootContextPreservingPayload.payload.agentType,
      now
    })
    if (
      previous &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: rootContextPreservingPayload.payload.state
      })
    ) {
      return previous
    }
    const identityResolvedPayload =
      identity.agentType === rootContextPreservingPayload.payload.agentType
        ? rootContextPreservingPayload
        : {
            ...rootContextPreservingPayload,
            payload: {
              ...rootContextPreservingPayload.payload,
              agentType: identity.agentType
            }
          }
    const effectivePayload = attachClaudePermissionToolUseId(previous, identityResolvedPayload)
    const boundaryAwarePayload = attachClaudeChildOnlyBoundary(previous, effectivePayload)
    if (previous && shouldKeepClaudePermissionVisible(previous, effectivePayload)) {
      return previous
    }
    // Why: some TUIs emit a delayed tool/working hook after Ctrl+C stopped the turn; don't let it resurrect the row.
    if (
      previous?.payload.state === 'done' &&
      previous.payload.interrupted === true &&
      effectivePayload.payload.state === 'done' &&
      previous.payload.agentType === effectivePayload.payload.agentType &&
      previous.payload.prompt === effectivePayload.payload.prompt &&
      Date.now() - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
    ) {
      return previous
    }
    if (
      previous?.payload.state === 'done' &&
      previous.payload.interrupted === true &&
      effectivePayload.payload.state === 'working' &&
      previous.payload.agentType === effectivePayload.payload.agentType &&
      previous.payload.prompt === effectivePayload.payload.prompt &&
      (effectivePayload.isReplay === true ||
        isToolProgressWorkingAfterInterrupt(effectivePayload) ||
        (effectivePayload.hasExplicitPrompt !== true &&
          Date.now() - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS))
    ) {
      if (effectivePayload.payload.agentType === 'codex') {
        markCodexLeadTurnInterrupted(this.state, effectivePayload.paneKey)
      }
      return previous
    }
    if (
      effectivePayload.payload.state !== 'done' ||
      effectivePayload.payload.lastAssistantMessage
    ) {
      this.clearAssistantMessageRetry(effectivePayload.paneKey)
    }
    onAccepted?.()
    if (!identity.inheritedFromActivePane) {
      this.maybeTrackAgentPromptSent(effectivePayload, previous)
    }
    const enriched = {
      ...this.attachStatusTiming(boundaryAwarePayload, now),
      observation: this.stampObservation(boundaryAwarePayload, origin, now)
    }
    if (
      typeof enriched.payload.turnCompletedAt === 'number' &&
      Number.isFinite(enriched.payload.turnCompletedAt)
    ) {
      this.activeHookTurnCompletedAtByPaneKey.set(
        enriched.paneKey,
        enriched.payload.turnCompletedAt
      )
    }
    // Why: an identity-matched event can still leave the aggregate backed only by another restored child; keep liveness reconciliation eligible.
    if (enriched.restoredUnconfirmed) {
      this.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
    } else {
      this.runtimeObservedStatusPaneKeys.add(enriched.paneKey)
    }
    this.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(enriched)
    return enriched
  }

  // Why: every status emit must reach plugins too, so a new early-return path
  // upstream cannot silently leave the plugin tap behind the main-window fanout.
  private emitEnrichedStatus(enriched: EnrichedAgentHookEventPayload): void {
    this.onAgentStatus?.(enriched)
    for (const listener of this.enrichedStatusListeners) {
      try {
        listener(enriched)
      } catch (err) {
        console.error('[agent-hooks] enriched status listener threw', err)
      }
    }
  }

  private clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  private clearCodexSubagentPoll(paneKey: string): void {
    const timer = this.codexSubagentPollTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.codexSubagentPollTimers.delete(paneKey)
  }

  private scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    // Why: a nested non-codex CLI inherits ORCA_PANE_KEY, so clearing here would silently end a live codex poll.
    if (source !== 'codex') {
      return
    }
    this.clearCodexSubagentPoll(original.paneKey)
    if (!hasCodexTranscriptSubagents(this.state, original.paneKey)) {
      return
    }
    const timer = setTimeout(() => {
      this.codexSubagentPollTimers.delete(original.paneKey)
      const current = this.state.lastStatusByPaneKey.get(original.paneKey)
      if (!this.server || current !== original) {
        return
      }
      const normalized = normalizeHookPayload(this.state, source, body, this.env)
      if (!normalized) {
        return
      }
      const subagentsChanged =
        JSON.stringify(normalized.payload.subagents) !== JSON.stringify(original.payload.subagents)
      const next = subagentsChanged ? this.applyNormalizedStatus(normalized) : original
      this.scheduleCodexSubagentPoll(source, body, next)
    }, CODEX_SUBAGENT_POLL_MS)
    this.codexSubagentPollTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt = 1,
    discoveryReady = false
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        // Why: slug-group discovery can outlive the bounded flush timers; its completion must drive the first retry deterministically.
        void discovery
          .then(() => {
            if (this.server) {
              this.applyAssistantMessageRetry(source, body, original, 1, true)
            }
          })
          .catch((err) => {
            console.error('[agent-hooks] Grok result discovery failed:', err)
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(source, body, original, attempt + 1, discoveryReady)
      } catch (err) {
        console.error('[agent-hooks] assistant message retry failed:', err)
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.state.lastStatusByPaneKey.get(original.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const normalized = this.normalizeLocalHookPayload(source, body)
    if (!normalized.event?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(source, body, original, nextAttempt, requireExactOriginal)
      return
    }
    // Why: some agents POST Stop before their transcript line is flushed; discovery is event-driven, later content retries stay timed.
    this.applyNormalizedStatus(normalized.event, normalized.onAccepted)
  }

  private normalizeLocalHookPayload(source: AgentHookSource, body: unknown): NormalizedLocalHook {
    if (source !== 'claude' || typeof body !== 'object' || body === null) {
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
    }
    const rawPaneKey = (body as Record<string, unknown>).paneKey
    const paneKey = typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    if (!paneKey) {
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
    }
    const previousRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const previousActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const event = normalizeHookPayload(this.state, source, body, this.env)
    const nextRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const nextActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this.setClaudeBackgroundEvidence(paneKey, previousRunningTask, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Why: nested CLIs may inherit the pane key; only accepted statuses may mutate its background-work gate.
    return {
      event,
      onAccepted: () => this.setClaudeBackgroundEvidence(paneKey, nextRunningTask, nextActiveCron)
    }
  }

  private setClaudeBackgroundEvidence(
    paneKey: string,
    hasRunningTask: boolean,
    hasActiveCron: boolean
  ): void {
    if (hasRunningTask) {
      this.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    } else {
      this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    }
    if (hasActiveCron) {
      this.state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  }

  ingestTerminalStatus(event: {
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    payload: ParsedAgentStatusPayload
  }): void {
    const physicalPaneKey = event.paneKey.trim()
    const paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN || !parsedPaneKey) {
      return
    }
    const reportedTabId =
      event.tabId !== undefined && event.tabId.trim().length > 0 ? event.tabId.trim() : undefined
    if (
      paneKey === physicalPaneKey &&
      reportedTabId !== undefined &&
      reportedTabId !== parsedPaneKey.tabId
    ) {
      return
    }
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    if (this.getAgentStatusDisposition(paneKey) !== 'accept') {
      return
    }
    const worktreeId =
      event.worktreeId !== undefined && event.worktreeId.trim().length > 0
        ? event.worktreeId.trim()
        : undefined
    const connectionId =
      typeof event.connectionId === 'string' && event.connectionId.trim().length > 0
        ? event.connectionId.trim()
        : null
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      previous?.claudeLeadBoundaryChildOnly === true &&
      previous.payload.agentType === 'claude' &&
      event.payload.agentType === 'claude'
    ) {
      // Why: OSC has no child identity or lead boundary, so it cannot replace a persisted child-only proof before the lifecycle hook arrives.
      return
    }
    const preserveActiveTurnStamp =
      previous?.payload.turnCompletedAt !== undefined &&
      previous.payload.turnCompletedAt === this.activeHookTurnCompletedAtByPaneKey.get(paneKey)
    if (
      !previous?.restoredUnconfirmed &&
      previous?.connectionId === connectionId &&
      previous.tabId === tabId &&
      previous.worktreeId === worktreeId &&
      terminalStatusPayloadMatchesHook(previous.payload, event.payload, preserveActiveTurnStamp)
    ) {
      return
    }
    // Why: the OSC 9999 wire payload has no providerSession field at all, so an OSC observation is
    // never evidence that the session ended — yet overwriting the row dropped the cached identity.
    // That erased it from persisted rows (lost across restart) and from headless `orca serve`, which
    // serves these rows to mobile directly instead of the renderer store, blanking Chat UI (#10630).
    // A new turn after `done` still starts clean so a reused pane cannot inherit a finished session.
    // Why: mirror resolveAgentStatusIdentity, which treats a literal 'unknown' exactly like an
    // omitted type — an OSC ping that names no agent makes no claim about the pane's identity, so
    // it must not be read as a mismatch and strip the session the renderer would have kept.
    const claimedAgentType =
      event.payload.agentType && event.payload.agentType !== 'unknown'
        ? event.payload.agentType
        : undefined
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' || event.payload.state === 'done')
        ? previous.providerSession
        : undefined
    // Why: OSC status is a runtime observation, not a prompt boundary; keep prompt-sent telemetry tied to native hooks.
    this.applyNormalizedStatus(
      {
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
        payload: event.payload
      },
      undefined,
      'osc'
    )
  }

  /** Ingest a payload from the relay JSON-RPC channel (not the local HTTP server); connectionId is stamped here. Main is still the SSH trust boundary, so re-run the canonical normalizer before caching. */
  ingestRemote(
    envelope: {
      paneKey: string
      tabId?: string
      worktreeId?: string
      env?: string
      version?: string
      launchToken?: string
      hasExplicitPrompt?: boolean
      promptInteractionKey?: string
      hookEventName?: string
      source?: unknown
      providerPromptId?: unknown
      compactTrigger?: unknown
      toolUseId?: string
      toolAgentId?: string
      teammateName?: string
      toolAgentType?: string
      providerSession?: unknown
      providerSessionOnly?: unknown
      isReplay?: boolean
      /** Payload fields the relay dropped to fit an oversized frame; validated below. */
      shedFields?: unknown
      claudeRunningNonAgentTask?: unknown
      payload: unknown
    },
    connectionId: string | null
  ): void {
    // Why: wire crosses a trust boundary — re-check/trim so an empty connectionId can't poison caches.
    if (connectionId !== null && typeof connectionId !== 'string') {
      return
    }
    const trimmedConnectionId = connectionId?.trim() ?? null
    if (trimmedConnectionId !== null && trimmedConnectionId.length === 0) {
      return
    }
    if (!envelope || typeof envelope.paneKey !== 'string') {
      return
    }
    // Why: trim paneKey to match the HTTP path, else remote-vs-local events for one pane diverge.
    const physicalPaneKey = envelope.paneKey.trim()
    const paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN) {
      return
    }
    if (!parsedPaneKey) {
      return
    }
    // Why: fence relay spool replay at main so stale generations cannot overwrite hydrated state.
    if (envelope.isReplay === true) {
      const expectedLaunchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      const actualLaunchTokenHash = launchTokenHash(envelope.launchToken)
      if (expectedLaunchTokenHash && actualLaunchTokenHash !== expectedLaunchTokenHash) {
        return
      }
    }
    if (envelope.tabId !== undefined && typeof envelope.tabId !== 'string') {
      return
    }
    if (envelope.worktreeId !== undefined && typeof envelope.worktreeId !== 'string') {
      return
    }
    // Why: mirror the HTTP path's readStringField — trim and treat empty-after-trim as undefined.
    const reportedTabId =
      envelope.tabId !== undefined && envelope.tabId.trim().length > 0
        ? envelope.tabId.trim()
        : undefined
    if (
      paneKey === physicalPaneKey &&
      reportedTabId !== undefined &&
      reportedTabId !== parsedPaneKey.tabId
    ) {
      return
    }
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    const hookEventName =
      typeof envelope.hookEventName === 'string' && envelope.hookEventName.trim().length > 0
        ? envelope.hookEventName.trim()
        : undefined
    const source = isAgentHookSource(envelope.source) ? envelope.source : undefined
    const providerPromptId =
      source === 'claude' ? normalizeClaudePromptId(envelope.providerPromptId) : undefined
    const compactTrigger =
      source === 'claude' &&
      (envelope.compactTrigger === 'manual' || envelope.compactTrigger === 'auto')
        ? envelope.compactTrigger
        : undefined
    const statusDisposition = this.getAgentStatusDisposition(paneKey, {
      source,
      rawSource: envelope.source,
      hookEventName,
      isReplay: envelope.isReplay === true,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true,
      launchToken: envelope.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    if (statusDisposition === 'restart') {
      // Why: same rebind as the HTTP path — a retired pane taking a new turn is a new session.
      // Why paneKey, not envelope.paneKey: alias resolution already mapped it to the
      // stable pane, so the rebind cannot land on a legacy key.
      this.observations.rebind(paneKey)
    }
    const worktreeId =
      envelope.worktreeId !== undefined && envelope.worktreeId.trim().length > 0
        ? envelope.worktreeId.trim()
        : undefined
    const promptInteractionKey =
      typeof envelope.promptInteractionKey === 'string' &&
      envelope.promptInteractionKey.trim().length > 0
        ? envelope.promptInteractionKey.trim()
        : undefined
    const toolUseId =
      typeof envelope.toolUseId === 'string' && envelope.toolUseId.trim().length > 0
        ? envelope.toolUseId.trim()
        : undefined
    const toolAgentId =
      typeof envelope.toolAgentId === 'string' && envelope.toolAgentId.trim().length > 0
        ? envelope.toolAgentId.trim()
        : undefined
    const teammateName =
      typeof envelope.teammateName === 'string' && envelope.teammateName.trim().length > 0
        ? envelope.teammateName.trim()
        : undefined
    const toolAgentType =
      typeof envelope.toolAgentType === 'string' && envelope.toolAgentType.trim().length > 0
        ? envelope.toolAgentType.trim()
        : undefined
    const providerSession = normalizeAgentProviderSession(envelope.providerSession) ?? undefined
    // Why: relay crosses a trust boundary — re-run the canonical normalizer to enforce caps/invariants (returns null on malformed).
    const validatedPayload = normalizeAgentStatusPayload(envelope.payload)
    if (!validatedPayload) {
      return
    }
    // Why: restore a shed roster only when its digest and turn identity still match the cache.
    let normalizedPayload = restoreShedStatusFields(
      validatedPayload,
      envelope.shedFields,
      this.state.lastStatusByPaneKey.get(paneKey)?.payload
    )
    const previousStatus = this.state.lastStatusByPaneKey.get(paneKey)
    let acceptedCompactCompletion = false
    if (hookEventName === 'PreCompact' || hookEventName === 'PostCompact') {
      // Why: PreCompact is never registered and proves nothing (an aborted compact emits it alone);
      // reject it here too so a host on any version cannot drive pane state from it.
      if (hookEventName === 'PreCompact' || source !== 'claude') {
        return
      }
      // Why: a relay predating this change strips `compactTrigger` from its cached PostCompact
      // before replaying it, so the replay has no manual/auto discriminator. That relay's mapping is
      // fixed and known — manual produced `done`, auto produced `working` — so the payload state
      // stands in for the missing trigger. Trigger substitution only; ownership is still checked.
      const effectiveTrigger = resolveLegacyCompactTrigger(compactTrigger, normalizedPayload.state)
      // Why: an auto compact happens inside a turn that resumes and emits its own Stop. An older
      // relay maps it to `working`, and this ingest applies the relay's payload verbatim — so
      // without this drop, every auto compact on such a host mints exactly the stuck `working` this
      // change removes.
      if (effectiveTrigger !== 'manual' || normalizedPayload.agentType !== source) {
        return
      }
      if (
        isClaudeCompactCompletionConsumed(
          this.state.claudeConsumedCompactPromptIdByPaneKey,
          paneKey,
          providerPromptId
        ) ||
        !canAcceptClaudeCompactCompletion(previousStatus, {
          source,
          connectionId: trimmedConnectionId,
          providerPromptId,
          providerSession
        })
      ) {
        return
      }
      markClaudeCompactCompletionConsumed(
        this.state.claudeConsumedCompactPromptIdByPaneKey,
        paneKey,
        providerPromptId
      )
      // Why: an older relay built this payload before the boundary flag existed, so it arrives as a
      // plain `done` — which every completion-reactive consumer reads as a finished turn. Stamp the
      // boundary here so a compact stays silent regardless of which relay normalized it.
      if (normalizedPayload.sessionBoundary !== true) {
        normalizedPayload = { ...normalizedPayload, sessionBoundary: true }
      }
      acceptedCompactCompletion = true
    }
    // Why: keyed on "did we accept a completion", not on the trigger surviving the wire — the
    // trigger-stripped replay is exactly the shape that arrives without one, and it is still the
    // compact's own promptless event, so it still needs the summarized turn's label.
    if (
      source === 'claude' &&
      (compactTrigger !== undefined || acceptedCompactCompletion) &&
      normalizedPayload.prompt.length === 0 &&
      previousStatus?.payload.prompt
    ) {
      normalizedPayload = { ...normalizedPayload, prompt: previousStatus.payload.prompt }
    }
    if (
      envelope.providerSessionOnly === true &&
      !isValidPiProviderSessionOnly(providerSession, normalizedPayload.agentType)
    ) {
      return
    }
    const applyClaudeBackgroundWork =
      normalizedPayload.agentType === 'claude' &&
      typeof envelope.claudeRunningNonAgentTask === 'boolean' &&
      // Why: reconnect replay may seed a restarted listener, but cannot override any observation made by this runtime.
      (envelope.isReplay !== true || !this.runtimeObservedStatusPaneKeys.has(paneKey))
    // Why: run the HTTP path's warn-once version/env-mismatch diagnostics with this.env as expected.
    warnOnHookEnvOrVersionMismatch(this.state, {
      version: envelope.version,
      env: envelope.env,
      expectedEnv: this.env
    })
    const event: AgentHookEventPayload = {
      paneKey,
      source,
      launchToken: statusDisposition === 'restart' ? undefined : envelope.launchToken,
      tabId,
      worktreeId,
      connectionId: trimmedConnectionId,
      hasExplicitPrompt: envelope.hasExplicitPrompt === true ? true : undefined,
      promptInteractionKey,
      hookEventName,
      providerPromptId,
      compactTrigger,
      toolUseId,
      toolAgentId,
      teammateName,
      toolAgentType,
      providerSession,
      providerSessionOnly: envelope.providerSessionOnly === true ? true : undefined,
      isReplay: envelope.isReplay === true ? true : undefined,
      claudeRunningNonAgentTask:
        typeof envelope.claudeRunningNonAgentTask === 'boolean'
          ? envelope.claudeRunningNonAgentTask
          : undefined,
      payload: normalizedPayload
    }
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(
      event,
      applyClaudeBackgroundWork
        ? () => {
            if (envelope.claudeRunningNonAgentTask) {
              this.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
            } else {
              this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
            }
          }
        : undefined
    )
  }

  async start(options?: {
    env?: string
    userDataPath?: string
    endpointNamespace?: string
  }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    if (options?.userDataPath) {
      // Why: dev builds share one userData path; namespace per instance while packaged keeps the stable path for PTY reconnect.
      this.endpointDir = options.endpointNamespace
        ? join(options.userDataPath, 'agent-hooks', options.endpointNamespace)
        : join(options.userDataPath, 'agent-hooks')
      this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
      this.lastStatusFilePath = join(this.endpointDir, LAST_STATUS_FILE_NAME)
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.lastWrittenJson = null
    // Why: hydrate before binding the listener so an early hook POST runs against a populated map.
    if (this.lastStatusFilePath) {
      this.persistence.hydrateLastStatusFromDisk(HYDRATE_MAX_AGE_MS)
    }
    this.captureHydratedAuthorityCommitments()
    // Drain before binding the listener so replay cannot race a live hook during startup.
    if (this.endpointDir) {
      drainAgentHookSpool({
        endpointDir: this.endpointDir,
        getPersistedLaunchTokenHash: (paneKey) =>
          this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
        ingest: (record: SpoolRecord) => this.ingestSpoolRecord(record)
      })
    }
    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }

      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }

      // Why: bound request time so a stalled client can't hold a socket open (slowloris).
      // Why: track our own destroy so the slowloris cap can't be misread as outside interference.
      let destroyedBySlowlorisCap = false
      req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
        destroyedBySlowlorisCap = true
        req.destroy()
      })

      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      try {
        const body = await readRequestBody(req)
        if (pathname === CLAUDE_STATUSLINE_PATHNAME) {
          const statusLineEvent = parseClaudeStatusLineBody(body)
          if (statusLineEvent) {
            this.onClaudeStatusLine?.(statusLineEvent)
          }
          res.writeHead(204)
          res.end()
          return
        }
        const source = resolveHookSource(pathname)
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        const hookBody = mergeAgentHookRequestHeaders(body, req.headers)
        trackEmptyPaneKeyHook(hookBody)
        const aliasedBody = this.normalizeHookBodyPaneKeyAlias(hookBody)
        const normalized = this.normalizeLocalHookPayload(source, aliasedBody)
        const statusDisposition = normalized.event
          ? this.getAgentStatusDisposition(normalized.event.paneKey, {
              source,
              hookEventName: normalized.event.hookEventName,
              isReplay: normalized.event.isReplay,
              hasExplicitPrompt: normalized.event.hasExplicitPrompt,
              launchToken: normalized.event.launchToken
            })
          : 'suppress'
        if (normalized.event && statusDisposition !== 'suppress') {
          const event =
            statusDisposition === 'restart'
              ? { ...normalized.event, launchToken: undefined }
              : normalized.event
          if (statusDisposition === 'restart') {
            // Why: a retired pane accepting a new turn is a different agent session behind the
            // same key — later observations must not be ordered against the retired one.
            this.observations.rebind(event.paneKey)
          }
          this.recordCurrentAuthorityObservation(event)
          const enriched = this.applyNormalizedStatus(event, normalized.onAccepted)
          this.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
          this.scheduleCodexSubagentPoll(source, aliasedBody, enriched)
        }

        res.writeHead(204)
        res.end()
      } catch (error) {
        // Why (#11217): an authenticated POST whose body dies short of its own Content-Length was cut
        // by something on the loopback path, not by a bad payload. Fail open as before, but count it —
        // this is the one failure mode that silently stops status for every runtime at once.
        if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
          this.transportInterference.record({ source: resolveHookSource(pathname) ?? null, error })
        }
        // Why: fail open — return success on malformed payloads so a broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    }
    // Why: node ignores a returned promise, so the handler must settle it itself; handleRequest never rejects.
    this.server = createServer((req, res) => {
      void handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      // Why: swap the startup reject-handler for a logging one so a later runtime 'error' can't crash main as an unhandled event.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        this.maybeWriteEndpointFile()
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    this.flushStatusPersistSync()
    this.persistence.stop()
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
    this.onPaneStatusCleared = null
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    for (const timer of this.codexSubagentPollTimers.values()) {
      clearTimeout(timer)
    }
    this.codexSubagentPollTimers.clear()
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    this.lastStatusFilePath = null
    this.runtimeObservedStatusPaneKeys.clear()
    this.hydratedAuthorityCommitments = Object.freeze([])
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    this.currentAuthorityObservations.clear()
    this.promptSentDedupeByPaneKey.clear()
    this.closedAgentStatusTabIds.clear()
    this.closedAgentStatusPaneKeys.clear()
    this.restartedStatusLaunchTokenHashByPaneKey.clear()
    this.retiredPaneFencesByKey.clear()
    this.connectionTimestampWatermarkById.clear()
    this.legacyPaneKeyAliases.clear()
    clearAllListenerCaches(this.state)
    this.notifyStatusChangeListeners()
  }

  // Pane authority delegation methods
  normalizeHookBodyPaneKeyAlias(body: unknown): unknown {
    return this.paneAuthority.normalizeHookBodyPaneKeyAlias(body)
  }

  getAgentStatusDisposition(
    paneKey: string,
    options?: {
      hookEventName?: string
      isReplay?: boolean
      source?: AgentHookSource
      hasExplicitPrompt?: boolean
      launchToken?: string
    }
  ): AgentStatusDisposition {
    return this.paneAuthority.getAgentStatusDisposition(paneKey, options)
  }

  resolvePaneKeyAlias(paneKey: string): string {
    return this.paneAuthority.resolvePaneKeyAlias(paneKey)
  }

  registerPaneKeyAlias(
    legacyPaneKey: string,
    stablePaneKey: string,
    ptyId: string | null,
    updatedAt?: number,
    options?: { authorityVerified: boolean }
  ): void {
    this.paneAuthority.registerPaneKeyAlias(legacyPaneKey, stablePaneKey, ptyId, updatedAt, options)
  }

  clearPaneKeyAliasesForPty(
    ptyId: string,
    options?: { shouldClearStablePaneKey?: (stablePaneKey: string) => boolean }
  ): void {
    this.paneAuthority.clearPaneKeyAliasesForPty(ptyId, options)
  }

  retirePaneAuthority(paneKey: string): void {
    this.paneAuthority.retirePaneAuthority(paneKey)
  }

  restorePaneAuthority(paneKey: string): boolean {
    return this.paneAuthority.restorePaneAuthority(paneKey)
  }

  transferPaneAuthority(
    fromPaneKey: string,
    toPaneKey: string,
    ptyId: string | null,
    updatedAt?: number,
    options?: { authorityVerified: boolean }
  ): void {
    this.paneAuthority.transferPaneAuthority(fromPaneKey, toPaneKey, ptyId, updatedAt, options)
  }

  canTransferPaneAuthority(
    paneKey: string,
    ptyId: string | undefined,
    ownsPty: (paneKey: string, ptyId: string) => boolean
  ): boolean {
    return this.paneAuthority.canTransferPaneAuthority(paneKey, ptyId, ownsPty)
  }

  setPaneKeyAliasPersistenceListener(
    listener: ((entries: LegacyPaneKeyAliasEntry[]) => void) | null
  ): void {
    this.paneAuthority.setPaneKeyAliasPersistenceListener(listener)
  }

  // Status ingestion delegation — public methods for external callers
  applyNormalizedStatus(
    payload: AgentHookEventPayload,
    onAccepted?: () => void,
    origin?: AgentStatusObservationOrigin
  ): EnrichedAgentHookEventPayload {
    return this.ingest.applyNormalizedStatus(payload, onAccepted, origin)
  }

  clearAssistantMessageRetry(paneKey: string): void {
    this.ingest.clearAssistantMessageRetry(paneKey)
  }

  clearCodexSubagentPoll(paneKey: string): void {
    this.ingest.clearCodexSubagentPoll(paneKey)
  }

  scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    this.ingest.scheduleCodexSubagentPoll(source, body, original)
  }

  scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt?: number,
    discoveryReady?: boolean
  ): void {
    this.ingest.scheduleAssistantMessageRetry(source, body, original, attempt, discoveryReady)
  }

  normalizeLocalHookPayload(source: AgentHookSource, body: unknown): NormalizedLocalHook {
    return this.ingest.normalizeLocalHookPayload(source, body)
  }

  // Support methods required by PaneAuthorityRegistry
  markPaneClosedForAgentStatus(paneKey: string): void {
    this.closedAgentStatusPaneKeys.add(paneKey)
  }

  markTabClosedForAgentStatus(tabId: string): void {
    this.closedAgentStatusTabIds.add(tabId)
  }

  notifyPaneKeyAliasPersistenceListener(): void {
    // This is called by PaneAuthorityRegistry when aliases change
    // The actual listener is set via setPaneKeyAliasPersistenceListener
  }

  revokeHydratedAuthorityForPaneKeys(paneKeys: Set<string>): boolean {
    let changed = false
    for (const paneKey of paneKeys) {
      for (const commitment of this.hydratedAuthorityCommitments) {
        if (commitment.paneKey === paneKey) {
          this.revokedHydratedAuthorityCommitments.add(commitment)
          changed = true
        }
      }
    }
    return changed
  }

  /** The resume-identity remnant of a dropped row: a `providerSessionOnly` entry carries no state
   *  claim — it cannot gate a pane `working` — so it survives teardowns that end the pane's live
   *  claims. Returns null when the row has no resumable session to keep. */
  private toRetainedProviderSessionRow(
    entry: EnrichedAgentHookEventPayload | null | undefined
  ): EnrichedAgentHookEventPayload | null {
    if (
      !entry?.providerSession ||
      !entry.payload.agentType ||
      entry.payload.agentType === 'unknown'
    ) {
      return null
    }
    const { launchToken: _launchToken, ...resumeIdentity } = entry
    return { ...resumeIdentity, providerSessionOnly: true, retainedForLiveness: true }
  }

  /** Drop only the status row (user dismissal); do NOT wipe prompt/tool caches since the pane's agent may still be alive. Use clearPaneState for PTY-teardown. */
  dropStatusEntry(paneKey: string): void {
    const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
    if (!deleted) {
      return
    }
    const retained = this.toRetainedProviderSessionRow(deleted)
    if (retained) {
      this.state.lastStatusByPaneKey.set(deleted.paneKey, retained)
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
  }

  /** Retire panes whose owning process is certifiably dead.
   *
   *  The ordinary teardown already does this: every attributable PTY exit reaches
   *  `clearProviderPtyState`, which resolves the pane key and calls `clearPaneState`. But that
   *  resolution depends on the spawn-time `ptyPaneKey` mapping, which a restored/reattached PTY may
   *  never rebuild — so those panes keep a `working` row and its latches for good, with no hook left
   *  to retire them. This is the same operation reached from the runtime's own pane-key knowledge,
   *  so a dead pane is cleaned up identically however its keys were resolved. */
  reconcileEndedProcessForPaneKeys(
    paneKeys: Iterable<string>,
    options?: {
      /** The pane's PTY outlived its agent (a confirmed shell foreground), so the session can still
       *  be resumed in place — keep the `providerSessionOnly` remnant the paired `agentStatus:drop`
       *  minted for exactly this case. A certified PTY exit passes nothing: there is no pane left to
       *  resume into, and dropping it matches what `clearProviderPtyState` already does. */
      preserveResumeIdentity?: boolean
    }
  ): number {
    let cleared = 0
    for (const paneKey of paneKeys) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      if (!this.hasLiveClaimsForPaneKey(resolvedPaneKey)) {
        continue
      }
      const retained = options?.preserveResumeIdentity
        ? this.toRetainedProviderSessionRow(
            this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
              | EnrichedAgentHookEventPayload
              | undefined
          )
        : null
      this.clearPaneState(resolvedPaneKey)
      if (retained) {
        this.state.lastStatusByPaneKey.set(resolvedPaneKey, retained)
        this.scheduleStatusPersist()
        this.notifyStatusChangeListeners()
      }
      cleared += 1
    }
    return cleared
  }

  /** Anything a dead pane could still be asserting: a row, or a latch that would re-gate one through
   *  `resolveClaudePaneState` on the pane's next event even after the row reads `done`. The list
   *  itself lives beside `clearPaneCacheState`, so adding a latch cannot leave this behind in a
   *  different file. */
  private hasLiveClaimsForPaneKey(paneKey: string): boolean {
    return paneHasStateClaims(this.state, paneKey)
  }

  /** Clear statuses proven to belong to one lost SSH transport. */
  clearStatusEntriesForConnection(connectionId: string): void {
    const normalizedConnectionId = connectionId.trim()
    if (normalizedConnectionId.length === 0) {
      return
    }
    const clearedAt = Math.max(
      Date.now(),
      (this.connectionTimestampWatermarkById.get(normalizedConnectionId) ?? -1) + 1
    )
    this.connectionTimestampWatermarkById.set(normalizedConnectionId, clearedAt)
    let statusChanged = false
    for (const [paneKey, rawEntry] of this.state.lastStatusByPaneKey) {
      const entry = rawEntry as EnrichedAgentHookEventPayload
      // Why: unstamped rows can't be attributed to one host; leave them for normal pane teardown.
      if (entry.connectionId !== normalizedConnectionId) {
        continue
      }
      const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
      if (deleted) {
        statusChanged = true
        if (deleted.payload.agentType === 'codex') {
          // Why: a replacement remote process may reuse the pane; don't merge it with the lost connection's children.
          this.state.codexSubagentRosterByPaneKey.delete(paneKey)
          this.state.codexLeadStateByPaneKey.delete(paneKey)
        } else if (deleted.payload.agentType === 'claude') {
          this.state.claudeSubagentRosterByPaneKey.delete(paneKey)
          this.state.claudeLeadStateByPaneKey.delete(paneKey)
          this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
          this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
          this.state.claudeSessionOwnerByPaneKey.delete(paneKey)
        }
      }
    }
    for (const [paneKey, evidence] of this.currentAuthorityObservations) {
      if (evidence.connectionId === normalizedConnectionId) {
        this.currentAuthorityObservations.delete(paneKey)
      }
    }
    if (statusChanged) {
      // Why: persist/notify once — one disconnect can own many panes.
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    // Why: always send the cutoff even with no matched entry — another host may have overwritten this pane's row.
    this.emitPaneStatusCleared({
      transient: true,
      connectionId: normalizedConnectionId,
      clearedAt
    })
  }

  private deleteStatusEntry(
    paneKey: string,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const existing = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return null
    }
    this.state.lastStatusByPaneKey.delete(resolvedPaneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    if (!options?.preserveAuthority) {
      this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
    }
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearCodexSubagentPoll(resolvedPaneKey)
    this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    if (existing.payload.state === 'done') {
      this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    }
    return existing
  }

  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.markTabClosedForAgentStatus(tabId)
    const paneKeysToClear = new Set<string>()
    for (const key of this.state.lastStatusByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
      }
    }
    for (const key of this.state.lastPromptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.lastToolByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.antigravityCompletedTranscriptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.ampCompletedCacheKeys) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const paneKey of this.runtimeObservedStatusPaneKeys) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const paneKey of this.promptSentDedupeByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (paneCacheKeyMatchesTab(commitment.paneKey, tabId)) {
        paneKeysToClear.add(commitment.paneKey)
      }
    }

    let aliasChanged = false
    for (const [legacyPaneKey, entry] of this.legacyPaneKeyAliases) {
      const ownerMatches = paneCacheKeyMatchesTab(entry.stablePaneKey, tabId)
      if (ownerMatches) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeysToClear.add(legacyPaneKey)
        paneKeysToClear.add(entry.stablePaneKey)
        this.markPaneClosedForAgentStatus(legacyPaneKey)
        this.markPaneClosedForAgentStatus(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeysToClear)

    let statusChanged = false
    for (const paneKey of paneKeysToClear) {
      if (this.state.lastStatusByPaneKey.has(paneKey)) {
        statusChanged = true
      }
      this.clearAssistantMessageRetry(paneKey)
      this.clearCodexSubagentPoll(paneKey)
      clearPaneCacheState(this.state, paneKey)
      this.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
      this.runtimeObservedStatusPaneKeys.delete(paneKey)
      this.currentAuthorityObservations.delete(paneKey)
      this.promptSentDedupeByPaneKey.delete(paneKey)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (statusChanged || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  clearPaneState(paneKey: string): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const hadStatus = this.state.lastStatusByPaneKey.has(resolvedPaneKey)
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearCodexSubagentPoll(resolvedPaneKey)
    clearPaneCacheState(this.state, resolvedPaneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
    let clearedAlias = false
    for (const [legacyPaneKey, stablePaneKey] of this.legacyPaneKeyAliases) {
      if (stablePaneKey.stablePaneKey === resolvedPaneKey) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeys.add(legacyPaneKey)
        paneKeys.add(stablePaneKey.stablePaneKey)
        clearPaneCacheState(this.state, legacyPaneKey)
        this.activeHookTurnCompletedAtByPaneKey.delete(legacyPaneKey)
        this.currentAuthorityObservations.delete(legacyPaneKey)
        this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        this.restartedStatusLaunchTokenHashByPaneKey.delete(legacyPaneKey)
        clearedAlias = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (hadStatus || authorityChanged) {
      this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitPaneStatusCleared({ paneKey: resolvedPaneKey })
    }
  }

  /** Second reap path for restored Claude subagent rows: drop the ones whose pane
   *  has no live local agent process behind it any more. A PTY that dies while Orca
   *  is down never runs the teardown that clears pane state, so hydrate rebuilds a
   *  roster nothing can ever retire — the inventory reap needs the parent to emit a
   *  complete `background_tasks` list and an idle parent never does. The row then
   *  gates the pane 'working' for the rest of its life and hibernation, which
   *  requires 'done', can never reclaim the agent's heap.
   *
   *  Both the execution host and relay binding must prove local ownership before
   *  targeted PTY liveness is consulted. Panes that reported in this runtime are
   *  also skipped. Returns the number of panes changed. */
  async reapRestoredClaudeSubagentsWithoutLiveAgent(
    isLocalExecutionHost: (worktreeId: string | undefined) => boolean,
    isLocalPaneAgentLive: (paneKey: string) => Promise<boolean>,
    isLocalPaneLivenessEvidenceCurrent: (paneKey: string) => boolean
  ): Promise<number> {
    const candidates: { paneKey: string; entry: EnrichedAgentHookEventPayload }[] = []
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      const enriched = entry as EnrichedAgentHookEventPayload
      if (
        enriched.payload.agentType === 'claude' &&
        enriched.connectionId === null &&
        isLocalExecutionHost(enriched.worktreeId) &&
        // Why: a restored roster is only one shape of stranded claim. A lead row left non-terminal,
        // or a background-task/cron latch nothing will refresh, strands the pane just as
        // permanently — and unlike the roster case there is no child event left to reap it.
        (claudeRosterHasRestoredSnapshotSubagent(
          this.state.claudeSubagentRosterByPaneKey.get(paneKey)
        ) ||
          enriched.payload.state !== 'done' ||
          this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
          this.state.claudeActiveSessionCronPaneKeys.has(paneKey)) &&
        !this.runtimeObservedStatusPaneKeys.has(paneKey)
      ) {
        candidates.push({ paneKey, entry: enriched })
      }
    }
    const liveness = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await isLocalPaneAgentLive(candidate.paneKey)
        } catch {
          return true
        }
      })
    )
    let changedPanes = 0
    for (const [index, candidate] of candidates.entries()) {
      const { paneKey, entry: enriched } = candidate
      if (
        liveness[index] ||
        !isLocalPaneLivenessEvidenceCurrent(paneKey) ||
        this.state.lastStatusByPaneKey.get(paneKey) !== enriched ||
        this.runtimeObservedStatusPaneKeys.has(paneKey) ||
        !isLocalExecutionHost(enriched.worktreeId)
      ) {
        continue
      }
      if (!reapRestoredClaudeSubagentsForDeadPane(this.state, paneKey)) {
        // Why: the roster reap only speaks for restored child rows. A pane whose PTY is provably
        // gone and whose claim is a lead row or a latch has nothing for it to reap, so retire the
        // pane the same way an observed exit would — otherwise the widened candidate set is inert.
        //
        // Why delete rather than downgrade to `done` like the reap branch below: that branch has a
        // real turn to describe — a parent whose children it just reaped — while these panes' only
        // claim IS the stale non-terminal row. Rewriting a `waiting`/`blocked` row to `done` would
        // invent a completion that never happened, and leaving it non-terminal keeps the bug. This
        // sweep stands in for the exit Orca never observed, so it does what that exit does:
        // `clearProviderPtyState` -> `clearPaneState`.
        if (this.hasLiveClaimsForPaneKey(paneKey)) {
          this.clearPaneState(paneKey)
          changedPanes += 1
        }
        continue
      }
      changedPanes += 1
      const roster = this.state.claudeSubagentRosterByPaneKey.get(paneKey)
      const subagents = claudeRosterToSnapshots(roster)
      // Why: the pane's persisted 'working' was the child gate holding a finished
      // lead open (subagent events never set lead state). With the last working row
      // gone and no process left to report, 'done' is the only truthful state — and
      // the one hibernation needs once this pane's agent is restored.
      const state =
        enriched.payload.state === 'working' && !claudeRosterHasWorkingSubagent(roster)
          ? 'done'
          : enriched.payload.state
      const stateChanged = state !== enriched.payload.state
      const reconciledAt = stateChanged
        ? Math.max(Date.now(), enriched.receivedAt + 1)
        : enriched.receivedAt
      // Why: a reconciled `done` is process-probe-verified, not hydrated guesswork — carrying
      // restoredUnconfirmed onto it would make freshness gates suppress a legitimate completion.
      const { restoredUnconfirmed, ...reconciledBase } = enriched
      const reconciled: EnrichedAgentHookEventPayload = {
        ...reconciledBase,
        ...(state !== 'done' && restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
        receivedAt: reconciledAt,
        stateStartedAt: stateChanged ? reconciledAt : enriched.stateStartedAt,
        payload: {
          ...enriched.payload,
          state,
          workingMode: state === 'working' ? enriched.payload.workingMode : undefined,
          subagents
        }
      }
      this.state.lastStatusByPaneKey.set(paneKey, reconciled)
    }
    if (changedPanes > 0) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    return changedPanes
  }

  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION,
      ORCA_AGENT_HOOK_TRANSPORT: ORCA_HOOK_RAW_JSON_TRANSPORT
    }
    // Why: hooks source this file at invocation; dev namespaces it so parallel `pnpm dev` runs don't steal each other's hooks.
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

  /** Test/diagnostic accessor for the on-disk last-status file path. */
  get lastStatusPath(): string | null {
    return this.lastStatusFilePath
  }

  private maybeWriteEndpointFile(): void {
    if (!this.endpointDir || !this.endpointFilePathCache) {
      return
    }
    this.endpointFileWritten = false
    const ok = writeEndpointFile(this.endpointDir, this.endpointFilePathCache, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    this.endpointFileWritten = ok
  }

  private hydrateLastStatusFromDisk(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Why: keep hydrate idempotent so a future re-start path can't merge prior-session state.
    this.state.lastStatusByPaneKey.clear()
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    let raw: string
    try {
      raw = readFileSync(this.lastStatusFilePath, 'utf8')
    } catch (err) {
      // Why: missing file is normal (first launch); other errors degrade to empty hydration + one warn.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-hooks] failed to read last-status file:', err)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[agent-hooks] last-status file is not valid JSON; ignoring')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[agent-hooks] last-status file is not an object; ignoring')
      return
    }
    const file = parsed as Partial<LastStatusFile>
    if (file.version !== LAST_STATUS_FILE_VERSION) {
      console.warn(
        `[agent-hooks] last-status file version mismatch (${String(
          file.version
        )} != ${LAST_STATUS_FILE_VERSION}); ignoring`
      )
      return
    }
    const entries = file.entries
    if (typeof entries !== 'object' || entries === null) {
      console.warn('[agent-hooks] last-status file entries missing or wrong shape; ignoring')
      return
    }
    let hydrated = 0
    let dropped = 0
    let prunedLegacyClaudeSubagents = 0
    let scrubbedLegacyLaunchTokens = 0
    // Why: drop entries older than HYDRATE_MAX_AGE_MS to bound disk growth (one Date.now() for a consistent cutoff).
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, rawEntry] of Object.entries(entries)) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const rawResolvedEntry =
        resolvedPaneKey === paneKey || typeof rawEntry !== 'object' || rawEntry === null
          ? rawEntry
          : { ...(rawEntry as Record<string, unknown>), paneKey: resolvedPaneKey }
      const entry = sanitizeHydratedEntry(resolvedPaneKey, rawResolvedEntry)
      if (entry && entry.receivedAt >= ttlCutoff) {
        const launchTokenHash = readPersistedLaunchTokenHash(rawResolvedEntry)
        if (launchTokenHash) {
          this.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, launchTokenHash)
          const evidence = this.toAuthorityEvidence(entry, launchTokenHash)
          if (evidence) {
            this.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, evidence)
          }
        }
        if (
          typeof rawResolvedEntry === 'object' &&
          rawResolvedEntry !== null &&
          typeof (rawResolvedEntry as Record<string, unknown>).launchToken === 'string'
        ) {
          scrubbedLegacyLaunchTokens += 1
        }
        const hydratedPayload = dropHydratedIdleClaudeSubagents(entry.payload)
        if (hydratedPayload !== entry.payload) {
          prunedLegacyClaudeSubagents +=
            (entry.payload.subagents?.length ?? 0) - (hydratedPayload.subagents?.length ?? 0)
          entry.payload = hydratedPayload
        }
        if (entry.payload.state !== 'done') {
          // Why: the terminal transition may have fired while no receiver was up; restore as unconfirmed, never as live truth.
          entry.restoredUnconfirmed = true
        }
        this.state.lastStatusByPaneKey.set(resolvedPaneKey, entry)
        if (entry.connectionId) {
          // Why: a restart can see an earlier wall clock; seed ordering so new events stay after disk state.
          const previousWatermark = this.connectionTimestampWatermarkById.get(entry.connectionId)
          this.connectionTimestampWatermarkById.set(
            entry.connectionId,
            Math.max(previousWatermark ?? -1, entry.receivedAt)
          )
        }
        // Why: restore live child hierarchy immediately; provider-specific reconciliation reaps stale seeds.
        if (entry.payload.agentType === 'codex') {
          seedCodexStateFromSnapshot(this.state, resolvedPaneKey, entry.payload)
        } else if (entry.payload.agentType === 'claude') {
          seedClaudeLeadTurnFromPersistedStatus(this.state, resolvedPaneKey, entry, {
            childOnlyBoundary: entry.claudeLeadBoundaryChildOnly === true
          })
          if (entry.payload.subagents) {
            seedClaudeSubagentRosterFromSnapshots(
              this.state,
              resolvedPaneKey,
              entry.payload.subagents
            )
          }
        }
        hydrated += 1
      } else {
        dropped += 1
      }
    }
    for (const [paneKey, rawCommitment] of Object.entries(file.authorityCommitments ?? {})) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const commitment = sanitizePersistedAuthorityCommitment(resolvedPaneKey, rawCommitment)
      if (!commitment || commitment.observedAt < ttlCutoff) {
        dropped += 1
        continue
      }
      const existing = this.persistedAuthorityCommitmentsByPaneKey.get(resolvedPaneKey)
      if (existing && !authorityCommitmentsMatch(existing, commitment)) {
        this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
        this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
        dropped += 1
        continue
      }
      this.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, commitment)
      this.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, commitment.launchTokenHash)
    }
    if (dropped > 0) {
      console.warn(
        `[agent-hooks] last-status hydrate dropped ${dropped} entries (kept ${hydrated})`
      )
    }
    if (dropped > 0 || prunedLegacyClaudeSubagents > 0 || scrubbedLegacyLaunchTokens > 0) {
      // Why: persist load-time pruning and bearer scrubbing once.
      this.runStatusPersist()
    } else if (hydrated > 0) {
      // Why: prime dedup from raw bytes (not re-serialized) only when hydration was lossless.
      this.lastWrittenJson = raw
    }
  }

  private captureHydratedAuthorityCommitments(): void {
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    for (const entry of this.state.lastStatusByPaneKey.values()) {
      const evidence = this.toAuthorityEvidence(
        entry as EnrichedAgentHookEventPayload,
        this.hydratedLaunchTokenHashByPaneKey.get(entry.paneKey)
      )
      if (evidence && !this.persistedAuthorityCommitmentsByPaneKey.has(entry.paneKey)) {
        this.persistedAuthorityCommitmentsByPaneKey.set(entry.paneKey, evidence)
      }
    }
    this.hydratedAuthorityCommitments = Object.freeze(
      Array.from(this.persistedAuthorityCommitmentsByPaneKey.values())
    )
  }

  private recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void {
    const evidence = this.toAuthorityEvidence(payload)
    if (evidence) {
      this.currentAuthorityObservations.set(evidence.paneKey, evidence)
      this.persistedAuthorityCommitmentsByPaneKey.set(evidence.paneKey, evidence)
      this.hydratedLaunchTokenHashByPaneKey.set(evidence.paneKey, evidence.launchTokenHash)
    }
  }

  toAuthorityEvidence(
    payload: unknown,
    launchTokenHashOverride?: string
  ): unknown {
    const launchToken = payload.launchToken?.trim()
    const launchTokenHash =
      launchTokenHashOverride ??
      (launchToken ? createHash('sha256').update(launchToken).digest('hex') : null)
    if (!launchTokenHash) {
      return null
    }
    return Object.freeze({
      paneKey: payload.paneKey,
      launchTokenHash,
      connectionId: payload.connectionId,
      ...(payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
      observedAt: 'receivedAt' in payload ? payload.receivedAt : Date.now()
    })
  }

  private serializeStatusFile(): string {
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    for (const [paneKey, commitment] of this.persistedAuthorityCommitmentsByPaneKey) {
      authorityCommitments[paneKey] = { ...commitment }
    }
    for (const [paneKey, payload] of this.state.lastStatusByPaneKey) {
      // Why: never persist invalid keys (matches the hydrate-path invariant).
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const enrichedPayload = payload as EnrichedAgentHookEventPayload
      const childOnlyBoundary = enrichedPayload.claudeLeadBoundaryChildOnly === true
      const {
        claudeRunningNonAgentTask: _claudeRunningNonAgentTask,
        promptInteractionKey: _promptInteractionKey,
        // Why: never persisted — hydrate re-stamps it, so a stored copy could only drift.
        restoredUnconfirmed: _restoredUnconfirmed,
        // Why: same — the sequencer that issued it dies with the process (see PersistedAgentHookEventPayload).
        observation: _observation,
        // Replay provenance is runtime-only and must not survive another restart.
        isReplay: _isReplay,
        launchToken,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = launchToken?.trim()
        ? createHash('sha256').update(launchToken.trim()).digest('hex')
        : this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      entries[paneKey] = {
        ...persistedPayload,
        ...(childOnlyBoundary ? { claudeLeadBoundaryChildOnly: true } : {}),
        ...(launchTokenHash ? { launchTokenHash } : {})
      }
      const commitment = this.toAuthorityEvidence(payload, launchTokenHash)
      if (commitment && !conflictedCommitments.has(paneKey)) {
        const existing = authorityCommitments[paneKey]
        if (existing && !authorityCommitmentsMatch(existing, commitment)) {
          delete authorityCommitments[paneKey]
          conflictedCommitments.add(paneKey)
        } else {
          authorityCommitments[paneKey] = { ...commitment }
        }
      }
    }
    const file: LastStatusFile = {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments
    }
    return JSON.stringify(file)
  }

  private scheduleStatusPersist(): void {
    this.persistence.scheduleStatusPersist(STATUS_PERSIST_DEBOUNCE_MS)
  }

  flushStatusPersistSync(): void {
    this.persistence.flushStatusPersistSync()
  }

  /** Test-only accessor for the per-instance listener state (narrow getter avoids an `as unknown` cast). */
  _getStateForTests(): HookListenerState {
    return this.state
  }

  _resetPromptSentDedupeForTests(): void {
    this.promptSentDedupeByPaneKey.clear()
  }

  _resetConnectionTimestampWatermarksForTests(): void {
    this.connectionTimestampWatermarkById.clear()
  }
}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors.
export const _internals = {
  // Why: bind the test-helper to the singleton's state so tests exercise the live caches.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(agentHookServer._getStateForTests(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(agentHookServer._getStateForTests())
    agentHookServer._resetPromptSentDedupeForTests()
    agentHookServer._resetConnectionTimestampWatermarksForTests()
  }
}
