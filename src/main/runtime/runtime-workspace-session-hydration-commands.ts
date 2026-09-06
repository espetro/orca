import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeStore } from './orca-runtime'

export type RuntimeWorkspaceSessionHydrationCommandsDeps = {
  store: () => RuntimeStore | null
  resolveFolderWorkspaceConnectionId: (workspace: FolderWorkspace) => string | null
  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: (
    session: WorkspaceSessionState,
    worktreeId: string,
    tabs: unknown
  ) => boolean
}

export class RuntimeWorkspaceSessionHydrationCommands {
  constructor(private readonly deps: RuntimeWorkspaceSessionHydrationCommandsDeps) {}

  getWorkspaceSessionHydrationTargets(
    includeAllPersistedWorktrees: boolean
  ): Map<string, WorkspaceSessionState> {
    const store = this.deps.store()
    const repos = store?.getRepos?.() ?? []
    const repoHostIdByRepoId = new Map(
      repos.map((repo) => [repo.id, getRepoExecutionHostId(repo)] as const)
    )
    const folderHostIdByWorkspaceId = new Map(
      (store?.getFolderWorkspaces?.() ?? []).map((workspace) => {
        const connectionId = this.deps.resolveFolderWorkspaceConnectionId(workspace)
        return [
          workspace.id,
          connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
        ] as const
      })
    )
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }

    const targets = new Map<string, WorkspaceSessionState>()
    for (const hostId of hostIds) {
      const session = store?.getWorkspaceSession?.(hostId)
      if (!session) {
        continue
      }
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        const scope = parseWorkspaceKey(worktreeId)
        const ownerHostId =
          scope?.type === 'folder'
            ? (folderHostIdByWorkspaceId.get(scope.folderWorkspaceId) ?? null)
            : (repoHostIdByRepoId.get(
                getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : worktreeId)
              ) ?? LOCAL_EXECUTION_HOST_ID)
        if (
          ownerHostId === hostId &&
          (includeAllPersistedWorktrees ||
            this.deps.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
              session,
              worktreeId,
              tabs
            ))
        ) {
          targets.set(worktreeId, session)
        }
      }
    }
    return targets
  }
}
