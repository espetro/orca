import type { RuntimeOrchestrationGraphReloadCommandsDeps } from './runtime-orchestration-graph-reload-commands-deps'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

export type RuntimeRendererReloadFence = Readonly<{
  revision: number
  recovery: 'renderer' | 'headless' | 'reloading'
}>

export class RuntimeOrchestrationGraphReloadCommands {
  constructor(private deps: RuntimeOrchestrationGraphReloadCommandsDeps) {}

  markRendererReloading(windowId: number): RuntimeRendererReloadFence | null {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.deps.getAuthoritativeWindowId() === HEADLESS_RUNTIME_WINDOW_ID &&
      this.deps.isHeadlessGraphFallbackAvailable()
    ) {
      this.deps.attachWindow(windowId)
      const revision = this.deps.graphReloadLifecycle.getActiveRevision()
      return this.deps.getAuthoritativeWindowId() === windowId && revision !== null
        ? { revision, recovery: 'headless' }
        : null
    }
    if (windowId !== this.deps.getAuthoritativeWindowId()) {
      return null
    }
    if (this.deps.getGraphStatus() === 'reloading') {
      return {
        revision: this.deps.graphReloadLifecycle.begin(windowId),
        recovery: this.shouldRestoreHeadlessGraph(windowId) ? 'headless' : 'reloading'
      }
    }
    if (this.deps.getGraphStatus() !== 'ready') {
      return null
    }
    return { revision: this.beginGraphReload(windowId), recovery: 'renderer' }
  }

  private beginGraphReload(windowId: number): number {
    this.deps.setRendererGraphEpoch(this.deps.getRendererGraphEpoch() + 1)
    this.deps.setGraphStatus('reloading')
    const revision = this.deps.graphReloadLifecycle.begin(windowId)
    this.deps.setTerminalSideEffectConsumerAvailable(false)
    this.deps.rememberDetachedPreAllocatedLeaves()
    const retainedHandles = new Set([
      ...this.deps.handleByPtyId.values(),
      ...[...this.deps.handleByPtyIncarnation.values()].map((record: unknown) => {
        const rec = record as { handle: string }
        return rec.handle
      })
    ])
    for (const handle of this.deps.waitersByHandle.keys()) {
      if (!retainedHandles.has(handle)) {
        this.deps.rejectWaitersForHandle(handle, 'terminal_handle_stale')
      }
    }
    this.deps.handles.clear()
    this.deps.handleByLeafKey.clear()
    this.deps.refreshWritableFlags()
    return revision
  }

  markRendererReloadCancelled(windowId: number, fence: RuntimeRendererReloadFence): boolean {
    if (
      windowId !== this.deps.getAuthoritativeWindowId() ||
      this.deps.getGraphStatus() !== 'reloading' ||
      !this.deps.graphReloadLifecycle.settle(fence.revision, 'cancelled')
    ) {
      return false
    }
    if (fence.recovery === 'headless' && this.shouldRestoreHeadlessGraph(windowId)) {
      this.restoreHeadlessGraphAuthority()
      return false
    }
    if (fence.recovery === 'renderer') {
      const restoresPublishedInventory =
        this.deps.getSessionTabsInventoryPublicationEpoch() ===
        this.deps.getRendererGraphEpoch() - 1
      this.deps.setGraphStatus('ready')
      this.deps.setTerminalSideEffectConsumerAvailable(true)
      for (const leaf of this.deps.leaves.values()) {
        this.deps.adoptPreAllocatedHandle(leaf)
      }
      this.deps.reconcilePtyIncarnationHandles()
      this.deps.refreshWritableFlags()
      if (restoresPublishedInventory) {
        this.deps.markSessionTabsInventoryPublished()
      }
      return true
    }
    this.deps.graphReloadLifecycle.begin(windowId)
    return false
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.deps.getAuthoritativeWindowId()) {
      return
    }
    this.deps.graphReloadLifecycle.settleActive('success')
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.deps.setHeadlessGraphFallbackAvailable(false)
      this.deps.setPendingHeadlessPromotionWindowId(null)
    }
    this.deps.setGraphStatus('ready')
    this.deps.setTerminalSideEffectConsumerAvailable(windowId !== HEADLESS_RUNTIME_WINDOW_ID)
    this.deps.refreshWritableFlags()
  }

  markGraphReloadFailed(
    windowId: number,
    _reason: 'renderer-frame-unavailable' | 'renderer-process-gone'
  ): void {
    if (windowId !== this.deps.getAuthoritativeWindowId()) {
      return
    }
    if (this.deps.getGraphStatus() === 'ready') {
      this.beginGraphReload(windowId)
    }
    this.deps.graphReloadLifecycle.settleActive('failure')
    this.transitionGraphReloadToTerminalState(windowId)
  }

  markGraphUnavailable(windowId: number): void {
    if (
      this.deps.getAuthoritativeWindowId() === HEADLESS_RUNTIME_WINDOW_ID &&
      windowId === this.deps.getPendingHeadlessPromotionWindowId()
    ) {
      this.deps.setPendingHeadlessPromotionWindowId(null)
      return
    }
    if (windowId !== this.deps.getAuthoritativeWindowId()) {
      return
    }
    this.deps.graphReloadLifecycle.settleActive('cancelled')
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.deps.setPendingHeadlessPromotionWindowId(null)
      this.restoreHeadlessGraphAuthority()
      return
    }
    if (this.deps.getGraphStatus() !== 'unavailable') {
      this.deps.setRendererGraphEpoch(this.deps.getRendererGraphEpoch() + 1)
    }
    this.deps.setGraphStatus('unavailable')
    this.deps.setTerminalSideEffectConsumerAvailable(false)
    this.deps.setAuthoritativeWindowId(null)
    this.deps.rememberDetachedPreAllocatedLeaves()
    this.deps.tabs.clear()
    this.deps.leaves.clear()
    this.deps.leavesByPtyId.clear()
    this.deps.handles.clear()
    this.deps.handleByLeafKey.clear()
    this.deps.clearPtyIncarnationHandles()
    this.deps.rejectAllWaiters('terminal_handle_stale')
  }

  handleGraphReloadTimeout(windowId: number): void {
    if (
      windowId !== this.deps.getAuthoritativeWindowId() ||
      this.deps.getGraphStatus() !== 'reloading'
    ) {
      return
    }
    this.transitionGraphReloadToTerminalState(windowId)
  }

  private transitionGraphReloadToTerminalState(windowId: number): void {
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.restoreHeadlessGraphAuthority()
      return
    }
    this.deps.setGraphStatus('unavailable')
    this.deps.setTerminalSideEffectConsumerAvailable(false)
    this.deps.rememberDetachedPreAllocatedLeaves()
    this.deps.tabs.clear()
    this.deps.leaves.clear()
    this.deps.leavesByPtyId.clear()
    this.deps.handles.clear()
    this.deps.handleByLeafKey.clear()
    this.deps.clearPtyIncarnationHandles()
    this.deps.rejectAllWaiters('terminal_handle_stale')
    this.deps.refreshWritableFlags()
  }

  private shouldRestoreHeadlessGraph(windowId: number): boolean {
    return windowId !== HEADLESS_RUNTIME_WINDOW_ID && this.deps.isHeadlessGraphFallbackAvailable()
  }

  private restoreHeadlessGraphAuthority(): void {
    this.deps.setRendererGraphEpoch(this.deps.getRendererGraphEpoch() + 1)
    this.deps.setAuthoritativeWindowId(HEADLESS_RUNTIME_WINDOW_ID)
    this.deps.setGraphStatus('ready')
    this.deps.setRendererGeneration(null)
    this.deps.setTerminalSideEffectConsumerAvailable(false)
    this.deps.tabs.clear()
    this.deps.leaves.clear()
    this.deps.leavesByPtyId.clear()
    this.deps.handles.clear()
    this.deps.handleByLeafKey.clear()
    this.deps.clearPtyIncarnationHandles()
    this.deps.rejectAllWaiters('terminal_handle_stale')
    this.deps.refreshWritableFlags()
    this.deps.markSessionTabsInventoryPublished()
  }
}
