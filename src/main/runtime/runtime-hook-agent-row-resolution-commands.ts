import type {
  AgentStatusIpcPayload,
  AgentStatusEntry,
  AgentProviderSessionMetadata,
  RuntimeAgentRowSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimePtyWorktreeRecord,
  AgentStatusOrchestrationContext,
  OrchestrationDb
} from '../../shared/runtime-types'
import type { RuntimeHookAgentRowResolutionCommandsDeps } from './runtime-hook-agent-row-resolution-commands-deps'

type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  'payload' | 'updatedAt' | 'stateStartedAt' | 'worktreeId'
>

const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000
const FIRST_PANE_ID = 0

export class RuntimeHookAgentRowResolutionCommands {
  constructor(private readonly deps: RuntimeHookAgentRowResolutionCommandsDeps) {}

  resolveHookLiveAgentRow(
    live: HookLiveAgentRow | null,
    pty: RuntimePtyWorktreeRecord | null,
    nonAgentTitle: boolean
  ): HookLiveAgentRow | null {
    if (!live) {
      return null
    }
    if (live.payload.interactivePrompt != null) {
      return live
    }
    return !nonAgentTitle && live.updatedAt >= (pty?.lastOscTitleEpochMs ?? 0) ? live : null
  }

  getHookAgentRowForPane(rows: readonly AgentStatusIpcPayload[]): {
    providerSession: AgentProviderSessionMetadata | null
    providerSessionAgentType: string | null
    providerSessionReceivedAt: number | null
    agentType: string | null
    agentIsLive: boolean
    live: HookLiveAgentRow | null
  } {
    let session: AgentStatusIpcPayload | null = null
    let agent: AgentStatusIpcPayload | null = null
    let live: AgentStatusIpcPayload | null = null
    const agentTypeFreshAfter = Date.now() - AGENT_STATUS_STALE_AFTER_MS
    for (const entry of rows) {
      if (entry.providerSession && (!session || entry.receivedAt > session.receivedAt)) {
        session = entry
      }
      if (
        entry.agentType &&
        (entry.providerSessionOnly !== true ||
          (entry.agentType === 'pi' && entry.providerSession != null)) &&
        entry.receivedAt >= agentTypeFreshAfter &&
        (!agent || entry.receivedAt > agent.receivedAt)
      ) {
        agent = entry
      }
      if (
        entry.providerSessionOnly !== true &&
        entry.restoredUnconfirmed !== true &&
        entry.receivedAt >= agentTypeFreshAfter &&
        (!live || entry.receivedAt > live.receivedAt)
      ) {
        live = entry
      }
    }
    return {
      providerSession: session?.providerSession ?? null,
      providerSessionAgentType: session?.agentType ?? null,
      providerSessionReceivedAt: session?.receivedAt ?? null,
      agentType: agent?.agentType ?? null,
      agentIsLive: agent != null && agent.state !== 'done',
      live: live
        ? {
            payload: this.deps.pickParsedAgentStatusPayload(live),
            updatedAt: live.receivedAt,
            stateStartedAt: live.stateStartedAt ?? live.receivedAt,
            ...(live.worktreeId ? { worktreeId: live.worktreeId } : {})
          }
        : null
    }
  }

  getFreshRetainedAgentStatusForMobileTab(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimeAgentRowSnapshot | null {
    let retained = this.deps.latestAgentStatusByPaneKey.get(paneKey) ?? null
    if (!retained) {
      const ptyId = pty?.ptyId ?? tab.ptyId ?? null
      if (ptyId) {
        for (const snapshot of this.deps.latestAgentStatusByPaneKey.values()) {
          if (snapshot.ptyId !== ptyId) {
            continue
          }
          if (!retained || snapshot.updatedAt > retained.updatedAt) {
            retained = snapshot
          }
        }
      }
    }
    if (!retained || Date.now() - retained.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
      return null
    }
    return retained
  }

  findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    const snapshotPtyId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? null
    const paneKey = this.getMobileTerminalPaneKey(tab)
    if (snapshotPtyId) {
      const pty = this.deps.ptysById.get(snapshotPtyId)
      if (!pty) {
        return null
      }
      if (this.mobileTerminalTabMatchesPty(worktreeId, tab, pty, paneKey)) {
        return pty
      }
      if (
        options.allowWorktreeOnlyMatch === true &&
        pty.worktreeId === worktreeId &&
        pty.tabId === null &&
        pty.paneKey === null
      ) {
        return pty
      }
      return null
    }
    const paneKeys = new Set([`${tab.parentTabId}:${tab.leafId}`])
    if (tab.leafId === `pane:${FIRST_PANE_ID}`) {
      paneKeys.add(`${tab.parentTabId}:${FIRST_PANE_ID}`)
    }
    for (const pty of this.deps.ptysById.values()) {
      if (pty.tabId === tab.parentTabId && pty.paneKey && paneKeys.has(pty.paneKey)) {
        return pty
      }
    }
    return null
  }

  getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    if (this.deps.isTerminalLeafId(tab.leafId)) {
      return this.deps.makePaneKey(tab.parentTabId, tab.leafId)
    }
    const legacyPaneId = /^pane:(\d+)$/.exec(tab.leafId)?.[1] ?? null
    return `${tab.parentTabId}:${legacyPaneId ?? tab.leafId}`
  }

  mobileTerminalTabMatchesPty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    pty: RuntimePtyWorktreeRecord,
    paneKey = this.getMobileTerminalPaneKey(tab)
  ): boolean {
    return pty.worktreeId === worktreeId && pty.tabId === tab.parentTabId && pty.paneKey === paneKey
  }

  getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null {
    const parsed = this.deps.parsePaneKey(paneKey)
    let leafPty: RuntimePtyWorktreeRecord | null = null
    if (parsed) {
      const leaf = this.deps.leaves.get(this.deps.getLeafKey(parsed.tabId, parsed.leafId))
      const pty = leaf?.ptyId ? this.deps.ptysById.get(leaf.ptyId) : undefined
      if (pty?.connected) {
        return pty
      }
      leafPty = pty ?? null
      for (const candidate of this.deps.leaves.values()) {
        if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
          continue
        }
        const remintedPty = this.deps.ptysById.get(candidate.ptyId)
        if (remintedPty?.connected) {
          return remintedPty
        }
        leafPty ??= remintedPty ?? null
      }
    }
    let newestMatch: RuntimePtyWorktreeRecord | null = null
    for (const pty of this.deps.ptysById.values()) {
      const ptyPane = this.deps.parsePaneKey(pty.paneKey ?? '')
      if (pty.paneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
        if (pty.connected) {
          return pty
        }
        newestMatch = pty
      }
    }
    return leafPty ?? newestMatch
  }

  getPaneKeyForTerminalHandle(handle: string): string | null {
    const livePty = this.deps.getLivePtyForHandle(handle)
    if (livePty?.pty.paneKey) {
      return livePty.pty.paneKey
    }
    const record = this.deps.handles.get(handle)
    if (!record || record.runtimeId !== this.deps.runtimeId) {
      return null
    }
    if (!this.deps.isTerminalLeafId(record.leafId)) {
      return null
    }
    return this.deps.makePaneKey(record.tabId, record.leafId)
  }

  getWorktreeIdForTerminalHandle(handle: string): string | null {
    const livePty = this.deps.getLivePtyForHandle(handle)
    if (livePty?.pty.worktreeId) {
      return livePty.pty.worktreeId
    }
    const record = this.deps.handles.get(handle)
    if (!record || record.runtimeId !== this.deps.runtimeId) {
      return null
    }
    return record.worktreeId
  }

  buildAgentOrchestrationByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    return this.deps.orchestrationCommands?.buildAgentOrchestrationByPaneKey()
  }

  getAgentStatusOrchestrationContextForHandle(
    handle: string,
    db?: OrchestrationDb
  ): AgentStatusOrchestrationContext | undefined {
    return this.deps.orchestrationCommands?.getAgentStatusOrchestrationContextForHandle(handle, db)
  }

  getRecentSettledDispatchForTerminal(
    handle: string,
    db?: OrchestrationDb
  ): ReturnType<OrchestrationDb['getLatestDispatchForTerminal']> {
    const dispatch = db?.getLatestDispatchForTerminal?.(handle)
    if (
      !dispatch?.completed_at ||
      dispatch.status === 'pending' ||
      dispatch.status === 'dispatched'
    ) {
      return undefined
    }
    const completedAtMs = Date.parse(
      dispatch.completed_at.includes('T')
        ? dispatch.completed_at
        : `${dispatch.completed_at.replace(' ', 'T')}Z`
    )
    if (!Number.isFinite(completedAtMs)) {
      return undefined
    }
    return Date.now() - completedAtMs <= AGENT_STATUS_STALE_AFTER_MS ? dispatch : undefined
  }

  renewMobileAgentStatusFromPtyTitle(
    status: AgentStatusEntry | null,
    pty: RuntimePtyWorktreeRecord | null,
    options: { preserveQuestionUnderShellTitle?: boolean } = {}
  ): AgentStatusEntry | null {
    if (!status || !pty) {
      return status
    }
    if (
      (status.state === 'waiting' || status.state === 'blocked') &&
      pty.lastAgentStatus === 'idle' &&
      Date.now() - status.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
    ) {
      return status
    }
    if (
      options.preserveQuestionUnderShellTitle &&
      status.interactivePrompt != null &&
      this.deps.terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)
    ) {
      return status
    }
    const richStatusCanOwnTitleInterval =
      pty.lastAgentStatusRichInvalidatedAtEpochMs === null ||
      status.updatedAt > pty.lastAgentStatusRichInvalidatedAtEpochMs
    const titleEvidenceAt = pty.lastOscTitleEpochMs
    if (titleEvidenceAt === null) {
      return richStatusCanOwnTitleInterval ? status : null
    }
    const buildTitleOnlyStatus = (
      state: AgentStatusEntry['state'],
      updatedAt: number,
      stateStartedAt: number
    ): AgentStatusEntry => ({
      state,
      prompt: '',
      updatedAt,
      stateStartedAt,
      paneKey: status.paneKey,
      stateHistory: [],
      ...(status.agentType ? { agentType: status.agentType } : {}),
      ...(status.terminalHandle ? { terminalHandle: status.terminalHandle } : {}),
      ...(status.worktreeId ? { worktreeId: status.worktreeId } : {}),
      ...(status.tabId ? { tabId: status.tabId } : {}),
      ...(status.terminalTitle ? { terminalTitle: status.terminalTitle } : {}),
      ...(status.providerSession ? { providerSession: status.providerSession } : {})
    })
    const titleConfirmsState =
      (pty.lastAgentStatus === 'working' && status.state === 'working') ||
      (pty.lastAgentStatus === 'permission' &&
        (status.state === 'blocked' || status.state === 'waiting'))
    if (!titleConfirmsState) {
      if (richStatusCanOwnTitleInterval && status.updatedAt >= titleEvidenceAt) {
        return status
      }
      if (
        pty.lastAgentStatus === null &&
        !this.deps.terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)
      ) {
        return status
      }
      const titleState =
        pty.lastAgentStatus === 'working'
          ? 'working'
          : pty.lastAgentStatus === 'permission'
            ? 'blocked'
            : 'done'
      return buildTitleOnlyStatus(
        titleState,
        titleEvidenceAt,
        pty.lastAgentStatusStartedAtEpochMs ?? titleEvidenceAt
      )
    }
    const richStatusIsFresh = Date.now() - status.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
    const richStatusOwnsCurrentState = richStatusIsFresh && richStatusCanOwnTitleInterval
    const stateStartedAt = richStatusOwnsCurrentState
      ? status.stateStartedAt
      : (pty.lastAgentStatusStartedAtEpochMs ?? status.stateStartedAt)
    if (richStatusOwnsCurrentState) {
      pty.lastAgentStatusStartedAtEpochMs = stateStartedAt
    }
    const updatedAt = Math.max(status.updatedAt, titleEvidenceAt)
    if (!richStatusOwnsCurrentState) {
      return buildTitleOnlyStatus(status.state, updatedAt, stateStartedAt)
    }
    if (updatedAt === status.updatedAt && stateStartedAt === status.stateStartedAt) {
      return status
    }
    return { ...status, updatedAt, stateStartedAt }
  }

  buildPtyMobileAgentStatus(
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    terminalHandle: string | null,
    retained: RuntimeAgentRowSnapshot | null,
    getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
  ): { agentStatus: AgentStatusEntry } | Record<string, never> {
    const paneKey = this.getMobileTerminalPaneKey(tab)
    const hookRow = this.getHookAgentRowForPane(getHookRowsForPane(paneKey))
    if (!pty?.lastAgentStatus && !retained && !hookRow.agentType && !hookRow.providerSession) {
      return {}
    }
    const providerSession = hookRow.providerSession
      ? { providerSession: hookRow.providerSession }
      : {}
    const leaf = this.deps.leaves.get(this.deps.getLeafKey(tab.parentTabId, tab.leafId)) ?? null
    const trackerOnlyTitle = this.deps.getUnpersistedTrackedTitleForPty(
      pty?.ptyId ?? leaf?.ptyId ?? null
    )
    const ptyTitle = pty
      ? this.deps.getLatestAgentCandidateTitle(
          { title: pty.title, updatedAt: pty.titleUpdatedAt },
          { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
        )
      : leaf
        ? this.deps.getLatestAgentCandidateTitle(
            { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
            { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
          )
        : null
    const ptyTitleClassification = this.deps.classifyAgentTitle(ptyTitle)
    const nonAgentTitle = ptyTitle !== null && ptyTitleClassification !== 'agent'
    if (nonAgentTitle) {
      const hasLiveHookSignal =
        retained?.payload.interactivePrompt != null ||
        retained?.payload.toolName != null ||
        hookRow.live?.payload.interactivePrompt != null ||
        (!pty?.lastAgentStatus && (hookRow.agentType != null || hookRow.providerSession != null))
      if (!hasLiveHookSignal) {
        return {}
      }
    }
    const ownerAgent =
      this.deps.resolvePaneAgentOwner({
        launchAgent: tab.launchAgent ?? pty?.launchAgent ?? null,
        hookAgent: retained?.payload.agentType ?? hookRow.agentType
      }) ??
      pty?.foregroundAgent ??
      null
    const terminalTitle = this.deps.normalizeCompatibleAgentTitleForOwner(
      trackerOnlyTitle ?? (pty ? this.deps.getLatestPtyTitle(pty) : null) ?? tab.title,
      ownerAgent
    )
    const liveRow = retained ?? this.resolveHookLiveAgentRow(hookRow.live, pty, nonAgentTitle)
    if (liveRow) {
      const liveStatus = this.deps.normalizeCompatibleAgentStatusEntryForOwner(
        {
          ...liveRow.payload,
          paneKey,
          updatedAt: liveRow.updatedAt,
          stateStartedAt: liveRow.stateStartedAt,
          stateHistory: [],
          ...(terminalHandle ? { terminalHandle } : {}),
          ...((pty?.worktreeId ?? liveRow.worktreeId)
            ? { worktreeId: pty?.worktreeId ?? liveRow.worktreeId }
            : {}),
          tabId: tab.parentTabId,
          terminalTitle,
          ...providerSession
        },
        ownerAgent
      )
      const renewedStatus = this.renewMobileAgentStatusFromPtyTitle(liveStatus, pty, {
        preserveQuestionUnderShellTitle: true
      })
      if (renewedStatus) {
        return { agentStatus: renewedStatus }
      }
    }
    const evidenceAt = pty?.lastOscTitleEpochMs ?? hookRow.providerSessionReceivedAt ?? Date.now()
    const agentType = ownerAgent ?? undefined
    return {
      agentStatus: {
        state:
          pty?.lastAgentStatus === 'working'
            ? 'working'
            : pty?.lastAgentStatus === 'permission'
              ? 'blocked'
              : 'done',
        prompt: '',
        updatedAt: evidenceAt,
        stateStartedAt: pty?.lastAgentStatusStartedAtEpochMs ?? evidenceAt,
        paneKey,
        ...(terminalHandle ? { terminalHandle } : {}),
        ...(agentType ? { agentType } : {}),
        ...(pty?.worktreeId ? { worktreeId: pty.worktreeId } : {}),
        tabId: tab.parentTabId,
        terminalTitle,
        stateHistory: [],
        ...providerSession
      }
    }
  }
}
