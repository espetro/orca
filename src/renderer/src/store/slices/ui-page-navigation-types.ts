import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { TaskProvider } from '../../../../shared/task-providers'
import type { TaskResumeState, TopLevelView } from '../../../../shared/ui-chrome-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'

export type TaskPageData = {
  preselectedRepoId?: string
  prefilledName?: string
  taskSource?: TaskProvider
  openGitHubWorkItem?: GitHubWorkItem
  openGitHubSourceContext?: TaskSourceContext | null
  openGitHubInitialTab?: 'conversation' | 'checks' | 'files'
  openGitLabWorkItem?: GitLabWorkItem
  openGitLabSourceContext?: TaskSourceContext | null
  openLinearIssue?: LinearIssue
  openLinearSourceContext?: TaskSourceContext | null
  openJiraIssue?: JiraIssue
  openJiraSourceContext?: TaskSourceContext | null
}

export type UIPageNavigationSlice = {
  activeView: TopLevelView
  previousViewBeforeTasks:
    | 'terminal'
    | 'settings'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'artifacts'
    | 'mobile'
  previousViewBeforeSettings:
    | 'terminal'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'artifacts'
    | 'mobile'
  previousViewBeforeActivity:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'automations'
    | 'space'
    | 'skills'
    | 'artifacts'
    | 'mobile'
  previousViewBeforeAutomations:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'space'
    | 'skills'
    | 'artifacts'
    | 'mobile'
  previousViewBeforeSpace:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'skills'
    | 'artifacts'
    | 'mobile'
  previousViewBeforeSkills:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'artifacts'
    | 'mobile'
  previousViewBeforeMobile:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'artifacts'
  previousViewBeforeArtifacts:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'mobile'
  setActiveView: (view: UIPageNavigationSlice['activeView']) => void
  taskPageData: TaskPageData
  taskResumeState: TaskResumeState | undefined
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  taskListPosition: { contextKey: string; page: number; scrollTop: number } | null
  setTaskListPosition: (position: UIPageNavigationSlice['taskListPosition']) => void
  githubTaskDrawerWorkItem: GitHubWorkItem | null
  setGithubTaskDrawerWorkItem: (item: GitHubWorkItem | null) => void
  newWorkspaceDraft: {
    repoId: string | null
    // Why: project-first creation uses these when present; old drafts keep using only repoId during the additive migration.
    projectId?: string | null
    projectGroupId?: string | null
    hostId?: ExecutionHostId | null
    projectHostSetupId?: string | null
    name: string
    prompt: string
    note: string
    attachments: string[]
    linkedWorkItem: {
      provider?: 'github' | 'gitlab' | 'linear' | 'jira'
      type: 'issue' | 'pr' | 'mr'
      number: number
      title: string
      url: string
      linearIdentifier?: string
      linearBranchName?: string
      jiraIdentifier?: string
      repoId?: string
    } | null
    /** Preserve where provider data came from, separately from the host chosen to run the workspace. */
    taskSourceContext?: TaskSourceContext | null
    linkedTaskSourceContext?: TaskSourceContext | null
    agent: TuiAgent
    linkedIssue: string
    linkedPR: number | null
    /** GitLab parallels — number for an issue, iid for an MR. Optional so pre-GitLab drafts still load without migration. */
    linkedGitLabIssue?: number | null
    linkedGitLabMR?: number | null
    // Why: repo-scoped start ref from the "Start from" picker; absent means "use the repo's effective base ref".
    baseBranch?: string
    // Why: review worktrees start from a head ref/SHA while Source Control compares against the provider target branch.
    compareBaseRef?: string
  } | null
  openTaskPage: (
    data?: UIPageNavigationSlice['taskPageData'],
    options?: { recordTasksInteraction?: boolean }
  ) => void
  closeTaskPage: () => void
  openActivityPage: () => void
  closeActivityPage: () => void
  selectedAutomationId: string | null
  setSelectedAutomationId: (id: string | null) => void
  pendingAutomationRunNavigation: {
    automationId: string
    runId: string | null
    hostId?: ExecutionHostId
  } | null
  setPendingAutomationRunNavigation: (
    navigation: { automationId: string; runId: string | null; hostId?: ExecutionHostId } | null
  ) => void
  openAutomationsPage: () => void
  closeAutomationsPage: () => void
  openSpacePage: () => void
  closeSpacePage: () => void
  openSkillsPage: () => void
  closeSkillsPage: () => void
  pendingSkillShareId: string | null
  openSkillShare: (shareId: string) => void
  clearPendingSkillShare: () => void
  /** Set when another surface links straight to the page's shared-links view. */
  pendingSkillsSharedView: boolean
  openSkillsSharedLinks: () => void
  clearPendingSkillsSharedView: () => void
  openArtifactsPage: () => void
  closeArtifactsPage: () => void
  openMobilePage: () => void
  closeMobilePage: () => void
  setNewWorkspaceDraft: (draft: NonNullable<UIPageNavigationSlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  openSettingsPage: () => void
  closeSettingsPage: () => void
  settingsNavigationTarget: SettingsNavigationTarget | null
  openSettingsTarget: (
    target: NonNullable<UIPageNavigationSlice['settingsNavigationTarget']>
  ) => void
  clearSettingsTarget: () => void
  /** Which host the Projects Settings pane shows per project (keyed by projectId). Ephemeral on purpose — never persisted, so reload reopens on the effective host. */
  settingsProjectHostSelection: Record<string, ExecutionHostId>
  settingsProjectSetupSelection: Record<string, string>
  setSettingsProjectHostSelection: (
    projectId: string,
    hostId: ExecutionHostId,
    setupId?: string
  ) => void
  /** One-shot Appearance accordion to expand for nested Settings deep links (e.g. Usage percentages under Window & Sidebar). Cleared when Appearance consumes it. */
  appearanceAccordionDeepLink: 'interface' | 'terminal' | 'window' | null
  setAppearanceAccordionDeepLink: (
    section: NonNullable<UIPageNavigationSlice['appearanceAccordionDeepLink']>
  ) => void
  clearAppearanceAccordionDeepLink: () => void
  activeModal:
    | 'none'
    | 'create-worktree'
    | 'edit-meta'
    | 'delete-worktree'
    | 'preserved-branch-review'
    | 'forget-ssh-workspace'
    | 'confirm-add-project-from-folder'
    | 'confirm-non-git-folder'
    | 'confirm-remove-folder'
    | 'add-repo'
    | 'quick-open'
    | 'worktree-palette'
    | 'workspace-cleanup'
    | 'project-added'
    | 'worktree-visibility'
    | 'setup-guide'
    | 'feature-wall'
    | 'feature-tips'
    | 'new-workspace-composer'
    | 'confirm-orca-yaml-hooks'
  modalData: Record<string, unknown>
  openModal: (modal: UIPageNavigationSlice['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
}
