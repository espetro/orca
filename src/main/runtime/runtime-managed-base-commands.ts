/* eslint-disable max-lines -- Why: extracted managed MR/PR/base-ref resolution cluster moved as one unit from OrcaRuntimeService. */
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { pickPreferredGitRemote } from '../../shared/preferred-git-remote'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import {
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from '../../shared/review-head-tracking-ref'
import type { GitHubPrStartPoint, GitPushTarget } from '../../shared/worktree/types'
import { fetchCompareBaseRefWithLocalFallback } from '../git/compare-base-ref-fetch'
import { isTransientReviewHeadFetchError } from '../git/fetch-error-classification'
import { getDefaultRemote } from '../git/repo'
import { gitExecFileAsync } from '../git/runner'
import {
  fetchGitHubPullRequestHeadRef,
  fetchPrHeadTrackingRef
} from '../github/pr-head-tracking-ref'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import { resolveGitHubReviewHeadRemote } from '../github/review-head-remote'
import { getProjectRefForRemote as getGitLabProjectRefForRemote } from '../gitlab/gl-utils'
import { getWorkItemByProjectRef as getGitLabWorkItemByProjectRef } from '../gitlab/client'
import { getGlabKnownHosts } from '../gitlab/gl-utils'
import { fetchGitLabMergeRequestHeadRef } from '../gitlab/mr-head-tracking-ref'
import type { Store } from '../persistence'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { REMOTE_FETCH_TIMEOUT_MS } from './runtime-tail-projection'
import type { RuntimeStore } from './orca-runtime'
import type { RemoteFetchResult, RemoteTrackingBase } from './orca-runtime'

export type RuntimeManagedBaseCommandsDeps = {
  getCanonicalFetchKey: (
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string }
  ) => Promise<string>
  getFreshFetchCompletedAt: (key: string) => number | null
  rememberFreshFetchCompletedAt: (key: string, completedAt?: number) => void
  store: RuntimeStore | null
  resolveRepoSelector: (selector: string) => Promise<Repo>
  requireStore: () => Store
}

export class RuntimeManagedBaseCommands {
  private readonly deps: RuntimeManagedBaseCommandsDeps
  private fetchInflight = new Map<string, Promise<RemoteFetchResult>>()
  private remoteFetchQueueTail = new Map<string, Promise<RemoteFetchResult>>()

  constructor(deps: RuntimeManagedBaseCommandsDeps) {
    this.deps = deps
  }

  enqueueRemoteFetch(
    remoteKey: string,
    runFetch: () => Promise<RemoteFetchResult>
  ): Promise<RemoteFetchResult> {
    const previous = this.remoteFetchQueueTail.get(remoteKey)
    const promise = previous ? previous.then(runFetch, runFetch) : runFetch()
    this.remoteFetchQueueTail.set(remoteKey, promise)
    promise.finally(() => {
      if (this.remoteFetchQueueTail.get(remoteKey) === promise) {
        this.remoteFetchQueueTail.delete(remoteKey)
      }
    })
    return promise
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    const key = await this.deps.getCanonicalFetchKey(repoPath, remote, gitOptions)
    if (this.deps.getFreshFetchCompletedAt(key) !== null) {
      // Why: freshness window hit — skip the fetch entirely. Do NOT reuse any
      // in-flight promise here; the timestamp is only written on success, so
      // hitting this branch means a previous fetch did succeed recently.
      return { ok: true }
    }

    const existing = this.fetchInflight.get(key)
    if (existing) {
      // Why: genuine serialization (not check-then-set). Two callers racing
      // on the same repo+remote share the single underlying `git fetch`.
      return existing
    }

    const promise = this.enqueueRemoteFetch(key, () =>
      gitExecFileAsync(['fetch', remote], {
        cwd: repoPath,
        ...gitOptions,
        // Why: cap the create-path base-ref fetch so a stuck first-auth on
        // Windows (GCM prompt) fails fast instead of hanging creation (STA-1292).
        timeout: REMOTE_FETCH_TIMEOUT_MS
      })
        .then((): RemoteFetchResult => {
          // Why (§3.3 Lifecycle): timestamp on success ONLY. Writing on rejection
          // would make the freshness cache lie about the last known remote state.
          this.deps.rememberFreshFetchCompletedAt(key)
          return { ok: true }
        })
        .catch((err): RemoteFetchResult => {
          // Why: swallow here so awaiters don't throw at the await site. Outer
          // create/dispatch paths are already tolerant of offline fetch failure;
          // this is the behavioral contract of this helper.
          console.warn(`[fetchRemoteWithCache] ${remote} fetch failed for ${repoPath}:`, err)
          return { ok: false, errorKind: 'git_error' }
        })
    ).finally(() => {
      // Why (§3.3 Lifecycle): evict on BOTH success and rejection. A
      // rejected entry that survived in the Map would wedge every future
      // create on this repo until Orca restarted (the F2 bug §3.3 pins).
      this.fetchInflight.delete(key)
    })

    this.fetchInflight.set(key, promise)
    return promise
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    const remoteKey = await this.deps.getCanonicalFetchKey(repoPath, base.remote, gitOptions)
    const key = await this.deps.getCanonicalFetchKey(
      repoPath,
      `base:${base.remote}:${base.branch}`,
      gitOptions
    )
    if (this.deps.getFreshFetchCompletedAt(key) !== null) {
      // Why: exact-base freshness is the safety boundary. A full remote fetch
      // can be narrowed by repo refspecs, so it must not prove this branch.
      return { ok: true }
    }

    const existing = this.fetchInflight.get(key)
    if (existing) {
      return existing
    }

    const promise = this.enqueueRemoteFetch(remoteKey, async () => {
      if (this.deps.getFreshFetchCompletedAt(key) !== null) {
        return { ok: true }
      }
      // Why: this exact refresh gates worktree create; ordinary fetches still own maintenance.
      return gitExecFileAsync(
        [
          ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
          'fetch',
          '--no-tags',
          base.remote,
          `+refs/heads/${base.branch}:${base.ref}`
        ],
        {
          cwd: repoPath,
          ...gitOptions,
          // Why: exact remote-base refresh is the network gate for worktree
          // creation, so honor repo SSH routing and bound custom wrappers.
          useConfiguredSshCommandForNetwork: true,
          timeout: REMOTE_FETCH_TIMEOUT_MS
        }
      )
        .then((): RemoteFetchResult => {
          this.deps.rememberFreshFetchCompletedAt(key)
          return { ok: true }
        })
        .catch((err): RemoteFetchResult => {
          console.warn(
            `[refreshRemoteTrackingBase] ${base.base} refresh failed for ${repoPath}:`,
            err
          )
          return { ok: false, errorKind: 'git_error' }
        })
    }).finally(() => {
      this.fetchInflight.delete(key)
    })

    this.fetchInflight.set(key, promise)
    return promise
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteTrackingBase | null> {
    let remotes: string[]
    try {
      const { stdout } = await gitExecFileAsync(['remote'], { cwd: repoPath, ...gitOptions })
      remotes = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return null
    }

    const remoteRefPrefix = 'refs/remotes/'
    const shortBaseBranch = baseBranch.startsWith(remoteRefPrefix)
      ? baseBranch.slice(remoteRefPrefix.length)
      : baseBranch
    const remote = remotes
      .filter((candidate) => shortBaseBranch.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (!remote) {
      return null
    }
    const branch = shortBaseBranch.slice(remote.length + 1)
    if (!branch) {
      return null
    }
    return {
      remote,
      branch,
      ref: `refs/remotes/${remote}/${branch}`,
      base: `${remote}/${branch}`
    }
  }

  async resolveManagedPrBase(args: {
    repoSelector: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }): Promise<GitHubPrStartPoint | { error: string }> {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }
    let repo: Repo
    try {
      repo = await this.deps.resolveRepoSelector(args.repoSelector)
    } catch {
      return { error: 'Repo not found' }
    }
    if (isFolderRepo(repo)) {
      return { error: 'Folder mode does not support creating worktrees.' }
    }
    const sshGitProvider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
    const localGitExecOptions = sshGitProvider
      ? undefined
      : getLocalProjectGitExecOptions(this.deps.requireStore(), repo)
    const localWorktreeGitOptions = sshGitProvider
      ? {}
      : getLocalProjectWorktreeGitOptions(this.deps.requireStore(), repo)
    const gitExec = sshGitProvider
      ? (gitArgs: string[]) => sshGitProvider.exec(gitArgs, repo.path)
      : (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions ?? { cwd: repo.path })
    // Why: one resolver keeps source preference and hosting identity aligned
    // across local, WSL, and SSH worktree creation.
    const resolveRemote = (): Promise<string> =>
      resolveGitHubReviewHeadRemote({
        repoPath: repo.path,
        issueSourcePreference: repo.issueSourcePreference,
        connectionId: repo.connectionId ?? null,
        localGitOptions: localWorktreeGitOptions,
        gitExec
      })

    // Why: SSH review-head fetches require narrow write-capable RPCs.
    const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
      fetchPrHeadTrackingRef(
        repo,
        sshGitProvider,
        remote,
        branch,
        localGitExecOptions ? { localGitExecOptions } : {}
      )
    const fetchPullRequestHeadRef = (remote: string, prNumber: number): Promise<string> =>
      fetchGitHubPullRequestHeadRef(
        repo,
        sshGitProvider,
        remote,
        prNumber,
        localGitExecOptions ? { localGitExecOptions } : {}
      )

    return resolveGitHubPrStartPoint({
      repoPath: repo.path,
      prNumber: args.prNumber,
      headRefName: args.headRefName,
      baseRefName: args.baseRefName,
      isCrossRepository: args.isCrossRepository,
      issueSourcePreference: repo.issueSourcePreference,
      connectionId: repo.connectionId ?? null,
      localGitOptions: localWorktreeGitOptions,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef,
      resolveRemote
    })
  }

  async resolveManagedMrBase(args: {
    repoSelector: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }): Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  > {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }
    let repo: Repo
    try {
      repo = await this.deps.resolveRepoSelector(args.repoSelector)
    } catch {
      return { error: 'Repo not found' }
    }
    if (isFolderRepo(repo)) {
      return { error: 'Folder mode does not support creating worktrees.' }
    }
    const sshGitProvider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
    const localGitExecOptions = sshGitProvider
      ? undefined
      : getLocalProjectGitExecOptions(this.deps.requireStore(), repo)
    const localWorktreeGitOptions = sshGitProvider
      ? {}
      : getLocalProjectWorktreeGitOptions(this.deps.requireStore(), repo)
    const gitExec = sshGitProvider
      ? (gitArgs: string[]) => sshGitProvider.exec(gitArgs, repo.path)
      : (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions ?? { cwd: repo.path })

    let sourceBranch = args.sourceBranch?.trim() ?? ''
    let targetBranch = args.targetBranch?.trim() ?? ''
    let isCrossRepository = args.isCrossRepository === true

    if (!sourceBranch) {
      let remote: string
      try {
        remote = await this.resolveGitLabIssueSourceRemote(
          repo.path,
          repo.issueSourcePreference,
          repo.connectionId ?? null,
          localWorktreeGitOptions
        )
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
      }
      const knownHosts = await getGlabKnownHosts(repo.connectionId ?? null, localWorktreeGitOptions)
      const projectRef = await getGitLabProjectRefForRemote(
        repo.path,
        remote,
        knownHosts,
        repo.connectionId ?? null,
        localWorktreeGitOptions
      )
      if (!projectRef) {
        return { error: 'No GitLab project found for this repository.' }
      }
      const item = await getGitLabWorkItemByProjectRef(
        repo.path,
        projectRef,
        args.mrIid,
        'mr',
        repo.connectionId ?? null,
        localWorktreeGitOptions
      )
      if (!item || item.type !== 'mr') {
        return { error: `MR !${args.mrIid} not found.` }
      }
      sourceBranch = (item.branchName ?? '').trim()
      targetBranch = (item.baseRefName ?? '').trim()
      if (!sourceBranch) {
        return { error: `MR !${args.mrIid} has no source branch.` }
      }
      if (item.isCrossRepository === true) {
        isCrossRepository = true
      }
    }

    let remote: string
    try {
      remote = await this.resolveGitLabIssueSourceRemote(
        repo.path,
        repo.issueSourcePreference,
        repo.connectionId ?? null,
        localWorktreeGitOptions
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
    }
    const compareBaseRef = targetBranch ? `refs/remotes/${remote}/${targetBranch}` : undefined
    const fetchRemoteTrackingRef = async (branch: string, ref: string): Promise<void> => {
      await (sshGitProvider
        ? sshGitProvider.fetchRemoteTrackingRef(repo.path, remote, branch, ref)
        : gitExec(['fetch', remote, `+refs/heads/${branch}:${ref}`]))
    }
    // Why: the target/compare branch is optional (it only powers the diff
    // base). A merged MR may have had its target ref deleted, so a fetch
    // failure must NOT abort the whole resolution — that would discard the
    // already-verified source-branch base and silently fall back to the repo
    // default branch. Degrade gracefully by dropping compareBaseRef instead.
    const fetchCompareBaseRef = (): Promise<boolean> =>
      fetchCompareBaseRefWithLocalFallback({
        compareBaseRef,
        fetchCompareBaseRef: (ref) => fetchRemoteTrackingRef(targetBranch, ref),
        gitExec,
        logLabel: '[runtime:resolveManagedMrBase]',
        logContext: { remote, targetBranch, mrIid: args.mrIid }
      })

    if (isCrossRepository) {
      const mrRef = `refs/merge-requests/${args.mrIid}/head`
      // Why: soft-keep needs identity when the fetch throws before returning a path.
      // Success uses the path returned by the fetch itself (writer-authoritative).
      let softKeepLocalRefPromise: Promise<string | null> | undefined
      const resolveSoftKeepLocalRef = (): Promise<string | null> => {
        softKeepLocalRefPromise ??= (async () => {
          try {
            const { stdout } = await gitExec(['remote', 'get-url', remote])
            const remoteUrl = stdout.trim()
            if (!remoteUrl) {
              return null
            }
            return gitlabMergeRequestHeadLocalRef(
              reviewHeadRemoteRefComponent(remote, remoteUrl),
              args.mrIid
            )
          } catch {
            return null
          }
        })()
        return softKeepLocalRefPromise
      }
      const resolveDurableHeadSha = async (localRef: string | null): Promise<string | null> => {
        if (!localRef) {
          return null
        }
        try {
          const { stdout } = await gitExec(['rev-parse', '--verify', `${localRef}^{commit}`])
          return stdout.trim() || null
        } catch {
          return null
        }
      }
      try {
        const localRef = await fetchGitLabMergeRequestHeadRef(
          repo,
          sshGitProvider,
          remote,
          args.mrIid,
          localGitExecOptions ? { localGitExecOptions } : {}
        )
        const sha = await resolveDurableHeadSha(localRef)
        if (!sha) {
          return { error: `Could not resolve fork MR !${args.mrIid} head after fetch.` }
        }
        const compareBaseFetched = await fetchCompareBaseRef()
        return { baseBranch: sha, ...(compareBaseFetched ? { compareBaseRef } : {}) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Why: mirror compare-base — a transient transport failure must not fail
        // the resolve when a prior fetch already pinned the durable head ref. A
        // missing remote ref (deleted MR/fork), auth failure, or stale-relay
        // error must fail hard: serving the durable ref there would check out a
        // dead or unauthorized tip and mask the actionable error.
        if (isTransientReviewHeadFetchError(error)) {
          const localSha = await resolveDurableHeadSha(await resolveSoftKeepLocalRef())
          if (localSha) {
            console.warn(
              '[runtime:resolveManagedMrBase] MR head fetch failed; using durable local ref',
              {
                remote,
                mrIid: args.mrIid,
                error: message.split('\n')[0]
              }
            )
            const compareBaseFetched = await fetchCompareBaseRef()
            return { baseBranch: localSha, ...(compareBaseFetched ? { compareBaseRef } : {}) }
          }
        }
        return { error: `Failed to fetch ${mrRef}: ${message.split('\n')[0]}` }
      }
    }

    try {
      await fetchRemoteTrackingRef(sourceBranch, `refs/remotes/${remote}/${sourceBranch}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Failed to fetch ${remote}/${sourceBranch}: ${message.split('\n')[0]}` }
    }

    const remoteRef = `${remote}/${sourceBranch}`
    try {
      await gitExec(['rev-parse', '--verify', remoteRef])
    } catch {
      return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
    }
    const compareBaseFetched = await fetchCompareBaseRef()
    return {
      baseBranch: remoteRef,
      ...(compareBaseFetched ? { compareBaseRef } : {}),
      pushTarget: { remoteName: remote, branchName: sourceBranch }
    }
  }

  async resolveGitLabIssueSourceRemote(
    repoPath: string,
    preference?: Repo['issueSourcePreference'],
    connectionId?: string | null,
    localGitOptions: { wslDistro?: string } = {}
  ): Promise<string> {
    const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
    const localGitOptionArgs =
      Object.keys(localGitOptions).length > 0 ? ([localGitOptions] as const) : []
    if (preference === 'origin') {
      const origin = await getGitLabProjectRefForRemote(
        repoPath,
        'origin',
        knownHosts,
        connectionId,
        ...localGitOptionArgs
      )
      if (origin) {
        return 'origin'
      }
      throw new Error('No GitLab project found for origin.')
    }
    if (preference === 'upstream') {
      const upstream = await getGitLabProjectRefForRemote(
        repoPath,
        'upstream',
        knownHosts,
        connectionId,
        ...localGitOptionArgs
      )
      if (upstream) {
        return 'upstream'
      }
      const origin = await getGitLabProjectRefForRemote(
        repoPath,
        'origin',
        knownHosts,
        connectionId,
        ...localGitOptionArgs
      )
      if (origin) {
        return 'origin'
      }
      throw new Error('No GitLab project found for upstream or origin.')
    }
    const upstream = await getGitLabProjectRefForRemote(
      repoPath,
      'upstream',
      knownHosts,
      connectionId,
      ...localGitOptionArgs
    )
    if (upstream) {
      return 'upstream'
    }
    const origin = await getGitLabProjectRefForRemote(
      repoPath,
      'origin',
      knownHosts,
      connectionId,
      ...localGitOptionArgs
    )
    if (origin) {
      return 'origin'
    }
    if (connectionId) {
      const provider = requireSshGitProvider(connectionId)
      const { stdout } = await provider.exec(['remote'], repoPath)
      return pickPreferredGitRemote(stdout.split('\n'))
    }
    return getDefaultRemote(repoPath, localGitOptions)
  }
}
