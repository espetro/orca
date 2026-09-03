import type { NewGithubIssueDialogProps } from '@/components/task-page/dialogs/new-github-issue-dialog'
import type { NewJiraIssueDialogProps } from '@/components/task-page/dialogs/new-jira-issue-dialog'
import type { NewLinearIssueDialogProps } from '@/components/task-page/dialogs/new-linear-issue-dialog'
import type { NewLinearProjectDialogProps } from '@/components/task-page/dialogs/new-linear-project-dialog'
import type { TaskPageConnectDialogsProps } from '@/components/task-page/dialogs/task-page-connect-dialogs'
import type { TaskPageSectionsProps } from './task-page-sections-props'

type DialogsDeps = Pick<
  TaskPageSectionsProps,
  | 'submitShortcutLabel'
  | 'newIssueOpen'
  | 'newIssueSubmitting'
  | 'setNewIssueOpen'
  | 'handleCreateNewIssue'
  | 'newIssueTargetRepo'
  | 'perRepoSourceState'
  | 'setIssueSourcePreference'
  | 'selectedRepos'
  | 'newIssueRepoId'
  | 'setNewIssueRepoId'
  | 'setNewIssueLabels'
  | 'setNewIssueAssignees'
  | 'newIssueTitle'
  | 'setNewIssueTitle'
  | 'newIssueBody'
  | 'setNewIssueBody'
  | 'newIssueRepoLabels'
  | 'newIssueLabels'
  | 'newIssueRepoAssignees'
  | 'newIssueAssignees'
  | 'newLinearProjectOpen'
  | 'newLinearProjectSubmitting'
  | 'setNewLinearProjectOpen'
  | 'handleCreateNewLinearProject'
  | 'availableTeams'
  | 'newLinearProjectTargetTeam'
  | 'setNewLinearProjectTeamId'
  | 'newLinearProjectName'
  | 'setNewLinearProjectName'
  | 'newLinearProjectDescription'
  | 'setNewLinearProjectDescription'
  | 'newLinearProjectContent'
  | 'setNewLinearProjectContent'
  | 'newLinearProjectPriority'
  | 'setNewLinearProjectPriority'
  | 'newLinearProjectMembers'
  | 'newLinearProjectLeadId'
  | 'setNewLinearProjectLeadId'
  | 'newLinearProjectMemberIds'
  | 'setNewLinearProjectMemberIds'
  | 'newLinearProjectLabelIds'
  | 'setNewLinearProjectLabelIds'
  | 'newLinearProjectLabels'
  | 'newLinearProjectStartDate'
  | 'setNewLinearProjectStartDate'
  | 'newLinearProjectTargetDate'
  | 'setNewLinearProjectTargetDate'
  | 'newLinearIssueOpen'
  | 'newLinearIssueSubmitting'
  | 'setNewLinearIssueOpen'
  | 'handleCreateNewLinearIssue'
  | 'newLinearIssueTargetTeam'
  | 'newLinearIssueTeamId'
  | 'setNewLinearIssueTeamId'
  | 'newLinearIssueTitle'
  | 'setNewLinearIssueTitle'
  | 'newLinearIssueBody'
  | 'setNewLinearIssueBody'
  | 'newLinearStates'
  | 'newLinearIssueStateId'
  | 'setNewLinearIssueStateId'
  | 'newLinearMembers'
  | 'newLinearIssueAssigneeId'
  | 'setNewLinearIssueAssigneeId'
  | 'newLinearIssuePriority'
  | 'setNewLinearIssuePriority'
  | 'newLinearIssueProjects'
  | 'newLinearIssueProjectId'
  | 'setNewLinearIssueProjectId'
  | 'newLinearIssueProjectsLoading'
  | 'newLinearIssueLabelIds'
  | 'setNewLinearIssueLabelIds'
  | 'newLinearLabels'
  | 'newJiraIssueOpen'
  | 'newJiraIssueSubmitting'
  | 'setNewJiraIssueOpen'
  | 'handleCreateNewJiraIssue'
  | 'newJiraIssueTargetProject'
  | 'newJiraIssueProjectComboboxOpen'
  | 'handleNewJiraIssueProjectComboboxOpenChange'
  | 'handleNewJiraIssueProjectTriggerKeyDown'
  | 'sortedAvailableJiraProjects'
  | 'includeJiraSiteNameInProjectLabel'
  | 'newJiraIssueProjectCommandValue'
  | 'setNewJiraIssueProjectCommandValue'
  | 'newJiraIssueProjectSearchInputRef'
  | 'newJiraIssueProjectQuery'
  | 'newJiraIssueTitle'
  | 'newJiraIssueBody'
  | 'setNewJiraIssueBody'
  | 'setNewJiraIssueTitle'
  | 'setNewJiraIssueProjectQuery'
  | 'filteredNewJiraIssueProjects'
  | 'newJiraIssueTargetProjectSelectionKey'
  | 'handleNewJiraIssueProjectSelect'
  | 'newJiraIssueTypeId'
  | 'newJiraIssueTargetType'
  | 'setNewJiraIssueTypeId'
  | 'jiraIssueTypesLoading'
  | 'availableJiraIssueTypes'
  | 'jiraCreateFieldsLoading'
  | 'jiraCreateFieldsError'
  | 'visibleJiraCreateFields'
  | 'newJiraIssueCustomFieldValues'
  | 'setNewJiraIssueCustomFieldValues'
  | 'hasMissingJiraCreateField'
  | 'gitlabDialogItem'
  | 'gitlabDialogRepo'
  | 'gitlabDialogSourceContext'
  | 'setGitlabDialogItem'
  | 'handleUseGitLabItem'
  | 'linearConnectOpen'
  | 'setLinearConnectOpen'
  | 'selectedLinearWorkspace'
  | 'handleLinearAccessConnected'
  | 'jiraConnectOpen'
  | 'setJiraConnectOpen'
>

export function buildNewGithubIssue(deps: DialogsDeps): NewGithubIssueDialogProps {
  return {
    newIssueOpen: deps.newIssueOpen,
    newIssueSubmitting: deps.newIssueSubmitting,
    setNewIssueOpen: deps.setNewIssueOpen,
    handleCreateNewIssue: deps.handleCreateNewIssue,
    newIssueTargetRepo: deps.newIssueTargetRepo,
    perRepoSourceState: deps.perRepoSourceState,
    setIssueSourcePreference: deps.setIssueSourcePreference,
    selectedRepos: deps.selectedRepos,
    newIssueRepoId: deps.newIssueRepoId,
    setNewIssueRepoId: deps.setNewIssueRepoId,
    setNewIssueLabels: deps.setNewIssueLabels,
    setNewIssueAssignees: deps.setNewIssueAssignees,
    newIssueTitle: deps.newIssueTitle,
    setNewIssueTitle: deps.setNewIssueTitle,
    newIssueBody: deps.newIssueBody,
    setNewIssueBody: deps.setNewIssueBody,
    newIssueRepoLabels: deps.newIssueRepoLabels,
    newIssueLabels: deps.newIssueLabels,
    newIssueRepoAssignees: deps.newIssueRepoAssignees,
    newIssueAssignees: deps.newIssueAssignees,
    submitShortcutLabel: deps.submitShortcutLabel
  }
}

export function buildNewLinearProject(deps: DialogsDeps): NewLinearProjectDialogProps {
  return {
    newLinearProjectOpen: deps.newLinearProjectOpen,
    newLinearProjectSubmitting: deps.newLinearProjectSubmitting,
    setNewLinearProjectOpen: deps.setNewLinearProjectOpen,
    handleCreateNewLinearProject: deps.handleCreateNewLinearProject,
    availableTeams: deps.availableTeams,
    newLinearProjectTargetTeam: deps.newLinearProjectTargetTeam,
    setNewLinearProjectTeamId: deps.setNewLinearProjectTeamId,
    newLinearProjectName: deps.newLinearProjectName,
    setNewLinearProjectName: deps.setNewLinearProjectName,
    newLinearProjectDescription: deps.newLinearProjectDescription,
    setNewLinearProjectDescription: deps.setNewLinearProjectDescription,
    newLinearProjectContent: deps.newLinearProjectContent,
    setNewLinearProjectContent: deps.setNewLinearProjectContent,
    submitShortcutLabel: deps.submitShortcutLabel,
    newLinearProjectPriority: deps.newLinearProjectPriority,
    setNewLinearProjectPriority: deps.setNewLinearProjectPriority,
    newLinearProjectMembers: deps.newLinearProjectMembers,
    newLinearProjectLeadId: deps.newLinearProjectLeadId,
    setNewLinearProjectLeadId: deps.setNewLinearProjectLeadId,
    newLinearProjectMemberIds: deps.newLinearProjectMemberIds,
    setNewLinearProjectMemberIds: deps.setNewLinearProjectMemberIds,
    newLinearProjectLabelIds: deps.newLinearProjectLabelIds,
    setNewLinearProjectLabelIds: deps.setNewLinearProjectLabelIds,
    newLinearProjectLabels: deps.newLinearProjectLabels,
    newLinearProjectStartDate: deps.newLinearProjectStartDate,
    setNewLinearProjectStartDate: deps.setNewLinearProjectStartDate,
    newLinearProjectTargetDate: deps.newLinearProjectTargetDate,
    setNewLinearProjectTargetDate: deps.setNewLinearProjectTargetDate
  }
}

export function buildNewLinearIssue(deps: DialogsDeps): NewLinearIssueDialogProps {
  return {
    newLinearIssueOpen: deps.newLinearIssueOpen,
    newLinearIssueSubmitting: deps.newLinearIssueSubmitting,
    setNewLinearIssueOpen: deps.setNewLinearIssueOpen,
    handleCreateNewLinearIssue: deps.handleCreateNewLinearIssue,
    availableTeams: deps.availableTeams,
    newLinearIssueTargetTeam: deps.newLinearIssueTargetTeam,
    newLinearIssueTeamId: deps.newLinearIssueTeamId,
    setNewLinearIssueTeamId: deps.setNewLinearIssueTeamId,
    newLinearIssueTitle: deps.newLinearIssueTitle,
    setNewLinearIssueTitle: deps.setNewLinearIssueTitle,
    newLinearIssueBody: deps.newLinearIssueBody,
    setNewLinearIssueBody: deps.setNewLinearIssueBody,
    submitShortcutLabel: deps.submitShortcutLabel,
    newLinearStates: deps.newLinearStates,
    newLinearIssueStateId: deps.newLinearIssueStateId,
    setNewLinearIssueStateId: deps.setNewLinearIssueStateId,
    newLinearMembers: deps.newLinearMembers,
    newLinearIssueAssigneeId: deps.newLinearIssueAssigneeId,
    setNewLinearIssueAssigneeId: deps.setNewLinearIssueAssigneeId,
    newLinearIssuePriority: deps.newLinearIssuePriority,
    setNewLinearIssuePriority: deps.setNewLinearIssuePriority,
    newLinearIssueProjects: deps.newLinearIssueProjects,
    newLinearIssueProjectId: deps.newLinearIssueProjectId,
    setNewLinearIssueProjectId: deps.setNewLinearIssueProjectId,
    newLinearIssueProjectsLoading: deps.newLinearIssueProjectsLoading,
    newLinearIssueLabelIds: deps.newLinearIssueLabelIds,
    setNewLinearIssueLabelIds: deps.setNewLinearIssueLabelIds,
    newLinearLabels: deps.newLinearLabels
  }
}

export function buildNewJiraIssue(deps: DialogsDeps): NewJiraIssueDialogProps {
  return {
    newJiraIssueOpen: deps.newJiraIssueOpen,
    newJiraIssueSubmitting: deps.newJiraIssueSubmitting,
    setNewJiraIssueOpen: deps.setNewJiraIssueOpen,
    handleCreateNewJiraIssue: deps.handleCreateNewJiraIssue,
    newJiraIssueTargetProject: deps.newJiraIssueTargetProject,
    newJiraIssueProjectComboboxOpen: deps.newJiraIssueProjectComboboxOpen,
    handleNewJiraIssueProjectComboboxOpenChange: deps.handleNewJiraIssueProjectComboboxOpenChange,
    handleNewJiraIssueProjectTriggerKeyDown: deps.handleNewJiraIssueProjectTriggerKeyDown,
    sortedAvailableJiraProjects: deps.sortedAvailableJiraProjects,
    includeJiraSiteNameInProjectLabel: deps.includeJiraSiteNameInProjectLabel,
    newJiraIssueProjectCommandValue: deps.newJiraIssueProjectCommandValue,
    setNewJiraIssueProjectCommandValue: deps.setNewJiraIssueProjectCommandValue,
    newJiraIssueProjectSearchInputRef: deps.newJiraIssueProjectSearchInputRef,
    newJiraIssueProjectQuery: deps.newJiraIssueProjectQuery,
    setNewJiraIssueProjectQuery: deps.setNewJiraIssueProjectQuery,
    filteredNewJiraIssueProjects: deps.filteredNewJiraIssueProjects,
    newJiraIssueTargetProjectSelectionKey: deps.newJiraIssueTargetProjectSelectionKey,
    handleNewJiraIssueProjectSelect: deps.handleNewJiraIssueProjectSelect,
    newJiraIssueTypeId: deps.newJiraIssueTypeId,
    newJiraIssueTargetType: deps.newJiraIssueTargetType,
    setNewJiraIssueTypeId: deps.setNewJiraIssueTypeId,
    jiraIssueTypesLoading: deps.jiraIssueTypesLoading,
    availableJiraIssueTypes: deps.availableJiraIssueTypes,
    newJiraIssueTitle: deps.newJiraIssueTitle,
    setNewJiraIssueTitle: deps.setNewJiraIssueTitle,
    newJiraIssueBody: deps.newJiraIssueBody,
    setNewJiraIssueBody: deps.setNewJiraIssueBody,
    jiraCreateFieldsLoading: deps.jiraCreateFieldsLoading,
    jiraCreateFieldsError: deps.jiraCreateFieldsError,
    visibleJiraCreateFields: deps.visibleJiraCreateFields,
    newJiraIssueCustomFieldValues: deps.newJiraIssueCustomFieldValues,
    setNewJiraIssueCustomFieldValues: deps.setNewJiraIssueCustomFieldValues,
    submitShortcutLabel: deps.submitShortcutLabel,
    hasMissingJiraCreateField: deps.hasMissingJiraCreateField
  }
}

export function buildConnectDialogs(deps: DialogsDeps): TaskPageConnectDialogsProps {
  return {
    gitlabDialogItem: deps.gitlabDialogItem,
    gitlabDialogRepo: deps.gitlabDialogRepo,
    gitlabDialogSourceContext: deps.gitlabDialogSourceContext,
    setGitlabDialogItem: deps.setGitlabDialogItem,
    handleUseGitLabItem: deps.handleUseGitLabItem,
    linearConnectOpen: deps.linearConnectOpen,
    setLinearConnectOpen: deps.setLinearConnectOpen,
    selectedLinearWorkspace: deps.selectedLinearWorkspace,
    handleLinearAccessConnected: deps.handleLinearAccessConnected,
    jiraConnectOpen: deps.jiraConnectOpen,
    setJiraConnectOpen: deps.setJiraConnectOpen
  }
}
