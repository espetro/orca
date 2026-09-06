import type { GitPushTarget } from '../../shared/worktree/types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { WorktreePushTargetStore } from './worktree-push-target-cleanup'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type GitRemoteExec
} from './worktree-push-target-cleanup'
import {
  configureCreatedWorktreePushTargetWithExec,
  ensureUniqueRemoteName,
  findRemoteForUrl,
  prepareWorktreePushTargetWithExec
} from './worktree-push-target-setup'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { gitExecFileAsync } from '../git/runner'
import { validateGitPushTarget } from '../git/push-target-validation'

export async function prepareWorktreePushTarget(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {}
): Promise<GitPushTarget> {
  await validateGitPushTarget(repoPath, target, gitOptions)
  return prepareWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    repoPath,
    target,
    (existingRemote) =>
      store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            { ...target, remoteName: existingRemote },
            repoId
          )
        : false
  )
}

export function isPushTargetRemoteCreatedByKnownWorktree(
  store: WorktreePushTargetStore,
  target: GitPushTarget,
  repoId?: string
): boolean {
  return Object.entries(store.getAllWorktreeMeta()).some(([worktreeId, meta]) => {
    if (repoId && getRepoIdFromWorktreeId(worktreeId) !== repoId) {
      return false
    }
    if (!meta.pushTarget?.remoteCreated) {
      return false
    }
    const otherRemoteUrl = meta.pushTarget.remoteUrl
    const targetRemoteUrl = target.remoteUrl
    return (
      meta.pushTarget.remoteName === target.remoteName ||
      (typeof otherRemoteUrl === 'string' &&
        typeof targetRemoteUrl === 'string' &&
        sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
    )
  })
}

export async function cleanupUnusedWorktreePushTargetRemote(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  gitOptions: { wslDistro?: string } = {}
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions })
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to clean up fork PR remote for ${removedWorktreeId}`, error)
  }
}

export async function configureCreatedWorktreePushTarget(
  worktreePath: string,
  branchName: string,
  target: GitPushTarget,
  gitOptions: { wslDistro?: string } = {}
): Promise<GitPushTarget> {
  return configureCreatedWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    worktreePath,
    branchName,
    target
  )
}

export async function prepareWorktreePushTargetSsh(
  provider: SshGitProvider,
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  const execGit: GitRemoteExec = (args, cwd) => provider.exec(args, cwd)
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  await provider.exec(['check-ref-format', '--branch', target.branchName], repoPath)
  let remoteName = target.remoteName
  let remoteCreated = false
  // Why: ownership above is inherited from sibling worktrees, so it can be true
  // for a remote this call did not create. Only rollback needs that distinction.
  let remoteAddedHere = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(execGit, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: a reused Orca-created fork remote must inherit ownership so deleting the final user can remove it.
      remoteCreated = store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            {
              ...target,
              remoteName: existingRemote
            },
            repoId
          )
        : false
    } else {
      remoteName = await ensureUniqueRemoteName(execGit, repoPath, target.remoteName)
      try {
        await provider.exec(['remote', 'add', remoteName, target.remoteUrl], repoPath)
      } catch (error) {
        // Why: relays predating fork-remote support reject this exec by policy; name the fix instead of surfacing their rule.
        if (error instanceof Error && error.message.includes('Destructive git remote operations')) {
          throw new Error(
            'This SSH host is running an older Orca relay that cannot add a fork remote for a PR workspace. Reconnect to deploy the latest relay, then try again.'
          )
        }
        throw error
      }
      remoteCreated = true
      remoteAddedHere = true
    }
  }
  try {
    await provider.fetchRemoteTrackingRef(
      repoPath,
      remoteName,
      target.branchName,
      `refs/remotes/${remoteName}/${target.branchName}`
    )
  } catch (error) {
    // Why: mirrors the local path — a fetch failure aborts the create, so the
    // remote we just added on the host would be orphaned with no owner to clean it.
    // A reused remote belongs to a live sibling worktree; removing it breaks that one.
    if (remoteAddedHere) {
      await provider.exec(['remote', 'remove', remoteName], repoPath).catch(() => {})
    }
    throw error
  }
  return { ...sanitizedTarget, remoteName, ...(remoteCreated ? { remoteCreated: true } : {}) }
}

export async function cleanupUnusedWorktreePushTargetRemoteSsh(
  provider: SshGitProvider,
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => provider.exec(args, cwd)
    )
  } catch (error) {
    console.warn(
      `[worktrees] Failed to clean up remote fork PR remote for ${removedWorktreeId}`,
      error
    )
  }
}
