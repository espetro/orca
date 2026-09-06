import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { warmTaskPagePrefetch } from './task-prefetch'
import type { UIPageNavigationSlice } from './ui-page-navigation-types'

export type { TaskPageData, UIPageNavigationSlice } from './ui-page-navigation-types'
import { isTopLevelView } from '../../../../shared/top-level-view'
import { settleEvictedModalData } from './modal-slot-dismissal'
import { hasFeatureInteraction } from '../../../../shared/feature-interactions'
import {
  findPrevLiveNonTaskStackHistoryIndex,
  rewindHistoryIndexPastView
} from './worktree-nav-history'

// Why: local copy of TaskPage's preset→query mapping avoids a store ↔ lib circular import while warming the exact cache key.

export function sanitizeHydratedActiveView(
  value: PersistedUIState['activeView'],
  experimentalActivityEnabled: boolean
): TopLevelView {
  // Why: older data (pre-activeView) or a view a different build doesn't have
  // falls back to terminal rather than rendering nothing.
  if (!isTopLevelView(value)) {
    return 'terminal'
  }
  // Why: activity is hidden when its setting is off, so gate only it (mobile/automations stay functional when hidden).
  if (value === 'activity' && !experimentalActivityEnabled) {
    return 'terminal'
  }
  return value
}

export const createUIPageNavigationSlice: StateCreator<AppState, [], [], UIPageNavigationSlice> = (
  set,
  get
) => ({
  activeView: 'terminal',
  previousViewBeforeTasks: 'terminal',
  previousViewBeforeSettings: 'terminal',
  previousViewBeforeActivity: 'terminal',
  previousViewBeforeAutomations: 'terminal',
  previousViewBeforeSpace: 'terminal',
  previousViewBeforeSkills: 'terminal',
  pendingSkillShareId: null,
  pendingSkillsSharedView: false,
  previousViewBeforeMobile: 'terminal',
  previousViewBeforeArtifacts: 'terminal',
  setActiveView: (view) => set({ activeView: view }),
  taskPageData: {},
  taskResumeState: undefined,
  taskListPosition: null,
  githubTaskDrawerWorkItem: null,
  newWorkspaceDraft: null,
  openTaskPage: (data = {}, options = {}) => {
    if (options.recordTasksInteraction !== false) {
      const wasTasksPreviouslyInteracted = hasFeatureInteraction(get().featureInteractions, 'tasks')
      set((state) => ({
        contextualTourNavigationInteractionSnapshot: {
          ...state.contextualTourNavigationInteractionSnapshot,
          tasks: wasTasksPreviouslyInteracted
        }
      }))
      get().recordFeatureInteraction?.('tasks')
    }
    if (data.openGitHubWorkItem) {
      get().recordFeatureInteraction?.('github-tasks')
    }
    if (data.openGitLabWorkItem) {
      get().recordFeatureInteraction?.('gitlab-tasks')
    }
    if (data.openLinearIssue) {
      get().recordFeatureInteraction?.('linear-tasks')
    }
    if (data.openJiraIssue) {
      get().recordFeatureInteraction?.('jira-tasks')
    }
    // Why: record a Tasks visit in shared back/forward history; all task-source variants collapse to one deduped 'tasks' entry.
    const detailEntry = data.openGitHubWorkItem
      ? ({
          kind: 'task-detail',
          source: 'github',
          workItem: data.openGitHubWorkItem,
          sourceContext: data.openGitHubSourceContext,
          initialTab: data.openGitHubInitialTab
        } as const)
      : data.openGitLabWorkItem
        ? ({
            kind: 'task-detail',
            source: 'gitlab',
            workItem: data.openGitLabWorkItem,
            sourceContext: data.openGitLabSourceContext
          } as const)
        : data.openLinearIssue
          ? ({
              kind: 'task-detail',
              source: 'linear',
              issue: data.openLinearIssue,
              sourceContext: data.openLinearSourceContext
            } as const)
          : data.openJiraIssue
            ? ({
                kind: 'task-detail',
                source: 'jira',
                issue: data.openJiraIssue,
                sourceContext: data.openJiraSourceContext
              } as const)
            : null
    const currentEntry = get().worktreeNavHistory[get().worktreeNavHistoryIndex]
    const currentIsTaskStack =
      currentEntry === 'tasks' ||
      (typeof currentEntry === 'object' && currentEntry.kind === 'task-detail')
    if (!detailEntry || !currentIsTaskStack) {
      get().recordViewVisit('tasks')
    }
    if (detailEntry) {
      get().recordViewVisit(detailEntry)
    }
    set((state) => ({
      activeView: 'tasks',
      previousViewBeforeTasks:
        state.activeView === 'tasks' ? state.previousViewBeforeTasks : state.activeView,
      taskPageData: data
    }))
    warmTaskPagePrefetch(get, data)
  },
  setTaskResumeState: (updates) =>
    set((s) => {
      const next = { ...s.taskResumeState, ...updates }
      window.api.ui.set({ taskResumeState: next }).catch(console.error)
      return { taskResumeState: next }
    }),
  setTaskListPosition: (taskListPosition) => set({ taskListPosition }),
  setGithubTaskDrawerWorkItem: (item) => set({ githubTaskDrawerWorkItem: item }),
  closeTaskPage: () =>
    set((state) => {
      // Why: if parked on a 'tasks' entry, rewind the history index so Back/Forward aren't no-ops; keep 0 if it's the only entry.
      const currentEntry = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
      let nextHistoryIndex = state.worktreeNavHistoryIndex
      if (
        currentEntry === 'tasks' ||
        (typeof currentEntry === 'object' && currentEntry.kind === 'task-detail')
      ) {
        const prev = findPrevLiveNonTaskStackHistoryIndex(state)
        if (prev !== null) {
          nextHistoryIndex = prev
        } else if (typeof currentEntry === 'object' && state.worktreeNavHistory[0] === 'tasks') {
          nextHistoryIndex = 0
        }
      }
      return {
        activeView: state.previousViewBeforeTasks,
        taskPageData: {},
        githubTaskDrawerWorkItem: null,
        worktreeNavHistoryIndex: nextHistoryIndex
      }
    }),
  openActivityPage: () => {
    if (get().settings?.experimentalActivity !== true) {
      return
    }
    set((state) => ({
      activeView: 'activity',
      previousViewBeforeActivity:
        state.activeView === 'activity' ? state.previousViewBeforeActivity : state.activeView
    }))
  },
  closeActivityPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeActivity
    })),
  selectedAutomationId: null,
  setSelectedAutomationId: (id) => set({ selectedAutomationId: id }),
  pendingAutomationRunNavigation: null,
  setPendingAutomationRunNavigation: (navigation) =>
    set({ pendingAutomationRunNavigation: navigation }),
  openAutomationsPage: () => {
    get().recordViewVisit('automations')
    set((state) => ({
      activeView: 'automations',
      previousViewBeforeAutomations:
        state.activeView === 'automations' ? state.previousViewBeforeAutomations : state.activeView
    }))
  },
  closeAutomationsPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeAutomations,
      worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'automations')
    })),
  openSpacePage: () => {
    get().recordFeatureInteraction?.('workspace-cleanup')
    set((state) => ({
      activeView: 'space',
      previousViewBeforeSpace:
        state.activeView === 'space' ? state.previousViewBeforeSpace : state.activeView
    }))
  },
  closeSpacePage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeSpace
    })),
  openSkillsPage: () => {
    get().recordViewVisit('skills')
    set((state) => ({
      activeView: 'skills',
      previousViewBeforeSkills:
        state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView
    }))
  },
  closeSkillsPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeSkills,
      worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'skills')
    })),
  openSkillShare: (shareId) => {
    get().recordViewVisit('skills')
    set((state) => ({
      activeView: 'skills',
      previousViewBeforeSkills:
        state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
      pendingSkillShareId: shareId
    }))
  },
  clearPendingSkillShare: () => set({ pendingSkillShareId: null }),
  openSkillsSharedLinks: () => {
    get().recordViewVisit('skills')
    set((state) => ({
      activeView: 'skills',
      previousViewBeforeSkills:
        state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView,
      pendingSkillsSharedView: true
    }))
  },
  clearPendingSkillsSharedView: () => set({ pendingSkillsSharedView: false }),
  openArtifactsPage: () => {
    get().recordViewVisit('artifacts')
    set((state) => ({
      activeView: 'artifacts',
      previousViewBeforeArtifacts:
        state.activeView === 'artifacts' ? state.previousViewBeforeArtifacts : state.activeView
    }))
  },
  closeArtifactsPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeArtifacts,
      worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'artifacts')
    })),
  openMobilePage: () =>
    set((state) => ({
      activeView: 'mobile',
      previousViewBeforeMobile:
        state.activeView === 'mobile' ? state.previousViewBeforeMobile : state.activeView
    })),
  closeMobilePage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeMobile
    })),
  setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
  clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null }),
  openSettingsPage: () => {
    // Why: settings search is a transient filter; opening Settings shouldn't inherit hidden sections from last visit.
    get().setSettingsSearchQuery('')
    set((state) => ({
      activeView: 'settings',
      // Why: preserve the originating view so Settings back returns there (e.g. in-progress draft), not always terminal.
      previousViewBeforeSettings:
        state.activeView === 'settings' ? state.previousViewBeforeSettings : state.activeView
    }))
  },
  closeSettingsPage: () =>
    set((state) => {
      const previousView =
        state.previousViewBeforeSettings === 'activity' &&
        state.settings?.experimentalActivity !== true
          ? 'terminal'
          : state.previousViewBeforeSettings
      return { activeView: previousView }
    }),
  activeModal: 'none',
  modalData: {},
  openModal: (modal, data = {}) => {
    if (modal === 'add-repo' || modal === 'create-worktree') {
      get().recordFeatureInteraction?.('workspace-creation')
    }
    const evicted = get().modalData
    set({
      activeModal: modal,
      modalData: data
    })
    settleEvictedModalData(evicted)
  },
  closeModal: () => {
    const evicted = get().modalData
    set({ activeModal: 'none', modalData: {} })
    settleEvictedModalData(evicted)
  },
  settingsNavigationTarget: null,
  openSettingsTarget: (target) => {
    if (!isSettingsNavigationTarget(target)) {
      if (import.meta.env.DEV) {
        throw new TypeError('openSettingsTarget received an invalid navigation target')
      }
      return
    }
    set({ settingsNavigationTarget: target })
  },
  clearSettingsTarget: () => set({ settingsNavigationTarget: null }),
  settingsProjectHostSelection: {},
  settingsProjectSetupSelection: {},
  // Why: renderer-only, never persisted — no window.api.ui.set, and absent from the debounced UI writer in App.tsx.
  setSettingsProjectHostSelection: (projectId, hostId, setupId) =>
    set((s) => {
      const nextSetupSelections = { ...s.settingsProjectSetupSelection }
      if (setupId) {
        nextSetupSelections[projectId] = setupId
      } else {
        delete nextSetupSelections[projectId]
      }
      if (
        s.settingsProjectHostSelection[projectId] === hostId &&
        s.settingsProjectSetupSelection[projectId] === setupId
      ) {
        return s
      }
      return {
        settingsProjectHostSelection: {
          ...s.settingsProjectHostSelection,
          [projectId]: hostId
        },
        settingsProjectSetupSelection: nextSetupSelections
      }
    }),
  appearanceAccordionDeepLink: null,
  setAppearanceAccordionDeepLink: (section) => set({ appearanceAccordionDeepLink: section }),
  clearAppearanceAccordionDeepLink: () => set({ appearanceAccordionDeepLink: null })
})
