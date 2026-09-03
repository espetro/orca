import type { LinearWorkspaceSelection } from '../../../shared/linear/workspace-types'
import type {
  LinearIssueListFilter,
  LinearIssueListResult,
  LinearProjectListResult,
  LinearIssueRequest,
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult,
} from '../../../shared/linear/agent-access'
import {
  clampLinearSearchLimit
} from '../../../shared/linear/agent-access'
import { linearPriorityLabel } from '../../../shared/linear/priority-label'
import { clampLinearIssueListLimit } from '../../../shared/linear/issue-read-limits'

import { resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type { ResolvedWorktree } from '../repo-worktree-row-resolution'

import {
  connect as connectLinear,
  disconnect as disconnectLinear,
  getStatus as getLinearStatus,
  selectWorkspace as selectLinearWorkspace,
  testConnection as testLinearConnection
} from '../../linear/client'
import {
  searchIssues as searchLinearIssues
} from '../../linear/linear-issue-lookups'
import {
  listIssues as listLinearIssues,
  type LinearListFilter
} from '../../linear/linear-issue-listing'
import {
  getIssueComments as getLinearIssueComments
} from '../../linear/linear-issue-comments'
import type { LinearIssueListOptions } from '../../linear/linear-issue-query-documents'
import {
  LinearAgentAccessError,
  getLinearCurrentIssueFromWorktree,
  readLinearIssueContext,
  resolveLegacyLinearLinkWorkspace,
  searchLinearIssuesForAgents
} from '../../linear/issue-context'
import {
  sanitizeLinearErrorMessage
} from '../../linear/issue-context-errors'
import { listMcpIssues } from '../../linear/mcp-issue-list'
import {
  getTeamMembersOrThrow as getLinearTeamMembersOrThrow,
  listTeamsForAgent as listLinearTeamsForAgent,
  listTeams as listLinearTeams,
} from '../../linear/teams'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'


export class LinearReadCommands {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

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

async linearResolveCurrentIssue(
  context?: LinearCurrentIssueContextHints
): Promise<ReturnType<typeof getLinearCurrentIssueFromWorktree>> {
  if (!this.host.store) {
    throw new Error('runtime_unavailable')
  }

  let worktree: ResolvedWorktree | null = null
  if (context?.terminalHandle) {
    try {
      const terminal = await this.host.showTerminal(context.terminalHandle)
      if (context.worktreeId && context.worktreeId !== terminal.worktreeId) {
        throw new LinearAgentAccessError(
          'linear_permission_denied',
          'The provided Linear worktree context does not match the caller terminal.'
        )
      }
      worktree = await this.host.resolveWorktreeSelector(`id:${terminal.worktreeId}`)
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
    worktree = await this.host.resolveWorktreeForContainedPath(context.cwd)
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
      this.host.store.setWorktreeMeta(worktree.id, {
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

linearListIssues(
  filter?: LinearListFilter,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  options?: LinearIssueListOptions
): ReturnType<typeof listLinearIssues> {
  return listLinearIssues(filter, clampLinearIssueListLimit(limit), workspaceId, options)
}

linearIssueComments(
  issueId: string,
  workspaceId?: string
): ReturnType<typeof getLinearIssueComments> {
  return getLinearIssueComments(issueId, workspaceId)
}

async resolveWorktreeForContainedPath(cwd: string): Promise<ResolvedWorktree | null> {
  const currentPath = resolve(cwd)
  let best: ResolvedWorktree | null = null
  for (const candidate of await this.host.listResolvedWorktrees()) {
    if (!isPathInsideOrEqual(candidate.path, currentPath)) {
      continue
    }
    if (!best || candidate.path.length > best.path.length) {
      best = candidate
    }
  }
  return best
}

linearListTeams(workspaceId?: LinearWorkspaceSelection): ReturnType<typeof listLinearTeams> {
  return listLinearTeams(workspaceId)
}
}
