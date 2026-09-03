import type { GithubDetailHostProps } from '@/components/task-page/github/github-detail-host'
import type { GithubWorkItemTableProps } from '@/components/task-page/github/github-work-item-table'
import type { GitlabWorkItemListProps } from '@/components/task-page/gitlab/gitlab-work-item-list'
import type { JiraIssueListHostProps } from '@/components/task-page/jira/jira-issue-list-host'
import type { TaskPageSectionsProps } from './task-page-sections-props'

// Pure builders for the TaskPageLayout list/detail prop objects.
type ListDeps = Pick<
  TaskPageSectionsProps,
  | 'dialogWorkItem'
  | 'dialogInitialTab'
  | 'dialogRepoPath'
  | 'dialogSourceContext'
  | 'setDialogWorkItem'
  | 'handleUseWorkItem'
  | 'handleDialogReviewRequestsChange'
  | 'closeTaskDetailPage'
  | 'githubListScrollRef'
  | 'githubResumeContextKey'
  | 'currentPageRef'
  | 'pendingGithubScrollRestoreRef'
  | 'githubListScrollTopRef'
  | 'taskListPositionRef'
  | 'githubTaskGridClass'
  | 'activeGithubTaskKind'
  | 'showPRManagementColumns'
  | 'tasksError'
  | 'githubUnavailable'
  | 'failedCount'
  | 'selectedRepos'
  | 'perRepoSourceState'
  | 'handleRetryIssuesFetch'
  | 'tasksLoading'
  | 'retryingSourceKeys'
  | 'unresolvedSourceRepos'
  | 'showGitHubTaskSkeletons'
  | 'filteredWorkItems'
  | 'softHiddenVisibleCount'
  | 'totalPages'
  | 'githubEmptyState'
  | 'repoMap'
  | 'allWorktrees'
  | 'openGitHubDetailPage'
  | 'githubWorkItemMutation'
  | 'ensurePRChecksLoaded'
  | 'handleOpenOrUseGitHubWorkItem'
  | 'currentPage'
  | 'loadingTargetPage'
  | 'pages'
  | 'handleLoadNextPage'
  | 'setCurrentPage'
  | 'gitlabError'
  | 'gitlabLoading'
  | 'gitlabItems'
  | 'displayedGitLabItems'
  | 'gitlabEmptyState'
  | 'openGitLabDetailPage'
  | 'handleUseGitLabItem'
  | 'gitlabView'
  | 'gitlabIssuePage'
  | 'gitlabIssueTotalPages'
  | 'gitlabIssueLoadingTargetPage'
  | 'setGitlabIssueLoadingTargetPage'
  | 'setGitlabIssuePage'
  | 'jiraStatusReady'
  | 'jiraConnected'
  | 'setJiraConnectOpen'
  | 'hideTaskSource'
  | 'displayedJiraIssues'
  | 'jiraOrderDirection'
  | 'handleJiraSort'
  | 'jiraOrderBy'
  | 'jiraStatusCredentialError'
  | 'jiraError'
  | 'jiraErrorDetailsOpen'
  | 'setJiraErrorDetailsOpen'
  | 'jiraIssues'
  | 'jiraLoading'
  | 'jiraSearchInput'
  | 'sortedJiraIssues'
  | 'openJiraDetailPage'
  | 'handleUseJiraItem'
  | 'selectedJiraIssue'
  | 'selectedJiraSiteId'
  | 'displayedJiraStatusOrder'
  | 'jiraDetailSourceContext'
>

export function buildGithubDetail(deps: ListDeps): GithubDetailHostProps | null {
  return deps.dialogWorkItem
    ? {
        dialogWorkItem: deps.dialogWorkItem,
        dialogInitialTab: deps.dialogInitialTab,
        dialogRepoPath: deps.dialogRepoPath,
        dialogSourceContext: deps.dialogSourceContext,
        setDialogWorkItem: deps.setDialogWorkItem,
        handleUseWorkItem: deps.handleUseWorkItem,
        handleDialogReviewRequestsChange: deps.handleDialogReviewRequestsChange,
        closeTaskDetailPage: deps.closeTaskDetailPage
      }
    : null
}

export function buildGithubTable(deps: ListDeps): GithubWorkItemTableProps {
  return {
    githubListScrollRef: deps.githubListScrollRef,
    githubResumeContextKey: deps.githubResumeContextKey,
    currentPageRef: deps.currentPageRef,
    pendingGithubScrollRestoreRef: deps.pendingGithubScrollRestoreRef,
    githubListScrollTopRef: deps.githubListScrollTopRef,
    taskListPositionRef: deps.taskListPositionRef,
    githubTaskGridClass: deps.githubTaskGridClass,
    activeGithubTaskKind: deps.activeGithubTaskKind,
    showPRManagementColumns: deps.showPRManagementColumns,
    tasksError: deps.tasksError,
    githubUnavailable: deps.githubUnavailable,
    failedCount: deps.failedCount,
    selectedRepos: deps.selectedRepos,
    perRepoSourceState: deps.perRepoSourceState,
    handleRetryIssuesFetch: deps.handleRetryIssuesFetch,
    tasksLoading: deps.tasksLoading,
    retryingSourceKeys: deps.retryingSourceKeys,
    unresolvedSourceRepos: deps.unresolvedSourceRepos,
    showGitHubTaskSkeletons: deps.showGitHubTaskSkeletons,
    filteredWorkItems: deps.filteredWorkItems,
    softHiddenVisibleCount: deps.softHiddenVisibleCount,
    totalPages: deps.totalPages,
    githubEmptyState: deps.githubEmptyState,
    repoMap: deps.repoMap,
    allWorktrees: deps.allWorktrees,
    openGitHubDetailPage: deps.openGitHubDetailPage,
    githubWorkItemMutation: deps.githubWorkItemMutation,
    ensurePRChecksLoaded: deps.ensurePRChecksLoaded,
    handleOpenOrUseGitHubWorkItem: deps.handleOpenOrUseGitHubWorkItem,
    handleUseWorkItem: deps.handleUseWorkItem,
    currentPage: deps.currentPage,
    loadingTargetPage: deps.loadingTargetPage,
    pages: deps.pages,
    handleLoadNextPage: deps.handleLoadNextPage,
    setCurrentPage: deps.setCurrentPage
  }
}

export function buildGitlabList(deps: ListDeps): GitlabWorkItemListProps {
  return {
    gitlabError: deps.gitlabError,
    gitlabLoading: deps.gitlabLoading,
    gitlabItems: deps.gitlabItems,
    displayedGitLabItems: deps.displayedGitLabItems,
    gitlabEmptyState: deps.gitlabEmptyState,
    openGitLabDetailPage: deps.openGitLabDetailPage,
    handleUseGitLabItem: deps.handleUseGitLabItem,
    showGitlabIssuePagination: deps.gitlabView === 'issues' && deps.gitlabIssueTotalPages > 1,
    gitlabIssuePage: deps.gitlabIssuePage,
    gitlabIssueTotalPages: deps.gitlabIssueTotalPages,
    gitlabIssueLoadingTargetPage: deps.gitlabIssueLoadingTargetPage,
    onGitlabIssuePageChange: (page: number) => {
      if (page === deps.gitlabIssuePage) {
        return
      }
      deps.setGitlabIssueLoadingTargetPage(page)
      deps.setGitlabIssuePage(page)
    }
  }
}

export function buildJiraList(deps: ListDeps): JiraIssueListHostProps {
  return {
    jiraStatusReady: deps.jiraStatusReady,
    jiraConnected: deps.jiraConnected,
    setJiraConnectOpen: deps.setJiraConnectOpen,
    hideTaskSource: deps.hideTaskSource,
    displayedJiraIssues: deps.displayedJiraIssues,
    jiraOrderDirection: deps.jiraOrderDirection,
    handleJiraSort: deps.handleJiraSort,
    jiraOrderBy: deps.jiraOrderBy,
    jiraStatusCredentialError: deps.jiraStatusCredentialError,
    jiraError: deps.jiraError,
    jiraErrorDetailsOpen: deps.jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen: deps.setJiraErrorDetailsOpen,
    jiraLoading: deps.jiraLoading,
    jiraIssues: deps.jiraIssues,
    jiraSearchInput: deps.jiraSearchInput,
    sortedJiraIssues: deps.sortedJiraIssues,
    openJiraDetailPage: deps.openJiraDetailPage,
    handleUseJiraItem: deps.handleUseJiraItem,
    selectedJiraIssue: deps.selectedJiraIssue,
    selectedJiraSiteId: deps.selectedJiraSiteId,
    displayedJiraStatusOrder: deps.displayedJiraStatusOrder,
    closeTaskDetailPage: deps.closeTaskDetailPage,
    jiraDetailSourceContext: deps.jiraDetailSourceContext
  }
}
