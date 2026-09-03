import type {
  LinearIssueTaskUpdateRequest,
  LinearSaveIssueRequest,
} from '../../../shared/linear/agent-access'
import type { LinearIssueUpdate } from '../../../shared/issue-mutation-types'


import type {
  getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
} from '../../linear/linear-issue-lookups'
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

function labelsForIds(
  ids: string[],
  labels: { id?: string | null; name?: string | null; color?: string | null }[]
): { id: string; name: string; color?: string | null }[] {
  return ids.map((id) => {
    const label = labels.find((candidate) => candidate.id === id)
    return {
      id,
      name: label?.name ?? id,
      ...(label?.color ? { color: label.color } : {})
    }
  })
}

export class LinearIssueWriteFields {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

async buildLinearTaskUpdate(
  params: LinearIssueTaskUpdateRequest,
  current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  workspaceId: string
): Promise<{
  fields: {
    assigneeId?: string | null
    priority?: number
    estimate?: number | null
    dueDate?: string | null
    labelIds?: string[]
  }
  labels?: { id: string; name: string }[]
} | null> {
  if (params.operation === 'assignee') {
    const assigneeId = params.assigneeMe
      ? (await this.getLinearViewerForWrite(workspaceId)).id
      : params.assigneeId
    if (assigneeId === undefined) {
      throw linearError('linear_invalid_assignee', 'Pass --me, --to-id, or clear assignee.')
    }
    return { fields: { assigneeId } }
  }
  if (params.operation === 'priority') {
    if (params.priority === undefined) {
      throw linearError('linear_write_failed', 'Missing priority value.')
    }
    return { fields: { priority: params.priority } }
  }
  if (params.operation === 'estimate') {
    if (params.estimate === undefined) {
      throw linearError('linear_write_failed', 'Missing estimate value.')
    }
    return { fields: { estimate: params.estimate } }
  }
  if (params.operation === 'dueDate') {
    if (params.dueDate === undefined) {
      throw linearError('linear_write_failed', 'Missing due date value.')
    }
    return { fields: { dueDate: params.dueDate } }
  }
  if (params.operation === 'labels') {
    const mode = params.labelMode
    const inputs = params.labels ?? []
    if (!mode || inputs.length === 0) {
      throw linearError('linear_invalid_label', 'Pass at least one --label.')
    }
    const labels = await this.resolveLinearLabelsForIssue(current, inputs, workspaceId)
    const requestedIds = labels.map((label) => label.id)
    const existingIds = current.labelIds ?? current.labels?.map((label) => label.id) ?? []
    const nextIds =
      mode === 'set'
        ? requestedIds
        : mode === 'add'
          ? Array.from(new Set([...existingIds, ...requestedIds]))
          : existingIds.filter((id) => !requestedIds.includes(id))
    return {
      fields: { labelIds: nextIds },
      labels: labelsForIds(nextIds, [...(current.labels ?? []), ...labels])
    }
  }
  return null
}

async buildLinearSaveUpdate(
  params: LinearSaveIssueRequest,
  current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  workspaceId: string
): Promise<LinearIssueUpdate> {
  const fields: LinearIssueUpdate = {}
  if (params.title !== undefined) {
    fields.title = params.title
  }
  if (params.description !== undefined) {
    fields.description = params.description
  }
  if (params.priority !== undefined) {
    fields.priority = params.priority
  }
  if (params.estimate !== undefined) {
    fields.estimate = params.estimate
  }
  if (params.dueDate !== undefined) {
    fields.dueDate = params.dueDate
  }
  if (params.state !== undefined) {
    const states = await this.getLinearTeamStatesForWrite(current.team.id, workspaceId)
    const state = this.resolveLinearAgentState(params.state, states)
    if (!state) {
      throw linearError(
        'linear_invalid_state',
        `No workflow state exactly matched "${params.state}".`
      )
    }
    fields.stateId = state.id
  }
  if (params.assignee !== undefined) {
    fields.assigneeId =
      params.assignee === null
        ? null
        : await this.resolveLinearAssignee(params.assignee, current.team.id, workspaceId)
  }
  if (params.labels !== undefined) {
    if (params.labels.length === 0) {
      fields.labelIds = []
    } else {
      const labels = await this.resolveLinearLabelsForIssue(current, params.labels, workspaceId)
      fields.labelIds = labels.map((label) => label.id)
    }
  }
  if (params.project !== undefined) {
    fields.projectId =
      params.project === null
        ? null
        : (
            await this.resolveLinearCreateProject(params.project, {
              id: current.team.id,
              workspaceId
            })
          ).id
  }
  if (params.parentId !== undefined) {
    fields.parentId =
      params.parentId === null
        ? null
        : (
            await this.resolveLinearAgentWriteTarget({
              input: params.parentId,
              workspaceId,
              context: params.context
            })
          ).issue.id
    if (fields.parentId === current.id) {
      throw linearError('linear_invalid_parent', 'An issue cannot be its own parent.')
    }
  }
  return fields
}

linearSavedIssueMatchesIntent(
  issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  fields: LinearIssueUpdate
): boolean {
  if (fields.title !== undefined && issue.title !== fields.title) {
    return false
  }
  if (fields.description !== undefined && (issue.description ?? '') !== fields.description) {
    return false
  }
  if (fields.parentId !== undefined && (issue.parent?.id ?? null) !== fields.parentId) {
    return false
  }
  if (fields.stateId !== undefined && issue.state?.id !== fields.stateId) {
    return false
  }
  if (fields.assigneeId !== undefined && (issue.assignee?.id ?? null) !== fields.assigneeId) {
    return false
  }
  if (fields.priority !== undefined && issue.priority !== fields.priority) {
    return false
  }
  if (fields.estimate !== undefined && (issue.estimate ?? null) !== fields.estimate) {
    return false
  }
  if (fields.dueDate !== undefined && (issue.dueDate ?? null) !== fields.dueDate) {
    return false
  }
  if (fields.projectId !== undefined && (issue.project?.id ?? null) !== fields.projectId) {
    return false
  }
  const issueLabelIds = issue.labelIds ?? issue.labels?.map((label) => label.id) ?? []
  return fields.labelIds === undefined || sameStringSet(issueLabelIds, fields.labelIds)
}

async resolveLinearCreateFields(
  params: {
    state?: string
    assignee?: string
    priority?: number
    estimate?: number
    dueDate?: string
    labels?: string[]
    projectInput?: string
  },
  team: { id: string; workspaceId: string }
): Promise<LinearCreateFieldIntent> {
  const fields: LinearCreateFieldIntent = {}
  if (params.state) {
    const states = await this.getLinearTeamStatesForWrite(team.id, team.workspaceId)
    const state = this.resolveLinearAgentState(params.state, states)
    if (!state) {
      throw linearError(
        'linear_invalid_state',
        `No workflow state exactly matched "${params.state}".`,
        { states: states.map(({ id, name, type }) => ({ id, name, type })) }
      )
    }
    fields.stateId = state.id
  }
  if (params.assignee) {
    fields.assigneeId = await this.resolveLinearAssignee(
      params.assignee,
      team.id,
      team.workspaceId
    )
  }
  if (params.priority !== undefined) {
    fields.priority = params.priority
  }
  if (params.estimate !== undefined) {
    fields.estimate = params.estimate
  }
  if (params.dueDate !== undefined) {
    fields.dueDate = params.dueDate
  }
  if (params.labels && params.labels.length > 0) {
    const labels = await this.resolveLinearLabelsForTeam(team.id, params.labels, team.workspaceId)
    fields.labelIds = labels.map((label) => label.id)
  }
  if (params.projectInput) {
    const project = await this.resolveLinearCreateProject(params.projectInput, team)
    fields.projectId = project.id
  }
  return fields
}

async resolveLinearLabelsForIssue(
  issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  inputs: string[],
  workspaceId: string
): Promise<{ id: string; name: string }[]> {
  const labels = await this.getLinearTeamLabelsForWrite(issue.team.id, workspaceId)
  const resolved = inputs.map((input) => {
    const normalized = input.toLocaleLowerCase()
    const idMatch = labels.find((label) => label.id.toLocaleLowerCase() === normalized)
    if (idMatch) {
      return { id: idMatch.id, name: idMatch.name }
    }
    const nameMatches = labels.filter((label) => label.name.toLocaleLowerCase() === normalized)
    if (nameMatches.length === 1) {
      return { id: nameMatches[0].id, name: nameMatches[0].name }
    }
    throw linearError(
      'linear_invalid_label',
      nameMatches.length === 0
        ? `No label exactly matched "${input}".`
        : `Multiple labels exactly matched "${input}".`,
      {
        labels: labels.map((label) => ({ id: label.id, name: label.name })),
        nextSteps: ['Run `orca linear team labels --team <key-or-id> --json` and retry by id.']
      }
    )
  })
  return Array.from(new Map(resolved.map((label) => [label.id, label])).values())
}

async resolveLinearLabelsForTeam(
  teamId: string,
  inputs: string[],
  workspaceId: string
): Promise<{ id: string; name: string }[]> {
  const labels = await this.getLinearTeamLabelsForWrite(teamId, workspaceId)
  const resolved = inputs.map((input) => {
    const normalized = input.toLocaleLowerCase()
    const idMatch = labels.find((label) => label.id.toLocaleLowerCase() === normalized)
    if (idMatch) {
      return { id: idMatch.id, name: idMatch.name }
    }
    const nameMatches = labels.filter((label) => label.name.toLocaleLowerCase() === normalized)
    if (nameMatches.length === 1) {
      return { id: nameMatches[0].id, name: nameMatches[0].name }
    }
    throw linearError(
      'linear_invalid_label',
      nameMatches.length === 0
        ? `No label exactly matched "${input}".`
        : `Multiple labels exactly matched "${input}".`,
      { labels: labels.map((label) => ({ id: label.id, name: label.name })) }
    )
  })
  return Array.from(new Map(resolved.map((label) => [label.id, label])).values())
}
}
