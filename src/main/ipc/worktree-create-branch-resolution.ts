import type { BranchPrefixSettings } from '../../shared/branch-prefix'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { computeValidatedBranchName } from './worktree-logic'
import { hasCommitObjectViaGitExec } from '../git/commit-object-ref'
import { gitExecFileAsync } from '../git/runner'
import { listWorktrees } from '../git/worktree'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'

export async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: BranchPrefixSettings,
  username: string | null,
  gitOptions: { wslDistro?: string } = {}
): Promise<string> {
  if (!branchNameOverride) {
    return computeValidatedBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branchNameOverride], {
    cwd: repoPath,
    ...gitOptions
  })
  return branchNameOverride
}

export async function resolveCreateBranchNameSsh(
  provider: SshGitProvider,
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: BranchPrefixSettings,
  username: string | null
): Promise<string> {
  if (!branchNameOverride) {
    return computeValidatedBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await provider.exec(['check-ref-format', '--branch', branchNameOverride], repoPath)
  return branchNameOverride
}

export function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

export async function canCheckoutExistingLocalBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  gitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      {
        cwd: repoPath,
        ...gitOptions
      }
    )
    localHead = stdout.trim()
  } catch {
    return false
  }
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        { cwd: repoPath, ...gitOptions }
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await listWorktrees(repoPath, gitOptions)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

export function hasLocalGitOptions(gitOptions: { wslDistro?: string }): boolean {
  return Object.keys(gitOptions).length > 0
}

export function hasLocalCommitObjectWithOptions(
  repoPath: string,
  ref: string,
  gitOptions: { wslDistro?: string }
): Promise<boolean> {
  return hasCommitObjectViaGitExec(
    (gitArgs) => gitExecFileAsync(gitArgs, { cwd: repoPath, ...gitOptions }),
    ref
  )
}

export async function hasLocalWorktreeBaseRefWithOptions(
  repoPath: string,
  baseRef: string,
  gitOptions: { wslDistro?: string }
): Promise<boolean> {
  const refExists = async (qualifiedRef: string) => {
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`],
        {
          cwd: repoPath,
          ...gitOptions
        }
      )
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasLocalCommitObjectWithOptions(repoPath, baseRef, gitOptions)
}

export function hasRemoteCommitObject(
  provider: SshGitProvider,
  repoPath: string,
  ref: string
): Promise<boolean> {
  return hasCommitObjectViaGitExec((gitArgs) => provider.exec(gitArgs, repoPath), ref)
}

export async function hasRemoteWorktreeBaseRef(
  provider: SshGitProvider,
  repoPath: string,
  baseRef: string
): Promise<boolean> {
  const refExists = (qualifiedRef: string) => hasCommitRefSsh(provider, repoPath, qualifiedRef)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasRemoteCommitObject(provider, repoPath, baseRef)
}

// Why: hasRemoteCommitObject resolves only SHAs, not symbolic refs; resolve any qualified ref (remote-tracking or local head) directly.
export async function hasCommitRefSsh(
  provider: SshGitProvider,
  repoPath: string,
  ref: string
): Promise<boolean> {
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      repoPath
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export async function canCheckoutExistingLocalBranchSsh(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  baseBranch: string
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      repoPath
    )
    localHead = stdout.trim()
  } catch {
    return false
  }
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await provider.exec(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        repoPath
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await provider.listWorktrees(repoPath)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

async function listSshRemoteNames(provider: SshGitProvider, repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  } catch {
    return []
  }
}

function isAllowedSshRemoteBaseRef(refName: string, allowedBaseRef: string): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}

function resolveSshRemoteBranchName(refName: string, remoteNames: string[]): string {
  const remotePrefix = 'refs/remotes/'
  if (!refName.startsWith(remotePrefix)) {
    return refName
  }
  const remoteAndBranch = refName.slice(remotePrefix.length)
  const remote = remoteNames.find((candidate) => remoteAndBranch.startsWith(`${candidate}/`))
  if (remote) {
    return remoteAndBranch.slice(remote.length + 1)
  }
  return remoteAndBranch.split('/').slice(1).join('/') || remoteAndBranch
}

async function hasSshRemoteBranchConflict(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  allowedBaseRef: string
): Promise<boolean> {
  const remoteNames = await listSshRemoteNames(provider, repoPath)
  try {
    const { stdout } = await provider.exec(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      repoPath
    )
    return stdout.split(/\r?\n/).some((line) => {
      const refName = line.trim()
      if (!refName || /^refs\/remotes\/.+\/HEAD$/.test(refName)) {
        return false
      }
      if (isAllowedSshRemoteBaseRef(refName, allowedBaseRef)) {
        return false
      }
      // Why: `git branch --all --list feature/x` doesn't match `remotes/origin/feature/x`; parse remote refs directly.
      return resolveSshRemoteBranchName(refName, remoteNames) === branchName
    })
  } catch {
    return false
  }
}

async function hasSshLocalBranchConflict(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    const { stdout } = await provider.exec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      repoPath
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export async function getSshBranchConflictKind(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  allowedBaseRef: string
): Promise<'local' | 'remote' | null> {
  if (await hasSshLocalBranchConflict(provider, repoPath, branchName)) {
    return 'local'
  }
  return (await hasSshRemoteBranchConflict(provider, repoPath, branchName, allowedBaseRef))
    ? 'remote'
    : null
}
