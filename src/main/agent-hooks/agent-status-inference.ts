import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { markCodexLeadTurnInterrupted } from '../../shared/agent-hook-listener/providers/codex-state'
import { isAskUserQuestionTool } from '../../shared/agent-question-answered-intent'
import { isAgentInterruptInputIntent } from '../../shared/agent-interrupt-intent'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../shared/agent-question-answered-intent'
import type { AgentType } from '../../shared/agent-status-types'
import {
  equivalentInterruptAgentType,
  isValidPaneKey,
  type AgentHookStatusChangeEntry,
  type AgentHookProviderSessionIdentity,
  type EnrichedAgentHookEventPayload
} from './agent-hook-payload-sanitize'
import { clearClaudeAnsweredQuestionWait } from '../../shared/agent-hook-listener/providers/claude-roster-state'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-hook-listener/listener-limits'

export type AgentStatusInferenceDeps = {
  readonly state: HookListenerState
  runtimeObservedStatusPaneKeys: Set<string>
  statusChangeListeners: Set<(statuses: AgentHookStatusChangeEntry[]) => void>
  providerSessionChangeListeners: Set<
    (sessions: AgentHookProviderSessionIdentity[]) => void
  >
  inferQuestionAnswered(request: AgentQuestionAnsweredInferenceRequest): boolean
  applyNormalizedStatus(
    payload: {
      paneKey: string
      tabId?: string
      worktreeId?: string
      connectionId?: string | null
      providerSession?: { id: string; transcriptPath?: string }
      payload: EnrichedAgentHookEventPayload['payload']
    },
    onAccepted?: () => void
  ): EnrichedAgentHookEventPayload
}

export class AgentStatusInferenceRegistry {
  private readonly _deps: AgentStatusInferenceDeps

  constructor(deps: AgentStatusInferenceDeps) {
    this._deps = deps
  }

  inferInterrupt(request: AgentInterruptInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    if (!isAgentInterruptInputIntent(request.intent)) {
      return false
    }
    const existing = this._deps.state.lastStatusByPaneKey.get(request.paneKey) as
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
      return this._deps.inferQuestionAnswered(request)
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
      (this._deps.state.claudeRunningNonAgentTaskPaneKeys.has(existing.paneKey) ||
        this._deps.state.claudeActiveSessionCronPaneKeys.has(existing.paneKey))
    ) {
      return false
    }

    // Why: keep the Claude lead-turn record in sync, or a later child event re-emits the stale 'working' state and resurrects the cancelled pane.
    if (agentType === 'claude') {
      markClaudeLeadTurnInterrupted(this._deps.state, existing.paneKey)
    }
    if (agentType === 'codex') {
      markCodexLeadTurnInterrupted(this._deps.state, existing.paneKey)
    }
    const inferred = this._deps.applyNormalizedStatus({
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

  inferQuestionAnswered(request: AgentQuestionAnsweredInferenceRequest): boolean {
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    const existing = this._deps.state.lastStatusByPaneKey.get(request.paneKey) as
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
    const restored = clearClaudeAnsweredQuestionWait(this._deps.state, existing.paneKey)
    const inferred = this._deps.applyNormalizedStatus({
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

  buildStatusChangeNotification(): {
    statuses: AgentHookStatusChangeEntry[]
    providerSessions: AgentHookProviderSessionIdentity[]
  } {
    const statuses: AgentHookStatusChangeEntry[] = []
    const providerSessions: AgentHookProviderSessionIdentity[] = []
    for (const [paneKey, entry] of this._deps.state.lastStatusByPaneKey) {
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
          observedInCurrentRuntime: this._deps.runtimeObservedStatusPaneKeys.has(paneKey)
        })
      }
    }
    return { statuses, providerSessions }
  }

  notifyStatusChangeListeners(): void {
    if (
      this._deps.statusChangeListeners.size === 0 &&
      this._deps.providerSessionChangeListeners.size === 0
    ) {
      return
    }
    const { statuses, providerSessions } = this.buildStatusChangeNotification()
    for (const listener of this._deps.statusChangeListeners) {
      try {
        listener(statuses)
      } catch (err) {
        console.error('[agent-hooks] status-change listener threw', err)
      }
    }
    for (const listener of this._deps.providerSessionChangeListeners) {
      try {
        listener(providerSessions)
      } catch (err) {
        console.error('[agent-hooks] provider-session listener threw', err)
      }
    }
  }
}
