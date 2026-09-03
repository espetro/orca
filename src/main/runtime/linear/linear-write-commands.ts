import type {
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult,
  LinearSaveIssueRequest,
  LinearSaveIssueResult,
  LinearStatusSetResult
} from '../../../shared/linear/agent-access'
import {
  LINEAR_WRITE_BODY_CAP,
} from '../../../shared/linear/agent-access'
import type { LinearIssueUpdate } from '../../../shared/issue-mutation-types'


import {
  getIssue as getLinearIssue,
} from '../../linear/linear-issue-lookups'
import {
  createIssue as createLinearIssue,
  updateIssueForAgent as updateLinearIssueForAgent,
  updateIssue as updateLinearIssue
} from '../../linear/linear-issue-mutations'
import {
  addIssueComment as addLinearIssueComment,
} from '../../linear/linear-issue-comments'
import { LinearWriteFailure } from '../../linear/linear-issue-write-support'
import {
  linearError,
} from '../../linear/issue-context-errors'
import { writeIssueRelation } from '../../linear/issue-relation-write'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'


export class LinearWriteCommands {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

linearCreateIssue(
  teamId: string,
  title: string,
  description?: string,
  workspaceId?: string,
  parentIssueId?: string,
  projectId?: string | null,
  options?: {
    stateId?: string
    priority?: number
    estimate?: number | null
    dueDate?: string | null
    assigneeId?: string | null
    labelIds?: string[]
  }
): ReturnType<typeof createLinearIssue> {
  return createLinearIssue(teamId, title, description, workspaceId, {
    parentId: parentIssueId,
    projectId,
    ...options
  })
}

linearGetIssue(id: string, workspaceId?: string): ReturnType<typeof getLinearIssue> {
  return getLinearIssue(id, workspaceId)
}

linearUpdateIssue(
  id: string,
  updates: LinearIssueUpdate,
  workspaceId?: string
): ReturnType<typeof updateLinearIssue> {
  return updateLinearIssue(id, updates, workspaceId)
}

linearAddIssueComment(
  issueId: string,
  body: string,
  workspaceId?: string
): ReturnType<typeof addLinearIssueComment> {
  return addLinearIssueComment(issueId, body, workspaceId)
}

async linearIssueSetState(params: {
  input?: string
  current?: boolean
  workspaceId?: string
  to: string
  context?: LinearCurrentIssueContextHints
}): Promise<LinearStatusSetResult> {
  const target = await this.resolveLinearAgentWriteTarget(params)
  const teamId = target.issue.team?.id
  if (!teamId) {
    throw linearError('linear_invalid_state', 'The Linear issue does not have a team.')
  }
  const states = await this.getLinearTeamStatesForWrite(teamId, target.workspaceId)
  const state = this.resolveLinearAgentState(params.to, states)
  if (!state) {
    throw linearError(
      'linear_invalid_state',
      `No workflow state exactly matched "${params.to}".`,
      {
        states: states.map(({ id, name, type }) => ({ id, name, type })),
        nextSteps: [`Retry with one of the exact state names for ${target.issue.identifier}.`]
      }
    )
  }

  const previousState =
    target.issue.state?.id && target.issue.state.name
      ? { id: target.issue.state.id, name: target.issue.state.name }
      : null
  const alreadyInState = target.issue.state?.id === state.id
  if (!alreadyInState) {
    await this.runLinearAgentWrite(
      async (signal) => {
        const updated = await updateLinearIssueForAgent(
          target.issue.id,
          { stateId: state.id },
          target.workspaceId,
          {
            signal
          }
        )
        if (updated.state?.id !== state.id) {
          throw new LinearWriteFailure(
            'unconfirmed',
            'Linear state update could not be confirmed.'
          )
        }
        return updated
      },
      (cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the state change, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` and check the current state before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        )
    )
  }
  await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
  return {
    issue: this.linearWriteIssueRef(target.issue),
    state: { id: state.id, name: state.name, type: state.type },
    previousState,
    meta: { workspaceId: target.workspaceId, alreadyInState }
  }
}

async linearIssueRelationWrite(
  params: LinearIssueRelationWriteRequest
): Promise<LinearIssueRelationWriteResult> {
  const target = await this.resolveLinearAgentWriteTarget(params)
  const related = await this.resolveLinearAgentWriteTarget({
    input: params.relatedInput,
    workspaceId: target.workspaceId,
    context: params.context
  })
  if (target.issue.id === related.issue.id) {
    throw linearError('linear_write_failed', 'An issue cannot be related to itself.')
  }
  try {
    const result = await this.runLinearAgentWrite(
      (signal) =>
        writeIssueRelation({
          issue: { ...this.linearWriteIssueRef(target.issue), title: target.issue.title },
          relatedIssue: {
            ...this.linearWriteIssueRef(related.issue),
            title: related.issue.title
          },
          relationship: params.relationship,
          operation: params.operation,
          workspaceId: target.workspaceId,
          signal
        }),
      (cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the relation change, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --relations --workspace ${target.workspaceId} --json\` before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        )
    )
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, [
      target.issue.identifier,
      related.issue.identifier
    ])
    return result
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async linearSaveIssue(params: LinearSaveIssueRequest): Promise<LinearSaveIssueResult> {
  if ((params.description?.length ?? 0) > LINEAR_WRITE_BODY_CAP) {
    throw linearError('linear_body_too_large', 'Linear issue body is too large.')
  }
  if (!params.input && !params.current) {
    if (!params.title || !params.team) {
      throw linearError(
        'linear_write_failed',
        'Creating with save-issue requires both team and title.'
      )
    }
    const created = await this.linearIssueCreate({
      title: params.title,
      body: params.description,
      teamInput: params.team,
      state: params.state,
      assignee: params.assignee ?? undefined,
      priority: params.priority,
      estimate: params.estimate ?? undefined,
      dueDate: params.dueDate ?? undefined,
      labels: params.labels,
      projectInput: params.project ?? undefined,
      parentInput: params.parentId ?? undefined,
      workspaceId: params.workspaceId,
      writeId: params.writeId,
      context: params.context
    })
    return { ...created, meta: { ...created.meta, created: true } }
  }
  if (params.team !== undefined) {
    throw linearError('linear_write_failed', 'Team can only be set when creating an issue.')
  }
  const target = await this.resolveLinearAgentWriteTarget(params)
  const current = await this.readLinearAgentIssueWriteRecord(target.issue.id, target.workspaceId)
  const fields = await this.buildLinearSaveUpdate(params, current, target.workspaceId)
  if (Object.keys(fields).length === 0) {
    throw linearError('linear_write_failed', 'No issue fields were provided to save.')
  }
  const alreadySet = this.linearSavedIssueMatchesIntent(current, fields)
  const updated = alreadySet
    ? current
    : await this.runLinearAgentWrite(
        async (signal) => {
          const saved = await updateLinearIssueForAgent(
            target.issue.id,
            fields,
            target.workspaceId,
            { signal }
          )
          if (!this.linearSavedIssueMatchesIntent(saved, fields)) {
            throw new LinearWriteFailure(
              'unconfirmed',
              'Linear issue save could not be confirmed.'
            )
          }
          return saved
        },
        (cause) =>
          linearError(
            'linear_write_unconfirmed',
            'Linear may have applied the issue save, but Orca could not confirm it.',
            {
              nextSteps: [
                `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` before retrying.`
              ],
              ...(cause ? { cause } : {})
            }
          )
      )
  await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
  return {
    issue: updated,
    meta: {
      workspaceId: target.workspaceId,
      created: false
    }
  }
}

async linearIssueUpdateTask(
  params: LinearIssueTaskUpdateRequest
): Promise<LinearIssueTaskUpdateResult> {
  const target = await this.resolveLinearAgentWriteTarget(params)
  const current = await this.readLinearAgentIssueWriteRecord(target.issue.id, target.workspaceId)
  const update = await this.buildLinearTaskUpdate(params, current, target.workspaceId)
  if (!update) {
    throw linearError('linear_write_failed', 'No Linear task field update was requested.')
  }
  const alreadySet = this.linearTaskFieldAlreadySet(params.operation, current, update)
  if (!alreadySet) {
    await this.runLinearAgentWrite(
      async (signal) => {
        const updated = await updateLinearIssueForAgent(
          target.issue.id,
          update.fields,
          target.workspaceId,
          { signal }
        )
        if (!this.linearTaskFieldAlreadySet(params.operation, updated, update)) {
          throw new LinearWriteFailure(
            'unconfirmed',
            'Linear task field update could not be confirmed.'
          )
        }
        return updated
      },
      (cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the task update, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` and check the updated field before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        )
    )
  }
  await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
  const finalRecord = alreadySet
    ? current
    : await this.readLinearAgentIssueWriteRecord(target.issue.id, target.workspaceId)
  return this.linearTaskUpdateResult(
    params.operation,
    target.issue,
    target.workspaceId,
    current,
    finalRecord,
    alreadySet
  )
}
}
