export type SubscriptionRegistration = Readonly<{
  /** Tears down only if this registration still owns the id; otherwise a no-op. */
  releaseIfCurrent: () => void
}>

export type RuntimeDisposalTreeDeps = {
  logger?: Console
}

/**
 * RuntimeDisposalTree manages the lifecycle of subscriptions, timers, and resource cleanups.
 * Handles subscription registration/deregistration with connection tracking,
 * async cleanup execution and retry logic, and pending restore timer management.
 */
export class RuntimeDisposalTree {
  // Subscription cleanup state
  private subscriptionCleanups = new Map<string, () => void | Promise<void>>()
  private subscriptionCleanupPromises = new Map<
    string,
    { cleanup: () => void | Promise<void>; promise: Promise<void> }
  >()
  private subscriptionsByConnection = new Map<string, Set<string>>()
  private subscriptionConnectionByEntry = new Map<string, string>()

  // Timer management state
  private pendingRestoreTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >()

  constructor(private deps: RuntimeDisposalTreeDeps) {}

  // ─── Subscription Cleanup API ──────────────────────────────────────

  registerSubscriptionCleanup(
    subscriptionId: string,
    cleanup: () => void | Promise<void>,
    connectionId?: string
  ): void {
    const existing = this.subscriptionCleanups.get(subscriptionId)
    if (existing) {
      this.removeSubscriptionConnectionIndex(subscriptionId)
      this.cleanupOwnedSubscription(subscriptionId, existing)
    }
    this.subscriptionCleanups.set(subscriptionId, cleanup)
    if (connectionId) {
      let set = this.subscriptionsByConnection.get(connectionId)
      if (!set) {
        set = new Set()
        this.subscriptionsByConnection.set(connectionId, set)
      }
      set.add(subscriptionId)
      this.subscriptionConnectionByEntry.set(subscriptionId, connectionId)
    }
  }

  registerOwnedSubscriptionCleanup(
    subscriptionId: string,
    cleanup: () => void | Promise<void>,
    connectionId?: string
  ): SubscriptionRegistration {
    this.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
    return {
      releaseIfCurrent: () => this.cleanupOwnedSubscription(subscriptionId, cleanup)
    }
  }

  cleanupSubscription(subscriptionId: string): void {
    void this.cleanupSubscriptionAndWait(subscriptionId).catch((error) => {
      this.deps.logger?.error(`[runtime] subscription cleanup failed for ${subscriptionId}:`, error)
    })
  }

  cleanupSubscriptionIfOwnedByConnection(
    subscriptionId: string,
    connectionId: string | undefined
  ): boolean {
    if (!connectionId) {
      this.cleanupSubscription(subscriptionId)
      return true
    }
    if (!this.subscriptionCleanups.has(subscriptionId)) {
      return true
    }
    if (this.subscriptionConnectionByEntry.get(subscriptionId) !== connectionId) {
      return false
    }
    this.cleanupSubscription(subscriptionId)
    return true
  }

  private cleanupOwnedSubscription(
    subscriptionId: string,
    expectedCleanup: () => void | Promise<void>
  ): void {
    if (this.subscriptionCleanups.get(subscriptionId) !== expectedCleanup) {
      return
    }
    this.cleanupSubscription(subscriptionId)
  }

  retrySubscriptionCleanupAfter(
    subscriptionId: string,
    cleanupOwner: () => void | Promise<void>,
    gate: Promise<void>
  ): void {
    const failedGeneration = this.subscriptionCleanupPromises.get(subscriptionId)
    void gate.then(
      async () => {
        await (failedGeneration?.cleanup === cleanupOwner
          ? failedGeneration.promise.catch(() => undefined)
          : undefined)
        while (this.subscriptionCleanups.get(subscriptionId) === cleanupOwner) {
          const newerGeneration = this.subscriptionCleanupPromises.get(subscriptionId)
          if (newerGeneration?.cleanup === cleanupOwner) {
            await newerGeneration.promise.catch(() => undefined)
            continue
          }
          this.cleanupSubscription(subscriptionId)
          return
        }
      },
      () => undefined
    )
  }

  async cleanupSubscriptionAndWait(subscriptionId: string): Promise<void> {
    const cleanup = this.subscriptionCleanups.get(subscriptionId)
    if (!cleanup) {
      return
    }
    const inFlight = this.subscriptionCleanupPromises.get(subscriptionId)
    if (inFlight?.cleanup === cleanup) {
      return inFlight.promise
    }
    let cleanupResult: void | Promise<void>
    try {
      cleanupResult = cleanup()
    } catch (error) {
      cleanupResult = Promise.reject(error)
    }
    const promise = Promise.resolve(cleanupResult)
      .then(() => {
        if (this.subscriptionCleanups.get(subscriptionId) !== cleanup) {
          return
        }
        this.subscriptionCleanups.delete(subscriptionId)
        this.removeSubscriptionConnectionIndex(subscriptionId)
      })
      .finally(() => {
        if (this.subscriptionCleanupPromises.get(subscriptionId)?.promise === promise) {
          this.subscriptionCleanupPromises.delete(subscriptionId)
        }
      })
    this.subscriptionCleanupPromises.set(subscriptionId, { cleanup, promise })
    return promise
  }

  private removeSubscriptionConnectionIndex(subscriptionId: string): void {
    const connectionId = this.subscriptionConnectionByEntry.get(subscriptionId)
    if (connectionId) {
      this.subscriptionConnectionByEntry.delete(subscriptionId)
      const set = this.subscriptionsByConnection.get(connectionId)
      if (set) {
        set.delete(subscriptionId)
        if (set.size === 0) {
          this.subscriptionsByConnection.delete(connectionId)
        }
      }
    }
  }

  cleanupSubscriptionsByPrefix(prefix: string): void {
    const ids = Array.from(this.subscriptionCleanups.keys()).filter((id) => id.startsWith(prefix))
    for (const id of ids) {
      this.cleanupSubscription(id)
    }
  }

  cleanupSubscriptionsForConnection(connectionId: string): void {
    const set = this.subscriptionsByConnection.get(connectionId)
    if (!set) {
      return
    }
    const ids = Array.from(set)
    for (const id of ids) {
      if (this.subscriptionConnectionByEntry.get(id) !== connectionId) {
        set.delete(id)
        continue
      }
      this.cleanupSubscription(id)
    }
    if (set.size === 0) {
      this.subscriptionsByConnection.delete(connectionId)
    }
  }

  // ─── Timer Management API ──────────────────────────────────────────

  schedulePendingRestoreTimer(
    ptyId: string,
    timer: ReturnType<typeof setTimeout>,
    clientId: string
  ): void {
    this.pendingRestoreTimers.set(ptyId, { timer, clientId })
  }

  getPendingRestoreTimer(ptyId: string): ReturnType<typeof setTimeout> | null {
    return this.pendingRestoreTimers.get(ptyId)?.timer ?? null
  }

  cancelPendingRestoreTimer(ptyId: string): void {
    const entry = this.pendingRestoreTimers.get(ptyId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }
  }

  cancelAllPendingRestoreTimers(): void {
    for (const [, entry] of this.pendingRestoreTimers) {
      clearTimeout(entry.timer)
    }
    this.pendingRestoreTimers.clear()
  }

  hasPendingRestoreTimer(ptyId: string): boolean {
    return this.pendingRestoreTimers.has(ptyId)
  }

  getPendingRestoreTimers(): Map<string, { timer: ReturnType<typeof setTimeout>; clientId: string }> {
    return new Map(this.pendingRestoreTimers)
  }

  cancelPendingRestoreTimersByClientId(clientId: string): void {
    const ptysToCancel: string[] = []
    for (const [ptyId, entry] of this.pendingRestoreTimers) {
      if (entry.clientId === clientId) {
        ptysToCancel.push(ptyId)
      }
    }
    for (const ptyId of ptysToCancel) {
      this.cancelPendingRestoreTimer(ptyId)
    }
  }

  // ─── Batch Cleanup Operations ──────────────────────────────────────

  clearAllSubscriptions(): void {
    for (const cleanup of this.subscriptionCleanups.values()) {
      try {
        const result = cleanup()
        if (result instanceof Promise) {
          result.catch((error) => {
            this.deps.logger?.error('[runtime] batch subscription cleanup failed:', error)
          })
        }
      } catch (error) {
        this.deps.logger?.error('[runtime] batch subscription cleanup failed:', error)
      }
    }
    this.subscriptionCleanups.clear()
    this.subscriptionCleanupPromises.clear()
    this.subscriptionsByConnection.clear()
    this.subscriptionConnectionByEntry.clear()
  }

  clearAllTimers(): void {
    this.cancelAllPendingRestoreTimers()
  }

  clearAll(): void {
    this.clearAllSubscriptions()
    this.clearAllTimers()
  }

  // ─── Introspection ────────────────────────────────────────────────

  getSubscriptionCount(): number {
    return this.subscriptionCleanups.size
  }

  getConnectionSubscriptionIds(connectionId: string): string[] {
    const set = this.subscriptionsByConnection.get(connectionId)
    return set ? Array.from(set) : []
  }

  getPendingRestoreTimerCount(): number {
    return this.pendingRestoreTimers.size
  }
}
