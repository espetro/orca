import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeVisibilitySourceMatcher } from '../../shared/worktree/visibility-sources'
import { getRuntimeFileTargetExecutionHostId } from './orca-runtime-files'
import { findRuntimeWorkspaceFileOwner } from '../../shared/runtime-workspace-file-owner'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ResolvedWorktree, RuntimeStore } from './orca-runtime'

export type RuntimeWorkspaceFileTargetCommandsDeps = {
  store: RuntimeStore | null
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  buildRuntimeVisibilitySourceMatchersByRepoId: (
    worktrees: readonly Worktree[],
    visibilityDefaults?: GlobalSettings['worktreeVisibilityDefaults']
  ) => Map<string, WorktreeVisibilitySourceMatcher>
  isRuntimeWorktreeVisible: (
    worktree: Worktree,
    matcher?: WorktreeVisibilitySourceMatcher,
    settings?: ReturnType<RuntimeStore['getSettings']>
  ) => boolean
  resolveFolderWorkspaceConnectionId: (
    folderWorkspace: FolderWorkspace
  ) => string | null | undefined
  folderWorkspaceToResolvedWorktree: (folderWorkspace: FolderWorkspace) => ResolvedWorktree
}

export class RuntimeWorkspaceFileTargetCommands {
  constructor(private readonly deps: RuntimeWorkspaceFileTargetCommandsDeps) {}

  async resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
    relativePath: string
  } | null> {
    const targets = new Map<
      string,
      {
        worktree: ResolvedWorktree
        connectionId?: string
        executionHostId: ExecutionHostId
      }
    >()
    const resolvedWorktrees = await this.deps.listResolvedWorktrees()
    const settings = this.deps.store?.getSettings()
    const visibilitySourceMatchersByRepoId = this.deps.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolvedWorktrees,
      settings?.worktreeVisibilityDefaults
    )
    for (const worktree of resolvedWorktrees) {
      if (
        !this.deps.isRuntimeWorktreeVisible(
          worktree,
          visibilitySourceMatchersByRepoId.get(worktree.repoId),
          settings
        )
      ) {
        continue
      }
      const candidateConnectionId =
        this.deps.store?.getRepo(worktree.repoId)?.connectionId ?? undefined
      const target = {
        worktree,
        executionHostId: getRuntimeFileTargetExecutionHostId({
          worktree,
          connectionId: candidateConnectionId
        }),
        ...(candidateConnectionId ? { connectionId: candidateConnectionId } : {})
      }
      targets.set(`${target.executionHostId}\0${worktree.id}`, target)
    }
    for (const folderWorkspace of this.deps.store?.getFolderWorkspaces?.() ?? []) {
      try {
        const candidateConnectionId =
          this.deps.resolveFolderWorkspaceConnectionId(folderWorkspace) ?? undefined
        const worktree = this.deps.folderWorkspaceToResolvedWorktree(folderWorkspace)
        const target = {
          worktree,
          executionHostId: getRuntimeFileTargetExecutionHostId({
            worktree,
            connectionId: candidateConnectionId
          }),
          ...(candidateConnectionId ? { connectionId: candidateConnectionId } : {})
        }
        targets.set(`${target.executionHostId}\0${worktree.id}`, target)
      } catch {
        // An ambiguous folder workspace has no single filesystem authority.
      }
    }

    const owner = findRuntimeWorkspaceFileOwner(
      [...targets.values()].map((target) => ({
        workspaceId: target.worktree.id,
        rootPath: target.worktree.path,
        executionHostId: target.executionHostId
      })),
      absolutePath,
      executionHostId
    )
    if (!owner) {
      return null
    }
    const target = targets.get(`${owner.executionHostId}\0${owner.workspaceId}`)
    return target ? { ...target, relativePath: owner.relativePath } : null
  }
}
