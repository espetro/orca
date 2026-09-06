/* eslint-disable max-lines -- Why: extracted worktree base-ref drift probe + reconcile cluster from the managed-worktrees facade */
import type { RemoteFetchResult, RemoteTrackingBase, ResolvedWorktree } from './orca-runtime'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import { DRIFT_PROBE_SUBJECT_LIMIT } from './runtime-tail-projection'
import { getBaseRefDefault, getRecentDriftSubjects, getRemoteDrift } from '../git/repo'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { splitWorktreeId } from '../../shared/worktree/id'
import { planWorktreeSortOrderUpdates } from '../../shared/worktree/sort-order-update'
import { gitExecFileAsync } from '../git/runner'

/** Facade methods the drift commands reach back into. */
export type RuntimeWorktreeDriftCommandsHost = {
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  notifyWorktreesChanged: (repoId: string) => void
}

export type RuntimeWorktreeDriftCommandsDeps = Pick<
  RuntimeManagedWorktreesDeps,
  | 'store'
  | 'requireStore'
  | 'resolveRemoteTrackingBase'
  | 'fetchRemoteWithCache'
  | 'notifier'
  | 'getOrStartRemoteFetch'
  | 'invalidateResolvedWorktreeCache'
>

import type { RuntimeManagedWorktreesDeps } from './runtime-managed-worktrees'

export class RuntimeWorktreeDriftCommands {
  /** Worktree id -> reconcile token from the most recent create. */
  readonly optimisticReconcileTokens = new Map<string, string>()

  constructor(
    private deps: RuntimeWorktreeDriftCommandsDeps,
    private host: RuntimeWorktreeDriftCommandsHost
  ) {}

  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    const wt = await this.host.resolveWorktreeSelector(worktreeSelector)
    if (!this.deps.store) {
      return null
    }
    const repo = this.deps.store.getRepos().find((r) => r.id === wt.repoId)
    if (!repo) {
      return null
    }
    if (repo.connectionId) {
      // Why: the drift probe uses local git helpers. Until the SSH provider
      // exposes equivalent remote refs/log plumbing, fail closed to "unknown"
      // instead of probing a server path on the desktop filesystem.
      return null
    }
    const localGitExecOptions = getLocalProjectGitExecOptions(this.deps.requireStore(), repo)
    const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(
      this.deps.requireStore(),
      repo
    )
    const meta = this.deps.store.getWorktreeMeta(wt.id)
    const base =
      meta?.baseRef ||
      meta?.sparseBaseRef ||
      repo.worktreeBaseRef ||
      (await getBaseRefDefault(repo.path, localWorktreeGitOptions))
    if (!base) {
      // Why: brand-new repo with no remote primary — nothing to compare
      // against, so there's no meaningful drift to report. Dispatch should
      // not block on a probe that cannot form an opinion.
      return null
    }
    const remoteTrackingBase = await this.deps.resolveRemoteTrackingBase(
      repo.path,
      base,
      localWorktreeGitOptions
    )
    if (!remoteTrackingBase) {
      return null
    }
    const remote = remoteTrackingBase.remote
    // Why: fetch failures are non-fatal; we proceed with whatever the
    // last-known remote ref points at. `fetchRemoteWithCache` never throws.
    await this.deps.fetchRemoteWithCache(repo.path, remote, localWorktreeGitOptions)
    const drift = await getRemoteDrift(wt.path, 'HEAD', base, localGitExecOptions)
    if (!drift) {
      return null
    }
    // Why: behind=0 proves HEAD..base is empty, so git log cannot add subjects.
    const recentSubjects =
      drift.behind > 0
        ? await getRecentDriftSubjects(
            wt.path,
            'HEAD',
            base,
            DRIFT_PROBE_SUBJECT_LIMIT,
            localGitExecOptions
          )
        : []
    return { base, behind: drift.behind, recentSubjects }
  }

  async reconcileWorktreeBaseStatus(args: {
    repoId: string
    repoPath: string
    worktreeId: string
    base: RemoteTrackingBase
    branchName: string
    createdBaseSha: string
    token: string
    fetchPromise: Promise<RemoteFetchResult>
  }): Promise<void> {
    const stillCurrent = (): boolean =>
      this.optimisticReconcileTokens.get(args.worktreeId) === args.token
    const emit = (event: Omit<WorktreeBaseStatusEvent, 'repoId' | 'worktreeId' | 'base'>): void => {
      if (!stillCurrent()) {
        return
      }
      this.deps.notifier?.worktreeBaseStatus?.({
        repoId: args.repoId,
        worktreeId: args.worktreeId,
        base: args.base.base,
        remote: args.base.remote,
        ...event
      })
    }
    const resolvePublishRemote = async (): Promise<string> => {
      // Why: repos whose canonical publish remote is named differently (e.g.
      // `upstream`, a forked `myfork`, or any non-`origin` configuration —
      // including multi-segment names like `foo/bar` that this PR's resolver
      // explicitly supports) would otherwise silently skip the conflict
      // signal. Resolve from git config in priority order:
      //   1) branch.<name>.pushRemote (explicit per-branch override)
      //   2) remote.pushDefault (workspace-wide override)
      //   3) branch.<name>.remote (tracked remote)
      //   4) the base ref's own remote (matches resolveRemoteTrackingBase)
      //   5) `origin` as a final fallback.
      const tryConfig = async (key: string): Promise<string | null> => {
        try {
          const { stdout } = await gitExecFileAsync(['config', '--get', key], {
            cwd: args.repoPath
          })
          const value = stdout.trim()
          return value || null
        } catch {
          return null
        }
      }
      return (
        (await tryConfig(`branch.${args.branchName}.pushRemote`)) ??
        (await tryConfig('remote.pushDefault')) ??
        (await tryConfig(`branch.${args.branchName}.remote`)) ??
        args.base.remote ??
        'origin'
      )
    }
    const checkPublishRemoteConflict = async (): Promise<void> => {
      const publishRemote = await resolvePublishRemote()
      try {
        if (publishRemote !== args.base.remote) {
          const result = await this.deps.getOrStartRemoteFetch(args.repoPath, publishRemote)
          if (!result.ok) {
            return
          }
        }
        await gitExecFileAsync(
          ['rev-parse', '--verify', `refs/remotes/${publishRemote}/${args.branchName}^{commit}`],
          { cwd: args.repoPath }
        )
        if (stillCurrent()) {
          this.deps.notifier?.worktreeRemoteBranchConflict?.({
            repoId: args.repoId,
            worktreeId: args.worktreeId,
            remote: publishRemote,
            branchName: args.branchName
          })
        }
      } catch {
        // No publish-remote conflict is the common case; stay quiet.
      }
    }

    try {
      const fetchResult = await args.fetchPromise
      if (!stillCurrent()) {
        return
      }
      if (!fetchResult.ok) {
        emit({ status: 'unknown' })
        return
      }

      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', `${args.base.ref}^{commit}`],
        { cwd: args.repoPath }
      )
      const postFetchSha = stdout.trim()
      if (postFetchSha === args.createdBaseSha) {
        emit({ status: 'current' })
        await checkPublishRemoteConflict()
        return
      }

      try {
        await gitExecFileAsync(['merge-base', '--is-ancestor', args.createdBaseSha, postFetchSha], {
          cwd: args.repoPath
        })
      } catch {
        emit({ status: 'base_changed' })
        await checkPublishRemoteConflict()
        return
      }

      const { stdout: countStdout } = await gitExecFileAsync(
        ['rev-list', '--count', `${args.createdBaseSha}..${postFetchSha}`],
        { cwd: args.repoPath }
      )
      const behind = Number(countStdout.trim())
      if (!Number.isFinite(behind) || behind <= 0) {
        emit({ status: 'current' })
        await checkPublishRemoteConflict()
        return
      }
      const { stdout: logStdout } = await gitExecFileAsync(
        ['log', '--format=%s', '-n', '5', `${args.createdBaseSha}..${postFetchSha}`],
        { cwd: args.repoPath }
      )
      emit({
        status: 'drift',
        behind,
        recentSubjects: logStdout.split('\n').filter((line) => line.trim().length > 0)
      })
      await checkPublishRemoteConflict()
    } catch (err) {
      console.warn(`[worktree-base-status] reconcile failed for ${args.worktreeId}:`, err)
      emit({ status: 'unknown' })
    } finally {
      // Why: reconcile is one-shot; clear the token so long-lived sessions
      // that create many worktrees without removing them don't grow the
      // optimisticReconcileTokens map monotonically. Removal still no-ops
      // because the entry is already gone.
      if (this.optimisticReconcileTokens.get(args.worktreeId) === args.token) {
        this.optimisticReconcileTokens.delete(args.worktreeId)
      }
    }
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.deps.store
    const updates = planWorktreeSortOrderUpdates(
      orderedIds,
      (worktreeId) => store.getWorktreeMeta(worktreeId),
      Date.now()
    )
    for (const update of updates) {
      store.setWorktreeMeta(update.worktreeId, { sortOrder: update.sortOrder })
    }
    if (updates.length === 0) {
      return { updated: 0 }
    }
    this.deps.invalidateResolvedWorktreeCache()
    const changedRepoIds = new Set(
      updates.flatMap((update) => {
        const parsed = splitWorktreeId(update.worktreeId)
        return parsed ? [parsed.repoId] : []
      })
    )
    for (const repoId of changedRepoIds) {
      this.host.notifyWorktreesChanged(repoId)
    }
    return { updated: updates.length }
  }
}
