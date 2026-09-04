/** Read-only query interface for terminal state. Narrows public surface to terminal inspection. */

export type OrcaTerminalQueryFacade = {
  /** Get a terminal record by PTY ID. */
  getTerminalById(ptyId: string): unknown

  /** List all active terminal records. */
  listTerminals(): unknown[]

  /** Get terminal status: 'live' | 'disconnected' | 'exited'. */
  getTerminalStatus(ptyId: string): 'live' | 'disconnected' | 'exited'

  /** Check if terminal is currently alive. */
  isTerminalAlive(ptyId: string): boolean

  /** Get terminal handle by PTY ID. */
  getTerminalHandleForPtyId(ptyId: string): string | undefined

  /** List all terminal handles. */
  listTerminalHandles(): string[]
}
