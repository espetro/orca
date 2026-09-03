import {
  clearPaneCacheState,
  paneHasStateClaims,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import { reapRestoredClaudeSubagentsForDeadPane } from '../../shared/agent-hook-listener/providers/claude-roster-state'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots
} from '../../shared/claude-subagent-roster'
import type { AgentStatusClearIpcPayload } from '../../shared/agent-status-types'
import {
  paneCacheKeyMatchesTab,
  type AgentHookAuthorityEvidence,
  type AgentPromptSentDedupeEntry,
  type EnrichedAgentHookEventPayload,
  type PaneKeyAliasEntry
} from './agent-hook-payload-sanitize'

export type AgentStatusCleanupDeps = {
  readonly state: HookListenerState
  runtimeObservedStatusPaneKeys: Set<string>
  persistedAuthorityCommitmentsByPaneKey: Map<string, AgentHookAuthorityEvidence>
  hydratedLaunchTokenHashByPaneKey: Map<string, string>
  connectionTimestampWatermarkById: Map<string, number>
  currentAuthorityObservations: Map<string, AgentHookAuthorityEvidence>
  hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[]
  legacyPaneKeyAliases: Map<string, PaneKeyAliasEntry>
  activeHookTurnCompletedAtByPaneKey: Map<string, number>
  promptSentDedupeByPaneKey: Map<string, AgentPromptSentDedupeEntry>
  restartedStatusLaunchTokenHashByPaneKey: Map<string, string>
  resolvePaneKeyAlias(paneKey: string): string
  clearAssistantMessageRetry(paneKey: string): void
  clearCodexSubagentPoll(paneKey: string): void
  markTabClosedForAgentStatus(tabId: string): void
  markPaneClosedForAgentStatus(paneKey: string): void
  notifyPaneKeyAliasPersistenceListener(): void
  revokeHydratedAuthorityForPaneKeys(paneKeys: Set<string>): boolean
  scheduleStatusPersist(): void
  notifyStatusChangeListeners(): void
  emitPaneStatusCleared(clear: AgentStatusClearIpcPayload): void
}

export class AgentStatusCleanupRegistry {
  private readonly _deps: AgentStatusCleanupDeps

  constructor(deps: AgentStatusCleanupDeps) {
    this._deps = deps
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
      this._deps.state.lastStatusByPaneKey.set(deleted.paneKey, retained)
    }
    this._deps.scheduleStatusPersist()
    this._deps.notifyStatusChangeListeners()
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
      const resolvedPaneKey = this._deps.resolvePaneKeyAlias(paneKey)
      if (!this.hasLiveClaimsForPaneKey(resolvedPaneKey)) {
        continue
      }
      const retained = options?.preserveResumeIdentity
        ? this.toRetainedProviderSessionRow(
            this._deps.state.lastStatusByPaneKey.get(resolvedPaneKey) as
              | EnrichedAgentHookEventPayload
              | undefined
          )
        : null
      this.clearPaneState(resolvedPaneKey)
      if (retained) {
        this._deps.state.lastStatusByPaneKey.set(resolvedPaneKey, retained)
        this._deps.scheduleStatusPersist()
        this._deps.notifyStatusChangeListeners()
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
    return paneHasStateClaims(this._deps.state, paneKey)
  }

  /** Clear statuses proven to belong to one lost SSH transport. */
  clearStatusEntriesForConnection(connectionId: string): void {
    const normalizedConnectionId = connectionId.trim()
    if (normalizedConnectionId.length === 0) {
      return
    }
    const clearedAt = Math.max(
      Date.now(),
      (this._deps.connectionTimestampWatermarkById.get(normalizedConnectionId) ?? -1) + 1
    )
    this._deps.connectionTimestampWatermarkById.set(normalizedConnectionId, clearedAt)
    let statusChanged = false
    for (const [paneKey, rawEntry] of this._deps.state.lastStatusByPaneKey) {
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
          this._deps.state.codexSubagentRosterByPaneKey.delete(paneKey)
          this._deps.state.codexLeadStateByPaneKey.delete(paneKey)
        } else if (deleted.payload.agentType === 'claude') {
          this._deps.state.claudeSubagentRosterByPaneKey.delete(paneKey)
          this._deps.state.claudeLeadStateByPaneKey.delete(paneKey)
          this._deps.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
          this._deps.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
          this._deps.state.claudeSessionOwnerByPaneKey.delete(paneKey)
        }
      }
    }
    for (const [paneKey, evidence] of this._deps.currentAuthorityObservations) {
      if (evidence.connectionId === normalizedConnectionId) {
        this._deps.currentAuthorityObservations.delete(paneKey)
      }
    }
    if (statusChanged) {
      // Why: persist/notify once — one disconnect can own many panes.
      this._deps.scheduleStatusPersist()
      this._deps.notifyStatusChangeListeners()
    }
    // Why: always send the cutoff even with no matched entry — another host may have overwritten this pane's row.
    this._deps.emitPaneStatusCleared({
      transient: true,
      connectionId: normalizedConnectionId,
      clearedAt
    })
  }

  private deleteStatusEntry(
    paneKey: string,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null {
    const resolvedPaneKey = this._deps.resolvePaneKeyAlias(paneKey)
    const existing = this._deps.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return null
    }
    this._deps.state.lastStatusByPaneKey.delete(resolvedPaneKey)
    this._deps.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    if (!options?.preserveAuthority) {
      this._deps.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
      this._deps.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
    }
    this._deps.clearAssistantMessageRetry(resolvedPaneKey)
    this._deps.clearCodexSubagentPoll(resolvedPaneKey)
    this._deps.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
    this._deps.currentAuthorityObservations.delete(resolvedPaneKey)
    if (existing.payload.state === 'done') {
      this._deps.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    }
    return existing
  }

  dropStatusEntriesByTabPrefix(tabId: string): void {
    this._deps.markTabClosedForAgentStatus(tabId)
    const paneKeysToClear = new Set<string>()
    for (const key of this._deps.state.lastStatusByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
      }
    }
    for (const key of this._deps.state.lastPromptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this._deps.state.lastToolByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this._deps.state.antigravityCompletedTranscriptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this._deps.state.ampCompletedCacheKeys) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const paneKey of this._deps.runtimeObservedStatusPaneKeys) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const paneKey of this._deps.promptSentDedupeByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const commitment of this._deps.hydratedAuthorityCommitments) {
      if (paneCacheKeyMatchesTab(commitment.paneKey, tabId)) {
        paneKeysToClear.add(commitment.paneKey)
      }
    }

    let aliasChanged = false
    for (const [legacyPaneKey, entry] of this._deps.legacyPaneKeyAliases) {
      const ownerMatches = paneCacheKeyMatchesTab(entry.stablePaneKey, tabId)
      if (ownerMatches) {
        this._deps.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeysToClear.add(legacyPaneKey)
        paneKeysToClear.add(entry.stablePaneKey)
        this._deps.markPaneClosedForAgentStatus(legacyPaneKey)
        this._deps.markPaneClosedForAgentStatus(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    const authorityChanged = this._deps.revokeHydratedAuthorityForPaneKeys(paneKeysToClear)

    let statusChanged = false
    for (const paneKey of paneKeysToClear) {
      if (this._deps.state.lastStatusByPaneKey.has(paneKey)) {
        statusChanged = true
      }
      this._deps.clearAssistantMessageRetry(paneKey)
      this._deps.clearCodexSubagentPoll(paneKey)
      clearPaneCacheState(this._deps.state, paneKey)
      this._deps.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
      this._deps.runtimeObservedStatusPaneKeys.delete(paneKey)
      this._deps.currentAuthorityObservations.delete(paneKey)
      this._deps.promptSentDedupeByPaneKey.delete(paneKey)
      this._deps.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
    }
    if (aliasChanged) {
      this._deps.notifyPaneKeyAliasPersistenceListener()
    }
    if (statusChanged || authorityChanged) {
      this._deps.scheduleStatusPersist()
      this._deps.notifyStatusChangeListeners()
    }
  }

  clearPaneState(paneKey: string): void {
    const resolvedPaneKey = this._deps.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const hadStatus = this._deps.state.lastStatusByPaneKey.has(resolvedPaneKey)
    this._deps.clearAssistantMessageRetry(resolvedPaneKey)
    this._deps.clearCodexSubagentPoll(resolvedPaneKey)
    clearPaneCacheState(this._deps.state, resolvedPaneKey)
    this._deps.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    this._deps.currentAuthorityObservations.delete(resolvedPaneKey)
    this._deps.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    this._deps.restartedStatusLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
    let clearedAlias = false
    for (const [legacyPaneKey, stablePaneKey] of this._deps.legacyPaneKeyAliases) {
      if (stablePaneKey.stablePaneKey === resolvedPaneKey) {
        this._deps.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeys.add(legacyPaneKey)
        paneKeys.add(stablePaneKey.stablePaneKey)
        clearPaneCacheState(this._deps.state, legacyPaneKey)
        this._deps.activeHookTurnCompletedAtByPaneKey.delete(legacyPaneKey)
        this._deps.currentAuthorityObservations.delete(legacyPaneKey)
        this._deps.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        this._deps.restartedStatusLaunchTokenHashByPaneKey.delete(legacyPaneKey)
        clearedAlias = true
      }
    }
    const authorityChanged = this._deps.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this._deps.notifyPaneKeyAliasPersistenceListener()
    }
    if (hadStatus || authorityChanged) {
      this._deps.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this._deps.scheduleStatusPersist()
      this._deps.notifyStatusChangeListeners()
      this._deps.emitPaneStatusCleared({ paneKey: resolvedPaneKey })
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
    for (const [paneKey, entry] of this._deps.state.lastStatusByPaneKey) {
      const enriched = entry as EnrichedAgentHookEventPayload
      if (
        enriched.payload.agentType === 'claude' &&
        enriched.connectionId === null &&
        isLocalExecutionHost(enriched.worktreeId) &&
        // Why: a restored roster is only one shape of stranded claim. A lead row left non-terminal,
        // or a background-task/cron latch nothing will refresh, strands the pane just as
        // permanently — and unlike the roster case there is no child event left to reap it.
        (claudeRosterHasRestoredSnapshotSubagent(
          this._deps.state.claudeSubagentRosterByPaneKey.get(paneKey)
        ) ||
          enriched.payload.state !== 'done' ||
          this._deps.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
          this._deps.state.claudeActiveSessionCronPaneKeys.has(paneKey)) &&
        !this._deps.runtimeObservedStatusPaneKeys.has(paneKey)
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
        this._deps.state.lastStatusByPaneKey.get(paneKey) !== enriched ||
        this._deps.runtimeObservedStatusPaneKeys.has(paneKey) ||
        !isLocalExecutionHost(enriched.worktreeId)
      ) {
        continue
      }
      if (!reapRestoredClaudeSubagentsForDeadPane(this._deps.state, paneKey)) {
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
      const roster = this._deps.state.claudeSubagentRosterByPaneKey.get(paneKey)
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
      this._deps.state.lastStatusByPaneKey.set(paneKey, reconciled)
    }
    if (changedPanes > 0) {
      this._deps.scheduleStatusPersist()
      this._deps.notifyStatusChangeListeners()
    }
    return changedPanes
  }
}
