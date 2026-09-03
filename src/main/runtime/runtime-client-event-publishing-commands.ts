import type { RuntimeClientEventPublishingCommandsDeps } from './runtime-client-event-publishing-commands-deps'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

export class RuntimeClientEventPublishingCommands {
  constructor(private deps: RuntimeClientEventPublishingCommandsDeps) {}

  countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.deps.clientEventListeners.size - this.deps.terminalSideEffectExcludedClientEventListeners.size
  }

  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    const events: RuntimeClientEvent[] = []
    const sleepStates = [...this.deps.terminalSleepStateByWorktreeId.values()].sort((a, b) =>
      a.worktreeId.localeCompare(b.worktreeId)
    )
    for (const state of sleepStates) {
      const committedPtyIds = new Set(state.ptyIds)
      if (state.phase === 'stopping') {
        const pendingPtyIds = Object.keys(state.terminalHandlesByPtyId)
          .filter((ptyId) => !committedPtyIds.has(ptyId))
          .sort()
        if (pendingPtyIds.length > 0) {
          events.push({
            type: 'worktreeTerminalSleepState',
            worktreeId: state.worktreeId,
            generation: state.generation,
            phase: 'started',
            ptyIds: pendingPtyIds,
            terminalHandles: this.getRecordedTerminalSleepHandles(pendingPtyIds, state.terminalHandlesByPtyId)
          })
        }
      }
      if (state.ptyIds.length > 0) {
        events.push({
          type: 'worktreeTerminalSleepState',
          worktreeId: state.worktreeId,
          generation: state.generation,
          phase: state.phase,
          ptyIds: state.ptyIds,
          terminalHandles: this.getRecordedTerminalSleepHandles(state.ptyIds, state.terminalHandlesByPtyId)
        })
      }
    }
    return events
  }

  getRecordedTerminalSleepHandles(ptyIds: string[], terminalHandlesByPtyId: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {}
    for (const ptyId of ptyIds) {
      const handle = terminalHandlesByPtyId[ptyId]
      if (handle) result[ptyId] = handle
    }
    return result
  }

  emitClientEvent(event: RuntimeClientEvent): void {
    for (const listener of this.deps.clientEventListeners) {
      listener(event)
    }
  }

  filterTerminalSideEffectEventForClient(event: RuntimeClientEvent): boolean {
    return !this.deps.terminalSideEffectExcludedClientEventListeners.has(this.emitClientEvent)
  }

  notifyMobileSessionTabsChanged(tabUpdate: any): void {
    this.deps.notifyMobileSessionTabsChanged(tabUpdate)
  }

  notifyWorktreesChanged(repoId: string): void {
    this.deps.store.updateUI?.({
      worktreesChangedByRepoId: { [repoId]: true }
    })
  }

  emitWorktreeLifecycle(event: any): void {
    for (const listener of this.deps.worktreeLifecycleListeners) {
      listener(event)
    }
  }

  notifyReposChanged(): void {
    this.deps.store.updateUI?.({
      reposChanged: true
    })
  }

  notifyActivateWorktree(worktreeId: string, navigationTarget?: any): void {
    this.emitClientEvent({
      type: 'worktreeActivation',
      worktreeId,
      navigationTarget
    })
  }

  notifyHostActivateWorktree(worktreeId: string, navigationTarget?: any): void {
    this.deps.store.updateUI?.({
      activateWorktree: { worktreeId, navigationTarget }
    })
  }

  notifyClientsActivateWorktree(worktreeId: string, navigationTarget?: any): void {
    this.notifyActivateWorktree(worktreeId, navigationTarget)
  }

  bumpSshRelayRecoveryGeneration(targetId: string): number {
    const current = this.deps.sshRelayRecoveryGenerationByTargetId.get(targetId) ?? 0
    const next = current + 1
    this.deps.sshRelayRecoveryGenerationByTargetId.set(targetId, next)
    return next
  }

  async publishRecoveredSshMobileSessionTabs(sessionId: string, tabs: any[]): Promise<void> {
    this.emitClientEvent({
      type: 'automationsChanged',
      automationIds: []
    })
  }

  persistWindowlessPtyBindingsForDesktopAttach(): void {
    this.deps.store.flushOrThrow?.()
  }

  resolveNativeChatLaunchDraftOwner(draftId: string): any {
    return null
  }

  retireResolvedNativeChatLaunchDraftFromMobileSnapshot(draftId: string): void {
    // No-op delegation
  }

  applyNativeChatLaunchDraftResolutionFence(draftId: string): void {
    // No-op delegation
  }

  reconcileNativeChatLaunchDraftResolutionTombstones(): void {
    // No-op delegation
  }
}
