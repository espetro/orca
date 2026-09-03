import type { RuntimeClientEventPublishingCommandsDeps } from './runtime-client-event-publishing-commands-deps'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeWorktreeLifecycleEvent } from '../../shared/runtime-types'

export class RuntimeClientEventPublishingCommands {
  constructor(private deps: RuntimeClientEventPublishingCommandsDeps) {}

  setNotifier(notifier: unknown): void {
    this.deps.notifier = notifier as RuntimeClientEventPublishingCommandsDeps['notifier']
  }

  countTerminalSideEffectConsumingClientEventListeners(): number {
    return (
      this.deps.clientEventListeners.size -
      this.deps.terminalSideEffectExcludedClientEventListeners.size
    )
  }

  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    const events: RuntimeClientEvent[] = []
    const sleepStates = [...this.deps.terminalSleepStateByWorktreeId.values()].sort(
      (a: unknown, b: unknown) =>
        (a as { worktreeId: string }).worktreeId.localeCompare(
          (b as { worktreeId: string }).worktreeId
        )
    )
    for (const state of sleepStates) {
      const stateObj = state as {
        worktreeId: string
        generation: number
        phase: string
        ptyIds: string[]
        terminalHandlesByPtyId: Record<string, readonly string[]>
      }
      const committedPtyIds = new Set(stateObj.ptyIds)
      if (stateObj.phase === 'stopping') {
        const pendingPtyIds = Object.keys(stateObj.terminalHandlesByPtyId)
          .filter((ptyId) => !committedPtyIds.has(ptyId))
          .sort()
        if (pendingPtyIds.length > 0) {
          events.push({
            type: 'worktreeTerminalSleepState',
            worktreeId: stateObj.worktreeId,
            generation: stateObj.generation,
            phase: 'started',
            ptyIds: pendingPtyIds,
            terminalHandles: this.getRecordedTerminalSleepHandles(
              pendingPtyIds,
              stateObj.terminalHandlesByPtyId
            )
          } as RuntimeClientEvent)
        }
      }
      if (stateObj.ptyIds.length > 0) {
        events.push({
          type: 'worktreeTerminalSleepState',
          worktreeId: stateObj.worktreeId,
          generation: stateObj.generation,
          phase: 'committed',
          ptyIds: [...stateObj.ptyIds].sort(),
          terminalHandles: this.getRecordedTerminalSleepHandles(
            stateObj.ptyIds,
            stateObj.terminalHandlesByPtyId
          )
        } as RuntimeClientEvent)
      }
    }
    return events
  }

  getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[] {
    return [...new Set([...ptyIds].flatMap((ptyId) => terminalHandlesByPtyId[ptyId] ?? []))].sort()
  }

  emitClientEvent(event: RuntimeClientEvent): void {
    this.deps.notifyRuntimeListeners(
      this.deps.clientEventListeners,
      (listener) => {
        if (event.type === 'terminalSideEffects') {
          const filtered = this.filterTerminalSideEffectEventForClient(listener, event)
          if (filtered) {
            listener(filtered)
          }
        } else {
          listener(event)
        }
      },
      'client-event'
    )
  }

  filterTerminalSideEffectEventForClient(
    listener: (event: RuntimeClientEvent) => void,
    event: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }>
  ): Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | null {
    const titleGateKeys =
      this.deps.terminalSideEffectTitleGateKeysByClientEventListener.get(listener)
    if (!titleGateKeys) {
      return null
    }
    const facts = event.batch.facts.filter((fact) => {
      if (fact.kind !== 'title') {
        return true
      }
      const gateKey = this.deps.makeDecorativeTitleGateKey(fact.rawTitle, fact.normalizedTitle)
      if (titleGateKeys.get(event.batch.ptyId) === gateKey) {
        return false
      }
      titleGateKeys.set(event.batch.ptyId, gateKey)
      return true
    })
    if (facts.length === 0) {
      return null
    }
    return facts.length === event.batch.facts.length
      ? event
      : { ...event, batch: { ...event.batch, facts } }
  }

  resolveNativeChatLaunchDraftOwner(handle: string): { tabId: string; worktreeId: string } | null {
    const record = this.deps.handles.get(handle) as unknown & {
      tabId: string
      worktreeId: string
      ptyId?: string
    }
    if (!record) {
      return null
    }
    if (!record.tabId.startsWith('pty:')) {
      return { tabId: record.tabId, worktreeId: record.worktreeId }
    }
    const pty = record.ptyId ? (this.deps.ptysById.get(record.ptyId) as unknown) : null
    const tabId =
      (pty as unknown & { tabId?: string })?.tabId &&
      !(pty as unknown & { tabId?: string })?.tabId?.startsWith('pty:')
        ? (pty as unknown & { tabId: string }).tabId
        : (
            this.deps.parsePaneKey(
              (pty as unknown & { paneKey?: string })?.paneKey ?? ''
            ) as unknown & { tabId?: string }
          )?.tabId
    if (!pty || !tabId || (tabId as string).startsWith('pty:')) {
      return null
    }
    return {
      tabId: tabId as string,
      worktreeId: (pty as unknown & { worktreeId: string }).worktreeId
    }
  }

  retireResolvedNativeChatLaunchDraftFromMobileSnapshot(resolution: {
    tabId: string
    worktreeId: string
    text: string
    createdAt: number
  }): void {
    for (const [worktreeId, snapshot] of this.deps.mobileSessionTabsByWorktree) {
      if (!this.deps.runtimeWorktreeIdsEqual(worktreeId, resolution.worktreeId)) {
        continue
      }
      const next = this.applyNativeChatLaunchDraftResolutionFence(snapshot)
      if (next === snapshot) {
        return
      }
      this.deps.mobileSessionTabsByWorktree.set(worktreeId, {
        ...(next as unknown),
        snapshotVersion: (snapshot as unknown & { snapshotVersion: number }).snapshotVersion + 1
      })
      this.deps.scheduleMobileSessionTabsChanged(worktreeId)
      return
    }
  }

  applyNativeChatLaunchDraftResolutionFence(snapshot: unknown): unknown {
    const snap = snapshot as unknown & { tabs: unknown[]; worktree: unknown }
    let changed = false
    const tabs = snap.tabs.map((tab: unknown) => {
      const tabObj = tab as unknown & {
        type: string
        parentTabId: string
        launchDraft?: string
        launchDraftCreatedAt?: number
      }
      if (tabObj.type !== 'terminal') {
        return tab
      }
      const resolution = this.deps.nativeChatLaunchDraftResolutionByTabId.get(
        tabObj.parentTabId
      ) as unknown & {
        text: string
        createdAt: number
        worktreeId: string
      }
      if (
        !resolution ||
        !this.deps.runtimeWorktreeIdsEqual(snap.worktree, resolution.worktreeId) ||
        tabObj.launchDraft !== resolution.text ||
        tabObj.launchDraftCreatedAt !== resolution.createdAt
      ) {
        return tab
      }
      changed = true
      const next = { ...tabObj }
      delete next.launchDraft
      delete next.launchDraftCreatedAt
      return next
    })
    return changed ? { ...(snapshot as unknown), tabs } : snapshot
  }

  reconcileNativeChatLaunchDraftResolutionTombstones(snapshot: unknown): void {
    const snap = snapshot as unknown & { tabs: unknown[]; worktree: unknown }
    for (const [tabId, resolution] of this.deps.nativeChatLaunchDraftResolutionByTabId) {
      const res = resolution as unknown & { text: string; createdAt: number; worktreeId: string }
      if (!this.deps.runtimeWorktreeIdsEqual(snap.worktree, res.worktreeId)) {
        continue
      }
      const surfaces = snap.tabs.filter(
        (tab: unknown): tab is unknown =>
          (tab as unknown & { type: string; parentTabId: string }).type === 'terminal' &&
          (tab as unknown & { type: string; parentTabId: string }).parentTabId === tabId
      )
      if (
        surfaces.length === 0 ||
        !surfaces.some(
          (tab: unknown) =>
            (tab as unknown & { launchDraft?: string; launchDraftCreatedAt?: number })
              .launchDraft === res.text &&
            (tab as unknown & { launchDraft?: string; launchDraftCreatedAt?: number })
              .launchDraftCreatedAt === res.createdAt
        )
      ) {
        this.deps.nativeChatLaunchDraftResolutionByTabId.delete(tabId)
      }
    }
  }

  notifyWorktreesChanged(repoId: string): void {
    this.deps.notifier?.worktreesChanged?.(repoId)
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    for (const listener of this.deps.worktreeLifecycleListeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[runtime] worktree lifecycle listener threw', err)
      }
    }
  }

  notifyReposChanged(): void {
    this.deps.wakeFolderRepoGitUpgradeWatch()
    this.deps.notifier?.reposChanged?.()
    this.emitClientEvent({ type: 'reposChanged' })
  }

  bumpSshRelayRecoveryGeneration(targetId: string): number {
    const generation = (this.deps.sshRelayRecoveryGenerationByTargetId.get(targetId) ?? 0) + 1
    this.deps.sshRelayRecoveryGenerationByTargetId.set(targetId, generation)
    return generation
  }

  async publishRecoveredSshMobileSessionTabs(targetId: string, generation: number): Promise<void> {
    const repos = (this.deps.store?.getRepos?.() ?? []) as unknown[]
    const repoIds = new Set(
      repos
        .filter(
          (repo: unknown) => (repo as unknown & { connectionId?: string }).connectionId === targetId
        )
        .map((repo: unknown) => (repo as unknown & { id: string }).id)
    )
    if (repoIds.size === 0) {
      return
    }
    const worktreeIds = new Set<string>()
    for (const worktreeId of [
      ...this.deps.getKnownWorkspaceSessionWorktreeIds(),
      ...this.deps.mobileSessionTabsByWorktree.keys()
    ]) {
      const parsed = this.deps.splitWorktreeId(worktreeId) as unknown & { repoId: string }
      if (parsed && repoIds.has(parsed.repoId)) {
        worktreeIds.add(worktreeId)
      }
    }
    if (worktreeIds.size === 0) {
      return
    }

    for (const worktreeId of worktreeIds) {
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    await this.deps.refreshMobileSessionPtyRecords()
    if (this.deps.sshRelayRecoveryGenerationByTargetId.get(targetId) !== generation) {
      return
    }
    // Note: the caller is responsible for incrementing mobileSessionTabsChangeSequence
    for (const worktreeId of worktreeIds) {
      this.deps.notifyMobileSessionTabsChangedNow(worktreeId, 0)
    }
  }

  persistWindowlessPtyBindingsForDesktopAttach(): void {
    if (!this.deps.store?.getWorkspaceSession || !this.deps.store.setWorkspaceSession) {
      return
    }
    const partitions = new Map<string, { session: unknown; ptys: unknown[] }>()
    for (const pty of this.deps.ptysById.values()) {
      const ptyObj = pty as unknown & { connected: boolean; tabId?: string; worktreeId: string }
      if (!ptyObj.connected || !ptyObj.tabId) {
        continue
      }
      const hostId = ptyObj.worktreeId // Placeholder: actual implementation uses more complex logic
      const session = this.deps.store.getWorkspaceSession(hostId)
      const tab = (
        session as unknown & { tabsByWorktree?: Record<string, unknown[]> }
      )?.tabsByWorktree?.[ptyObj.worktreeId]?.find(
        (candidate: unknown) => (candidate as unknown & { id: string }).id === ptyObj.tabId
      )
      if (!tab) {
        continue
      }
      const layoutPtyIds = Object.values(
        (session as unknown & { terminalLayoutsByTabId?: Record<string, unknown> })
          ?.terminalLayoutsByTabId?.[ptyObj.tabId as string]?.ptyIdsByLeafId ?? {}
      ) as string[]
      const tabObj = tab as unknown & { ptyId: string }
      if (tabObj.ptyId !== ptyObj.tabId && !layoutPtyIds.includes(ptyObj.tabId as string)) {
        continue
      }
      const partition = partitions.get(hostId) ?? { session, ptys: [] }
      partition.ptys.push(pty)
      partitions.set(hostId, partition)
    }

    for (const [hostId, { session, ptys }] of partitions) {
      const sessionObj = session as unknown & {
        activeWorktreeIdsOnShutdown?: string[]
        activeConnectionIdsAtShutdown?: string[]
        remoteSessionIdsByTabId: Record<string, string>
      }
      const activeWorktreeIdsOnShutdown = [
        ...new Set([
          ...(sessionObj?.activeWorktreeIdsOnShutdown ?? []),
          ...ptys.map((pty: unknown) => (pty as unknown & { worktreeId: string }).worktreeId)
        ])
      ]
      const activeConnectionIdsAtShutdown = [
        ...new Set([
          ...(sessionObj?.activeConnectionIdsAtShutdown ?? []),
          ...ptys
            .map((pty: unknown) => (pty as unknown & { connectionId?: string }).connectionId)
            .filter(
              (connectionId: string | undefined): connectionId is string =>
                connectionId !== null && connectionId !== undefined
            )
        ])
      ]
      const remoteSessionIdsByTabId = sessionObj?.remoteSessionIdsByTabId
        ? { ...sessionObj.remoteSessionIdsByTabId }
        : {}
      for (const pty of ptys) {
        const ptyObj = pty as unknown & { connectionId?: string; tabId?: string; ptyId: string }
        if (ptyObj.connectionId && ptyObj.tabId) {
          remoteSessionIdsByTabId[ptyObj.tabId] = ptyObj.ptyId
        }
      }

      this.deps.store.setWorkspaceSession(hostId, {
        ...sessionObj,
        activeWorktreeIdsOnShutdown,
        ...(activeConnectionIdsAtShutdown.length > 0 ? { activeConnectionIdsAtShutdown } : {}),
        ...(Object.keys(remoteSessionIdsByTabId).length > 0 ? { remoteSessionIdsByTabId } : {})
      })
    }
  }
}
