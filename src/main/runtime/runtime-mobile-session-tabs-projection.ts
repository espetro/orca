// Snapshot-to-client projection: tab identity keys, group sanitization, terminal tab projection.
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import {
  getLatestAgentCandidateTitle,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-tail-projection'
import { indexAgentStatusRowsByPaneKey } from '../agent-hooks/agent-status-pane-index'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../shared/pane-agent-owner'
import type { RuntimeMobileSessionFacadeCtx } from './runtime-mobile-session-facade-ctx'
export function getMobileSessionSnapshotTabIdentityKeys(
  tab: RuntimeMobileSessionSnapshotTab
): string[] {
  if (tab.type === 'terminal') {
    // Why: split terminal leaves share one parent tab; merge dedup must stay
    // leaf-scoped or preserved siblings collapse into a single surface.
    const keys = [tab.id, `${tab.parentTabId}::${tab.leafId}`]
    if (typeof tab.ptyId === 'string' && tab.ptyId.length > 0) {
      // Why: renderer and headless sources can derive different leafIds for the same
      // terminal; real PTYs collapse those duplicates without merging pending splits.
      keys.push(`${tab.parentTabId}::pty:${tab.ptyId}`)
    }
    return keys
  }
  if (tab.type === 'browser') {
    return [tab.id, tab.browserWorkspaceId]
  }
  return [tab.id]
}

export function sanitizeMobileSessionTabGroups(
  ctx: RuntimeMobileSessionFacadeCtx,
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  returnedTabs: readonly RuntimeMobileSessionClientTab[]
): RuntimeMobileSessionTabGroup[] | undefined {
  if (!groups || groups.length === 0) {
    return undefined
  }
  const returnedIds = ctx.deps.collectReturnedSessionTabIds(returnedTabs)
  const sanitized = groups
    .map((group): RuntimeMobileSessionTabGroup | null => {
      const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
      if (tabOrder.length === 0) {
        return null
      }
      const activeTabId =
        group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
      return {
        id: group.id,
        activeTabId,
        tabOrder,
        ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
      }
    })
    .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
  return sanitized.length > 0 ? sanitized : undefined
}

export function pruneMobileSessionTabGroupLayout(
  ctx: RuntimeMobileSessionFacadeCtx,
  layout: TabGroupLayoutNode | null | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneMobileSessionTabGroupLayout(ctx, layout.first, validGroupIds)
  const second = pruneMobileSessionTabGroupLayout(ctx, layout.second, validGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

export function toMobileSessionTabsResult(
  ctx: RuntimeMobileSessionFacadeCtx,
  snapshot: RuntimeMobileSessionTabsSnapshot
): RuntimeMobileSessionTabsResult {
  const tabs: RuntimeMobileSessionClientTab[] = []
  const liveBrowserTabsByPageId = ctx.deps.getLiveBrowserTabsByPageId(snapshot.worktree)
  // Production reads hook rows by pane; the snapshot fallback remains for tests
  // and embedders that have not adopted the narrow getter.
  let hookRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  const hookRowsForPane = new Map<string, AgentStatusIpcPayload[]>()
  const getHookRowsForPane = (paneKey: string): AgentStatusIpcPayload[] => {
    const cached = hookRowsForPane.get(paneKey)
    if (cached) {
      return cached
    }
    const direct = ctx.deps.getAgentProviderSessionRowsForPaneFn()?.(paneKey)
    if (direct) {
      hookRowsForPane.set(paneKey, direct)
      return direct
    }
    hookRowsByPaneKey ??= indexAgentStatusRowsByPaneKey(
      ctx.deps.getAgentProviderSessionSnapshotFn()?.() ?? []
    )
    const rows = hookRowsByPaneKey.get(paneKey) ?? []
    hookRowsForPane.set(paneKey, rows)
    return rows
  }
  // Why: a live PTY backs one surface; claim each once so two leaves resolving to it can't emit duplicate React keys and crash the client.
  const claimedLivePtyIds = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (tab.type === 'browser') {
      const liveTab = tab.browserPageId ? liveBrowserTabsByPageId.get(tab.browserPageId) : undefined
      if (!liveTab) {
        continue
      }
      // Why: renderer snapshots lag BrowserView teardown/process swaps; only surface pages the browser bridge can still route to.
      tabs.push({
        ...tab,
        title: liveTab.title || tab.title,
        url: liveTab.url || tab.url,
        // Why: bridge "active" means active BrowserView/webContents, not active Orca tab; preserve the renderer's session focus.
        isActive: tab.isActive
      })
      continue
    }
    if (tab.type === 'markdown' || tab.type === 'file' || tab.type === 'agent-session') {
      tabs.push(tab)
      continue
    }
    const syncedTab = ctx.deps.tabs().get(tab.parentTabId)
    const leaf = ctx.deps.leaves().get(ctx.deps.getLeafKey(tab.parentTabId, tab.leafId)) ?? null
    const liveLeaf = leaf?.ptyId && leaf.connected ? leaf : null
    const liveLeafPtyId = liveLeaf?.ptyId ?? null
    const liveLeafPty = liveLeafPtyId ? (ctx.deps.ptysById().get(liveLeafPtyId) ?? null) : null
    const pty = liveLeaf
      ? null
      : ctx.deps
          .hookAgentRowResolutionCommands()
          .findPtyForMobileTerminalTab(snapshot.worktree, tab, {
            allowWorktreeOnlyMatch: !snapshot.publicationEpoch.startsWith('headless')
          })
    const livePty = pty?.connected ? pty : null
    // Why: enforce one-live-PTY-per-tab; drop a later tab resolving to an already-claimed PTY so no two tabs share a handle.
    const resolvedLivePtyId = liveLeafPtyId ?? livePty?.ptyId ?? null
    if (resolvedLivePtyId !== null) {
      if (claimedLivePtyIds.has(resolvedLivePtyId)) {
        continue
      }
      claimedLivePtyIds.add(resolvedLivePtyId)
    }
    const legacyPaneId = /^pane:(\d+)$/.exec(tab.leafId)?.[1] ?? null
    const paneKey = isTerminalLeafId(tab.leafId)
      ? makePaneKey(tab.parentTabId, tab.leafId)
      : `${tab.parentTabId}:${legacyPaneId ?? tab.leafId}`
    const mobileStatusPty = livePty ?? pty
    // Why: headless hooks live only in main's retained rows; reuse this lookup
    // for both title ownership and status publication so the two cannot diverge.
    const retainedAgentStatus = tab.agentStatus
      ? null
      : ctx.deps
          .hookAgentRowResolutionCommands()
          .getFreshRetainedAgentStatusForMobileTab(paneKey, liveLeafPty ?? mobileStatusPty, tab)
    const hookAgentStatus = tab.agentStatus
      ? ctx.deps.getHookAgentRowForPane(getHookRowsForPane(paneKey))
      : null
    // Why not tab.ptyId: findPtyForMobileTerminalTab already rejected it when it returned
    // null, because persisted ids can collide with an unrelated pane after restart — reading
    // that pane's tracker would publish its title here, ahead of every other source.
    const trackerOnlyTitle = ctx.deps.getUnpersistedTrackedTitleForPty()(
      liveLeafPtyId ?? pty?.ptyId ?? null
    )
    const leafTitle = leaf
      ? getLatestAgentCandidateTitle(
          { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
          { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
        )
      : null
    const ptyTitle = pty
      ? getLatestAgentCandidateTitle(
          { title: pty.title, updatedAt: pty.titleUpdatedAt },
          { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
        )
      : null
    // Renderer omission is authoritative: PTY launch provenance outlives agent exit.
    const launchAgent = tab.launchAgent ?? null
    const launchOwnerAgent = launchAgent ?? liveLeafPty?.launchAgent ?? pty?.launchAgent ?? null
    // Why: a retained OMP hook stays stable while wrapper foreground reads can report Pi.
    const ownerAgent =
      resolvePaneAgentOwner({
        launchAgent: launchOwnerAgent,
        hookAgent:
          tab.agentStatus?.agentType ??
          hookAgentStatus?.agentType ??
          retainedAgentStatus?.payload.agentType ??
          null
      }) ??
      liveLeafPty?.foregroundAgent ??
      pty?.foregroundAgent ??
      null
    const title = normalizeCompatibleAgentTitleForOwner(
      trackerOnlyTitle ?? leafTitle ?? ptyTitle ?? syncedTab?.title ?? tab.title,
      ownerAgent
    )
    const liveTitleEvidence = leafTitle ?? ptyTitle
    // Why: renderer status can precede hook session identity, leaving native chat with no transcript address.
    const rendererStatusAgent =
      resolveCompatibleAgentTypeForOwner(tab.agentStatus?.agentType, ownerAgent) ??
      ownerAgent ??
      undefined
    const hookSessionAgent = resolveCompatibleAgentTypeForOwner(
      hookAgentStatus?.providerSessionAgentType,
      ownerAgent
    )
    const hookSessionMatchesRenderer =
      !rendererStatusAgent || !hookSessionAgent || rendererStatusAgent === hookSessionAgent
    const hookProviderSession =
      hookAgentStatus?.providerSession &&
      hookSessionMatchesRenderer &&
      (!tab.agentStatus?.providerSession ||
        (hookAgentStatus.providerSessionReceivedAt ?? -1) >= tab.agentStatus.updatedAt)
        ? hookAgentStatus.providerSession
        : tab.agentStatus?.providerSession
    const statusPty = liveLeafPty ?? mobileStatusPty
    const normalizedTabAgentStatus = ctx.deps
      .hookAgentRowResolutionCommands()
      .renewMobileAgentStatusFromPtyTitle(
        tab.agentStatus
          ? normalizeCompatibleAgentStatusEntryForOwner(
              {
                ...tab.agentStatus,
                ...(hookProviderSession ? { providerSession: hookProviderSession } : {})
              },
              ownerAgent
            )
          : null,
        statusPty,
        { preserveQuestionUnderShellTitle: true }
      )
    // Why: keep rich status on a live prompt/tool, or interactivePrompt is lost under a non-agent title.
    const hasLiveAgentSignal =
      normalizedTabAgentStatus?.interactivePrompt != null ||
      normalizedTabAgentStatus?.toolName != null
    // Why: only shell/management evidence proves the agent released the pane
    // (same predicate as the terminal-status API). A merely neutral live title
    // — 'Terminal', an editor, a cwd — proves nothing, and treating it as
    // completion published a synthetic `done` that fought the client's own
    // live status on every republication.
    const keepFullAgentStatus =
      normalizedTabAgentStatus &&
      (!terminalTitleBlocksExplicitAgentStatus(liveTitleEvidence) || hasLiveAgentSignal)
    const agentStatus = keepFullAgentStatus
      ? { agentStatus: normalizedTabAgentStatus }
      : // Why: idle live title → drop stale "working" (no spinner) but keep agent identity so native chat can still address the transcript.
        normalizedTabAgentStatus?.agentType != null
        ? {
            agentStatus: {
              state: 'done' as const,
              prompt: '',
              updatedAt: statusPty?.lastOscTitleEpochMs ?? normalizedTabAgentStatus.updatedAt,
              stateStartedAt:
                statusPty?.lastAgentStatusStartedAtEpochMs ??
                normalizedTabAgentStatus.stateStartedAt,
              paneKey: normalizedTabAgentStatus.paneKey,
              stateHistory: [],
              agentType: normalizedTabAgentStatus.agentType,
              ...(normalizedTabAgentStatus.providerSession
                ? { providerSession: normalizedTabAgentStatus.providerSession }
                : {})
            }
          }
        : null
    // Why: web/mobile clients hold handles across renderer graph syncs; leaf handles are epoch-bound but PTY handles stay streamable.
    const terminalHandle = liveLeafPtyId
      ? ctx.deps.issuePtyHandle(
          ctx.deps.recordPtyWorktree(liveLeafPtyId, snapshot.worktree, {
            tabId: tab.parentTabId,
            paneKey,
            connected: true
          })
        )
      : livePty
        ? ctx.deps.issuePtyHandle(livePty)
        : null
    const projectedAgentStatus =
      agentStatus ??
      ctx.deps
        .hookAgentRowResolutionCommands()
        .buildPtyMobileAgentStatus(
          mobileStatusPty,
          tab,
          terminalHandle,
          retainedAgentStatus,
          getHookRowsForPane
        )
    const projectedStatusEntry = projectedAgentStatus.agentStatus as
      | (AgentStatusEntry & { turnCompletedAt?: number })
      | undefined
    const { turnCompletedAt: projectedTurnCompletedAt, ...clientStatusFields } =
      projectedStatusEntry ?? {}
    const clientAgentStatus = projectedStatusEntry
      ? { agentStatus: clientStatusFields as AgentStatusEntry }
      : {}
    const rawTurnCompletedAt =
      hookAgentStatus?.live?.payload.turnCompletedAt ??
      ctx.deps.getHookAgentRowForPane(getHookRowsForPane(paneKey)).live?.payload.turnCompletedAt ??
      projectedTurnCompletedAt
    const turnCompletedAt =
      typeof rawTurnCompletedAt === 'number' && Number.isFinite(rawTurnCompletedAt)
        ? rawTurnCompletedAt
        : undefined
    tabs.push({
      type: 'terminal',
      id: tab.id,
      parentTabId: tab.parentTabId,
      leafId: tab.leafId,
      title,
      ...(tab.ptyId ? { ptyId: tab.ptyId } : {}),
      ...(tab.terminalTheme ? { terminalTheme: tab.terminalTheme } : {}),
      ...(launchAgent ? { launchAgent } : {}),
      ...clientAgentStatus,
      ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
      ...(tab.parentLayout ? { parentLayout: tab.parentLayout } : {}),
      ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
      ...(tab.color != null ? { color: tab.color } : {}),
      ...(tab.isPinned ? { isPinned: true } : {}),
      ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
      ...(tab.launchDraft ? { launchDraft: tab.launchDraft } : {}),
      ...(tab.launchDraftCreatedAt !== undefined
        ? { launchDraftCreatedAt: tab.launchDraftCreatedAt }
        : {}),
      isActive: tab.isActive,
      ...(terminalHandle
        ? { status: 'ready' as const, terminal: terminalHandle }
        : { status: 'pending-handle' as const, terminal: null })
    })
  }
  const active =
    tabs.find((tab) => tab.isActive && tab.id === snapshot.activeTabId) ??
    tabs.find((tab) => tab.isActive) ??
    (snapshot.activeTabId ? (tabs[0] ?? null) : null)
  const normalizedTabs =
    active && !tabs.some((tab) => tab.isActive)
      ? tabs.map((tab) => (tab.id === active.id ? { ...tab, isActive: true } : tab))
      : tabs
  const tabGroups = sanitizeMobileSessionTabGroups(ctx, snapshot.tabGroups, normalizedTabs)
  const validGroupIds = new Set(tabGroups?.map((group) => group.id) ?? [])
  const tabGroupLayout =
    snapshot.tabGroupLayout === undefined
      ? undefined
      : pruneMobileSessionTabGroupLayout(ctx, snapshot.tabGroupLayout, validGroupIds)
  const activeGroupId =
    snapshot.activeGroupId && validGroupIds.has(snapshot.activeGroupId)
      ? snapshot.activeGroupId
      : (tabGroups?.find((group) =>
          active
            ? group.tabOrder.some((tabId) =>
                ctx.deps.collectReturnedSessionTabIds([active]).has(tabId)
              )
            : false
        )?.id ??
        tabGroups?.[0]?.id ??
        null)
  return {
    worktree: snapshot.worktree,
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion,
    activeGroupId,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(tabGroups ? { tabGroups } : {}),
    ...(snapshot.tabGroupLayout !== undefined ? { tabGroupLayout } : {}),
    tabs: normalizedTabs
  }
}
