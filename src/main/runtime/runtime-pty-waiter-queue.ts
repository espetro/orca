import type {
  RuntimeLeafRecord,
  MessageWaiter,
  RuntimePtyWorktreeRecord,
  TerminalWaiter,
  MessageWaitResult
} from './orca-runtime'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import { buildPtyTerminalWaitResult, buildTerminalWaitResult } from './runtime-tail-projection'
import type { RuntimePtyWorktrees, RuntimePtyWorktreesDeps } from './runtime-pty-worktrees'

export class RuntimePtyWaiterQueue {
  constructor(
    private readonly host: RuntimePtyWorktrees,
    private readonly deps: RuntimePtyWorktreesDeps
  ) {}

  bindTerminalWaiterAbort(waiter: TerminalWaiter, signal: AbortSignal | undefined): boolean {
    if (!signal) {
      return true
    }
    if (signal.aborted) {
      return false
    }
    const onAbort = (): void => {
      this.removeWaiter(waiter)
      waiter.reject(new Error('request_aborted'))
    }
    waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    return true
  }

  cancelMessageWaiters(handle: string): void {
    const waiters = this.deps.messageWaitersByHandle().get(handle)
    if (!waiters) {
      return
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- waiters is mutated during iteration
    for (const waiter of [...waiters]) {
      this.resolveMessageWaiter(waiter, 'cancelled')
    }
  }

  rejectAllWaiters(code: string): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- map is mutated during iteration
    for (const handle of [...this.deps.waitersByHandle().keys()]) {
      this.rejectWaitersForHandle(handle, code)
    }
  }

  rejectWaitersForHandle(handle: string, code: string): void {
    const waiters = this.deps.waitersByHandle().get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- waiters is mutated during iteration
    for (const waiter of [...waiters]) {
      this.removeWaiter(waiter)
      waiter.reject(new Error(code))
    }
  }

  removeMessageWaiter(waiter: MessageWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
      waiter.timeout = null
    }
    if (waiter.abortCleanup) {
      waiter.abortCleanup()
      waiter.abortCleanup = null
    }
    const waiters = this.deps.messageWaitersByHandle().get(waiter.handle)
    if (waiters) {
      waiters.delete(waiter)
      if (waiters.size === 0) {
        this.deps.messageWaitersByHandle().delete(waiter.handle)
      }
    }
  }

  removeWaiter(waiter: TerminalWaiter): void {
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
    const waiters = this.deps.waitersByHandle().get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.deps.waitersByHandle().delete(waiter.handle)
    }
  }

  resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.host.issueHandle(leaf)
    if (!handle) {
      return
    }
    const waiters = this.deps.waitersByHandle().get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- waiters is mutated during iteration
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'exit', leaf))
      } else {
        // Why: after exit, conditions like tui-idle can never be satisfied — reject now instead of spinning the poll until timeout on a dead process.
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  resolveHandleForTab(tabId: string): string | null {
    for (const leaf of this.deps.leaves().values()) {
      if (leaf.tabId === tabId && leaf.ptyId !== null) {
        return this.host.issueHandle(leaf)
      }
    }
    return null
  }

  resolveMessageWaiter(waiter: MessageWaiter, result: MessageWaitResult): void {
    this.removeMessageWaiter(waiter)
    waiter.resolve(result)
  }

  resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.deps.handleByPtyId().get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.deps.waitersByHandle().get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- waiters is mutated during iteration
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'exit', pty))
      } else {
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    const candidateHandle =
      this.deps.handleByLeafKey().get(leafKey) ??
      (leaf.ptyId
        ? (this.deps.handleByPtyId().get(leaf.ptyId) ??
          this.deps.handleByPtyIncarnation().get(leaf.ptyId)?.handle)
        : undefined)
    if (!candidateHandle || !this.deps.waitersByHandle().has(candidateHandle)) {
      return
    }
    const handle = this.host.issueHandle(leaf)
    const waiters = this.deps.waitersByHandle().get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- waiters is mutated during iteration
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'tui-idle', leaf))
      }
    }
  }

  resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.removeWaiter(waiter)
    waiter.resolve(result)
  }

  waitForLeafPtyId(handle: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    const leaf = this.host.resolveLeafForHandle(handle)
    if (leaf?.ptyId) {
      return Promise.resolve(leaf.ptyId)
    }

    // Why: ptyId null→real invalidates the old handle; capture tabId+leafId now for direct leaf lookup afterward.
    const record = this.deps.handles().get(handle)
    const savedTabId = record?.tabId ?? null
    const savedLeafId = record?.leafId ?? null

    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let check: () => void = () => {}
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        const idx = this.deps.graphSyncCallbacks().indexOf(check)
        if (idx !== -1) {
          this.deps.graphSyncCallbacks().splice(idx, 1)
        }
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (ptyId: string): void => {
        cleanup()
        resolve(ptyId)
      }
      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        fail(new Error('request_aborted'))
      }
      if (signal?.aborted) {
        reject(new Error('request_aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        fail(new Error('Timed out waiting for PTY to spawn'))
      }, timeoutMs)

      check = (): void => {
        // Try the handle first (works if handle wasn't invalidated yet)
        let ptyId = this.host.resolveLeafForHandle(handle)?.ptyId
        // Why: ptyId null→real invalidates the old handle; fall back to direct leaf lookup by saved coordinates.
        if (!ptyId && savedTabId && savedLeafId) {
          const directLeaf = this.deps.leaves().get(this.deps.getLeafKey(savedTabId, savedLeafId))
          ptyId = directLeaf?.ptyId ?? null
        }
        if (ptyId) {
          finish(ptyId)
        }
      }
      this.deps.graphSyncCallbacks().push(check)
      check()
    })
  }

  waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    const existing = this.resolveHandleForTab(tabId)
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.deps.graphSyncCallbacks().indexOf(check)
        if (idx !== -1) {
          this.deps.graphSyncCallbacks().splice(idx, 1)
        }
        reject(new Error('Timed out waiting for terminal handle after creation'))
      }, timeoutMs)

      const check = (): void => {
        const handle = this.resolveHandleForTab(tabId)
        if (handle) {
          clearTimeout(timer)
          const idx = this.deps.graphSyncCallbacks().indexOf(check)
          if (idx !== -1) {
            this.deps.graphSyncCallbacks().splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.deps.graphSyncCallbacks().push(check)
      // Why: graph sync may have fired between the initial check and registration; re-check to avoid a missed wake-up.
      check()
    })
  }
}
