/** Read-only query interface for worktree state. Narrows public surface to worktree inspection. */

export type OrcaWorktreeQueryFacade = {
  /** Get a worktree record by worktree ID. */
  getWorktreeById(worktreeId: string): unknown

  /** List all worktree IDs currently known to the runtime. */
  listWorktrees(): string[]

  /** Get worktree status: 'ready' | 'scanning' | 'unavailable'. */
  getWorktreeStatus(worktreeId: string): 'ready' | 'scanning' | 'unavailable'

  /** Resolve worktree filesystem path. */
  resolveWorktreePath(worktreeId: string): string | undefined

  /** Get repository ID for a worktree. */
  getRepositoryIdForWorktree(worktreeId: string): string | undefined

  /** Get worktree's current branch. */
  getWorktreeBranch(worktreeId: string): string | undefined
}
