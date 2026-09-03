/* eslint-disable max-lines -- Why: this file owns the loopback HTTP adapter, the on-disk last-status persistence layer (hydrate, sanitize, TTL, atomic write, drop), and the relay ingest path in one place so the cache lifecycle (set → schedule → drain) lives next to the surfaces that mutate it. Splitting would force mutual `private` accessor scaffolding for a single class. */
// Why: this main-process adapter keeps listener internals in shared/ (`src/shared/agent-hook-listener.ts`) so the relay can host the same pipeline without Electron; parsing that drifts back into this file stops applying to SSH panes.
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { LegacyPaneKeyAliasEntry } from '../../shared/persisted-state-types'
import { track } from '../telemetry/client'
import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  createHookListenerState,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import {
  clearClaudeAnsweredQuestionWait,
  markClaudeLeadTurnInterrupted
} from '../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../../shared/agent-hook-listener/endpoint-publication'
import { markCodexLeadTurnInterrupted } from '../../shared/agent-hook-listener/providers/codex-state'
import {
  MAX_PANE_KEY_LEN,
  normalizeClaudePromptId,
  warnOnHookEnvOrVersionMismatch
} from '../../shared/agent-hook-listener/listener-limits'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
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
  type HookTransportInterferenceReport
} from '../../shared/agent-hook-transport-interference'
import {
  isAgentHookSource,
  restoreShedStatusFields,
  type AgentHookSource
} from '../../shared/agent-hook-relay'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
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
  type AgentStatusObservationOrigin
} from '../../shared/agent-status-observation'
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
import {
  buildSpoolHookBody,
  drainAgentHookSpool,
  launchTokenHash,
  type SpoolRecord
} from '../../shared/agent-hook-spool'

export type { AgentHookSource }

import {
  equivalentInterruptAgentType,
  HYDRATE_MAX_AGE_MS,
  isValidPaneKey,
  isValidPiProviderSessionOnly,
  LAST_STATUS_FILE_NAME,
  STATUS_PERSIST_DEBOUNCE_MS,
  toAgentStatusIpcPayload,
  type AgentHookAuthorityAttestation,
  type AgentHookAuthorityEvidence,
  type AgentHookProviderSessionIdentity,
  type AgentHookStatusChangeEntry,
  type AgentPromptSentDedupeEntry,
  type EnrichedAgentHookEventPayload,
  type NormalizedLocalHook,
  type PaneStatusClearListener,
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
  AgentStatusIngestRegistry,
  type AgentHookServerIngestDeps
} from './agent-status-ingest'
import { AgentStatusCleanupRegistry, type AgentStatusCleanupDeps } from './agent-status-cleanup'

export {
  PANE_KEY_ALIASES_MAX,
  RETIRED_PANE_FENCES_MAX,
  type PaneKeyAliasEntry,
  type RetiredPaneFence
} from './pane-authority-transfer'
import { AgentStatusPersistence, type AgentHookServerDeps } from './agent-status-persistence'
import { AgentHookHttpServer, type AgentHookHttpServerDeps } from './agent-hook-http-server'

// Why: server-side enrichment — receivedAt = latest event arrival, stateStartedAt = when the current state first appeared; extra fields ride the shared map untouched (it only writes/clears).

export class AgentHookServer {
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
  private readonly http = new AgentHookHttpServer(this as unknown as AgentHookHttpServerDeps)
  // Why: main is the pane authority for local/WSL/SSH panes — hook HTTP, relay, and its own
  // OSC parse all converge on applyNormalizedStatus, so one sequencer covers every ingress here.
  private readonly observations = new AgentStatusObservationSequencer(
    createAgentStatusAuthorityId('main-agent-hooks')
  )
  private readonly ingest: AgentStatusIngestRegistry
  private readonly cleanup: AgentStatusCleanupRegistry

  constructor() {
    this.persistence = new AgentStatusPersistence(this as unknown as AgentHookServerDeps)
    this.ingest = new AgentStatusIngestRegistry(
      this as unknown as AgentHookServerIngestDeps,
      this.observations
    )
    this.cleanup = new AgentStatusCleanupRegistry(this as unknown as AgentStatusCleanupDeps)
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
    if (this.http.running) {
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
    await this.http.start()
  }

  stop(): void {
    this.flushStatusPersistSync()
    this.persistence.stop()
    this.http.close()
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

  // Status cleanup delegation — public methods for external callers
  dropStatusEntry(paneKey: string): void {
    this.cleanup.dropStatusEntry(paneKey)
  }

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
    return this.cleanup.reconcileEndedProcessForPaneKeys(paneKeys, options)
  }

  clearStatusEntriesForConnection(connectionId: string): void {
    this.cleanup.clearStatusEntriesForConnection(connectionId)
  }

  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.cleanup.dropStatusEntriesByTabPrefix(tabId)
  }

  clearPaneState(paneKey: string): void {
    this.cleanup.clearPaneState(paneKey)
  }

  reapRestoredClaudeSubagentsWithoutLiveAgent(
    isLocalExecutionHost: (worktreeId: string | undefined) => boolean,
    isLocalPaneAgentLive: (paneKey: string) => Promise<boolean>,
    isLocalPaneLivenessEvidenceCurrent: (paneKey: string) => boolean
  ): Promise<number> {
    return this.cleanup.reapRestoredClaudeSubagentsWithoutLiveAgent(
      isLocalExecutionHost,
      isLocalPaneAgentLive,
      isLocalPaneLivenessEvidenceCurrent
    )
  }

  buildPtyEnv(): Record<string, string> {
    if (this.http.port <= 0 || !this.token) {
      return {}
    }

    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.http.port),
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
      port: this.http.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    this.endpointFileWritten = ok
  }

  private captureHydratedAuthorityCommitments(): void {
    this.persistence.captureHydratedAuthorityCommitments()
  }

  private recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void {
    this.persistence.recordCurrentAuthorityObservation(payload)
  }

  toAuthorityEvidence(
    payload: unknown,
    launchTokenHashOverride?: string
  ): unknown {
    return this.persistence.toAuthorityEvidence(payload, launchTokenHashOverride)
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
