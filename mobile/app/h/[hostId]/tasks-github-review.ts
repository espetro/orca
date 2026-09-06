import type {
  GitHubAssignableUser,
  GitHubPRReviewSummary,
  GitHubPRReviewerRow,
  GitHubRepoSources,
  GitHubWorkItem,
  HostedReviewItem,
  HostedReviewMergeMethod,
  PendingHostedMerge,
  PendingHostedStateChange,
  PendingProjectGitHubMerge,
  TaskItem
} from './tasks-types-all'
import type { GitHubOwnerRepo } from '../../../../src/shared/github/pull-request-types'
import { projectRowType } from './tasks-github-project-fields'

export function formatGitHubReviewState(state: string | null | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes requested'
    case 'COMMENTED':
      return 'Commented'
    case 'DISMISSED':
      return 'Dismissed'
    case 'PENDING':
      return 'Pending'
    default:
      return 'Reviewed'
  }
}

export function getGitHubReviewerRows(item: {
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
}): GitHubPRReviewerRow[] {
  const byLogin = new Map<string, GitHubPRReviewerRow>()
  for (const user of item.reviewRequests ?? []) {
    const login = user.login.trim()
    if (!login) {
      continue
    }
    byLogin.set(login.toLowerCase(), {
      login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      stateLabel: 'Requested'
    })
  }
  for (const review of item.latestReviews ?? []) {
    const login = review.login.trim()
    const key = login.toLowerCase()
    if (!login || byLogin.has(key)) {
      continue
    }
    byLogin.set(key, {
      login,
      name: null,
      avatarUrl: review.avatarUrl,
      stateLabel: formatGitHubReviewState(review.state)
    })
  }
  return Array.from(byLogin.values())
}

export function getGitHubReviewSummary(item: {
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
}): string {
  if (item.reviewDecision === 'APPROVED') {
    return 'Approved'
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Changes requested'
  }
  const rows = getGitHubReviewerRows(item)
  if (rows.length === 0) {
    return 'No reviewers'
  }
  if (rows.length === 1) {
    return `${rows[0]!.login} - ${rows[0]!.stateLabel}`
  }
  return `${rows[0]!.login} +${rows.length - 1}`
}

export function formatGitHubPRDelta(item: GitHubWorkItem): string | null {
  const parts: string[] = []
  if (typeof item.additions === 'number') {
    parts.push(`+${item.additions}`)
  }
  if (typeof item.deletions === 'number') {
    parts.push(`-${item.deletions}`)
  }
  if (typeof item.changedFiles === 'number') {
    parts.push(`${item.changedFiles} ${item.changedFiles === 1 ? 'file' : 'files'}`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

export function hostedBranchSummary(item: TaskItem): { head: string; base: string } | null {
  if (item.provider === 'github' && item.source.type === 'pr') {
    return {
      head: item.source.branchName?.trim() || 'unknown head',
      base: item.source.baseRefName?.trim() || 'base'
    }
  }
  if (item.provider === 'gitlab' && item.source.type === 'mr') {
    return {
      head: item.source.branchName?.trim() || 'unknown head',
      base: item.source.baseRefName?.trim() || 'base'
    }
  }
  return null
}

export function getGitHubMergeLabel(item: GitHubWorkItem): string {
  if (item.mergeable === undefined && item.mergeStateStatus === undefined) {
    return 'Merge'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'closed') {
    return 'Closed'
  }
  if (item.mergeable === 'CONFLICTING') {
    return 'Conflicts'
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return 'Behind'
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return 'Blocked'
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return 'Able to merge'
  }
  return 'Unknown'
}

export function getHostedReviewMergeMethodLabel(method: HostedReviewMergeMethod): string {
  if (method === 'squash') {
    return 'Squash and merge'
  }
  if (method === 'rebase') {
    return 'Rebase and merge'
  }
  return 'Create merge commit'
}

export function hostedReviewMergeTargetLabel(item: HostedReviewItem): string {
  return item.provider === 'gitlab' ? 'merge request' : 'PR'
}

export function getHostedMergeConfirmMessage(pending: PendingHostedMerge): string {
  const target = hostedReviewMergeTargetLabel(pending.item)
  if (pending.method === 'squash') {
    return `Squash and merge ${target} #${pending.item.source.number}?`
  }
  const action = pending.method === 'rebase' ? 'Rebase and merge' : 'Merge'
  return `${action} ${target} #${pending.item.source.number}?`
}

export function getProjectGitHubMergeConfirmMessage(pending: PendingProjectGitHubMerge): string {
  const number = pending.row.content.number
  const action =
    pending.method === 'squash'
      ? 'Squash and merge'
      : pending.method === 'rebase'
        ? 'Rebase and merge'
        : 'Merge'
  return `${action} PR #${number}?`
}

export function hostedStateChangeAction(nextState: PendingHostedStateChange['nextState']): string {
  return nextState === 'closed' ? 'Close' : 'Reopen'
}

export function hostedStateChangeTarget(pending: PendingHostedStateChange): {
  titleTarget: string
  labelTarget: string
  number: number | null
} {
  if (pending.source === 'project') {
    const type = projectRowType(pending.row)
    return {
      titleTarget: type === 'pr' ? 'Pull Request' : 'Issue',
      labelTarget: type === 'pr' ? 'PR' : 'Issue',
      number: pending.row.content.number
    }
  }
  if (pending.item.provider === 'gitlab') {
    return {
      titleTarget: pending.item.source.type === 'mr' ? 'Merge Request' : 'Issue',
      labelTarget: pending.item.source.type === 'mr' ? 'MR' : 'Issue',
      number: pending.item.source.number
    }
  }
  return {
    titleTarget: pending.item.source.type === 'pr' ? 'Pull Request' : 'Issue',
    labelTarget: pending.item.source.type === 'pr' ? 'PR' : 'Issue',
    number: pending.item.source.number
  }
}

export function getHostedStateConfirmTitle(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.titleTarget}`
}

export function getHostedStateConfirmMessage(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.labelTarget} #${target.number}?`
}

export function getHostedStateConfirmLabel(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.labelTarget}`
}

export function mergeGitHubAssignableUsers(
  users: GitHubAssignableUser[],
  seeds: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of [...users, ...seeds]) {
    const login = user.login.trim()
    if (!login || byLogin.has(login.toLowerCase())) {
      continue
    }
    byLogin.set(login.toLowerCase(), { ...user, login })
  }
  return [...byLogin.values()]
}

export function getGitHubReviewerSeedUsers(item: {
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  author?: string | null
}): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  const add = (user: GitHubAssignableUser): void => {
    const login = user.login.trim()
    if (!login || byLogin.has(login.toLowerCase())) {
      return
    }
    byLogin.set(login.toLowerCase(), { ...user, login })
  }
  for (const user of item.reviewRequests ?? []) {
    add(user)
  }
  for (const review of item.latestReviews ?? []) {
    add({
      login: review.login,
      name: null,
      avatarUrl: review.avatarUrl ?? null
    })
  }
  if (item.author) {
    add({ login: item.author, name: null, avatarUrl: null })
  }
  return [...byLogin.values()]
}

export function sameGitHubOwnerRepo(
  a: GitHubOwnerRepo | null | undefined,
  b: GitHubOwnerRepo | null | undefined
): boolean {
  return (
    !!a &&
    !!b &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

export function hasGitHubIssueSourceChoice(sources: GitHubRepoSources | undefined): boolean {
  return Boolean(
    sources?.prs &&
    sources.upstreamCandidate &&
    !sameGitHubOwnerRepo(sources.prs, sources.upstreamCandidate)
  )
}

export function issueSourceSlug(source: GitHubOwnerRepo | null | undefined): string {
  return source ? `${source.owner}/${source.repo}` : 'Unknown'
}
