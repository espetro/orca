import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { normalizeRightSidebarRoute } from '../right-sidebar-route'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { VisibleWorkspaceHostIds } from '../../../../shared/ui-chrome-types'
import {
  applyManualRepoOrder,
  normalizeManualRepoOrder
} from '../../../../shared/manual-repo-order'
import { isReleaseChannel } from '../../../../shared/release-channel'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { PET_SIZE_DEFAULT } from '../../../../shared/pet-types'
import { normalizeWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'
import { normalizeFeatureTipIds } from '../../../../shared/feature-tips'
import { normalizeFeatureInteractions } from '../../../../shared/feature-interactions'
import { normalizeContextualTourIds } from '../../../../shared/contextual-tours'
import {
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  normalizeWorkspaceStatuses
} from '../../../../shared/workspace-statuses'
import { clampMarkdownTocPanelWidth } from '../../../../shared/markdown-toc-panel-width'
import { clampCombinedDiffFileTreeWidth } from '../../../../shared/combined-diff-file-tree-width'
import { normalizeKagiSessionLink } from '../../../../shared/browser-url'
import {
  filterSetupScriptPromptDismissalsToValidRepos,
  sanitizeSetupScriptPromptDismissals
} from '../../lib/setup-script-prompt'
import { DEFAULT_PET_ID, isBundledPetId } from '../../components/pet/pet-models'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  type PersistedUIWriteBaseline
} from './persisted-ui-write-baseline'
import { normalizeBrowserPageZoomLevel } from '../../../../shared/browser-page-zoom'
import { getRepoHostIdentity } from './repo-host-identity'
import { parsePersistedAutomationHostFilter } from '../../../../shared/automation-host-filter'
import {
  DEFAULT_HIDE_SLEEPING_WORKSPACES,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties
} from '../../../../shared/constants'
import {
  createUIPageNavigationSlice,
  sanitizeHydratedActiveView,
  type UIPageNavigationSlice
} from './ui-page-navigation'
import {
  createUIWorkspaceFiltersSlice,
  DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM,
  DEFAULT_ON_GROK_STATUS_BAR_ITEM,
  DEFAULT_ON_KIMI_STATUS_BAR_ITEM,
  DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM,
  DEFAULT_ON_PORTS_STATUS_BAR_ITEM,
  migrateStatusBarItems,
  type UIWorkspaceFiltersSlice
} from './ui-workspace-filters'
import { createUIContextualToursSlice, type UIContextualToursSlice } from './ui-contextual-tours'
import { createUIAgentSendSlice, type UIAgentSendSlice } from './ui-agent-send'
import { createUINoticesSlice, type UINoticesSlice } from './ui-notices'
import { createUIPetOverlaySlice, clampPetSize, type UIPetOverlaySlice } from './ui-pet-overlay'
import {
  hydratedUIPartialMatchesState,
  hydrateTrustedOrcaHooks,
  sanitizeAcknowledgedAgentsByPaneKey,
  sanitizePersistedRepoIds,
  sanitizePersistedSidebarWidth,
  sanitizeShowDotfilesByWorktree,
  sanitizeTaskResumeState,
  sanitizeWorkspaceCleanupDismissals
} from './ui-persisted-state-sanitizers'

export type {
  AgentSendPopoverTargetMode,
  OpenAgentSendPopoverTargetModeArgs
} from './ui-agent-send'

export type PendingSidebarWorktreeReveal = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  behavior: 'auto' | 'smooth'
  highlight?: boolean
  beginRename?: boolean
}

export type PendingSidebarRowReveal = {
  rowKey: string
  behavior: 'auto' | 'smooth'
  highlight?: boolean
}

const MAX_LEFT_SIDEBAR_WIDTH = 500
// Why: right-sidebar resize is window-relative, so widths can far exceed 500px on wide displays; this ceiling is only a corruption safety net.
const MAX_RIGHT_SIDEBAR_WIDTH = 4000

function normalizeHydratedVisibleWorkspaceHostIds(ui: PersistedUIState): VisibleWorkspaceHostIds {
  const visibleHostIds = normalizeVisibleExecutionHostIds(ui.visibleWorkspaceHostIds)
  if (visibleHostIds) {
    return visibleHostIds
  }
  const legacyScope = normalizeExecutionHostScope(ui.workspaceHostScope)
  return legacyScope === 'all' ? null : [legacyScope]
}

export type UISlice = UIPageNavigationSlice &
  UIWorkspaceFiltersSlice &
  UIContextualToursSlice &
  UIAgentSendSlice &
  UINoticesSlice &
  UIPetOverlaySlice & {
    sidebarOpen: boolean
    sidebarWidth: number
    toggleSidebar: () => void
    setSidebarOpen: (open: boolean) => void
    setSidebarWidth: (width: number) => void
    pendingRevealWorktree: PendingSidebarWorktreeReveal | null
    pendingRevealSidebarRow: PendingSidebarRowReveal | null
    revealWorktreeInSidebar: (
      worktreeId: string,
      options?: {
        behavior?: PendingSidebarWorktreeReveal['behavior']
        highlight?: boolean
        beginRename?: boolean
        executionHostId?: ExecutionHostId
      }
    ) => void
    revealSidebarRow: (
      rowKey: string,
      options?: {
        behavior?: PendingSidebarRowReveal['behavior']
        highlight?: boolean
      }
    ) => void
    clearPendingRevealWorktreeId: () => void
    clearPendingRevealSidebarRow: () => void
    // Why: cleared by the diff decorator after it reveals the line, so the same id can be requested again without a stale value.
    scrollToDiffCommentId: string | null
    setScrollToDiffCommentId: (id: string | null) => void
    persistedUIReady: boolean
    /** Writer-owned fields as last hydrated from main or flushed by the writer; the debounced writer diffs against this so it only persists fields this client changed (STA-5781). */
    persistedUIWriteBaseline: PersistedUIWriteBaseline | null
    /** Fields with a ui.set round-trip in flight; hydration keeps the mirror's value for them so an echo of the in-flight write can't revert a newer flip-back. */
    persistedUIWriteInFlightCounts: Partial<Record<keyof PersistedUIWriteBaseline, number>>
    /** Bumped whenever hydration replaces the baseline; an ack whose write predates the bump must not fold, or it would erase a remote write that landed during the round trip. */
    persistedUIWriteBaselineGeneration: number
    notePersistedUIWriteStarted: (fields: readonly (keyof PersistedUIWriteBaseline)[]) => void
    /** Settle an in-flight write: fold the acked patch into the baseline (null = rejected, leaving the fields dirty so the next change re-flushes them). */
    notePersistedUIWriteSettled: (
      fields: readonly (keyof PersistedUIWriteBaseline)[],
      flushed: Partial<PersistedUIWriteBaseline> | null,
      options?: { sentAtGeneration: number }
    ) => void
    uiZoomLevel: number
    setUIZoomLevel: (level: number) => void
    editorFontZoomLevel: number
    setEditorFontZoomLevel: (level: number) => void
    hydratePersistedUI: (ui: PersistedUIState, source?: 'startup' | 'sync') => void
  }

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) => ({
  ...createUIPageNavigationSlice(set, get, get as never),
  ...createUIWorkspaceFiltersSlice(set, get, get as never),
  ...createUIContextualToursSlice(set, get, get as never),
  ...createUIAgentSendSlice(set, get, get as never),
  ...createUINoticesSlice(set, get, get as never),
  ...createUIPetOverlaySlice(set, get, get as never),

  sidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  pendingRevealWorktree: null,
  pendingRevealSidebarRow: null,
  revealWorktreeInSidebar: (worktreeId, options) =>
    set({
      pendingRevealWorktree: {
        worktreeId,
        ...(options?.executionHostId ? { executionHostId: options.executionHostId } : {}),
        behavior: options?.behavior ?? 'smooth',
        ...(options?.highlight ? { highlight: true } : {}),
        ...(options?.beginRename ? { beginRename: true } : {})
      }
    }),
  revealSidebarRow: (rowKey, options) =>
    set({
      pendingRevealSidebarRow: {
        rowKey,
        behavior: options?.behavior ?? 'smooth',
        ...(options?.highlight === false ? {} : { highlight: true })
      }
    }),
  clearPendingRevealWorktreeId: () => set({ pendingRevealWorktree: null }),
  clearPendingRevealSidebarRow: () => set({ pendingRevealSidebarRow: null }),
  scrollToDiffCommentId: null,
  setScrollToDiffCommentId: (id) => set({ scrollToDiffCommentId: id }),
  persistedUIReady: false,
  persistedUIWriteBaseline: null,
  persistedUIWriteInFlightCounts: {},
  notePersistedUIWriteStarted: (fields) =>
    set((s) => {
      const counts = { ...s.persistedUIWriteInFlightCounts }
      for (const field of fields) {
        counts[field] = (counts[field] ?? 0) + 1
      }
      return { persistedUIWriteInFlightCounts: counts }
    }),
  persistedUIWriteBaselineGeneration: 0,
  notePersistedUIWriteSettled: (fields, flushed, options) =>
    set((s) => {
      const counts = { ...s.persistedUIWriteInFlightCounts }
      for (const field of fields) {
        const next = (counts[field] ?? 0) - 1
        if (next > 0) {
          counts[field] = next
        } else {
          delete counts[field]
        }
      }
      // Why the generation guard: a hydration during the round trip made the
      // baseline authoritative for state NEWER than this write; folding the
      // sent values over it would blank the mirror-vs-baseline diff and leave
      // mirror and authority divergent with nothing left to reconcile them.
      // Skipping the fold keeps the diff alive so the trailing flush re-sends.
      // Why options is required for folding: an unguarded fold from a future
      // caller could silently erase a remote write that landed mid-round-trip.
      const foldable =
        flushed &&
        s.persistedUIWriteBaseline &&
        options !== undefined &&
        options.sentAtGeneration === s.persistedUIWriteBaselineGeneration
      return {
        persistedUIWriteInFlightCounts: counts,
        ...(foldable
          ? { persistedUIWriteBaseline: { ...s.persistedUIWriteBaseline!, ...flushed } }
          : {})
      }
    }),
  uiZoomLevel: 0,
  setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
  editorFontZoomLevel: 0,
  setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level }),

  hydratePersistedUI: (ui, source = 'sync') =>
    set((s) => {
      const manualRepoOrder = normalizeManualRepoOrder(ui.manualRepoOrder)
      const orderedRepos = applyManualRepoOrder(s.repos, manualRepoOrder)
      const validRepoIds = new Set(s.repos.map((repo) => repo.id))
      const validRepoHostIdentities = new Set(s.repos.map(getRepoHostIdentity))
      const persistedFilterRepoIds = sanitizePersistedRepoIds(ui.filterRepoIds)
      // Why: pre-rename builds used sidekick* keys; read as fallback only so new pet* writes win after upgrade.
      const customPets = Array.isArray(ui.customPets)
        ? ui.customPets
        : Array.isArray(ui.customSidekicks)
          ? ui.customSidekicks
          : []
      const petId = ui.petId ?? ui.sidekickId
      // Migration: one-shot old-'recent'→'smart' runs in main (_sortBySmartMigrated), not here, so a deliberate 'recent' choice survives restart.
      const sortBy = ui.sortBy
      const migratedStatusBarItems = migrateStatusBarItems(ui.statusBarItems)
      const statusBarItemsWithPorts =
        ui._portsStatusBarDefaultAdded || migratedStatusBarItems.includes('ports')
          ? migratedStatusBarItems
          : [...migratedStatusBarItems, DEFAULT_ON_PORTS_STATUS_BAR_ITEM]
      const statusBarItems =
        ui._kimiStatusBarDefaultAdded || statusBarItemsWithPorts.includes('kimi')
          ? statusBarItemsWithPorts
          : [...statusBarItemsWithPorts, DEFAULT_ON_KIMI_STATUS_BAR_ITEM]
      const statusBarItemsWithMiniMax =
        ui._minimaxStatusBarDefaultAdded || statusBarItems.includes('minimax')
          ? statusBarItems
          : [...statusBarItems, DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM]
      const statusBarItemsWithAntigravity =
        ui._antigravityStatusBarDefaultAdded || statusBarItemsWithMiniMax.includes('antigravity')
          ? statusBarItemsWithMiniMax
          : [...statusBarItemsWithMiniMax, DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM]
      const statusBarItemsWithGrok =
        ui._grokStatusBarDefaultAdded || statusBarItemsWithAntigravity.includes('grok')
          ? statusBarItemsWithAntigravity
          : [...statusBarItemsWithAntigravity, DEFAULT_ON_GROK_STATUS_BAR_ITEM]
      if (
        (!ui._portsStatusBarDefaultAdded ||
          !ui._kimiStatusBarDefaultAdded ||
          !ui._minimaxStatusBarDefaultAdded ||
          !ui._antigravityStatusBarDefaultAdded ||
          !ui._grokStatusBarDefaultAdded) &&
        typeof window !== 'undefined'
      ) {
        window.api.ui
          .set({
            statusBarItems: statusBarItemsWithGrok,
            _portsStatusBarDefaultAdded: true,
            _kimiStatusBarDefaultAdded: true,
            _minimaxStatusBarDefaultAdded: true,
            _antigravityStatusBarDefaultAdded: true,
            _grokStatusBarDefaultAdded: true
          })
          .catch(console.error)
      }
      const rightSidebarRoute = normalizeRightSidebarRoute(
        ui.rightSidebarTab,
        ui.rightSidebarExplorerView
      )
      const hydrated = {
        // Why: persisted widths may be stale/corrupt/hand-edited; clamp during hydration so invalid values can't break layout.
        sidebarWidth: sanitizePersistedSidebarWidth(
          ui.sidebarWidth,
          s.sidebarWidth,
          MAX_LEFT_SIDEBAR_WIDTH
        ),
        rightSidebarWidth: sanitizePersistedSidebarWidth(
          ui.rightSidebarWidth,
          s.rightSidebarWidth,
          MAX_RIGHT_SIDEBAR_WIDTH
        ),
        markdownTocPanelWidth: clampMarkdownTocPanelWidth(
          ui.markdownTocPanelWidth,
          undefined,
          s.markdownTocPanelWidth
        ),
        combinedDiffFileTreeWidth: clampCombinedDiffFileTreeWidth(
          ui.combinedDiffFileTreeWidth,
          undefined,
          s.combinedDiffFileTreeWidth
        ),
        rightSidebarOpen: typeof ui.rightSidebarOpen === 'boolean' ? ui.rightSidebarOpen : true,
        rightSidebarTab: rightSidebarRoute.rightSidebarTab,
        rightSidebarExplorerView: rightSidebarRoute.rightSidebarExplorerView,
        groupBy: (ui.groupBy as UISlice['groupBy'] | 'parent') === 'parent' ? 'repo' : ui.groupBy,
        sortBy,
        // Why: main-process getUI() already normalized this (defaulting to 'manual'); read it through without migrating.
        projectOrderBy: ui.projectOrderBy,
        // Why: Active-only was retired; force the old flag off so an old profile can't invisibly narrow the workspace list.
        showActiveOnly: false,
        // Why: ignore older positive-form keys so old profiles start from the new default (sleeping workspaces visible).
        showSleepingWorkspaces: !(ui.hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
        workspaceHostScope: normalizeExecutionHostScope(ui.workspaceHostScope),
        visibleWorkspaceHostIds: normalizeHydratedVisibleWorkspaceHostIds(ui),
        workspaceHostOrder: normalizeExecutionHostOrder(ui.workspaceHostOrder),
        // Why: a malformed or legacy filter value must degrade to All hosts, never throw during hydration.
        automationHostFilter: parsePersistedAutomationHostFilter(ui.automationHostFilter),
        manualRepoOrder,
        // Why: apply the desktop-owned overlay immediately since UI state can arrive after a catalog or from another client.
        repos: orderedRepos,
        hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace ?? false,
        hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
        hideCliCreatedWorkspaces: ui.hideCliCreatedWorkspaces === true,
        hideDetachedHeadWorkspaces: ui.hideDetachedHeadWorkspaces === true,
        hideWorkspacesFromOtherDevices: ui.hideWorkspacesFromOtherDevices === true,
        // Why !== false: profiles written before #8873 have no key, and they are
        // precisely the ones showing the bug, so absence must mean "exempt".
        alwaysShowDefaultBranchWorkspace: ui.alwaysShowDefaultBranchWorkspace !== false,
        showDotfilesByWorktree: sanitizeShowDotfilesByWorktree(ui.showDotfilesByWorktree),
        // Why: startup hydrates UI before repo catalogs, so defer repo-filter validation to the all-host refresh.
        filterRepoIds:
          validRepoIds.size === 0
            ? persistedFilterRepoIds
            : persistedFilterRepoIds.filter((repoId) => validRepoIds.has(repoId)),
        collapsedGroups: new Set(ui.collapsedGroups ?? []),
        uiZoomLevel: ui.uiZoomLevel ?? 0,
        editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
        worktreeCardProperties: normalizeWorktreeCardProperties(ui.worktreeCardProperties),
        _worktreeCardModeDefaulted: ui._worktreeCardModeDefaulted === true,
        agentActivityDisplayMode: normalizeAgentActivityDisplayMode(ui.agentActivityDisplayMode),
        workspaceStatuses: normalizeWorkspaceStatuses(ui.workspaceStatuses),
        workspaceBoardOpacity: clampWorkspaceBoardOpacity(ui.workspaceBoardOpacity),
        workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(ui.workspaceBoardColumnWidth),
        syncTaskStatusFromWorkspaceBoard: ui.syncTaskStatusFromWorkspaceBoard === true,
        statusBarItems: statusBarItemsWithGrok,
        statusBarVisible: ui.statusBarVisible ?? true,
        usagePercentageDisplay: normalizeUsagePercentageDisplay(ui.usagePercentageDisplay),
        statusBarUsageMode: normalizeStatusBarUsageMode(ui.statusBarUsageMode),
        // Why: default true so existing users see the pet on first enabling the flag; only an explicit Hide persists false.
        petVisible: ui.petVisible ?? ui.sidekickVisible ?? true,
        petSize: clampPetSize(ui.petSize ?? ui.sidekickSize ?? PET_SIZE_DEFAULT),
        customPets,
        // Why: fall back to default when the persisted id is unknown (e.g. custom pet removed elsewhere) so the overlay renders.
        petId: ((): string => {
          const id = petId
          if (typeof id !== 'string') {
            return DEFAULT_PET_ID
          }
          if (isBundledPetId(id)) {
            return id
          }
          if (customPets.some((m) => m.id === id)) {
            return id
          }
          return DEFAULT_PET_ID
        })(),
        dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
        // Why: a persisted value from a build that knew a different channel set
        // would otherwise survive as-is; activeChannel only falls back on null,
        // so an unknown string reaches listBuilds and the segmented control.
        releaseChannelOverride: isReleaseChannel(ui.releaseChannelOverride)
          ? ui.releaseChannelOverride
          : null,
        updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
        osc52ClipboardDefaultOnNoticePending: ui.osc52ClipboardDefaultOnNoticePending === true,
        browserDefaultUrl: ui.browserDefaultUrl ?? null,
        browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
        browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(ui.browserDefaultZoomLevel),
        browserKagiSessionLink: normalizeKagiSessionLink(ui.browserKagiSessionLink ?? ''),
        taskResumeState: sanitizeTaskResumeState(ui.taskResumeState),
        featureTipsSeenIds: normalizeFeatureTipIds(ui.featureTipsSeenIds),
        featureInteractions: normalizeFeatureInteractions(ui.featureInteractions),
        contextualToursSeenIds: normalizeContextualTourIds(ui.contextualToursSeenIds),
        contextualToursAutoEligible:
          typeof ui.contextualToursAutoEligible === 'boolean'
            ? ui.contextualToursAutoEligible
            : null,
        trustedOrcaHooks: hydrateTrustedOrcaHooks(ui.trustedOrcaHooks, validRepoIds),
        setupScriptPromptDismissedRepoIds:
          validRepoHostIdentities.size === 0
            ? sanitizeSetupScriptPromptDismissals(ui.setupScriptPromptDismissedRepoIds)
            : filterSetupScriptPromptDismissalsToValidRepos(
                ui.setupScriptPromptDismissedRepoIds,
                validRepoHostIdentities
              ),
        setupGuideSidebarDismissed: ui.setupGuideSidebarDismissed === true,
        setupGuideBrowserMilestoneMigrated: ui.setupGuideBrowserMilestoneMigrated === true,
        setupGuideBrowserMilestoneLegacyComplete:
          ui.setupGuideBrowserMilestoneLegacyComplete === true,
        browserImportHintHidden: ui.browserImportHintHidden === true,
        mobileEmulatorTabIntroDismissed: ui.mobileEmulatorTabIntroDismissed === true,
        mobileEmulatorAgentSetupDismissed: ui.mobileEmulatorAgentSetupDismissed === true,
        projectOrderManualDefaultNoticeDismissed:
          ui.projectOrderManualDefaultNoticeDismissed === true,
        // Why: treat only explicit true as dismissed so a false from migration still surfaces.
        usagePercentageDisplayChangeNoticeDismissed:
          ui.usagePercentageDisplayChangeNoticeDismissed === true,
        // Why: default false so existing users still see the CTA; only explicit dismissal persists true.
        usageEmptyStateDismissed: ui.usageEmptyStateDismissed === true,
        // Why: stale acks are inert (paneKey reuse beats them via stateStartedAt); sanitizer bounds growth past HYDRATE_MAX_AGE_MS.
        acknowledgedAgentsByPaneKey: sanitizeAcknowledgedAgentsByPaneKey(
          ui.acknowledgedAgentsByPaneKey
        ),
        workspaceCleanupDismissals: sanitizeWorkspaceCleanupDismissals(
          ui.workspaceCleanup?.dismissals
        ),
        // Why the normalizer rather than a cast: this blob is hand-editable and
        // may come from an older or newer build; it degrades field by field
        // instead of bricking the cleanup dialog.
        // Why: a sync broadcast can carry stale browse state while its writer is debounced.
        workspaceCleanupBrowse:
          source === 'startup'
            ? normalizeWorkspaceCleanupBrowseState(ui.workspaceCleanup?.browse)
            : s.workspaceCleanupBrowse,
        // Why: restore only on startup; on 'sync' broadcasts it would clobber the window's current per-window view.
        activeView:
          source === 'startup'
            ? sanitizeHydratedActiveView(ui.activeView, s.settings?.experimentalActivity === true)
            : s.activeView,
        persistedUIReady: true
      }
      // The incoming payload is authoritative for the writer-owned fields, so it becomes the
      // writer's new diff baseline — but fields with an unflushed local edit (mirror diverged
      // from the previous baseline) keep the local value so a broadcast arriving inside the
      // writer's debounce window can't silently revert what the user just toggled (STA-5781).
      // Order matters: capture the baseline BEFORE overlaying pending edits, or the baseline
      // would equal the pending value, the diff would go empty, and the toggle would be dropped.
      // Note the width sanitizers above fall back to the CURRENT store value only for
      // non-numeric input (numbers are clamped in place), so a captured width can differ
      // from what main holds only for garbage payloads; at worst main keeps an
      // out-of-range width until the next drag re-writes it.
      const nextWriteBaseline = capturePersistedUIWriteBaseline(hydrated)
      const previousBaseline = s.persistedUIWriteBaseline
      if (previousBaseline) {
        const pendingLocalEdits = diffPersistedUIWriteFields(
          capturePersistedUIWriteBaseline(s),
          previousBaseline
        )
        Object.assign(hydrated, pendingLocalEdits)
        // In-flight fields too: a flip-back to the baseline value diffs empty,
        // yet the in-flight write's echo must not revert it (PR#17057 review).
        for (const field of Object.keys(
          s.persistedUIWriteInFlightCounts
        ) as (keyof PersistedUIWriteBaseline)[]) {
          ;(hydrated as Record<string, unknown>)[field] = s[field]
        }
      }
      // Why: return the same ref on identical hydration so App's debounced writer doesn't echo it back to main.
      // The baseline must still advance when it moved (a remote same-field write during an in-flight
      // ack pins the only visibly differing field, and our own echo precedes every ack) — but only
      // the two baseline keys, or every ordinary write's echo would churn the store's collection
      // identities and re-render identity-compared selectors once per write.
      // Why the generation bumps only on baseline movement: an unrelated-field
      // broadcast during an in-flight write would otherwise void that write's
      // fold and cost a redundant trailing re-send of identical values.
      const writeBaselineMoved =
        !previousBaseline ||
        Object.keys(diffPersistedUIWriteFields(nextWriteBaseline, previousBaseline)).length > 0
      const nextWriteBaselineGeneration = writeBaselineMoved
        ? s.persistedUIWriteBaselineGeneration + 1
        : s.persistedUIWriteBaselineGeneration
      if (hydratedUIPartialMatchesState(s, hydrated)) {
        if (!writeBaselineMoved) {
          return s
        }
        return {
          persistedUIWriteBaseline: nextWriteBaseline,
          persistedUIWriteBaselineGeneration: nextWriteBaselineGeneration
        }
      }
      return {
        ...hydrated,
        persistedUIWriteBaseline: nextWriteBaseline,
        persistedUIWriteBaselineGeneration: nextWriteBaselineGeneration
      }
    })
})
