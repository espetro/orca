import {
  closeMR as closeGitLabMR,
  createIssue as createGitLabIssue,
  diagnoseAuth as diagnoseGitLabAuthClient,
  getJobTrace as getGitLabJobTrace,
  getRateLimit as getGitLabRateLimit,
  getWorkItemByProjectRef as getGitLabWorkItemByProjectRef,
  addIssueComment as addGitLabIssueComment,
  addMRInlineComment as addGitLabMRInlineComment,
  addMRComment as addGitLabMRComment,
  listTodos as listGitLabTodos,
  listIssues as listGitLabIssues,
  listLabels as listGitLabLabels,
  listMergeRequests as listGitLabMergeRequests,
  listWorkItems as listGitLabWorkItems,
  mergeMR as mergeGitLabMR,
  reopenMR as reopenGitLabMR,
  resolveMRDiscussion as resolveGitLabMRDiscussion,
  retryJob as retryGitLabJob,
  updateMR as updateGitLabMR,
  updateMRReviewers as updateGitLabMRReviewers,
  updateIssue as updateGitLabIssue
} from '../gitlab/client'
import {
  normalizeGitLabIssueListArgs,
  normalizeGitLabMRListState,
  normalizeGitLabPositiveInteger,
  type GitLabIssueListState
} from '../gitlab/gitlab-preload-args'
import { recordGitLabProjectRecent } from '../gitlab/gitlab-project-recents'
import { getWorkItemDetails as getGitLabWorkItemDetails } from '../gitlab/work-item-details'
import type {
  GitLabIssueUpdate,
  GitLabMRInlineCommentInput,
  GitLabMRUpdate,
  GitLabProjectRef,
  GitLabWorkItem,
  MRListState
} from '../../shared/gitlab-types'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'

// Why: narrow closure surface over OrcaRuntimeService so repo/git commands stay
// unit-testable without constructing the full runtime (pattern of runtime-linear-command-host).

export class RuntimeRepoGitLabCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  private get self() {
    return this
  }

  async listGitLabRepoWorkItems(
    repoSelector: string,
    state?: MRListState,
    page?: number,
    perPage?: number,
    query?: string
  ): Promise<Awaited<ReturnType<typeof listGitLabWorkItems>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listGitLabWorkItems(
      repo.path,
      state ?? 'opened',
      page ?? 1,
      perPage ?? 20,
      repo.issueSourcePreference,
      query,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async listGitLabRepoMRs(
    repoSelector: string,
    state?: MRListState,
    page?: number,
    perPage?: number,
    query?: string
  ): Promise<Awaited<ReturnType<typeof listGitLabMergeRequests>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listGitLabMergeRequests(
      repo.path,
      normalizeGitLabMRListState(state),
      normalizeGitLabPositiveInteger(page, 1, 10_000),
      normalizeGitLabPositiveInteger(perPage, 20, 100),
      repo.issueSourcePreference,
      query,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async listGitLabRepoIssues(
    repoSelector: string,
    state?: GitLabIssueListState,
    assignee?: string,
    limit?: number,
    page?: number
  ): Promise<{
    items: GitLabWorkItem[]
    totalPages: number
    error?: Awaited<ReturnType<typeof listGitLabIssues>>['error']
  }> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const normalized = normalizeGitLabIssueListArgs({
      state,
      assignee,
      limit,
      page
    })
    // Why: page is after localGitOptions; never spread optional args before it (#13538).
    const result = await listGitLabIssues(
      repo.path,
      normalized.limit,
      repo.issueSourcePreference,
      normalized.state,
      normalized.assignee,
      repo.connectionId ?? null,
      self.getLocalGitExecutionOptionArgs(repo)[0] ?? {},
      normalized.page
    )
    // Why: web runtime mirrors the desktop preload contract, where GitLab
    // issue rows share the GitLabWorkItem shape with MRs on TaskPage.
    const items: GitLabWorkItem[] = result.items.map((issue) => ({
      id: `gitlab-issue-${repo.id}-${issue.number}`,
      type: 'issue' as const,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      labels: issue.labels,
      updatedAt: issue.updatedAt ?? '',
      author: issue.author ?? null,
      repoId: repo.id
    }))
    return {
      items,
      totalPages: result.totalPages,
      ...(result.error ? { error: result.error } : {})
    }
  }

  async listGitLabRepoTodos(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listGitLabTodos>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listGitLabTodos(
      repo.path,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async diagnoseGitLabAuth(): Promise<Awaited<ReturnType<typeof diagnoseGitLabAuthClient>>> {
    return diagnoseGitLabAuthClient()
  }

  async getGitLabRateLimit(options?: {
    force?: boolean
    host?: string | null
  }): Promise<Awaited<ReturnType<typeof getGitLabRateLimit>>> {
    return getGitLabRateLimit(options)
  }

  async listGitLabRepoLabels(
    repoSelector: string
  ): Promise<Awaited<ReturnType<typeof listGitLabLabels>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return listGitLabLabels(
      repo.path,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async createGitLabRepoIssue(
    repoSelector: string,
    title: string,
    body: string
  ): Promise<Awaited<ReturnType<typeof createGitLabIssue>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return createGitLabIssue(
      repo.path,
      title,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async updateGitLabRepoIssue(
    repoSelector: string,
    number: number,
    updates: GitLabIssueUpdate,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof updateGitLabIssue>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updateGitLabIssue(
      repo.path,
      number,
      updates,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async addGitLabRepoIssueComment(
    repoSelector: string,
    number: number,
    body: string,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof addGitLabIssueComment>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return addGitLabIssueComment(
      repo.path,
      number,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async addGitLabRepoMRComment(
    repoSelector: string,
    iid: number,
    body: string,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof addGitLabMRComment>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return addGitLabMRComment(
      repo.path,
      iid,
      body,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async addGitLabRepoMRInlineComment(
    repoSelector: string,
    iid: number,
    input: GitLabMRInlineCommentInput,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof addGitLabMRInlineComment>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return addGitLabMRInlineComment(
      repo.path,
      iid,
      input,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async resolveGitLabRepoMRDiscussion(
    repoSelector: string,
    iid: number,
    discussionId: string,
    resolved: boolean,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof resolveGitLabMRDiscussion>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return resolveGitLabMRDiscussion(
      repo.path,
      iid,
      discussionId,
      resolved,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getGitLabRepoJobTrace(
    repoSelector: string,
    jobId: number,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof getGitLabJobTrace>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getGitLabJobTrace(
      repo.path,
      jobId,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async retryGitLabRepoJob(
    repoSelector: string,
    jobId: number,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof retryGitLabJob>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return retryGitLabJob(
      repo.path,
      jobId,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async mergeGitLabRepoMR(
    repoSelector: string,
    iid: number,
    method?: 'merge' | 'squash' | 'rebase',
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof mergeGitLabMR>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return mergeGitLabMR(
      repo.path,
      iid,
      method ?? 'merge',
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async updateGitLabRepoMRState(
    repoSelector: string,
    iid: number,
    state: 'opened' | 'closed',
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof closeGitLabMR>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return state === 'closed'
      ? closeGitLabMR(
          repo.path,
          iid,
          repo.issueSourcePreference,
          repo.connectionId ?? null,
          projectRef,
          ...self.getLocalGitExecutionOptionArgs(repo)
        )
      : reopenGitLabMR(
          repo.path,
          iid,
          repo.issueSourcePreference,
          repo.connectionId ?? null,
          projectRef,
          ...self.getLocalGitExecutionOptionArgs(repo)
        )
  }

  async updateGitLabRepoMR(
    repoSelector: string,
    iid: number,
    updates: GitLabMRUpdate,
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof updateGitLabMR>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updateGitLabMR(
      repo.path,
      iid,
      updates,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async updateGitLabRepoMRReviewers(
    repoSelector: string,
    iid: number,
    reviewerIds: number[],
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof updateGitLabMRReviewers>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return updateGitLabMRReviewers(
      repo.path,
      iid,
      reviewerIds,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getGitLabRepoWorkItemDetails(
    repoSelector: string,
    iid: number,
    type: 'issue' | 'mr',
    projectRef?: GitLabProjectRef | null
  ): Promise<Awaited<ReturnType<typeof getGitLabWorkItemDetails>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    return getGitLabWorkItemDetails(
      repo.path,
      iid,
      type,
      repo.issueSourcePreference,
      repo.connectionId ?? null,
      projectRef,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
  }

  async getGitLabRepoWorkItemByPath(
    repoSelector: string,
    projectRef: GitLabProjectRef,
    iid: number,
    type: 'issue' | 'mr'
  ): Promise<Awaited<ReturnType<typeof getGitLabWorkItemByProjectRef>>> {
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const result = await getGitLabWorkItemByProjectRef(
      repo.path,
      projectRef,
      iid,
      type,
      repo.connectionId ?? null,
      ...self.getLocalGitExecutionOptionArgs(repo)
    )
    // Why: remote pasted-URL lookups should update GitLab recents exactly
    // like the desktop IPC path, but only after a successful lookup.
    if (result && self.deps.store?.updateSettings) {
      const store = self.deps.store
      recordGitLabProjectRecent(
        {
          getSettings: () => store.getSettings(),
          updateSettings: (updates) => store.updateSettings?.(updates)
        },
        projectRef.host,
        projectRef.path
      )
    }
    return result
  }
}
