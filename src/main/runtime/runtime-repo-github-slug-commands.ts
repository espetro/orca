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
  UpdateProjectItemFieldArgs,
  UpdatePullRequestBySlugArgs
} from '../../shared/github/project-request-types'
import {
  clearProjectItemFieldValue,
  getProjectViewTable,
  getWorkItemDetailsBySlug,
  listAccessibleProjects,
  listProjectViews,
  resolveProjectRef,
  addIssueCommentBySlug,
  deleteIssueCommentBySlug,
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  listLabelsBySlug,
  updateIssueCommentBySlug,
  updateIssueBySlug,
  updateIssueTypeBySlug,
  updateProjectItemFieldValue,
  updatePullRequestBySlug
} from '../github/project-view'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'

export class RuntimeRepoGitHubSlugCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  async listGitHubProjects(
    args?: ListAccessibleProjectsArgs
  ): Promise<Awaited<ReturnType<typeof listAccessibleProjects>>> {
    return listAccessibleProjects(args)
  }

  async listGitHubLabelsBySlug(
    args: ListLabelsBySlugArgs
  ): Promise<Awaited<ReturnType<typeof listLabelsBySlug>>> {
    return listLabelsBySlug(args)
  }

  async listGitHubAssignableUsersBySlug(
    args: ListAssignableUsersBySlugArgs
  ): Promise<Awaited<ReturnType<typeof listAssignableUsersBySlug>>> {
    return listAssignableUsersBySlug(args)
  }

  async listGitHubIssueTypesBySlug(
    args: ListIssueTypesBySlugArgs
  ): Promise<Awaited<ReturnType<typeof listIssueTypesBySlug>>> {
    return listIssueTypesBySlug(args)
  }

  async resolveGitHubProjectRef(
    args: ResolveProjectRefArgs
  ): Promise<Awaited<ReturnType<typeof resolveProjectRef>>> {
    return resolveProjectRef(args)
  }

  async listGitHubProjectViews(
    args: ListProjectViewsArgs
  ): Promise<Awaited<ReturnType<typeof listProjectViews>>> {
    return listProjectViews(args)
  }

  async getGitHubProjectViewTable(
    args: GetProjectViewTableArgs
  ): Promise<Awaited<ReturnType<typeof getProjectViewTable>>> {
    return getProjectViewTable(args)
  }

  async getGitHubProjectWorkItemDetailsBySlug(
    args: ProjectWorkItemDetailsBySlugArgs
  ): Promise<Awaited<ReturnType<typeof getWorkItemDetailsBySlug>>> {
    return getWorkItemDetailsBySlug(args)
  }

  async updateGitHubProjectItemField(
    args: UpdateProjectItemFieldArgs
  ): Promise<Awaited<ReturnType<typeof updateProjectItemFieldValue>>> {
    return updateProjectItemFieldValue(args)
  }

  async clearGitHubProjectItemField(
    args: ClearProjectItemFieldArgs
  ): Promise<Awaited<ReturnType<typeof clearProjectItemFieldValue>>> {
    return clearProjectItemFieldValue(args)
  }

  async updateGitHubIssueBySlug(
    args: UpdateIssueBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updateIssueBySlug>>> {
    return updateIssueBySlug(args)
  }

  async updateGitHubPullRequestBySlug(
    args: UpdatePullRequestBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updatePullRequestBySlug>>> {
    return updatePullRequestBySlug(args)
  }

  async updateGitHubIssueTypeBySlug(
    args: UpdateIssueTypeBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updateIssueTypeBySlug>>> {
    return updateIssueTypeBySlug(args)
  }

  async addGitHubIssueCommentBySlug(
    args: AddIssueCommentBySlugArgs
  ): Promise<Awaited<ReturnType<typeof addIssueCommentBySlug>>> {
    return addIssueCommentBySlug(args)
  }

  async updateGitHubIssueCommentBySlug(
    args: UpdateIssueCommentBySlugArgs
  ): Promise<Awaited<ReturnType<typeof updateIssueCommentBySlug>>> {
    return updateIssueCommentBySlug(args)
  }

  async deleteGitHubIssueCommentBySlug(
    args: DeleteIssueCommentBySlugArgs
  ): Promise<Awaited<ReturnType<typeof deleteIssueCommentBySlug>>> {
    return deleteIssueCommentBySlug(args)
  }
}
