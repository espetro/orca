// Renderer snapshot sync, removal notifications, coalesced change broadcasts, navigation application, headless activation and recovery replacement.
import type { RuntimeLeafRecord } from './runtime-contracts'
import type { RuntimeSyncedTab } from '../../shared/runtime-session-contracts'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import {
  getMobileSessionSnapshotTabIdentityKeys,
  toMobileSessionTabsResult
} from './runtime-mobile-session-tabs-projection'
import { restoreLivePairedRendererSessionOwnedMobileTerminals } from './runtime-mobile-session-terminal-create'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { navigationTargetsClients } from '../../shared/runtime-navigation'
import { refusedMobileSessionTabClose } from './mobile-session-tab-close-outcome'
import {
  activateClientSessionTabSelection,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from './client-session-tab-selection'
import type { RuntimeMobileSessionFacadeCtx } from './runtime-mobile-session-facade-ctx'
export function syncMobileSessionTabs(
  ctx: RuntimeMobileSessionFacadeCtx,
  snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
  unchangedWorktreeIds?: string[],
  resyncWorktreeIds = new Set<string>()
): Set<string> {
  const changedWorktreeIds = new Set<string>()
  if (snapshots === undefined) {
    return changedWorktreeIds
  }
  // Why: snapshots are immutable — every writer replaces the map entry with a
  // new object, and the accept gate below drops semantically-unchanged
  // renderer resends before they replace an entry — so reference identity
  // before/after detects exactly the entries that actually changed.
  const before = new Map(ctx.deps.mobileSessionTabsByWorktree())
  restoreLivePairedRendererSessionOwnedMobileTerminals(ctx, null, {
    missingSnapshotOnly: true,
    notify: false
  })
  // Why: graph sync must scan each persisted host session once, not once per workspace.
  const worktreeSessionsToHydrate = new Map<string, WorkspaceSessionState | null>(
    ctx.deps.getWorkspaceSessionHydrationTargets(Boolean(ctx.deps.offscreenBrowserBackend()))
  )
  if (ctx.deps.offscreenBrowserBackend()) {
    for (const snapshot of snapshots) {
      if (!worktreeSessionsToHydrate.has(snapshot.worktree)) {
        worktreeSessionsToHydrate.set(snapshot.worktree, null)
      }
    }
  }
  // Why: an empty renderer publication after HUB restart must not hide SSH panes persisted in this HUB's host partition.
  for (const [worktreeId, workspaceSession] of worktreeSessionsToHydrate) {
    ctx.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true,
      ...(workspaceSession ? { runtimeOwnedTerminalCandidateKnown: true, workspaceSession } : {})
    })
  }
  const nextWorktrees = new Set<string>()
  const incomingWorktreeIds = new Set(snapshots.map((snapshot) => snapshot.worktree))
  // Why: the renderer withholds unchanged snapshots to keep the graph payload
  // small, so these worktrees are still live and must not fall into the prune
  // below. Ask for a republish when main no longer holds that accepted renderer
  // publication or a formerly-preserved runtime tab has gone stale.
  for (const worktreeId of unchangedWorktreeIds ?? []) {
    const existing = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const accepted = ctx.deps.acceptedRendererMobileSnapshotByWorktree().get(worktreeId)
    if (existing) {
      nextWorktrees.add(worktreeId)
    }
    if (
      existing &&
      accepted &&
      (existing.publicationEpoch === accepted.publicationEpoch ||
        existing.publicationEpoch.startsWith(`${accepted.publicationEpoch}:headless-merge:`)) &&
      existing.tabs.length >= accepted.rendererTabCount &&
      (existing.tabs.length === accepted.rendererTabCount ||
        !ctx.deps
          .mobileSnapshotMerge()
          .storedMobileSnapshotHasStalePreservedTab(existing, accepted.rendererTabIdentityKeys))
    ) {
      continue
    }
    if (!incomingWorktreeIds.has(worktreeId)) {
      resyncWorktreeIds.add(worktreeId)
    }
    // Why: the accept gate compares against the renderer's last accepted pair,
    // which outlives the dropped snapshot and would reject the republish.
    ctx.deps.acceptedRendererMobileSnapshotByWorktree().delete(worktreeId)
  }
  for (const snapshot of snapshots) {
    nextWorktrees.add(snapshot.worktree)
    const existing = ctx.deps.mobileSessionTabsByWorktree().get(snapshot.worktree)
    // Why: judge renderer publication ordering against the renderer's own
    // last-accepted (epoch, version) — the renderer reuses one pair for
    // byte-identical content, so a same-epoch version <= the accepted one is
    // a no-op resend (or a stale frame) and must be skipped. Never compare
    // against the stored snapshot's version: main-local touches bump it
    // independently and would reject genuinely newer renderer revisions.
    const accepted = ctx.deps.acceptedRendererMobileSnapshotByWorktree().get(snapshot.worktree)
    if (
      accepted &&
      accepted.publicationEpoch === snapshot.publicationEpoch &&
      snapshot.snapshotVersion <= accepted.rendererVersion &&
      // Why: preservation is main-only state — a serve/SSH binding (or live
      // browser page) can disappear without the renderer bumping its version,
      // so a resend of the EXACT accepted revision (content-identical to the
      // accepted publication, safe to re-merge) must still fall through to
      // the merge, which prunes stale preserved tabs. Strictly-older frames
      // stay skipped: their content is outdated, and the next accepted-pair
      // resend performs the prune.
      !(
        existing &&
        snapshot.snapshotVersion === accepted.rendererVersion &&
        ctx.deps
          .mobileSnapshotMerge()
          .storedMobileSnapshotHasStalePreservedTab(existing, accepted.rendererTabIdentityKeys)
      )
    ) {
      continue
    }
    ctx.deps.reconcileNativeChatLaunchDraftResolutionTombstones(snapshot)
    const launchDraftFencedSnapshot = ctx.deps.applyNativeChatLaunchDraftResolutionFence(snapshot)
    const fencedSnapshot = ctx.deps.applyMobileSessionRetirementFences(launchDraftFencedSnapshot)
    ctx.deps.releaseRuntimeSessionOwnershipForRendererRetiredTabs(fencedSnapshot, existing)
    const nextSnapshot = ctx.deps
      .mobileSnapshotMerge()
      .mergePreservedHeadlessMobileSessionTabs(fencedSnapshot, existing)
    // Why: clients drop same-epoch frames whose version isn't strictly newer,
    // and main-local touches may already have emitted a higher version than
    // the renderer's counter — keep the stored version strictly monotonic so
    // the accepted content is never discarded as stale downstream.
    const storedVersion = existing
      ? Math.max(nextSnapshot.snapshotVersion, existing.snapshotVersion + 1)
      : nextSnapshot.snapshotVersion
    ctx.deps
      .mobileSessionTabsByWorktree()
      .set(
        snapshot.worktree,
        storedVersion === nextSnapshot.snapshotVersion
          ? nextSnapshot
          : { ...nextSnapshot, snapshotVersion: storedVersion }
      )
    ctx.deps.acceptedRendererMobileSnapshotByWorktree().set(snapshot.worktree, {
      publicationEpoch: snapshot.publicationEpoch,
      rendererVersion: snapshot.snapshotVersion,
      rendererTabCount: fencedSnapshot.tabs.length,
      rendererTabIdentityKeys: new Set(
        fencedSnapshot.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
      )
    })
  }
  for (const [worktreeId, existing] of ctx.deps.mobileSessionTabsByWorktree().entries()) {
    if (!nextWorktrees.has(worktreeId)) {
      const preserved = ctx.deps
        .mobileSnapshotMerge()
        .buildPreservedHeadlessMobileSessionSnapshot(existing)
      if (preserved) {
        // Why: preservation filters existing.tabs in place (same objects) and
        // the merge epoch hashes the preserved identities idempotently, so an
        // equal epoch with every tab object retained means the recomputation
        // was a no-op — keep the entry so no-op syncs don't fan out.
        const preservedIsNoOp =
          preserved.publicationEpoch === existing.publicationEpoch &&
          preserved.tabs.length === existing.tabs.length &&
          preserved.tabs.every((tab, index) => tab === existing.tabs[index])
        if (!preservedIsNoOp) {
          ctx.deps.mobileSessionTabsByWorktree().set(worktreeId, preserved)
        }
        // Why: the stored entry is no longer the renderer's publication, so a
        // future renderer frame must be re-merged even if it reuses the pair.
        ctx.deps.acceptedRendererMobileSnapshotByWorktree().delete(worktreeId)
        nextWorktrees.add(worktreeId)
      } else {
        ctx.deps.mobileSessionTabsByWorktree().delete(worktreeId)
        ctx.deps.mobileSessionTabsAgentStatusHeartbeat().removeWorktree(worktreeId)
        ctx.deps.acceptedRendererMobileSnapshotByWorktree().delete(worktreeId)
        // Why: drop any pending coalesced notify so a stale snapshot can't land after the removed frame.
        cancelScheduledMobileSessionTabsChanged(ctx, worktreeId)
        notifyMobileSessionTabsRemoved(ctx, worktreeId)
      }
    }
  }
  for (const [worktreeId, snapshot] of ctx.deps.mobileSessionTabsByWorktree()) {
    if (before.get(worktreeId) !== snapshot) {
      changedWorktreeIds.add(worktreeId)
    }
  }
  return changedWorktreeIds
}

export function notifyMobileSessionTabsRemoved(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string
): void {
  const removed: RuntimeMobileSessionTabsRemovedResult = {
    worktree: worktreeId,
    publicationEpoch: `removed:${Date.now().toString(36)}`,
    snapshotVersion: 0,
    removed: true,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
  const changeSequence = ctx.deps.nextMobileSessionTabsChangeSequence()
  for (const subscription of ctx.deps.mobileSessionTabListeners()) {
    subscription.listener(
      ctx.deps.clientSessionTabSelections().project(removed, subscription.clientNavigationId),
      changeSequence
    )
  }
  ctx.deps.clientSessionTabSelections().forgetWorktree(worktreeId)
}

export function scheduleMobileSessionTabsChanged(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string
): void {
  ctx.pendingMobileSessionTabsChangeSequenceByWorktree.set(
    worktreeId,
    ctx.deps.nextMobileSessionTabsChangeSequence()
  )
  ctx.mobileSessionTabsNotifyCoalescer.schedule(worktreeId)
}

export function cancelScheduledMobileSessionTabsChanged(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string
): void {
  ctx.mobileSessionTabsNotifyCoalescer.cancel(worktreeId)
  ctx.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
}

export function flushScheduledMobileSessionTabsChanged(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string
): void {
  const changeSequence = ctx.pendingMobileSessionTabsChangeSequenceByWorktree.get(worktreeId)
  if (changeSequence === undefined) {
    return
  }
  ctx.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
  notifyMobileSessionTabsChangedNow(ctx, worktreeId, changeSequence)
}

export function notifyMobileSessionTabsChangedNow(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  changeSequence: number
): void {
  if (ctx.deps.mobileSessionTabListeners().size === 0) {
    return
  }
  const snapshot = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
  if (!snapshot) {
    return
  }
  // Why: browser bridge events are already worktree-scoped; don't fan out every workspace snapshot during navigation/tab churn.
  const result = toMobileSessionTabsResult(ctx, snapshot)
  for (const subscription of ctx.deps.mobileSessionTabListeners()) {
    subscription.listener(
      ctx.deps
        .mobileTabSnapshots()
        .projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
      changeSequence
    )
  }
}

export function getMobileSessionTabsForWorktree(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  clientNavigationId?: string
): RuntimeMobileSessionTabsResult {
  return ctx.deps.managedWorktrees().getMobileSessionTabsForWorktree(worktreeId, clientNavigationId)
}

export async function resolveMobileMarkdownWorktreeId(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeSelector: string,
  tabId: string
): Promise<string> {
  return ctx.deps.managedWorktrees().resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
}

export async function publishRecoveredSshMobileSessionTabs(
  ctx: RuntimeMobileSessionFacadeCtx,
  targetId: string,
  generation: number
): Promise<void> {
  await ctx.deps
    .clientEventPublishingCommands()
    .publishRecoveredSshMobileSessionTabs(targetId, generation)
  // Update the mobile session tabs change sequence after recovery
  for (const worktreeId of ctx.deps.mobileSessionTabsByWorktree().keys()) {
    notifyMobileSessionTabsChangedNow(
      ctx,
      worktreeId,
      ctx.deps.nextMobileSessionTabsChangeSequence()
    )
  }
}

export function collectMobileVisibleGraphChangedWorktrees(
  ctx: RuntimeMobileSessionFacadeCtx,
  previousTabs: Map<string, RuntimeSyncedTab>,
  previousLeaves: Map<string, RuntimeLeafRecord>
): Set<string> {
  return ctx.deps
    .managedWorktrees()
    .collectMobileVisibleGraphChangedWorktrees(previousTabs, previousLeaves)
}

export async function refuseUnattributedMobileSessionTabClose(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeSelector: string,
  tabId: string
): Promise<MobileSessionTabCloseOutcome> {
  const snapshot = await ctx.listMobileSessionTabs(worktreeSelector)
  const tabExists = snapshot.tabs.some(
    (candidate) =>
      candidate.id === tabId ||
      (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
      (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
  )
  if (!tabExists) {
    throw new Error('tab_not_found')
  }
  // Why: a legacy client may already have hidden its mirror; a new snapshot
  // restores it without granting an unattributed request destructive authority.
  republishMobileSessionTabsSnapshot(ctx, snapshot.worktree)
  return refusedMobileSessionTabClose('missing-intent', {
    snapshotRepublished: true
  })
}

export function republishMobileSessionTabsSnapshot(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string
): void {
  const snapshot = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
  if (snapshot) {
    ctx.deps.mobileSessionTabsByWorktree().set(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1
    })
  }
  ctx.deps.notifyMobileSessionTabsChanged(worktreeId)
}

export function applyMobileSessionTabNavigation(
  ctx: RuntimeMobileSessionFacadeCtx,
  snapshot: RuntimeMobileSessionTabsResult,
  activeTabId: string,
  navigation: RuntimeNavigationTarget,
  clientNavigationId?: string
): RuntimeMobileSessionTabsResult {
  let callerSnapshot: RuntimeMobileSessionTabsResult | null = null
  if (navigationTargetsClients(navigation)) {
    // Why: follow is live intent; disconnected devices must not inherit stale navigation on reconnect.
    const ids = new Set(
      [...ctx.deps.mobileSessionTabListeners()]
        .map((subscription) => subscription.clientNavigationId)
        .filter((id): id is string => Boolean(id))
    )
    if (clientNavigationId) {
      ids.add(clientNavigationId)
    }
    for (const id of ids) {
      const projected = ctx.deps
        .clientSessionTabSelections()
        .activate(ctx.deps.withClientHostedPagesHold(snapshot, id), id, activeTabId)
      ctx.emitMobileSessionTabsSnapshotToClient(projected, id, true)
      if (id === clientNavigationId) {
        callerSnapshot = projected
      }
    }
  } else if (clientNavigationId) {
    // Why: follow-host still starts as caller navigation; the host is an additional target, not a replacement owner.
    callerSnapshot = ctx.deps
      .clientSessionTabSelections()
      .activate(
        ctx.deps.withClientHostedPagesHold(snapshot, clientNavigationId),
        clientNavigationId,
        activeTabId
      )
    ctx.emitMobileSessionTabsSnapshotToClient(callerSnapshot, clientNavigationId)
  }
  if (clientNavigationId) {
    return (
      callerSnapshot ??
      ctx.deps.mobileTabSnapshots().projectMobileSessionTabsForClient(snapshot, clientNavigationId)
    )
  }
  if (navigation === 'caller') {
    const selection = activateClientSessionTabSelection(
      snapshot,
      deriveClientSessionTabSelection(snapshot),
      activeTabId
    )
    return projectClientSessionTabSelection(snapshot, selection).snapshot
  }
  return snapshot
}

export function shouldMaterializeHeadlessMobileSessionTab(
  ctx: RuntimeMobileSessionFacadeCtx,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tab: RuntimeMobileSessionTerminalTab
): boolean {
  return (
    ctx.deps.isHeadlessMobileSessionPublication(snapshot.publicationEpoch) ||
    ctx.deps.hasServeOrSshOwnedBinding(tab)
  )
}

export function shouldPersistHeadlessMobileSessionActivation(
  ctx: RuntimeMobileSessionFacadeCtx,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tab: RuntimeMobileSessionTerminalTab
): boolean {
  if (snapshot.publicationEpoch.includes(':headless-merge:')) {
    return false
  }
  if (ctx.deps.authoritativeWindowId() !== null && ctx.deps.graphStatus() === 'ready') {
    return false
  }
  return shouldMaterializeHeadlessMobileSessionTab(ctx, snapshot, tab)
}

export function activateHeadlessMobileSessionTerminalTab(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  activeTab: RuntimeMobileSessionTerminalTab
): void {
  const tabs = snapshot.tabs.map((candidate) => ({
    ...candidate,
    isActive: candidate.id === activeTab.id
  }))
  const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
    ...snapshot,
    publicationEpoch: `headless:${Date.now().toString(36)}`,
    snapshotVersion: snapshot.snapshotVersion + 1,
    activeTabId: activeTab.id,
    activeTabType: 'terminal',
    tabGroups: ctx.deps
      .mobileTabSnapshots()
      .buildHeadlessMobileSessionTabGroups(worktreeId, tabs, activeTab, snapshot.tabGroups),
    tabs
  }
  ctx.deps.persistHeadlessTerminalActiveLeaf(worktreeId, activeTab)
  ctx.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
  ctx.deps.mobileTabSnapshots().emitMobileSessionTabsSnapshot(nextSnapshot)
}

export function replaceHeadlessTerminalFromRendererSnapshotForRecovery(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  snapshot: {
    data: string
    cols: number
    rows: number
    cwd?: string | null
    oscLinks?: TerminalOscLinkRange[]
  },
  trailingOutput: { data: string; seq: number }[] = []
): void {
  if (!snapshot.data) {
    return
  }
  // Why: a redraw byte can create a suffix-only model before the renderer settles; replace it with the exact snapshot already sent mobile.
  ctx.deps.providerSnapshotPreferredPtys().add(ptyId)
  ctx.deps.disposeHeadlessTerminal(ptyId)
  ctx.deps.seedHeadlessTerminal(
    ptyId,
    snapshot.data,
    { cols: snapshot.cols, rows: snapshot.rows },
    { cwd: snapshot.cwd, oscLinks: snapshot.oscLinks }
  )
  for (const chunk of trailingOutput) {
    ctx.deps.trackHeadlessTerminalData(ptyId, chunk.data, chunk.seq)
  }
  // The seed's write chain owns subsequent live bytes; suppress on-data hydration from replacing this known-good seed.
  ctx.deps.headlessHydrationState().set(ptyId, 'done')
}
