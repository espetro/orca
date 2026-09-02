import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** Resolves the git-derived identity env seeds for one dev runner invocation. */
export type DevInstanceIdentity = {
  branch: string | null
  worktreeName: string
  label: string | null
  identitySeed: string
  dockTitle: string
}

function readGitValue(repoRoot: string, args: readonly string[]): string | null {
  try {
    const value = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function lastBranchSegment(value: string): string {
  return value.replace(/\\/g, '/').split('/').findLast(Boolean) ?? value
}

function formatDevInstanceLabel(branch: string | null, worktreeName: string | null): string | null {
  if (branch && worktreeName) {
    if (branch === worktreeName || lastBranchSegment(branch) === worktreeName) {
      return worktreeName
    }
    return `${worktreeName} @ ${branch}`
  }
  return branch || worktreeName || null
}

function createDockTitle(branch: string | null, label: string | null): string {
  return `Orca: ${branch || label || 'dev'}`
}

export function resolveDevInstanceIdentity(repoRoot: string): DevInstanceIdentity {
  const branch =
    process.env.ORCA_DEV_BRANCH ||
    readGitValue(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']) ||
    readGitValue(repoRoot, ['rev-parse', '--short', 'HEAD'])
  const worktreeName = process.env.ORCA_DEV_WORKTREE_NAME || path.basename(repoRoot)
  const label = process.env.ORCA_DEV_INSTANCE_LABEL || formatDevInstanceLabel(branch, worktreeName)
  const identitySeed = process.env.ORCA_DEV_INSTANCE_KEY || repoRoot
  const dockTitle = process.env.ORCA_DEV_DOCK_TITLE || createDockTitle(branch, label)
  return { branch, worktreeName, label, identitySeed, dockTitle }
}

/** Seeds ORCA_DEV_* env for the Electron child; later `pnpm dev` runs reuse the same values. */
export function seedDevInstanceIdentityEnv(repoRoot: string): void {
  const { branch, worktreeName, label, identitySeed, dockTitle } =
    resolveDevInstanceIdentity(repoRoot)

  process.env.ORCA_DEV_REPO_ROOT ||= repoRoot
  process.env.ORCA_DEV_INSTANCE_KEY ||= identitySeed
  if (branch) {
    process.env.ORCA_DEV_BRANCH ||= branch
  }
  if (worktreeName) {
    process.env.ORCA_DEV_WORKTREE_NAME ||= worktreeName
  }
  if (label) {
    // Why: parallel `pnpm dev` runs need a stable origin label for window titles,
    // Dock names, and automation sessions without re-running git in Electron.
    process.env.ORCA_DEV_INSTANCE_LABEL ||= label
  }
  process.env.ORCA_DEV_DOCK_TITLE ||= dockTitle
}
