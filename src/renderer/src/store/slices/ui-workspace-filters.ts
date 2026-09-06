import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  AgentActivityDisplayMode,
  ManualRepoOrderEntry,
  ProjectOrderBy,
  StatusBarItem,
  VisibleWorkspaceHostIds,
  WorkspaceHostOrder,
  WorkspaceHostScope,
  WorktreeCardMode,
  WorktreeCardProperty
} from '../../../../shared/ui-chrome-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import {
  DEFAULT_USAGE_PERCENTAGE_DISPLAY,
  normalizeUsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import {
  DEFAULT_STATUS_BAR_USAGE_MODE,
  normalizeStatusBarUsageMode
} from '../../../../shared/status-bar-usage-mode'
import {
  ALL_AUTOMATION_HOSTS_FILTER,
  toPersistedAutomationHostFilter
} from '../../../../shared/automation-host-filter'
import {
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds
} from '../../../../shared/execution-host'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  cloneDefaultWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from '../../../../shared/workspace-statuses'
import {
  DEFAULT_SHOW_SLEEPING_WORKSPACES,
  DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardModeUpdates,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties
} from '../../../../shared/constants'

export function migrateStatusBarItems(items: readonly string[] | undefined): StatusBarItem[] {
  const source = items ?? DEFAULT_STATUS_BAR_ITEMS
  const out: string[] = []
  for (const id of source) {
    const mapped = id === 'memory' || id === 'sessions' ? 'resource-usage' : id
    if (!out.includes(mapped)) {
      out.push(mapped)
    }
  }
  return out as StatusBarItem[]
}

export const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
export const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
export const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
export const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
export const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'

export type UIWorkspaceFiltersSlice = {
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  setGroupBy: (g: UIWorkspaceFiltersSlice['groupBy']) => void
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  setSortBy: (s: UIWorkspaceFiltersSlice['sortBy']) => void
  projectOrderBy: ProjectOrderBy
  setProjectOrderBy: (p: ProjectOrderBy) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  showSleepingWorkspaces: boolean
  setShowSleepingWorkspaces: (v: boolean) => void
  workspaceHostScope: WorkspaceHostScope
  setWorkspaceHostScope: (scope: WorkspaceHostScope) => void
  visibleWorkspaceHostIds: VisibleWorkspaceHostIds
  setVisibleWorkspaceHostIds: (ids: VisibleWorkspaceHostIds) => void
  workspaceHostOrder: WorkspaceHostOrder
  setWorkspaceHostOrder: (ids: WorkspaceHostOrder) => void
  /** Automations page host filter, in stable form. Never written from an unhydrated catalog. */
  automationHostFilter: AutomationHostFilter
  setAutomationHostFilter: (filter: AutomationHostFilter) => void
  manualRepoOrder: ManualRepoOrderEntry[]
  hideDefaultBranchWorkspace: boolean
  setHideDefaultBranchWorkspace: (v: boolean) => void
  hideAutomationGeneratedWorkspaces: boolean
  setHideAutomationGeneratedWorkspaces: (v: boolean) => void
  hideCliCreatedWorkspaces: boolean
  setHideCliCreatedWorkspaces: (v: boolean) => void
  hideDetachedHeadWorkspaces: boolean
  setHideDetachedHeadWorkspaces: (v: boolean) => void
  hideWorkspacesFromOtherDevices: boolean
  setHideWorkspacesFromOtherDevices: (v: boolean) => void
  alwaysShowDefaultBranchWorkspace: boolean
  setAlwaysShowDefaultBranchWorkspace: (v: boolean) => void
  showDotfilesByWorktree: Record<string, boolean>
  setShowDotfilesForWorktree: (worktreeId: string, showDotfiles: boolean) => void
  toggleShowDotfilesForWorktree: (worktreeId: string) => void
  filterRepoIds: readonly string[]
  setFilterRepoIds: (ids: readonly string[]) => void
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
  worktreeCardProperties: WorktreeCardProperty[]
  _worktreeCardModeDefaulted: boolean
  setWorktreeCardMode: (mode: WorktreeCardMode) => void
  setWorktreeCardProperties: (properties: readonly WorktreeCardProperty[]) => void
  agentActivityDisplayMode: AgentActivityDisplayMode
  setAgentActivityDisplayMode: (mode: AgentActivityDisplayMode) => void
  workspaceStatuses: WorkspaceStatusDefinition[]
  setWorkspaceStatuses: (statuses: WorkspaceStatusDefinition[]) => void
  workspaceBoardOpacity: number
  setWorkspaceBoardOpacity: (opacity: number) => void
  workspaceBoardColumnWidth: number
  setWorkspaceBoardColumnWidth: (width: number) => void
  syncTaskStatusFromWorkspaceBoard: boolean
  setSyncTaskStatusFromWorkspaceBoard: (enabled: boolean) => void
  /** Transient: the in-window Agent Dashboard companion drawer is open. Not persisted. */
  agentDashboardDrawerOpen: boolean
  setAgentDashboardDrawerOpen: (open: boolean) => void
  statusBarItems: StatusBarItem[]
  toggleStatusBarItem: (item: StatusBarItem) => void
  statusBarVisible: boolean
  setStatusBarVisible: (v: boolean) => void
  usagePercentageDisplay: UsagePercentageDisplay
  setUsagePercentageDisplay: (display: UsagePercentageDisplay) => void
  statusBarUsageMode: StatusBarUsageMode
  setStatusBarUsageMode: (mode: StatusBarUsageMode) => void
  workspacePortScan: { key: string; result: WorkspacePortScanResult } | null
  workspacePortScansByKey: Record<string, WorkspacePortScanResult>
  workspacePortScanRefreshing: boolean
  setWorkspacePortScan: (scan: { key: string; result: WorkspacePortScanResult } | null) => void
  setWorkspacePortScanProjection: (
    scan: { key: string; result: WorkspacePortScanResult } | null
  ) => void
  replaceWorkspacePortScans: (
    scansByKey: Record<string, WorkspacePortScanResult>,
    projection: { key: string; result: WorkspacePortScanResult } | null
  ) => void
  setWorkspacePortScanForKey: (key: string, result: WorkspacePortScanResult | null) => void
  setWorkspacePortScanRefreshing: (refreshing: boolean) => void
  /** Whether the pet overlay is currently visible. Persisted so "Hide pet" survives reload. Independent of the experimentalPet flag (which gates whether it can render at all). */
}

export const createUIWorkspaceFiltersSlice: StateCreator<
  AppState,
  [],
  [],
  UIWorkspaceFiltersSlice
> = (set, get) => ({
  groupBy: 'repo',
  // Why: group keys are mode-specific, so clear collapsed state on mode switch — stale keys are meaningless and accumulate.
  setGroupBy: (g) => {
    window.api.ui.set({ groupBy: g, collapsedGroups: [] }).catch(console.error)
    set({ groupBy: g, collapsedGroups: new Set<string>() })
  },

  sortBy: 'recent',
  setSortBy: (s) => set({ sortBy: s }),

  // Why: bare set — persists only via the debounced window.api.ui.set writer in App.tsx, not on its own.
  projectOrderBy: 'manual',
  setProjectOrderBy: (p) => set({ projectOrderBy: p }),

  showActiveOnly: false,
  setShowActiveOnly: (v) => set({ showActiveOnly: v }),

  showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
  setShowSleepingWorkspaces: (v) => set({ showSleepingWorkspaces: v }),

  workspaceHostScope: 'all',
  // Why: host scope is presentation/filtering only — must never trigger resource teardown (terminals, browser pages).
  setWorkspaceHostScope: (scope) => {
    const normalized = normalizeExecutionHostScope(scope)
    const visibleWorkspaceHostIds = normalized === 'all' ? null : [normalized]
    set({ workspaceHostScope: normalized, visibleWorkspaceHostIds })
    window.api.ui
      .set({ workspaceHostScope: normalized, visibleWorkspaceHostIds })
      .catch(console.error)
  },
  visibleWorkspaceHostIds: null,
  setVisibleWorkspaceHostIds: (ids) => {
    const normalized = normalizeVisibleExecutionHostIds(ids)
    // Why: workspaceHostScope stays the compat/default-host signal for creation flows; visibility can now be multi-select.
    let workspaceHostScope: WorkspaceHostScope = get().workspaceHostScope
    if (normalized === null) {
      workspaceHostScope = 'all'
    } else if (normalized.length === 1) {
      workspaceHostScope = normalized[0]
    }
    set({ visibleWorkspaceHostIds: normalized, workspaceHostScope })
    window.api.ui
      .set({ visibleWorkspaceHostIds: normalized, workspaceHostScope })
      .catch(console.error)
  },
  workspaceHostOrder: [],
  setWorkspaceHostOrder: (ids) => {
    const workspaceHostOrder = normalizeExecutionHostOrder(ids)
    set({ workspaceHostOrder })
    window.api.ui.set({ workspaceHostOrder }).catch(console.error)
  },
  automationHostFilter: ALL_AUTOMATION_HOSTS_FILTER,
  setAutomationHostFilter: (filter) => {
    window.api.ui
      .set({ automationHostFilter: toPersistedAutomationHostFilter(filter) })
      .catch(console.error)
    set({ automationHostFilter: filter })
  },
  manualRepoOrder: [],

  hideDefaultBranchWorkspace: false,
  setHideDefaultBranchWorkspace: (v) => set({ hideDefaultBranchWorkspace: v }),
  hideAutomationGeneratedWorkspaces: false,
  setHideAutomationGeneratedWorkspaces: (v) => set({ hideAutomationGeneratedWorkspaces: v }),
  hideCliCreatedWorkspaces: false,
  setHideCliCreatedWorkspaces: (v) => set({ hideCliCreatedWorkspaces: v }),
  hideDetachedHeadWorkspaces: false,
  setHideDetachedHeadWorkspaces: (v) => set({ hideDetachedHeadWorkspaces: v }),
  hideWorkspacesFromOtherDevices: false,
  setHideWorkspacesFromOtherDevices: (v) => set({ hideWorkspacesFromOtherDevices: v }),
  alwaysShowDefaultBranchWorkspace: true,
  setAlwaysShowDefaultBranchWorkspace: (v) => set({ alwaysShowDefaultBranchWorkspace: v }),

  showDotfilesByWorktree: {},
  setShowDotfilesForWorktree: (worktreeId, showDotfiles) =>
    set((s) => {
      if (!worktreeId) {
        return s
      }
      const current = s.showDotfilesByWorktree[worktreeId] ?? true
      if (current === showDotfiles) {
        return s
      }
      const next = { ...s.showDotfilesByWorktree }
      // Why: showing dotfiles is the default; only persist worktree-level opt-outs.
      if (showDotfiles) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = false
      }
      return { showDotfilesByWorktree: next }
    }),
  toggleShowDotfilesForWorktree: (worktreeId) =>
    set((s) => {
      if (!worktreeId) {
        return s
      }
      const nextShowDotfiles = !(s.showDotfilesByWorktree[worktreeId] ?? true)
      const next = { ...s.showDotfilesByWorktree }
      if (nextShowDotfiles) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = false
      }
      return { showDotfilesByWorktree: next }
    }),

  filterRepoIds: [],
  setFilterRepoIds: (ids) => set({ filterRepoIds: ids }),

  collapsedGroups: new Set<string>(),
  toggleCollapsedGroup: (key) =>
    set((s) => {
      const next = new Set(s.collapsedGroups)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      window.api.ui.set({ collapsedGroups: [...next] }).catch(console.error)
      return { collapsedGroups: next }
    }),

  worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
  _worktreeCardModeDefaulted: true,
  setWorktreeCardMode: (mode) => {
    const updates = getWorktreeCardModeUpdates(mode)
    set((s) => ({
      settings: s.settings ? { ...s.settings, ...updates.settings } : s.settings,
      worktreeCardProperties: updates.ui.worktreeCardProperties,
      _worktreeCardModeDefaulted: true
    }))
    void Promise.all([
      window.api.settings.set(updates.settings).then((nextSettings) => {
        if (nextSettings) {
          set({ settings: nextSettings })
        }
      }),
      window.api.ui.set(updates.ui)
    ]).catch(console.error)
  },
  setWorktreeCardProperties: (properties) => {
    const normalized = normalizeWorktreeCardProperties(properties)
    set({ worktreeCardProperties: normalized, _worktreeCardModeDefaulted: false })
    window.api.ui
      .set({ worktreeCardProperties: normalized, _worktreeCardModeDefaulted: false })
      .catch(console.error)
  },
  agentActivityDisplayMode: DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
  setAgentActivityDisplayMode: (mode) => {
    const normalized = normalizeAgentActivityDisplayMode(mode)
    window.api.ui.set({ agentActivityDisplayMode: normalized }).catch(console.error)
    set({ agentActivityDisplayMode: normalized })
  },

  workspaceStatuses: cloneDefaultWorkspaceStatuses(),
  setWorkspaceStatuses: (statuses) => {
    const normalized = normalizeWorkspaceStatuses(statuses)
    window.api.ui.set({ workspaceStatuses: normalized }).catch(console.error)
    set({ workspaceStatuses: normalized })
  },

  workspaceBoardOpacity: 1,
  setWorkspaceBoardOpacity: (opacity) => {
    const clamped = clampWorkspaceBoardOpacity(opacity)
    window.api.ui.set({ workspaceBoardOpacity: clamped }).catch(console.error)
    set({ workspaceBoardOpacity: clamped })
  },

  workspaceBoardColumnWidth: WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  setWorkspaceBoardColumnWidth: (width) => {
    const clamped = clampWorkspaceBoardColumnWidth(width)
    window.api.ui.set({ workspaceBoardColumnWidth: clamped }).catch(console.error)
    set({ workspaceBoardColumnWidth: clamped })
  },

  syncTaskStatusFromWorkspaceBoard: false,
  setSyncTaskStatusFromWorkspaceBoard: (enabled) => {
    window.api.ui.set({ syncTaskStatusFromWorkspaceBoard: enabled }).catch(console.error)
    set({ syncTaskStatusFromWorkspaceBoard: enabled })
  },

  statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
  toggleStatusBarItem: (item) =>
    set((s) => {
      const current = s.statusBarItems || DEFAULT_STATUS_BAR_ITEMS
      const updated = current.includes(item)
        ? current.filter((i) => i !== item)
        : [...current, item]
      window.api.ui.set({ statusBarItems: updated }).catch(console.error)
      return { statusBarItems: updated }
    }),

  agentDashboardDrawerOpen: false,
  setAgentDashboardDrawerOpen: (open) => set({ agentDashboardDrawerOpen: open }),
  statusBarVisible: true,
  setStatusBarVisible: (v) => {
    window.api.ui.set({ statusBarVisible: v }).catch(console.error)
    set({ statusBarVisible: v })
  },
  usagePercentageDisplay: DEFAULT_USAGE_PERCENTAGE_DISPLAY,
  setUsagePercentageDisplay: (display) => {
    const normalized = normalizeUsagePercentageDisplay(display)
    // Why: changing the control is the discovery path, so permanently dismiss the one-time change notice.
    window.api.ui
      .set({
        usagePercentageDisplay: normalized,
        usagePercentageDisplayChangeNoticeDismissed: true
      })
      .catch(console.error)
    set({
      usagePercentageDisplay: normalized,
      usagePercentageDisplayChangeNoticeDismissed: true
    })
  },
  statusBarUsageMode: DEFAULT_STATUS_BAR_USAGE_MODE,
  setStatusBarUsageMode: (mode) => {
    const normalized = normalizeStatusBarUsageMode(mode)
    window.api.ui.set({ statusBarUsageMode: normalized }).catch(console.error)
    set({ statusBarUsageMode: normalized })
  },
  workspacePortScan: null,
  workspacePortScansByKey: {},
  workspacePortScanRefreshing: false,
  setWorkspacePortScan: (scan) =>
    set((state) => {
      if (!scan) {
        if (!state.workspacePortScan && Object.keys(state.workspacePortScansByKey).length === 0) {
          return state
        }
        return { workspacePortScan: null, workspacePortScansByKey: {} }
      }
      if (
        state.workspacePortScan?.key === scan.key &&
        state.workspacePortScan.result === scan.result &&
        state.workspacePortScansByKey[scan.key] === scan.result
      ) {
        return state
      }
      return {
        workspacePortScan: scan,
        workspacePortScansByKey: { ...state.workspacePortScansByKey, [scan.key]: scan.result }
      }
    }),
  // Why: target changes rebuild the aggregate without republishing or clearing per-host scans.
  setWorkspacePortScanProjection: (scan) =>
    set((state) => {
      if (
        state.workspacePortScan?.key === scan?.key &&
        state.workspacePortScan?.result === scan?.result
      ) {
        return state
      }
      return { workspacePortScan: scan }
    }),
  // Why: drop stale per-host scans in one store update so a large host set can't fan out notifications to every subscriber.
  replaceWorkspacePortScans: (scansByKey, projection) =>
    set((state) => {
      if (
        state.workspacePortScansByKey === scansByKey &&
        state.workspacePortScan?.key === projection?.key &&
        state.workspacePortScan?.result === projection?.result
      ) {
        return state
      }
      return { workspacePortScansByKey: scansByKey, workspacePortScan: projection }
    }),
  setWorkspacePortScanForKey: (key, result) =>
    set((state) => {
      const currentResult = state.workspacePortScansByKey[key]
      if (currentResult === result || (!result && !currentResult)) {
        return state
      }
      const nextScansByKey = { ...state.workspacePortScansByKey }
      if (result) {
        nextScansByKey[key] = result
      } else {
        delete nextScansByKey[key]
      }
      return {
        workspacePortScansByKey: nextScansByKey,
        workspacePortScan:
          state.workspacePortScan?.key === key
            ? result
              ? { key, result }
              : null
            : state.workspacePortScan
      }
    }),
  setWorkspacePortScanRefreshing: (refreshing) => set({ workspacePortScanRefreshing: refreshing })
})
