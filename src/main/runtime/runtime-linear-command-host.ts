import type { LinearCurrentIssueContextHints } from '../../shared/linear/agent-access'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeTerminalShow } from '../../shared/runtime-types'
import type { ResolvedWorktree } from '../../shared/worktree/types'

// Why: narrow closure surface for RuntimeLinearCommands so it can be unit-tested
// without constructing the full OrcaRuntimeService.
export type RuntimeLinearCommandHost = {
  readonly store: NonNullable<{
    getAllWorktreeMeta(): Record<string, unknown>
    getRepos(): unknown[]
    setWorktreeMeta(worktreeId: string, meta: { linkedLinearIssueWorkspaceId: string; linkedLinearIssueOrganizationUrlKey: string | null }): void
  }> | null
  showTerminal(handle: string): Promise<RuntimeTerminalShow>
  resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree>
  resolveWorktreeForContainedPath(cwd: string): Promise<ResolvedWorktree | null>
  listResolvedWorktrees(): Promise<ResolvedWorktree[]>
  emitClientEvent(event: RuntimeClientEvent): void
}

export type LinearResolveCurrentIssueContext = LinearCurrentIssueContextHints
