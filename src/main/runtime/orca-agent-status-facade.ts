/** Write-only interface for agent status reporting. Narrows public surface to agent status updates. */

export type OrcaAgentStatusFacade = {
  /** Report agent status update for a terminal handle. */
  reportAgentStatus(handle: string, status: unknown): Promise<void>

  /** Publish agent status update to subscribers. */
  publishAgentStatusUpdate(ptyId: string, status: unknown): void

  /** Notify subscribers of agent status change. */
  notifyAgentStatusChanged(ptyId: string): void

  /** Get current agent status for a terminal handle. */
  getAgentStatus(handle: string): unknown | undefined

  /** Mark agent exit confirmed for a PTY. */
  confirmAgentExit(ptyId: string): void
}
