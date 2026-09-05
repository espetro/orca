import { RuntimeRepoGitCoreCommands } from './runtime-repo-git-core-commands'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'
import { RuntimeRepoHostedReviewCommands } from './runtime-repo-hosted-review-commands'
import { RuntimeRepoGitLabCommands } from './runtime-repo-gitlab-commands'
import { RuntimeRepoPRCheckCommands } from './runtime-repo-pr-check-commands'
import { RuntimeRepoSetupHookCommands } from './runtime-repo-setup-hook-commands'
import { RuntimeRepoManagedWorktreeCommands } from './runtime-repo-managed-worktree-commands'
import { RuntimeRepoGitHubSlugCommands } from './runtime-repo-github-slug-commands'

export class RuntimeRepoGitCommandsFacade {
  private readonly git: RuntimeRepoGitCoreCommands
  private readonly hostedReview: RuntimeRepoHostedReviewCommands
  private readonly gitlab: RuntimeRepoGitLabCommands
  private readonly prCheck: RuntimeRepoPRCheckCommands
  private readonly setupHook: RuntimeRepoSetupHookCommands
  private readonly managedWorktrees: RuntimeRepoManagedWorktreeCommands
  private readonly githubSlug: RuntimeRepoGitHubSlugCommands
  getRepoBaseRefDefault: typeof this.git.getRepoBaseRefDefault
  inspectTerminalProcess: typeof this.git.inspectTerminalProcess
  removeProject: typeof this.git.removeProject
  reorderRepos: typeof this.git.reorderRepos
  searchRepoRefs: typeof this.git.searchRepoRefs
  setRepoBaseRef: typeof this.git.setRepoBaseRef
  showRepo: typeof this.git.showRepo
  updateRepo: typeof this.git.updateRepo
  addGitHubIssueCommentBySlug: typeof this.githubSlug.addGitHubIssueCommentBySlug
  clearGitHubProjectItemField: typeof this.githubSlug.clearGitHubProjectItemField
  deleteGitHubIssueCommentBySlug: typeof this.githubSlug.deleteGitHubIssueCommentBySlug
  getGitHubProjectViewTable: typeof this.githubSlug.getGitHubProjectViewTable
  getGitHubProjectWorkItemDetailsBySlug: typeof this.githubSlug.getGitHubProjectWorkItemDetailsBySlug
  listGitHubAssignableUsersBySlug: typeof this.githubSlug.listGitHubAssignableUsersBySlug
  listGitHubIssueTypesBySlug: typeof this.githubSlug.listGitHubIssueTypesBySlug
  listGitHubLabelsBySlug: typeof this.githubSlug.listGitHubLabelsBySlug
  listGitHubProjectViews: typeof this.githubSlug.listGitHubProjectViews
  listGitHubProjects: typeof this.githubSlug.listGitHubProjects
  resolveGitHubProjectRef: typeof this.githubSlug.resolveGitHubProjectRef
  updateGitHubIssueBySlug: typeof this.githubSlug.updateGitHubIssueBySlug
  updateGitHubIssueCommentBySlug: typeof this.githubSlug.updateGitHubIssueCommentBySlug
  updateGitHubIssueTypeBySlug: typeof this.githubSlug.updateGitHubIssueTypeBySlug
  updateGitHubProjectItemField: typeof this.githubSlug.updateGitHubProjectItemField
  updateGitHubPullRequestBySlug: typeof this.githubSlug.updateGitHubPullRequestBySlug
  addGitLabRepoIssueComment: typeof this.gitlab.addGitLabRepoIssueComment
  addGitLabRepoMRComment: typeof this.gitlab.addGitLabRepoMRComment
  addGitLabRepoMRInlineComment: typeof this.gitlab.addGitLabRepoMRInlineComment
  createGitLabRepoIssue: typeof this.gitlab.createGitLabRepoIssue
  diagnoseGitLabAuth: typeof this.gitlab.diagnoseGitLabAuth
  getGitLabRateLimit: typeof this.gitlab.getGitLabRateLimit
  getGitLabRepoJobTrace: typeof this.gitlab.getGitLabRepoJobTrace
  getGitLabRepoWorkItemByPath: typeof this.gitlab.getGitLabRepoWorkItemByPath
  getGitLabRepoWorkItemDetails: typeof this.gitlab.getGitLabRepoWorkItemDetails
  listGitLabRepoIssues: typeof this.gitlab.listGitLabRepoIssues
  listGitLabRepoLabels: typeof this.gitlab.listGitLabRepoLabels
  listGitLabRepoMRs: typeof this.gitlab.listGitLabRepoMRs
  listGitLabRepoTodos: typeof this.gitlab.listGitLabRepoTodos
  listGitLabRepoWorkItems: typeof this.gitlab.listGitLabRepoWorkItems
  mergeGitLabRepoMR: typeof this.gitlab.mergeGitLabRepoMR
  resolveGitLabRepoMRDiscussion: typeof this.gitlab.resolveGitLabRepoMRDiscussion
  retryGitLabRepoJob: typeof this.gitlab.retryGitLabRepoJob
  updateGitLabRepoIssue: typeof this.gitlab.updateGitLabRepoIssue
  updateGitLabRepoMR: typeof this.gitlab.updateGitLabRepoMR
  updateGitLabRepoMRReviewers: typeof this.gitlab.updateGitLabRepoMRReviewers
  updateGitLabRepoMRState: typeof this.gitlab.updateGitLabRepoMRState
  countRepoWorkItems: typeof this.hostedReview.countRepoWorkItems
  createHostedReview: typeof this.hostedReview.createHostedReview
  createStackedHostedReview: typeof this.hostedReview.createStackedHostedReview
  getGitHubRateLimit: typeof this.hostedReview.getGitHubRateLimit
  getHostedReviewCreationEligibility: typeof this.hostedReview.getHostedReviewCreationEligibility
  getHostedReviewForBranch: typeof this.hostedReview.getHostedReviewForBranch
  getRepoPRForBranch: typeof this.hostedReview.getRepoPRForBranch
  getRepoSlug: typeof this.hostedReview.getRepoSlug
  getRepoUpstream: typeof this.hostedReview.getRepoUpstream
  getRepoWorkItem: typeof this.hostedReview.getRepoWorkItem
  getRepoWorkItemByOwnerRepo: typeof this.hostedReview.getRepoWorkItemByOwnerRepo
  getRepoWorkItemDetails: typeof this.hostedReview.getRepoWorkItemDetails
  listRepoAssignableUsers: typeof this.hostedReview.listRepoAssignableUsers
  listRepoIssues: typeof this.hostedReview.listRepoIssues
  listRepoLabels: typeof this.hostedReview.listRepoLabels
  listRepoWorkItems: typeof this.hostedReview.listRepoWorkItems
  listDetectedManagedWorktrees: typeof this.managedWorktrees.listDetectedManagedWorktrees
  listManagedWorktrees: typeof this.managedWorktrees.listManagedWorktrees
  listRetiredWorktreeNames: typeof this.managedWorktrees.listRetiredWorktreeNames
  teardownMissingManagedWorktreeTerminals: typeof this.managedWorktrees.teardownMissingManagedWorktreeTerminals
  addRepoIssueComment: typeof this.prCheck.addRepoIssueComment
  addRepoPRReviewComment: typeof this.prCheck.addRepoPRReviewComment
  addRepoPRReviewCommentReply: typeof this.prCheck.addRepoPRReviewCommentReply
  createRepoIssue: typeof this.prCheck.createRepoIssue
  getRepoIssue: typeof this.prCheck.getRepoIssue
  getRepoPRCheckDetails: typeof this.prCheck.getRepoPRCheckDetails
  getRepoPRChecks: typeof this.prCheck.getRepoPRChecks
  getRepoPRComments: typeof this.prCheck.getRepoPRComments
  getRepoPRFileContents: typeof this.prCheck.getRepoPRFileContents
  markRepoPRReadyForReview: typeof this.prCheck.markRepoPRReadyForReview
  mergeRepoPR: typeof this.prCheck.mergeRepoPR
  removeRepoPRReviewers: typeof this.prCheck.removeRepoPRReviewers
  requestRepoPRReviewers: typeof this.prCheck.requestRepoPRReviewers
  rerunRepoPRChecks: typeof this.prCheck.rerunRepoPRChecks
  resolveRepoReviewThread: typeof this.prCheck.resolveRepoReviewThread
  setRepoPRAutoMerge: typeof this.prCheck.setRepoPRAutoMerge
  setRepoPRCommentReaction: typeof this.prCheck.setRepoPRCommentReaction
  setRepoPRFileViewed: typeof this.prCheck.setRepoPRFileViewed
  updateRepoIssue: typeof this.prCheck.updateRepoIssue
  updateRepoPRDetails: typeof this.prCheck.updateRepoPRDetails
  updateRepoPRState: typeof this.prCheck.updateRepoPRState
  updateRepoPRTitle: typeof this.prCheck.updateRepoPRTitle
  checkRepoHooks: typeof this.setupHook.checkRepoHooks
  getRepoHooks: typeof this.setupHook.getRepoHooks
  inspectRepoSetupScriptImports: typeof this.setupHook.inspectRepoSetupScriptImports
  readRepoIssueCommand: typeof this.setupHook.readRepoIssueCommand
  writeRepoIssueCommand: typeof this.setupHook.writeRepoIssueCommand

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.git = new RuntimeRepoGitCoreCommands(deps)
    this.hostedReview = new RuntimeRepoHostedReviewCommands(deps)
    this.gitlab = new RuntimeRepoGitLabCommands(deps)
    this.prCheck = new RuntimeRepoPRCheckCommands(deps)
    this.setupHook = new RuntimeRepoSetupHookCommands(deps)
    this.managedWorktrees = new RuntimeRepoManagedWorktreeCommands(deps)
    this.githubSlug = new RuntimeRepoGitHubSlugCommands(deps)
    this.teardownMissingManagedWorktreeTerminals =
      this.managedWorktrees.teardownMissingManagedWorktreeTerminals.bind(this.managedWorktrees)
    this.getHostedReviewCreationEligibility =
      this.hostedReview.getHostedReviewCreationEligibility.bind(this.hostedReview)
    this.getGitHubProjectWorkItemDetailsBySlug =
      this.githubSlug.getGitHubProjectWorkItemDetailsBySlug.bind(this.prCheck)
    this.listRetiredWorktreeNames = this.managedWorktrees.listRetiredWorktreeNames.bind(
      this.managedWorktrees
    )
    this.listDetectedManagedWorktrees = this.managedWorktrees.listDetectedManagedWorktrees.bind(
      this.managedWorktrees
    )
    this.showRepo = this.git.showRepo.bind(this.git)
    this.setRepoBaseRef = this.git.setRepoBaseRef.bind(this.git)
    this.updateRepo = this.git.updateRepo.bind(this.git)
    this.removeProject = this.git.removeProject.bind(this.git)
    this.inspectTerminalProcess = this.git.inspectTerminalProcess.bind(this.git)
    this.reorderRepos = this.git.reorderRepos.bind(this.git)
    this.searchRepoRefs = this.git.searchRepoRefs.bind(this.git)
    this.getRepoBaseRefDefault = this.git.getRepoBaseRefDefault.bind(this.git)
    this.getRepoSlug = this.hostedReview.getRepoSlug.bind(this.hostedReview)
    this.getRepoUpstream = this.hostedReview.getRepoUpstream.bind(this.hostedReview)
    this.listRepoWorkItems = this.hostedReview.listRepoWorkItems.bind(this.hostedReview)
    this.listRepoIssues = this.hostedReview.listRepoIssues.bind(this.hostedReview)
    this.getRepoWorkItem = this.hostedReview.getRepoWorkItem.bind(this.hostedReview)
    this.getRepoWorkItemByOwnerRepo = this.hostedReview.getRepoWorkItemByOwnerRepo.bind(
      this.hostedReview
    )
    this.getRepoWorkItemDetails = this.hostedReview.getRepoWorkItemDetails.bind(this.hostedReview)
    this.countRepoWorkItems = this.hostedReview.countRepoWorkItems.bind(this.hostedReview)
    this.listRepoLabels = this.hostedReview.listRepoLabels.bind(this.hostedReview)
    this.listRepoAssignableUsers = this.hostedReview.listRepoAssignableUsers.bind(this.hostedReview)
    this.getGitHubRateLimit = this.hostedReview.getGitHubRateLimit.bind(this.hostedReview)
    this.getRepoPRForBranch = this.hostedReview.getRepoPRForBranch.bind(this.hostedReview)
    this.getHostedReviewForBranch = this.hostedReview.getHostedReviewForBranch.bind(
      this.hostedReview
    )
    this.createHostedReview = this.hostedReview.createHostedReview.bind(this.hostedReview)
    this.createStackedHostedReview = this.hostedReview.createStackedHostedReview.bind(
      this.hostedReview
    )
    this.listGitLabRepoWorkItems = this.gitlab.listGitLabRepoWorkItems.bind(this.gitlab)
    this.listGitLabRepoMRs = this.gitlab.listGitLabRepoMRs.bind(this.gitlab)
    this.listGitLabRepoIssues = this.gitlab.listGitLabRepoIssues.bind(this.gitlab)
    this.listGitLabRepoTodos = this.gitlab.listGitLabRepoTodos.bind(this.gitlab)
    this.diagnoseGitLabAuth = this.gitlab.diagnoseGitLabAuth.bind(this.gitlab)
    this.getGitLabRateLimit = this.gitlab.getGitLabRateLimit.bind(this.gitlab)
    this.listGitLabRepoLabels = this.gitlab.listGitLabRepoLabels.bind(this.gitlab)
    this.createGitLabRepoIssue = this.gitlab.createGitLabRepoIssue.bind(this.gitlab)
    this.updateGitLabRepoIssue = this.gitlab.updateGitLabRepoIssue.bind(this.gitlab)
    this.addGitLabRepoIssueComment = this.gitlab.addGitLabRepoIssueComment.bind(this.gitlab)
    this.addGitLabRepoMRComment = this.gitlab.addGitLabRepoMRComment.bind(this.gitlab)
    this.addGitLabRepoMRInlineComment = this.gitlab.addGitLabRepoMRInlineComment.bind(this.gitlab)
    this.resolveGitLabRepoMRDiscussion = this.gitlab.resolveGitLabRepoMRDiscussion.bind(this.gitlab)
    this.getGitLabRepoJobTrace = this.gitlab.getGitLabRepoJobTrace.bind(this.gitlab)
    this.retryGitLabRepoJob = this.gitlab.retryGitLabRepoJob.bind(this.gitlab)
    this.mergeGitLabRepoMR = this.gitlab.mergeGitLabRepoMR.bind(this.gitlab)
    this.updateGitLabRepoMRState = this.gitlab.updateGitLabRepoMRState.bind(this.gitlab)
    this.updateGitLabRepoMR = this.gitlab.updateGitLabRepoMR.bind(this.gitlab)
    this.updateGitLabRepoMRReviewers = this.gitlab.updateGitLabRepoMRReviewers.bind(this.gitlab)
    this.getGitLabRepoWorkItemDetails = this.gitlab.getGitLabRepoWorkItemDetails.bind(this.gitlab)
    this.getGitLabRepoWorkItemByPath = this.gitlab.getGitLabRepoWorkItemByPath.bind(this.gitlab)
    this.getRepoIssue = this.prCheck.getRepoIssue.bind(this.prCheck)
    this.getRepoPRChecks = this.prCheck.getRepoPRChecks.bind(this.prCheck)
    this.rerunRepoPRChecks = this.prCheck.rerunRepoPRChecks.bind(this.prCheck)
    this.getRepoPRCheckDetails = this.prCheck.getRepoPRCheckDetails.bind(this.prCheck)
    this.getRepoPRComments = this.prCheck.getRepoPRComments.bind(this.prCheck)
    this.setRepoPRCommentReaction = this.prCheck.setRepoPRCommentReaction.bind(this.prCheck)
    this.getRepoPRFileContents = this.prCheck.getRepoPRFileContents.bind(this.prCheck)
    this.resolveRepoReviewThread = this.prCheck.resolveRepoReviewThread.bind(this.prCheck)
    this.setRepoPRFileViewed = this.prCheck.setRepoPRFileViewed.bind(this.prCheck)
    this.updateRepoPRTitle = this.prCheck.updateRepoPRTitle.bind(this.prCheck)
    this.updateRepoPRDetails = this.prCheck.updateRepoPRDetails.bind(this.prCheck)
    this.mergeRepoPR = this.prCheck.mergeRepoPR.bind(this.prCheck)
    this.setRepoPRAutoMerge = this.prCheck.setRepoPRAutoMerge.bind(this.prCheck)
    this.markRepoPRReadyForReview = this.prCheck.markRepoPRReadyForReview.bind(this.prCheck)
    this.updateRepoPRState = this.prCheck.updateRepoPRState.bind(this.prCheck)
    this.requestRepoPRReviewers = this.prCheck.requestRepoPRReviewers.bind(this.prCheck)
    this.removeRepoPRReviewers = this.prCheck.removeRepoPRReviewers.bind(this.prCheck)
    this.createRepoIssue = this.prCheck.createRepoIssue.bind(this.prCheck)
    this.updateRepoIssue = this.prCheck.updateRepoIssue.bind(this.prCheck)
    this.addRepoIssueComment = this.prCheck.addRepoIssueComment.bind(this.prCheck)
    this.addRepoPRReviewComment = this.prCheck.addRepoPRReviewComment.bind(this.prCheck)
    this.addRepoPRReviewCommentReply = this.prCheck.addRepoPRReviewCommentReply.bind(this.prCheck)
    this.listGitHubProjects = this.githubSlug.listGitHubProjects.bind(this.prCheck)
    this.listGitHubLabelsBySlug = this.githubSlug.listGitHubLabelsBySlug.bind(this.prCheck)
    this.listGitHubAssignableUsersBySlug = this.githubSlug.listGitHubAssignableUsersBySlug.bind(
      this.prCheck
    )
    this.listGitHubIssueTypesBySlug = this.githubSlug.listGitHubIssueTypesBySlug.bind(this.prCheck)
    this.resolveGitHubProjectRef = this.githubSlug.resolveGitHubProjectRef.bind(this.prCheck)
    this.listGitHubProjectViews = this.githubSlug.listGitHubProjectViews.bind(this.prCheck)
    this.getGitHubProjectViewTable = this.githubSlug.getGitHubProjectViewTable.bind(this.prCheck)
    this.updateGitHubProjectItemField = this.githubSlug.updateGitHubProjectItemField.bind(
      this.prCheck
    )
    this.clearGitHubProjectItemField = this.githubSlug.clearGitHubProjectItemField.bind(
      this.prCheck
    )
    this.updateGitHubIssueBySlug = this.githubSlug.updateGitHubIssueBySlug.bind(this.prCheck)
    this.updateGitHubPullRequestBySlug = this.githubSlug.updateGitHubPullRequestBySlug.bind(
      this.prCheck
    )
    this.updateGitHubIssueTypeBySlug = this.githubSlug.updateGitHubIssueTypeBySlug.bind(
      this.prCheck
    )
    this.addGitHubIssueCommentBySlug = this.githubSlug.addGitHubIssueCommentBySlug.bind(
      this.prCheck
    )
    this.updateGitHubIssueCommentBySlug = this.githubSlug.updateGitHubIssueCommentBySlug.bind(
      this.prCheck
    )
    this.deleteGitHubIssueCommentBySlug = this.githubSlug.deleteGitHubIssueCommentBySlug.bind(
      this.prCheck
    )
    this.getRepoHooks = this.setupHook.getRepoHooks.bind(this.setupHook)
    this.checkRepoHooks = this.setupHook.checkRepoHooks.bind(this.setupHook)
    this.inspectRepoSetupScriptImports = this.setupHook.inspectRepoSetupScriptImports.bind(
      this.setupHook
    )
    this.readRepoIssueCommand = this.setupHook.readRepoIssueCommand.bind(this.setupHook)
    this.writeRepoIssueCommand = this.setupHook.writeRepoIssueCommand.bind(this.setupHook)
    this.listManagedWorktrees = this.managedWorktrees.listManagedWorktrees.bind(
      this.managedWorktrees
    )
  }

  backfillForkUpstreams(): Promise<void> {
    return this.hostedReview.backfillForkUpstreams()
  }
}
