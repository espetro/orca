import type { LinearMobileIssue } from '../../../src/tasks/linear-mobile-issue-read'

export type LinearProject = {
  id: string
  name: string
  url?: string
  color?: string
}

export type LinearIssueChild = {
  id: string
  identifier: string
  title: string
  url: string
}

export type LinearIssue = LinearMobileIssue

export type LinearState = {
  id: string
  name: string
  type: string
  color?: string
}

export type LinearTeam = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  key: string
}
export type LinearWorkspace = {
  id: string
  organizationName?: string
  displayName?: string
}

export type LinearStatusResponse = {
  connected?: boolean
  workspaces?: LinearWorkspace[]
  selectedWorkspaceId?: string | 'all' | null
  activeWorkspaceId?: string | null
}
