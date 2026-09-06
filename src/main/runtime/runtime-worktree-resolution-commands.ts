import type {
  ResolvedWorktree,
  RuntimeWorktreeRemovalTarget,
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './orca-runtime'
import type { RuntimeMobileSessionMarkdownTab } from '../../shared/runtime-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { WorktreeIdRequiresFullPathError } from './orca-runtime'
import {
  branchSelectorMatches,
  getExplicitWorktreeIdSelector,
  runtimePathsEqual
} from './runtime-tail-projection'
import type { RuntimeManagedWorktreesDeps } from './runtime-managed-worktrees'
import {
  WORKTREE_ID_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdComparisonKey
} from '../../shared/worktree/id'
import { parseExactWorktreeIdSelector } from './runtime-worktree-git-shared'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { resolveLocalProjectRuntimeForWorktreeId } from '../../main/local-project-runtime-resolution'
import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'

/** Facade methods the resolution commands reach back into. */
export type RuntimeWorktreeResolutionCommandsHost = {
  resolveLineageForWorktreeCreate: (
    input?: WorktreeLineageInput
  ) => Promise<WorktreeLineageResolution>
}

export type RuntimeWorktreeResolutionCommandsDeps = Pick<
  RuntimeManagedWorktreesDeps,
  | 'store'
  | 'requireStore'
  | 'hasFreshResolvedWorktreeCache'
  | 'resolveExplicitWorktreeIdScoped'
  | 'buildResolvedWorktreeFromId'
  | 'listResolvedWorktrees'
  | 'getRuntimeId'
  | 'getStartedAt'
  | 'resolveFolderWorkspaceConnectionId'
  | 'graphStatus'
  | 'tabs'
  | 'mobileSessionTabsByWorktree'
>

export class RuntimeWorktreeResolutionCommands {
  constructor(private deps: RuntimeWorktreeResolutionCommandsDeps) {}

  getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    const repos = this.deps.store?.getRepos?.() ?? []
    const repoIds = new Set(repos.map((repo) => repo.id))
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    const worktreeIds = new Set<string>()
    for (const hostId of hostIds) {
      const session = this.deps.store?.getWorkspaceSession?.(hostId)
      for (const worktreeId of Object.keys(session?.tabsByWorktree ?? {})) {
        if (repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
          worktreeIds.add(worktreeId)
        }
      }
    }
    return worktreeIds
  }

  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    let worktreeId = this.deps.store?.getWorkspaceSession?.()?.activeWorktreeId ?? null
    if (!worktreeId && this.deps.graphStatus() === 'ready') {
      for (const tab of this.deps.tabs().values()) {
        if (tab.activeLeafId && tab.worktreeId) {
          worktreeId = tab.worktreeId
          break
        }
      }
    }
    if (!worktreeId) {
      return null
    }
    try {
      const resolved = await this.resolveWorktreeSelector(`id:${worktreeId}`)
      return {
        worktreeId: resolved.id,
        path: resolved.git.path,
        branch: resolved.git.branch,
        displayName: resolved.displayName
      }
    } catch {
      return null
    }
  }

  resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    const repo = worktree?.repoId ? this.deps.requireStore().getRepo(worktree.repoId) : undefined
    const executionHostId = worktree
      ? getWorktreeExecutionHostId(worktree, repo)
      : LOCAL_EXECUTION_HOST_ID
    const parsedHost = parseExecutionHostId(executionHostId)
    return resolveRuntimeBrowserNetworkExecutionHost({
      runtimeId: this.deps.getRuntimeId(),
      runtimeRevision: this.deps.getStartedAt(),
      executionHostId,
      ...(worktree
        ? {
            projectRuntime: resolveLocalProjectRuntimeForWorktreeId(
              this.deps.requireStore(),
              worktree.id
            )
          }
        : {}),
      ...(parsedHost?.kind === 'ssh'
        ? { sshState: getRegisteredSshState(parsedHost.targetId) }
        : {})
    })
  }

  async resolveMobileMarkdownWorktreeId(worktreeSelector: string, tabId: string): Promise<string> {
    const worktreeId =
      this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.deps.store && worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(this.deps.requireStore(), worktreeId)
      : undefined
  }

  async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    try {
      const exactTarget = parseExactWorktreeIdSelector(worktreeSelector)
      const worktree =
        exactTarget && requiredHostId
          ? ((await this.deps.resolveExplicitWorktreeIdScoped(exactTarget.id, requiredHostId)) ??
            (() => {
              throw new Error('selector_not_found')
            })())
          : await this.resolveWorktreeSelector(worktreeSelector)
      const removalTarget = {
        id: worktree.id,
        repoId: worktree.repoId,
        path: worktree.path
      }
      return worktree.pushTarget
        ? { ...removalTarget, pushTarget: worktree.pushTarget }
        : removalTarget
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'selector_not_found') {
        throw error
      }
      const removalTarget = parseExactWorktreeIdSelector(worktreeSelector)
      const meta = removalTarget ? this.deps.store?.getWorktreeMeta(removalTarget.id) : undefined
      if (
        !removalTarget ||
        !meta ||
        (requiredHostId !== undefined && meta.hostId !== requiredHostId)
      ) {
        throw error
      }
      // Why: delete requests can arrive after Git no longer lists the worktree.
      // Only exact IDs with persisted Orca metadata are accepted here so
      // branch/path selectors cannot resolve to an arbitrary missing path.
      return meta.pushTarget ? { ...removalTarget, pushTarget: meta.pushTarget } : removalTarget
    }
  }

  async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(selector)
    // Why only `id:`: every other selector kind is matched across the whole fleet, and their
    // `selector_ambiguous` contract is defined over all repos. Scoping those would silently pick a
    // winner where today they correctly refuse. An `id:` selector already names its repo.
    if (explicitWorktreeId && !this.deps.hasFreshResolvedWorktreeCache()) {
      const scoped = await this.deps.resolveExplicitWorktreeIdScoped(explicitWorktreeId)
      if (scoped) {
        return scoped
      }
    }
    const worktrees = await this.deps.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('identity:')) {
      const identityKey = selector.slice('identity:'.length)
      candidates = worktrees.filter((worktree) => worktree.identity?.key === identityKey)
    } else if (selector.startsWith('id:')) {
      const worktreeId = explicitWorktreeId ?? selector.slice(3)
      candidates = worktrees.filter((worktree) => worktree.id === worktreeId)
      if (candidates.length === 0) {
        // Why (#16243): `id:` is the only shape the renderer can send, and a stored id can spell
        // its path differently from the scan — the divergence `path:` has always absorbed.
        // The bare unprefixed branch below stays byte-exact on purpose: only `id:` reaches a
        // renderer caller, so `id:repo::p/` folds here while bare `repo::p/` still misses.
        const comparisonKey = worktreeIdComparisonKey(worktreeId)
        candidates = comparisonKey
          ? worktrees.filter((worktree) => worktreeIdComparisonKey(worktree.id) === comparisonKey)
          : candidates
      }
      if (candidates.length === 0) {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        const repo = parsed ? this.deps.store?.getRepo(parsed.repoId) : null
        const fallback =
          repo?.connectionId && this.deps.store?.getWorktreeMeta(worktreeId)
            ? this.deps.buildResolvedWorktreeFromId(worktreeId)
            : null
        if (fallback !== null) {
          candidates = [fallback]
        }
      }
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) =>
        runtimePathsEqual(worktree.path, selector.slice(5))
      )
      if (candidates.length > 1) {
        const hostIds = new Set(
          candidates.map((worktree) => {
            const repo = this.deps.store?.getRepo(worktree.repoId)
            return getWorktreeExecutionHostId(worktree, repo)
          })
        )
        // Why: duplicate registrations on one host describe one path; identical paths on different hosts do not.
        if (hostIds.size === 1) {
          candidates = [candidates[0]]
        }
      }
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('name:')) {
      // Keep display-name matching exact so duplicate names hit the same ambiguity path as other selectors.
      candidates = worktrees.filter((worktree) => worktree.displayName === selector.slice(5))
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          runtimePathsEqual(worktree.path, selector) ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    this.deps.store?.setWorkspaceSession?.(
      session,
      this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    )
  }

  tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const workspace = this.deps.store
        ?.getFolderWorkspaces?.()
        .find((entry) => entry.id === scope.folderWorkspaceId)
      if (!workspace) {
        return null
      }
      if (workspace.executionHostId != null) {
        return parseExecutionHostId(workspace.executionHostId)?.id ?? null
      }
      const connectionId = this.deps.resolveFolderWorkspaceConnectionId(workspace)
      return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
    }
    const resolvedWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
    const repo = this.deps.store?.getRepo?.(getRepoIdFromWorktreeId(resolvedWorktreeId))
    return repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
  }

  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    return hostId ? (this.deps.store?.getWorkspaceSession?.(hostId) ?? null) : null
  }

  getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    if (!hostId) {
      throw new Error('folder_workspace_not_found')
    }
    return hostId
  }

  getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    const worktreeId = getExplicitWorktreeIdSelector(selector)
    if (
      worktreeId &&
      !worktreeId.includes(WORKTREE_ID_SEPARATOR) &&
      this.deps.store?.getRepo(worktreeId)
    ) {
      // Why: a registered repo id is a known-invalid worktree id; reject early before fast paths or Git/SSH scans hide the mistake.
      throw new WorktreeIdRequiresFullPathError()
    }
    return worktreeId
  }

  folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    return {
      ...worktree,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        isBare: worktree.isBare,
        isMainWorktree: worktree.isMainWorktree
      }
    }
  }
}
