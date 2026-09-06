import { colors } from '../../../src/theme/mobile-theme'

export type LinearIssueSection = {
  key: string
  label: string
  color: string
  issues: LinearIssue[]
}
export type LinearListEntry =
  | { type: 'section'; section: LinearIssueSection }
  | { type: 'issue'; issue: LinearIssue }
import { getLinkedWorkItemSuggestedName } from '../../../src/tasks/mobile-workspace-name'
import type {
  ActionableTaskItem,
  GitLabTodo,
  GitLabWorkItem,
  GitHubWorkItem,
  LinearDisplayProperty,
  LinearGroupBy,
  LinearIssue,
  LinearOrderBy,
  LinearTeam,
  RepoSummary,
  TaskItem
} from './tasks-types-all'

export function taskWorkspaceFallback(item: ActionableTaskItem): string {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    return `${item.source.type}-${item.source.number}`
  }
  return item.source.identifier.toLowerCase()
}

export function taskWorkspaceSuggestedName(item: ActionableTaskItem): string {
  return getLinkedWorkItemSuggestedName(item) || taskWorkspaceFallback(item)
}

export function taskTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

export function formatUpdatedAt(value: string): string {
  const time = taskTime(value)
  if (!time) {
    return ''
  }
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

export function gitHubStatusLabel(item: GitHubWorkItem): string {
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

export function gitHubTaskSubtitle(item: GitHubWorkItem): string {
  return `${item.repoName} ${item.type === 'pr' ? '#' : '#'}${item.number}`
}

export function createGitHubTask(
  repo: RepoSummary,
  item: Omit<GitHubWorkItem, 'repoId' | 'repoName'>
) {
  const source: GitHubWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `github:${repo.id}:${item.type}:${item.number}`,
    provider: 'github' as const,
    title: item.title,
    subtitle: gitHubTaskSubtitle(source),
    status: gitHubStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

export function gitLabStatusLabel(item: GitLabWorkItem): string {
  if (item.state === 'opened') {
    return 'Open'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Locked'
}

export function createGitLabTask(
  repo: RepoSummary,
  item: Omit<GitLabWorkItem, 'repoId' | 'repoName'>
) {
  const source: GitLabWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `gitlab:${repo.id}:${item.type}:${item.number}`,
    provider: 'gitlab' as const,
    title: item.title,
    subtitle: `${repo.displayName} ${item.type === 'mr' ? '!' : '#'}${item.number}`,
    status: gitLabStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

export function gitLabTodoTargetLabel(todo: Pick<GitLabTodo, 'targetType'>): string {
  if (todo.targetType === 'MergeRequest') {
    return 'Merge request'
  }
  if (todo.targetType === 'Issue') {
    return 'Issue'
  }
  return 'GitLab todo'
}

export function gitLabTodoTargetRef(todo: Pick<GitLabTodo, 'targetType' | 'targetIid'>): string {
  if (!todo.targetIid) {
    return ''
  }
  if (todo.targetType === 'MergeRequest') {
    return `!${todo.targetIid}`
  }
  if (todo.targetType === 'Issue') {
    return `#${todo.targetIid}`
  }
  return String(todo.targetIid)
}

export function createGitLabTodoTask(todo: GitLabTodo): TaskItem {
  const targetRef = gitLabTodoTargetRef(todo)
  return {
    key: `gitlab-todo:${todo.id}`,
    provider: 'gitlabTodo',
    title: todo.targetTitle || todo.targetUrl,
    subtitle: `${todo.projectPath}${targetRef ? ` ${targetRef}` : ''}`,
    status: todo.actionName.replace(/_/g, ' ') || 'Todo',
    updatedAt: todo.updatedAt,
    source: todo
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

export function createLinearTask(issue: LinearIssue): TaskItem {
  return {
    key: `linear:${issue.workspaceId ?? 'workspace'}:${issue.id}`,
    provider: 'linear',
    title: issue.title,
    subtitle: `${issue.identifier} · ${issue.team.name}`,
    status: issue.state.name,
    updatedAt: issue.updatedAt,
    source: issue
  }
}

const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

export function getLinearPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? `P${priority}`
}

export function getLinearPriorityRank(priority: number): number {
  return priority === 0 ? 1 : priority
}

export function compareLinearIssues(
  a: LinearIssue,
  b: LinearIssue,
  orderBy: LinearOrderBy
): number {
  if (orderBy === 'updated') {
    return taskTime(b.updatedAt) - taskTime(a.updatedAt)
  }
  if (orderBy === 'identifier') {
    return a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  }
  const priorityDelta = getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority)
  return priorityDelta || taskTime(b.updatedAt) - taskTime(a.updatedAt)
}

export function getLinearIssueGroup(
  issue: LinearIssue,
  groupBy: LinearGroupBy
): {
  key: string
  label: string
  color: string
} {
  if (groupBy === 'status') {
    return { key: `status:${issue.state.name}`, label: issue.state.name, color: issue.state.color }
  }
  if (groupBy === 'assignee') {
    return {
      key: `assignee:${issue.assignee?.id ?? issue.assignee?.displayName ?? 'unassigned'}`,
      label: issue.assignee?.displayName ?? 'Unassigned',
      color: colors.accentBlue
    }
  }
  if (groupBy === 'priority') {
    return {
      key: `priority:${issue.priority}`,
      label: getLinearPriorityLabel(issue.priority),
      color: colors.accentBlue
    }
  }
  if (groupBy === 'team') {
    return { key: `team:${issue.team.id}`, label: issue.team.name, color: issue.state.color }
  }
  return { key: 'all', label: 'Issues', color: colors.accentBlue }
}

export function groupLinearIssues(
  issues: LinearIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy
): LinearIssueSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'Issues', color: colors.accentBlue, issues: sorted }]
  }
  const sections = new Map<
    string,
    { key: string; label: string; color: string; issues: LinearIssue[] }
  >()
  for (const issue of sorted) {
    const group = getLinearIssueGroup(issue, groupBy)
    const section = sections.get(group.key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(group.key, { ...group, issues: [issue] })
    }
  }
  return [...sections.values()]
}

export function linearIssueSecondaryParts(
  issue: LinearIssue,
  displayProperties: ReadonlySet<LinearDisplayProperty>
): string[] {
  const parts = [issue.identifier]
  if (displayProperties.has('priority')) {
    parts.push(getLinearPriorityLabel(issue.priority))
  }
  if (displayProperties.has('assignee') && issue.assignee?.displayName) {
    parts.push(issue.assignee.displayName)
  }
  if (displayProperties.has('team')) {
    parts.push(issue.team.name)
  }
  if (displayProperties.has('labels') && issue.labels.length > 0) {
    parts.push(issue.labels.slice(0, 2).join(', '))
  }
  if (displayProperties.has('updated')) {
    parts.push(formatUpdatedAt(issue.updatedAt))
  }
  return parts
}

export function reconcileTeamSelection(
  teams: LinearTeam[],
  saved: string[] | null | undefined
): Set<string> {
  if (!saved) {
    return new Set(teams.map((team) => team.id))
  }
  const available = new Set(teams.map((team) => team.id))
  const next = new Set(saved.filter((id) => available.has(id)))
  return next.size === 0 ? new Set(teams.map((team) => team.id)) : next
}
