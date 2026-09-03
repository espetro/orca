import { RuntimeRepoGitCoreCommands } from './runtime-repo-git-core-commands'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'
import { RuntimeRepoHostedReviewCommands } from './runtime-repo-hosted-review-commands'
import { RuntimeRepoGitLabCommands } from './runtime-repo-gitlab-commands'
import { RuntimeRepoPRCheckCommands } from './runtime-repo-pr-check-commands'
import { RuntimeRepoSetupHookCommands } from './runtime-repo-setup-hook-commands'
import { RuntimeRepoManagedWorktreeCommands } from './runtime-repo-managed-worktree-commands'

export class RuntimeRepoGitCommandsFacade {
  private readonly git: RuntimeRepoGitCoreCommands
  private readonly hostedReview: RuntimeRepoHostedReviewCommands
  private readonly gitlab: RuntimeRepoGitLabCommands
  private readonly prCheck: RuntimeRepoPRCheckCommands
  private readonly setupHook: RuntimeRepoSetupHookCommands
  private readonly managedWorktrees: RuntimeRepoManagedWorktreeCommands

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.git = new RuntimeRepoGitCoreCommands(deps)
    this.hostedReview = new RuntimeRepoHostedReviewCommands(deps)
    this.gitlab = new RuntimeRepoGitLabCommands(deps)
    this.prCheck = new RuntimeRepoPRCheckCommands(deps)
    this.setupHook = new RuntimeRepoSetupHookCommands(deps)
    this.managedWorktrees = new RuntimeRepoManagedWorktreeCommands(deps)
  }

  showRepo = this.git.showRepo.bind(this.git)
  setRepoBaseRef = this.git.setRepoBaseRef.bind(this.git)
  updateRepo = this.git.updateRepo.bind(this.git)
  removeProject = this.git.removeProject.bind(this.git)
  inspectTerminalProcess = this.git.inspectTerminalProcess.bind(this.git)
  reorderRepos = this.git.reorderRepos.bind(this.git)
  searchRepoRefs = this.git.searchRepoRefs.bind(this.git)
  getRepoBaseRefDefault = this.git.getRepoBaseRefDefault.bind(this.git)
  getRepoSlug = this.hostedReview.getRepoSlug.bind(this.hostedReview)
  getRepoUpstream = this.hostedReview.getRepoUpstream.bind(this.hostedReview)
  listRepoWorkItems = this.hostedReview.listRepoWorkItems.bind(this.hostedReview)
  listRepoIssues = this.hostedReview.listRepoIssues.bind(this.hostedReview)
  getRepoWorkItem = this.hostedReview.getRepoWorkItem.bind(this.hostedReview)
  getRepoWorkItemByOwnerRepo = this.hostedReview.getRepoWorkItemByOwnerRepo.bind(this.hostedReview)
  getRepoWorkItemDetails = this.hostedReview.getRepoWorkItemDetails.bind(this.hostedReview)
  countRepoWorkItems = this.hostedReview.countRepoWorkItems.bind(this.hostedReview)
  listRepoLabels = this.hostedReview.listRepoLabels.bind(this.hostedReview)
  listRepoAssignableUsers = this.hostedReview.listRepoAssignableUsers.bind(this.hostedReview)
  getGitHubRateLimit = this.hostedReview.getGitHubRateLimit.bind(this.hostedReview)
  getRepoPRForBranch = this.hostedReview.getRepoPRForBranch.bind(this.hostedReview)
  getHostedReviewForBranch = this.hostedReview.getHostedReviewForBranch.bind(this.hostedReview)
  getHostedReviewCreationEligibility = this.hostedReview.getHostedReviewCreationEligibility.bind(
    this.hostedReview
  )
  createHostedReview = this.hostedReview.createHostedReview.bind(this.hostedReview)
  createStackedHostedReview = this.hostedReview.createStackedHostedReview.bind(this.hostedReview)
  listGitLabRepoWorkItems = this.gitlab.listGitLabRepoWorkItems.bind(this.gitlab)
  listGitLabRepoMRs = this.gitlab.listGitLabRepoMRs.bind(this.gitlab)
  listGitLabRepoIssues = this.gitlab.listGitLabRepoIssues.bind(this.gitlab)
  listGitLabRepoTodos = this.gitlab.listGitLabRepoTodos.bind(this.gitlab)
  diagnoseGitLabAuth = this.gitlab.diagnoseGitLabAuth.bind(this.gitlab)
  getGitLabRateLimit = this.gitlab.getGitLabRateLimit.bind(this.gitlab)
  listGitLabRepoLabels = this.gitlab.listGitLabRepoLabels.bind(this.gitlab)
  createGitLabRepoIssue = this.gitlab.createGitLabRepoIssue.bind(this.gitlab)
  updateGitLabRepoIssue = this.gitlab.updateGitLabRepoIssue.bind(this.gitlab)
  addGitLabRepoIssueComment = this.gitlab.addGitLabRepoIssueComment.bind(this.gitlab)
  addGitLabRepoMRComment = this.gitlab.addGitLabRepoMRComment.bind(this.gitlab)
  addGitLabRepoMRInlineComment = this.gitlab.addGitLabRepoMRInlineComment.bind(this.gitlab)
  resolveGitLabRepoMRDiscussion = this.gitlab.resolveGitLabRepoMRDiscussion.bind(this.gitlab)
  getGitLabRepoJobTrace = this.gitlab.getGitLabRepoJobTrace.bind(this.gitlab)
  retryGitLabRepoJob = this.gitlab.retryGitLabRepoJob.bind(this.gitlab)
  mergeGitLabRepoMR = this.gitlab.mergeGitLabRepoMR.bind(this.gitlab)
  updateGitLabRepoMRState = this.gitlab.updateGitLabRepoMRState.bind(this.gitlab)
  updateGitLabRepoMR = this.gitlab.updateGitLabRepoMR.bind(this.gitlab)
  updateGitLabRepoMRReviewers = this.gitlab.updateGitLabRepoMRReviewers.bind(this.gitlab)
  getGitLabRepoWorkItemDetails = this.gitlab.getGitLabRepoWorkItemDetails.bind(this.gitlab)
  getGitLabRepoWorkItemByPath = this.gitlab.getGitLabRepoWorkItemByPath.bind(this.gitlab)
  getRepoIssue = this.prCheck.getRepoIssue.bind(this.prCheck)
  getRepoPRChecks = this.prCheck.getRepoPRChecks.bind(this.prCheck)
  rerunRepoPRChecks = this.prCheck.rerunRepoPRChecks.bind(this.prCheck)
  getRepoPRCheckDetails = this.prCheck.getRepoPRCheckDetails.bind(this.prCheck)
  getRepoPRComments = this.prCheck.getRepoPRComments.bind(this.prCheck)
  setRepoPRCommentReaction = this.prCheck.setRepoPRCommentReaction.bind(this.prCheck)
  getRepoPRFileContents = this.prCheck.getRepoPRFileContents.bind(this.prCheck)
  resolveRepoReviewThread = this.prCheck.resolveRepoReviewThread.bind(this.prCheck)
  setRepoPRFileViewed = this.prCheck.setRepoPRFileViewed.bind(this.prCheck)
  updateRepoPRTitle = this.prCheck.updateRepoPRTitle.bind(this.prCheck)
  updateRepoPRDetails = this.prCheck.updateRepoPRDetails.bind(this.prCheck)
  mergeRepoPR = this.prCheck.mergeRepoPR.bind(this.prCheck)
  setRepoPRAutoMerge = this.prCheck.setRepoPRAutoMerge.bind(this.prCheck)
  markRepoPRReadyForReview = this.prCheck.markRepoPRReadyForReview.bind(this.prCheck)
  updateRepoPRState = this.prCheck.updateRepoPRState.bind(this.prCheck)
  requestRepoPRReviewers = this.prCheck.requestRepoPRReviewers.bind(this.prCheck)
  removeRepoPRReviewers = this.prCheck.removeRepoPRReviewers.bind(this.prCheck)
  createRepoIssue = this.prCheck.createRepoIssue.bind(this.prCheck)
  updateRepoIssue = this.prCheck.updateRepoIssue.bind(this.prCheck)
  addRepoIssueComment = this.prCheck.addRepoIssueComment.bind(this.prCheck)
  addRepoPRReviewComment = this.prCheck.addRepoPRReviewComment.bind(this.prCheck)
  addRepoPRReviewCommentReply = this.prCheck.addRepoPRReviewCommentReply.bind(this.prCheck)
  listGitHubProjects = this.prCheck.listGitHubProjects.bind(this.prCheck)
  listGitHubLabelsBySlug = this.prCheck.listGitHubLabelsBySlug.bind(this.prCheck)
  listGitHubAssignableUsersBySlug = this.prCheck.listGitHubAssignableUsersBySlug.bind(this.prCheck)
  listGitHubIssueTypesBySlug = this.prCheck.listGitHubIssueTypesBySlug.bind(this.prCheck)
  resolveGitHubProjectRef = this.prCheck.resolveGitHubProjectRef.bind(this.prCheck)
  listGitHubProjectViews = this.prCheck.listGitHubProjectViews.bind(this.prCheck)
  getGitHubProjectViewTable = this.prCheck.getGitHubProjectViewTable.bind(this.prCheck)
  getGitHubProjectWorkItemDetailsBySlug = this.prCheck.getGitHubProjectWorkItemDetailsBySlug.bind(
    this.prCheck
  )
  updateGitHubProjectItemField = this.prCheck.updateGitHubProjectItemField.bind(this.prCheck)
  clearGitHubProjectItemField = this.prCheck.clearGitHubProjectItemField.bind(this.prCheck)
  updateGitHubIssueBySlug = this.prCheck.updateGitHubIssueBySlug.bind(this.prCheck)
  updateGitHubPullRequestBySlug = this.prCheck.updateGitHubPullRequestBySlug.bind(this.prCheck)
  updateGitHubIssueTypeBySlug = this.prCheck.updateGitHubIssueTypeBySlug.bind(this.prCheck)
  addGitHubIssueCommentBySlug = this.prCheck.addGitHubIssueCommentBySlug.bind(this.prCheck)
  updateGitHubIssueCommentBySlug = this.prCheck.updateGitHubIssueCommentBySlug.bind(this.prCheck)
  deleteGitHubIssueCommentBySlug = this.prCheck.deleteGitHubIssueCommentBySlug.bind(this.prCheck)
  getRepoHooks = this.setupHook.getRepoHooks.bind(this.setupHook)
  checkRepoHooks = this.setupHook.checkRepoHooks.bind(this.setupHook)
  inspectRepoSetupScriptImports = this.setupHook.inspectRepoSetupScriptImports.bind(this.setupHook)
  readRepoIssueCommand = this.setupHook.readRepoIssueCommand.bind(this.setupHook)
  writeRepoIssueCommand = this.setupHook.writeRepoIssueCommand.bind(this.setupHook)
  listManagedWorktrees = this.managedWorktrees.listManagedWorktrees.bind(this.managedWorktrees)
  listRetiredWorktreeNames = this.managedWorktrees.listRetiredWorktreeNames.bind(
    this.managedWorktrees
  )
  listDetectedManagedWorktrees = this.managedWorktrees.listDetectedManagedWorktrees.bind(
    this.managedWorktrees
  )
  teardownMissingManagedWorktreeTerminals =
    this.managedWorktrees.teardownMissingManagedWorktreeTerminals.bind(this.managedWorktrees)
}
