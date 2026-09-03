import type { RuntimeMobileSnapshotValueComparisonDeps } from './runtime-mobile-snapshot-value-comparison-commands-deps'
import type { RuntimeMobileSessionTabsSnapshot, RuntimeMobileSessionSnapshotTab, RuntimeMobileSessionTerminalTab, RuntimeMobileSessionTabGroup } from '../../shared/runtime-types'
import { collectLayoutLeafIdsInOrder } from '../../shared/terminal-layout'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

const SSH_PANE_RECOVERY_GRACE_MS = 30000

export class RuntimeMobileSnapshotValueComparisonCommands {
  constructor(private deps: RuntimeMobileSnapshotValueComparisonDeps) {}

  headlessMobileSnapshotContentUnchanged(
    existing: RuntimeMobileSessionTabsSnapshot,
    next: RuntimeMobileSessionTabsSnapshot
  ): boolean {
    if (
      existing.worktree !== next.worktree ||
      existing.activeGroupId !== next.activeGroupId ||
      existing.activeTabId !== next.activeTabId ||
      existing.activeTabType !== next.activeTabType
    ) {
      return false
    }
    return (
      this.mobileSnapshotValueEqual(existing.tabs, next.tabs) &&
      this.mobileSnapshotValueEqual(existing.tabGroups ?? null, next.tabGroups ?? null) &&
      this.mobileSnapshotValueEqual(existing.tabGroupLayout ?? null, next.tabGroupLayout ?? null)
    )
  }

  mobileSnapshotValueEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
      return true
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false
      }
      for (let index = 0; index < a.length; index++) {
        if (!this.mobileSnapshotValueEqual(a[index], b[index])) {
          return false
        }
      }
      return true
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const aRecord = a as Record<string, unknown>
      const bRecord = b as Record<string, unknown>
      const aKeys = Object.keys(aRecord)
      if (aKeys.length !== Object.keys(bRecord).length) {
        return false
      }
      for (const key of aKeys) {
        if (
          !Object.hasOwn(bRecord, key) ||
          !this.mobileSnapshotValueEqual(aRecord[key], bRecord[key])
        ) {
          return false
        }
      }
      return true
    }
    return false
  }

  reconcileHeadlessMobileSessionBrowserTabs(
    worktreeId: string,
    existing: RuntimeMobileSessionTabsSnapshot
  ): void {
    const liveBrowserTabs = this.buildHeadlessMobileSessionBrowserTabs(worktreeId)
    const liveIds = liveBrowserTabs.map((tab) => tab.id)
    const existingBrowserTabs = existing.tabs.filter(
      (tab): tab is any => tab.type === 'browser'
    )
    const existingBrowserIds = existingBrowserTabs.map((tab) => tab.id)
    if (this.headlessBrowserTabsUnchanged(liveBrowserTabs, existingBrowserTabs)) {
      return
    }
    const nonBrowserTabs = existing.tabs.filter((tab) => tab.type !== 'browser')
    const nextTabs: RuntimeMobileSessionSnapshotTab[] = [...nonBrowserTabs, ...liveBrowserTabs]
    const liveIdSet = new Set(liveIds)
    const tabGroups = this.appendBrowserTabOrder(
      (existing.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter(
          (id) => liveIdSet.has(id) || !existingBrowserIds.includes(id)
        )
      })),
      liveIds
    )
    const activeStillPresent = nextTabs.some((tab) => tab.id === existing.activeTabId)
    const active = activeStillPresent
      ? null
      : (nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null)
    this.deps.mobileSessionTabsByWorktree.set(worktreeId, {
      ...existing,
      publicationEpoch: `headless-hydrated:${Date.now().toString(36)}`,
      snapshotVersion: existing.snapshotVersion + 1,
      ...(activeStillPresent
        ? {}
        : { activeTabId: active?.id ?? null, activeTabType: active?.type ?? null }),
      tabGroups,
      tabs: nextTabs
    })
  }

  appendBrowserTabOrder(
    groups: readonly RuntimeMobileSessionTabGroup[],
    browserTabIds: readonly string[],
    newTabAssignment?: { tabId: string; groupId: string },
    priorGroupByBrowserId?: ReadonlyMap<string, string>
  ): RuntimeMobileSessionTabGroup[] {
    if (browserTabIds.length === 0) {
      return [...groups]
    }
    const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
    if (next.length === 0) {
      return next
    }
    const groupById = new Map(next.map((group) => [group.id, group]))
    const ownerGroupByTabId = new Map<string, RuntimeMobileSessionTabGroup>()
    for (const group of next) {
      for (const id of group.tabOrder) {
        ownerGroupByTabId.set(id, group)
      }
    }
    for (const id of browserTabIds) {
      if (ownerGroupByTabId.has(id)) {
        continue
      }
      const priorGroupId = priorGroupByBrowserId?.get(id)
      const targetGroup =
        (newTabAssignment?.tabId === id ? groupById.get(newTabAssignment.groupId) : undefined) ??
        (priorGroupId ? groupById.get(priorGroupId) : undefined) ??
        next[0]!
      targetGroup.tabOrder.push(id)
    }
    return next
  }

  collectBrowserGroupAssignment(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    browserTabIds: readonly string[]
  ): Map<string, string> {
    const browserIdSet = new Set(browserTabIds)
    const assignment = new Map<string, string>()
    for (const group of groups ?? []) {
      for (const id of group.tabOrder) {
        if (browserIdSet.has(id)) {
          assignment.set(id, group.id)
        }
      }
    }
    return assignment
  }

  isServeOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && ptyId.startsWith('serve-')
  }

  isSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && parseAppSshPtyId(ptyId) !== null
  }

  workspaceSessionHasRuntimeOwnedPtyCandidate(session: any): boolean {
    return Object.entries(session.tabsByWorktree ?? {}).some(([worktreeId, tabs]: any) =>
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs)
    )
  }

  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    session: any,
    worktreeId: string,
    tabs: any
  ): boolean {
    return tabs.some((tab: any) => {
      if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
        return true
      }
      const leafPtyIds = session.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId
      return (
        (leafPtyIds &&
          Object.values(leafPtyIds).some((ptyId: any) => this.isServeOrSshOwnedPtyId(ptyId))) ||
        this.getRecentExpiredSshLease(worktreeId, tab.id, undefined) !== null
      )
    })
  }

  getRecentExpiredSshLease(
    worktreeId: string,
    tabId: string,
    leafId: string | undefined,
    ptyId?: string
  ): any {
    const now = Date.now()
    return (
      this.deps.store
        ?.getSshRemotePtyLeases?.()
        .find(
          (lease: any) =>
            lease.state === 'expired' &&
            lease.worktreeId === worktreeId &&
            lease.tabId === tabId &&
            (ptyId === undefined || lease.ptyId === ptyId) &&
            (leafId === undefined || lease.leafId === undefined || lease.leafId === leafId) &&
            lease.updatedAt <= now &&
            now - lease.updatedAt <= SSH_PANE_RECOVERY_GRACE_MS
        ) ?? null
    )
  }

  hasRecentExpiredSshLeasePane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return this.getRecentExpiredSshLease(worktreeId, tab.parentTabId, tab.leafId) !== null
  }

  isServeOrSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return this.isServeOwnedPtyId(ptyId) || this.isSshOwnedPtyId(ptyId)
  }

  hasServeOrSshOwnedBinding(tab: RuntimeMobileSessionTerminalTab): boolean {
    if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
      return true
    }
    return Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {}).some((ptyId: any) =>
      this.isServeOrSshOwnedPtyId(ptyId)
    )
  }

  hasLiveOrPersistedServeOrSshOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const boundPtyIds = [
      tab.ptyId,
      ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})
    ].filter((ptyId): ptyId is string => this.isServeOrSshOwnedPtyId(ptyId))
    const boundSshPtyIds = boundPtyIds.filter((ptyId) => this.isSshOwnedPtyId(ptyId))
    if (boundPtyIds.length === 0) {
      return this.hasRecentExpiredSshLeasePane(worktreeId, tab)
    }
    if (boundPtyIds.some((ptyId) => this.deps.ptysById.get(ptyId)?.connected === true)) {
      return true
    }
    const now = Date.now()
    if (
      boundPtyIds.some((ptyId) => {
        const pty = this.deps.ptysById.get(ptyId)
        return (
          pty?.connectionId != null &&
          pty.lastExitCode != null &&
          pty.lastExitCode < 0 &&
          pty.disconnectedAt != null &&
          now - pty.disconnectedAt <= SSH_PANE_RECOVERY_GRACE_MS
        )
      })
    ) {
      return true
    }
    if (
      now - this.deps.startedAt <= SSH_PANE_RECOVERY_GRACE_MS &&
      boundSshPtyIds.some((ptyId) => {
        const pty = this.deps.ptysById.get(ptyId)
        return !pty || (!pty.connected && pty.lastExitCode === null)
      })
    ) {
      return true
    }
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    if (!session) {
      return false
    }
    const persistedTab = (session.tabsByWorktree?.[worktreeId] ?? []).find(
      (candidate: any) => candidate.id === tab.parentTabId
    )
    if (!persistedTab) {
      return false
    }
    const persistedPtyIds = new Set(
      [
        persistedTab.ptyId,
        ...Object.values(session.terminalLayoutsByTabId?.[persistedTab.id]?.ptyIdsByLeafId ?? {})
      ].filter((ptyId): ptyId is string => typeof ptyId === 'string')
    )
    return boundPtyIds.some((ptyId) => persistedPtyIds.has(ptyId))
  }

  hasLiveRuntimeSessionOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const pty = this.deps.findPtyForMobileTerminalTab(worktreeId, tab)
    return pty?.connected === true && pty.runtimeSessionOwned
  }

  clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    parentTabId: string
  ): void {
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'terminal' || tab.parentTabId !== parentTabId) {
        continue
      }
      const ptyIds = [tab.ptyId, ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})].filter(
        (ptyId): ptyId is string => typeof ptyId === 'string'
      )
      for (const ptyId of ptyIds) {
        const pty = this.deps.ptysById.get(ptyId)
        if (pty?.worktreeId === worktreeId && pty.tabId === parentTabId) {
          pty.runtimeSessionOwned = false
        }
      }
    }
  }

  getMobileTerminalLeafPtyIds(tab: RuntimeMobileSessionTerminalTab): string[] {
    return [tab.ptyId, tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]].filter(
      (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
    )
  }

  clearRuntimeSessionOwnershipForMobileTerminalLeaf(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    for (const ptyId of this.getMobileTerminalLeafPtyIds(tab)) {
      const pty = this.deps.ptysById.get(ptyId)
      if (pty?.worktreeId === worktreeId && pty.tabId === tab.parentTabId) {
        pty.runtimeSessionOwned = false
      }
    }
  }

  persistedParentStillBindsMobileTerminalLeaf(
    session: any,
    persistedParent: any,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const layout = session.terminalLayoutsByTabId?.[tab.parentTabId]
    if (!layout) {
      return true
    }
    if (
      typeof layout.ptyIdsByLeafId?.[tab.leafId] === 'string' ||
      collectLayoutLeafIdsInOrder(layout.root).includes(tab.leafId)
    ) {
      return true
    }
    const leafPtyIds = new Set(this.getMobileTerminalLeafPtyIds(tab))
    if (leafPtyIds.size === 0) {
      return true
    }
    return [persistedParent.ptyId, ...Object.values(layout.ptyIdsByLeafId ?? {})].some(
      (ptyId) => typeof ptyId === 'string' && leafPtyIds.has(ptyId)
    )
  }

  releaseRuntimeSessionOwnershipForRendererRetiredTabs(
    incoming: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): void {
    if (!existing || this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)) {
      return
    }
    const worktreeId = existing.worktree
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    const persistedTabs = session?.tabsByWorktree?.[worktreeId]
    if (!session || !persistedTabs) {
      return
    }
    const persistedTabsById = new Map(persistedTabs.map((tab: any) => [tab.id, tab]))
    const incomingIdentityKeys = new Set(
      incoming.tabs.flatMap((tab) => this.deps.getMobileSessionSnapshotTabIdentityKeys(tab))
    )
    for (const tab of existing.tabs) {
      if (tab.type !== 'terminal') {
        continue
      }
      if (
        this.deps.pendingMobileTerminalCreatesByKey.has(`${worktreeId}::${tab.parentTabId}`) ||
        this.deps.getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
          incomingIdentityKeys.has(id)
        ) ||
        !this.hasLiveRuntimeSessionOwnedPtyBinding(worktreeId, tab)
      ) {
        continue
      }
      const persistedParent = persistedTabsById.get(tab.parentTabId)
      if (!persistedParent) {
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, existing, tab.parentTabId)
        continue
      }
      if (!this.persistedParentStillBindsMobileTerminalLeaf(session, persistedParent, tab)) {
        this.clearRuntimeSessionOwnershipForMobileTerminalLeaf(worktreeId, tab)
      }
    }
  }

  isRuntimeOwnedHeadlessMobileTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (this.hasServeOrSshOwnedBinding(tab)) {
      return true
    }
    const pty = this.deps.findPtyForMobileTerminalTab(worktreeId, tab)
    if (pty && this.isServeOrSshOwnedPtyId(pty.ptyId)) {
      return true
    }
    return !this.deps.tabs.has(tab.parentTabId)
  }

  mergeMobileSessionSnapshotTabs(
    baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
    extraTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): RuntimeMobileSessionSnapshotTab[] {
    const seenIds = new Set<string>()
    const merged: RuntimeMobileSessionSnapshotTab[] = []
    const add = (tab: RuntimeMobileSessionSnapshotTab): void => {
      const ids = this.deps.getMobileSessionSnapshotTabIdentityKeys(tab)
      if (ids.some((id) => seenIds.has(id))) {
        return
      }
      for (const id of ids) {
        seenIds.add(id)
      }
      merged.push(tab)
    }
    for (const tab of baseTabs) {
      add(tab)
    }
    for (const tab of extraTabs) {
      add(tab)
    }
    return merged
  }

  mergeMobileSessionTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    terminalTabs: readonly RuntimeMobileSessionTerminalTab[],
    activeTab: RuntimeMobileSessionTerminalTab | null
  ): RuntimeMobileSessionTabGroup[] {
    const parentTabOrder = this.collectHeadlessParentTabOrder(terminalTabs)
    if (parentTabOrder.length === 0) {
      return [...groups]
    }
    const targetGroupId = groups[0]?.id ?? this.getHeadlessMobileSessionGroupId(worktreeId)
    const nextGroups =
      groups.length > 0
        ? groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
        : [
            {
              id: targetGroupId,
              activeTabId: null,
              tabOrder: []
            }
          ]
    const ownerGroupId = new Map<string, string>()
    for (const group of nextGroups) {
      for (const tabId of group.tabOrder) {
        ownerGroupId.set(tabId, group.id)
      }
    }
    const liveTabIds = new Set(parentTabOrder)
    const activeParentId = activeTab?.parentTabId ?? null
    const activeGroupId =
      (activeParentId ? ownerGroupId.get(activeParentId) : undefined) ?? nextGroups[0]!.id
    const retainedOrder = new Map<string, string[]>(nextGroups.map((group) => [group.id, []]))
    for (const tabId of parentTabOrder) {
      const groupId = ownerGroupId.get(tabId) ?? activeGroupId
      retainedOrder.get(groupId)?.push(tabId)
    }
    return nextGroups
      .map((group) => {
        const tabOrder = retainedOrder.get(group.id) ?? []
        const keptActive =
          group.activeTabId &&
          tabOrder.includes(group.activeTabId) &&
          liveTabIds.has(group.activeTabId)
            ? group.activeTabId
            : null
        return {
          ...group,
          tabOrder,
          activeTabId:
            activeParentId && tabOrder.includes(activeParentId)
              ? activeParentId
              : (keptActive ?? tabOrder[0] ?? null)
        }
      })
      .filter((group) => group.tabOrder.length > 0)
  }

  // Stub methods needed by parent (will be delegated from OrcaRuntimeService)
  private buildHeadlessMobileSessionBrowserTabs(worktreeId: string): any[] {
    return []
  }

  private headlessBrowserTabsUnchanged(a: any, b: any): boolean {
    return false
  }

  private isHeadlessBuiltMobileSessionPublicationBase(epoch: string): boolean {
    return epoch.startsWith('headless-')
  }

  private collectHeadlessParentTabOrder(tabs: any[]): string[] {
    return []
  }

  private getHeadlessMobileSessionGroupId(worktreeId: string): string {
    return 'default'
  }
}
