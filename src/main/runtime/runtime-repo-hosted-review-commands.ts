import type { Repo } from '../../shared/repo-types'
import type { MainWorkItem } from '../github/client'
import {
  getPRForBranchOutcome,
  getRepoSlug,
  getRepoUpstream,
  getWorkItem,
  listIssues as listGitHubIssues,
  listWorkItems,
  countWorkItems,
  getWorkItemByOwnerRepo,
  getWorkItemDetails
} from '../github/client'
import { listLabels, listAssignableUsers } from '../github/client'
import { getRateLimit } from '../github/rate-limit'
import type { ListWorkItemsResult } from '../../shared/github/work-item-types'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GitHubPRBranchLookupOptions } from '../github/client'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../shared/hosted-review'
import { getHostedReviewForBranch as getHostedReviewForBranchFromRepo } from '../source-control/hosted-review'
import {
  createHostedReview as createHostedReviewFromRepo,
  getHostedReviewCreationEligibility as getHostedReviewCreationEligibilityFromRepo
} from '../source-control/hosted-review-creation'
import { createStackedHostedReview as createStackedHostedReviewFromRepo } from '../source-control/stacked-hosted-review-creation'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { resolveLocalProjectRuntimeForRepo } from '../local-project-runtime-resolution'
import { getAgentLaunchPlatformForRepo } from '../agent-launch-platform'
import { detectGitHubAvatarIcon } from '../repo-icon-autodetect'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'
import type { TerminalWorkspaceLaunchScope } from './runtime-workspace-launch-scope-type'

// Why: narrow closure surface over OrcaRuntimeService so repo/git commands stay
// unit-testable without constructing the full runtime (pattern of runtime-linear-command-host).

export class RuntimeRepoHostedReviewCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  private get self() {
    return this
  }

  private getHostedReviewExecutionOptions(
    repo: Repo
  ): { localGitExecOptions: { wslDistro?: string } } | undefined {
    const localGitOptions = self.getLocalGitExecutionOptionArgs(repo)[0] ?? {}
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  private getLocalGitExecutionOptionArgs(repo: Repo): [] | [{ wslDistro?: string }] {
    const localGitOptions = getLocalProjectWorktreeGitOptions(self.deps.requireStore(), repo)
    return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
  }

  private getAgentLaunchPlatformForRepo(repo: Repo): NodeJS.Platform {
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(self.deps.requireStore(), repo)
    return getAgentLaunchPlatformForRepo(repo, projectRuntime)
  }

  private getAgentLaunchPlatformForWorkspace(scope: TerminalWorkspaceLaunchScope): NodeJS.Platform {
    if (scope.repo) {
      return self.getAgentLaunchPlatformForRepo(scope.repo)
    }
    if (scope.connectionId) {
      return isWindowsAbsolutePathLike(scope.path) ? 'win32' : 'linux'
    }
    return isWslUncPath(scope.path) ? 'linux' : process.platform
  }

  async getRepoSlug(repoSelector: string): Promise<GitHubOwnerRepo | null> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const options = self.getHostedReviewExecutionOptions(repo)
    return options
      ? getRepoSlug(repo.path, repo.connectionId ?? null, options)
      : getRepoSlug(repo.path, repo.connectionId ?? null)
  }

  async getRepoUpstream(repoSelector: string): Promise<GitHubOwnerRepo | null> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const options = self.getHostedReviewExecutionOptions(repo)
    return options
      ? getRepoUpstream(repo.path, repo.connectionId ?? null, options)
      : getRepoUpstream(repo.path, repo.connectionId ?? null)
  }

  // Why: repos added before fork detection existed have no stored `upstream`, so
  // their avatar/badge would never self-correct. Resolve it once at startup for
  // local git repos; SSH repos resolve lazily when their settings open (their
  // connection may not be up yet). Sequential to respect the gh rate limit;
  // failures leave `upstream` unset so the next launch retries.
  private async backfillForkUpstreams(): Promise<void> {
    try {
      const store = self.deps.requireStore()
      let changed = false
      for (const repo of store.getRepos()) {
        if (repo.upstream !== undefined || repo.kind === 'folder' || repo.connectionId) {
          continue
        }
        let upstream: GitHubOwnerRepo | null
        try {
          upstream = await getRepoUpstream(repo.path, null)
        } catch {
          continue
        }
        const repoIcon =
          upstream && repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github'
            ? await detectGitHubAvatarIcon(repo.path, null, upstream)
            : null
        // Why: settings can change the repo while the probes above are pending, so
        // re-read it — a stale snapshot must not clobber a user-chosen icon or an
        // upstream another path already resolved.
        const current = store.getRepos().find((candidate) => candidate.id === repo.id)
        if (!current || current.upstream !== undefined) {
          continue
        }
        const updates: Partial<Repo> = { upstream: upstream ?? null }
        // Only migrate the auto-detected origin avatar; never touch a chosen icon.
        if (
          repoIcon &&
          current.repoIcon?.type === 'image' &&
          current.repoIcon.source === 'github'
        ) {
          updates.repoIcon = repoIcon
        }
        store.updateRepo(repo.id, updates)
        changed = true
      }
      if (changed) {
        self.deps.notifyReposChanged()
      }
    } catch {
      // Best-effort startup backfill; never disrupt launch.
    }
  }

  async listRepoWorkItems(
    repoSelector: string,
    limit?: number,
    query?: string,
    page?: number,
    noCache?: boolean
  ): Promise<ListWorkItemsResult<MainWorkItem>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listWorkItems(
      repo.path,
      limit,
      query,
      page,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      noCache,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async listRepoIssues(
    repoSelector: string,
    limit?: number
  ): Promise<Awaited<ReturnType<typeof listGitHubIssues>>['items']> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const result = await listGitHubIssues(
      repo.path,
      limit,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
    return result.items
  }

  async getRepoWorkItem(
    repoSelector: string,
    number: number,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItem>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    // Why: open-by-number must pin the same source the list and start-point use,
    // else a fork and its upstream sharing a PR number resolve to different PRs.
    return getWorkItem(
      repo.path,
      number,
      type,
      repo.connectionId ?? null,
      self.getLocalGitExecutionOptionArgs(repo)[0] ?? {},
      repo.issueSourcePreference
    )
  }

  async getRepoWorkItemByOwnerRepo(
    repoSelector: string,
    ownerRepo: { owner: string; repo: string; host?: string },
    number: number,
    type: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemByOwnerRepo>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getWorkItemByOwnerRepo(
      repo.path,
      ownerRepo,
      number,
      type,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getRepoWorkItemDetails(
    repoSelector: string,
    number: number,
    type?: 'issue' | 'pr'
  ): Promise<Awaited<ReturnType<typeof getWorkItemDetails>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getWorkItemDetails(
      repo.path,
      number,
      type,
      repo.connectionId ?? null,
      self.getLocalGitExecutionOptionArgs(repo)[0] ?? {},
      repo.issueSourcePreference
    )
  }

  async countRepoWorkItems(repoSelector: string, query?: string): Promise<number> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return countWorkItems(
      repo.path,
      query,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async listRepoLabels(repoSelector: string): Promise<Awaited<ReturnType<typeof listLabels>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listLabels(
      repo.path,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async listRepoAssignableUsers(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listAssignableUsers>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  getGitHubRateLimit(options?: {
    force?: boolean
  }): Promise<Awaited<ReturnType<typeof getRateLimit>>> {
    return getRateLimit(options)
  }

  async getRepoPRForBranch(
    repoSelector: string,
    branch: string,
    linkedPRNumber?: number | null,
    fallbackPRNumber?: number | null,
    acceptMergedFallbackPR?: boolean,
    currentHeadOid?: string | null
  ): Promise<PRRefreshOutcome> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const options: GitHubPRBranchLookupOptions = self.getHostedReviewExecutionOptions(repo) ?? {}
    const lookupOptions = { ...options }
    if (acceptMergedFallbackPR === true) {
      lookupOptions.acceptMergedFallbackPR = true
    }
    if (typeof currentHeadOid === 'string' && currentHeadOid.trim().length > 0) {
      lookupOptions.currentHeadOid = currentHeadOid.trim()
    }
    const lookupOptionArgs: [] | [GitHubPRBranchLookupOptions] =
      Object.keys(lookupOptions).length > 0 ? [lookupOptions] : []
    // Why: return the full classified outcome (not PRInfo|null) so a runtime gh
    // auth/network failure crosses the RPC as `upstream-error` instead of
    // collapsing to `null`, which the renderer would otherwise cache as a false
    // accepted "no PR found" (design success criterion 1).
    return getPRForBranchOutcome(
      repo.path,
      branch,
      linkedPRNumber ?? null,
      repo.connectionId ?? null,
      linkedPRNumber == null ? (fallbackPRNumber ?? null) : null,
      ...lookupOptionArgs
    )
  }

  async getHostedReviewForBranch(args: {
    repoSelector: string
    branch: string
    currentHeadOid?: string | null
    active?: boolean
    linkedGitHubPR?: number | null
    fallbackGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedAzureDevOpsPR?: number | null
    linkedGiteaPR?: number | null
  }): Promise<HostedReviewInfo | null> {
    const repo = await self.deps.resolveRepoSelector(args.repoSelector)
    const executionOptions = self.getHostedReviewExecutionOptions(repo)
    const review = await getHostedReviewForBranchFromRepo({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      branch: args.branch,
      currentHeadOid: args.currentHeadOid ?? null,
      ...(args.active === true ? { active: true } : {}),
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      ...executionOptions
    })
    if (
      review?.provider === 'github' &&
      self.deps.stats &&
      !self.deps.stats.hasCountedPR(review.url)
    ) {
      self.deps.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: review.number, prUrl: review.url }
      })
    }
    return review
  }

  async getHostedReviewCreationEligibility(
    args: Omit<HostedReviewCreationEligibilityArgs, 'repoPath'> & {
      repoSelector: string
      worktreeSelector?: string
    }
  ): Promise<HostedReviewCreationEligibility> {
    const { repo, repoPath } = await self.resolveHostedReviewTarget(args)
    const executionOptions = self.getHostedReviewExecutionOptions(repo)
    return getHostedReviewCreationEligibilityFromRepo({
      repoPath,
      connectionId: repo.connectionId ?? null,
      branch: args.branch,
      base: args.base ?? null,
      hasUncommittedChanges: args.hasUncommittedChanges,
      hasUpstream: args.hasUpstream,
      ahead: args.ahead,
      behind: args.behind,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      ...executionOptions
    })
  }

  async createHostedReview(
    args: CreateHostedReviewInput & {
      repoSelector: string
      worktreeSelector?: string
    }
  ): Promise<CreateHostedReviewResult> {
    const { repo, repoPath } = await self.resolveHostedReviewTarget(args)
    const executionOptions = self.getHostedReviewExecutionOptions(repo)
    const input = {
      provider: args.provider,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft,
      ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
    }
    const result = executionOptions
      ? await createHostedReviewFromRepo(
          repoPath,
          input,
          repo.connectionId ?? null,
          executionOptions
        )
      : await createHostedReviewFromRepo(repoPath, input, repo.connectionId ?? null)
    if (result.ok && self.deps.stats && !self.deps.stats.hasCountedPR(result.url)) {
      self.deps.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: result.number, prUrl: result.url }
      })
    }
    return result
  }

  async createStackedHostedReview(
    args: CreateStackedHostedReviewInput & {
      repoSelector: string
      worktreeSelector?: string
    }
  ): Promise<CreateStackedHostedReviewResult> {
    const { repo, repoPath } = await self.resolveHostedReviewTarget(args)
    const executionOptions = self.getHostedReviewExecutionOptions(repo)
    const result = await createStackedHostedReviewFromRepo(
      repoPath,
      {
        provider: args.provider,
        base: args.base,
        head: args.head,
        title: args.title,
        body: args.body,
        draft: args.draft,
        ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
      },
      repo.connectionId ?? null,
      executionOptions ?? {}
    )
    if (result.ok && self.deps.stats && !self.deps.stats.hasCountedPR(result.url)) {
      self.deps.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: result.number, prUrl: result.url }
      })
    }
    return result
  }
}
