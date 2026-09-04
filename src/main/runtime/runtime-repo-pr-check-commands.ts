import {
  getIssue,
  resolveReviewThread,
  getPRChecks,
  getPRCheckDetails,
  rerunPRChecks,
  getPRComments,
  setPRCommentReaction,
  updatePRTitle,
  updatePRDetails,
  mergePR,
  markPRReadyForReview,
  setPRAutoMerge,
  updatePRState,
  requestPRReviewers,
  removePRReviewers,
  createIssue,
  updateIssue,
  addIssueComment,
  addPRReviewComment,
  addPRReviewCommentReply
} from '../github/client'
import { getPRFileContents } from '../github/work-item-details'
import type {
  GitHubCreateIssueFields,
  GitHubIssueUpdate,
  GitHubPullRequestStateUpdate
} from '../../shared/issue-mutation-types'
import type {
  GitHubPRReviewCommentInput,
  GitHubReactionContent
} from '../../shared/github/comment-types'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../shared/github/pull-request-types'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'

// Why: narrow closure surface over OrcaRuntimeService so repo/git commands stay
// unit-testable without constructing the full runtime (pattern of runtime-linear-command-host).

export class RuntimeRepoPRCheckCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  private get self() {
    return this
  }

  async getRepoIssue(
    repoSelector: string,
    number: number
  ): Promise<Awaited<ReturnType<typeof getIssue>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getIssue(
      repo.path,
      number,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    headSha?: string,
    prRepo?: GitHubOwnerRepo | null,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRChecks>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getPRChecks(
      repo.path,
      prNumber,
      headSha,
      prRepo ?? null,
      options,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async rerunRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    options?: {
      headSha?: string
      failedOnly?: boolean
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<Awaited<ReturnType<typeof rerunPRChecks>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return rerunPRChecks(
      repo.path,
      prNumber,
      options,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getRepoPRCheckDetails(
    repoSelector: string,
    args: {
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: GitHubOwnerRepo | null
    },
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<typeof getPRCheckDetails>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const localGitOptions = self.getLocalGitExecutionOptionArgs(repo)[0] ?? {}
    return getPRCheckDetails(
      repo.path,
      { ...args, prRepo: args.prRepo ?? null },
      repo.connectionId ?? null,
      localGitOptions,
      signal
    )
  }

  async getRepoPRComments(
    repoSelector: string,
    prNumber: number,
    prRepo?: GitHubOwnerRepo | null,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRComments>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getPRComments(
      repo.path,
      prNumber,
      { ...options, prRepo: prRepo ?? null },
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async setRepoPRCommentReaction(
    repoSelector: string,
    reactionSubjectId: string,
    content: GitHubReactionContent,
    reacted: boolean,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof setPRCommentReaction>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return setPRCommentReaction(
      repo.path,
      reactionSubjectId,
      content,
      reacted,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getRepoPRFileContents(
    repoSelector: string,
    args: {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }
  ): Promise<Awaited<ReturnType<typeof getPRFileContents>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getPRFileContents({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      localGitOptions: self.getLocalGitExecutionOptionArgs(repo)[0],
      ...args
    })
  }

  async resolveRepoReviewThread(
    repoSelector: string,
    threadId: string,
    resolve: boolean,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof resolveReviewThread>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return resolveReviewThread(
      repo.path,
      threadId,
      resolve,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async setRepoPRFileViewed(
    repoSelector: string,
    args: {
      prRepo?: GitHubOwnerRepo | null
      pullRequestId: string
      path: string
      viewed: boolean
    }
  ): Promise<Awaited<ReturnType<typeof setPRFileViewed>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return setPRFileViewed({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      localGitOptions: self.getLocalGitExecutionOptionArgs(repo)[0],
      ...args
    })
  }

  async updateRepoPRTitle(
    repoSelector: string,
    prNumber: number,
    title: string,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof updatePRTitle>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updatePRTitle(
      repo.path,
      prNumber,
      title,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async updateRepoPRDetails(
    repoSelector: string,
    prNumber: number,
    updates: { title?: string; body?: string },
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof updatePRDetails>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updatePRDetails(
      repo.path,
      prNumber,
      updates,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async mergeRepoPR(
    repoSelector: string,
    prNumber: number,
    method?: 'merge' | 'squash' | 'rebase',
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof mergePR>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return mergePR(
      repo.path,
      prNumber,
      method,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async setRepoPRAutoMerge(
    repoSelector: string,
    prNumber: number,
    enabled: boolean,
    method?: 'merge' | 'squash' | 'rebase',
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof setPRAutoMerge>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return setPRAutoMerge(
      repo.path,
      prNumber,
      enabled,
      method,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async markRepoPRReadyForReview(
    repoSelector: string,
    prNumber: number,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof markPRReadyForReview>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return markPRReadyForReview(
      repo.path,
      prNumber,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async updateRepoPRState(
    repoSelector: string,
    prNumber: number,
    updates: GitHubPullRequestStateUpdate,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof updatePRState>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updatePRState(
      repo.path,
      prNumber,
      updates,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async requestRepoPRReviewers(
    repoSelector: string,
    prNumber: number,
    reviewers: string[],
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof requestPRReviewers>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return requestPRReviewers(
      repo.path,
      prNumber,
      reviewers,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async removeRepoPRReviewers(
    repoSelector: string,
    prNumber: number,
    reviewers: string[],
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof removePRReviewers>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return removePRReviewers(
      repo.path,
      prNumber,
      reviewers,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async createRepoIssue(
    repoSelector: string,
    title: string,
    body: string,
    fields?: GitHubCreateIssueFields
  ): Promise<Awaited<ReturnType<typeof createIssue>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return createIssue(
      repo.path,
      title,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      fields,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async updateRepoIssue(
    repoSelector: string,
    number: number,
    updates: GitHubIssueUpdate
  ): Promise<Awaited<ReturnType<typeof updateIssue>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updateIssue(
      repo.path,
      number,
      updates,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async addRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string,
    prRepo?: GitHubOwnerRepo | null
  ): Promise<Awaited<ReturnType<typeof addIssueComment>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return addIssueComment(
      repo.path,
      number,
      body,
      repo.connectionId ?? null,
      prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async addRepoPRReviewComment(
    repoSelector: string,
    args: Omit<GitHubPRReviewCommentInput, 'repoPath'>
  ): Promise<Awaited<ReturnType<typeof addPRReviewComment>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return addPRReviewComment({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      localGitOptions: self.getLocalGitExecutionOptionArgs(repo)[0],
      ...args
    })
  }

  async addRepoPRReviewCommentReply(
    repoSelector: string,
    args: {
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
      prRepo?: GitHubOwnerRepo | null
    }
  ): Promise<Awaited<ReturnType<typeof addPRReviewCommentReply>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return addPRReviewCommentReply(
      repo.path,
      args.prNumber,
      args.commentId,
      args.body,
      args.threadId,
      args.path,
      args.line,
      repo.connectionId ?? null,
      args.prRepo ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }
}
