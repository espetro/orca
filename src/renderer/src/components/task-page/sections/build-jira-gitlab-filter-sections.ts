import type { TaskPageJiraFiltersProps } from '@/components/task-page/chrome/task-page-jira-filters'
import type { TaskPageGitlabFiltersProps } from '@/components/task-page/chrome/task-page-gitlab-filters'
import type { TaskPageSectionsProps } from './task-page-sections-props'

type FilterChromeDeps = Pick<
  TaskPageSectionsProps,
  | 'jiraPresets'
  | 'jiraSearchInput'
  | 'activeJiraPreset'
  | 'setJiraSearchInput'
  | 'setAppliedJiraSearch'
  | 'setActiveJiraPreset'
  | 'setTaskResumeState'
  | 'setJiraRefreshNonce'
  | 'sortedAvailableJiraProjects'
  | 'setNewJiraIssueTitle'
  | 'setNewJiraIssueBody'
  | 'setNewJiraIssueProjectId'
  | 'setNewJiraIssueProjectQuery'
  | 'setNewJiraIssueProjectCommandValue'
  | 'setNewJiraIssueTypeId'
  | 'setNewJiraIssueOpen'
  | 'jiraProjectsLoading'
  | 'jiraLoading'
  | 'gitlabView'
  | 'setGitlabView'
  | 'taskPickerGroups'
  | 'repoSelection'
  | 'getTaskPickerRepoHostLabel'
  | 'eligibleRepos'
  | 'setRepoSelection'
  | 'updateSettings'
  | 'taskPickerRepos'
  | 'gitLabIssueFilters'
  | 'gitLabMRFilters'
  | 'activeGitlabFilter'
  | 'setGitlabFilter'
  | 'setGitlabRefreshNonce'
  | 'gitlabLoading'
  | 'gitlabTodosLoading'
>

export function buildJiraFilters(deps: FilterChromeDeps): TaskPageJiraFiltersProps {
  return {
    jiraPresets: deps.jiraPresets,
    jiraSearchInput: deps.jiraSearchInput,
    activeJiraPreset: deps.activeJiraPreset,
    setJiraSearchInput: deps.setJiraSearchInput,
    setAppliedJiraSearch: deps.setAppliedJiraSearch,
    setActiveJiraPreset: deps.setActiveJiraPreset,
    setTaskResumeState: deps.setTaskResumeState,
    setJiraRefreshNonce: deps.setJiraRefreshNonce,
    sortedAvailableJiraProjects: deps.sortedAvailableJiraProjects,
    setNewJiraIssueTitle: deps.setNewJiraIssueTitle,
    setNewJiraIssueBody: deps.setNewJiraIssueBody,
    setNewJiraIssueProjectId: deps.setNewJiraIssueProjectId,
    setNewJiraIssueProjectQuery: deps.setNewJiraIssueProjectQuery,
    setNewJiraIssueProjectCommandValue: deps.setNewJiraIssueProjectCommandValue,
    setNewJiraIssueTypeId: deps.setNewJiraIssueTypeId,
    setNewJiraIssueOpen: deps.setNewJiraIssueOpen,
    jiraProjectsLoading: deps.jiraProjectsLoading,
    jiraLoading: deps.jiraLoading
  }
}

export function buildGitlabFilters(deps: FilterChromeDeps): TaskPageGitlabFiltersProps {
  return {
    gitlabView: deps.gitlabView,
    setGitlabView: deps.setGitlabView,
    taskPickerGroups: deps.taskPickerGroups,
    repoSelection: deps.repoSelection,
    getTaskPickerRepoHostLabel: deps.getTaskPickerRepoHostLabel,
    eligibleRepos: deps.eligibleRepos,
    setRepoSelection: deps.setRepoSelection,
    updateSettings: deps.updateSettings,
    taskPickerRepos: deps.taskPickerRepos,
    gitLabIssueFilters: deps.gitLabIssueFilters,
    gitLabMRFilters: deps.gitLabMRFilters,
    activeGitlabFilter: deps.activeGitlabFilter,
    setGitlabFilter: deps.setGitlabFilter,
    setGitlabRefreshNonce: deps.setGitlabRefreshNonce,
    gitlabLoading: deps.gitlabLoading,
    gitlabTodosLoading: deps.gitlabTodosLoading
  }
}
