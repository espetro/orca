import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { RuntimeWorktreeLifecycleEvent } from './runtime-contracts'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { navigationTargetsClients, navigationTargetsHost } from '../../shared/runtime-navigation'
import { toRuntimeActivateWorktreeEvent } from '../../shared/runtime-client-events'
import { planWorktreeSortOrderUpdates } from '../../shared/worktree/sort-order-update'
import { splitWorktreeId } from '../../shared/worktree/id'

/** State owned by the facade that the notify commands mutate. */
export type RuntimeWorktreeNotifyCommandsState = {
  worktreeLifecycleListeners: Set<(event: RuntimeWorktreeLifecycleEvent) => void>
  clientSessionTabSelections: { migrateWorktree: (oldId: string, newId: string) => void }
  notifyWorktreesChanged: (repoId: string) => void
  notifyWorktreesChangedForRemoteClients: (repoId: string) => void
  notifyHostActivateWorktree: (
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ) => void
  notifyClientsActivateWorktree: (
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ) => void
}

export type RuntimeWorktreeNotifyCommandsDeps = Pick<
  RuntimeManagedWorktreesDeps,
  | 'notifier'
  | 'store'
  | 'emitClientEvent'
  | 'clientEventPublishingCommands'
  | 'invalidateResolvedWorktreeCache'
  | 'invalidateWorktreeScanCacheForRepo'
>

import type { RuntimeManagedWorktreesDeps } from './runtime-managed-worktrees'

export class RuntimeWorktreeNotifyCommands {
  constructor(
    private deps: RuntimeWorktreeNotifyCommandsDeps,
    private state: RuntimeWorktreeNotifyCommandsState
  ) {}

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    this.deps.notifier?.worktreeBaseStatus?.(event)
  }

  emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    this.deps.clientEventPublishingCommands().emitWorktreeLifecycle(event)
  }

  notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    launch: {
      setup?: CreateWorktreeResult['setup']
      startup?: WorktreeStartupLaunch
      defaultTabs?: CreateWorktreeResult['defaultTabs']
      navigationTarget: RuntimeNavigationTarget | undefined
    }
  ): void {
    const { setup, startup, defaultTabs } = launch
    const navigation = launch.navigationTarget ?? 'all'
    if (navigationTargetsHost(navigation)) {
      this.state.notifyHostActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    }
    if (navigationTargetsClients(navigation)) {
      this.state.notifyClientsActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    }
  }

  notifyClientsActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.deps.emitClientEvent(
      toRuntimeActivateWorktreeEvent(repoId, worktreeId, setup, startup, defaultTabs)
    )
  }

  notifyHostActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.deps.notifier?.activateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
  }

  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    this.deps.invalidateWorktreeScanCacheForRepo(repoId)
    const matchingRepos = this.deps.store?.getRepos().filter((repo) => repo.id === repoId) ?? []
    if (matchingRepos.length !== 1 || matchingRepos[0]?.connectionId) {
      return
    }
    this.state.notifyWorktreesChangedForRemoteClients(repoId)
  }

  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    this.state.clientSessionTabSelections.migrateWorktree(oldWorktreeId, newWorktreeId)
    this.deps.invalidateResolvedWorktreeCache()
    this.deps.invalidateWorktreeScanCacheForRepo(repoId)
    this.deps.notifier?.worktreesChanged(repoId, { oldWorktreeId, newWorktreeId })
    // Mirror notifyBranchRenamed so in-process onClientEvent listeners also see the rename.
    this.deps.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  notifyWorktreesChanged(repoId: string): void {
    this.deps.clientEventPublishingCommands().notifyWorktreesChanged(repoId)
  }

  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    this.deps.invalidateResolvedWorktreeCache()
    this.deps.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    this.state.worktreeLifecycleListeners.add(listener)
    return () => {
      this.state.worktreeLifecycleListeners.delete(listener)
    }
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.deps.store
    const updates = planWorktreeSortOrderUpdates(
      orderedIds,
      (worktreeId) => store.getWorktreeMeta(worktreeId),
      Date.now()
    )
    for (const update of updates) {
      store.setWorktreeMeta(update.worktreeId, { sortOrder: update.sortOrder })
    }
    if (updates.length === 0) {
      return { updated: 0 }
    }
    this.deps.invalidateResolvedWorktreeCache()
    const changedRepoIds = new Set(
      updates.flatMap((update) => {
        const parsed = splitWorktreeId(update.worktreeId)
        return parsed ? [parsed.repoId] : []
      })
    )
    for (const repoId of changedRepoIds) {
      this.state.notifyWorktreesChanged(repoId)
    }
    return { updated: updates.length }
  }
}
