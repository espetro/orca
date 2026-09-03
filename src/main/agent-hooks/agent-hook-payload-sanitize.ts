// Pure payload sanitation/enrichment helpers extracted from agent-hooks/server.ts (no server state).
import { createHash } from 'node:crypto'

import { track } from '../telemetry/client'
import { AGENT_KIND_VALUES, type AgentKind } from '../../shared/telemetry-events'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { LegacyPaneKeyAliasEntry } from '../../shared/persisted-state-types'
import {
  type AgentStatusClearIpcPayload,
  type AgentStatusIpcPayload,
  type AgentType,
  type AgentStatusState,
  type ParsedAgentStatusPayload,
  normalizeAgentStatusPayload
} from '../../shared/agent-status-types'
import type { AgentStatusObservation } from '../../shared/agent-status-observation'
import {
  MAX_PANE_KEY_LEN,
  normalizeClaudePromptId
} from '../../shared/agent-hook-listener/listener-limits'
import {
  getAgentResumeArgv,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../shared/agent-session-resume'
import { isAgentHookSource } from '../../shared/agent-hook-relay'
import { isAskUserQuestionTool } from '../../shared/agent-question-answered-intent'
import { claudeTeammateIdMatchesName } from '../../shared/claude-subagent-roster'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'

export type EnrichedAgentHookEventPayload = AgentHookEventPayload & {
  receivedAt: number
  stateStartedAt: number
  /** Provenance/ordering stamped by this server as the pane authority (STA-4293). Read by nothing yet. */
  observation?: AgentStatusObservation
  /** Stamped at hydrate for nonterminal states; never persisted (hydrate re-stamps) and cleared by any accepted live event replacing the entry. */
  restoredUnconfirmed?: true
  /** User-hidden resume identity retained solely for destructive liveness checks. */
  retainedForLiveness?: true
  /** Persisted proof that a lead boundary was held working only by child agents. */
  claudeLeadBoundaryChildOnly?: true
}

export type NormalizedLocalHook = {
  event: AgentHookEventPayload | null
  onAccepted?: () => void
}

export type PersistedAgentHookEventPayload = Omit<
  EnrichedAgentHookEventPayload,
  | 'claudeRunningNonAgentTask'
  | 'launchToken'
  | 'promptInteractionKey'
  | 'restoredUnconfirmed'
  // Why: revision counters are in-memory and the authority id is regenerated per process, so
  // a stored observation could only rehydrate as a stale ordering claim from a dead authority.
  | 'observation'
> & {
  launchTokenHash?: string
}

export type PersistedAgentHookAuthorityCommitment = {
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}

export type AgentHookStatusChangeEntry = {
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

export type AgentHookProviderSessionIdentity = {
  paneKey: string
  sessionId: string
  transcriptPath?: string
  worktreeId?: string
}

export type AgentHookAuthorityEvidence = Readonly<{
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}>

export type AgentHookAuthorityAttestation = Readonly<{
  paneKey: string
  source: 'current_hook' | 'hydrated_commitment'
}>

export type StatusChangeListener = (statuses: AgentHookStatusChangeEntry[]) => void
export type ProviderSessionChangeListener = (
  providerSessions: AgentHookProviderSessionIdentity[]
) => void
export type PaneStatusClearListener = (clear: AgentStatusClearIpcPayload) => void
export type PaneKeyAliasPersistenceListener = (entries: LegacyPaneKeyAliasEntry[]) => void
export type PaneKeyAliasEntry = {
  stablePaneKey: string
  ptyId: string | null
  updatedAt: number
  authorityVerified: boolean
}
export type RetiredPaneAlias = { physicalPaneKey: string; entry: PaneKeyAliasEntry }
/** What one retirement fenced, so a re-attach can lift exactly that set and no more. */
export type RetiredPaneFence = {
  paneKeys: readonly string[]
  aliases: readonly RetiredPaneAlias[]
}

// Why: co-located with the endpoint file in userData/agent-hooks/ so hook-server cross-restart artifacts stay together.
export const LAST_STATUS_FILE_NAME = 'last-status.json'
export const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
export const ASSISTANT_MESSAGE_RETRY_MS = 50
export const CODEX_SUBAGENT_POLL_MS = 1_000
export const INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS = 15_000

// Why: starts at 2 — pre-merge v1 lacked receivedAt/stateStartedAt (never shipped); a mismatched version hydrates empty (treated as corrupt).
export const LAST_STATUS_FILE_VERSION = 2

// Why: trailing-edge debounce so a burst of hook events yields one disk write, not N; quit-time flushStatusPersistSync() guarantees the final flush.
export const STATUS_PERSIST_DEBOUNCE_MS = 250
export const TOOL_PROGRESS_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure'
])
export const AGENT_PROMPT_SENT_AGENT_KINDS = new Set<AgentKind>(AGENT_KIND_VALUES)

// Why: bound file growth from PTYs that never re-attach; 7 days is the "still relevant?" horizon beyond which entries shouldn't resurrect on hydrate.
export const HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Why: a long-closed tab can't receive status events; bound the set so it can't grow one entry per close for the whole session.
export const CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const CLOSED_AGENT_STATUS_PANE_KEYS_MAX = 1024
export const PANE_KEY_ALIASES_MAX = 1024
export const RETIRED_PANE_FENCES_MAX = 1024

export type LastStatusFile = {
  version: number
  entries: Record<string, PersistedAgentHookEventPayload>
  authorityCommitments?: Record<string, PersistedAgentHookAuthorityCommitment>
}

export type AgentPromptSentDedupeEntry = {
  agentKind: AgentKind
  promptHash: string
  promptInteractionKey?: string
}

export function agentTypeToPromptSentAgentKind(agentType: AgentType | undefined): AgentKind {
  const normalized = agentType?.trim().toLowerCase()
  if (!normalized || normalized === 'unknown') {
    return 'other'
  }
  if (normalized === 'claude') {
    return 'claude-code'
  }
  return AGENT_PROMPT_SENT_AGENT_KINDS.has(normalized as AgentKind)
    ? (normalized as AgentKind)
    : 'other'
}

export function equivalentInterruptAgentType(
  actual: AgentType | undefined,
  baseline: AgentType | undefined
): boolean {
  const normalizedActual = actual === 'unknown' ? undefined : actual
  const normalizedBaseline = baseline === 'unknown' ? undefined : baseline
  return normalizedActual === normalizedBaseline
}

// Why: validate the durable `${tabId}:${leafUuid}` leaf suffix at write/hydrate so legacy numeric rows fail closed.
export function isValidPaneKey(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_PANE_KEY_LEN && parsePaneKey(value) !== null
  )
}

export function dropHydratedIdleClaudeSubagents(
  payload: ParsedAgentStatusPayload
): ParsedAgentStatusPayload {
  if (
    payload.agentType !== 'claude' ||
    !payload.subagents?.some((subagent) => subagent.state === 'idle')
  ) {
    return payload
  }
  const activeSubagents = payload.subagents.filter((subagent) => subagent.state !== 'idle')
  // Why: an idle teammate's liveness can't be proven across a restart (its TeammateIdle confirmation is in-memory); prune so a dead pile can't resurrect — a live teammate re-earns its row via SubagentStart.
  return {
    ...payload,
    subagents: activeSubagents.length > 0 ? activeSubagents : undefined
  }
}

// Why: remote metadata-only rows are currently a Pi contract; user-dismissed rows use an internal persisted marker instead.
export function isValidPiProviderSessionOnly(
  providerSession: AgentProviderSessionMetadata | undefined,
  agentType: AgentType | undefined
): boolean {
  return Boolean(providerSession && agentType === 'pi' && getAgentResumeArgv('pi', providerSession))
}

export function sanitizeHydratedEntry(
  paneKey: string,
  rawEntry: unknown
): EnrichedAgentHookEventPayload | null {
  const parsedPaneKey = parsePaneKey(paneKey)
  if (!parsedPaneKey) {
    return null
  }
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const record = rawEntry as Record<string, unknown>
  if (record.paneKey !== paneKey) {
    return null
  }
  const tabId = record.tabId
  if (tabId !== undefined && (typeof tabId !== 'string' || tabId.length === 0)) {
    return null
  }
  // Why: a stored tabId that diverges from the paneKey's tab segment is corruption; drop instead of hydrating an inconsistent row.
  if (typeof tabId === 'string' && tabId !== parsedPaneKey.tabId) {
    return null
  }
  const worktreeId = record.worktreeId
  if (worktreeId !== undefined && (typeof worktreeId !== 'string' || worktreeId.length === 0)) {
    return null
  }
  const receivedAt = record.receivedAt
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) {
    return null
  }
  const stateStartedAt = record.stateStartedAt
  if (
    typeof stateStartedAt !== 'number' ||
    !Number.isFinite(stateStartedAt) ||
    stateStartedAt <= 0
  ) {
    return null
  }
  // Why: connectionId is null (local) or string (relay); any other shape is rejected to keep the typed surface honest.
  const connectionIdRaw = record.connectionId
  let connectionId: string | null
  if (connectionIdRaw === null || connectionIdRaw === undefined) {
    connectionId = null
  } else if (typeof connectionIdRaw === 'string') {
    connectionId = connectionIdRaw
  } else {
    return null
  }
  const payload = normalizeAgentStatusPayload(record.payload)
  if (!payload) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(record.providerSession) ?? undefined
  const providerSessionOnly = record.providerSessionOnly === true
  const retainedForLiveness = record.retainedForLiveness === true
  const validRetainedIdentity = Boolean(
    retainedForLiveness && providerSession && payload.agentType && payload.agentType !== 'unknown'
  )
  if (
    providerSessionOnly &&
    !isValidPiProviderSessionOnly(providerSession, payload.agentType) &&
    !validRetainedIdentity
  ) {
    return null
  }
  const source = isAgentHookSource(record.source) ? record.source : undefined
  const providerPromptId =
    source === 'claude' ? normalizeClaudePromptId(record.providerPromptId) : undefined
  const compactTrigger =
    source === 'claude' && (record.compactTrigger === 'manual' || record.compactTrigger === 'auto')
      ? record.compactTrigger
      : undefined
  return {
    paneKey,
    source,
    tabId: typeof tabId === 'string' ? tabId : undefined,
    worktreeId: typeof worktreeId === 'string' ? worktreeId : undefined,
    connectionId,
    hasExplicitPrompt: record.hasExplicitPrompt === true ? true : undefined,
    hookEventName: typeof record.hookEventName === 'string' ? record.hookEventName : undefined,
    providerPromptId,
    compactTrigger,
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : undefined,
    toolAgentId: typeof record.toolAgentId === 'string' ? record.toolAgentId : undefined,
    teammateName: typeof record.teammateName === 'string' ? record.teammateName : undefined,
    toolAgentType: typeof record.toolAgentType === 'string' ? record.toolAgentType : undefined,
    claudeLeadBoundaryChildOnly: record.claudeLeadBoundaryChildOnly === true ? true : undefined,
    providerSession,
    providerSessionOnly: providerSessionOnly ? true : undefined,
    retainedForLiveness: retainedForLiveness ? true : undefined,
    payload,
    receivedAt,
    stateStartedAt
  }
}

export function readPersistedLaunchTokenHash(rawEntry: unknown): string | null {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const record = rawEntry as Record<string, unknown>
  const launchTokenHash =
    typeof record.launchTokenHash === 'string' ? record.launchTokenHash.trim() : ''
  if (/^[a-f0-9]{64}$/.test(launchTokenHash)) {
    return launchTokenHash
  }
  const legacyLaunchToken = typeof record.launchToken === 'string' ? record.launchToken.trim() : ''
  return legacyLaunchToken ? createHash('sha256').update(legacyLaunchToken).digest('hex') : null
}

export function sanitizePersistedAuthorityCommitment(
  paneKey: string,
  value: unknown
): AgentHookAuthorityEvidence | null {
  if (!isValidPaneKey(paneKey) || typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const launchTokenHash =
    typeof record.launchTokenHash === 'string' ? record.launchTokenHash.trim() : ''
  const connectionId = record.connectionId
  const observedAt = record.observedAt
  if (
    !/^[a-f0-9]{64}$/.test(launchTokenHash) ||
    (connectionId !== null && typeof connectionId !== 'string') ||
    typeof observedAt !== 'number' ||
    !Number.isFinite(observedAt)
  ) {
    return null
  }
  return Object.freeze({
    paneKey,
    launchTokenHash,
    connectionId,
    ...(typeof record.tabId === 'string' ? { tabId: record.tabId } : {}),
    ...(typeof record.worktreeId === 'string' ? { worktreeId: record.worktreeId } : {}),
    observedAt
  })
}

export function authorityCommitmentsMatch(
  left: AgentHookAuthorityEvidence,
  right: AgentHookAuthorityEvidence
): boolean {
  return (
    left.paneKey === right.paneKey &&
    left.launchTokenHash === right.launchTokenHash &&
    left.connectionId === right.connectionId &&
    left.tabId === right.tabId &&
    left.worktreeId === right.worktreeId
  )
}

export function toAgentStatusIpcPayload(
  entry: EnrichedAgentHookEventPayload
): AgentStatusIpcPayload {
  return {
    paneKey: entry.paneKey,
    ...(entry.launchToken ? { launchToken: entry.launchToken } : {}),
    tabId: entry.tabId,
    worktreeId: entry.worktreeId,
    connectionId: entry.connectionId,
    receivedAt: entry.receivedAt,
    stateStartedAt: entry.stateStartedAt,
    ...(entry.providerSession ? { providerSession: entry.providerSession } : {}),
    ...(entry.providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...(entry.promptInteractionKey ? { promptInteractionKey: entry.promptInteractionKey } : {}),
    ...(entry.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    ...(entry.observation ? { observation: entry.observation } : {}),
    ...entry.payload
  }
}

export function trackEmptyPaneKeyHook(body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    return
  }
  const paneKey = (body as Record<string, unknown>).paneKey
  if (typeof paneKey === 'string' && paneKey.trim().length > 0) {
    return
  }
  track('agent_hook_unattributed', { reason: 'empty_pane_key' })
}

export function isToolProgressWorkingAfterInterrupt(next: AgentHookEventPayload): boolean {
  if (next.payload.state !== 'working') {
    return false
  }
  if (next.payload.agentType !== 'claude' && next.payload.agentType !== 'codex') {
    return false
  }
  // Why: a same-prompt retry is another UserPromptSubmit, while late post-Ctrl+C progress arrives as tool lifecycle work.
  return next.hookEventName !== undefined && TOOL_PROGRESS_HOOK_EVENTS.has(next.hookEventName)
}

export function paneCacheKeyTabId(key: string): string | null {
  const paneKey = key.split('\0', 1)[0] ?? key
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

export function paneCacheKeyMatchesTab(key: string, tabId: string): boolean {
  return paneCacheKeyTabId(key) === tabId
}

export function attachClaudeChildOnlyBoundary(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): AgentHookEventPayload & { claudeLeadBoundaryChildOnly?: true } {
  const establishesBoundary =
    next.payload.agentType === 'claude' &&
    (next.hookEventName === 'Stop' || next.hookEventName === 'StopFailure') &&
    !next.toolAgentId &&
    next.payload.state === 'working' &&
    next.payload.subagents?.some((subagent) => subagent.state === 'working') === true &&
    next.claudeRunningNonAgentTask === false
  const carriesBoundary =
    previous?.claudeLeadBoundaryChildOnly === true &&
    next.payload.agentType === 'claude' &&
    next.claudeRunningNonAgentTask === false &&
    (next.toolAgentId !== undefined ||
      next.hookEventName === 'SubagentStart' ||
      next.hookEventName === 'SubagentStop' ||
      next.hookEventName === 'TeammateIdle')
  return establishesBoundary || carriesBoundary
    ? { ...next, claudeLeadBoundaryChildOnly: true }
    : next
}

export function invalidateClaudeChildOnlyBoundary(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): EnrichedAgentHookEventPayload | undefined {
  if (
    previous?.claudeLeadBoundaryChildOnly !== true ||
    attachClaudeChildOnlyBoundary(previous, next).claudeLeadBoundaryChildOnly === true
  ) {
    return previous
  }
  const { claudeLeadBoundaryChildOnly: _boundary, ...withoutBoundary } = previous
  return withoutBoundary
}

export function shouldKeepClaudePermissionVisible(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (previous?.restoredUnconfirmed) {
    return false
  }
  if (
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'waiting' ||
    previous.hookEventName !== 'PermissionRequest' ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'working'
  ) {
    return false
  }
  if (next.hasExplicitPrompt === true) {
    return false
  }
  if (isClaudePermissionOwningChildEnding(previous, next)) {
    return false
  }
  if (isClaudePermissionResumingApprovedTool(previous, next)) {
    return false
  }
  // Why: only real permission requests stay sticky; newer Claude reports AskUserQuestion as a PermissionRequest, so tool name (not event) decides.
  if (isAskUserQuestionTool(previous.payload.toolName)) {
    return false
  }
  return true
}

export function isClaudePermissionOwningChildEnding(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const ownerId = previous.toolAgentId?.trim()
  if (!ownerId) {
    return false
  }
  if (next.hookEventName === 'SubagentStop') {
    return ownerId === next.toolAgentId?.trim()
  }
  return (
    next.hookEventName === 'TeammateIdle' &&
    next.teammateName !== undefined &&
    claudeTeammateIdMatchesName(ownerId, next.teammateName)
  )
}

export function isClaudePermissionResumingApprovedTool(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const previousToolUseId = previous.toolUseId?.trim() || undefined
  const nextToolUseId = next.toolUseId?.trim() || undefined
  const previousAgentId = previous.toolAgentId?.trim() || undefined
  const nextAgentId = next.toolAgentId?.trim() || undefined
  const hasAgentId = previousAgentId !== undefined || nextAgentId !== undefined
  const previousAgentType = previous.toolAgentType?.trim() || undefined
  const nextAgentType = next.toolAgentType?.trim() || undefined
  const hasMatchingConcreteAgentId =
    previousAgentId !== undefined && previousAgentId === nextAgentId
  const hasSameExplicitAgentType =
    !hasAgentId && previousAgentType !== undefined && previousAgentType === nextAgentType
  const sameToolName =
    previous.payload.toolName !== undefined && previous.payload.toolName === next.payload.toolName
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownInputFromConcreteAgent =
    hasMatchingConcreteAgentId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined
  const hasMatchingToolUseId =
    previousToolUseId !== undefined && previousToolUseId === nextToolUseId
  const hasConflictingToolUseId =
    previousToolUseId !== undefined &&
    nextToolUseId !== undefined &&
    previousToolUseId !== nextToolUseId
  const sameUnknownInputFromToolUseId =
    hasMatchingToolUseId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined

  return (
    (next.hookEventName === 'PreToolUse' || next.hookEventName === 'PostToolUse') &&
    nextToolUseId !== undefined &&
    !hasConflictingToolUseId &&
    // Why: subagents share agent_type, so a concrete agent id (or the preserved PostToolUse tool_use_id) is the safest resume signal.
    (hasMatchingConcreteAgentId || hasSameExplicitAgentType || hasMatchingToolUseId) &&
    sameToolName &&
    (sameKnownToolInput || sameUnknownInputFromConcreteAgent || sameUnknownInputFromToolUseId)
  )
}

export function shouldInheritClaudeToolUseIdForPermission(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (
    previous?.restoredUnconfirmed ||
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'working' ||
    previous.hookEventName !== 'PreToolUse' ||
    typeof previous.toolUseId !== 'string' ||
    previous.toolUseId.trim().length === 0 ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'waiting' ||
    next.hookEventName !== 'PermissionRequest' ||
    next.toolUseId !== undefined
  ) {
    return false
  }
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownToolInput =
    previous.payload.toolInput === undefined && next.payload.toolInput === undefined
  if (
    previous.toolAgentId !== next.toolAgentId ||
    previous.toolAgentType !== next.toolAgentType ||
    previous.payload.toolName === undefined ||
    previous.payload.toolName !== next.payload.toolName ||
    (!sameKnownToolInput && !sameUnknownToolInput)
  ) {
    return false
  }
  return true
}

export function attachClaudePermissionToolUseId(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): AgentHookEventPayload {
  const inheritedToolUseId = previous?.toolUseId
  if (
    !shouldInheritClaudeToolUseIdForPermission(previous, next) ||
    typeof inheritedToolUseId !== 'string'
  ) {
    return next
  }
  return {
    ...next,
    // Why: Claude emits PermissionRequest without tool_use_id, then PostToolUse carries the original PreToolUse id.
    toolUseId: inheritedToolUseId
  }
}
