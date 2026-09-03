import { createHash } from 'node:crypto'

import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'
import {
  hasCodexTranscriptSubagents,
  markCodexLeadTurnInterrupted,
  reconcileRemoteCodexState
} from '../../shared/agent-hook-listener/providers/codex-state'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../shared/agent-hook-listener/grok-result-discovery'
import {
  isNewTurnEvent
} from '../../shared/agent-hook-listener/provider-event-routing'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../shared/command-code-turn-boundary'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import type {
  AgentStatusObservationSequencer,
  AgentStatusObservation,
  AgentStatusObservationOrigin
} from '../../shared/agent-status-observation'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  attachClaudeChildOnlyBoundary,
  attachClaudePermissionToolUseId,
  CODEX_SUBAGENT_POLL_MS,
  agentTypeToPromptSentAgentKind,
  INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS,
  invalidateClaudeChildOnlyBoundary,
  isToolProgressWorkingAfterInterrupt,
  shouldKeepClaudePermissionVisible,
  type EnrichedAgentHookEventPayload,
  type AgentPromptSentDedupeEntry,
  type NormalizedLocalHook
} from './agent-hook-payload-sanitize'
import type { AgentHookSource } from '../../shared/agent-hook-relay'

export type AgentHookServerIngestDeps = {
  readonly state: HookListenerState
  readonly env: NodeJS.ProcessEnv
  readonly server: unknown
  connectionTimestampWatermarkById: Map<string, number>
  activeHookTurnCompletedAtByPaneKey: Map<string, number>
  promptSentDedupeByPaneKey: Map<string, AgentPromptSentDedupeEntry>
  promptSentHashSalt: string
  assistantMessageRetryTimers: Map<string, ReturnType<typeof setTimeout>>
  codexSubagentPollTimers: Map<string, ReturnType<typeof setTimeout>>
  onAgentStatus: ((payload: EnrichedAgentHookEventPayload) => void) | null
  enrichedStatusListeners: Set<(payload: EnrichedAgentHookEventPayload) => void>
  runtimeObservedStatusPaneKeys: Set<string>
  scheduleStatusPersist(): void
  notifyStatusChangeListeners(): void
}

export class AgentStatusIngestRegistry {
  private readonly _server: AgentHookServerIngestDeps
  private readonly _observations: AgentStatusObservationSequencer

  constructor(server: AgentHookServerIngestDeps, observations: AgentStatusObservationSequencer) {
    this._server = server
    this._observations = observations
  }

  applyNormalizedStatus(
    payload: AgentHookEventPayload,
    onAccepted?: () => void,
    origin: AgentStatusObservationOrigin = 'hook'
  ): EnrichedAgentHookEventPayload {
    if (payload.hookEventName === 'UserPromptSubmit') {
      this._server.activeHookTurnCompletedAtByPaneKey.delete(payload.paneKey)
    }
    let previous = this._server.state.lastStatusByPaneKey.get(payload.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const connectionClearWatermark = payload.connectionId
      ? this._server.connectionTimestampWatermarkById.get(payload.connectionId)
      : undefined
    const restoredStatusWatermark = previous?.restoredUnconfirmed ? previous.receivedAt : undefined
    const now = Math.max(
      Date.now(),
      (connectionClearWatermark ?? -1) + 1,
      (restoredStatusWatermark ?? -1) + 1
    )
    if (payload.connectionId) {
      this._server.connectionTimestampWatermarkById.set(payload.connectionId, now)
    }
    if (payload.providerSessionOnly) {
      onAccepted?.()
      const enriched = {
        ...this._attachStatusTiming(payload, now),
        observation: this._stampObservation(payload, origin, now)
      }
      this._clearAssistantMessageRetry(enriched.paneKey)
      this._server.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
      this._server.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
      this._server.scheduleStatusPersist()
      this._server.notifyStatusChangeListeners()
      this._emitEnrichedStatus(enriched)
      return enriched
    }
    const stateReconciledPayload =
      payload.connectionId && payload.payload.agentType === 'codex' && payload.hookEventName
        ? {
            ...payload,
            payload: reconcileRemoteCodexState(
              this._server.state,
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
        this._server.state.lastStatusByPaneKey.set(previous.paneKey, previous)
        this._server.scheduleStatusPersist()
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
        markCodexLeadTurnInterrupted(this._server.state, effectivePayload.paneKey)
      }
      return previous
    }
    if (
      effectivePayload.payload.state !== 'done' ||
      effectivePayload.payload.lastAssistantMessage
    ) {
      this._clearAssistantMessageRetry(effectivePayload.paneKey)
    }
    onAccepted?.()
    if (!identity.inheritedFromActivePane) {
      this._maybeTrackAgentPromptSent(effectivePayload, previous)
    }
    const enriched = {
      ...this._attachStatusTiming(boundaryAwarePayload, now),
      observation: this._stampObservation(boundaryAwarePayload, origin, now)
    }
    if (
      typeof enriched.payload.turnCompletedAt === 'number' &&
      Number.isFinite(enriched.payload.turnCompletedAt)
    ) {
      this._server.activeHookTurnCompletedAtByPaneKey.set(
        enriched.paneKey,
        enriched.payload.turnCompletedAt
      )
    }
    if (enriched.restoredUnconfirmed) {
      this._server.runtimeObservedStatusPaneKeys.delete(enriched.paneKey)
    } else {
      this._server.runtimeObservedStatusPaneKeys.add(enriched.paneKey)
    }
    this._server.state.lastStatusByPaneKey.set(enriched.paneKey, enriched)
    this._server.scheduleStatusPersist()
    this._server.notifyStatusChangeListeners()
    this._emitEnrichedStatus(enriched)
    return enriched
  }

  clearAssistantMessageRetry(paneKey: string): void {
    this._clearAssistantMessageRetry(paneKey)
  }

  clearCodexSubagentPoll(paneKey: string): void {
    this._clearCodexSubagentPoll(paneKey)
  }

  scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    this._scheduleCodexSubagentPoll(source, body, original)
  }

  scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt?: number,
    discoveryReady?: boolean
  ): void {
    this._scheduleAssistantMessageRetry(source, body, original, attempt, discoveryReady)
  }

  normalizeLocalHookPayload(source: AgentHookSource, body: unknown): NormalizedLocalHook {
    if (source !== 'claude' || typeof body !== 'object' || body === null) {
      return { event: normalizeHookPayload(this._server.state, source, body, this._server.env) }
    }
    const rawPaneKey = (body as Record<string, unknown>).paneKey
    const paneKey = typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    if (!paneKey) {
      return { event: normalizeHookPayload(this._server.state, source, body, this._server.env) }
    }
    const previousRunningTask = this._server.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const previousActiveCron = this._server.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const event = normalizeHookPayload(this._server.state, source, body, this._server.env)
    const nextRunningTask = this._server.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const nextActiveCron = this._server.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this._setClaudeBackgroundEvidence(paneKey, previousRunningTask, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    return {
      event,
      onAccepted: () => this._setClaudeBackgroundEvidence(paneKey, nextRunningTask, nextActiveCron)
    }
  }

  private _attachStatusTiming(
    payload: AgentHookEventPayload,
    now = Date.now()
  ): EnrichedAgentHookEventPayload {
    const previous = this._server.state.lastStatusByPaneKey.get(payload.paneKey) as
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

  private _stampObservation(
    payload: AgentHookEventPayload,
    origin: AgentStatusObservationOrigin,
    observedAt: number
  ): AgentStatusObservation {
    return this._observations.observe(payload.paneKey, {
      origin,
      observedAt,
      boundary:
        payload.source !== undefined && isNewTurnEvent(payload.source, payload.hookEventName),
      kind: payload.providerSessionOnly
        ? 'identity-only'
        : payload.isReplay === true || origin === 'osc'
          ? 'snapshot'
          : 'transition'
    })
  }

  private _emitEnrichedStatus(enriched: EnrichedAgentHookEventPayload): void {
    this._server.onAgentStatus?.(enriched)
    for (const listener of this._server.enrichedStatusListeners) {
      try {
        listener(enriched)
      } catch (err) {
        console.error('[agent-hooks] enriched status listener threw', err)
      }
    }
  }

  private _clearAssistantMessageRetry(paneKey: string): void {
    const timer = this._server.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this._server.assistantMessageRetryTimers.delete(paneKey)
  }

  private _clearCodexSubagentPoll(paneKey: string): void {
    const timer = this._server.codexSubagentPollTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this._server.codexSubagentPollTimers.delete(paneKey)
  }

  private _scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    if (source !== 'codex') {
      return
    }
    this._clearCodexSubagentPoll(original.paneKey)
    if (!hasCodexTranscriptSubagents(this._server.state, original.paneKey)) {
      return
    }
    const timer = setTimeout(() => {
      this._server.codexSubagentPollTimers.delete(original.paneKey)
      const current = this._server.state.lastStatusByPaneKey.get(original.paneKey)
      if (!this._server.server || current !== original) {
        return
      }
      const normalized = normalizeHookPayload(this._server.state, source, body, this._server.env)
      if (!normalized) {
        return
      }
      const subagentsChanged =
        JSON.stringify(normalized.payload.subagents) !== JSON.stringify(original.payload.subagents)
      const next = subagentsChanged ? this.applyNormalizedStatus(normalized) : original
      this._scheduleCodexSubagentPoll(source, body, next)
    }, CODEX_SUBAGENT_POLL_MS)
    this._server.codexSubagentPollTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private _scheduleAssistantMessageRetry(
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
    this._clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        void discovery
          .then(() => {
            if (this._server.server) {
              this._applyAssistantMessageRetry(source, body, original, 1, true)
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
        this._server.assistantMessageRetryTimers.delete(original.paneKey)
        this._applyAssistantMessageRetry(source, body, original, attempt + 1, discoveryReady)
      } catch (err) {
        console.error('[agent-hooks] assistant message retry failed:', err)
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this._server.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private _applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this._server.state.lastStatusByPaneKey.get(original.paneKey) as
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
      this._scheduleAssistantMessageRetry(source, body, original, nextAttempt, requireExactOriginal)
      return
    }
    this.applyNormalizedStatus(normalized.event, normalized.onAccepted)
  }

  private _maybeTrackAgentPromptSent(
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
    const promptHash = this._hashPromptForTelemetryDedupe(prompt)
    const promptInteractionKey =
      typeof payload.promptInteractionKey === 'string' &&
      payload.promptInteractionKey.trim().length > 0
        ? payload.promptInteractionKey.trim()
        : undefined
    const previousDedupe = this._server.promptSentDedupeByPaneKey.get(payload.paneKey)
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
    this._server.promptSentDedupeByPaneKey.set(payload.paneKey, {
      agentKind,
      promptHash,
      promptInteractionKey
    })
    try {
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

  private _hashPromptForTelemetryDedupe(prompt: string): string {
    return createHash('sha256')
      .update(this._server.promptSentHashSalt)
      .update('\0')
      .update(prompt)
      .digest('hex')
  }

  private _setClaudeBackgroundEvidence(
    paneKey: string,
    hasRunningTask: boolean,
    hasActiveCron: boolean
  ): void {
    if (hasRunningTask) {
      this._server.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    } else {
      this._server.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    }
    if (hasActiveCron) {
      this._server.state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      this._server.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  }
}
