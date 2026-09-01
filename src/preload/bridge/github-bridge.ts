import { ipcRenderer } from 'electron'
import type { Merged } from '../api-types'
import type { GithubPullRequestApi } from '../api/github-pull-request-api'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GithubWorkItemApi, GitHubRepoSelectorArgs } from '../api/github-work-item-api'
import type { GitHubPRFile } from '../../shared/github/pull-request-types'
import type {
  GitHubCommentResult,
  GitHubReactionContent
} from '../../shared/github/comment-types'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason
} from '../../shared/github/pull-request-refresh-types'
import type { GitHubWorkItem, ListWorkItemsResult } from '../../shared/github/work-item-types'
import type { GitHubCreateIssueResult } from '../../shared/issue-mutation-types'

type GhCore = Merged<GithubPullRequestApi & GithubWorkItemApi>

export const ghBridge: Omit<
  GhCore,
  | 'checkOrcaStarred'
  | 'starOrca'
  | 'rateLimit'
  | 'diagnoseAuth'
  | 'listAccessibleProjects'
  | 'resolveProjectRef'
  | 'listProjectViews'
  | 'getProjectViewTable'
  | 'projectWorkItemDetailsBySlug'
  | 'updateProjectItemField'
  | 'clearProjectItemField'
  | 'updateIssueBySlug'
  | 'updatePullRequestBySlug'
  | 'addIssueCommentBySlug'
  | 'updateIssueCommentBySlug'
  | 'deleteIssueCommentBySlug'
  | 'listLabelsBySlug'
  | 'listAssignableUsersBySlug'
  | 'listIssueTypesBySlug'
  | 'updateIssueTypeBySlug'
  | 'listLabels'
  | 'listAssignableUsers'
  | 'onWorkItemMutated'
> = {
  viewer: () => ipcRenderer.invoke('gh:viewer'),

  repoSlug: (args: { repoPath: string; repoId?: string }) =>
    ipcRenderer.invoke('gh:repoSlug', args),

  repoUpstream: (args: { repoPath: string; repoId?: string }) =>
    ipcRenderer.invoke('gh:repoUpstream', args),

  prForBranch: (args: {
    repoPath: string
    repoId?: string
    branch: string
    linkedPRNumber?: number | null
    fallbackPRNumber?: number | null
    acceptMergedFallbackPR?: boolean
    currentHeadOid?: string | null
  }) => ipcRenderer.invoke('gh:prForBranch', args),

  refreshPRNow: (args: { candidate: GitHubPRRefreshCandidate }) =>
    ipcRenderer.invoke('gh:refreshPRNow', args),

  enqueuePRRefresh: (args: {
    candidate: GitHubPRRefreshCandidate
    reason: GitHubPRRefreshReason
    priority?: number
  }) => ipcRenderer.invoke('gh:enqueuePRRefresh', args),

  reportVisiblePRRefreshCandidates: (args: {
    candidates: GitHubPRRefreshCandidate[]
    generation: number
  }) => ipcRenderer.invoke('gh:reportVisiblePRRefreshCandidates', args),

  onPRRefreshEvent: (callback: (event: GitHubPRRefreshEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: GitHubPRRefreshEvent): void =>
      callback(event)
    ipcRenderer.on('gh:prRefreshEvent', listener)
    return () => ipcRenderer.removeListener('gh:prRefreshEvent', listener)
  },

  issue: (
    args: GitHubRepoSelectorArgs & {
      number: number
    }
  ) => ipcRenderer.invoke('gh:issue', args),

  workItem: (
    args: GitHubRepoSelectorArgs & {
      number: number
      type?: 'issue' | 'pr'
    }
  ) => ipcRenderer.invoke('gh:workItem', args),

  workItemByOwnerRepo: (args: {
    repoPath: string
    repoId?: string
    owner: string
    repo: string
    host?: string
    number: number
    type: 'issue' | 'pr'
  }) => ipcRenderer.invoke('gh:workItemByOwnerRepo', args),

  workItemDetails: (
    args: GitHubRepoSelectorArgs & {
      number: number
      type?: 'issue' | 'pr'
    }
  ) => ipcRenderer.invoke('gh:workItemDetails', args),

  notifyWorkItemMutated: (args: {
    repoPath: string
    repoId?: string
    type: 'issue' | 'pr'
    number: number
  }): Promise<boolean> => ipcRenderer.invoke('gh:notifyWorkItemMutated', args),

  prFileContents: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }
  ) => ipcRenderer.invoke('gh:prFileContents', args),

  listIssues: (args: { repoPath: string; repoId?: string; limit?: number }) =>
    ipcRenderer.invoke('gh:listIssues', args),

  createIssue: (
    args: GitHubRepoSelectorArgs & {
      title: string
      body: string
      labels?: string[]
      assignees?: string[]
    }
  ): Promise<GitHubCreateIssueResult> => ipcRenderer.invoke('gh:createIssue', args),

  countWorkItems: (args: {
    repoPath: string
    repoId?: string
    query?: string
  }): Promise<number> => ipcRenderer.invoke('gh:countWorkItems', args),

  listWorkItems: (args: {
    repoPath: string
    repoId?: string
    limit?: number
    query?: string
    page?: number
    noCache?: boolean
  }): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> =>
    ipcRenderer.invoke('gh:listWorkItems', args),

  prChecks: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      headSha?: string
      prRepo?: GitHubOwnerRepo | null
      noCache?: boolean
    }
  ) => ipcRenderer.invoke('gh:prChecks', args),

  prCheckDetails: (
    args: GitHubRepoSelectorArgs & {
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: GitHubOwnerRepo | null
    }
  ) => ipcRenderer.invoke('gh:prCheckDetails', args),

  rerunPRChecks: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      headSha?: string
      failedOnly?: boolean
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true; count: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:rerunPRChecks', args),

  prComments: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      noCache?: boolean
    }
  ) => ipcRenderer.invoke('gh:prComments', args),

  setPRCommentReaction: (
    args: GitHubRepoSelectorArgs & {
      reactionSubjectId: string
      content: GitHubReactionContent
      reacted: boolean
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<boolean> => ipcRenderer.invoke('gh:setPRCommentReaction', args),

  resolveReviewThread: (
    args: GitHubRepoSelectorArgs & {
      threadId: string
      resolve: boolean
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<boolean> => ipcRenderer.invoke('gh:resolveReviewThread', args),

  setPRFileViewed: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      pullRequestId: string
      path: string
      viewed: boolean
    }
  ): Promise<boolean> => ipcRenderer.invoke('gh:setPRFileViewed', args),

  updatePRTitle: (args: {
    repoPath: string
    repoId?: string
    prNumber: number
    title: string
    prRepo?: GitHubOwnerRepo | null
  }): Promise<boolean> => ipcRenderer.invoke('gh:updatePRTitle', args),

  mergePR: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      method?: 'merge' | 'squash' | 'rebase'
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:mergePR', args),

  setPRAutoMerge: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      enabled: boolean
      method?: 'merge' | 'squash' | 'rebase'
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:setPRAutoMerge', args),

  updatePRState: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      updates: { state: 'open' | 'closed' }
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:updatePRState', args),

  markPRReadyForReview: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:markPRReadyForReview', args),

  requestPRReviewers: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      reviewers: string[]
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:requestPRReviewers', args),

  removePRReviewers: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      reviewers: string[]
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:removePRReviewers', args),

  updateIssue: (
    args: GitHubRepoSelectorArgs & {
      number: number
      updates: unknown
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('gh:updateIssue', args),

  addIssueComment: (
    args: GitHubRepoSelectorArgs & {
      number: number
      body: string
      type?: 'issue' | 'pr'
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addIssueComment', args),

  addPRReviewCommentReply: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewCommentReply', args),

  addPRReviewComment: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      commitId: string
      path: string
      line: number
      startLine?: number
      body: string
    }
  ): Promise<GitHubCommentResult> => ipcRenderer.invoke('gh:addPRReviewComment', args),
}
