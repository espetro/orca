import type { LinearWorkspaceSelection } from '../../../shared/linear/workspace-types'
import type {
} from '../../../shared/linear/agent-access'
import { clampLinearIssueListLimit } from '../../../shared/linear/issue-read-limits'


import {
  createProject as createLinearProject,
  getCustomView as getLinearCustomView,
  getProject as getLinearProject,
  listCustomViewIssues as listLinearCustomViewIssues,
  listCustomViewProjects as listLinearCustomViewProjects,
  listCustomViews as listLinearCustomViews,
  listProjectIssues as listLinearProjectIssues,
  listProjects as listLinearProjects,
  type LinearProjectCreateInput
} from '../../linear/projects'
import {
  getTeamLabels as getLinearTeamLabels,
  getTeamMembers as getLinearTeamMembers,
  getTeamStates as getLinearTeamStates,
} from '../../linear/teams'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'


export class LinearProjectReadCommands {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

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
}
