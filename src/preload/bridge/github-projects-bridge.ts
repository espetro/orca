import { ipcRenderer } from 'electron'
import type { GitHubAssignableUser } from '../../shared/github/pull-request-types'
import type { GetRateLimitResult } from '../../shared/github/rate-limit-types'
import type { GhAuthDiagnostic } from '../../shared/github/auth-types'
import type { AppStarSource } from '../../shared/gh-star-source'
import type {
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugResult,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefResult
} from '../../shared/github/project-result-types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  ListAccessibleProjectsArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../../shared/github/project-request-types'
import type { GithubWorkItemApi, GitHubRepoSelectorArgs } from '../api/github-work-item-api'
import type { Merged } from '../api-types'
import type { GithubPullRequestApi } from '../api/github-pull-request-api'
// Star state, rate limit, auth diagnostics and Projects V2 members of the gh merged contract.
export const ghProjectsBridge: Pick<
  Merged<GithubPullRequestApi & GithubWorkItemApi>,
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
  checkOrcaStarred: (): Promise<boolean | null> => ipcRenderer.invoke('gh:checkOrcaStarred'),
  starOrca: (source: AppStarSource): Promise<boolean> => ipcRenderer.invoke('gh:starOrca', source),

  // Why: rate_limit is exempt from rate-limit accounting; `force` still busts the 30s in-process cache after an expensive op.
  rateLimit: (args?: { force?: boolean }): Promise<GetRateLimitResult> =>
    ipcRenderer.invoke('gh:rateLimit', args),

  diagnoseAuth: (args?: { host?: string }): Promise<GhAuthDiagnostic> =>
    ipcRenderer.invoke('gh:diagnoseAuth', args),

  listLabels: (args: GitHubRepoSelectorArgs & {}): Promise<string[]> =>
    ipcRenderer.invoke('gh:listLabels', args),

  listAssignableUsers: (args: GitHubRepoSelectorArgs & {}): Promise<GitHubAssignableUser[]> =>
    ipcRenderer.invoke('gh:listAssignableUsers', args),

  // Why: renderer owns the work-item cache; main fires this for non-origin mutations only (origin callers updated optimistically). See src/main/ipc/github.ts.
  onWorkItemMutated: (
    callback: (payload: {
      repoPath: string
      repoId?: string
      type: 'issue' | 'pr'
      number: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { repoPath: string; repoId?: string; type: 'issue' | 'pr'; number: number }
    ): void => callback(payload)
    ipcRenderer.on('gh:workItemMutated', listener)
    return () => ipcRenderer.removeListener('gh:workItemMutated', listener)
  },

  // ── ProjectV2 (GitHub Projects) ───────────────────────────────────
  listAccessibleProjects: (
    args?: ListAccessibleProjectsArgs
  ): Promise<ListAccessibleProjectsResult> => ipcRenderer.invoke('gh:listAccessibleProjects', args),
  resolveProjectRef: (args: ResolveProjectRefArgs): Promise<ResolveProjectRefResult> =>
    ipcRenderer.invoke('gh:resolveProjectRef', args),
  listProjectViews: (args: ListProjectViewsArgs): Promise<ListProjectViewsResult> =>
    ipcRenderer.invoke('gh:listProjectViews', args),
  getProjectViewTable: (args: GetProjectViewTableArgs): Promise<GetProjectViewTableResult> =>
    ipcRenderer.invoke('gh:getProjectViewTable', args),
  projectWorkItemDetailsBySlug: (
    args: ProjectWorkItemDetailsBySlugArgs
  ): Promise<ProjectWorkItemDetailsBySlugResult> =>
    ipcRenderer.invoke('gh:projectWorkItemDetailsBySlug', args),
  updateProjectItemField: (
    args: UpdateProjectItemFieldArgs
  ): Promise<GitHubProjectMutationResult> => ipcRenderer.invoke('gh:updateProjectItemField', args),
  clearProjectItemField: (args: ClearProjectItemFieldArgs): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:clearProjectItemField', args),
  updateIssueBySlug: (args: UpdateIssueBySlugArgs): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:updateIssueBySlug', args),
  updatePullRequestBySlug: (
    args: UpdatePullRequestBySlugArgs
  ): Promise<GitHubProjectMutationResult> => ipcRenderer.invoke('gh:updatePullRequestBySlug', args),
  addIssueCommentBySlug: (
    args: AddIssueCommentBySlugArgs
  ): Promise<GitHubProjectCommentMutationResult> =>
    ipcRenderer.invoke('gh:addIssueCommentBySlug', args),
  updateIssueCommentBySlug: (
    args: UpdateIssueCommentBySlugArgs
  ): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:updateIssueCommentBySlug', args),
  deleteIssueCommentBySlug: (
    args: DeleteIssueCommentBySlugArgs
  ): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:deleteIssueCommentBySlug', args),
  listLabelsBySlug: (args: ListLabelsBySlugArgs): Promise<ListLabelsBySlugResult> =>
    ipcRenderer.invoke('gh:listLabelsBySlug', args),
  listAssignableUsersBySlug: (
    args: ListAssignableUsersBySlugArgs
  ): Promise<ListAssignableUsersBySlugResult> =>
    ipcRenderer.invoke('gh:listAssignableUsersBySlug', args),
  listIssueTypesBySlug: (args: ListIssueTypesBySlugArgs): Promise<ListIssueTypesBySlugResult> =>
    ipcRenderer.invoke('gh:listIssueTypesBySlug', args),
  updateIssueTypeBySlug: (args: UpdateIssueTypeBySlugArgs): Promise<GitHubProjectMutationResult> =>
    ipcRenderer.invoke('gh:updateIssueTypeBySlug', args)
}
