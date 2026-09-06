import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import type { RemoteTrackingBase } from '../runtime/orca-runtime'
import type { Repo } from '../../shared/repo-types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { probeWorktreeBaseRefPresence } from '../git/worktree-base-ref-probe'
import { registerOptionalSshWorktreeCreateRoots } from './ssh-worktree-create-root-registration'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import {
  fetchRemoteForWorktreeCreate,
  getSshWorktreeCreateBasePlanKey,
  getOrStartSshWorktreeCreateBasePlanInflight,
  refreshRemoteTrackingBaseForWorktreeCreate,
  type RemoteWorktreeCreateBasePlan
} from './ssh-worktree-create-fetch-queue'
import { hasCommitRefSsh, hasRemoteWorktreeBaseRef } from './worktree-create-branch-resolution'

type RemoteLocalBaseRefRefreshability =
  | {
      refreshable: true
      baseRef: string
      localBranch: string
      fullRef: string
      remoteTrackingRef: string
      behind: number
      ownerWorktreePath?: string
    }
  | {
      refreshable: false
      // undefined = nothing to refresh (no local branch yet), so the caller reports no status at all.
      result: LocalBaseRefRefreshResult | undefined
    }

function countNonEmptyGitOutputLines(output: string): number {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}

async function resolveRemoteTrackingBaseSsh(
  provider: SshGitProvider,
  repoPath: string,
  baseBranch: string
): Promise<RemoteTrackingBase | null> {
  let remotes: string[]
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    remotes = stdout
      .split(/\r?\n/)
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

export async function resolveRemoteWorktreeCreateBasePlan(
  provider: SshGitProvider,
  repo: Repo,
  requestedBaseBranch: string | undefined
): Promise<RemoteWorktreeCreateBasePlan | null> {
  const baseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () =>
      resolveDefaultBaseRefViaExec((argv) => provider.exec(argv, repo.path)),
    isBaseUsable: async (baseBranchCandidate) => {
      const remoteTrackingBase = await resolveRemoteTrackingBaseSsh(
        provider,
        repo.path,
        baseBranchCandidate
      )
      if (remoteTrackingBase) {
        if (await hasCommitRefSsh(provider, repo.path, remoteTrackingBase.ref)) {
          return true
        }
        return hasRemoteWorktreeBaseRef(provider, repo.path, baseBranchCandidate)
      }
      return hasRemoteWorktreeBaseRef(provider, repo.path, baseBranchCandidate)
    }
  })
  if (!baseBranch) {
    return null
  }
  return {
    baseBranch,
    remoteTrackingBase: await resolveRemoteTrackingBaseSsh(provider, repo.path, baseBranch)
  }
}

export function getOrStartRemoteWorktreeCreateBasePlan(
  provider: SshGitProvider,
  repo: Repo,
  requestedBaseBranch: string | undefined
): Promise<RemoteWorktreeCreateBasePlan | null> {
  const key = getSshWorktreeCreateBasePlanKey(repo, requestedBaseBranch)
  return getOrStartSshWorktreeCreateBasePlanInflight(key, () =>
    resolveRemoteWorktreeCreateBasePlan(provider, repo, requestedBaseBranch)
  )
}

export async function prefetchRemoteWorktreeCreateBase(
  provider: SshGitProvider,
  repo: Repo,
  args: { baseBranch?: string }
): Promise<void> {
  // Why: base-plan probes use generic git.exec, and some relays require the repo root registered before probes can see refs.
  await registerOptionalSshWorktreeCreateRoots(repo.connectionId!, [repo.path])
  const basePlan = await getOrStartRemoteWorktreeCreateBasePlan(provider, repo, args.baseBranch)
  if (!basePlan) {
    return
  }
  if (basePlan.remoteTrackingBase) {
    if (
      (await hasCommitRefSsh(provider, repo.path, basePlan.remoteTrackingBase.ref)) ||
      !(await hasRemoteWorktreeBaseRef(provider, repo.path, basePlan.baseBranch))
    ) {
      await refreshRemoteTrackingBaseForWorktreeCreate(provider, repo, basePlan.remoteTrackingBase)
      return
    }
  }
  if (await hasRemoteWorktreeBaseRef(provider, repo.path, basePlan.baseBranch)) {
    // Why: PR/MR resolvers already fetched verified SHA start points; a broad fetch only updates unrelated refs.
    return
  }

  // Why: mirrors createRemoteWorktree's legacy local-base fallback so prefetch and create share one process-local SSH fetch cache.
  await fetchRemoteForWorktreeCreate(provider, repo, 'origin')
}

export async function refreshLocalBaseRefForRemoteWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase
): Promise<LocalBaseRefRefreshResult | undefined> {
  const evaluation = await evaluateRemoteLocalBaseRefRefreshability(
    provider,
    repoPath,
    remoteTrackingBase
  )
  if (!evaluation.refreshable) {
    return evaluation.result
  }

  const resultBase = { baseRef: evaluation.baseRef, localBranch: evaluation.localBranch }
  try {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath,
      fullRef: evaluation.fullRef,
      remoteTrackingRef: evaluation.remoteTrackingRef,
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {})
    })
    return {
      ...resultBase,
      status: 'updated',
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {})
    }
  } catch {
    return { ...resultBase, status: 'skipped_error' }
  }
}

export async function evaluateRemoteLocalBaseRefRefreshability(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase,
  shouldInspectOwner: (behind: number) => boolean = () => true
): Promise<RemoteLocalBaseRefRefreshability> {
  const resultBase = {
    baseRef: remoteTrackingBase.base,
    localBranch: remoteTrackingBase.branch
  }
  const fullRef = `refs/heads/${remoteTrackingBase.branch}`

  let behind = 0
  try {
    // Why: SSH generic git.exec is allowlisted — merge-base and log are permitted read-only probes; rev-list is intentionally not exposed.
    await provider.exec(['merge-base', '--is-ancestor', fullRef, remoteTrackingBase.ref], repoPath)
    const { stdout } = await provider.exec(
      ['log', '--format=%H', `${fullRef}..${remoteTrackingBase.ref}`],
      repoPath
    )
    behind = countNonEmptyGitOutputLines(stdout)
    if (!shouldInspectOwner(behind)) {
      // Why: no behind commits means no update to advise; skip remote worktree/status round trips.
      return {
        refreshable: true,
        ...resultBase,
        fullRef,
        remoteTrackingRef: remoteTrackingBase.ref,
        behind
      }
    }
  } catch {
    // Why (#15331): the probes above also fail when refs/heads/<branch> is simply absent; the relay's
    // `worktree add -b` is about to create it, so there is nothing stale to warn about. Only a proven
    // absence suppresses: a dropped relay connection is not evidence the branch is missing.
    const presence = await probeWorktreeBaseRefPresence(
      (args) => provider.exec(args, repoPath),
      fullRef
    )
    if (presence === 'absent') {
      return { refreshable: false, result: undefined }
    }
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    const worktrees = await provider.listWorktrees(repoPath)
    const ownerWorktree = worktrees.find((wt) => wt.branch === fullRef)

    if (ownerWorktree) {
      const status = await provider.worktreeIsClean(ownerWorktree.path, {
        includeUntracked: false
      })
      if (!status.clean) {
        return {
          refreshable: false,
          result: {
            ...resultBase,
            status: 'skipped_dirty_worktree',
            ownerWorktreePath: ownerWorktree.path
          }
        }
      }
      return {
        refreshable: true,
        ...resultBase,
        fullRef,
        remoteTrackingRef: remoteTrackingBase.ref,
        behind,
        ownerWorktreePath: ownerWorktree.path
      }
    }

    // Why: not checked out anywhere, so a bare-ref fast-forward is safe; omitting ownerWorktreePath tells the relay to update-ref, not reset --hard.
    return {
      refreshable: true,
      ...resultBase,
      fullRef,
      remoteTrackingRef: remoteTrackingBase.ref,
      behind
    }
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

export async function getRemoteLocalBaseRefUpdateSuggestionForWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateRemoteLocalBaseRefRefreshability(
    provider,
    repoPath,
    remoteTrackingBase,
    (behind) => behind > 0
  )
  if (!evaluation.refreshable || evaluation.behind <= 0) {
    return undefined
  }
  try {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath,
      fullRef: evaluation.fullRef,
      remoteTrackingRef: evaluation.remoteTrackingRef,
      ...(evaluation.ownerWorktreePath ? { ownerWorktreePath: evaluation.ownerWorktreePath } : {}),
      checkOnly: true
    })
  } catch {
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}
