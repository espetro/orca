import { colors } from '../../../src/theme/mobile-theme'
import type { RpcSuccess } from '../../../src/transport/types'
import type { GitHubPreset, GitHubTaskKind, RepoSummary, TaskItem } from './tasks-types-all'
import { gitLabTodoTargetLabel } from './tasks-work-item-tasks'
import type { TaskProvider } from '../../../src/tasks/mobile-task-providers'

export function isSuccess(response: unknown): response is RpcSuccess {
  return Boolean(response && typeof response === 'object' && (response as RpcSuccess).ok)
}

export function getTaskPresetQuery(preset: GitHubPreset): string {
  switch (preset) {
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case 'issues':
    default:
      return 'is:issue is:open'
  }
}

export function isTaskProvider(value: unknown): value is TaskProvider {
  return value === 'github' || value === 'gitlab' || value === 'linear'
}

export function normalizeGitHubPreset(value: unknown): GitHubPreset {
  return value === 'my-issues' ||
    value === 'prs' ||
    value === 'my-prs' ||
    value === 'review' ||
    value === 'issues'
    ? value
    : 'issues'
}

export function normalizeLinearFilter(
  value: unknown
): 'assigned' | 'created' | 'completed' | 'all' {
  return value === 'assigned' || value === 'created' || value === 'completed' || value === 'all'
    ? value
    : 'all'
}

export function githubKindFromQuery(query: string, fallbackPreset: GitHubPreset): GitHubTaskKind {
  if (/\bis:pr\b/i.test(query)) {
    return 'prs'
  }
  if (/\bis:issue\b/i.test(query)) {
    return 'issues'
  }
  return fallbackPreset === 'prs' || fallbackPreset === 'my-prs' || fallbackPreset === 'review'
    ? 'prs'
    : 'issues'
}

export function scopeGitHubTaskSearch(query: string, kind: GitHubTaskKind): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return getTaskPresetQuery(kind === 'prs' ? 'prs' : 'issues')
  }
  if (/\bis:(?:issue|pr)\b/i.test(trimmed)) {
    return trimmed
  }
  return `${kind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`
}

export function taskKindLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return item.source.type === 'pr' ? 'Pull request' : 'Issue'
  }
  if (item.provider === 'gitlab') {
    return item.source.type === 'mr' ? 'Merge request' : 'Issue'
  }
  if (item.provider === 'gitlabTodo') {
    return `${gitLabTodoTargetLabel(item.source)} todo`
  }
  return 'Linear ticket'
}

export function taskExternalOpenLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return 'Open in GitHub'
  }
  if (item.provider === 'gitlab' || item.provider === 'gitlabTodo') {
    return 'Open in GitLab'
  }
  return 'Open in Linear'
}

export function taskStatusActionLabel(item: TaskItem): string {
  const verb =
    item.provider === 'github' || item.provider === 'gitlab'
      ? item.source.state === 'closed'
        ? 'Reopen'
        : 'Close'
      : ''
  return verb ? `${verb} ${taskKindLabel(item).toLowerCase()}` : ''
}

export function isGitHubPrMergeBlocked(item: Extract<TaskItem, { provider: 'github' }>): boolean {
  return item.source.type === 'pr' && item.source.mergeable === 'CONFLICTING'
}

export function isFailedGitHubCheck(check: { conclusion?: string | null }): boolean {
  return ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
}

export function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

export function buildPartialRepositoryNotice(failedCount: number, totalCount: number): string {
  return `${failedCount} of ${repositoryCount(totalCount)} failed to load.`
}

export function repoColor(name: string): string {
  const palette = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return palette[Math.abs(hash) % palette.length]!
}

export function getRepoBadgeColor(repo: RepoSummary | undefined, fallbackName: string): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? fallbackName)
}

export function setupSourceLabel(source: string | null): string {
  if (source === 'orca.yaml') {
    return 'orca.yaml'
  }
  if (source === 'legacy') {
    return 'local hooks'
  }
  return 'repository hooks'
}

export function taskRepositoryMeta(
  item: TaskItem,
  reposById: Map<string, RepoSummary>
): { key: string; label: string; color: string } {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    const repo = reposById.get(item.source.repoId)
    return {
      key: item.source.repoId,
      label: repo?.displayName ?? item.source.repoName,
      color: getRepoBadgeColor(repo, item.source.repoName)
    }
  }
  if (item.provider === 'gitlabTodo') {
    return {
      key: item.source.projectPath,
      label: item.source.projectPath,
      color: repoColor(item.source.projectPath)
    }
  }
  return {
    key: item.source.team.id,
    label: item.source.team.name,
    color: item.source.state.color || colors.accentBlue
  }
}

export function compareTasksByUpdated(a: TaskItem, b: TaskItem): number {
  const time = (value: string): number => {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return time(b.updatedAt) - time(a.updatedAt)
}

export function compareTasksByRepository(
  a: TaskItem,
  b: TaskItem,
  reposById: Map<string, RepoSummary>
): number {
  const aRepo = taskRepositoryMeta(a, reposById)
  const bRepo = taskRepositoryMeta(b, reposById)
  const repoComparison = aRepo.label.localeCompare(bRepo.label)
  return repoComparison || compareTasksByUpdated(a, b)
}

export function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function splitReviewerList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}
