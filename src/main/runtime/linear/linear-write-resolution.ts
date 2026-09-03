import type {
} from '../../../shared/linear/agent-access'
import { isLinearUuid } from '../../../shared/linear/uuid'


import {
  getStatus as getLinearStatus,
} from '../../linear/client'
import type {
  getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
} from '../../linear/linear-issue-lookups'
import {
  readLinearIssueContext,
} from '../../linear/issue-context'
import {
  linearError,
} from '../../linear/issue-context-errors'
import {
  getTeamLabelsOrThrow as getLinearTeamLabelsOrThrow,
  getTeamMembersOrThrow as getLinearTeamMembersOrThrow,
  getTeamStatesOrThrow as getLinearTeamStatesOrThrow,
  getViewerForWorkspaceOrThrow as getLinearViewerForWorkspaceOrThrow,
  listTeamsOrThrow as listLinearTeamsOrThrow
} from '../../linear/teams'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'

type LinearAgentWriteTarget = {
  issue: LinearIssueSummary
  workspaceId: string
}

export class LinearWriteResolution {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

async resolveLinearAgentWriteTarget(params: {
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

async getLinearTeamStatesForWrite(
  teamId: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof getLinearTeamStatesOrThrow>>> {
  try {
    return await getLinearTeamStatesOrThrow(teamId, workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

resolveLinearAgentState(
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

async getLinearTeamLabelsForWrite(
  teamId: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof getLinearTeamLabelsOrThrow>>> {
  try {
    return await getLinearTeamLabelsOrThrow(teamId, workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async readLinearAgentIssueWriteRecord(
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

async resolveLinearAssignee(
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

async getLinearViewerForWrite(
  workspaceId: string
): Promise<{ id: string; displayName?: string | null; avatarUrl?: string | null }> {
  try {
    return await getLinearViewerForWorkspaceOrThrow(workspaceId)
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

async resolveLinearTeamInput(
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

async resolveLinearCreateTeam(
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

validateLinearCreateWorkspaceScope(workspaceId: string | undefined): void {
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
}
