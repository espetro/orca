import type {
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueUpdate,
  JiraSiteSelection
} from '../../../shared/jira-types'
import type {
} from '../../../shared/linear/agent-access'


import {
  connect as connectJira,
  disconnect as disconnectJira,
  getStatus as getJiraStatus,
  selectSite as selectJiraSite,
  testConnection as testJiraConnection
} from '../../jira/client'
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
} from '../../jira/issues'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'


export class JiraCommands {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

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
