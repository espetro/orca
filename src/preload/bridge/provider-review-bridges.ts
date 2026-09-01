import { ipcRenderer } from 'electron'
import type { HostedReviewForBranchArgs } from '../../shared/hosted-review'
import type { JiraProjectStatusOrder } from '../../shared/jira-types'
import type { LinearProjectDetail } from '../../shared/linear/project-types'
import type { PreloadApi } from '../api-types'

export const hostedReviewBridge: PreloadApi['hostedReview'] = {
  forBranch: (args: HostedReviewForBranchArgs) =>
    ipcRenderer.invoke('hostedReview:forBranch', args),
  getCreationEligibility: (args) =>
    ipcRenderer.invoke('hostedReview:getCreationEligibility', args),
  create: (args) => ipcRenderer.invoke('hostedReview:create', args),
  createStacked: (args) => ipcRenderer.invoke('hostedReview:createStacked', args)
}

export const bitbucketBridge: PreloadApi['bitbucket'] = {
  connect: (args: {
    authMode: 'token' | 'basic'
    accessToken?: string | null
    email?: string | null
    apiToken?: string | null
    baseUrl?: string | null
  }): Promise<{ ok: true; account: string | null } | { ok: false; error: string }> =>
    ipcRenderer.invoke('bitbucket:connect', args),

  disconnect: (): Promise<void> => ipcRenderer.invoke('bitbucket:disconnect'),

  status: () => ipcRenderer.invoke('bitbucket:status')
}

export const linearBridge: PreloadApi['linear'] = {
  connect: (args: { apiKey: string }) => ipcRenderer.invoke('linear:connect', args),

  disconnect: (args?: { workspaceId?: string }): Promise<void> =>
    ipcRenderer.invoke('linear:disconnect', args),

  selectWorkspace: (args: { workspaceId: string }) =>
    ipcRenderer.invoke('linear:selectWorkspace', args),

  status: () => ipcRenderer.invoke('linear:status'),

  testConnection: (args?: { workspaceId?: string }) =>
    ipcRenderer.invoke('linear:testConnection', args),

  searchIssues: (args: { query: string; limit?: number; workspaceId?: string }) =>
    ipcRenderer.invoke('linear:searchIssues', args),

  listIssues: (args?: {
    filter?: 'assigned' | 'created' | 'all' | 'completed'
    limit?: number
    workspaceId?: string
    attributeFilter?: unknown
  }) => ipcRenderer.invoke('linear:listIssues', args),

  createIssue: (args: {
    teamId: string
    title: string
    description?: string
    workspaceId?: string
    parentIssueId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    assigneeId?: string | null
    labelIds?: string[]
  }): Promise<
    | { ok: true; id: string; identifier: string; title: string; url: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('linear:createIssue', args),

  getIssue: (args: { id: string; workspaceId?: string }) =>
    ipcRenderer.invoke('linear:getIssue', args),

  updateIssue: (args: {
    id: string
    updates: unknown
    workspaceId?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:updateIssue', args),

  addIssueComment: (args: {
    issueId: string
    body: string
    workspaceId?: string
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:addIssueComment', args),

  issueComments: (args: { issueId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('linear:issueComments', args),

  listTeams: (args?: { workspaceId?: string }) => ipcRenderer.invoke('linear:listTeams', args),

  listProjects: (args?: {
    query?: string
    limit?: number
    workspaceId?: string
    force?: boolean
  }) => ipcRenderer.invoke('linear:listProjects', args),

  createProject: (args: {
    name: string
    description?: string
    content?: string
    teamIds: string[]
    workspaceId?: string
    leadId?: string | null
    memberIds?: string[]
    labelIds?: string[]
    priority?: number
    startDate?: string
    targetDate?: string
  }): Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:createProject', args),

  getProject: (args: { id: string; workspaceId: string; force?: boolean }) =>
    ipcRenderer.invoke('linear:getProject', args),

  listProjectIssues: (args: {
    projectId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }) => ipcRenderer.invoke('linear:listProjectIssues', args),

  listCustomViews: (args: {
    model: string
    limit?: number
    workspaceId?: string
    force?: boolean
  }) => ipcRenderer.invoke('linear:listCustomViews', args),

  getCustomView: (args: {
    viewId: string
    model: string
    workspaceId: string
    force?: boolean
  }) => ipcRenderer.invoke('linear:getCustomView', args),

  listCustomViewIssues: (args: {
    viewId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }) => ipcRenderer.invoke('linear:listCustomViewIssues', args),

  listCustomViewProjects: (args: {
    viewId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }) => ipcRenderer.invoke('linear:listCustomViewProjects', args),

  teamStates: (args: { teamId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('linear:teamStates', args),

  teamLabels: (args: { teamId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('linear:teamLabels', args),

  teamMembers: (args: { teamId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('linear:teamMembers', args)
}

export const jiraBridge: PreloadApi['jira'] = {
  connect: (args: {
    siteUrl: string
    email: string
    apiToken: string
    authType?: 'cloud' | 'server'
  }) => ipcRenderer.invoke('jira:connect', args),

  disconnect: (args?: { siteId?: string }): Promise<void> =>
    ipcRenderer.invoke('jira:disconnect', args),

  selectSite: (args: { siteId: string }) => ipcRenderer.invoke('jira:selectSite', args),

  status: () => ipcRenderer.invoke('jira:status'),

  readStatus: () => ipcRenderer.invoke('jira:readStatus'),

  testConnection: (args?: { siteId?: string }) => ipcRenderer.invoke('jira:testConnection', args),

  searchIssues: (args: { jql: string; limit?: number; siteId?: string; requestId?: string }) =>
    ipcRenderer.invoke('jira:searchIssues', args),
  cancelSearchIssues: (args: { requestId: string }): Promise<void> =>
    ipcRenderer.invoke('jira:cancelSearchIssues', args),

  listIssues: (args?: {
    filter?: 'assigned' | 'reported' | 'all' | 'done'
    limit?: number
    siteId?: string
  }) => ipcRenderer.invoke('jira:listIssues', args),

  getIssue: (args: { key: string; siteId?: string }) => ipcRenderer.invoke('jira:getIssue', args),

  lookupIssueSummary: (args: { key: string; siteId: string; requestId?: string }) =>
    ipcRenderer.invoke('jira:lookupIssueSummary', args),
  cancelIssueSummary: (args: { requestId: string }): Promise<void> =>
    ipcRenderer.invoke('jira:cancelIssueSummary', args),

  createIssue: (args: {
    siteId?: string
    projectId: string
    issueTypeId: string
    title: string
    description?: string
    customFields?: Record<string, unknown>
  }): Promise<
    { ok: true; id: string; key: string; url: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('jira:createIssue', args),

  updateIssue: (args: {
    key: string
    updates: unknown
    siteId?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:updateIssue', args),

  addIssueComment: (args: {
    key: string
    body: string
    siteId?: string
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:addIssueComment', args),

  issueComments: (args: { key: string; siteId?: string }) =>
    ipcRenderer.invoke('jira:issueComments', args),

  listProjects: (args?: { siteId?: string }) => ipcRenderer.invoke('jira:listProjects', args),

  listIssueTypes: (args: { projectIdOrKey: string; siteId?: string }) =>
    ipcRenderer.invoke('jira:listIssueTypes', args),

  listCreateFields: (args: { projectIdOrKey: string; issueTypeId: string; siteId?: string }) =>
    ipcRenderer.invoke('jira:listCreateFields', args),

  listPriorities: (args?: { siteId?: string }) => ipcRenderer.invoke('jira:listPriorities', args),

  listAssignableUsers: (args: { key: string; query?: string; siteId?: string }) =>
    ipcRenderer.invoke('jira:listAssignableUsers', args),

  listTransitions: (args: { key: string; siteId?: string }) =>
    ipcRenderer.invoke('jira:listTransitions', args),
  getProjectStatusOrder: (args: {
    projectKey: string
    siteId?: string
  }): Promise<JiraProjectStatusOrder> => ipcRenderer.invoke('jira:getProjectStatusOrder', args)
}
