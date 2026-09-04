/** Write-only interface for mobile notification publishing. Narrows public surface to mobile updates. */

export type OrcaMobilePublishFacade = {
  /** Publish mobile session tab snapshot for a worktree. */
  publishMobileSessionTabs(worktreeId: string): Promise<void>

  /** Notify subscribers of mobile session tab state change. */
  notifyMobileSubscriber(worktreeId: string, clientNavigationId?: string): Promise<unknown>

  /** Publish mobile layout/viewport update. */
  publishMobileLayout(worktreeId: string, update: unknown): Promise<void>

  /** Schedule mobile session tabs notification for deferred flush. */
  scheduleMobileSessionTabsChanged(worktreeId: string): void

  /** Cancel any pending scheduled mobile session tabs notification. */
  cancelScheduledMobileSessionTabsChanged(worktreeId: string): void
}
