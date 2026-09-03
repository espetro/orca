import type { GitHubAssignableUser, GitHubPRReviewSummary } from './tasks-types-core'
import type { LinearIssueChild, LinearProject } from './tasks-types-linear'

export type DetailComment = {
  id: string | number
  author?: string
  authorAvatarUrl?: string
  user?: { displayName?: string }
  isBot?: boolean
  body: string
  createdAt?: string
  url?: string
  reactions?: Array<{
    content:
      | 'thumbs_up'
      | 'thumbs_down'
      | 'laugh'
      | 'confused'
      | 'heart'
      | 'hooray'
      | 'rocket'
      | 'eyes'
    count: number
  }>
  path?: string
  line?: number
  startLine?: number
  threadId?: string
  isResolved?: boolean
}

export type GitHubDetailFile = {
  path: string
  oldPath?: string
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions?: number
  deletions?: number
  isBinary?: boolean
  viewerViewedState?: 'DISMISSED' | 'VIEWED' | 'UNVIEWED'
}

export type GitHubDetailCheck = {
  name: string
  status: string
  conclusion?: string | null
  url?: string | null
}

export type GitHubPRFileContents = {
  original: string
  modified: string
  originalIsBinary: boolean
  modifiedIsBinary: boolean
}

export type DetailPayload =
  | {
      provider: 'github'
      body: string
      comments: DetailComment[]
      labels: string[]
      assignees: string[]
      reviewDecision?: string | null
      reviewRequests: GitHubAssignableUser[]
      latestReviews: GitHubPRReviewSummary[]
      headSha?: string
      baseSha?: string
      pullRequestId?: string
      checks: GitHubDetailCheck[]
      files: GitHubDetailFile[]
    }
  | {
      provider: 'gitlab'
      body: string
      comments: DetailComment[]
      labels: string[]
      assignees: string[]
      pipelineJobs: Array<{
        id?: number
        name: string
        stage: string
        status: string
        webUrl?: string | null
        duration?: number | null
      }>
    }
  | {
      provider: 'linear'
      description: string
      comments: DetailComment[]
      labels: string[]
      assignee?: string
      project?: LinearProject
      children: LinearIssueChild[]
    }
export type DetailCommentGroup =
  | { kind: 'standalone'; comment: DetailComment }
  | { kind: 'thread'; threadId: string; root: DetailComment; replies: DetailComment[] }
