/* eslint-disable max-lines -- Why: extracted window-graph client command cluster (syncWindowGraph/resizeForClient/onClientDisconnected/getStatus); host delegation pending further split. */
import type { AgentStatusOrchestrationContext } from '../../shared/agent-status-types'
import type { RuntimeCapability } from '../../shared/protocol-version'
import {
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type {
  RuntimeDegradation,
  RuntimeDesktopWindowStatus,
  RuntimeGraphStatus,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeRendererSyncWindowGraph,
  RuntimeStatus,
  RuntimeSyncWindowGraph,
  RuntimeSyncWindowGraphResult,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab
} from '../../shared/runtime-types'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  HEADLESS_RUNTIME_WINDOW_ID,
  browserUnavailableMessage
} from '../../shared/runtime-types'
import type { BrowserBackend } from '../browser/browser-backend'
import { runtimeTerminalDegradation } from './native-terminal-availability'
import type { OrchestrationDb } from './orchestration/db'
import {
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
import { clampTerminalViewport } from './runtime-worktree-git-shared'
import {
  WORKTREE_CREATE_RESULT_TTL_MS,
  type ApplyLayoutResult,
  type DriverState,
  type PtyIncarnationHandleRecord,
  type PtyLayoutState,
  type PtyLayoutTarget,
  type RuntimeLeafRecord,
  type RuntimePtyWorktreeRecord,
  type RuntimeStore
} from './orca-runtime'
import type { BrowserWindow } from 'electron'

export type RuntimeWindowGraphClientCommandsDeps = {
  adoptFirstPtyForLeafHandle: (
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ) => boolean
  adoptPreAllocatedHandle: (leaf: RuntimeLeafRecord) => string | null
  applyRemoteDesktopLayout: (ptyId: string) => Promise<boolean>
  attachWindow: (windowId: number) => void
  buildAgentOrchestrationByPaneKey: () =>
    | Record<string, AgentStatusOrchestrationContext>
    | undefined
  cancelMobileDictationForClient: (clientId: string) => void
  collectMobileVisibleGraphChangedWorktrees: (
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ) => Set<string>
  deliverPendingMessagesForLeaf: (leaf: RuntimeLeafRecord) => void
  enqueueLayout: (ptyId: string, target: PtyLayoutTarget) => Promise<ApplyLayoutResult>
  getAutoRestoreFitMs: () => number | null
  getAvailableAuthoritativeWindow: () => BrowserWindow | null
  getDriver: (ptyId: string) => DriverState
  getLeafKey: (tabId: string, leafId: string) => string
  getMobileDisplayMode: (ptyId: string) => 'auto' | 'desktop'
  getNativeChatLaunchDraftResolutionClientEventSnapshot: () => Extract<
    RuntimeClientEvent,
    { type: 'nativeChatLaunchDraftResolved' }
  >[]
  getStatus: () => RuntimeStatus
  getTerminalSize: (ptyId: string) => { cols: number; rows: number } | null
  hasRemoteDesktopViewers: (ptyId: string) => boolean
  invalidateLeafHandle: (leafKey: string) => void
  makeRuntimePaneKey: (
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ) => string
  markGraphReady: (windowId: number) => void
  markSessionTabsInventoryPublished: () => void
  mobileTookFloor: (
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent?: () => boolean
  ) => Promise<void>
  nextTitleObservationSequence: () => number
  notifyFitOverrideListeners: (
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ) => void
  notifyRemoteTerminalViewPresenceChanged: (ptyId: string) => void
  pickMostRecentActor: (
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ) => { clientId: string; lastActedAt: number } | null
  rebuildLeafPtyIndex: () => void
  reconcileMobileSessionRetirementFences: (
    leaves: readonly RuntimeSyncedLeaf[]
  ) => RuntimeSyncedLeaf[]
  reconcilePtyIncarnationHandles: () => void
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'title'
        | 'connectionId'
        | 'runtimeSessionOwned'
        | 'isWsl'
        | 'wslDistro'
        | 'incarnationId'
        | 'agentSessionOwners'
      >
    >
  ) => RuntimePtyWorktreeRecord
  resolveDesktopRestoreTarget: (ptyId: string) => { cols: number; rows: number }
  scheduleMobileSessionTabsChanged: (worktreeId: string) => void
  setDriver: (ptyId: string, next: DriverState) => void
  syncMobileSessionTabs: (
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds?: Set<string>
  ) => Set<string>
  _orchestrationDb: () => OrchestrationDb | null
  authoritativeWindowId: () => number | null
  authoritativeWindowIdSet: (windowId: number) => void
  detachedPreAllocatedLeaves: Map<string, RuntimeLeafRecord>
  freshSubscribeGuard: Set<string>
  getDesktopWindowStatusFn: () => RuntimeDesktopWindowStatus
  graphStatus: () => RuntimeGraphStatus
  graphSyncCallbacks: (() => void)[]
  handleByLeafKey: Map<string, string>
  handleByPtyId: Map<string, string>
  handleByPtyIncarnation: Map<string, PtyIncarnationHandleRecord>
  headlessGraphFallbackAvailable: boolean
  headlessGraphFallbackAvailableSet: (value: boolean) => void
  lastRendererSizes: Map<string, { cols: number; rows: number }>
  layouts: Map<string, PtyLayoutState>
  leaves: () => Map<string, RuntimeLeafRecord>
  leavesSet: (leaves: Map<string, RuntimeLeafRecord>) => void
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  mobileSubscribers: Map<
    string,
    Map<
      string,
      {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    >
  >
  offscreenBrowserBackend: () => BrowserBackend | null
  pendingHeadlessPromotionWindowId: () => number | null
  pendingRestoreTimers: Map<string, { timer: ReturnType<typeof setTimeout>; clientId: string }>
  pendingSoftLeavers: Map<
    string,
    {
      clientId: string
      timer: ReturnType<typeof setTimeout>
      record: {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    }
  >
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  remoteDesktopHostReclaimTargets: Map<string, { cols: number; rows: number }>
  rendererGeneration: () => string | null
  rendererGenerationSet: (generation: string | null) => void
  rendererGraphEpoch: () => number
  revokeTerminalFileGrantsForClient: (clientId: string) => void
  runtimeId: `${string}-${string}-${string}-${string}-${string}`
  sessionTabsInventoryPublicationEpoch: () => number | null
  sessionTabsInventoryPublicationEpochSet: (epoch: number | null) => void
  store: RuntimeStore | null
  tabs: () => Map<string, RuntimeSyncedTab>
  tabsSet: (tabs: Map<string, RuntimeSyncedTab>) => void
  terminalFitOverrides: Map<
    string,
    {
      mode: 'mobile-fit'
      cols: number
      rows: number
      previousCols: number | null
      previousRows: number | null
      updatedAt: number
      clientId: string
    }
  >
}

export class RuntimeWindowGraphClientCommands {
  private readonly deps: RuntimeWindowGraphClientCommandsDeps

  constructor(deps: RuntimeWindowGraphClientCommandsDeps) {
    this.deps = deps
  }

  syncWindowGraph(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): RuntimeSyncWindowGraphResult {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.deps.authoritativeWindowId() === HEADLESS_RUNTIME_WINDOW_ID &&
      this.deps.headlessGraphFallbackAvailable
    ) {
      if (windowId !== this.deps.pendingHeadlessPromotionWindowId()) {
        throw new Error('Runtime graph publisher does not match the pending desktop promotion')
      }
      // Why: a renderer may publish after a failed promotion was restored to
      // headless authority; accepting that late healthy graph is self-healing.
      this.deps.attachWindow(windowId)
    }
    if (this.deps.authoritativeWindowId() === null) {
      this.deps.authoritativeWindowIdSet(windowId)
    }
    if (windowId !== this.deps.authoritativeWindowId()) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }
    const rendererGeneration =
      windowId === HEADLESS_RUNTIME_WINDOW_ID
        ? null
        : 'rendererGeneration' in graph && typeof graph.rendererGeneration === 'string'
          ? graph.rendererGeneration
          : undefined
    if (
      typeof rendererGeneration === 'string' &&
      rendererGeneration === this.deps.rendererGeneration() &&
      this.deps.graphStatus() !== 'ready'
    ) {
      throw new Error('Runtime graph publisher belongs to a superseded renderer generation')
    }
    if (windowId === HEADLESS_RUNTIME_WINDOW_ID) {
      this.deps.headlessGraphFallbackAvailableSet(true)
      this.deps.rendererGenerationSet(null)
    }

    const graphWasReady = this.deps.graphStatus() === 'ready'
    const previousTabs = this.deps.tabs()
    const previousLeaves = this.deps.leaves()
    this.deps.tabsSet(new Map(graph.tabs.map((tab) => [tab.tabId, tab] as const)))
    const lifecycleLeaves = this.deps.reconcileMobileSessionRetirementFences(graph.leaves)
    const mobileSessionResyncWorktrees = new Set<string>()
    const changedMobileWorktrees = this.deps.syncMobileSessionTabs(
      graph.mobileSessionTabs,
      graph.unchangedMobileSessionWorktrees,
      mobileSessionResyncWorktrees
    )
    const nextLeaves = new Map<string, RuntimeLeafRecord>()
    const graphSyncedAt = this.deps.nextTitleObservationSequence()

    // Why: renderer reloads can briefly republish the same leaf with no ptyId;
    // keep live CLI handles usable while the UI graph rebuilds.
    const preserveLivePtysDuringReload = this.deps.graphStatus() === 'reloading'
    for (const leaf of lifecycleLeaves) {
      const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.deps.leaves().get(leafKey)
      const ptyId =
        preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)
      const existingPty = ptyId ? this.deps.ptysById.get(ptyId) : undefined
      const tailSource = existing?.ptyId === ptyId ? existing : existingPty

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected: ptyId !== null,
        writable: this.deps.graphStatus() === 'ready' && ptyId !== null,
        lastOutputAt: tailSource?.lastOutputAt ?? null,
        lastExitCode: tailSource?.lastExitCode ?? null,
        lastExitCause: tailSource?.lastExitCause ?? null,
        tailBuffer: tailSource?.tailBuffer ?? [],
        tailTranscriptBuffer: tailSource?.tailTranscriptBuffer ?? [],
        tailTranscriptChars: tailSource?.tailTranscriptChars ?? 0,
        tailPartialLine: tailSource?.tailPartialLine ?? '',
        tailPendingAnsi: tailSource?.tailPendingAnsi ?? '',
        tailRedrawCursor: tailSource?.tailRedrawCursor ?? null,
        tailTruncated: tailSource?.tailTruncated ?? false,
        tailLinesTotal: tailSource?.tailLinesTotal ?? 0,
        preview: tailSource?.preview ?? '',
        waitBlockedAt: tailSource?.waitBlockedAt ?? null,
        lastAgentStatus: tailSource?.lastAgentStatus ?? null,
        lastAgentStatusObservedLive: tailSource?.lastAgentStatusObservedLive ?? false,
        lastOscTitle: tailSource?.lastOscTitle ?? null,
        lastOscTitleAt: tailSource?.lastOscTitleAt ?? null,
        paneTitleUpdatedAt:
          existing?.ptyId === ptyId && existing.paneTitle === leaf.paneTitle
            ? existing.paneTitleUpdatedAt
            : graphSyncedAt
      })

      if (leaf.ptyId) {
        this.deps.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.deps.makeRuntimePaneKey(leaf)
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        // Why: mobile can subscribe while the pane is waiting for its first PTY.
        // Keep that handle usable after the recovery mount binds it.
        const adoptedFirstPty =
          existing.ptyId === null &&
          this.deps.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
        if (!adoptedFirstPty) {
          this.deps.invalidateLeafHandle(leafKey)
        }
      }
    }

    // Why: computed BEFORE preserving stale leaves so preservation can refuse a
    // leaf whose PTY the incoming graph already rebound to a live leaf. Two
    // leaves on one PTY resolve to the same handle (handles are ptyId-keyed) and
    // crash paired clients with a duplicate React key.
    const nextPtyIds = new Set(
      [...nextLeaves.values()].map((leaf) => leaf.ptyId).filter((ptyId): ptyId is string => !!ptyId)
    )
    for (const oldLeafKey of this.deps.leaves().keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.deps.leaves().get(oldLeafKey)
        const retainedIncarnation = oldLeaf?.ptyId
          ? this.deps.handleByPtyIncarnation.get(oldLeaf.ptyId)
          : undefined
        if (
          preserveLivePtysDuringReload &&
          oldLeaf?.ptyId &&
          (this.deps.handleByPtyId.has(oldLeaf.ptyId) ||
            (retainedIncarnation &&
              retainedIncarnation.incarnationId ===
                this.deps.ptysById.get(oldLeaf.ptyId)?.incarnationId)) &&
          !nextPtyIds.has(oldLeaf.ptyId)
        ) {
          // Why: the first reload graph can precede pane rebinding; the live PTY incarnation still owns its handle.
          nextLeaves.set(oldLeafKey, oldLeaf)
          nextPtyIds.add(oldLeaf.ptyId)
        } else if (oldLeaf?.ptyId && nextPtyIds.has(oldLeaf.ptyId)) {
          // Why: the incoming graph already rebound this PTY to a live leaf (e.g.
          // a woken agent re-keyed to a new leaf during renderer reload). Keeping
          // the old leaf too would put two leaves on ONE PTY, which emit the same
          // terminal handle and crash paired clients. Drop the stale leaf; if its
          // handle is the shared ptyId-keyed one it belongs to the live leaf now,
          // so release only this dead leaf key's alias. A leaf-unique handle has
          // no next owner — invalidate it so in-flight CLI waiters fail fast
          // instead of hanging on a dead leaf.
          const oldHandle = this.deps.handleByLeafKey.get(oldLeafKey)
          const incarnationHandle = retainedIncarnation?.handle
          if (
            oldHandle !== undefined &&
            (oldHandle === this.deps.handleByPtyId.get(oldLeaf.ptyId) ||
              oldHandle === incarnationHandle)
          ) {
            this.deps.handleByLeafKey.delete(oldLeafKey)
          } else {
            this.deps.invalidateLeafHandle(oldLeafKey)
          }
        } else {
          this.deps.invalidateLeafHandle(oldLeafKey)
        }
      }
    }

    for (const [ptyId, leaf] of this.deps.detachedPreAllocatedLeaves) {
      if (nextPtyIds.has(ptyId) || !this.deps.handleByPtyId.has(ptyId)) {
        this.deps.detachedPreAllocatedLeaves.delete(ptyId)
        continue
      }
      nextLeaves.set(this.deps.getLeafKey(leaf.tabId, leaf.leafId), leaf)
      nextPtyIds.add(ptyId)
    }

    this.deps.leavesSet(nextLeaves)
    this.deps.rebuildLeafPtyIndex()
    this.deps.reconcilePtyIncarnationHandles()
    // Why: the emitted client payload is a function of the stored snapshot AND
    // the tab/leaf graph (handles/titles/connected resolve from leaf state), so
    // a graph-only change — e.g. a restored leaf binding its ptyId while the
    // snapshot pair is unchanged — must also fan out, or a paired client stays
    // on pending-handle forever. Schedule the union on the same 50ms trailing
    // edge as the OSC-title path; the coalescer emit reads the latest state at
    // fire time so no final version is ever lost.
    for (const worktreeId of this.deps.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )) {
      if (changedMobileWorktrees.has(worktreeId)) {
        continue
      }
      const stored = this.deps.mobileSessionTabsByWorktree.get(worktreeId)
      if (!stored) {
        continue
      }
      // Why: web clients drop same-epoch frames whose version isn't strictly
      // newer, so a graph-only change must mint a fresh stored version (like
      // the PTY touch path does) or the re-emitted payload — e.g. the
      // pending-handle → ready flip — is discarded and the client stays stale.
      // The accepted-renderer tracking is untouched: this is a main-local bump.
      this.deps.mobileSessionTabsByWorktree.set(worktreeId, {
        ...stored,
        snapshotVersion: stored.snapshotVersion + 1
      })
      changedMobileWorktrees.add(worktreeId)
    }
    for (const worktreeId of changedMobileWorktrees) {
      if (this.deps.mobileSessionTabsByWorktree.has(worktreeId)) {
        this.deps.scheduleMobileSessionTabsChanged(worktreeId)
      }
    }
    // Why: only the authoritative window grants inventory authority; headless qualifies because it becomes authoritative before its next sync.
    const isAuthoritativeGraphPublisher = windowId === this.deps.authoritativeWindowId()
    this.deps.markGraphReady(windowId)
    if (
      isAuthoritativeGraphPublisher &&
      (windowId === HEADLESS_RUNTIME_WINDOW_ID || graph.mobileSessionTabs !== undefined)
    ) {
      if (mobileSessionResyncWorktrees.size === 0) {
        this.deps.markSessionTabsInventoryPublished()
      } else {
        this.deps.sessionTabsInventoryPublicationEpochSet(null)
      }
    }
    if (rendererGeneration !== undefined) {
      this.deps.rendererGenerationSet(rendererGeneration)
    }
    for (const leaf of this.deps.leaves().values()) {
      this.deps.adoptPreAllocatedHandle(leaf)
      const previousLeaf = previousLeaves.get(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
      if (
        this.deps._orchestrationDb() &&
        leaf.lastAgentStatus === 'idle' &&
        leaf.lastAgentStatusObservedLive &&
        leaf.writable &&
        (!graphWasReady ||
          previousLeaf?.ptyId !== leaf.ptyId ||
          !previousLeaf.writable ||
          previousLeaf.lastAgentStatus !== 'idle' ||
          !previousLeaf.lastAgentStatusObservedLive)
      ) {
        this.deps.deliverPendingMessagesForLeaf(leaf)
      }
    }

    // Why: createTerminal waits for the renderer's graph sync to populate the
    // new leaf so it can return a handle. Drain callbacks after leaves update.
    for (const cb of this.deps.graphSyncCallbacks) {
      cb()
    }

    const agentOrchestrationByPaneKey = this.deps.buildAgentOrchestrationByPaneKey()
    const nativeChatLaunchDraftResolutions = this.deps
      .getNativeChatLaunchDraftResolutionClientEventSnapshot()
      .map(({ tabId, text, createdAt }) => ({ tabId, text, createdAt }))
    return {
      ...this.deps.getStatus(),
      ...(agentOrchestrationByPaneKey ? { agentOrchestrationByPaneKey } : {}),
      ...(nativeChatLaunchDraftResolutions.length > 0 ? { nativeChatLaunchDraftResolutions } : {}),
      ...(mobileSessionResyncWorktrees.size > 0
        ? { mobileSessionResyncWorktrees: [...mobileSessionResyncWorktrees] }
        : {})
    }
  }

  async resizeForClient(
    ptyId: string,
    mode: 'mobile-fit' | 'restore',
    clientId: string,
    cols?: number,
    rows?: number
  ): Promise<{
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    mode: 'mobile-fit' | 'desktop-fit'
  }> {
    if (mode === 'mobile-fit') {
      if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
        throw new Error('invalid_dimensions')
      }
      const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(cols, rows)

      const currentSize = this.deps.getTerminalSize(ptyId)
      const existing = this.deps.terminalFitOverrides.get(ptyId)
      // Capture baseline cols/rows for the return value (existing override's
      // baseline wins over current size to preserve original desktop dims
      // across multiple re-fits).
      const previousCols = existing?.previousCols ?? currentSize?.cols ?? null
      const previousRows = existing?.previousRows ?? currentSize?.rows ?? null

      // Why: legacy resizeForClient callers bypass handleMobileSubscribe, so
      // mobileSubscribers stays empty and resolveDesktopRestoreTarget's step-1
      // (per-subscriber baseline) never matches. Stash the pre-fit PTY size
      // into lastRendererSizes so restore lands on step 2 (renderer geometry)
      // instead of step 3 (current phone-fit dims = no-op restore).
      if (currentSize && !existing) {
        this.deps.lastRendererSizes.set(ptyId, {
          cols: currentSize.cols,
          rows: currentSize.rows
        })
      }

      this.deps.freshSubscribeGuard.add(ptyId)
      let result: ApplyLayoutResult
      try {
        result = await this.deps.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        this.deps.freshSubscribeGuard.delete(ptyId)
      }
      if (!result.ok) {
        throw new Error('resize_failed')
      }

      // Why: mobile-fit via resizeForClient is a deliberate mobile action;
      // the actor takes the floor (updates lastActedAt; mode-flip case is
      // already handled by enqueueLayout above).
      await this.deps.mobileTookFloor(ptyId, clientId)

      return {
        cols: clampedCols,
        rows: clampedRows,
        previousCols,
        previousRows,
        mode: 'mobile-fit'
      }
    }

    // restore mode
    const override = this.deps.terminalFitOverrides.get(ptyId)
    if (!override) {
      throw new Error('no_active_override')
    }
    // Only the owning client can restore — prevents one phone from undoing
    // another phone's active fit.
    if (override.clientId !== clientId) {
      throw new Error('not_override_owner')
    }

    const restore = this.deps.resolveDesktopRestoreTarget(ptyId)
    const result = await this.deps.enqueueLayout(ptyId, {
      kind: 'desktop',
      cols: restore.cols,
      rows: restore.rows
    })
    if (!result.ok) {
      throw new Error('resize_failed')
    }

    // Why: legacy mobile clients on the resizeForClient path also need a
    // fit-override-listener notification (the renderer-side terminalFitOverrideChanged
    // is already emitted by applyLayout's mode-flip path).
    this.deps.notifyFitOverrideListeners(ptyId, 'desktop-fit', restore.cols, restore.rows)

    return {
      cols: restore.cols,
      rows: restore.rows,
      previousCols: null,
      previousRows: null,
      mode: 'desktop-fit'
    }
  }

  onClientDisconnected(clientId: string): void {
    this.deps.revokeTerminalFileGrantsForClient(clientId)
    this.deps.cancelMobileDictationForClient(clientId)

    // (1) Cancel pending restore-debounce timers owned by this client.
    for (const [ptyId, entry] of this.deps.pendingRestoreTimers) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer)
        this.deps.pendingRestoreTimers.delete(ptyId)
      }
    }

    // (2) Promote any soft-leave grace owned by this client into immediate
    // finalization. Grace existed to absorb a quick re-subscribe; a real
    // disconnect kills any chance of re-subscribe.
    //
    // Note: this is mode-decoupled (matches docs/mobile-terminal-layout-state-machine.md
    // sub-case 2). Today's pre-rewrite code only restored when
    // `mode === 'auto' && wasResizedToPhone`; the new design restores
    // whenever the layout is currently `phone`. This is an intentional
    // behavior fix — `mode === 'phone'` with no subscribers is a degenerate
    // state nothing in product depends on.
    for (const [ptyId, soft] of this.deps.pendingSoftLeavers) {
      if (soft.clientId !== clientId) {
        continue
      }
      clearTimeout(soft.timer)
      this.deps.pendingSoftLeavers.delete(ptyId)

      // Cancel any in-flight 300ms restore timer too — we'll handle it inline.
      const pending = this.deps.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.deps.pendingRestoreTimers.delete(ptyId)
      }

      const cur = this.deps.layouts.get(ptyId)
      // Why: Indefinite hold (mobileAutoRestoreFitMs == null) keeps the PTY
      // at phone dims after the phone disconnects; the desktop banner's
      // Restore button is the explicit return path. See
      // docs/mobile-fit-hold.md.
      if (this.deps.hasRemoteDesktopViewers(ptyId)) {
        this.deps.setDriver(ptyId, { kind: 'idle' })
        void this.deps.applyRemoteDesktopLayout(ptyId)
        continue
      } else if (cur?.kind === 'phone' && this.deps.getAutoRestoreFitMs() != null) {
        if (this.deps.remoteDesktopHostReclaimTargets.has(ptyId)) {
          this.deps.setDriver(ptyId, { kind: 'idle' })
          void this.deps.applyRemoteDesktopLayout(ptyId)
          continue
        }
        // Use the soft-leaver's snapshot baseline as a hint, falling
        // through to resolveDesktopRestoreTarget for missing values.
        const fallback = this.deps.resolveDesktopRestoreTarget(ptyId)
        const cols = soft.record.previousCols ?? fallback.cols
        const rows = soft.record.previousRows ?? fallback.rows
        void this.deps.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.deps.setDriver(ptyId, { kind: 'idle' })
    }

    // (3) Immediate restore for PTYs where this client was the last
    // mobile subscriber. With multi-mobile, peer subscribers keep the
    // floor; only when the inner map empties do we transition to desktop.
    const ptysWithSurvivingPeers: string[] = []
    const ptysToRestore: { ptyId: string; baseline: { cols: number; rows: number } | null }[] = []
    for (const [ptyId, inner] of this.deps.mobileSubscribers) {
      const subscriber = inner.get(clientId)
      if (!subscriber) {
        continue
      }
      // Snapshot baseline before deleting — needed once mobileSubscribers
      // entry is gone for the resolveDesktopRestoreTarget chain.
      const baseline =
        subscriber.previousCols != null && subscriber.previousRows != null
          ? { cols: subscriber.previousCols, rows: subscriber.previousRows }
          : null
      inner.delete(clientId)
      this.deps.notifyRemoteTerminalViewPresenceChanged(ptyId)
      if (inner.size > 0) {
        ptysWithSurvivingPeers.push(ptyId)
      } else {
        this.deps.mobileSubscribers.delete(ptyId)
        ptysToRestore.push({ ptyId, baseline })
      }
    }
    for (const { ptyId, baseline } of ptysToRestore) {
      const cur = this.deps.layouts.get(ptyId)
      // Why: Indefinite hold gate — see soft-leaver branch above.
      if (this.deps.hasRemoteDesktopViewers(ptyId)) {
        this.deps.setDriver(ptyId, { kind: 'idle' })
        void this.deps.applyRemoteDesktopLayout(ptyId)
        continue
      } else if (cur?.kind === 'phone' && this.deps.getAutoRestoreFitMs() != null) {
        if (this.deps.remoteDesktopHostReclaimTargets.has(ptyId)) {
          this.deps.setDriver(ptyId, { kind: 'idle' })
          void this.deps.applyRemoteDesktopLayout(ptyId)
          continue
        }
        const fallback = this.deps.resolveDesktopRestoreTarget(ptyId)
        const cols = baseline?.cols ?? fallback.cols
        const rows = baseline?.rows ?? fallback.rows
        void this.deps.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.deps.setDriver(ptyId, { kind: 'idle' })
    }

    // (4) Driver re-election where peers survived. If the disconnecting
    // client was the active driver, the most-recent surviving actor takes
    // the floor.
    for (const ptyId of ptysWithSurvivingPeers) {
      const driver = this.deps.getDriver(ptyId)
      if (driver.kind !== 'mobile' || driver.clientId !== clientId) {
        continue
      }
      const inner = this.deps.mobileSubscribers.get(ptyId)
      const next = inner ? this.deps.pickMostRecentActor(inner) : null
      if (!next) {
        continue
      }
      this.deps.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })

      const mode = this.deps.getMobileDisplayMode(ptyId)
      if (mode === 'desktop') {
        continue
      }
      const nextSub = inner!.get(next.clientId)
      const nextViewport = nextSub?.viewport
      if (!nextViewport) {
        continue
      }
      void this.deps.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: nextViewport.cols,
        rows: nextViewport.rows,
        ownerClientId: next.clientId
      })
    }

    // (5) Legacy-callers fallback. Older mobile builds use resizeForClient
    // directly and never populate mobileSubscribers. For those PTYs the
    // override carries the owning clientId; restore the layout when the
    // owner disconnects. resolveDesktopRestoreTarget reads lastRendererSizes
    // (which the legacy mobile-fit branch stashes the pre-fit size into).
    for (const [ptyId, override] of this.deps.terminalFitOverrides) {
      if (override.clientId !== clientId) {
        continue
      }
      if (this.deps.mobileSubscribers.has(ptyId)) {
        continue
      }
      const cur = this.deps.layouts.get(ptyId)
      if (cur?.kind !== 'phone') {
        continue
      }
      // Why: Indefinite hold gate — see soft-leaver branch above. Legacy
      // mobile clients (resizeForClient path) honor the same setting.
      if (this.deps.getAutoRestoreFitMs() == null) {
        continue
      }
      const fallback = this.deps.resolveDesktopRestoreTarget(ptyId)
      const cols = override.previousCols ?? fallback.cols
      const rows = override.previousRows ?? fallback.rows
      void this.deps.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    }
  }

  getStatus(): RuntimeStatus {
    // Why: browser panes need a backend that can create and stream a page. A
    // desktop renderer provides one via <webview>; a headless serve provides one
    // via the offscreen backend. Either way the same browser.screencast.v1 path
    // works, so advertise it when either is present. browser.headless.v1
    // additionally tells clients this host owns browser pages with no renderer,
    // so they must not fall back to a local desktop browser tab.
    const hasRenderer = Boolean(this.deps.getAvailableAuthoritativeWindow())
    const hasOffscreen = !hasRenderer && Boolean(this.deps.offscreenBrowserBackend())
    const hasHeadlessCommands = runtimeBrowserCommandsFactoryIsHeadless()
    const canBrowse = hasRenderer || hasOffscreen
    const capabilities: RuntimeCapability[] = RUNTIME_CAPABILITIES.filter(
      (capability) =>
        (capability !== 'browser.screencast.v1' || canBrowse) &&
        // Why: the nested-runtime E2E needs a real legacy transport without maintaining an old binary fixture.
        (process.env.ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL !== '1' ||
          capability !== REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING !== '1' ||
          capability !== TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1' ||
          capability !== SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY)
    )
    if (hasOffscreen || hasHeadlessCommands) {
      capabilities.push(BROWSER_HEADLESS_RUNTIME_CAPABILITY)
    }
    // Why: certificate proceed is owned by the browser-hosting process for both
    // desktop webviews and offscreen pages. Advertise whenever either backend
    // can host a page so remote clients can surface Proceed Anyway (Unsafe).
    if (canBrowse) {
      capabilities.push(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY)
    }
    // Why the cause and not one fixed sentence: the operator can only act on the reason
    // that actually applies, and a host that says "set ORCA_BROWSER_EXECUTABLE" to someone
    // who already set it sends them to fix a thing that is not broken.
    const cause = canBrowse || hasHeadlessCommands ? null : runtimeBrowserUnavailableCause()
    const degradations: RuntimeDegradation[] = cause
      ? [
          {
            code: BROWSER_UNAVAILABLE_ERROR_CODE,
            capability: BROWSER_HEADLESS_RUNTIME_CAPABILITY,
            message: browserUnavailableMessage(cause.reason, cause.detail),
            reason: cause.reason,
            ...(cause.detail ? { detail: cause.detail } : {})
          }
        ]
      : []
    // Why appended rather than merged into the ternary: PTY loss and browser loss are
    // independent, and a host can be degraded on both at once.
    const terminalDegradation = runtimeTerminalDegradation()
    if (terminalDegradation) {
      degradations.push(terminalDegradation)
    }
    return {
      runtimeId: this.deps.runtimeId,
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      graphStatus: this.deps.graphStatus(),
      authoritativeWindowId: this.deps.authoritativeWindowId(),
      desktopWindowStatus: hasRenderer ? 'available' : this.deps.getDesktopWindowStatusFn(),
      liveTabCount: this.deps.tabs().size,
      liveLeafCount: this.deps.leaves().size,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      // Why: headless orca serve cannot create/stream BrowserViews, so clients
      // must not treat browser panes as supported just because runtime RPC is up.
      capabilities,
      ...(degradations.length > 0 ? { degradations } : {}),
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_RESULT_TTL_MS },
      hostPlatform: process.platform,
      terminalWindowsShell: this.deps.store?.getSettings?.().terminalWindowsShell ?? null,
      floatingWorkspaceEnabled: this.deps.store?.getSettings?.().floatingTerminalEnabled !== false,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }
}
