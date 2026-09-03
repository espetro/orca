/* eslint-disable max-lines -- Why: Linear and Jira command surfaces are large third-party adapters; this file is the collaborator-class split for the Linear/Jira integration and will shrink further in later passes. */
import { randomUUID } from 'node:crypto'
import type { LinearCustomViewModel, LinearProjectSummary } from '../../shared/linear/project-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'
import type {
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueUpdate,
  JiraSiteSelection
} from '../../shared/jira-types'
import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearErrorCode,
  LinearIssueListFilter,
  LinearIssueListResult,
  LinearProjectListResult,
  LinearIssueSummary,
  LinearIssueRequest,
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult,
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult,
  LinearSaveIssueRequest,
  LinearSaveIssueResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult,
  LinearStatusSetResult
} from '../../shared/linear/agent-access'
import {
  LINEAR_SEARCH_MAX_LIMIT,
  LINEAR_WRITE_BODY_CAP,
  clampLinearSearchLimit
} from '../../shared/linear/agent-access'
import { isLinearUuid } from '../../shared/linear/uuid'
import { linearPriorityLabel } from '../../shared/linear/priority-label'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import { sameStringSet } from '../../shared/string-set'
import type { RuntimeLinearCommandHost } from './runtime-linear-command-host'
import {
  connect as connectLinear,
  disconnect as disconnectLinear,
  getStatus as getLinearStatus,
  isAuthError as isLinearAuthError,
  selectWorkspace as selectLinearWorkspace,
  testConnection as testLinearConnection
} from '../linear/client'
import {
  getAttachmentByUuidForAgent as getLinearAttachmentByUuidForAgent,
  getCommentByUuidForAgent as getLinearCommentByUuidForAgent,
  getIssue as getLinearIssue,
  getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
  getIssueCommentThreadRoot as getLinearIssueCommentThreadRoot,
  searchIssues as searchLinearIssues
} from '../linear/linear-issue-lookups'
import {
  listIssues as listLinearIssues,
  type LinearListFilter
} from '../linear/linear-issue-listing'
import {
  createIssueForAgent as createLinearIssueForAgent,
  createIssue as createLinearIssue,
  updateIssueForAgent as updateLinearIssueForAgent,
  updateIssue as updateLinearIssue
} from '../linear/linear-issue-mutations'
import {
  addIssueComment as addLinearIssueComment,
  addIssueCommentForAgent as addLinearIssueCommentForAgent,
  createIssueAttachment as createLinearIssueAttachment,
  getIssueComments as getLinearIssueComments
} from '../linear/linear-issue-comments'
import { LinearWriteFailure } from '../linear/linear-issue-write-support'
import type { LinearIssueListOptions } from '../linear/linear-issue-query-documents'
import {
  LinearAgentAccessError,
  getLinearCurrentIssueFromWorktree,
  readLinearIssueContext,
  resolveLegacyLinearLinkWorkspace,
  searchLinearIssuesForAgents
} from '../linear/issue-context'
import {
  classifyLinearError,
  linearError,
  linearMessage,
  sanitizeLinearErrorMessage
} from '../linear/issue-context-errors'
import { listMcpIssues } from '../linear/mcp-issue-list'
import { writeIssueRelation } from '../linear/issue-relation-write'
import {
  createProject as createLinearProject,
  getCustomView as getLinearCustomView,
  getProject as getLinearProject,
  listCustomViewIssues as listLinearCustomViewIssues,
  listCustomViewProjects as listLinearCustomViewProjects,
  listCustomViews as listLinearCustomViews,
  listProjectsByExactName as listLinearProjectsByExactName,
  listProjectIssues as listLinearProjectIssues,
  listProjectTeams as listLinearProjectTeams,
  listProjects as listLinearProjects,
  type LinearProjectCreateInput
} from '../linear/projects'
import {
  getTeamLabels as getLinearTeamLabels,
  getTeamLabelsOrThrow as getLinearTeamLabelsOrThrow,
  getTeamMembers as getLinearTeamMembers,
  getTeamMembersOrThrow as getLinearTeamMembersOrThrow,
  getTeamStates as getLinearTeamStates,
  getTeamStatesOrThrow as getLinearTeamStatesOrThrow,
  getViewerForWorkspaceOrThrow as getLinearViewerForWorkspaceOrThrow,
  listTeamsForAgent as listLinearTeamsForAgent,
  listTeams as listLinearTeams,
  listTeamsOrThrow as listLinearTeamsOrThrow
} from '../linear/teams'
import {
  connect as connectJira,
  disconnect as disconnectJira,
  getStatus as getJiraStatus,
  selectSite as selectJiraSite,
  testConnection as testJiraConnection
} from '../jira/client'
import {
  addIssueComment as addJiraIssueComment,
  createIssue as createJiraIssue,
  getIssue as getJiraIssue,
  getIssueSummary as getJiraIssueSummary,
  getIssueComments as getJiraIssueComments,
  getProjectStatusOrder as getJiraProjectStatusOrder,
  listAssignableUsers as listJiraAssignableUsers,
  listCreateFields as listJiraCreateFields,
  listIssueTypes as listJiraIssueTypes,
  listIssues as listJiraIssues,
  listPriorities as listJiraPriorities,
  listProjects as listJiraProjects,
  listTransitions as listJiraTransitions,
  searchIssues as searchJiraIssues,
  updateIssue as updateJiraIssue
} from '../jira/issues'

export class RuntimeLinearCommands {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

// ── Linear integration ──

linearConnect(apiKey: string): ReturnType<typeof connectLinear> {
  return connectLinear(apiKey)
}

linearDisconnect(workspaceId?: string): { ok: true } {
  disconnectLinear(workspaceId)
  return { ok: true }
}

linearSelectWorkspace(workspaceId: LinearWorkspaceSelection): ReturnType<typeof getLinearStatus> {
  return selectLinearWorkspace(workspaceId)
}

linearStatus(): ReturnType<typeof getLinearStatus> {
  return getLinearStatus()
}

linearTestConnection(workspaceId?: string): ReturnType<typeof testLinearConnection> {
  return testLinearConnection(workspaceId)
}

linearSearchIssues(
  query: string,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection
): ReturnType<typeof searchLinearIssues> {
  return searchLinearIssues(query, Math.min(Math.max(1, limit), 50), workspaceId)
}

linearSearchForAgents(args: {
  query: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}): ReturnType<typeof searchLinearIssuesForAgents> {
  return searchLinearIssuesForAgents(args)
}

linearIssueContext(request: LinearIssueRequest): ReturnType<typeof readLinearIssueContext> {
  return readLinearIssueContext(request, (context) => this.linearResolveCurrentIssue(context))
}

async linearTeamListForAgents(params: {
  workspaceId?: (string & {}) | 'all'
}): Promise<LinearTeamListResult> {
  try {
    const result = await listLinearTeamsForAgent(params.workspaceId)
    const workspaceErrors = result.errors.map((error) => ({
      workspace: { id: error.workspaceId, name: error.workspaceName ?? error.workspaceId },
      code: this.linearWorkspaceErrorCode(error.type),
      message: sanitizeLinearErrorMessage(error.message)
    }))
    return {
      teams: result.teams.map((team) => this.linearTeamSummary(team)),
      meta: {
        workspaceId: params.workspaceId,
        returned: result.teams.length,
        partial: workspaceErrors.length > 0,
        workspaceErrors
      }
    }
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async linearTeamMembersForAgents(params: {
  teamInput: string
  workspaceId?: string
}): Promise<LinearTeamMembersResult> {
  const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
  try {
    const members = await getLinearTeamMembersOrThrow(team.id, team.workspaceId)
    return {
      team: this.linearTeamSummary(team),
      members: members.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl
      })),
      meta: { workspaceId: team.workspaceId, returned: members.length }
    }
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async linearTeamStatesForAgents(params: {
  teamInput: string
  workspaceId?: string
}): Promise<LinearTeamStatesResult> {
  const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
  const states = await this.getLinearTeamStatesForWrite(team.id, team.workspaceId)
  return {
    team: this.linearTeamSummary(team),
    states: states.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      color: state.color,
      position: state.position
    })),
    meta: { workspaceId: team.workspaceId, returned: states.length }
  }
}

async linearTeamLabelsForAgents(params: {
  teamInput: string
  workspaceId?: string
}): Promise<LinearTeamLabelsResult> {
  const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
  const labels = await this.getLinearTeamLabelsForWrite(team.id, team.workspaceId)
  return {
    team: this.linearTeamSummary(team),
    labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    meta: { workspaceId: team.workspaceId, returned: labels.length }
  }
}

async linearProjectListForAgents(params: {
  query?: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}): Promise<LinearProjectListResult> {
  const limit = clampLinearSearchLimit(params.limit)
  try {
    const result = await this.linearListProjects(params.query, limit, params.workspaceId, true)
    const projects = result.items.slice(0, limit).map((project) => ({
      id: project.id,
      name: project.name,
      ...(project.url ? { url: project.url } : {}),
      ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
      ...(project.workspaceName ? { workspaceName: project.workspaceName } : {}),
      ...(project.teams ? { teams: project.teams } : {})
    }))
    const workspaceErrors = (result.errors ?? []).map((error) => ({
      workspace: { id: error.workspaceId, name: error.workspaceName ?? error.workspaceId },
      code: this.linearWorkspaceErrorCode(error.type),
      message: sanitizeLinearErrorMessage(error.message)
    }))
    const hasMore = result.hasMore === true || result.items.length > limit
    return {
      projects,
      truncated: hasMore,
      meta: {
        query: params.query,
        workspaceId: params.workspaceId,
        limit,
        returned: projects.length,
        hasMore,
        partial: workspaceErrors.length > 0,
        workspaceErrors
      }
    }
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async linearIssueListForAgents(params: {
  filter?: LinearIssueListFilter
  teamInput?: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}): Promise<LinearIssueListResult> {
  const filter = params.filter ?? 'assigned'
  const limit = clampLinearIssueListLimit(params.limit)
  const team = params.teamInput
    ? await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
    : null
  const workspaceId = team?.workspaceId ?? params.workspaceId
  try {
    const result = await listLinearIssues(filter, limit, workspaceId, {
      teamId: team?.id
    })
    return {
      issues: result.items.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        team: issue.team,
        project: issue.project ?? null,
        assignee: issue.assignee ?? null,
        priority: issue.priority,
        estimate: issue.estimate,
        dueDate: issue.dueDate,
        updatedAt: issue.updatedAt,
        priorityLabel: linearPriorityLabel(issue.priority),
        workspace: {
          id: issue.workspaceId ?? workspaceId ?? '',
          name: issue.workspaceName ?? issue.workspaceId ?? workspaceId ?? ''
        }
      })),
      truncated: result.hasMore === true,
      meta: {
        filter,
        workspaceId,
        ...(team ? { team: this.linearTeamSummary(team) } : {}),
        limit,
        returned: result.items.length,
        hasMore: result.hasMore === true,
        partial: (result.errors?.length ?? 0) > 0,
        workspaceErrors: (result.errors ?? []).map((error) => ({
          workspace: { id: error.workspaceId, name: error.workspaceName ?? error.workspaceId },
          code: this.linearWorkspaceErrorCode(error.type),
          message: sanitizeLinearErrorMessage(error.message)
        }))
      }
    }
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async linearMcpIssueList(params: LinearMcpIssueListRequest): Promise<LinearMcpIssueListResult> {
  try {
    return await listMcpIssues(params)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async linearResolveCurrentIssue(
  context?: LinearCurrentIssueContextHints
): Promise<ReturnType<typeof getLinearCurrentIssueFromWorktree>> {
  if (!this.store) {
    throw new Error('runtime_unavailable')
  }

  let worktree: ResolvedWorktree | null = null
  if (context?.terminalHandle) {
    try {
      const terminal = await this.showTerminal(context.terminalHandle)
      if (context.worktreeId && context.worktreeId !== terminal.worktreeId) {
        throw new LinearAgentAccessError(
          'linear_permission_denied',
          'The provided Linear worktree context does not match the caller terminal.'
        )
      }
      worktree = await this.resolveWorktreeSelector(`id:${terminal.worktreeId}`)
    } catch (error) {
      if (error instanceof LinearAgentAccessError) {
        throw error
      }
      if (context.remote === true || context.worktreeId) {
        throw new LinearAgentAccessError(
          'linear_issue_required',
          'Could not verify the current Linear-linked worktree.'
        )
      }
    }
  }

  if (!worktree && context?.remote !== true && context?.cwd) {
    worktree = await this.resolveWorktreeForContainedPath(context.cwd)
    if (!worktree) {
      throw new LinearAgentAccessError(
        'linear_issue_required',
        'Run --current from inside an Orca-managed worktree or pass an issue id.'
      )
    }
  }

  if (!worktree) {
    throw new LinearAgentAccessError(
      'linear_issue_required',
      'Run --current from inside an Orca-managed worktree or pass an issue id.'
    )
  }

  const link = getLinearCurrentIssueFromWorktree(worktree)
  if (!link.workspaceId) {
    const backfill = resolveLegacyLinearLinkWorkspace(
      worktree.linkedLinearIssue ?? '',
      worktree.linkedLinearIssueOrganizationUrlKey
    )
    if (backfill?.workspaceId) {
      this.store.setWorktreeMeta(worktree.id, {
        linkedLinearIssueWorkspaceId: backfill.workspaceId,
        linkedLinearIssueOrganizationUrlKey: backfill.organizationUrlKey ?? null
      })
      return {
        ...link,
        workspaceId: backfill.workspaceId,
        organizationUrlKey: backfill.organizationUrlKey ?? link.organizationUrlKey,
        backfill
      }
    }
  }
  return link
}

private async resolveWorktreeForContainedPath(cwd: string): Promise<ResolvedWorktree | null> {
  const currentPath = resolve(cwd)
  let best: ResolvedWorktree | null = null
  for (const candidate of await this.listResolvedWorktrees()) {
    if (!isPathInsideOrEqual(candidate.path, currentPath)) {
      continue
    }
    if (!best || candidate.path.length > best.path.length) {
      best = candidate
    }
  }
  return best
}

linearListIssues(
  filter?: LinearListFilter,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  options?: LinearIssueListOptions
): ReturnType<typeof listLinearIssues> {
  return listLinearIssues(filter, clampLinearIssueListLimit(limit), workspaceId, options)
}

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

async linearIssueAddComment(params: {
  input?: string
  current?: boolean
  workspaceId?: string
  body: string
  replyTo?: string
  writeId?: string
  context?: LinearCurrentIssueContextHints
}): Promise<LinearCommentAddResult> {
  if (params.body.length > LINEAR_WRITE_BODY_CAP) {
    throw linearError('linear_body_too_large', 'Linear comment body is too large.')
  }
  const target = await this.resolveLinearAgentWriteTarget(params)
  const parentId = params.replyTo
    ? await this.resolveLinearCommentParentId(target.issue.id, params.replyTo, target.workspaceId)
    : null
  const writeId = params.writeId ?? randomUUID()
  const existing =
    params.writeId !== undefined
      ? await this.getMatchingLinearCommentWrite(
          writeId,
          target.issue.id,
          parentId,
          target.workspaceId,
          true
        )
      : null
  if (existing) {
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearCommentResult(existing, target, params.body.length, writeId, true)
  }

  try {
    const comment = await this.runLinearAgentWrite(
      (signal) =>
        addLinearIssueCommentForAgent(target.issue.id, params.body, target.workspaceId, {
          id: writeId,
          parentId,
          signal
        }),
      (cause) =>
        this.linearCreateStyleUnconfirmed('comment', writeId, target, {
          parentId,
          bodyRequired: true,
          cause
        })
    )
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearCommentResult(comment, target, params.body.length, writeId, false)
  } catch (error) {
    if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
      const comment = await this.refetchLinearCommentAfterDuplicate(
        writeId,
        target.issue.id,
        parentId,
        target.workspaceId,
        () =>
          this.linearCreateStyleUnconfirmed('comment', writeId, target, {
            parentId,
            bodyRequired: true
          })
      )
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
      return this.linearCommentResult(comment, target, params.body.length, writeId, true)
    }
    throw error
  }
}

async linearIssueAttachLink(params: {
  input?: string
  current?: boolean
  workspaceId?: string
  url: string
  title?: string
  writeId?: string
  context?: LinearCurrentIssueContextHints
}): Promise<LinearAttachResult> {
  const url = this.parseLinearAttachmentUrl(params.url)
  const target = await this.resolveLinearAgentWriteTarget(params)
  const writeId = params.writeId ?? randomUUID()
  const title = params.title?.trim() || this.defaultLinearAttachmentTitle(url)
  const existing =
    params.writeId !== undefined
      ? await this.getMatchingLinearAttachmentWrite(
          writeId,
          target.issue.id,
          target.workspaceId,
          true
        )
      : null
  if (existing) {
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearAttachResult(existing, target, writeId, true)
  }
  try {
    const attachment = await this.runLinearAgentWrite(
      (signal) =>
        createLinearIssueAttachment(
          target.issue.id,
          { id: writeId, title, url: url.toString() },
          target.workspaceId,
          { signal }
        ),
      (cause) =>
        this.linearCreateStyleUnconfirmed('attach', writeId, target, {
          title,
          url: url.toString(),
          cause
        })
    )
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearAttachResult(attachment, target, writeId, false)
  } catch (error) {
    if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
      const attachment = await this.refetchLinearAttachmentAfterDuplicate(
        writeId,
        target.issue.id,
        target.workspaceId,
        () =>
          this.linearCreateStyleUnconfirmed('attach', writeId, target, {
            title,
            url: url.toString()
          })
      )
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
      return this.linearAttachResult(attachment, target, writeId, true)
    }
    throw error
  }
}

async linearIssueCreate(params: {
  title: string
  body?: string
  teamInput?: string
  teamKey?: string
  state?: string
  assignee?: string
  priority?: number
  estimate?: number
  dueDate?: string
  labels?: string[]
  projectInput?: string
  parentInput?: string
  parentCurrent?: boolean
  workspaceId?: string
  writeId?: string
  context?: LinearCurrentIssueContextHints
}): Promise<LinearCreateResult> {
  if ((params.body?.length ?? 0) > LINEAR_WRITE_BODY_CAP) {
    throw linearError('linear_body_too_large', 'Linear issue body is too large.')
  }
  const parent =
    params.parentInput || params.parentCurrent
      ? await this.resolveLinearAgentWriteTarget({
          input: params.parentInput,
          current: params.parentCurrent,
          workspaceId: params.workspaceId,
          context: params.context
        })
      : null
  if (parent && params.workspaceId && params.workspaceId !== parent.workspaceId) {
    throw linearError(
      'linear_invalid_workspace',
      'The parent issue belongs to a different workspace.'
    )
  }
  const team = await this.resolveLinearCreateTeam(
    params.teamInput ?? params.teamKey,
    params.workspaceId,
    parent
  )
  const createFields = await this.resolveLinearCreateFields(params, team)
  const parentId = parent?.issue.id ?? null
  const writeId = params.writeId ?? randomUUID()
  const existing =
    params.writeId !== undefined
      ? await this.getMatchingLinearCreatedIssue(
          writeId,
          team.id,
          parentId,
          team.workspaceId,
          true,
          createFields
        )
      : null
  if (existing) {
    if (parent) {
      await this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
    }
    return this.linearCreateResult(existing, team.workspaceId, writeId, true)
  }

  try {
    const issue = await this.runLinearAgentWrite(
      async (signal) => {
        const created = await createLinearIssueForAgent(
          team.id,
          params.title,
          params.body,
          team.workspaceId,
          {
            id: writeId,
            parentId,
            ...createFields,
            signal
          }
        )
        if (!this.linearCreatedIssueMatchesIntent(created, createFields)) {
          throw new LinearWriteFailure(
            'unconfirmed',
            'Linear issue create could not be confirmed with the requested task fields.'
          )
        }
        return created
      },
      (cause) =>
        this.linearCreateStyleUnconfirmed('create', writeId, null, {
          team,
          parent,
          title: params.title,
          bodyRequired: params.body !== undefined,
          createFields,
          cause
        })
    )
    if (parent) {
      await this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
    }
    return this.linearCreateResult(issue, team.workspaceId, writeId, false)
  } catch (error) {
    if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
      const issue = await this.refetchLinearIssueAfterDuplicate(
        writeId,
        team.id,
        parentId,
        team.workspaceId,
        createFields,
        () =>
          this.linearCreateStyleUnconfirmed('create', writeId, null, {
            team,
            parent,
            title: params.title,
            bodyRequired: params.body !== undefined,
            createFields
          })
      )
      if (parent) {
        await this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
      }
      return this.linearCreateResult(issue, team.workspaceId, writeId, true)
    }
    throw error
  }
}

private async resolveLinearAgentWriteTarget(params: {
  input?: string
  current?: boolean
  workspaceId?: string
  context?: LinearCurrentIssueContextHints
}): Promise<LinearAgentWriteTarget> {
  const result = await readLinearIssueContext(
    {
      input: params.input,
      current: params.current,
      workspaceId: params.workspaceId,
      include: {
        comments: false,
        children: false,
        attachments: false,
        relations: false,
        activity: false
      },
      depth: 0,
      context: params.context
    },
    (context) => this.linearResolveCurrentIssue(context)
  )
  return { issue: result.issue, workspaceId: result.meta.resolved.workspaceId }
}

private async getLinearTeamStatesForWrite(
  teamId: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>> {
  try {
    return await getLinearTeamStatesOrThrow(teamId, workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private resolveLinearAgentState(
  input: string,
  states: Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>
): Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>[number] | null {
  const normalized = input.toLocaleLowerCase()
  const exact = states.find(
    (state) =>
      state.id.toLocaleLowerCase() === normalized || state.name.toLocaleLowerCase() === normalized
  )
  // Why: Linear MCP accepts lifecycle types; keep explicit IDs/names authoritative when they collide.
  return exact ?? states.find((state) => state.type.toLocaleLowerCase() === normalized) ?? null
}

private async getLinearTeamLabelsForWrite(
  teamId: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof getLinearTeamLabelsOrThrow>>> {
  try {
    return await getLinearTeamLabelsOrThrow(teamId, workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private async readLinearAgentIssueWriteRecord(
  issueId: string,
  workspaceId: string
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>> {
  const issue = await this.readLinearWriteLookup(() =>
    getLinearIssueByUuidForAgent(issueId, workspaceId)
  )
  if (!issue) {
    throw linearError('linear_issue_not_found', 'Linear issue was not found.')
  }
  return issue
}

private async buildLinearTaskUpdate(
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

private async buildLinearSaveUpdate(
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

private async resolveLinearAssignee(
  input: string,
  teamId: string,
  workspaceId: string
): Promise<string> {
  if (input.toLocaleLowerCase() === 'me') {
    return (await this.getLinearViewerForWrite(workspaceId)).id
  }
  // Why: caller-supplied IDs were accepted directly before save-issue; avoid a paginated member scan on that existing fast path.
  if (isLinearUuid(input)) {
    return input
  }
  let members: Awaited<ReturnType<typeof getLinearTeamMembersOrThrow>>
  try {
    members = await getLinearTeamMembersOrThrow(teamId, workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
  const normalized = input.toLocaleLowerCase()
  const matches = members.filter(
    (member) =>
      member.id.toLocaleLowerCase() === normalized ||
      member.displayName.toLocaleLowerCase() === normalized ||
      member.name?.toLocaleLowerCase() === normalized ||
      member.email?.toLocaleLowerCase() === normalized
  )
  if (matches.length === 1) {
    return matches[0].id
  }
  throw linearError(
    'linear_invalid_assignee',
    matches.length === 0
      ? `No team member exactly matched "${input}".`
      : `Multiple team members exactly matched "${input}".`
  )
}

private linearSavedIssueMatchesIntent(
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

private async resolveLinearCreateFields(
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

private async resolveLinearCreateProject(
  input: string,
  team: { id: string; workspaceId: string }
): Promise<LinearProjectSummary> {
  const trimmed = input.trim()
  if (!trimmed) {
    throw linearError('linear_invalid_project', 'Pass a non-empty Linear project id or name.')
  }
  const byId = isLinearUuid(trimmed)
    ? await this.readLinearProjectByIdForCreate(trimmed, team.workspaceId)
    : null
  if (byId) {
    await this.assertLinearProjectIncludesTeam(byId, team.id, team.workspaceId, trimmed)
    return byId
  }
  const searchCandidates = await this.readLinearProjectsForCreate(trimmed, team.workspaceId)
  const normalized = trimmed.toLowerCase()
  const idMatch = searchCandidates.find((project) => project.id.toLowerCase() === normalized)
  if (idMatch) {
    await this.assertLinearProjectIncludesTeam(idMatch, team.id, team.workspaceId, trimmed)
    return idMatch
  }
  const slugMatch = searchCandidates.find(
    (project) => project.slugId?.toLowerCase() === normalized
  )
  if (slugMatch) {
    await this.assertLinearProjectIncludesTeam(slugMatch, team.id, team.workspaceId, trimmed)
    return slugMatch
  }
  const nameMatches = await this.readLinearProjectsByExactNameForCreate(trimmed, team.workspaceId)
  const compatibleNameMatches = await this.filterLinearProjectsForTeam(
    nameMatches,
    team.id,
    team.workspaceId
  )
  if (compatibleNameMatches.length === 1) {
    return compatibleNameMatches[0]
  }
  if (compatibleNameMatches.length > 1) {
    throw linearError(
      'linear_invalid_project',
      `Multiple Linear projects exactly matched "${trimmed}".`,
      {
        projects: compatibleNameMatches.map((project) => ({
          id: project.id,
          name: project.name,
          teams: project.teams
        })),
        nextSteps: ['Run `orca linear project list --query <name> --json` and retry by id.']
      }
    )
  }
  if (nameMatches.length > 0) {
    await this.assertLinearProjectIncludesTeam(nameMatches[0], team.id, team.workspaceId, trimmed)
  }
  throw linearError('linear_invalid_project', `No Linear project exactly matched "${trimmed}".`, {
    projects: searchCandidates.map((project) => ({
      id: project.id,
      name: project.name,
      teams: project.teams
    })),
    nextSteps: ['Run `orca linear project list --query <name> --json` and retry by id.']
  })
}

private async readLinearProjectByIdForCreate(
  id: string,
  workspaceId: string
): Promise<LinearProjectSummary | null> {
  try {
    return await getLinearProject(id, workspaceId, true)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private async readLinearProjectsForCreate(
  query: string,
  workspaceId: string
): Promise<LinearProjectSummary[]> {
  try {
    return (await listLinearProjects(query, LINEAR_SEARCH_MAX_LIMIT, workspaceId, true)).items
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private async readLinearProjectsByExactNameForCreate(
  name: string,
  workspaceId: string
): Promise<LinearProjectSummary[]> {
  try {
    return await listLinearProjectsByExactName(name, workspaceId, true)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private async assertLinearProjectIncludesTeam(
  project: LinearProjectSummary,
  teamId: string,
  workspaceId: string,
  input: string
): Promise<void> {
  if (this.linearProjectIncludesTeam(project, teamId)) {
    return
  }
  let teams: NonNullable<LinearProjectSummary['teams']> = []
  try {
    // Why: summary reads cap project teams, so large cross-team projects need a paged membership check before rejecting a valid create.
    teams = await listLinearProjectTeams(project.id, workspaceId, true)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
  if (teams.some((team) => team.id === teamId)) {
    return
  }
  throw linearError(
    'linear_invalid_project',
    `Linear project "${input}" is not available to the target team.`,
    {
      project: { id: project.id, name: project.name, teams },
      nextSteps: ['Choose a project that includes the create target team, then retry by id.']
    }
  )
}

private async filterLinearProjectsForTeam(
  projects: LinearProjectSummary[],
  teamId: string,
  workspaceId: string
): Promise<LinearProjectSummary[]> {
  const compatible: LinearProjectSummary[] = []
  for (const project of projects) {
    if (this.linearProjectIncludesTeam(project, teamId)) {
      compatible.push(project)
      continue
    }
    try {
      const teams = await listLinearProjectTeams(project.id, workspaceId, true)
      if (teams.some((team) => team.id === teamId)) {
        compatible.push({ ...project, teams })
      }
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
  return compatible
}

private linearProjectIncludesTeam(project: LinearProjectSummary, teamId: string): boolean {
  return project.teams?.some((team) => team.id === teamId) === true
}

private async getLinearViewerForWrite(
  workspaceId: string
): Promise<{ id: string; displayName?: string | null; avatarUrl?: string | null }> {
  try {
    return await getLinearViewerForWorkspaceOrThrow(workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private async resolveLinearLabelsForIssue(
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

private async resolveLinearLabelsForTeam(
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

private linearCreatedIssueMatchesIntent(
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

private linearTaskFieldAlreadySet(
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

private linearTaskUpdateResult(
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

private linearTaskResultFields(
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

private async resolveLinearCommentParentId(
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

private async runLinearAgentWrite<T>(
  write: (signal: AbortSignal) => Promise<T>,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<T> {
  const controller = new AbortController()
  const writePromise = write(controller.signal)
  writePromise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      writePromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(
            new LinearWriteFailure(
              'unconfirmed',
              'Linear write deadline elapsed before confirmation.'
            )
          )
        }, 25_000)
      })
    ])
  } catch (error) {
    if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
      throw error
    }
    if (error instanceof LinearWriteFailure && error.kind === 'unconfirmed') {
      throw unconfirmed(this.linearWriteFailureCauseMessage(error))
    }
    if (error instanceof LinearWriteFailure && error.kind === 'network') {
      throw linearError('linear_network_error', sanitizeLinearErrorMessage(error.message))
    }
    if (error instanceof LinearWriteFailure) {
      throw linearError('linear_write_failed', sanitizeLinearErrorMessage(error.message))
    }
    throw this.mapLinearReadFailure(error)
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

private linearWriteFailureCauseMessage(error: LinearWriteFailure): string {
  if (error.cause instanceof Error) {
    return sanitizeLinearErrorMessage(error.cause.message)
  }
  if (error.cause !== undefined) {
    return sanitizeLinearErrorMessage(String(error.cause))
  }
  return sanitizeLinearErrorMessage(error.message)
}

private mapLinearReadFailure(error: unknown): LinearAgentAccessError {
  if (error instanceof LinearAgentAccessError) {
    return error
  }
  if (isLinearAuthError(error)) {
    return linearError('linear_auth_expired', 'Linear authentication expired.', {
      nextSteps: ['Reconnect Linear from Orca settings.']
    })
  }
  return linearError(classifyLinearError(error), linearMessage(error))
}

private async getMatchingLinearCommentWrite(
  writeId: string,
  issueId: string,
  parentId: string | null,
  workspaceId: string,
  required: boolean
): Promise<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>> | null> {
  const comment = await this.readLinearWriteLookup(() =>
    getLinearCommentByUuidForAgent(writeId, workspaceId)
  )
  if (!comment) {
    return null
  }
  if (comment.issue.id === issueId && comment.parentId === parentId) {
    return comment
  }
  if (required) {
    throw linearError(
      'linear_invalid_write_id',
      'The write id belongs to a different comment target.'
    )
  }
  return null
}

private async getMatchingLinearAttachmentWrite(
  writeId: string,
  issueId: string,
  workspaceId: string,
  required: boolean
): Promise<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>> | null> {
  const attachment = await this.readLinearWriteLookup(() =>
    getLinearAttachmentByUuidForAgent(writeId, workspaceId)
  )
  if (!attachment) {
    return null
  }
  if (attachment.issue.id === issueId) {
    return attachment
  }
  if (required) {
    throw linearError(
      'linear_invalid_write_id',
      'The write id belongs to a different attachment target.'
    )
  }
  return null
}

private async getMatchingLinearCreatedIssue(
  writeId: string,
  teamId: string,
  parentId: string | null,
  workspaceId: string,
  required: boolean,
  intent: LinearCreateFieldIntent = {}
): Promise<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>> | null> {
  const issue = await this.readLinearWriteLookup(() =>
    getLinearIssueByUuidForAgent(writeId, workspaceId)
  )
  if (!issue) {
    return null
  }
  if (
    issue.team.id === teamId &&
    (issue.parent?.id ?? null) === parentId &&
    this.linearCreatedIssueMatchesIntent(issue, intent)
  ) {
    return issue
  }
  if (required) {
    throw linearError(
      'linear_invalid_write_id',
      'The write id belongs to a different issue target.'
    )
  }
  return null
}

private async refetchLinearCommentAfterDuplicate(
  writeId: string,
  issueId: string,
  parentId: string | null,
  workspaceId: string,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>> {
  try {
    // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
    const comment = await this.getMatchingLinearCommentWrite(
      writeId,
      issueId,
      parentId,
      workspaceId,
      true
    )
    if (comment) {
      return comment
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
      throw error
    }
    throw unconfirmed(
      error instanceof Error
        ? sanitizeLinearErrorMessage(error.message)
        : sanitizeLinearErrorMessage(String(error))
    )
  }
  throw unconfirmed()
}

private async refetchLinearAttachmentAfterDuplicate(
  writeId: string,
  issueId: string,
  workspaceId: string,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>>>> {
  try {
    // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
    const attachment = await this.getMatchingLinearAttachmentWrite(
      writeId,
      issueId,
      workspaceId,
      true
    )
    if (attachment) {
      return attachment
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
      throw error
    }
    throw unconfirmed(
      error instanceof Error
        ? sanitizeLinearErrorMessage(error.message)
        : sanitizeLinearErrorMessage(String(error))
    )
  }
  throw unconfirmed()
}

private async refetchLinearIssueAfterDuplicate(
  writeId: string,
  teamId: string,
  parentId: string | null,
  workspaceId: string,
  intent: LinearCreateFieldIntent,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>> {
  try {
    // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
    const issue = await this.getMatchingLinearCreatedIssue(
      writeId,
      teamId,
      parentId,
      workspaceId,
      true,
      intent
    )
    if (issue) {
      return issue
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
      throw error
    }
    throw unconfirmed(
      error instanceof Error
        ? sanitizeLinearErrorMessage(error.message)
        : sanitizeLinearErrorMessage(String(error))
    )
  }
  throw unconfirmed()
}

private async readLinearWriteLookup<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup()
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

private parseLinearAttachmentUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url
    }
  } catch {
    // Fall through to the stable agent-facing error below.
  }
  throw linearError('linear_invalid_url', 'Attachment URL must be an absolute http(s) URL.')
}

private defaultLinearAttachmentTitle(url: URL): string {
  const tail = url.pathname.split('/').findLast(Boolean)
  return tail ? `${url.host}/${tail}` : url.host
}

private linearWorkspaceErrorCode(type: string): LinearErrorCode {
  if (type === 'auth') {
    return 'linear_auth_expired'
  }
  if (type === 'network') {
    return 'linear_network_error'
  }
  if (type === 'rate_limited') {
    return 'linear_rate_limited'
  }
  return 'linear_write_failed'
}

private linearTeamSummary(team: {
  id: string
  name: string
  key: string
  url?: string
  workspaceId?: string
  workspaceName?: string
}): {
  id: string
  name: string
  key: string
  url?: string
  workspace?: { id: string; name: string }
} {
  return {
    id: team.id,
    name: team.name,
    key: team.key,
    ...(team.url ? { url: team.url } : {}),
    ...(team.workspaceId
      ? { workspace: { id: team.workspaceId, name: team.workspaceName ?? team.workspaceId } }
      : {})
  }
}

private async resolveLinearTeamInput(
  teamInput: string,
  workspaceId?: (string & {}) | 'all'
): Promise<{
  id: string
  key: string
  name: string
  workspaceId: string
  workspaceName?: string
}> {
  this.validateLinearCreateWorkspaceScope(workspaceId === 'all' ? undefined : workspaceId)
  let teams: Awaited<ReturnType<typeof listLinearTeamsOrThrow>>
  try {
    teams = await listLinearTeamsOrThrow(workspaceId ?? 'all')
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
  const normalized = teamInput.toLocaleLowerCase()
  const idMatches = teams.filter((team) => team.id.toLocaleLowerCase() === normalized)
  const matches =
    idMatches.length > 0
      ? idMatches
      : teams.filter((team) => team.key.toLocaleLowerCase() === normalized)
  if (matches.length === 1 && matches[0].workspaceId) {
    return {
      id: matches[0].id,
      key: matches[0].key,
      name: matches[0].name,
      workspaceId: matches[0].workspaceId,
      workspaceName: matches[0].workspaceName
    }
  }
  if (matches.length > 1) {
    throw linearError(
      'linear_workspace_ambiguous',
      `Team ${teamInput} exists in multiple workspaces.`,
      {
        candidates: matches.map((team) => ({
          workspaceId: team.workspaceId,
          workspaceName: team.workspaceName,
          teamId: team.id,
          teamKey: team.key
        }))
      }
    )
  }
  throw linearError('linear_team_required', `No connected Linear team matched ${teamInput}.`)
}

private async resolveLinearCreateTeam(
  teamInput: string | undefined,
  workspaceId: string | undefined,
  parent: LinearAgentWriteTarget | null
): Promise<{ id: string; key: string; name: string; workspaceId: string }> {
  if (!teamInput && parent?.issue.team?.id && parent.issue.team.key && parent.issue.team.name) {
    return {
      id: parent.issue.team.id,
      key: parent.issue.team.key,
      name: parent.issue.team.name,
      workspaceId: parent.workspaceId
    }
  }
  if (!teamInput) {
    throw linearError('linear_team_required', 'Pass --team or create under a parent issue.', {
      nextSteps: ['Run `orca linear create --team <key> ...` or use --parent-current.']
    })
  }

  const scope = parent?.workspaceId ?? workspaceId
  this.validateLinearCreateWorkspaceScope(scope)
  let teams: Awaited<ReturnType<typeof listLinearTeamsOrThrow>>
  try {
    teams = await listLinearTeamsOrThrow(scope ?? 'all')
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
  if (teams.length === 0 && (getLinearStatus().workspaces?.length ?? 0) === 0) {
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the issue create.']
    })
  }
  const matches = teams.filter(
    (team) =>
      team.id.toLocaleLowerCase() === teamInput.toLocaleLowerCase() ||
      team.key.toLocaleLowerCase() === teamInput.toLocaleLowerCase()
  )
  if (matches.length === 1 && matches[0].workspaceId) {
    return {
      id: matches[0].id,
      key: matches[0].key,
      name: matches[0].name,
      workspaceId: matches[0].workspaceId
    }
  }
  if (matches.length > 1) {
    throw linearError(
      'linear_workspace_ambiguous',
      `Team ${teamInput} exists in multiple workspaces.`,
      {
        candidates: matches.map((team) => ({
          workspaceId: team.workspaceId,
          workspaceName: team.workspaceName,
          teamKey: team.key
        }))
      }
    )
  }
  if (parent) {
    let globalTeams: Awaited<ReturnType<typeof listLinearTeamsOrThrow>>
    try {
      globalTeams = await listLinearTeamsOrThrow('all')
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
    const globalMatch = globalTeams.find(
      (team) =>
        team.id.toLocaleLowerCase() === teamInput.toLocaleLowerCase() ||
        team.key.toLocaleLowerCase() === teamInput.toLocaleLowerCase()
    )
    if (globalMatch) {
      throw linearError(
        'linear_invalid_workspace',
        `Team ${teamInput} is not in the parent issue workspace.`
      )
    }
  }
  throw linearError('linear_team_required', `No connected Linear team matched ${teamInput}.`)
}

private validateLinearCreateWorkspaceScope(workspaceId: string | undefined): void {
  if (!workspaceId) {
    return
  }
  const workspaces = getLinearStatus().workspaces ?? []
  if (workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw linearError(
      'linear_invalid_workspace',
      `No connected Linear workspace matched ${workspaceId}.`
    )
  }
}

private linearWriteIssueRef(issue: { id: string; identifier: string; url: string }): {
  id: string
  identifier: string
  url: string
} {
  return { id: issue.id, identifier: issue.identifier, url: issue.url }
}

private linearCommentResult(
  comment: NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>,
  target: LinearAgentWriteTarget,
  bodyChars: number,
  writeId: string,
  deduplicated: boolean
): LinearCommentAddResult {
  return {
    comment: { id: comment.id, url: comment.url, parentId: comment.parentId },
    issue: this.linearWriteIssueRef(target.issue),
    meta: { workspaceId: target.workspaceId, bodyChars, writeId, deduplicated }
  }
}

private linearAttachResult(
  attachment: NonNullable<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>>>,
  target: LinearAgentWriteTarget,
  writeId: string,
  deduplicated: boolean
): LinearAttachResult {
  return {
    attachment: { id: attachment.id, title: attachment.title, url: attachment.url },
    issue: this.linearWriteIssueRef(target.issue),
    meta: { workspaceId: target.workspaceId, writeId, deduplicated }
  }
}

private linearCreateResult(
  issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  workspaceId: string,
  writeId: string,
  deduplicated: boolean
): LinearCreateResult {
  return {
    issue,
    meta: { workspaceId, writeId, deduplicated }
  }
}

private linearCreateFieldRetryTokens(fields: LinearCreateFieldIntent | undefined): string[] {
  if (!fields) {
    return []
  }
  return [
    ...(fields.stateId ? [`--state=${this.commandToken(fields.stateId, 'STATE_ID')}`] : []),
    ...(fields.assigneeId
      ? [`--assignee=${this.commandToken(fields.assigneeId, 'ASSIGNEE_ID')}`]
      : []),
    ...(fields.priority !== undefined
      ? [`--priority=${this.linearPriorityRetryToken(fields.priority)}`]
      : []),
    ...(fields.estimate !== undefined && fields.estimate !== null
      ? [`--estimate=${fields.estimate}`]
      : []),
    ...(fields.dueDate ? [`--due-date=${fields.dueDate}`] : []),
    ...(fields.projectId
      ? [`--project=${this.commandToken(fields.projectId, 'PROJECT_ID')}`]
      : []),
    ...(fields.labelIds ?? []).map(
      (labelId) => `--label=${this.commandToken(labelId, 'LABEL_ID')}`
    )
  ]
}

private linearPriorityRetryToken(priority: number): string {
  if (priority === 1) {
    return 'urgent'
  }
  if (priority === 2) {
    return 'high'
  }
  if (priority === 3) {
    return 'medium'
  }
  if (priority === 4) {
    return 'low'
  }
  return 'none'
}

private linearCreateStyleUnconfirmed(
  verb: 'comment' | 'attach' | 'create',
  writeId: string,
  target: LinearAgentWriteTarget | null,
  extra: {
    parentId?: string | null
    team?: { id: string; key: string; name: string; workspaceId: string }
    parent?: LinearAgentWriteTarget | null
    title?: string
    url?: string
    bodyRequired?: boolean
    createFields?: LinearCreateFieldIntent
    cause?: string
  } = {}
): LinearAgentAccessError {
  const workspaceId = target?.workspaceId ?? extra.team?.workspaceId ?? ''
  // Why: the retry preserves id and target so duplicate recovery can prove intent without matching mutable content.
  const pinned =
    verb === 'create'
      ? [
          'orca linear create',
          `--workspace=${this.commandToken(workspaceId, 'WORKSPACE_ID')}`,
          `--write-id=${this.commandToken(writeId, 'WRITE_ID')}`,
          '--title TITLE_HERE',
          ...(extra.bodyRequired ? ['--body-file -'] : []),
          ...(extra.parent
            ? [`--parent=${this.commandToken(extra.parent.issue.identifier, 'PARENT_ISSUE')}`]
            : []),
          ...(extra.team
            ? [`--team=${this.commandToken(extra.team.key, 'TEAM_KEY')}`]
            : []
          ).concat(this.linearCreateFieldRetryTokens(extra.createFields))
        ].join(' ')
      : [
          `orca linear ${verb === 'attach' ? 'attach' : 'comment add'}`,
          this.commandToken(target?.issue.identifier ?? '', 'ISSUE_ID'),
          `--workspace=${this.commandToken(workspaceId, 'WORKSPACE_ID')}`,
          `--write-id=${this.commandToken(writeId, 'WRITE_ID')}`,
          ...(verb === 'comment' ? ['--body-file -'] : []),
          ...(verb === 'comment' && extra.parentId
            ? [`--reply-to=${this.commandToken(extra.parentId, 'COMMENT_ID')}`]
            : []),
          ...(verb === 'attach' ? ['--url URL_HERE', '--title TITLE_HERE'] : [])
        ].join(' ')
  const retryPrefix = extra.bodyRequired || verb === 'comment' ? 'Pipe the same body and r' : 'R'
  const payloadNote =
    verb === 'attach'
      ? ' Replace TITLE_HERE/URL_HERE with the exact original payload values before running.'
      : verb === 'create'
        ? ' Replace TITLE_HERE with the exact original title before running.'
        : ''
  return linearError(
    'linear_write_unconfirmed',
    'Linear may have applied the write, but Orca could not confirm it.',
    {
      writeId,
      workspaceId,
      issueIdentifier: target?.issue.identifier,
      parentId: extra.parentId,
      team: extra.team ? { id: extra.team.id, key: extra.team.key } : undefined,
      parentIdentifier: extra.parent?.issue.identifier,
      createFields: extra.createFields,
      nextSteps: [
        `${retryPrefix}etry once with the pinned command: \`${pinned}\`.${payloadNote}`
      ],
      ...(extra.cause ? { cause: sanitizeLinearErrorMessage(extra.cause) } : {})
    }
  )
}

private commandToken(value: string, placeholder: string): string {
  return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : placeholder
}

private async notifyLinearLinkedIssueUpdated(
  workspaceId: string,
  identifier: string | readonly string[]
): Promise<void> {
  const identifiers = typeof identifier === 'string' ? [identifier] : identifier
  const normalized = new Map(
    identifiers.map((value) => [value.toLocaleUpperCase(), value] as const)
  )
  for (const worktree of await this.listResolvedWorktrees()) {
    const linkedIdentifier = normalized.get(
      (worktree.linkedLinearIssue ?? '').toLocaleUpperCase()
    )
    if (!linkedIdentifier) {
      continue
    }
    const linkedWorkspaceId = worktree.linkedLinearIssueWorkspaceId ?? workspaceId
    if (linkedWorkspaceId !== workspaceId) {
      continue
    }
    this.emitClientEvent({
      type: 'linearLinkedIssueUpdated',
      worktreeId: worktree.id,
      identifier: linkedIdentifier,
      workspaceId
    })
  }
}

linearIssueComments(
  issueId: string,
  workspaceId?: string
): ReturnType<typeof getLinearIssueComments> {
  return getLinearIssueComments(issueId, workspaceId)
}

linearListTeams(workspaceId?: LinearWorkspaceSelection): ReturnType<typeof listLinearTeams> {
  return listLinearTeams(workspaceId)
}

linearListProjects(
  query?: string,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  force?: boolean
): ReturnType<typeof listLinearProjects> {
  return listLinearProjects(query, Math.min(Math.max(1, limit), 50), workspaceId, force)
}

linearCreateProject(
  input: LinearProjectCreateInput,
  workspaceId?: string
): ReturnType<typeof createLinearProject> {
  return createLinearProject(input, workspaceId)
}

linearGetProject(
  id: string,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof getLinearProject> {
  return getLinearProject(id, workspaceId, force)
}

linearListProjectIssues(
  projectId: string,
  limit = 20,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof listLinearProjectIssues> {
  return listLinearProjectIssues(projectId, clampLinearIssueListLimit(limit), workspaceId, force)
}

linearListCustomViews(
  model: LinearCustomViewModel,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  force?: boolean
): ReturnType<typeof listLinearCustomViews> {
  return listLinearCustomViews(model, Math.min(Math.max(1, limit), 50), workspaceId, force)
}

linearGetCustomView(
  viewId: string,
  model: LinearCustomViewModel,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof getLinearCustomView> {
  return getLinearCustomView(viewId, model, workspaceId, force)
}

linearListCustomViewIssues(
  viewId: string,
  limit = 20,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof listLinearCustomViewIssues> {
  return listLinearCustomViewIssues(viewId, clampLinearIssueListLimit(limit), workspaceId, force)
}

linearListCustomViewProjects(
  viewId: string,
  limit = 20,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof listLinearCustomViewProjects> {
  return listLinearCustomViewProjects(
    viewId,
    Math.min(Math.max(1, limit), 50),
    workspaceId,
    force
  )
}

linearTeamStates(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamStates> {
  return getLinearTeamStates(teamId, workspaceId)
}

linearTeamLabels(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamLabels> {
  return getLinearTeamLabels(teamId, workspaceId)
}

linearTeamMembers(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamMembers> {
  return getLinearTeamMembers(teamId, workspaceId)
}

// ── Jira integration ──

jiraConnect(args: JiraConnectArgs): ReturnType<typeof connectJira> {
  return connectJira(args)
}

jiraDisconnect(siteId?: string): { ok: true } {
  disconnectJira(siteId)
  return { ok: true }
}

jiraSelectSite(siteId: JiraSiteSelection): ReturnType<typeof getJiraStatus> {
  return selectJiraSite(siteId)
}

jiraStatus(): ReturnType<typeof getJiraStatus> {
  return getJiraStatus()
}

jiraReadStatus(): ReturnType<typeof getJiraStatus> {
  return getJiraStatus()
}

jiraTestConnection(siteId?: string): ReturnType<typeof testJiraConnection> {
  return testJiraConnection(siteId)
}

jiraSearchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection,
  signal?: AbortSignal
): ReturnType<typeof searchJiraIssues> {
  return searchJiraIssues(jql, Math.min(Math.max(1, limit), 100), siteId, signal)
}

jiraListIssues(
  filter?: JiraIssueFilter,
  limit = 30,
  siteId?: JiraSiteSelection
): ReturnType<typeof listJiraIssues> {
  return listJiraIssues(filter, Math.min(Math.max(1, limit), 100), siteId)
}

jiraCreateIssue(args: JiraCreateIssueArgs): ReturnType<typeof createJiraIssue> {
  return createJiraIssue(args)
}

jiraGetIssue(key: string, siteId?: string): ReturnType<typeof getJiraIssue> {
  return getJiraIssue(key, siteId)
}

jiraLookupIssueSummary(
  key: string,
  siteId: string,
  signal?: AbortSignal
): ReturnType<typeof getJiraIssueSummary> {
  return getJiraIssueSummary(key, siteId, signal)
}

jiraUpdateIssue(
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string
): ReturnType<typeof updateJiraIssue> {
  return updateJiraIssue(key, updates, siteId)
}

jiraAddIssueComment(
  key: string,
  body: string,
  siteId?: string
): ReturnType<typeof addJiraIssueComment> {
  return addJiraIssueComment(key, body, siteId)
}

jiraIssueComments(key: string, siteId?: string): ReturnType<typeof getJiraIssueComments> {
  return getJiraIssueComments(key, siteId)
}

jiraListProjects(siteId?: JiraSiteSelection): ReturnType<typeof listJiraProjects> {
  return listJiraProjects(siteId)
}

jiraListIssueTypes(
  projectIdOrKey: string,
  siteId?: string
): ReturnType<typeof listJiraIssueTypes> {
  return listJiraIssueTypes(projectIdOrKey, siteId)
}

jiraListCreateFields(
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string
): ReturnType<typeof listJiraCreateFields> {
  return listJiraCreateFields(projectIdOrKey, issueTypeId, siteId)
}

jiraListPriorities(siteId?: string): ReturnType<typeof listJiraPriorities> {
  return listJiraPriorities(siteId)
}

jiraListAssignableUsers(
  key: string,
  query?: string,
  siteId?: string
): ReturnType<typeof listJiraAssignableUsers> {
  return listJiraAssignableUsers(key, query, siteId)
}

jiraListTransitions(key: string, siteId?: string): ReturnType<typeof listJiraTransitions> {
  return listJiraTransitions(key, siteId)
}

jiraGetProjectStatusOrder(
  projectKey: string,
  siteId?: string
): ReturnType<typeof getJiraProjectStatusOrder> {
  return getJiraProjectStatusOrder(projectKey, siteId)
}
}
