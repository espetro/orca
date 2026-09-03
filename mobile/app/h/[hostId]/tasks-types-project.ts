import type { GitHubProjectRef } from '../../../src/tasks/github-project-reference'
import type { GitHubProjectSortDirection } from '../../../../src/shared/github/project-types'

export type GitHubIssueType = {
  id: string
  name: string
  color: string | null
  description: string | null
}
export type GitHubProjectField =
  | {
      kind: 'field'
      id: string
      name: string
      dataType: string
    }
  | {
      kind: 'single-select'
      id: string
      name: string
      dataType: 'SINGLE_SELECT'
      options: Array<{ id: string; name: string; color: string }>
    }
  | {
      kind: 'iteration'
      id: string
      name: string
      dataType: 'ITERATION'
      iterations: Array<{
        id: string
        title: string
        startDate: string
        duration: number
        completed?: boolean
      }>
    }
export type GitHubProjectSort = {
  direction: GitHubProjectSortDirection
  field: GitHubProjectField
}
export type GitHubProjectFieldValue =
  | { kind: 'single-select'; fieldId: string; optionId: string; name: string; color: string }
  | {
      kind: 'iteration'
      fieldId: string
      iterationId: string
      title: string
      startDate: string
      duration: number
    }
  | { kind: 'text'; fieldId: string; text: string }
  | { kind: 'number'; fieldId: string; number: number }
  | { kind: 'date'; fieldId: string; date: string }
  | { kind: 'labels'; fieldId: string; labels: Array<{ name: string; color: string }> }
  | { kind: 'users'; fieldId: string; users: Array<{ login: string; name: string | null }> }
export type GitHubProjectFieldMutationValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'date'; date: string }
  | { kind: 'single-select'; optionId: string }
  | { kind: 'iteration'; iterationId: string }
export type GitHubProjectRow = {
  id: string
  itemType: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'
  content: {
    number: number | null
    title: string
    body: string | null
    url: string | null
    state: string | null
    stateReason?: string | null
    isDraft: boolean | null
    repository: string | null
    issueType?: GitHubIssueType | null
    labels: Array<{ name: string; color: string }>
    assignees: Array<{ login: string; name: string | null }>
    parentIssue?: { number: number; title: string; url: string } | null
  }
  fieldValuesByFieldId?: Record<string, GitHubProjectFieldValue>
  updatedAt: string
  position?: number
}
export type GitHubProjectTable = {
  project: GitHubProjectRef & {
    id: string
    title: string
    url: string
  }
  selectedView: {
    id: string
    number: number
    name: string
    filter: string
    layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'
    fields?: GitHubProjectField[]
    groupByFields?: GitHubProjectField[]
    sortByFields?: GitHubProjectSort[]
  }
  rows: GitHubProjectRow[]
  totalCount: number
  parentFieldDropped?: boolean
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
