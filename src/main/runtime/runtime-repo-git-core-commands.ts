import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo, BaseRefSearchResult } from '../../shared/repo-types'
import type { RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from './runtime-tail-projection'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshGitCapabilityCache } from '../git/git-capability-state'
import {
  getBaseRefDefault,
  getRemoteCount,
  searchBaseRefDetails,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefDetails,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  buildSearchBaseRefsArgv,
  mergeBaseRefSearchResultGroups
} from '../git/repo'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'

export class RuntimeRepoGitCoreCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  private get self() {
    return this
  }

  async showRepo(repoSelector: string): Promise<Repo> {
    return await self.deps.resolveRepoSelector(repoSelector)
  }

  async setRepoBaseRef(repoSelector: string, baseRef: string): Promise<Repo> {
    if (!self.deps.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support base refs.')
    }
    const updated = self.deps.store.updateRepo(repo.id, {
      worktreeBaseRef: baseRef
    })
    if (!updated) {
      throw new Error('repo_not_found')
    }
    self.deps.invalidateResolvedWorktreeCache()
    self.deps.notifyReposChanged()
    return updated
  }

  async updateRepo(
    repoSelector: string,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'repoIcon'
        | 'upstream'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'worktreeBasePath'
        | 'kind'
        | 'symlinkPaths'
        | 'issueSourcePreference'
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeInboxBaselinePaths'
        | 'importedExternalWorktreePaths'
        | 'agentWorktreeVisibility'
        | 'customWorktreeVisibilitySources'
        | 'worktreeVisibilitySourcePreferences'
        | 'projectGroupId'
        | 'projectGroupOrder'
      >
    > & {
      externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
    }
  ): Promise<Repo> {
    if (!self.deps.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const sanitizedUpdates = omitUndefinedProperties(updates)
    if ('worktreeBasePath' in updates && updates.worktreeBasePath === undefined) {
      sanitizedUpdates.worktreeBasePath = undefined
    }
    if ('externalWorktreeVisibility' in updates && updates.externalWorktreeVisibility === null) {
      sanitizedUpdates.externalWorktreeVisibility = undefined
    }
    if (
      'externalWorktreeDiscoverySuppressedAt' in updates &&
      updates.externalWorktreeDiscoverySuppressedAt === null
    ) {
      sanitizedUpdates.externalWorktreeDiscoverySuppressedAt = undefined
    }
    if ('sourceControlAi' in updates && updates.sourceControlAi === null) {
      sanitizedUpdates.sourceControlAi = null
    }
    const updated = self.deps.store.updateRepo(repo.id, sanitizedUpdates)
    if (!updated) {
      throw new Error('repo_not_found')
    }
    if ('worktreeBasePath' in updates) {
      await prepareLocalWorktreeRootForRepo(self.deps.store, updated)
      invalidateAuthorizedRootsCache()
    }
    self.deps.invalidateResolvedWorktreeCache()
    if ('worktreeBasePath' in updates) {
      self.deps.invalidateWorktreeScanCacheForRepo(repo.id)
    }
    self.deps.notifyReposChanged()
    return updated
  }

  async removeProject(repoSelector: string): Promise<{ removed: true }> {
    if (!self.deps.store?.removeProject) {
      throw new Error('runtime_unavailable')
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    // Why: removeProject is id-only, but the same id may be registered on a sibling
    // execution host; a path:/name: selector resolves one row and must remove only it.
    const hostId = getRepoExecutionHostId(repo)
    const idExistsOnOtherHost = self.deps.store
      .getRepos()
      .some((entry) => entry.id === repo.id && getRepoExecutionHostId(entry) !== hostId)
    if (idExistsOnOtherHost) {
      if (!self.deps.store.removeProjectForHost) {
        throw new Error('runtime_unavailable')
      }
      self.deps.store.removeProjectForHost(repo.id, hostId)
    } else {
      self.deps.store.removeProject(repo.id)
    }
    self.deps.terminalTopologyRevisionByRepoId.delete(repo.id)
    self.deps.invalidateResolvedWorktreeCache()
    self.deps.invalidateWorktreeScanCacheForRepo(repo.id)
    invalidateAuthorizedRootsCache()
    self.deps.notifyReposChanged()
    return { removed: true }
  }

  async inspectTerminalProcess(terminalSelector: string): Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }> {
    const leaf = self.deps.resolveLiveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !self.deps.ptyController) {
      throw new Error('terminal_gone')
    }
    if (self.deps.ptyController.inspectProcess) {
      return self.deps.ptyController.inspectProcess(leaf.ptyId)
    }
    const foregroundProcess = await self.deps.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses =
      (await self.deps.ptyController.hasChildProcesses?.(leaf.ptyId)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  reorderRepos(orderedIds: string[]): { status: 'applied' | 'rejected' } {
    if (!self.deps.store?.reorderRepos) {
      throw new Error('runtime_unavailable')
    }
    // Why: remote clients can race repo add/remove on the server just like
    // local drag-reorder can race another window. Let the store validate the
    // full permutation and signal a resync-worthy rejection.
    const applied = self.deps.store.reorderRepos(orderedIds)
    if (!applied) {
      return { status: 'rejected' }
    }
    self.deps.invalidateResolvedWorktreeCache()
    self.deps.notifyReposChanged()
    return { status: 'applied' }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT
  ): Promise<RuntimeRepoSearchRefs> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        refs: [],
        truncated: false
      }
    }
    const refDetails = repo.connectionId
      ? await self.searchRemoteRepoRefs(repo, query, limit + 1)
      : await searchBaseRefDetails(repo.path, query, limit + 1)
    return {
      refs: refDetails.slice(0, limit).map((entry) => entry.refName),
      refDetails: refDetails.slice(0, limit),
      truncated: refDetails.length > limit
    }
  }

  async getRepoBaseRefDefault(
    repoSelector: string
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    if (repo.connectionId) {
      return self.getRemoteRepoBaseRefDefault(repo)
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }

  private async getRemoteRepoBaseRefDefault(
    repo: Repo
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : null
    if (!provider) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      resolveDefaultBaseRefViaExec(async (argv) => {
        try {
          return await provider.exec(argv, repo.path)
        } catch (err) {
          if (argv[0] === 'symbolic-ref') {
            console.warn('[runtime:repo.baseRefDefault] SSH symbolic-ref failed', {
              path: repo.path,
              err
            })
          }
          throw err
        }
      }),
      provider
        .exec(['remote'], repo.path)
        .then((result) => parseRemoteCount(result.stdout))
        .catch((err) => {
          console.warn('[runtime:repo.baseRefDefault] SSH git remote count failed', {
            path: repo.path,
            err
          })
          return 0
        })
    ])
    return { defaultBaseRef, remoteCount }
  }

  private async searchRemoteRepoRefs(
    repo: Repo,
    query: string,
    limit: number
  ): Promise<BaseRefSearchResult[]> {
    const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : null
    if (!provider) {
      return []
    }
    const normalizedQuery = normalizeRefSearchQuery(query)
    try {
      const remotesResult = await provider.exec(['remote'], repo.path).catch(() => ({ stdout: '' }))
      const remotes = remotesResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const capabilities = getSshGitCapabilityCache(provider)
      const runSearch = async (patternGroup?: 'segmented' | 'branchRoot'): Promise<string> => {
        return capabilities.runWithFallback(
          'for-each-ref-exclude',
          async () =>
            (
              await provider.exec(
                buildSearchBaseRefsArgv(normalizedQuery, limit, {
                  remoteNames: remotes,
                  patternGroup
                }),
                repo.path
              )
            ).stdout,
          async () =>
            (
              await provider.exec(
                buildSearchBaseRefsArgv(normalizedQuery, limit, {
                  excludeRemoteHead: false,
                  remoteNames: remotes,
                  patternGroup
                }),
                repo.path
              )
            ).stdout,
          isForEachRefExcludeUnsupportedError
        )
      }
      const searchTokens = normalizedQuery.split('/').filter((token) => token.length > 0)
      if (searchTokens.length > 1) {
        const results = await Promise.all([runSearch('segmented'), runSearch('branchRoot')])
        return mergeBaseRefSearchResultGroups(
          results.map((stdout) => parseAndFilterSearchRefDetails(stdout, limit, remotes)),
          limit
        )
      }
      return parseAndFilterSearchRefDetails(await runSearch(), limit, remotes)
    } catch (err) {
      console.warn('[runtime:repo.searchRefs] SSH for-each-ref failed', {
        path: repo.path,
        err
      })
      return []
    }
  }

  private async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await self.deps.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await self.deps.resolveWorktreeSelector(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }
}
