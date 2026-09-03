import type { ExecutionHostId, LocalProjectRuntimeResolution } from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { closeTerminalTabInWorkspaceSession, advanceTerminalTopologyRevision } from '../../shared/workspace-session-terminal-tab-close'
import { retireTerminalSurfacesFromSnapshot, retireTerminalSurfaceFromPersistence, type RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import type { RuntimeMobileSessionBrowserTab, RuntimeMobileSessionSnapshotTab, RuntimeMobileSessionTabGroup, RuntimeMobileSessionTerminalTab, RuntimeMobileSessionTabsResult, RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { createHash, randomUUID } from 'node:crypto'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeMobileSessionTabSnapshotCommandsDeps } from './runtime-mobile-session-tab-snapshot-commands-deps'

export class RuntimeMobileSessionTabSnapshotCommands {
  constructor(private readonly deps: RuntimeMobileSessionTabSnapshotCommandsDeps) {}

  touchMobileSessionSnapshotsForPty(ptyId: string, options: { immediate?: boolean } = {}): void {
    for (const [worktreeId, snapshot] of this.deps.mobileSessionTabsByWorktree) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (!hasPtyBackedTab) {
        continue
      }
      this.touchMobileSessionTabsForWorktree(worktreeId, options)
    }
  }

  getMobileSessionWorktreeIdsForPty(ptyId: string): string[] {
    const worktreeIds: string[] = []
    for (const [worktreeId, snapshot] of this.deps.mobileSessionTabsByWorktree) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (hasPtyBackedTab) {
        worktreeIds.push(worktreeId)
      }
    }
    return worktreeIds
  }

  touchMobileSessionTabsForWorktree(worktreeId: string, options: { immediate?: boolean } = {}): void {
    const snapshot = this.deps.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    this.deps.mobileSessionTabsByWorktree.set(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1
    })
    if (options.immediate) {
      this.deps.notifyMobileSessionTabsChanged(worktreeId)
      return
    }
    this.deps.scheduleMobileSessionTabsChanged(worktreeId)
  }

  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void {
    const resolved = worktreeId ?? this.deps.getTerminalWorktreeIdForPaneKey(paneKey)
    if (!resolved) {
      return
    }
    this.touchMobileSessionTabsForWorktree(resolved)
  }

  private mobileSessionSnapshotHasSurface(worktreeId: string, parentTabId: string, leafId: string): boolean {
    return Boolean(
      this.deps.mobileSessionTabsByWorktree
        .get(worktreeId)
        ?.tabs.some(
          (tab) =>
            tab.type === 'terminal' && tab.parentTabId === parentTabId && tab.leafId === leafId
        )
    )
  }

  private isMobileSessionSurfaceMembershipAllowed(
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null | undefined
  ): boolean {
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const hasHostAuthoritativeTerminalMembership = this.deps.hasHostAuthoritativeTerminalMembership
    const terminalTopologyRevisionByRepoId = this.deps.terminalTopologyRevisionByRepoId
    const ptysById = this.deps.ptysById
    if (
      !hasHostAuthoritativeTerminalMembership(session, worktreeId) &&
      (session !== undefined || !terminalTopologyRevisionByRepoId.has(repoId))
    ) {
      return true
    }
    if (this.mobileSessionSnapshotHasSurface(worktreeId, parentTabId, leafId)) {
      return true
    }
    if (!candidatePtyId) {
      return false
    }
    const pty = ptysById.get(candidatePtyId)
    const pane = this.deps.parsePaneKey(pty?.paneKey ?? '')
    return Boolean(
      pty?.connected &&
      pty.worktreeId === worktreeId &&
      pty.tabId === parentTabId &&
      pane?.leafId === leafId
    )
  }

  private reconcileMobileSessionRetirementFences(leaves: readonly any[]): any[] {
    return leaves.filter((leaf) =>
      this.isMobileSessionSurfaceMembershipAllowed(
        leaf.worktreeId,
        leaf.tabId,
        leaf.leafId,
        leaf.ptyId
      )
    )
  }

  private applyMobileSessionRetirementFences(snapshot: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsSnapshot {
    let next = snapshot
    for (const tab of snapshot.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.isMobileSessionSurfaceMembershipAllowed(
          snapshot.worktree,
          tab.parentTabId,
          tab.leafId,
          tab.ptyId
        )
      ) {
        continue
      }
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot: next,
        ptyId: tab.ptyId ?? '',
        exactSurfaces: [{ parentTabId: tab.parentTabId, leafId: tab.leafId }],
        exactOnly: true
      })
      if (retired) {
        next = retired.snapshot
      }
    }
    return next
  }

  private persistTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[]
  ): { accepted: RetiredTerminalSurface[]; unpersisted: RetiredTerminalSurface[] } | null {
    const surfacesByHostId = new Map<ExecutionHostId, RetiredTerminalSurface[]>()
    for (const surface of retiredSurfaces) {
      const hostId = this.deps.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ?? 'local'
      const bucket = surfacesByHostId.get(hostId)
      if (bucket) {
        bucket.push(surface)
      } else {
        surfacesByHostId.set(hostId, [surface])
      }
    }
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    const pendingWrites: { hostId: ExecutionHostId; session: WorkspaceSessionState }[] = []
    for (const [hostId, surfaces] of surfacesByHostId) {
      const session = this.deps.getWorkspaceSessionForHostId(hostId)
      if (!session) {
        unpersisted.push(...surfaces)
        continue
      }
      if (!this.deps.canSetWorkspaceSession()) {
        return null
      }
      let nextSession = session
      const acceptedForHost: RetiredTerminalSurface[] = []
      for (const surface of surfaces) {
        const candidate = retireTerminalSurfaceFromPersistence(nextSession, surface)
        if (candidate !== nextSession) {
          acceptedForHost.push(surface)
          nextSession = candidate
        }
      }
      if (acceptedForHost.length === 0) {
        continue
      }
      accepted.push(...acceptedForHost)
      pendingWrites.push({ hostId, session: nextSession })
    }
    if (pendingWrites.length > 0) {
      try {
        for (const write of pendingWrites) {
          this.deps.setWorkspaceSession(write.session, write.hostId)
        }
        this.deps.flushOrThrow?.()
      } catch (error) {
        console.error('[runtime] failed to persist terminal retirement:', error)
        return null
      }
    }
    return { accepted, unpersisted }
  }

  private retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): void {
    const retiredSurfaceByKey = new Map<string, RetiredTerminalSurface>()
    for (const surface of exactSurfaces) {
      retiredSurfaceByKey.set(`${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`, {
        ...surface,
        ptyId,
        incarnationId
      })
    }
    for (const [worktreeId, snapshot] of this.deps.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: exactSurfaces.filter((surface) => surface.worktreeId === worktreeId)
      })
      if (!retired) {
        continue
      }
      for (const surface of retired.retired) {
        retiredSurfaceByKey.set(
          `${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`,
          { ...surface, incarnationId }
        )
      }
    }
    const retiredSurfaces = [...retiredSurfaceByKey.values()]
    if (retiredSurfaces.length === 0) {
      return
    }
    const persisted = this.persistTerminalSurfaceRetirements(retiredSurfaces)
    if (!persisted) {
      return
    }
    for (const surface of persisted.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.deps.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.deps.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    const publishableRetiredSurfaces = [...persisted.accepted, ...persisted.unpersisted]
    if (publishableRetiredSurfaces.length === 0) {
      return
    }
    for (const [worktreeId, snapshot] of this.deps.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: publishableRetiredSurfaces.filter(
          (surface) => surface.worktreeId === worktreeId
        ),
        exactOnly: true
      })
      if (retired) {
        this.deps.mobileSessionTabsByWorktree.set(worktreeId, retired.snapshot)
        this.deps.notifyMobileSessionTabsChanged(worktreeId)
      }
    }
  }

  buildHeadlessMobileSessionTerminalTabs(
    worktreeId: string,
    persistedTabs: readonly TerminalTab[],
    session: WorkspaceSessionState
  ): RuntimeMobileSessionTerminalTab[] {
    return [...persistedTabs]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
      .flatMap((tab, index) => {
        const layout = session.terminalLayoutsByTabId?.[tab.id]
        const leafIds = this.collectPersistedTerminalLeafIds(layout)
        if (leafIds.length === 0) {
          leafIds.push(this.deriveHeadlessLegacyTerminalLeafId(tab.id))
        }
        return leafIds.flatMap((leafId) => {
          const ptyId =
            layout?.ptyIdsByLeafId?.[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null)
          const title =
            tab.customTitle?.trim() ||
            tab.generatedTitle?.trim() ||
            tab.title?.trim() ||
            tab.defaultTitle?.trim() ||
            `Terminal ${index + 1}`
          return [
            {
              type: 'terminal' as const,
              id: `${tab.id}::${leafId}`,
              parentTabId: tab.id,
              leafId,
              title,
              ...(ptyId ? { ptyId } : {}),
              ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
              ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {}),
              ...(layout ? { parentLayout: this.cloneTerminalLayoutSnapshot(layout) } : {}),
              ...(tab.color != null ? { color: tab.color } : {}),
              ...(tab.isPinned ? { isPinned: true } : {}),
              ...(tab.viewMode ? { viewMode: tab.viewMode } : {})
            }
          ]
        })
      })
  }

  buildHeadlessMobileSessionBrowserTabs(worktreeId: string): RuntimeMobileSessionBrowserTab[] {
    const serverTabs =
      this.deps.offscreenBrowserBackend && this.deps.agentBrowserBridge?.tabList
        ? this.deps.agentBrowserBridge.tabList(worktreeId).tabs
        : []
    const publishedServerTabs = serverTabs.map((tab) => {
      const persistedProps = this.getPersistedUnifiedSessionTabProps(worktreeId, tab.browserPageId)
      return {
        type: 'browser' as const,
        id: tab.browserPageId,
        title: tab.title || tab.url || 'Browser',
        browserWorkspaceId: tab.browserPageId,
        browserPageId: tab.browserPageId,
        url: tab.url || 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        loadError: tab.loadError ?? undefined,
        certificateFailure: tab.certificateFailure ?? undefined,
        ...(persistedProps ? { color: persistedProps.color } : {}),
        ...(persistedProps ? { isPinned: persistedProps.isPinned === true } : {}),
        isActive: tab.active === true
      }
    })
    const publishedClientTabs = getRuntimeBrowserPageRegistry(this.deps.getRuntimeInstance())
      .listPages(worktreeId)
      .map((page) => ({
        type: 'browser' as const,
        id: page.browserPageId,
        title: page.title || page.url || 'Browser',
        browserWorkspaceId: page.browserPageId,
        browserPageId: page.browserPageId,
        browserProfileId: page.browserProfileId,
        executionHostKey: page.executionHostKey,
        placement: page.placement,
        url: page.url,
        loading: page.loading,
        canGoBack: page.canGoBack,
        canGoForward: page.canGoForward,
        isActive: page.active
      }))
    return [...publishedServerTabs, ...publishedClientTabs]
  }

  private headlessBrowserTabsUnchanged(
    live: RuntimeMobileSessionBrowserTab[],
    existing: RuntimeMobileSessionBrowserTab[]
  ): boolean {
    if (live.length !== existing.length) {
      return false
    }
    return live.every((tab, index) => {
      const prev = existing[index]
      return (
        tab.id === prev.id &&
        tab.title === prev.title &&
        tab.url === prev.url &&
        tab.loading === prev.loading &&
        tab.canGoBack === prev.canGoBack &&
        tab.canGoForward === prev.canGoForward &&
        tab.browserProfileId === prev.browserProfileId &&
        tab.executionHostKey === prev.executionHostKey &&
        ((tab.placement === undefined && prev.placement === undefined) ||
          (tab.placement !== undefined &&
            prev.placement !== undefined &&
            sameRuntimeBrowserPlacement(tab.placement, prev.placement))) &&
        tab.isActive === prev.isActive &&
        (tab.isPinned ?? false) === (prev.isPinned ?? false) &&
        (tab.color ?? null) === (prev.color ?? null) &&
        this.browserLoadErrorsEqual(tab.loadError, prev.loadError) &&
        this.browserCertificateFailuresEqual(tab.certificateFailure, prev.certificateFailure)
      )
    })
  }

  private browserLoadErrorsEqual(
    a: RuntimeMobileSessionBrowserTab['loadError'],
    b: RuntimeMobileSessionBrowserTab['loadError']
  ): boolean {
    const left = a ?? null
    const right = b ?? null
    if (left === right) {
      return true
    }
    if (!left || !right) {
      return false
    }
    return (
      left.code === right.code &&
      left.description === right.description &&
      left.validatedUrl === right.validatedUrl
    )
  }

  private browserCertificateFailuresEqual(
    a: RuntimeMobileSessionBrowserTab['certificateFailure'],
    b: RuntimeMobileSessionBrowserTab['certificateFailure']
  ): boolean {
    const left = a ?? null
    const right = b ?? null
    if (left === right) {
      return true
    }
    if (!left || !right) {
      return false
    }
    return (
      left.challengeId === right.challengeId &&
      left.browserPageId === right.browserPageId &&
      left.errorCode === right.errorCode &&
      left.error === right.error &&
      left.origin === right.origin &&
      left.displayHost === right.displayHost &&
      left.canProceed === right.canProceed &&
      left.observedAt === right.observedAt
    )
  }

  private getPersistedUnifiedSessionTabProps(worktreeId: string, tabId: string): Pick<any, 'color' | 'isPinned'> | null {
    const tab =
      this.deps.getWorkspaceSessionForWorktree(worktreeId)?.unifiedTabs?.[worktreeId]?.find(
        (candidate) => candidate.id === tabId || candidate.entityId === tabId
      ) ?? null
    return tab ? { color: tab.color, isPinned: tab.isPinned } : null
  }

  private collectPersistedTerminalLeafIds(layout: TerminalLayoutSnapshot | undefined): string[] {
    if (!layout) {
      return []
    }
    const leafIds = new Set<string>()
    const visit = (node: any): void => {
      if (!node) {
        return
      }
      if (node.type === 'leaf') {
        if (isTerminalLeafId(node.leafId)) {
          leafIds.add(node.leafId)
        }
        return
      }
      visit(node.first)
      visit(node.second)
    }
    visit(layout.root)
    if (layout.activeLeafId && isTerminalLeafId(layout.activeLeafId)) {
      leafIds.add(layout.activeLeafId)
    }
    for (const leafId of Object.keys(layout.ptyIdsByLeafId ?? {})) {
      if (isTerminalLeafId(leafId)) {
        leafIds.add(leafId)
      }
    }
    return [...leafIds]
  }

  private deriveHeadlessLegacyTerminalLeafId(tabId: string): string {
    const hash = createHash('sha256').update(`headless-terminal-leaf:${tabId}`).digest('hex')
    const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
    const leafId = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      `4${hash.slice(13, 16)}`,
      `${variant}${hash.slice(17, 20)}`,
      hash.slice(20, 32)
    ].join('-')
    if (!isTerminalLeafId(leafId)) {
      return randomUUID()
    }
    return leafId
  }

  private cloneTerminalLayoutSnapshot(layout: TerminalLayoutSnapshot): TerminalLayoutSnapshot {
    const cloned: TerminalLayoutSnapshot = {
      root: layout.root,
      activeLeafId: layout.activeLeafId,
      expandedLeafId: layout.expandedLeafId
    }
    if (layout.ptyIdsByLeafId) {
      cloned.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
    }
    if (layout.buffersByLeafId) {
      cloned.buffersByLeafId = { ...layout.buffersByLeafId }
    }
    if (layout.scrollbackRefsByLeafId) {
      cloned.scrollbackRefsByLeafId = { ...layout.scrollbackRefsByLeafId }
    }
    if (layout.titlesByLeafId) {
      cloned.titlesByLeafId = { ...layout.titlesByLeafId }
    }
    return cloned
  }

  private isPersistedTerminalLeafActive(
    session: WorkspaceSessionState,
    worktreeId: string,
    tabId: string,
    leafId: string,
    layout: TerminalLayoutSnapshot | undefined
  ): boolean {
    const activeTabId = session.activeTabIdByWorktree?.[worktreeId] ?? session.activeTabId
    return activeTabId === tabId && (!layout?.activeLeafId || layout.activeLeafId === leafId)
  }

  private pickHeadlessActiveTerminalTab(
    tabs: readonly RuntimeMobileSessionTerminalTab[]
  ): RuntimeMobileSessionTerminalTab | null {
    return tabs.find((tab) => tab.isActive) ?? tabs.find((tab) => tab.parentTabId) ?? null
  }

  private collectHeadlessParentTabOrder(tabs: readonly RuntimeMobileSessionTerminalTab[]): string[] {
    const order: string[] = []
    const seen = new Set<string>()
    for (const tab of tabs) {
      if (!seen.has(tab.parentTabId)) {
        seen.add(tab.parentTabId)
        order.push(tab.parentTabId)
      }
    }
    return order
  }

  private collectHeadlessTopLevelTabOrder(tabs: readonly RuntimeMobileSessionSnapshotTab[]): string[] {
    const order: string[] = []
    const seen = new Set<string>()
    for (const tab of tabs) {
      const topLevelId = tab.type === 'terminal' ? tab.parentTabId : tab.id
      if (!seen.has(topLevelId)) {
        seen.add(topLevelId)
        order.push(topLevelId)
      }
    }
    return order
  }

  private getHeadlessMobileSessionGroupId(worktreeId: string): string {
    return `headless-terminals:${worktreeId}`
  }

  buildHeadlessMobileSessionTabGroups(
    worktreeId: string,
    tabs: readonly RuntimeMobileSessionSnapshotTab[],
    activeTab: RuntimeMobileSessionSnapshotTab | null,
    existingGroups?: readonly RuntimeMobileSessionTabGroup[],
    newTabAssignment?: { tabId: string; groupId: string }
  ): RuntimeMobileSessionTabGroup[] {
    const tabOrder = this.collectHeadlessTopLevelTabOrder(tabs)
    const topLevelOf = (tab: RuntimeMobileSessionSnapshotTab): string =>
      tab.type === 'terminal' ? tab.parentTabId : tab.id
    const activeTopLevelId =
      (activeTab ? topLevelOf(activeTab) : null) ??
      existingGroups?.[0]?.activeTabId ??
      (() => {
        const active = tabs.find((tab) => tab.isActive)
        return active ? topLevelOf(active) : null
      })() ??
      tabOrder[0] ??
      null

    if (existingGroups && existingGroups.length > 1) {
      return this.distributeHeadlessTabsAcrossGroups(
        existingGroups,
        tabOrder,
        activeTopLevelId,
        newTabAssignment
      )
    }

    const groupId = existingGroups?.[0]?.id ?? this.getHeadlessMobileSessionGroupId(worktreeId)
    return [
      {
        id: groupId,
        activeTabId:
          activeTopLevelId && tabOrder.includes(activeTopLevelId)
            ? activeTopLevelId
            : (tabOrder[0] ?? null),
        tabOrder
      }
    ]
  }

  private distributeHeadlessTabsAcrossGroups(
    existingGroups: readonly RuntimeMobileSessionTabGroup[],
    tabOrder: readonly string[],
    activeTopLevelId: string | null,
    newTabAssignment?: { tabId: string; groupId: string }
  ): RuntimeMobileSessionTabGroup[] {
    const groupIdByTabId = new Map<string, string>()
    for (const group of existingGroups) {
      for (const tabId of group.tabOrder) {
        groupIdByTabId.set(tabId, group.id)
      }
    }
    const hasTargetGroup =
      newTabAssignment !== undefined &&
      existingGroups.some((group) => group.id === newTabAssignment.groupId)
    if (hasTargetGroup) {
      groupIdByTabId.set(newTabAssignment!.tabId, newTabAssignment!.groupId)
    }
    const activeGroupId =
      (activeTopLevelId ? groupIdByTabId.get(activeTopLevelId) : undefined) ?? existingGroups[0]!.id
    const orderByGroup = new Map<string, string[]>(existingGroups.map((group) => [group.id, []]))
    for (const tabId of tabOrder) {
      const groupId = groupIdByTabId.get(tabId) ?? activeGroupId
      orderByGroup.get(groupId)?.push(tabId)
    }
    return existingGroups
      .map((group) => {
        const nextOrder = orderByGroup.get(group.id) ?? []
        return {
          ...group,
          tabOrder: nextOrder,
          activeTabId:
            activeTopLevelId && nextOrder.includes(activeTopLevelId)
              ? activeTopLevelId
              : group.activeTabId && nextOrder.includes(group.activeTabId)
                ? group.activeTabId
                : (nextOrder[0] ?? null)
        }
      })
      .filter((group) => group.tabOrder.length > 0)
  }

  buildMaterializedHeadlessParentLayout(
    leafId: string,
    ptyId: string,
    existingLayout: TerminalLayoutSnapshot | undefined,
    split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
  ): TerminalLayoutSnapshot {
    if (!existingLayout) {
      return {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    }
    if (split) {
      return this.deps.buildHeadlessTerminalSplitLayout(this.cloneTerminalLayoutSnapshot(existingLayout), {
        leafId,
        ptyId,
        splitFromLeafId: split.splitFromLeafId,
        direction: split.direction
      })
    }
    return {
      ...this.cloneTerminalLayoutSnapshot(existingLayout),
      ptyIdsByLeafId: {
        ...existingLayout.ptyIdsByLeafId,
        [leafId]: ptyId
      }
    }
  }

  removePersistedHeadlessTerminalTab(
    worktreeId: string,
    parentTabId: string,
    options: { allowMissing?: boolean } = {}
  ): string[] {
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.deps.canSetWorkspaceSession()) {
      throw new Error('workspace_session_unavailable')
    }
    const result = closeTerminalTabInWorkspaceSession(session, worktreeId, parentTabId)
    if (result.pinned) {
      throw new Error('terminal_tab_pinned')
    }
    if (!result.closed) {
      if (options.allowMissing) {
        return []
      }
      throw new Error('tab_not_found')
    }
    this.deps.setWorkspaceSessionForWorktree(
      worktreeId,
      advanceTerminalTopologyRevision(result.session, worktreeId)
    )
    return result.ptyIdsToKill
  }

  persistHeadlessTerminalTabOrder(worktreeId: string, tabOrder: readonly string[]): void {
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.deps.canSetWorkspaceSession()) {
      return
    }
    const orderIndexByTabId = new Map(tabOrder.map((tabId, index) => [tabId, index]))
    const tabs = session.tabsByWorktree[worktreeId] ?? []
    const reordered = [...tabs]
      .sort((a, b) => {
        const aIndex = orderIndexByTabId.get(a.id) ?? Number.MAX_SAFE_INTEGER
        const bIndex = orderIndexByTabId.get(b.id) ?? Number.MAX_SAFE_INTEGER
        return aIndex - bIndex || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
      })
      .map((tab, index) => ({
        ...tab,
        sortOrder: index
      }))
    this.deps.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: reordered
      }
    })
  }

  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    const { mobileSessionTabListeners, mobileSessionTabsChangeSequence, toMobileSessionTabsResult, projectMobileSessionTabsForClient } = this.deps
    if (mobileSessionTabListeners.size === 0) {
      return
    }
    const result = toMobileSessionTabsResult(snapshot)
    const changeSequence = mobileSessionTabsChangeSequence + 1
    for (const subscription of mobileSessionTabListeners) {
      subscription.listener(
        projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
  }

  projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.deps.projectMobileSessionTabsForClient(result, clientNavigationId)
  }

  withClientHostedPagesHold(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.deps.withClientHostedPagesHold(result, clientNavigationId)
  }
}
