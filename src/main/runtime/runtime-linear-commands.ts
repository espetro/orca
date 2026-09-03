import type { RuntimeLinearCommandHost } from './runtime-linear-command-host'
import { LinearWriteCore } from './linear/linear-write-core'
import { LinearReadCommands } from './linear/linear-read-commands'
import { LinearProjectReadCommands } from './linear/linear-project-read-commands'
import { LinearWriteCommands } from './linear/linear-write-commands'
import { LinearCommentAttachmentCommands } from './linear/linear-comment-attachment-commands'
import { LinearAgentIssueCreate } from './linear/linear-agent-issue-create'
import { LinearWriteResolution } from './linear/linear-write-resolution'
import { LinearIssueWriteFields } from './linear/linear-issue-write-fields'
import { LinearTaskResultFields } from './linear/linear-task-result-fields'
import { LinearProjectWriteFields } from './linear/linear-project-write-fields'
import { LinearWriteRecovery } from './linear/linear-write-recovery'
import { JiraCommands } from './linear/jira-commands'

export class RuntimeLinearCommands {
  private readonly writeCore: LinearWriteCore
  private readonly readCommands: LinearReadCommands
  private readonly projectReadCommands: LinearProjectReadCommands
  private readonly writeCommands: LinearWriteCommands
  private readonly commentAttachmentCommands: LinearCommentAttachmentCommands
  private readonly agentIssueCreate: LinearAgentIssueCreate
  private readonly writeResolution: LinearWriteResolution
  private readonly issueWriteFields: LinearIssueWriteFields
  private readonly taskResultFields: LinearTaskResultFields
  private readonly projectWriteFields: LinearProjectWriteFields
  private readonly writeRecovery: LinearWriteRecovery
  private readonly jiraCommands: JiraCommands

  constructor(host: RuntimeLinearCommandHost) {
    this.writeCore = new LinearWriteCore(host)
    this.readCommands = new LinearReadCommands(host)
    this.projectReadCommands = new LinearProjectReadCommands(host)
    this.writeCommands = new LinearWriteCommands(host)
    this.commentAttachmentCommands = new LinearCommentAttachmentCommands(host)
    this.agentIssueCreate = new LinearAgentIssueCreate(host)
    this.writeResolution = new LinearWriteResolution(host)
    this.issueWriteFields = new LinearIssueWriteFields(host)
    this.taskResultFields = new LinearTaskResultFields(host)
    this.projectWriteFields = new LinearProjectWriteFields(host)
    this.writeRecovery = new LinearWriteRecovery(host)
    this.jiraCommands = new JiraCommands(host)
  }

linearConnect(apiKey: string): ReturnType<typeof connectLinear> {
    return this.readCommands.linearConnect(apiKey)
  }

linearDisconnect(workspaceId?: string): { ok: true } {
    return this.readCommands.linearDisconnect(workspaceId)
  }

linearSelectWorkspace(workspaceId: LinearWorkspaceSelection): ReturnType<typeof getLinearStatus> {
    return this.readCommands.linearSelectWorkspace(workspaceId)
  }

linearStatus(): ReturnType<typeof getLinearStatus> {
    return this.readCommands.linearStatus()
  }

linearTestConnection(workspaceId?: string): ReturnType<typeof testLinearConnection> {
    return this.readCommands.linearTestConnection(workspaceId)
  }

linearSearchIssues(
  query: string,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection
): ReturnType<typeof searchLinearIssues> {
    return this.readCommands.linearSearchIssues(query, limit, workspaceId)
  }

linearSearchForAgents(args: {
  query: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}): ReturnType<typeof searchLinearIssuesForAgents> {
    return this.readCommands.linearSearchForAgents(args)
  }

linearIssueContext(request: LinearIssueRequest): ReturnType<typeof readLinearIssueContext> {
    return this.readCommands.linearIssueContext(request)
  }

async linearTeamListForAgents(params: {
  workspaceId?: (string & {}) | 'all'
}): Promise<LinearTeamListResult> {
    return this.readCommands.linearTeamListForAgents(params)
  }

async linearTeamMembersForAgents(params: {
  teamInput: string
  workspaceId?: string
}): Promise<LinearTeamMembersResult> {
    return this.readCommands.linearTeamMembersForAgents(params)
  }

async linearTeamStatesForAgents(params: {
  teamInput: string
  workspaceId?: string
}): Promise<LinearTeamStatesResult> {
    return this.readCommands.linearTeamStatesForAgents(params)
  }

async linearTeamLabelsForAgents(params: {
  teamInput: string
  workspaceId?: string
}): Promise<LinearTeamLabelsResult> {
    return this.readCommands.linearTeamLabelsForAgents(params)
  }

async linearProjectListForAgents(params: {
  query?: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}): Promise<LinearProjectListResult> {
    return this.readCommands.linearProjectListForAgents(params)
  }

async linearIssueListForAgents(params: {
  filter?: LinearIssueListFilter
  teamInput?: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}): Promise<LinearIssueListResult> {
    return this.readCommands.linearIssueListForAgents(params)
  }

async linearMcpIssueList(params: LinearMcpIssueListRequest): Promise<LinearMcpIssueListResult> {
    return this.readCommands.linearMcpIssueList(params)
  }

async linearResolveCurrentIssue(
  context?: LinearCurrentIssueContextHints
): Promise<ReturnType<typeof getLinearCurrentIssueFromWorktree>> {
    return this.readCommands.linearResolveCurrentIssue(context)
  }

linearListIssues(
  filter?: LinearListFilter,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  options?: LinearIssueListOptions
): ReturnType<typeof listLinearIssues> {
    return this.readCommands.linearListIssues(filter, limit, workspaceId, options)
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
    return this.writeCommands.linearCreateIssue(teamId, title, description, workspaceId, parentIssueId, projectId, options)
  }

linearGetIssue(id: string, workspaceId?: string): ReturnType<typeof getLinearIssue> {
    return this.writeCommands.linearGetIssue(id, workspaceId)
  }

linearUpdateIssue(
  id: string,
  updates: LinearIssueUpdate,
  workspaceId?: string
): ReturnType<typeof updateLinearIssue> {
    return this.writeCommands.linearUpdateIssue(id, updates, workspaceId)
  }

linearAddIssueComment(
  issueId: string,
  body: string,
  workspaceId?: string
): ReturnType<typeof addLinearIssueComment> {
    return this.writeCommands.linearAddIssueComment(issueId, body, workspaceId)
  }

async linearIssueSetState(params: {
  input?: string
  current?: boolean
  workspaceId?: string
  to: string
  context?: LinearCurrentIssueContextHints
}): Promise<LinearStatusSetResult> {
    return this.writeCommands.linearIssueSetState(params)
  }

async linearIssueRelationWrite(
  params: LinearIssueRelationWriteRequest
): Promise<LinearIssueRelationWriteResult> {
    return this.writeCommands.linearIssueRelationWrite(params)
  }

async linearSaveIssue(params: LinearSaveIssueRequest): Promise<LinearSaveIssueResult> {
    return this.writeCommands.linearSaveIssue(params)
  }

async linearIssueUpdateTask(
  params: LinearIssueTaskUpdateRequest
): Promise<LinearIssueTaskUpdateResult> {
    return this.writeCommands.linearIssueUpdateTask(params)
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
    return this.commentAttachmentCommands.linearIssueAddComment(params)
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
    return this.commentAttachmentCommands.linearIssueAttachLink(params)
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
    return this.agentIssueCreate.linearIssueCreate(params)
  }

linearIssueComments(
  issueId: string,
  workspaceId?: string
): ReturnType<typeof getLinearIssueComments> {
    return this.readCommands.linearIssueComments(issueId, workspaceId)
  }

linearListTeams(workspaceId?: LinearWorkspaceSelection): ReturnType<typeof listLinearTeams> {
    return this.readCommands.linearListTeams(workspaceId)
  }

linearListProjects(
  query?: string,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  force?: boolean
): ReturnType<typeof listLinearProjects> {
    return this.projectReadCommands.linearListProjects(query, limit, workspaceId, force)
  }

linearCreateProject(
  input: LinearProjectCreateInput,
  workspaceId?: string
): ReturnType<typeof createLinearProject> {
    return this.projectReadCommands.linearCreateProject(input, workspaceId)
  }

linearGetProject(
  id: string,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof getLinearProject> {
    return this.projectReadCommands.linearGetProject(id, workspaceId, force)
  }

linearListProjectIssues(
  projectId: string,
  limit = 20,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof listLinearProjectIssues> {
    return this.projectReadCommands.linearListProjectIssues(projectId, limit, workspaceId, force)
  }

linearListCustomViews(
  model: LinearCustomViewModel,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection,
  force?: boolean
): ReturnType<typeof listLinearCustomViews> {
    return this.projectReadCommands.linearListCustomViews(model, limit, workspaceId, force)
  }

linearGetCustomView(
  viewId: string,
  model: LinearCustomViewModel,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof getLinearCustomView> {
    return this.projectReadCommands.linearGetCustomView(viewId, model, workspaceId, force)
  }

linearListCustomViewIssues(
  viewId: string,
  limit = 20,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof listLinearCustomViewIssues> {
    return this.projectReadCommands.linearListCustomViewIssues(viewId, limit, workspaceId, force)
  }

linearListCustomViewProjects(
  viewId: string,
  limit = 20,
  workspaceId: string,
  force?: boolean
): ReturnType<typeof listLinearCustomViewProjects> {
    return this.projectReadCommands.linearListCustomViewProjects(viewId, limit, workspaceId, force)
  }

linearTeamStates(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamStates> {
    return this.projectReadCommands.linearTeamStates(teamId, workspaceId)
  }

linearTeamLabels(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamLabels> {
    return this.projectReadCommands.linearTeamLabels(teamId, workspaceId)
  }

linearTeamMembers(teamId: string, workspaceId?: string): ReturnType<typeof getLinearTeamMembers> {
    return this.projectReadCommands.linearTeamMembers(teamId, workspaceId)
  }

jiraConnect(args: JiraConnectArgs): ReturnType<typeof connectJira> {
    return this.jiraCommands.jiraConnect(args)
  }

jiraDisconnect(siteId?: string): { ok: true } {
    return this.jiraCommands.jiraDisconnect(siteId)
  }

jiraSelectSite(siteId: JiraSiteSelection): ReturnType<typeof getJiraStatus> {
    return this.jiraCommands.jiraSelectSite(siteId)
  }

jiraStatus(): ReturnType<typeof getJiraStatus> {
    return this.jiraCommands.jiraStatus()
  }

jiraReadStatus(): ReturnType<typeof getJiraStatus> {
    return this.jiraCommands.jiraReadStatus()
  }

jiraTestConnection(siteId?: string): ReturnType<typeof testJiraConnection> {
    return this.jiraCommands.jiraTestConnection(siteId)
  }

jiraSearchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection,
  signal?: AbortSignal
): ReturnType<typeof searchJiraIssues> {
    return this.jiraCommands.jiraSearchIssues(jql, limit, siteId, signal)
  }

jiraListIssues(
  filter?: JiraIssueFilter,
  limit = 30,
  siteId?: JiraSiteSelection
): ReturnType<typeof listJiraIssues> {
    return this.jiraCommands.jiraListIssues(filter, limit, siteId)
  }

jiraCreateIssue(args: JiraCreateIssueArgs): ReturnType<typeof createJiraIssue> {
    return this.jiraCommands.jiraCreateIssue(args)
  }

jiraGetIssue(key: string, siteId?: string): ReturnType<typeof getJiraIssue> {
    return this.jiraCommands.jiraGetIssue(key, siteId)
  }

jiraLookupIssueSummary(
  key: string,
  siteId: string,
  signal?: AbortSignal
): ReturnType<typeof getJiraIssueSummary> {
    return this.jiraCommands.jiraLookupIssueSummary(key, siteId, signal)
  }

jiraUpdateIssue(
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string
): ReturnType<typeof updateJiraIssue> {
    return this.jiraCommands.jiraUpdateIssue(key, updates, siteId)
  }

jiraAddIssueComment(
  key: string,
  body: string,
  siteId?: string
): ReturnType<typeof addJiraIssueComment> {
    return this.jiraCommands.jiraAddIssueComment(key, body, siteId)
  }

jiraIssueComments(key: string, siteId?: string): ReturnType<typeof getJiraIssueComments> {
    return this.jiraCommands.jiraIssueComments(key, siteId)
  }

jiraListProjects(siteId?: JiraSiteSelection): ReturnType<typeof listJiraProjects> {
    return this.jiraCommands.jiraListProjects(siteId)
  }

jiraListIssueTypes(
  projectIdOrKey: string,
  siteId?: string
): ReturnType<typeof listJiraIssueTypes> {
    return this.jiraCommands.jiraListIssueTypes(projectIdOrKey, siteId)
  }

jiraListCreateFields(
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string
): ReturnType<typeof listJiraCreateFields> {
    return this.jiraCommands.jiraListCreateFields(projectIdOrKey, issueTypeId, siteId)
  }

jiraListPriorities(siteId?: string): ReturnType<typeof listJiraPriorities> {
    return this.jiraCommands.jiraListPriorities(siteId)
  }

jiraListAssignableUsers(
  key: string,
  query?: string,
  siteId?: string
): ReturnType<typeof listJiraAssignableUsers> {
    return this.jiraCommands.jiraListAssignableUsers(key, query, siteId)
  }

jiraListTransitions(key: string, siteId?: string): ReturnType<typeof listJiraTransitions> {
    return this.jiraCommands.jiraListTransitions(key, siteId)
  }

jiraGetProjectStatusOrder(
  projectKey: string,
  siteId?: string
): ReturnType<typeof getJiraProjectStatusOrder> {
    return this.jiraCommands.jiraGetProjectStatusOrder(projectKey, siteId)
  }
}
