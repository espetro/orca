/* eslint-disable max-lines -- Why: single cohesive mobile tab operations cluster */
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type {
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSessionTabCloseReason,
  RuntimeSyncedTab
} from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { SESSION_TAB_NOT_FOUND_ERROR } from '../../shared/session-tab-close'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { BrowserBackend } from '../browser/browser-backend'
import type { WatcherRemovalDeadline } from '../ipc/watcher-removal-drain'
import type { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import type { Store } from '../persistence'
import type { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { applyBrowserSessionTabSelection } from './browser-session-tab-selection-snapshot'
import type { BrowserSessionTabSelectionOptions } from './browser-tab-create-publication'
import type { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import {
  committedMobileSessionTabClose,
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'
import type { RuntimeFileCommands } from './orca-runtime-files'
import type {
  ResolvedWorktree,
  RuntimeHeadlessTerminal,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyWorktreeRecord,
  RuntimeStore
} from './orca-runtime'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeMobileSessionFacade } from './runtime-mobile-session-facade'
import type { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import type { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import type { RuntimePtyWorktrees } from './runtime-pty-worktrees'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import type { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'

export type RuntimeMobileTabOperationsDeps = {
  applySeededAgentStatus: (ptyId: string, title: string) => void
  assertStableReadyGraph: (expectedGraphEpoch: number) => void
  browserTabClose: (params: {
    index?: number
    page?: string
    worktree?: string
  }) => Promise<{ closed: boolean }>
  captureReadyGraphEpoch: () => number
  clientHostedBrowserRows: ClientHostedBrowserRowPublisher
  clientSessionTabSelections: () => ClientSessionTabSelectionStore
  closeFileWatchersForRemoval: () => (
    worktreePath: string,
    connectionId?: string,
    deadline?: WatcherRemovalDeadline
  ) => Promise<void>
  closeStructuredAgentSessionTab: (
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionAgentTab
  ) => void
  collectBrowserGroupAssignment: (
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    browserTabIds: readonly string[]
  ) => Map<string, string>
  fileCommands: RuntimeFileCommands
  forgetFileWatchersAfterRemoval: () => (worktreePath: string, connectionId?: string) => void
  getAvailableAuthoritativeWindow: () => BrowserWindow | null
  getPtyOutputSequence: (ptyId: string) => number
  getTerminalSize: (ptyId: string) => { cols: number; rows: number } | null
  getTrackedRawTitleForPty: () => (ptyId: string) => string | null
  getValidatedExplicitWorktreeIdSelector: (selector: string | undefined) => string | null
  getWorkspaceSessionForWorktree: (worktreeId: string) => WorkspaceSessionState | null
  hasRecentExpiredSshLeasePane: (
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ) => boolean
  hasRecentTerminalOutputPath: (handle: string, pathText: string, absolutePath: string) => boolean
  hasServeOrSshOwnedBinding: (tab: RuntimeMobileSessionTerminalTab) => boolean
  headlessHydrationState: Map<string, 'pending' | 'done'>
  headlessTerminals: Map<string, RuntimeHeadlessTerminal>
  isHeadlessBuiltMobileSessionPublicationBase: (publicationEpoch: string) => boolean
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  mobileSessionTabsChangeSequence: number
  notifier: () => RuntimeNotifier | null
  offscreenBrowserBackend: () => BrowserBackend | null
  persistClientHostedBrowserPagesForWorktree: (worktreeId: string) => void
  persistedClientHostedBrowserWorktreeIds: Set<string>
  providerSnapshotPreferredPtys: Set<string>
  ptyController: () => RuntimePtyController | null
  ptyWorktrees: () => RuntimePtyWorktrees
  recordRecentPtyOutputForPathProvenance: (ptyId: string, data: string) => void
  rendererPublicationThrottle: RendererPublicationThrottle
  repointPendingMessagesForHandle: (handle: string) => void
  republishMobileSessionTabsSnapshot: (worktreeId: string) => void
  requireStore: () => Store
  resolveKnownWorkspaceFileTarget: (
    absolutePath: string,
    executionHostId: ExecutionHostId
  ) => Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
    relativePath: string
  } | null>
  resolveRuntimeFileTarget: (worktreeSelector: string) => Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
  }>
  resolveRuntimeGitTarget: (worktreeSelector: string) => Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    connectionId?: string
    localGitOptions?: { wslDistro?: string }
  }>
  resolveTerminalContext: (
    handle: string
  ) => { worktreeId: string; connectionId: string | null } | null
  resolveTerminalCwd: (handle: string) => Promise<string | null>
  resolveTerminalFileUriHostname: (handle: string) => string | null
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  restoreFileWatchersAfterFailedRemoval: () => (
    worktreePath: string,
    connectionId?: string
  ) => Promise<void>
  retireRuntimeOwnedBrowserSessionTab: (worktreeId: string, browserPageId: string) => boolean
  runtimeId: () => `${string}-${string}-${string}-${string}-${string}`
  snapshotValueComparison: () => RuntimeMobileSnapshotValueComparisonCommands
  store: () => RuntimeStore | null
  tabs: Map<string, RuntimeSyncedTab>
  terminalClusterFacade: () => RuntimeTerminalCluster
  workspaceSessionHasRuntimeOwnedPtyCandidate: (session: unknown) => boolean
  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: (
    session: unknown,
    worktreeId: string,
    tabs: unknown
  ) => boolean
  recordOsc7MetadataForPty: () => (
    ptyId: string,
    data: string
  ) => { cwd: string | null; cwdChanged: boolean }
  buildHeadlessMobileSessionBrowserTabs: (worktreeId: string) => RuntimeMobileSessionBrowserTab[]
  buildHeadlessMobileSessionTerminalTabs: (
    worktreeId: string,
    persistedTabs: readonly TerminalTab[],
    session: WorkspaceSessionState
  ) => RuntimeMobileSessionTerminalTab[]
  headlessMobileSnapshotContentUnchanged: (
    existing: RuntimeMobileSessionTabsSnapshot,
    next: RuntimeMobileSessionTabsSnapshot
  ) => boolean
  isRuntimeOwnedHeadlessMobileTab: (
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ) => boolean
  mergeMobileSessionSnapshotTabs: (
    baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
    extraTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ) => RuntimeMobileSessionSnapshotTab[]
  mergeMobileSessionTabGroups: (
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    terminalTabs: readonly RuntimeMobileSessionTerminalTab[],
    activeTab: RuntimeMobileSessionTerminalTab | null
  ) => RuntimeMobileSessionTabGroup[]
  notifyMobileSessionTabSnapshots: () => void
  reconcileHeadlessMobileSessionBrowserTabs: (
    worktreeId: string,
    existing: RuntimeMobileSessionTabsSnapshot
  ) => void
  mobileSessionFacade: () => RuntimeMobileSessionFacade
  mobileTabSnapshots: () => RuntimeMobileSessionTabSnapshotCommands
}

export class RuntimeMobileTabOperations {
  private readonly deps: RuntimeMobileTabOperationsDeps

  constructor(deps: RuntimeMobileTabOperationsDeps) {
    this.deps = deps
  }

  applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.deps
      .mobileSessionFacade()
      .applyMobileSessionTabNavigation(snapshot, activeTabId, navigation, clientNavigationId)
  }

  cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    return this.deps.mobileSessionFacade().cancelScheduledMobileSessionTabsChanged(worktreeId)
  }

  clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: unknown,
    parentTabId: string
  ) {
    return this.deps
      .mobileSessionFacade()
      .clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, parentTabId)
  }

  closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowMissingPersistedTab?: boolean; killPtys?: boolean } = {}
  ): void {
    return this.deps
      .terminalClusterFacade()
      .closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, options)
  }

  async closeMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    options: {
      reason?: RuntimeSessionTabCloseReason
      expectedPublicationEpoch?: string
      expectedTerminalHandle?: string
      clientNavigationId?: string
      localPtyTeardownOwnedExternally?: boolean
    } = {}
  ): Promise<MobileSessionTabCloseOutcome> {
    const graphEpoch = options.clientNavigationId ? this.deps.captureReadyGraphEpoch() : null
    const explicitWorktreeId = this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.deps.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const observedPtyIds = await this.refreshMobileSessionPtyRecords()
    if (graphEpoch !== null) {
      this.deps.assertStableReadyGraph(graphEpoch)
    }
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId)
    const snapshot = this.deps.mobileSessionTabsByWorktree.get(worktreeId)
    if (options.reason !== undefined && options.reason !== 'user' && observedPtyIds === null) {
      // Why: keep-on-unknown must also restore the mirror the caller already pruned.
      this.deps.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('unknown-liveness', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    if (
      options.expectedPublicationEpoch !== undefined &&
      snapshot?.publicationEpoch !== options.expectedPublicationEpoch
    ) {
      this.deps.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('stale-publication', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    const tab =
      snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
      ) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
      )
    if (!snapshot || !tab) {
      throw new Error('tab_not_found')
    }
    if (options.expectedTerminalHandle !== undefined) {
      const terminalIncarnationMatches =
        tab.type === 'terminal' &&
        snapshot.tabs.some(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tab.parentTabId &&
            this.getMobileSessionTerminalHandle(worktreeId, candidate) ===
              options.expectedTerminalHandle
        )
      if (!terminalIncarnationMatches) {
        this.deps.republishMobileSessionTabsSnapshot(worktreeId)
        return refusedMobileSessionTabClose('stale-terminal', {
          snapshotRepublished: true
        })
      }
    }
    let closedSelectionTabIds = [tab.id]
    const finishCommittedClose = (): MobileSessionTabCloseOutcome =>
      committedMobileSessionTabClose(
        this.deps.clientSessionTabSelections(),
        worktreeId,
        closedSelectionTabIds
      )
    if (tab.type === 'terminal') {
      const parentLeafCount = snapshot.tabs.filter(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
      ).length
      const closingWholeParent = tab.id !== tabId || parentLeafCount <= 1
      if (closingWholeParent) {
        closedSelectionTabIds = snapshot.tabs.flatMap((candidate) =>
          candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
            ? [candidate.id, candidate.parentTabId]
            : []
        )
      }
      // Why: a non-'user' reason is a client-lifecycle echo ("terminal gone"),
      // not authorization to kill. Every destructive branch below can take the
      // whole parent down, so any live PTY under the parent means the echo is a
      // transport artifact: refuse the close and republish the snapshot so the
      // echoing client re-syncs and re-attaches. A reasonless close keeps
      // legacy behavior — old clients send user closes without the field.
      if (options.reason !== undefined && options.reason !== 'user') {
        const parentLeaves = snapshot.tabs.filter(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
        )
        // Why: exited PTYs keep a disconnected record in ptysById for status
        // reads (and a still-synced leaf retains its record), so record
        // presence is not liveness — only `connected` counts, or a genuinely
        // dead tab never retires and the echo loops forever.
        const leafHasConnectedPty = (leaf: RuntimeMobileSessionTerminalTab): boolean => {
          const snapshotPtyIds = [
            leaf.ptyId,
            leaf.parentLayout?.ptyIdsByLeafId?.[leaf.leafId]
          ].filter((ptyId): ptyId is string => Boolean(ptyId))
          // Why: daemon discovery can prove the PTY live before its pane binding
          // reconnects; missing metadata is never authority to retire it.
          return (
            this.findPtyForMobileTerminalTab(worktreeId, leaf)?.connected === true ||
            snapshotPtyIds.some((ptyId) => observedPtyIds?.has(ptyId) === true)
          )
        }
        if (parentLeaves.some(leafHasConnectedPty)) {
          // Why: when the echo addresses a dead leaf under a live sibling we
          // still refuse (every reachable close path below destroys the whole
          // parent, live sibling included) but skip the republish — re-adding
          // the dead leaf on the echoing client would feed an endless
          // refuse→republish→re-echo cycle.
          const addressedDeadLeaf = tab.id === tabId && !leafHasConnectedPty(tab)
          if (!addressedDeadLeaf) {
            this.deps.republishMobileSessionTabsSnapshot(worktreeId)
          }
          // Why: both markers are skew-safe; clients must restore a mirror only
          // when the host actually republished it, not for a dead leaf.
          return refusedMobileSessionTabClose('live-host-pty', {
            snapshotRepublished: !addressedDeadLeaf
          })
        }
        if (!closingWholeParent || this.deps.tabs.has(tab.parentTabId)) {
          // Why: only the renderer may retire its own tab or split leaf; a
          // remote lifecycle echo must never cross that boundary into a kill.
          return refusedMobileSessionTabClose('retirement-owner')
        }
      }
      // Why: a runtime-owned headless tab is absent from renderer state, so the
      // closeTerminalTab relay below would ack success without killing its PTY,
      // and syncMobileSessionTabs would republish the "closed" tab. Only bypass
      // the relay when no renderer owns the parent: an adopted tab needs the
      // renderer's live pin guard and durable close transaction.
      if (closingWholeParent && !this.deps.tabs.has(tab.parentTabId)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          killPtys: options.reason === undefined || options.reason === 'user'
        })
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        this.deps.store()?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (closingWholeParent && this.deps.notifier()?.closeTerminalTab) {
        // Why: whole-tab close is a lifecycle transaction. The renderer reply
        // arrives only after canonical retirement and a forced session flush.
        const win = this.deps.getAvailableAuthoritativeWindow()
        if (win?.webContents.isDestroyed?.()) {
          throw new Error('runtime_unavailable')
        }
        const releasePublicationThrottle =
          options.clientNavigationId && win
            ? this.deps.rendererPublicationThrottle.acquire(win.webContents)
            : () => {}
        try {
          await (options.localPtyTeardownOwnedExternally
            ? this.deps.notifier()!.closeTerminalTab!(tab.parentTabId, {
                localPtyTeardownOwnedExternally: true
              })
            : this.deps.notifier()!.closeTerminalTab!(tab.parentTabId))
        } finally {
          releasePublicationThrottle()
        }
        const remainingSnapshot = this.deps.mobileSessionTabsByWorktree.get(worktreeId)
        const remainingTab = remainingSnapshot?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
        )
        if (
          remainingSnapshot &&
          remainingTab &&
          this.deps.isRuntimeOwnedHeadlessMobileTab(worktreeId, remainingTab)
        ) {
          // Why: after relay recovery the renderer can acknowledge a tab it no longer mirrors; the HUB must still retire its SSH-owned surface.
          this.closeHeadlessMobileTerminalTab(worktreeId, remainingSnapshot, remainingTab, {
            // Why: the renderer may already have durably removed the tab before acknowledging.
            allowMissingPersistedTab: true
          })
          this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
          this.deps.store()?.flushOrThrow?.()
        }
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
        return finishCommittedClose()
      }
      // Why: notifier implementations without the acknowledged relay may expose
      // only raw pane close. Runtime-owned parents still need de-persist + kill.
      if (closingWholeParent && this.deps.isRuntimeOwnedHeadlessMobileTab(worktreeId, tab)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab)
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        this.deps.store()?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (!this.deps.notifier()?.closeTerminal) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab)
        this.deps.store()?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (tab.id === tabId) {
        const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
        if (pty) {
          if (this.deps.ptyController()?.kill(pty.ptyId) !== true) {
            throw new Error('terminal_close_failed')
          }
          return finishCommittedClose()
        }
        this.deps.notifier()!.closeTerminal(tab.parentTabId)
        return delegatedMobileSessionTabClose()
      }
      // Why: paired web tab bars represent a split terminal with one local
      // parent tab id. Closing that parent should close the desktop tab, not
      // just whichever leaf happened to be first in the session snapshot.
      this.deps.notifier()!.closeTerminal(tab.parentTabId)
      this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
      return delegatedMobileSessionTabClose()
    } else if (tab.type === 'browser') {
      // Why: a browser tab can be hosted by a client, by the offscreen backend,
      // or by the renderer; each surface owns a different retirement path.
      const clientPage = tab.browserPageId
        ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        : undefined
      if (clientPage) {
        await this.deps.browserTabClose({
          worktree: `id:${worktreeId}`,
          page: clientPage.browserPageId
        })
      } else if (this.isOffscreenMobileSessionBrowserTab(snapshot, tab)) {
        await this.deps
          .offscreenBrowserBackend()!
          .closeTab(tab.browserPageId!)
          .catch(() => {})
        this.deps.retireRuntimeOwnedBrowserSessionTab(worktreeId, tab.browserPageId!)
      } else {
        if (!this.deps.notifier()?.closeSessionTab) {
          throw new Error('runtime_unavailable')
        }
        await this.deps.notifier()!.closeSessionTab!(tab.id, worktreeId)
      }
    } else if (tab.type === 'agent-session') {
      if (this.deps.notifier()?.closeSessionTab) {
        try {
          await this.deps.notifier()!.closeSessionTab!(
            structuredAgentSessionTabId(tab.sessionId),
            worktreeId
          )
        } catch (error) {
          // The renderer already having removed the tab is an idempotent close, not a veto.
          if (!(error instanceof Error && error.message === SESSION_TAB_NOT_FOUND_ERROR)) {
            throw error
          }
        }
      }
      this.deps.closeStructuredAgentSessionTab(worktreeId, snapshot, tab)
    } else {
      if (!this.deps.notifier()?.closeSessionTab) {
        throw new Error('runtime_unavailable')
      }
      await this.deps.notifier()!.closeSessionTab!(tab.id, worktreeId)
    }
    return finishCommittedClose()
  }

  disposeHeadlessTerminal(ptyId: string): void {
    return this.deps.terminalClusterFacade().disposeHeadlessTerminal(ptyId)
  }

  emitMobileSessionTabsSnapshot(snapshot: unknown) {
    return this.deps.mobileTabSnapshots().emitMobileSessionTabsSnapshot(snapshot as never)
  }

  findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    return this.deps.terminalClusterFacade().findPtyForMobileTerminalTab(worktreeId, tab, options)
  }

  getHeadlessMobileSessionGroupId() {
    return this.deps.terminalClusterFacade().getHeadlessMobileSessionGroupId()
  }

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.deps
      .terminalClusterFacade()
      .getMobileSessionTabsForWorktree(worktreeId, clientNavigationId)
  }

  getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    return this.deps.terminalClusterFacade().getMobileSessionTerminalHandle(worktreeId, tab)
  }

  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    } = {}
  ): Set<string> {
    // Why: report which worktrees were reconciled in place so callers don't
    // reconcile them a second time (see notifyMobileSessionTabsChanged).
    const reconciledWorktreeIds = new Set<string>()
    if (this.deps.getAvailableAuthoritativeWindow() && options.allowAttachedWindow !== true) {
      return reconciledWorktreeIds
    }
    const session =
      options.workspaceSession ??
      (worktreeId
        ? this.deps.getWorkspaceSessionForWorktree(worktreeId)
        : this.deps.store()?.getWorkspaceSession?.())
    if (!session) {
      return reconciledWorktreeIds
    }
    // Why: with no runtime-owned candidate in the session and no offscreen
    // browser backend, this hydrate provably builds zero tabs for
    // every worktree — skip the per-worktree rebuild entirely (hot on every
    // graph sync). Scoped to onlyRuntimeOwnedTerminals so full hydrates are
    // untouched.
    if (
      options.onlyRuntimeOwnedTerminals === true &&
      !this.deps.offscreenBrowserBackend() &&
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId ?? '').length === 0 &&
      options.runtimeOwnedTerminalCandidateKnown !== true &&
      !(worktreeId
        ? this.deps.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
            session,
            worktreeId,
            session.tabsByWorktree[worktreeId] ?? []
          )
        : this.deps.workspaceSessionHasRuntimeOwnedPtyCandidate(session))
    ) {
      return reconciledWorktreeIds
    }
    const entries =
      worktreeId !== undefined
        ? ([[worktreeId, session.tabsByWorktree[worktreeId] ?? []]] as const)
        : Object.entries(session.tabsByWorktree ?? {})
    // Why: workspaceSession keys are `${repoId}::${path}` and are not pruned when
    // a repo disappears from this client's view (e.g. removed on another client,
    // or a stale browser-persisted session). Hydrating such a key would surface a
    // phantom "unknown"/duplicate workspace with no live repo behind it. Only
    // hydrate sessions whose repo still exists; leave unparseable keys alone.
    // Resolved lazily so unparseable keys (floating terminals) never pay for a
    // repo inventory on the hot poll path, and `null` when the store cannot
    // report repos — an unavailable list must not read as "every repo is gone".
    let liveRepoIds: Set<string> | null | undefined
    for (const [entryWorktreeId, persistedTabs] of entries) {
      const ownerRepoId = splitWorktreeIdForFilesystem(entryWorktreeId)?.repoId
      if (ownerRepoId) {
        if (liveRepoIds === undefined) {
          const knownRepos = this.deps.store()?.getRepos?.()
          liveRepoIds = knownRepos ? new Set(knownRepos.map((repo) => repo.id)) : null
        }
        if (liveRepoIds && !liveRepoIds.has(ownerRepoId)) {
          continue
        }
      }
      const existing = this.deps.mobileSessionTabsByWorktree.get(entryWorktreeId)
      if (
        existing &&
        existing.tabs.length > 0 &&
        options.force !== true &&
        options.onlyRuntimeOwnedTerminals !== true
      ) {
        // Why: terminals are stable/persisted so we normally skip a rebuild, but
        // offscreen browser tabs are live and may have been created/closed since.
        // Reconcile just the browser tabs against the live bridge instead of
        // leaving a stale snapshot that omits a freshly-opened browser tab.
        this.deps.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, existing)
        reconciledWorktreeIds.add(entryWorktreeId)
        continue
      }
      const terminalTabs = this.deps
        .buildHeadlessMobileSessionTerminalTabs(entryWorktreeId, persistedTabs, session)
        .filter(
          (tab) =>
            options.onlyRuntimeOwnedTerminals !== true ||
            this.deps.hasServeOrSshOwnedBinding(tab) ||
            this.deps.hasRecentExpiredSshLeasePane(entryWorktreeId, tab)
        )
      // Why: offscreen browser panes are live-only (no persisted session entry),
      // so include them on every hydrate regardless of the onlyRuntimeOwnedTerminals
      // filter, which is about terminal PTY ownership and never applies to browsers.
      const browserTabs = this.deps.buildHeadlessMobileSessionBrowserTabs(entryWorktreeId)
      const tabs: RuntimeMobileSessionSnapshotTab[] = [...terminalTabs, ...browserTabs]
      if (tabs.length === 0) {
        continue
      }
      const activeTab = this.pickHeadlessActiveTerminalTab(terminalTabs)
      const tabOrder = [
        ...this.collectHeadlessParentTabOrder(terminalTabs),
        ...browserTabs.map((tab) => tab.id)
      ]
      const groupId = this.getHeadlessMobileSessionGroupId()
      const mergedTabs =
        options.onlyRuntimeOwnedTerminals === true && existing
          ? this.deps.mergeMobileSessionSnapshotTabs(existing.tabs, tabs)
          : tabs
      const mergedActiveTab =
        existing?.tabs.find((tab) => tab.id === existing.activeTabId) ??
        activeTab ??
        mergedTabs[0] ??
        null
      const mergedTerminalTabs = mergedTabs.filter(
        (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
      )
      const mergedBrowserOrder = mergedTabs
        .filter((tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser')
        .map((tab) => tab.id)
      // Why: a persisted multi-group split must be restored on cold rebuild, or
      // the headless serve coalesces the user's group layout back into one group
      // (the persisted tabGroups/tabGroupLayouts would otherwise be write-only).
      const persistedGroups = session.tabGroups?.[entryWorktreeId]
      const persistedLayout = session.tabGroupLayouts?.[entryWorktreeId]
      const hasPersistedSplit =
        options.onlyRuntimeOwnedTerminals !== true &&
        persistedGroups !== undefined &&
        persistedGroups.length > 1
      const activeTopLevelId = mergedActiveTab
        ? mergedActiveTab.type === 'terminal'
          ? mergedActiveTab.parentTabId
          : mergedActiveTab.id
        : null
      const nextTabGroups: RuntimeMobileSessionTabGroup[] = hasPersistedSplit
        ? this.deps.snapshotValueComparison().appendBrowserTabOrder(
            this.distributeHeadlessTabsAcrossGroups(
              persistedGroups.map((group) => ({
                id: group.id,
                activeTabId: group.activeTabId,
                tabOrder: [...group.tabOrder],
                ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
              })),
              this.collectHeadlessParentTabOrder(mergedTerminalTabs),
              activeTopLevelId
            ),
            mergedBrowserOrder,
            undefined,
            // Why: distribute drops browser ids (terminal-only), so carry each
            // browser's persisted group forward instead of coalescing left.
            this.deps.collectBrowserGroupAssignment(persistedGroups, mergedBrowserOrder)
          )
        : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroups
          ? this.deps
              .snapshotValueComparison()
              .appendBrowserTabOrder(
                this.deps.mergeMobileSessionTabGroups(
                  entryWorktreeId,
                  existing.tabGroups,
                  mergedTerminalTabs,
                  mergedActiveTab?.type === 'terminal' ? mergedActiveTab : null
                ),
                mergedBrowserOrder
              )
          : [
              {
                id: groupId,
                activeTabId: mergedActiveTab?.id
                  ? (activeTab?.parentTabId ?? mergedActiveTab.id)
                  : (tabOrder[0] ?? null),
                tabOrder
              }
            ]
      // Why: merging runtime tabs INTO a renderer publication must not reclass
      // the snapshot as headless-built — the preservation predicate would then
      // treat the renderer's own tabs as runtime-owned and resurrect tabs the
      // renderer later closes. Keep the renderer base epoch with a merge suffix
      // (idempotent) so ownership stays derivable from the epoch.
      const mergedIntoRendererPublication =
        options.onlyRuntimeOwnedTerminals === true &&
        existing !== undefined &&
        !this.deps.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
      const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: existing?.worktree ?? entryWorktreeId,
        publicationEpoch: mergedIntoRendererPublication
          ? this.getMergedMobileSessionPublicationEpoch(existing, tabs)
          : `headless-hydrated:${Date.now().toString(36)}`,
        snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
        activeGroupId: existing?.activeGroupId ?? groupId,
        activeTabId: mergedActiveTab?.id ?? null,
        activeTabType: mergedActiveTab?.type ?? null,
        tabGroups: nextTabGroups,
        // Why: the runtime-owned rebuild runs on every graph sync — carry the
        // existing split layout forward or each sync drops it and fans out.
        ...(hasPersistedSplit && persistedLayout
          ? { tabGroupLayout: persistedLayout }
          : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroupLayout
            ? { tabGroupLayout: existing.tabGroupLayout }
            : {}),
        tabs: mergedTabs
      }
      // Why: the runtime-owned hydrate runs on EVERY graph sync; when the rebuilt
      // projection matches the existing snapshot, keep the existing object and
      // (epoch, version) untouched so identity-based change detection stays a
      // pure no-op and unchanged runtime/browser worktrees never fan out.
      if (existing && this.deps.headlessMobileSnapshotContentUnchanged(existing, nextSnapshot)) {
        continue
      }
      this.deps.mobileSessionTabsByWorktree.set(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
  }

  isOffscreenMobileSessionBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    return this.deps.mobileSessionFacade().isOffscreenMobileSessionBrowserTab(snapshot, tab)
  }

  markHeadlessBrowserSessionTabActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void {
    if (!worktreeId) {
      return
    }
    const { targetGroupId, focusesHost } = options
    // Why: client-placed pages publish through the page registry and need no offscreen backing.
    if (
      !this.deps.offscreenBrowserBackend() &&
      !getRuntimeBrowserPageRegistry(this).getPage(browserPageId)
    ) {
      return
    }
    // Hydrate first so the freshly created browser tab is present in the snapshot.
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.deps.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!snapshot || !tab) {
      return
    }
    const {
      snapshot: nextSnapshot,
      groups: nextGroups,
      placedInTargetGroup
    } = applyBrowserSessionTabSelection({
      snapshot,
      tabId: tab.id,
      ...(targetGroupId !== undefined ? { targetGroupId } : {}),
      focusesHost,
      publicationEpoch: `headless:${Date.now().toString(36)}`
    })
    this.deps.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    // Why: browser group membership is otherwise live-only; persist it so a
    // later rebuild keeps the browser in its group instead of coalescing left.
    if (placedInTargetGroup && nextSnapshot.tabGroupLayout) {
      this.persistHeadlessTabGroups(worktreeId, nextGroups, nextSnapshot.tabGroupLayout)
    }
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    if (options.caller) {
      // Why: the originating device still lands on the tab it just created; only the shared
      // snapshot stayed put. Local creates keep the pre-navigation shape by having no caller.
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        tab.id,
        options.caller.navigation,
        options.caller.clientNavigationId
      )
    }
  }

  maybeHydrateHeadlessFromRenderer(ptyId: string): void {
    if (this.deps.headlessHydrationState.has(ptyId)) {
      return
    }
    const providerSnapshotPreferred = this.deps.providerSnapshotPreferredPtys.has(ptyId)
    if (this.deps.headlessTerminals.has(ptyId) && !providerSnapshotPreferred) {
      // Daemon-snapshot seed already populated the emulator — skip hydration.
      this.deps.headlessHydrationState.set(ptyId, 'done')
      return
    }
    const controller = this.deps.ptyController()
    if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
      return
    }
    if (!controller.hasRendererSerializer(ptyId)) {
      // Renderer hasn't registered yet (or never will). Live writes lazy-
      // create the state via trackHeadlessTerminalData on this same tick.
      return
    }

    if (providerSnapshotPreferred) {
      // Why: a stream byte can create a partial model before restored history
      // arrives. A mounted renderer snapshot can safely replace that model.
      this.disposeHeadlessTerminal(ptyId)
    }

    this.deps.headlessHydrationState.set(ptyId, 'pending')
    const dims = this.deps.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    // Why: hydration writes below never set forwardQueryReplies (main-side
    // replay guard) — renderer-buffer snapshots can embed stale queries.
    const state = this.deps.ptyWorktrees().createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.deps.getPtyOutputSequence(ptyId)
    this.deps.headlessTerminals.set(ptyId, state)

    // Why: append the seed work to writeChain so live writes queued by
    // trackHeadlessTerminalData (after this method returns synchronously)
    // execute AFTER the seed-write resolves. If we awaited inline before
    // setting headlessTerminals, the live byte would lazy-create a separate
    // state and the seed-resolve would overwrite it, dropping live bytes.
    state.writeChain = state.writeChain.then(async () => {
      try {
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
          altScreenForcesZeroRows: true
        })
        if (!rendered || rendered.data.length === 0) {
          return
        }
        this.deps.recordOsc7MetadataForPty()(ptyId, rendered.data)
        this.deps.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
        // Resize to renderer's dims so the seed reflows correctly into the
        // emulator's grid, then resize back to PTY dims (if known) so live
        // writes use the correct cell layout.
        if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
          state.emulator.resize(rendered.cols, rendered.rows)
        }
        await state.emulator.write(rendered.data)
        const ptyDims = this.deps.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          state.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        // Why: the renderer xterm no longer sees synthetic hook title frames
        // (they feed main's tracker only), so its serializer lastTitle can be
        // stale here. Prefer main's tracked title; the renderer's is only the
        // seed when main has observed none (fresh relaunch, cold tracker).
        state.ownership.seedOwner(undefined, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        const seedTitle = this.deps.getTrackedRawTitleForPty()(ptyId) ?? rendered.lastTitle
        if (seedTitle) {
          state.emulator.setLastTitle(seedTitle)
          this.deps.applySeededAgentStatus(ptyId, seedTitle)
        }
        this.deps.providerSnapshotPreferredPtys.delete(ptyId)
      } catch {
        // Hydration is best-effort. Live writes continue via the same
        // writeChain that this catch-arm leaves intact.
      } finally {
        this.deps.headlessHydrationState.set(ptyId, 'done')
      }
    })
  }

  notifyMobileSessionTabsChanged(worktreeId?: string): void {
    if (!worktreeId) {
      this.deps.clientHostedBrowserRows.publishAll()
      for (const id of new Set([
        ...this.deps.persistedClientHostedBrowserWorktreeIds,
        ...getRuntimeBrowserPageRegistry(this)
          .listPages()
          .map((page) => page.workspaceId)
      ])) {
        this.deps.persistClientHostedBrowserPagesForWorktree(id)
      }
      this.deps.notifyMobileSessionTabSnapshots()
      return
    }
    // Why: every client-page mutation — create, navigate, metadata, host quit, recovery — reaches
    // this announcement, so the host's own rows derive from it rather than from a second seam.
    this.deps.clientHostedBrowserRows.publish(worktreeId)
    this.deps.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const hasClientBrowserPages =
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId).length > 0
    if (this.deps.offscreenBrowserBackend() || hasClientBrowserPages) {
      const reconciled = this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId,
        hasClientBrowserPages
          ? { allowAttachedWindow: true, onlyRuntimeOwnedTerminals: true }
          : undefined
      )
      // Why: hydrate already reconciles an existing snapshot in place; only reconcile here when it didn't (fresh build or early-returned hydrate).
      if (!reconciled.has(worktreeId)) {
        const existing = this.deps.mobileSessionTabsByWorktree.get(worktreeId)
        if (existing) {
          this.deps.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
        }
      }
    }
    // Why: structural changes must propagate promptly; cancel any pending coalesced notify since this immediate emit supersedes it.
    this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.deps.mobileSessionTabsChangeSequence)
  }

  notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    return this.deps
      .mobileSessionFacade()
      .notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  notifyRendererOfHeadlessTerminalClose(parentTabId: string): void {
    return this.deps.terminalClusterFacade().notifyRendererOfHeadlessTerminalClose(parentTabId)
  }

  persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ): void {
    return this.deps.terminalClusterFacade().persistHeadlessTabGroups(worktreeId, groups, layout)
  }

  async refreshMobileSessionPtyRecords(
    targetWorktreeId: string | null = null
  ): Promise<Set<string> | null> {
    return this.deps.mobileSessionFacade().refreshMobileSessionPtyRecords(targetWorktreeId)
  }

  restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    return this.deps
      .terminalClusterFacade()
      .restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId, options)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    return this.deps
      .mobileSessionFacade()
      .saveMobileMarkdownTab(worktreeSelector, tabId, baseVersion, content)
  }

  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }
  ): Promise<{ updated: true }> {
    return this.deps.terminalClusterFacade().setMobileSessionTabProps(worktreeSelector, args)
  }

  pickHeadlessActiveTerminalTab(
    tabs: readonly RuntimeMobileSessionTerminalTab[]
  ): RuntimeMobileSessionTerminalTab | null {
    return tabs.find((tab) => tab.isActive) ?? tabs.find((tab) => tab.parentTabId) ?? null
  }

  collectHeadlessParentTabOrder(tabs: readonly RuntimeMobileSessionTerminalTab[]): string[] {
    const order: string[] = []
    const seen = new Set<string>()
    for (const tab of tabs) {
      if (!seen.has(tab.parentTabId)) {
        seen.add(tab.parentTabId)
        order.push(tab.parentTabId)
      }
    }
    return order
  }

  distributeHeadlessTabsAcrossGroups(
    existingGroups: readonly RuntimeMobileSessionTabGroup[],
    tabOrder: readonly string[],
    activeTopLevelId: string | null,
    newTabAssignment?: { tabId: string; groupId: string }
  ): RuntimeMobileSessionTabGroup[] {
    const groupIdByTabId = new Map<string, string>()
    for (const group of existingGroups) {
      for (const tabId of group.tabOrder) {
        groupIdByTabId.set(tabId, group.id)
      }
    }
    const hasTargetGroup =
      newTabAssignment !== undefined &&
      existingGroups.some((group) => group.id === newTabAssignment.groupId)
    if (hasTargetGroup) {
      groupIdByTabId.set(newTabAssignment!.tabId, newTabAssignment!.groupId)
    }
    const activeGroupId =
      (activeTopLevelId ? groupIdByTabId.get(activeTopLevelId) : undefined) ?? existingGroups[0]!.id
    const orderByGroup = new Map<string, string[]>(existingGroups.map((group) => [group.id, []]))
    for (const tabId of tabOrder) {
      const groupId = groupIdByTabId.get(tabId) ?? activeGroupId
      orderByGroup.get(groupId)?.push(tabId)
    }
    return existingGroups
      .map((group) => {
        const nextOrder = orderByGroup.get(group.id) ?? []
        return {
          ...group,
          tabOrder: nextOrder,
          activeTabId:
            activeTopLevelId && nextOrder.includes(activeTopLevelId)
              ? activeTopLevelId
              : group.activeTabId && nextOrder.includes(group.activeTabId)
                ? group.activeTabId
                : (nextOrder[0] ?? null)
        }
      })
      .filter((group) => group.tabOrder.length > 0)
  }

  getMergedMobileSessionPublicationEpoch(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    preservedTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): string {
    // Why: preserved snapshots can merge repeatedly; strip the prior merge suffix first so the publication epoch stays idempotent.
    const normalizedPublicationEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    const signature = createHash('sha1')
      .update(
        preservedTabs
          .map((tab) =>
            tab.type === 'terminal'
              ? `${tab.id}:${tab.parentTabId}:${tab.ptyId ?? ''}:${tab.leafId}`
              : tab.id
          )
          .join('|')
      )
      .digest('hex')
      .slice(0, 12)
    return `${normalizedPublicationEpoch}:headless-merge:${signature}`
  }
}
