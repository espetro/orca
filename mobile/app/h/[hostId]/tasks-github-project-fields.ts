import { colors } from '../../../src/theme/mobile-theme'
import {
  isIterationCurrent,
  type ProjectGroup
} from '../../../../src/shared/github/project-group-sort'
import type { GitHubProjectTable as SharedGitHubProjectTable } from '../../../../src/shared/github/project-types'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from './tasks-types-all'
import type { GitHubProjectSortDirection } from '../../../../src/shared/github/project-types'

export type ProjectSortOverride = { fieldId: string; direction: GitHubProjectSortDirection }
export type ProjectListEntry =
  | { type: 'group'; group: ProjectGroup; collapsed: boolean }
  | { type: 'row'; row: GitHubProjectRow }

export function projectRowType(row: GitHubProjectRow): 'issue' | 'pr' | null {
  if (row.itemType === 'ISSUE') {
    return 'issue'
  }
  if (row.itemType === 'PULL_REQUEST') {
    return 'pr'
  }
  return null
}

export function canCreateWorkspaceFromProjectRow(row: GitHubProjectRow): boolean {
  // Why: desktop only exposes Project "Start work" for backed issue/PR rows
  // with enough GitHub identity to build the linked work item.
  return projectRowType(row) !== null && row.content.number != null && Boolean(row.content.url)
}

export function splitRepositorySlug(slug: string | null): { owner: string; repo: string } | null {
  const [owner, repo] = slug?.split('/') ?? []
  return owner && repo ? { owner, repo } : null
}

export function projectRowGitHubRepository(
  row: GitHubProjectRow,
  host: string
): { owner: string; repo: string; host: string } | null {
  const slug = splitRepositorySlug(row.content.repository)
  return slug ? { ...slug, host } : null
}

const GITHUB_PROJECT_OPTION_COLORS: Record<string, string> = {
  GRAY: '#8b949e',
  RED: '#f85149',
  ORANGE: '#db6d28',
  YELLOW: '#d29922',
  GREEN: '#3fb950',
  BLUE: '#58a6ff',
  PURPLE: '#bc8cff',
  PINK: '#db61a2'
}

export function githubProjectOptionColor(color: string | null | undefined): string {
  if (!color) {
    return colors.textMuted
  }
  const upper = color.toUpperCase()
  const mapped = GITHUB_PROJECT_OPTION_COLORS[upper]
  if (mapped) {
    return mapped
  }
  const hex = color.startsWith('#') ? color : `#${color}`
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : colors.textMuted
}

export function projectRowStatusLabel(row: GitHubProjectRow): string {
  if (row.itemType === 'DRAFT_ISSUE') {
    return 'Draft'
  }
  if (row.itemType === 'REDACTED') {
    return 'Redacted'
  }
  if (row.content.isDraft) {
    return 'Draft'
  }
  if (row.content.state === 'MERGED') {
    return 'Merged'
  }
  if (row.content.state === 'CLOSED') {
    return 'Closed'
  }
  return 'Open'
}

export function editableProjectFields(table: GitHubProjectTable | null): GitHubProjectField[] {
  return (
    table?.selectedView.fields?.filter((field) =>
      ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION'].includes(field.dataType)
    ) ?? []
  )
}

export function projectFieldValueLabel(row: GitHubProjectRow, field: GitHubProjectField): string {
  const value = row.fieldValuesByFieldId?.[field.id]
  if (!value) {
    return 'Empty'
  }
  if (value.kind === 'single-select') {
    return value.name
  }
  if (value.kind === 'iteration') {
    return value.title
  }
  if (value.kind === 'text') {
    return value.text || 'Empty'
  }
  if (value.kind === 'number') {
    return String(value.number)
  }
  if (value.kind === 'date') {
    return value.date
  }
  if (value.kind === 'labels') {
    return value.labels.map((label) => label.name).join(', ') || 'Empty'
  }
  if (value.kind === 'users') {
    return value.users.map((user) => user.login).join(', ') || 'Empty'
  }
  return 'Empty'
}

export function projectFieldDisplayLabel(row: GitHubProjectRow, field: GitHubProjectField): string {
  if (field.dataType === 'ASSIGNEES') {
    return row.content.assignees.map((user) => user.login).join(', ') || 'Empty'
  }
  if (field.dataType === 'LABELS') {
    return row.content.labels.map((label) => label.name).join(', ') || 'Empty'
  }
  if (field.dataType === 'REPOSITORY') {
    return row.content.repository ?? 'Empty'
  }
  if (field.dataType === 'PARENT_ISSUE') {
    return row.content.parentIssue ? `#${row.content.parentIssue.number}` : 'Empty'
  }
  if (field.dataType === 'ISSUE_TYPE') {
    return row.content.issueType?.name ?? 'Empty'
  }
  if (field.dataType === 'TITLE') {
    return row.content.title
  }
  return projectFieldValueLabel(row, field)
}

export function projectSummaryFields(table: GitHubProjectTable | null): GitHubProjectField[] {
  return (
    table?.selectedView.fields?.filter(
      (field) => field.dataType !== 'TITLE' && field.dataType !== 'REPOSITORY'
    ) ?? []
  )
}

export function projectFieldVisibilityKey(table: GitHubProjectTable | null): string | null {
  if (!table) {
    return null
  }
  // Why: desktop scopes column visibility to project + view; matching that
  // avoids hiding fields across unrelated Project views with colliding IDs.
  return `${table.project.id}:${table.selectedView.id}`
}

export function projectFieldDraftValue(row: GitHubProjectRow, field: GitHubProjectField): string {
  const value = row.fieldValuesByFieldId?.[field.id]
  if (!value) {
    return ''
  }
  if (value.kind === 'text') {
    return value.text
  }
  if (value.kind === 'number') {
    return String(value.number)
  }
  if (value.kind === 'date') {
    return value.date
  }
  return ''
}

export function normalizeProjectTableForMobileSort(
  table: GitHubProjectTable,
  rows: GitHubProjectRow[],
  sortOverride: ProjectSortOverride | null
): SharedGitHubProjectTable {
  const fields = table.selectedView.fields ?? []
  const overrideField = sortOverride
    ? fields.find((field) => field.id === sortOverride.fieldId)
    : undefined
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    content: {
      ...row.content,
      stateReason: row.content.stateReason ?? null,
      parentIssue: row.content.parentIssue ?? null,
      issueType: row.content.issueType ?? null
    },
    fieldValuesByFieldId: row.fieldValuesByFieldId ?? {},
    position: row.position ?? index
  }))

  return {
    ...table,
    selectedView: {
      ...table.selectedView,
      fields,
      groupByFields: table.selectedView.groupByFields ?? [],
      sortByFields:
        sortOverride && overrideField
          ? [{ field: overrideField, direction: sortOverride.direction }]
          : (table.selectedView.sortByFields ?? [])
    },
    rows: normalizedRows,
    parentFieldDropped: table.parentFieldDropped === true
  } as unknown as SharedGitHubProjectTable
}

export function projectGroupMeta(group: ProjectGroup): string {
  const parts = [`${group.rows.length}`]
  if (group.iteration) {
    const endDate = new Date(`${group.iteration.startDate}T00:00:00Z`)
    if (!Number.isNaN(endDate.getTime())) {
      endDate.setUTCDate(endDate.getUTCDate() + group.iteration.duration - 1)
      parts.push(`${group.iteration.startDate} - ${endDate.toISOString().slice(0, 10)}`)
    }
    if (isIterationCurrent(group.iteration)) {
      parts.push('Current')
    }
  }
  return parts.join(' · ')
}

export function optimisticProjectFieldValue(
  field: GitHubProjectField,
  value: GitHubProjectFieldMutationValue
): GitHubProjectFieldValue {
  if (value.kind === 'single-select' && field.kind === 'single-select') {
    const option = field.options.find((entry) => entry.id === value.optionId)
    return {
      kind: 'single-select',
      fieldId: field.id,
      optionId: value.optionId,
      name: option?.name ?? 'Selected',
      color: option?.color ?? 'GRAY'
    }
  }
  if (value.kind === 'iteration' && field.kind === 'iteration') {
    const iteration = field.iterations.find((entry) => entry.id === value.iterationId)
    return {
      kind: 'iteration',
      fieldId: field.id,
      iterationId: value.iterationId,
      title: iteration?.title ?? 'Iteration',
      startDate: iteration?.startDate ?? '',
      duration: iteration?.duration ?? 0
    }
  }
  if (value.kind === 'number') {
    return { kind: 'number', fieldId: field.id, number: value.number }
  }
  if (value.kind === 'date') {
    return { kind: 'date', fieldId: field.id, date: value.date }
  }
  return { kind: 'text', fieldId: field.id, text: value.kind === 'text' ? value.text : '' }
}
