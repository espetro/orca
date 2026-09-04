import { createHash } from 'node:crypto'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { RuntimeMobileSnapshotMergeDeps } from './runtime-mobile-snapshot-merge-commands-deps'

export class RuntimeMobileSnapshotMergeCommands {
  constructor(private readonly deps: RuntimeMobileSnapshotMergeDeps) {}

  mergePreservedHeadlessMobileSessionTabs(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): RuntimeMobileSessionTabsSnapshot {
    if (!existing) {
      return snapshot
    }
    const preservedTabs = this.collectPreservedHeadlessMobileSessionTabs(existing, snapshot)
    if (preservedTabs.length === 0) {
      return snapshot
    }
    const preservedActiveTab = preservedTabs.find(
      (tab) => tab.id === existing.activeTabId && tab.isActive
    )
    const hasIncomingActiveTab = snapshot.tabs.some((tab) => tab.isActive)
    const normalizedPreservedTabs = preservedTabs.map((tab) =>
      hasIncomingActiveTab && !preservedActiveTab ? { ...tab, isActive: false } : tab
    )
    // Why: an omitting renderer frame predates the runtime-owned structured
    // publication, so it cannot revoke that publication's focus intent.
    const normalizedIncomingTabs = preservedActiveTab
      ? snapshot.tabs.map((tab) => (tab.isActive ? { ...tab, isActive: false } : tab))
      : snapshot.tabs
    const tabs = this.deps.mergeMobileSessionSnapshotTabs(
      normalizedIncomingTabs,
      normalizedPreservedTabs
    )
    if (tabs.length === snapshot.tabs.length) {
      return snapshot
    }
    const activeTab =
      preservedActiveTab ??
      normalizedIncomingTabs.find((tab) => tab.id === snapshot.activeTabId) ??
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    const tabGroups = this.deps.mergeMobileSessionTabGroups(
      snapshot.worktree,
      snapshot.tabGroups ?? existing.tabGroups ?? [],
      terminalTabs,
      activeTab?.type === 'terminal' ? activeTab : null
    )
    return {
      ...snapshot,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(
        snapshot,
        normalizedPreservedTabs
      ),
      snapshotVersion: Math.max(snapshot.snapshotVersion, existing.snapshotVersion),
      activeGroupId: snapshot.activeGroupId ?? existing.activeGroupId,
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: this.mergeStructuredAgentSessionTabGroups(
        tabGroups,
        existing.tabGroups ?? [],
        normalizedPreservedTabs,
        activeTab?.id ?? null
      ),
      tabs
    }
  }

  private mergeStructuredAgentSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[],
    existingGroups: readonly RuntimeMobileSessionTabGroup[],
    preservedTabs: readonly RuntimeMobileSessionSnapshotTab[],
    activeTabId: string | null
  ): RuntimeMobileSessionTabGroup[] {
    const structuredTabs = preservedTabs.filter((tab) => tab.type === 'agent-session')
    if (structuredTabs.length === 0) {
      return [...groups]
    }
    const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
    for (const tab of structuredTabs) {
      const priorGroupId = existingGroups.find((group) => group.tabOrder.includes(tab.id))?.id
      const target = next.find((group) => group.id === priorGroupId) ?? next[0]
      if (target && !target.tabOrder.includes(tab.id)) {
        target.tabOrder.push(tab.id)
      }
      if (target && tab.id === activeTabId) {
        target.activeTabId = tab.id
      }
    }
    return next
  }

  buildPreservedHeadlessMobileSessionSnapshot(
    existing: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot | null {
    const tabs = this.collectPreservedHeadlessMobileSessionTabs(existing)
    if (tabs.length === 0) {
      return null
    }
    const activeTab =
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    return {
      ...existing,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(existing, tabs),
      // Why: mint a fresh version or clients' same-epoch gate drops the prune frame.
      snapshotVersion: existing.snapshotVersion + 1,
      activeGroupId:
        existing.activeGroupId ?? this.deps.getHeadlessMobileSessionGroupId(existing.worktree),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: this.deps.mergeMobileSessionTabGroups(
        existing.worktree,
        existing.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      tabs
    }
  }

  // Why: the accepted-revision no-op gate must not fossilize preserved runtime
  // tabs. A stored merged snapshot's tabs absent from the accepted renderer
  // publication exist only via preservation; if any such tab no longer
  // passes the preservation predicate (binding removed from the live PTY table
  // and persisted session, or browser page closed), the stored snapshot is stale.
  storedMobileSnapshotHasStalePreservedTab(
    existing: RuntimeMobileSessionTabsSnapshot,
    rendererTabIdentityKeys: ReadonlySet<string>
  ): boolean {
    return existing.tabs.some(
      (tab) =>
        !this.deps
          .getMobileSessionSnapshotTabIdentityKeys(tab)
          .some((id) => rendererTabIdentityKeys.has(id)) &&
        !this.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    )
  }

  private collectPreservedHeadlessMobileSessionTabs(
    existing: RuntimeMobileSessionTabsSnapshot,
    incoming?: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionSnapshotTab[] {
    const incomingIds = new Set(
      incoming?.tabs.flatMap((tab) => this.deps.getMobileSessionSnapshotTabIdentityKeys(tab)) ?? []
    )
    return existing.tabs.filter((tab) => {
      if (
        this.deps.getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))
      ) {
        return false
      }
      return this.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    })
  }

  private shouldPreserveHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean {
    if (tab.type === 'agent-session') {
      return true
    }
    if (tab.type === 'browser') {
      const liveClientPage = this.deps.getRuntimeBrowserPageForTab(tab, snapshot.worktree)
      if (
        liveClientPage?.workspaceId === snapshot.worktree &&
        tab.placement?.kind === 'client' &&
        this.deps.sameRuntimeBrowserPlacement(liveClientPage.placement, tab.placement)
      ) {
        return true
      }
      // Why: headless offscreen browser tabs exist only server-side, so a renderer-graph merge must keep them, not prune as "not in the graph".
      if (!this.deps.offscreenBrowserBackend) {
        return false
      }
      // Why: in a renderer-based merged snapshot the browser entries can also
      // be renderer-owned, so only pages the offscreen bridge still lists are
      // runtime-owned and preservable; a pure renderer epoch preserves none.
      return (
        this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
        (snapshot.publicationEpoch.includes(':headless-merge:') &&
          typeof tab.browserPageId === 'string' &&
          this.deps.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId))
      )
    }
    if (tab.type !== 'terminal') {
      return false
    }
    // Why: a merged renderer snapshot carries BOTH renderer-owned and
    // runtime-owned tabs, so the epoch alone must not preserve every terminal —
    // that resurrects renderer tabs the renderer already closed. Broad
    // preservation applies only to genuinely headless-built snapshots; in a
    // renderer-based one, only tabs with a live-or-persisted serve/SSH binding
    // are runtime-owned and preservable.
    return (
      this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
      this.deps.hasLiveRuntimeSessionOwnedPtyBinding(snapshot.worktree, tab) ||
      this.deps.hasLiveOrPersistedServeOrSshOwnedPtyBinding(snapshot.worktree, tab)
    )
  }

  // Why: `:headless-merge:` only marks that runtime tabs were merged in — the
  // BASE epoch still says who published the snapshot. A renderer-based merged
  // snapshot must not be classified as headless-built, or its renderer tabs
  // read as runtime-owned.
  private isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean {
    const base = publicationEpoch.split(':headless-merge:')[0]
    return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
  }

  private getMergedMobileSessionPublicationEpoch(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    preservedTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): string {
    // Why: preserved snapshots can merge repeatedly; strip the prior merge suffix first so the publication epoch stays idempotent.
    const normalizedPublicationEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    const signature = createHash('sha1')
      .update(
        preservedTabs
          .map((tab) =>
            tab.type === 'terminal'
              ? `${tab.id}:${tab.parentTabId}:${tab.ptyId ?? ''}:${tab.leafId}`
              : tab.id
          )
          .join('|')
      )
      .digest('hex')
      .slice(0, 12)
    return `${normalizedPublicationEpoch}:headless-merge:${signature}`
  }

  notifyMobileSessionTabSnapshots(): void {
    if (this.deps.mobileSessionTabListeners.size === 0) {
      return
    }
    for (const snapshot of this.deps.mobileSessionTabsByWorktree.values()) {
      const result = this.deps.toMobileSessionTabsResult(snapshot)
      const changeSequence = ++this.deps.mobileSessionTabsChangeSequence.value
      for (const subscription of this.deps.mobileSessionTabListeners) {
        subscription.listener(
          this.deps.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
          changeSequence
        )
      }
    }
  }

  emitMobileSessionTabsSnapshotToClient(
    projected: unknown,
    clientNavigationId: string,
    follow = false
  ): void {
    const changeSequence = ++this.deps.mobileSessionTabsChangeSequence.value
    for (const subscription of this.deps.mobileSessionTabListeners) {
      if (subscription.clientNavigationId === clientNavigationId) {
        subscription.listener(
          follow && typeof projected === 'object' && projected !== null
            ? { ...(projected as Record<string, unknown>), navigationIntent: 'follow' }
            : projected,
          changeSequence
        )
      }
    }
  }
}
