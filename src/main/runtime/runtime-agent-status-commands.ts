import type { RuntimeAgentStatusCommandsDeps } from './runtime-agent-status-commands-deps'

export class RuntimeAgentStatusCommands {
  constructor(private readonly deps: RuntimeAgentStatusCommandsDeps) {}

  isAgentWrapperForegroundProcess = (processName: string): boolean => {
    return this.deps.isAgentForegroundWrapperProcess(processName)
  }

  getPrimaryLeafForPty = (ptyId: string) => {
    return this.deps.getLeavesForPty(ptyId)[0] ?? null
  }

  deliverPendingMessagesForHandle = (handle: string, reservedTypes?: ReadonlySet<string>): void => {
    return this.deps.orchestrationMailboxNotifications.deliverForHandle(handle, reservedTypes)
  }

  writeOrchestrationPointerPty = (ptyId: string, data: string): boolean | Promise<boolean> => {
    return this.deps.orchestrationCommands.writeOrchestrationPointerPty(ptyId, data)
  }

  retireOrchestrationMailboxDeliveryForPty = (ptyId: string): void => {
    this.deps.orchestrationMailboxNotifications.retirePty(ptyId)
    for (const leaf of this.deps.getLeavesForPty(ptyId)) {
      const handle = this.deps.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        this.deps.mailPointerRepointScheduler.schedule(handle)
      }
      const run = this.deps.orchestrationDb?.getCurrentRunForPane?.(`${leaf.tabId}:${leaf.leafId}`)
      if (run) {
        this.deps.mailPointerRepointScheduler.schedule(`run:${run.id}`)
      }
    }
  }

  scheduleRestoredMessageRepoints = (): void => {
    let handles: string[]
    try {
      handles = this.deps.orchestrationDb?.getUndeliveredUnreadMailboxHandles?.() ?? []
    } catch (error) {
      console.warn('[orchestration] failed to scan restored mailboxes', error)
      return
    }
    for (const handle of handles) {
      try {
        if (handle.startsWith('dispatch:')) {
          continue
        }
        if (handle.startsWith('run:')) {
          this.deps.mailPointerRepointScheduler.schedule(handle)
          continue
        }
        const routed = this.deps.orchestrationMailboxOwner.routeDetachedDirectMessages(handle)
        for (const mailbox of routed.mailboxes) {
          this.deps.mailPointerRepointScheduler.schedule(mailbox.mailboxHandle)
        }
        if (!routed.hasMore) {
          this.deps.mailPointerRepointScheduler.schedule(handle)
        }
      } catch (error) {
        console.warn(`[orchestration] failed to restore mailbox ${handle}`, error)
        this.deps.mailPointerRepointScheduler.schedule(handle)
      }
    }
  }

  repointPendingMessagesForHandle = (handle: string): void => {
    try {
      this.deliverPendingMessagesForHandle(handle)
    } catch {
      // unref'd repair can outlive test/runtime-owned database during shutdown
    }
  }

  deliverPendingMessagesForLeaf = (leaf: any): void => {
    this.deps.orchestrationMailboxNotifications.deliverForLeaf(leaf)
  }

  notifyMessageArrived = (handle: string, messageType?: string): void => {
    if (!handle.startsWith('dispatch:')) {
      this.deps.mailPointerRepointScheduler.schedule(handle)
    }
    this.deps.orchestrationMailboxNotifications.notifyMessageArrived(handle, messageType)
  }

  waitForMessage = (
    handle: string,
    options?: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
      exclusive?: boolean
    }
  ) => {
    return this.deps.waitForMessageImpl(handle, options)
  }

  cancelMessageWaiters = (handle: string): void => {
    return this.deps.cancelMessageWaitersImpl(handle)
  }

  resolveMessageWaiter = (waiter: any, result: any): void => {
    return this.deps.removeMessageWaiter(waiter)
  }

  removeMessageWaiter = (waiter: any): void => {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    if (waiter.pollInterval) {
      clearInterval(waiter.pollInterval)
    }
    if (waiter.abortCleanup) {
      waiter.abortCleanup()
      waiter.abortCleanup = null
    }
    const waiters = this.deps.messageWaitersByHandle.get(waiter.handle)
    if (waiters) {
      waiters.delete(waiter)
      if (waiters.size === 0) {
        this.deps.messageWaitersByHandle.delete(waiter.handle)
      }
    }
  }

  buildPtyTerminalSummary = (pty: any, worktreesById: Map<string, any>) => {
    return this.deps.buildPtyTerminalSummaryImpl(pty, worktreesById)
  }

  getLiveLeafForHandle = (handle: string) => {
    return this.deps.getLiveLeafForHandleImpl(handle)
  }

  getLivePtyForHandle = (handle: string) => {
    return this.deps.getLivePtyForHandleImpl(handle)
  }

  assertLiveTerminalHandleTargetsPty = (handle: string, expectedPtyId: string): void => {
    return this.deps.assertLiveTerminalHandleTargetsPtyImpl(handle, expectedPtyId)
  }

  readPtyTerminal = (handle: string, pty: any, opts?: { cursor?: number; limit?: number }) => {
    return this.deps.readPtyTerminalImpl(handle, pty, opts)
  }

  issueHandle = (leaf: any): string => {
    return this.deps.issueHandleImpl(leaf)
  }

  bindPtyIncarnationHandle = (retained: any, leaf: any): void => {
    return this.deps.bindPtyIncarnationHandleImpl(retained, leaf)
  }

  invalidatePtyIncarnationHandle = (ptyId: string): void => {
    return this.deps.invalidatePtyIncarnationHandleImpl(ptyId)
  }

  clearPtyIncarnationHandles = (): void => {
    return this.deps.clearPtyIncarnationHandlesImpl()
  }

  reconcilePtyIncarnationHandles = (): void => {
    return this.deps.reconcilePtyIncarnationHandlesImpl()
  }

  adoptPreAllocatedHandle = (leaf: any): string | null => {
    return this.deps.adoptPreAllocatedHandleImpl(leaf)
  }

  issuePtyHandle = (pty: any): string => {
    return this.deps.issuePtyHandleImpl(pty)
  }

  findHandleForPtyRecord = (ptyId: string): string | null => {
    return this.deps.findHandleForPtyRecordImpl(ptyId)
  }

  refreshWritableFlags = (): void => {
    return this.deps.refreshWritableFlagsImpl()
  }

  invalidateLeafHandle = (leafKey: string): void => {
    return this.deps.invalidateLeafHandleImpl(leafKey)
  }

  adoptFirstPtyForLeafHandle = (leafKey: string, ptyId: string | null, ptyGeneration: number): boolean => {
    return this.deps.adoptFirstPtyForLeafHandleImpl(leafKey, ptyId, ptyGeneration)
  }

  rememberDetachedPreAllocatedLeaves = (): void => {
    return this.deps.rememberDetachedPreAllocatedLeavesImpl()
  }

  resolveExitWaiters = (leaf: any): void => {
    return this.deps.resolveExitWaitersImpl(leaf)
  }

  resolveTuiIdleWaiters = (leaf: any): void => {
    return this.deps.resolveTuiIdleWaitersImpl(leaf)
  }

  resolvePtyExitWaiters = (pty: any, ptyId: string): void => {
    return this.deps.resolvePtyExitWaitersImpl(pty, ptyId)
  }

  isPtyKnownExited = (ptyId: string): boolean => {
    return this.deps.isPtyKnownExitedImpl(ptyId)
  }

  notifyPtyExitListeners = (ptyId: string): void => {
    return this.deps.notifyPtyExitListenersImpl(ptyId)
  }

  resolvePtyTuiIdleWaiters = (pty: any, ptyId: string): void => {
    return this.deps.resolvePtyTuiIdleWaitersImpl(pty, ptyId)
  }

  startTuiIdleFallbackPoll = (waiter: any, leaf: any, waiterTimeoutMs: number): void => {
    return this.deps.startTuiIdleFallbackPollImpl(waiter, leaf, waiterTimeoutMs)
  }

  startPtyTuiIdleFallbackPoll = (waiter: any, pty: any, waiterTimeoutMs: number): void => {
    return this.deps.startPtyTuiIdleFallbackPollImpl(waiter, pty, waiterTimeoutMs)
  }

  startTuiIdleVisibleReadProbe = (waiter: any, waiterTimeoutMs: number): void => {
    return this.deps.startTuiIdleVisibleReadProbeImpl(waiter, waiterTimeoutMs)
  }

  buildTuiIdleProbeResult = (handle: string, blockedReason: any) => {
    return this.deps.buildTuiIdleProbeResultImpl(handle, blockedReason)
  }

  getAdoptedPtyExplicitIdleStatus = (pty: any) => {
    return this.deps.getAdoptedPtyExplicitIdleStatusImpl(pty)
  }

  resolveWaiter = (waiter: any, result: any): void => {
    this.removeMessageWaiter(waiter)
    waiter.resolve(result)
  }

  bindTerminalWaiterAbort = (waiter: any, signal: AbortSignal | undefined): boolean => {
    return this.deps.bindTerminalWaiterAbortImpl(waiter, signal)
  }

  rejectWaitersForHandle = (handle: string, code: string): void => {
    return this.deps.rejectWaitersForHandleImpl(handle, code)
  }

  rejectAllWaiters = (code: string): void => {
    return this.deps.rejectAllWaitersImpl(code)
  }

  private getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }
}
