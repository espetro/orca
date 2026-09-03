import type {
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
} from '../../../shared/linear/agent-access'


import {
  type getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
  getIssueCommentThreadRoot as getLinearIssueCommentThreadRoot,
} from '../../linear/linear-issue-lookups'
import {
  LinearAgentAccessError,
} from '../../linear/issue-context'
import {
  linearError,
} from '../../linear/issue-context-errors'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'


type LinearCreateFieldIntent = {
  stateId?: string
  assigneeId?: string | null
  priority?: number
  estimate?: number | null
  dueDate?: string | null
  labelIds?: string[]
  projectId?: string
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}


export class LinearTaskResultFields {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

linearCreatedIssueMatchesIntent(
  issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  intent: LinearCreateFieldIntent
): boolean {
  if (intent.stateId !== undefined && issue.state?.id !== intent.stateId) {
    return false
  }
  if (intent.assigneeId !== undefined && (issue.assignee?.id ?? null) !== intent.assigneeId) {
    return false
  }
  if (intent.priority !== undefined && issue.priority !== intent.priority) {
    return false
  }
  if (intent.estimate !== undefined && (issue.estimate ?? null) !== intent.estimate) {
    return false
  }
  if (intent.dueDate !== undefined && (issue.dueDate ?? null) !== intent.dueDate) {
    return false
  }
  if (intent.projectId !== undefined && (issue.project?.id ?? null) !== intent.projectId) {
    return false
  }
  const issueLabelIds = issue.labelIds ?? issue.labels?.map((label) => label.id) ?? []
  if (intent.labelIds !== undefined && !sameStringSet(issueLabelIds, intent.labelIds)) {
    return false
  }
  return true
}

linearTaskFieldAlreadySet(
  operation: LinearIssueTaskUpdateRequest['operation'],
  record: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  update: {
    fields: {
      assigneeId?: string | null
      priority?: number
      estimate?: number | null
      dueDate?: string | null
      labelIds?: string[]
    }
  }
): boolean {
  if (operation === 'assignee') {
    return (record.assignee?.id ?? null) === update.fields.assigneeId
  }
  if (operation === 'priority') {
    return record.priority === update.fields.priority
  }
  if (operation === 'estimate') {
    return (record.estimate ?? null) === update.fields.estimate
  }
  if (operation === 'dueDate') {
    return (record.dueDate ?? null) === update.fields.dueDate
  }
  if (operation === 'labels') {
    const recordLabelIds = record.labelIds ?? record.labels?.map((label) => label.id) ?? []
    return sameStringSet(recordLabelIds, update.fields.labelIds ?? [])
  }
  return false
}

linearTaskUpdateResult(
  operation: LinearIssueTaskUpdateRequest['operation'],
  issue: LinearIssueSummary,
  workspaceId: string,
  previous: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  alreadySet: boolean
): LinearIssueTaskUpdateResult {
  return {
    issue: this.linearWriteIssueRef(issue),
    operation,
    previous: this.linearTaskResultFields(previous),
    current: this.linearTaskResultFields(current),
    meta: { workspaceId, alreadySet }
  }
}

linearTaskResultFields(
  record: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>
): LinearIssueTaskUpdateResult['current'] {
  return {
    assignee: record.assignee ?? null,
    priority: record.priority ?? null,
    estimate: record.estimate ?? null,
    dueDate: record.dueDate ?? null,
    labels: record.labels ?? []
  }
}

async resolveLinearCommentParentId(
  issueId: string,
  commentId: string,
  workspaceId: string
): Promise<string> {
  try {
    const root = await getLinearIssueCommentThreadRoot(issueId, commentId, workspaceId)
    if (!root) {
      throw linearError(
        'linear_invalid_parent',
        'The reply target is not a comment on this issue.',
        {
          nextSteps: ['Run `orca linear issue <id> --comments --json` to list valid comment ids.']
        }
      )
    }
    return root.id
  } catch (error) {
    if (error instanceof LinearAgentAccessError) {
      throw error
    }
    throw this.mapLinearReadFailure(error)
  }
}
}
