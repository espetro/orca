import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type {
  RuntimeFileListResult,
  RuntimeFileOpenResult,
  RuntimeFileReadResult
} from '../../shared/runtime-file-contracts'
import type { ClientSessionTabSelectionStore } from './client-session-tab-selection'
/* eslint-disable max-lines -- Why: extracted mobile-session facade (bulk mobile cluster move); snapshot/tab publication ownership can split further if it grows */

import type { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import type { RuntimeMobileSnapshotMergeCommands } from './runtime-mobile-snapshot-merge-commands'
import type { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import type { RuntimeHookAgentRowResolutionCommands } from './runtime-hook-agent-row-resolution-commands'
import type { RuntimeHeadlessSessionTabPersistenceCommands } from './runtime-headless-session-tab-persistence-commands'
import type { RuntimeClientEventPublishingCommands } from './runtime-client-event-publishing-commands'

import type { OrcaRuntimeService } from './orca-runtime'
// Why: mirror of the god-class-local PTY record shape; god class does not export it.
type RuntimePtyRecord = OrcaRuntimeService['ptysById'] extends Map<string, infer T> ? T : never
import type {
  ApplyLayoutResult,
  DriverState,
  HookLiveAgentRow,
  MobileNotificationEvent,
  NativeChatLaunchDraftResolutionTombstone,
  ProviderBufferAcquisition,
  ProviderSnapshotReadOptions,
  PtyControllerInventory,
  PtyLayoutState,
  PtyLayoutTarget,
  ResolvedWorktree,
  RuntimeAgentRowSnapshot,
  RuntimeHeadlessTerminal,
  RuntimeLeafRecord,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyWorktreeRecord,
  RuntimeStore,
  RuntimeTerminalProjection,
  RuntimeVisibleTerminalState,
  TerminalHandleRecord,
  TerminalWorkspaceLaunchScope
} from './orca-runtime'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import type {
  AgentStatusEntry,
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { navigationTargetsHost } from '../../shared/runtime-navigation'
import type {
  BrowserTabInfo,
  RuntimeGraphStatus,
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSpeechSetupState,
  RuntimeSyncedTab,
  RuntimeTerminalCreate,
  RuntimeTerminalDriverState,
  RuntimeTerminalRead
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { TabActivationIntent } from '../../shared/tab-activation-intent'
import { isAutomaticTabActivation } from '../../shared/tab-activation-intent'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { BrowserBackend } from '../browser/browser-backend'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import type { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import {
  buildHeadlessTabGroupMove,
  buildHeadlessTabGroupSplit
} from './headless-tab-group-split-layout'
import type { MobileNotificationReplayBuffer } from './mobile-notification-replay'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import type { MobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'
import type { MobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import { createMobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import type { RuntimeAccountCommands } from './runtime-account-commands'
import type { RuntimeManagedWorktrees } from './runtime-managed-worktrees'
import {
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  buildPreview,
  buildVisibleSnapshotReadFallback,
  notifyRuntimeListeners,
  projectVisibleTerminalLines,
  shouldFallbackToVisibleTerminalSnapshot
} from './runtime-tail-projection'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { RuntimeMobileSessionFacadeCtx } from './runtime-mobile-session-facade-ctx'
import {
  cancelMobileDictation,
  cancelMobileDictationForClient,
  cancelMobileDictationForConnection,
  cancelMobileDictationSession,
  configureMobileDictation,
  deleteMobileSpeechModel,
  downloadMobileSpeechModel,
  feedMobileDictation,
  finishMobileDictation,
  listMobileSpeechModels,
  startMobileDictation
} from './runtime-mobile-dictation-session'
import {
  applyMobileDisplayMode,
  beginMobileInputFloor,
  getMobileAutoRestoreFitMs,
  getMobileDisplayMode,
  handleMobileSubscribe,
  handleMobileSubscribeInternal,
  handleMobileUnsubscribe,
  isMobileSubscriberActive,
  markMobileActor,
  mobileTookFloor,
  setMobileAutoRestoreFitMs,
  setMobileDisplayMode,
  updateMobileSubscriberViewport,
  updateMobileViewport
} from './runtime-mobile-session-subscription-commands'
import {
  createMobileSessionTerminal,
  createRuntimeOwnedMobileSessionTerminal,
  ensurePtyBackedMobileSurfaceForRendererTab,
  findMobileTerminalSurface,
  findMobileTerminalSurfaceForPty,
  isReadyMobileTerminalSurface,
  performMobileSessionPtyRecordsRefresh,
  publishPtyBackedMobileSessionTerminal,
  refreshMobileSessionPtyInventory,
  refreshMobileSessionPtyRecords,
  replaceHeadlessTerminalFromRendererSnapshotForRecovery,
  resolveMobileSessionTerminalCommand,
  restoreLivePairedRendererSessionOwnedMobileTerminals,
  runCreateMobileSessionTerminal,
  waitForMobileTerminalSurface
} from './runtime-mobile-session-terminal-create'
import {
  activateHeadlessMobileSessionTerminalTab,
  applyMobileSessionTabNavigation,
  cancelScheduledMobileSessionTabsChanged,
  collectMobileVisibleGraphChangedWorktrees,
  flushScheduledMobileSessionTabsChanged,
  getMobileSessionTabsForWorktree,
  notifyMobileSessionTabsChangedNow,
  notifyMobileSessionTabsRemoved,
  publishRecoveredSshMobileSessionTabs,
  refuseUnattributedMobileSessionTabClose,
  republishMobileSessionTabsSnapshot,
  resolveMobileMarkdownWorktreeId,
  scheduleMobileSessionTabsChanged,
  shouldMaterializeHeadlessMobileSessionTab,
  shouldPersistHeadlessMobileSessionActivation,
  syncMobileSessionTabs
} from './runtime-mobile-session-tab-sync-commands'
import {
  getMobileSessionSnapshotTabIdentityKeys,
  pruneMobileSessionTabGroupLayout,
  sanitizeMobileSessionTabGroups,
  toMobileSessionTabsResult
} from './runtime-mobile-session-tabs-projection'

// eslint-disable @typescript-eslint/no-explicit-any -- Deps mirror god-class members, several are any-typed delegation shims
export type RuntimeMobileSessionFacadeDeps = {
  acceptedRendererMobileSnapshotByWorktree: () => Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
    }
  >
  accountCommands: () => RuntimeAccountCommands
  agentPromptExplicitStatusFloorByPtyId: () => Map<string, number>
  agentStatusOscProcessorsByPtyId: () => Map<string, (data: string) => ProcessedAgentStatusChunk>
  applyHeadlessSessionTabPropsToSnapshot: () => (
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ) => any
  applyHeadlessTerminalPaneLayoutToSnapshot: () => (
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ) => any
  applyMobileSessionRetirementFences: (...args: any[]) => any
  applyNativeChatLaunchDraftResolutionFence: (
    snapshot: RuntimeMobileSessionTabsSnapshot
  ) => RuntimeMobileSessionTabsSnapshot
  applyRemoteDesktopLayout: (ptyId: string) => Promise<boolean>
  assertSessionTabsInventoryRequestActive: (signal?: AbortSignal) => void
  assertStableReadyGraph: (expectedGraphEpoch: number) => void
  authoritativeWindowId: () => number | null
  buildMaterializedHeadlessParentLayout: (...args: any[]) => any
  cancelAllPendingFitRestoreTimers: () => void
  captureReadyGraphEpoch: () => number
  claudeAgentTeams: () => ClaudeAgentTeamsService
  clearWaitBlockedCheckState: (ptyId: string) => void
  clientEventPublishingCommands: () => RuntimeClientEventPublishingCommands
  clientSessionTabSelections: () => ClientSessionTabSelectionStore
  collectReturnedSessionTabIds: (tabs: readonly RuntimeMobileSessionClientTab[]) => Set<string>
  createTerminal: (worktreeId: string, opts: any) => Promise<RuntimeTerminalCreate>
  currentDriver: () => Map<string, RuntimeTerminalDriverState>
  delayPtyBackedMobileSnapshotForForegroundAgent: () => (
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ) => void
  deliverPendingStartupCommandToBareRendererPty: (worktreeId: string, tabId: string) => void
  detachedPreAllocatedLeaves: () => Map<string, RuntimeLeafRecord>
  disposeHeadlessTerminal: (ptyId: string) => void
  disposePtyTitleTracker: () => (ptyId: string) => void
  earlyExitedPtyIncarnations: () => Map<string, string | null>
  enqueueLayout: (ptyId: string, target: PtyLayoutTarget) => Promise<ApplyLayoutResult>
  findHandleForPtyRecord: (ptyId: string) => string | null
  findLiveRegisteredPtyForRendererTab: (
    worktreeId: string,
    tabId: string
  ) => RuntimePtyWorktreeRecord | null
  forgetPtyLivenessVerdict: (ptyId: string, observedNoLaterThan?: number) => void
  freshSubscribeGuard: () => Set<string>
  getAgentLaunchPlatformForWorkspace: (...args: any[]) => any
  getAgentProviderSessionRowsForPaneFn: () => ((paneKey: string) => AgentStatusIpcPayload[]) | null
  getAgentProviderSessionSnapshotFn: () => (() => AgentStatusIpcPayload[]) | null
  getAgentStatusSnapshotFn: () => (() => AgentStatusIpcPayload[]) | null
  getAuthoritativeSessionTabsInventoryEpoch: () => number | null
  getAutoRestoreFitMs: () => number | null
  getAvailableAuthoritativeWindow: () => BrowserWindow | null
  getDriver: (ptyId: string) => DriverState
  getHookAgentRowForPane: (rows: readonly AgentStatusIpcPayload[]) => {
    providerSession: AgentProviderSessionMetadata | null
    providerSessionAgentType: string | null
    providerSessionReceivedAt: number | null
    agentType: string | null
    agentIsLive: boolean
    live: HookLiveAgentRow | null
  }
  getKnownWorkspaceSessionWorktreeIds: () => Set<string>
  getLeafKey: (tabId: string, leafId: string) => string
  getLeavesForPty: (ptyId: string) => RuntimeLeafRecord[]
  getLiveBrowserTabsByPageId: (worktreeId: string) => Map<string, BrowserTabInfo>
  getLivePtyForHandle: (handle: string) => {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  getMobileSessionTopLevelTabId: () => (tab: RuntimeMobileSessionSnapshotTab) => any
  getTerminalSize: (ptyId: string) => { cols: number; rows: number } | null
  getUnpersistedTrackedTitleForPty: () => (ptyId: string | null) => string | null
  getValidatedExplicitWorktreeIdSelector: (selector: string | undefined) => string | null
  getWorkspaceSessionHydrationTargets: (
    includeAllPersistedWorktrees: boolean
  ) => Map<string, WorkspaceSessionState>
  graphStatus: () => RuntimeGraphStatus
  graphSyncCallbacks: () => (() => void)[]
  handleByLeafKey: () => Map<string, string>
  handleByPtyId: () => Map<string, string>
  hasLiveShellForRendererTab: (worktreeId: string, tabId: string) => boolean
  hasRemoteDesktopLayoutState: (ptyId: string) => boolean
  hasRemoteDesktopViewers: (ptyId: string) => boolean
  hasServeOrSshOwnedBinding: (...args: any[]) => any
  headlessHydrationState: () => Map<string, 'pending' | 'done'>
  headlessSessionTabPersistenceCommands: () => RuntimeHeadlessSessionTabPersistenceCommands
  headlessTerminals: () => Map<string, RuntimeHeadlessTerminal>
  hookAgentRowResolutionCommands: () => RuntimeHookAgentRowResolutionCommands
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
    worktreeId?: string,
    options?: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
    }
  ) => any
  isDeliberatelyParkedPane: (worktreeId: string, tab: RuntimeMobileSessionTerminalTab) => boolean
  isHeadlessBuiltMobileSessionPublicationBase: (...args: any[]) => any
  isHeadlessMobileSessionPublication: (...args: any[]) => any
  isKnownUnattachedLocalDaemonPty: (ptyId: string) => boolean
  isMobileSessionSurfaceMembershipAllowed: (...args: any[]) => any
  isTerminalAlternateScreen: (ptyId: string) => boolean
  issuePtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  lastRendererSizes: () => Map<string, { cols: number; rows: number }>
  latestAgentStatusByPaneKey: () => Map<string, RuntimeAgentRowSnapshot>
  layouts: () => Map<string, PtyLayoutState>
  leaves: () => Map<string, RuntimeLeafRecord>
  legacyWorkerRecoveredPtys: () => Set<string>
  listMobileFiles: () => (
    worktreeSelector: string,
    options?: { signal?: AbortSignal }
  ) => Promise<RuntimeFileListResult>
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  listRuntimeMarkdownDocuments: () => (worktreeSelector: string) => Promise<MarkdownDocument[]>
  managedWorktrees: () => RuntimeManagedWorktrees
  markWorkspaceTrustedForAgent: (
    agent: TuiAgent,
    connectionId: string | null | undefined,
    workspacePath: string
  ) => Promise<void>
  mobileNotificationReplay: () => MobileNotificationReplayBuffer
  mobileSessionTabListeners: () => Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
    clientNavigationId?: string
  }>
  mobileSessionTabsAgentStatusHeartbeat: () => MobileSessionTabsAgentStatusHeartbeat
  mobileSessionTabsByWorktree: () => Map<string, RuntimeMobileSessionTabsSnapshot>
  nextMobileSessionTabsChangeSequence: () => number
  mobileSnapshotMerge: () => RuntimeMobileSnapshotMergeCommands
  mobileSubscribers: () => Map<
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
  mobileTabSnapshots: () => RuntimeMobileSessionTabSnapshotCommands
  notificationListeners: () => Set<(event: MobileNotificationEvent) => void>
  notifier: () => RuntimeNotifier | null
  notifyFitOverrideListeners: (
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ) => void
  notifyMobileSessionTabsChanged: (worktreeId?: string) => void
  notifyRemoteTerminalViewPresenceChanged: (ptyId: string) => void
  notifyTerminalResize: (
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ) => void
  offscreenBrowserBackend: () => BrowserBackend | null
  openMobileDiff: () => (
    worktreeSelector: string,
    relativePath: string,
    staged: boolean
  ) => Promise<RuntimeFileOpenResult>
  openMobileFile: () => (
    worktreeSelector: string,
    relativePath: string
  ) => Promise<RuntimeFileOpenResult>
  osc7ScanTailByPtyId: () => Map<string, string>
  oscTitleScanTailByPtyId: () => Map<string, string>
  pairedRendererSessionOwnedPtyIds: () => Set<string>
  pendingMobileTerminalCreatesByKey: () => Map<
    string,
    {
      activate: boolean
      paired: boolean
      selectIfNoActiveTab: boolean
      viewMode?: 'terminal' | 'chat'
      startupCommand?: string
    }
  >
  pendingPtyRegistrationIncarnations: () => Map<string, string | null>
  pendingRestoreTimers: () => Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >
  pendingSoftLeavers: () => Map<
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
  persistHeadlessSessionTabProps: () => (
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ) => any
  persistHeadlessTabGroups: (
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ) => void
  persistHeadlessTerminalActiveLeaf: (
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ) => void
  persistHeadlessTerminalPaneLayout: () => (
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ) => TerminalLayoutSnapshot | undefined
  persistHeadlessTerminalTabOrder: (...args: any[]) => any
  pickEarliestRestoreTarget: (
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ) => { previousCols: number; previousRows: number } | null
  pickMostRecentActor: (
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ) => { clientId: string; lastActedAt: number } | null
  providerBufferAcquisitionsByPtyId: () => Map<string, ProviderBufferAcquisition>
  providerModeSnapshotScansByPtyId: () => Map<string, Set<TerminalKittyKeyboardModeTracker>>
  providerModeTrackersByPtyId: () => Map<string, TerminalKittyKeyboardModeTracker>
  providerSequenceInitializedPtys: () => Set<string>
  providerSequenceOffsetByPtyId: () => Map<string, number>
  providerSnapshotPreferredPtys: () => Set<string>
  providerSnapshotsWithLiveModeTransition: () => WeakSet<PtyProviderBufferSnapshot>
  providerVisibleRetryAtByPtyId: () => Map<string, number>
  providerVisibleStateByPtyId: () => Map<string, RuntimeVisibleTerminalState>
  pruneDisconnectedPtyTranscript: (pty: RuntimePtyWorktreeRecord) => void
  ptyController: () => RuntimePtyController | null
  ptyDelayedForegroundSnapshotTitleObservations: () => Map<string, number>
  ptyOutputSequenceById: () => Map<string, number>
  ptysById: () => Map<string, RuntimePtyWorktreeRecord>
  rawTerminalViewSubscriberCounts: () => Map<string, number>
  readMobileFile: () => (
    worktreeSelector: string,
    relativePath: string
  ) => Promise<RuntimeFileReadResult>
  readProviderTerminalTailLines: (
    ptyId: string,
    limit: number | undefined,
    snapshotOptions: ProviderSnapshotReadOptions
  ) => Promise<RuntimeTerminalProjection>
  readVisibleTerminalState: (ptyId: string) => Promise<RuntimeVisibleTerminalState | null>
  recentPtyOutputById: () => Map<string, RecentPtyOutputBuffer>
  recentPtyPathCandidatesById: () => Map<string, string[]>
  reconcileNativeChatLaunchDraftResolutionTombstones: (
    snapshot: RuntimeMobileSessionTabsSnapshot
  ) => void
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
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null,
    deadline?: number,
    connectionId?: string | null
  ) => Promise<PtyControllerInventory | null>
  releaseRuntimeSessionOwnershipForRendererRetiredTabs: (...args: any[]) => any
  remoteDesktopHostReclaimTargets: () => Map<string, { cols: number; rows: number }>
  remoteDesktopOwners: () => Map<string, string>
  remoteDesktopViewerRevisions: () => Map<string, number>
  remoteDesktopViewers: () => Map<
    string,
    Map<string, { clientId: string; cols: number; rows: number; activity: number }>
  >
  remoteTerminalViewSubscriberCounts: () => Map<string, number>
  removePersistedHeadlessTerminalTab: (...args: any[]) => any
  rendererPublicationThrottle: () => RendererPublicationThrottle
  resizeListeners: () => Map<
    string,
    Set<
      (event: {
        cols: number
        rows: number
        displayMode: string
        reason: string
        seq?: number
      }) => void
    >
  >
  resolveDesktopRestoreTarget: (ptyId: string) => { cols: number; rows: number }
  resolveExitWaiters: (leaf: RuntimeLeafRecord) => void
  resolvePtyExitWaiters: (pty: RuntimePtyWorktreeRecord, ptyId: string) => void
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
  resolveWorkspaceTerminalStartupCwd: (
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ) => string | undefined
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  retireMobileSessionSurfacesForPty: (...args: any[]) => any
  searchMobileFilePaths: () => (
    worktreeSelector: string,
    query: string,
    limit: number
  ) => Promise<RuntimeFileListResult>
  seedHeadlessTerminal: (
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata?: any
  ) => void
  setDriver: (ptyId: string, next: DriverState) => void
  setPairedRendererSessionOwnership: (ptyId: string, owned: boolean) => void
  settleSessionTabsInventory: (
    inventory: {
      snapshots: RuntimeMobileSessionTabsResult[]
      ptyInventory: PtyControllerInventory | null
      changeSequence: number
    },
    clientNavigationId?: string,
    signal?: AbortSignal
  ) => Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }>
  setupCompletionTokenByPtyId: () => Map<string, string>
  shouldDelayPtyBackedMobileSnapshotForForegroundAgent: () => (
    pty: RuntimePtyWorktreeRecord,
    title: string
  ) => boolean
  snapshotValueComparison: () => RuntimeMobileSnapshotValueComparisonCommands
  store: () => RuntimeStore | null
  tabs: () => Map<string, RuntimeSyncedTab>
  terminalCwdByPtyId: () => Map<string, string>
  terminalFileUriHostnameByPtyId: () => Map<string, string>
  terminalFitOverrides: () => Map<
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
  terminalSpawnCommandsByPtyId: () => Map<string, string>
  trackHeadlessTerminalData: (
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies?: boolean
  ) => Promise<void>
  waitForSessionTabsInventoryPublication: (signal?: AbortSignal) => Promise<void>
  withClientHostedPagesHold: (...args: any[]) => any
  wslDistroByPtyId: () => Map<string, string>
}
// eslint-enable @typescript-eslint/no-explicit-any

export class RuntimeMobileSessionFacade {
  private readonly deps: RuntimeMobileSessionFacadeDeps
  readonly mobileDictation: {
    id: string
    owner: string
    clientId?: string
    connectionId?: string
    state: 'starting' | 'active' | 'closing'
    partialText: string
    finalTexts: string[]
    errors: string[]
  } | null = null
  readonly mobileDisplayModes = new Map<string, 'desktop'>()
  readonly mobileInputFloorClaims = new Map<
    string,
    {
      base: DriverState
      generation: number
      committedGeneration: number
      pending: Map<symbol, { clientId: string; generation: number }>
    }
  >()
  readonly mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer =
    createMobileSessionTabsNotifyCoalescer((worktreeId) =>
      this.flushScheduledMobileSessionTabsChanged(worktreeId)
    )
  readonly mobileTerminalCreateByMutationId = new Map<
    string,
    Promise<RuntimeMobileSessionCreateTerminalResult>
  >()
  pendingMobileSessionPtyAggregateInventoryRefresh: Promise<PtyControllerInventory | null> | null =
    null
  readonly pendingMobileSessionTabsChangeSequenceByWorktree = new Map<string, number>()

  // Why: notifier/store accessors are nullable on the god class; original methods relied on
  // external guards or threw earlier. Preserve behavior with local narrowing helpers.
  private requireNotifier(): RuntimeNotifier {
    const n = this.deps.notifier()
    if (!n) {
      throw new Error('renderer_unavailable')
    }
    return n
  }

  constructor(deps: RuntimeMobileSessionFacadeDeps) {
    this.deps = deps
  }

  private ctxInstance: RuntimeMobileSessionFacadeCtx | null = null

  // Why: one shared ctx object; module functions mutate facade-owned state through it.
  private get ctx(): RuntimeMobileSessionFacadeCtx {
    if (!this.ctxInstance) {
      this.ctxInstance = {
        deps: this.deps,
        mobileDictation: this.mobileDictation,
        mobileDisplayModes: this.mobileDisplayModes,
        mobileInputFloorClaims: this.mobileInputFloorClaims,
        mobileTerminalCreateByMutationId: this.mobileTerminalCreateByMutationId,
        pendingMobileSessionPtyAggregateInventoryRefresh:
          this.pendingMobileSessionPtyAggregateInventoryRefresh,
        pendingMobileSessionTabsChangeSequenceByWorktree:
          this.pendingMobileSessionTabsChangeSequenceByWorktree,
        mobileSessionTabsNotifyCoalescer: this.mobileSessionTabsNotifyCoalescer,
        listMobileSessionTabs: (selector, navId) => this.listMobileSessionTabs(selector, navId),
        emitMobileSessionTabsSnapshotToClient: (snapshot, navId, hold) => {
          const projected = hold
            ? this.deps.withClientHostedPagesHold()(snapshot, navId)
            : this.deps.mobileTabSnapshots().projectMobileSessionTabsForClient(snapshot, navId)
          for (const subscription of this.deps.mobileSessionTabListeners()) {
            const clientSnapshot = this.deps
              .clientSessionTabSelections()
              .project(projected, subscription.clientNavigationId)
            subscription.listener(clientSnapshot, this.deps.nextMobileSessionTabsChangeSequence())
          }
        }
      }
    }
    return this.ctxInstance
  }

  retireResolvedNativeChatLaunchDraftFromMobileSnapshot(
    resolution: NativeChatLaunchDraftResolutionTombstone
  ): void {
    this.deps
      .clientEventPublishingCommands()
      .retireResolvedNativeChatLaunchDraftFromMobileSnapshot(resolution)
  }

  async publishRecoveredSshMobileSessionTabs(targetId: string, generation: number): Promise<void> {
    return publishRecoveredSshMobileSessionTabs(this.ctx, targetId, generation)
  }

  collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    return collectMobileVisibleGraphChangedWorktrees(this.ctx, previousTabs, previousLeaves)
  }

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId)
      await this.refreshMobileSessionPtyRecords(explicitWorktreeId)
      this.restoreLivePairedRendererSessionOwnedMobileTerminals(explicitWorktreeId)
      return this.getMobileSessionTabsForWorktree(explicitWorktreeId, clientNavigationId)
    }
    const worktree = await this.deps.resolveWorktreeSelector(worktreeSelector)
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id)
    await this.refreshMobileSessionPtyRecords()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktree.id)
    return this.getMobileSessionTabsForWorktree(worktree.id, clientNavigationId)
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return (await this.listAllMobileSessionTabsWithChangeSequence(clientNavigationId)).snapshots
  }

  async listAllMobileSessionTabsWithChangeSequence(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    changeSequence: number
  }> {
    const inventory = await this.collectAllMobileSessionTabs(clientNavigationId)
    return { snapshots: inventory.snapshots, changeSequence: inventory.changeSequence }
  }

  async collectAllMobileSessionTabs(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    ptyInventory: PtyControllerInventory | null
    changeSequence: number
  }> {
    for (const worktreeId of this.deps.getKnownWorkspaceSessionWorktreeIds()) {
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    const ptyInventory = await this.refreshMobileSessionPtyInventory()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null)
    const snapshots = [...this.deps.mobileSessionTabsByWorktree().values()].map((snapshot) =>
      this.projectMobileSessionTabsForClient(
        this.toMobileSessionTabsResult(snapshot),
        clientNavigationId
      )
    )
    return {
      snapshots,
      ptyInventory,
      changeSequence: this.deps.nextMobileSessionTabsChangeSequence() - 1
    }
  }

  async listAllMobileSessionTabsInventory(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }> {
    const { snapshots, authoritative } =
      await this.listAllMobileSessionTabsInventoryWithChangeSequence(clientNavigationId, signal)
    return { snapshots, ...(authoritative ? { authoritative } : {}) }
  }

  async listAllMobileSessionTabsInventoryWithChangeSequence(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    this.deps.assertSessionTabsInventoryRequestActive(signal)
    const primedPublicationEpoch = this.deps.getAuthoritativeSessionTabsInventoryEpoch()
    const primed = await this.collectAllMobileSessionTabs(clientNavigationId)
    this.deps.assertSessionTabsInventoryRequestActive(signal)
    if (
      primedPublicationEpoch !== null &&
      this.deps.getAuthoritativeSessionTabsInventoryEpoch() === primedPublicationEpoch
    ) {
      return await this.deps.settleSessionTabsInventory(primed, clientNavigationId, signal)
    }
    while (true) {
      const publicationEpoch = this.deps.getAuthoritativeSessionTabsInventoryEpoch()
      if (publicationEpoch === null) {
        await this.deps.waitForSessionTabsInventoryPublication(signal)
        continue
      }
      const inventory = await this.collectAllMobileSessionTabs(clientNavigationId)
      this.deps.assertSessionTabsInventoryRequestActive(signal)
      if (this.deps.getAuthoritativeSessionTabsInventoryEpoch() === publicationEpoch) {
        return await this.deps.settleSessionTabsInventory(inventory, clientNavigationId, signal)
      }
    }
  }

  getMobileSessionSnapshotTabIdentityKeys(tab: RuntimeMobileSessionSnapshotTab): string[] {
    return getMobileSessionSnapshotTabIdentityKeys(tab)
  }

  publishPtyBackedMobileSessionTerminal(
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord,
    args: {
      tabId: string
      leafId: string
      title: string | null
      activate: boolean
      selectIfNoActiveTab?: boolean
      startupCwd?: string
      viewMode?: 'terminal' | 'chat'
      split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
      notify?: boolean
    }
  ): void {
    return publishPtyBackedMobileSessionTerminal(this.ctx, worktreeId, pty, args)
  }

  async refreshMobileSessionPtyRecords(
    targetWorktreeId: string | null = null
  ): Promise<Set<string> | null> {
    return refreshMobileSessionPtyRecords(this.ctx, targetWorktreeId)
  }

  async refreshMobileSessionPtyInventory(
    targetWorktreeId: string | null = null
  ): Promise<PtyControllerInventory | null> {
    return refreshMobileSessionPtyInventory(this.ctx, targetWorktreeId)
  }

  async performMobileSessionPtyRecordsRefresh(
    targetWorktreeId: string | null
  ): Promise<PtyControllerInventory | null> {
    return performMobileSessionPtyRecordsRefresh(this.ctx, targetWorktreeId)
  }

  async activateMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    leafId?: string,
    opts: {
      notifyClients?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      intent?: TabActivationIntent
    } = {}
  ): Promise<RuntimeMobileSessionTabsResult> {
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const explicitWorktreeId = this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.deps.resolveWorktreeSelector(worktreeSelector)).id
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    await this.refreshMobileSessionPtyRecords(worktreeId)
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const directTab = snapshot?.tabs.find((candidate) => candidate.id === tabId)
    const tab = leafId
      ? ((directTab?.type === 'terminal' && directTab.leafId === leafId ? directTab : undefined) ??
        snapshot?.tabs.find(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tabId &&
            candidate.leafId === leafId
        ))
      : (directTab ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
        ) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
        ))
    if (!snapshot || !tab) {
      throw new Error('tab_not_found')
    }

    if (tab.type === 'terminal') {
      const publicTab = this.toMobileSessionTabsResult(snapshot).tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.id === tab.id
      )
      // Why: serve-created tabs can be visible before any renderer has adopted
      // their tab id, so focusing the renderer would silently no-op.
      // Phone-local activation also needs this path for inactive restored tabs:
      // desktop focus is intentionally suppressed, but the PTY still must exist.
      const shouldMaterializePendingTerminal =
        publicTab?.type === 'terminal' &&
        publicTab.status !== 'ready' &&
        // Why: opening a tab is the documented wake gesture for a slept pane
        // (#11598), so only a background probe may be refused for one.
        (!isAutomaticTabActivation(opts.intent) ||
          !this.deps.isDeliberatelyParkedPane(worktreeId, tab)) &&
        (!targetsHost ||
          !this.deps.notifier()?.focusTerminal ||
          this.shouldMaterializeHeadlessMobileSessionTab(snapshot, tab))
      if (shouldMaterializePendingTerminal) {
        const sessionId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
        const targetGroupId = snapshot?.tabGroups?.find((group) =>
          group.tabOrder.includes(tab.parentTabId)
        )?.id
        // Why: a pending agent tab may exist without its startup command ever
        // having been delivered (the create's renderer stalled, #7587), so a
        // bare materialize would put a plain shell under the agent icon.
        // Re-resolve the launch like the create path; providers skip startup
        // commands when attaching to live sessions, so this cannot double-launch.
        let agentStartup: Awaited<
          ReturnType<RuntimeMobileSessionFacade['resolveMobileSessionTerminalCommand']>
        > = {}
        if (tab.launchAgent) {
          try {
            const workspace = await this.deps.resolveTerminalWorkspaceLaunchScope(
              `id:${worktreeId}`
            )
            agentStartup = await this.resolveMobileSessionTerminalCommand(workspace, {
              agent: tab.launchAgent
            })
          } catch {
            // Why: a disabled or unresolvable agent must not make the tab
            // untappable; fall back to the plain-shell materialize.
          }
        }
        try {
          await this.createRuntimeOwnedMobileSessionTerminal(worktreeId, targetsHost, undefined, {
            identity: {
              tabId: tab.parentTabId,
              leafId: tab.leafId,
              sessionId
            },
            cwd: tab.startupCwd,
            command: agentStartup.command,
            env: agentStartup.env,
            startupCommandDelivery: agentStartup.startupCommandDelivery,
            launchConfig: agentStartup.launchConfig,
            launchAgent: tab.launchAgent,
            targetGroupId
          })
        } catch (err) {
          if (sessionId && parseAppSshPtyId(sessionId)) {
            // Why: an expired SSH reattach clears durable bindings in the store,
            // but this in-memory headless snapshot can still carry the old id.
            this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
              force: true
            })
          }
          throw err
        }
        return this.applyMobileSessionTabNavigation(
          this.getMobileSessionTabsForWorktree(worktreeId),
          tab.id,
          navigation,
          opts.clientNavigationId
        )
      }
      const callerSnapshot = this.getMobileSessionTabsForWorktree(
        worktreeId,
        opts.clientNavigationId
      )
      const activeSibling =
        tab.id === tabId || leafId
          ? null
          : (callerSnapshot.tabs.find(
              (candidate) =>
                candidate.type === 'terminal' &&
                candidate.parentTabId === tab.parentTabId &&
                candidate.isActive
            ) as RuntimeMobileSessionTerminalTab | undefined)
      const targetTab = activeSibling ?? tab
      if (targetsHost && !this.deps.notifier()?.focusTerminal) {
        if (
          !targetTab.isActive &&
          this.shouldPersistHeadlessMobileSessionActivation(snapshot, targetTab)
        ) {
          this.activateHeadlessMobileSessionTerminalTab(worktreeId, snapshot, targetTab)
        }
      } else if (targetsHost) {
        this.deps.notifier()?.focusTerminal?.(targetTab.parentTabId, worktreeId, targetTab.leafId)
      }
      return this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        targetTab.id,
        navigation,
        opts.clientNavigationId
      )
    } else if (tab.type === 'browser') {
      // Why: browser mobile tabs are renderer-owned unified tabs; focusing the
      // session tab keeps desktop tab order/group state authoritative.
      if (targetsHost) {
        this.deps.notifier()?.focusEditorTab?.(tab.id, worktreeId)
      }
    } else {
      if (targetsHost) {
        this.deps.notifier()?.focusEditorTab?.(tab.id, worktreeId)
      }
    }
    return this.applyMobileSessionTabNavigation(
      this.getMobileSessionTabsForWorktree(worktreeId),
      tab.id,
      navigation,
      opts.clientNavigationId
    )
  }

  applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return applyMobileSessionTabNavigation(
      this.ctx,
      snapshot,
      activeTabId,
      navigation,
      clientNavigationId
    )
  }

  shouldMaterializeHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return shouldMaterializeHeadlessMobileSessionTab(this.ctx, snapshot, tab)
  }

  shouldPersistHeadlessMobileSessionActivation(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return shouldPersistHeadlessMobileSessionActivation(this.ctx, snapshot, tab)
  }

  activateHeadlessMobileSessionTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    activeTab: RuntimeMobileSessionTerminalTab
  ): void {
    return activateHeadlessMobileSessionTerminalTab(this.ctx, worktreeId, snapshot, activeTab)
  }

  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string
  ): Promise<MobileSessionTabCloseOutcome> {
    return await refuseUnattributedMobileSessionTabClose(this.ctx, worktreeSelector, tabId)
  }

  republishMobileSessionTabsSnapshot(worktreeId: string): void {
    return republishMobileSessionTabsSnapshot(this.ctx, worktreeId)
  }

  getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (!pty) {
      return null
    }
    return this.deps.handleByPtyId().get(pty.ptyId) ?? this.deps.findHandleForPtyRecord(pty.ptyId)
  }

  isOffscreenMobileSessionBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    if (!this.deps.offscreenBrowserBackend() || !tab.browserPageId) {
      return false
    }
    if (this.deps.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch)) {
      return true
    }
    const accepted = this.deps.acceptedRendererMobileSnapshotByWorktree().get(snapshot.worktree)
    return (
      snapshot.publicationEpoch.includes(':headless-merge:') &&
      accepted !== undefined &&
      !this.getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
        accepted.rendererTabIdentityKeys.has(id)
      ) &&
      this.deps.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId)
    )
  }

  closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowMissingPersistedTab?: boolean; killPtys?: boolean } = {}
  ): void {
    const closedParentTabId = tab.parentTabId
    this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, closedParentTabId)
    const projectedPtyIds = this.deps.removePersistedHeadlessTerminalTab(
      worktreeId,
      closedParentTabId,
      {
        allowMissing: options.allowMissingPersistedTab
      }
    )
    // Why: local provider ids can be reused after restart, so a dormant
    // persisted id is not kill authority. SSH relay ids remain durable exact
    // identities even before pane metadata reconnects.
    const ptyIdsToKill = new Set(projectedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId)))
    for (const candidate of snapshot.tabs) {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        continue
      }
      const livePty = this.findPtyForMobileTerminalTab(worktreeId, candidate)
      const ptyId = livePty?.ptyId ?? candidate.ptyId
      const hasOtherOwner = snapshot.tabs.some(
        (other) =>
          other.type === 'terminal' &&
          other.parentTabId !== closedParentTabId &&
          other.ptyId === ptyId
      )
      if (ptyId && !hasOtherOwner && (livePty || parseAppSshPtyId(ptyId))) {
        // Why: a live serve leaf can exist before its debounced binding reaches
        // persistence. Include it from the authoritative snapshot so split
        // close cannot leave a provider process behind.
        ptyIdsToKill.add(ptyId)
      }
    }
    if (options.killPtys !== false) {
      for (const ptyId of ptyIdsToKill) {
        this.deps.ptyController()?.kill(ptyId as string)
      }
    }
    const nextTabs = snapshot.tabs.filter((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return true
      }
      return false
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: this.buildHeadlessMobileSessionTabGroups(
        worktreeId,
        nextTabs,
        active,
        snapshot.tabGroups
      ),
      tabs: nextTabs
    }
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.deps.resolveWorktreeSelector(worktreeSelector)).id
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    const notifier = this.deps.notifier()
    if (!notifier?.moveSessionTab) {
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }

    // Why: web clients address terminal surfaces as tab::leaf, while desktop
    // tab grouping is owned by the outer terminal tab id.
    if (move.kind === 'reorder') {
      const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
      if (!tabOrder.includes(hostTabId)) {
        throw new Error('invalid_tab_order')
      }
      notifier.moveSessionTab(worktreeId, {
        ...move,
        tabId: hostTabId,
        tabOrder
      })
      return { moved: true }
    }
    notifier.moveSessionTab(worktreeId, {
      ...move,
      tabId: hostTabId
    })
    return { moved: true }
  }

  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.deps.resolveWorktreeSelector(worktreeSelector)).id
    // Why: when a renderer is authoritative (desktop host reached via shared
    // control), it owns pane geometry and republishes it — a headless write here
    // would be overwritten and could fight the renderer. Persist only headlessly.
    if (this.deps.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    // Why: resolve to the host tab id (older/raw-id clients) so the persisted
    // layout entry matches, matching setMobileSessionTabProps.
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    const resolvedArgs = { ...args, tabId: hostTabId }
    const acceptedLayout = this.deps.persistHeadlessTerminalPaneLayout()(worktreeId, resolvedArgs)
    if (acceptedLayout) {
      this.deps.applyHeadlessTerminalPaneLayoutToSnapshot()(worktreeId, {
        tabId: hostTabId,
        root: acceptedLayout.root,
        expandedLeafId: acceptedLayout.expandedLeafId,
        ...(acceptedLayout.titlesByLeafId ? { titlesByLeafId: acceptedLayout.titlesByLeafId } : {})
      })
    }
    return { updated: true }
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
    const explicitWorktreeId = this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.deps.resolveWorktreeSelector(worktreeSelector)).id
    // Why: a renderer-authoritative host owns + republishes tab props, so a
    // headless write would be overwritten. Persist only when headless.
    if (this.deps.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    this.deps
      .headlessSessionTabPersistenceCommands()
      .persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
    this.deps
      .headlessSessionTabPersistenceCommands()
      .applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, args)
    return { updated: true }
  }

  moveHeadlessMobileSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: RuntimeMobileSessionTabMove
  ): RuntimeMobileSessionTabMoveResult {
    if (move.kind === 'split') {
      return this.splitHeadlessMobileSessionTabGroup(worktreeId, snapshot, move)
    }
    if (move.kind === 'move-to-group') {
      return this.moveHeadlessMobileSessionTabToGroup(worktreeId, snapshot, move)
    }
    if (move.kind !== 'reorder') {
      throw new Error('renderer_unavailable')
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }
    const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
    const orderIndexByParentTabId = new Map(tabOrder.map((tabId, index) => [tabId, index]))
    const nextTabs = [...snapshot.tabs].sort((a, b) => {
      const aParent = a.type === 'terminal' ? a.parentTabId : a.id
      const bParent = b.type === 'terminal' ? b.parentTabId : b.id
      const aIndex = orderIndexByParentTabId.get(aParent) ?? Number.MAX_SAFE_INTEGER
      const bIndex = orderIndexByParentTabId.get(bParent) ?? Number.MAX_SAFE_INTEGER
      return aIndex - bIndex
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const reorderedTargetActiveTabId =
      active?.type === 'terminal' ? active.parentTabId : active ? active.id : (tabOrder[0] ?? null)
    // Why: reorder only changes ONE group's order. Preserve every other group so
    // a multi-group split isn't deleted by re-sorting tabs in one of its groups.
    const existingGroups = snapshot.tabGroups ?? []
    const nextGroups = existingGroups.some((group) => group.id === targetGroup.id)
      ? existingGroups.map((group) =>
          group.id === targetGroup.id
            ? { ...group, tabOrder, activeTabId: reorderedTargetActiveTabId }
            : group
        )
      : [{ ...targetGroup, tabOrder, activeTabId: reorderedTargetActiveTabId }]
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: nextGroups,
      tabs: nextTabs
    }
    this.deps.persistHeadlessTerminalTabOrder(worktreeId, tabOrder)
    if (nextGroups.length > 1 && snapshot.tabGroupLayout) {
      this.deps.persistHeadlessTabGroups(worktreeId, nextGroups, snapshot.tabGroupLayout)
    }
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  splitHeadlessMobileSessionTabGroup(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: Extract<RuntimeMobileSessionTabMove, { kind: 'split' }>
  ): RuntimeMobileSessionTabMoveResult {
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const split = buildHeadlessTabGroupSplit({
      groups: snapshot.tabGroups ?? [],
      layout: snapshot.tabGroupLayout,
      tabId: hostTabId,
      targetGroupId: move.targetGroupId,
      splitDirection: move.splitDirection,
      newGroupId: randomUUID()
    })
    if (!split) {
      // Renderer treats an unsplittable drop (e.g. last tab onto its own group)
      // as a no-op; mirror that instead of churning the snapshot.
      return { moved: true }
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: split.newGroupId,
      tabGroups: split.groups,
      tabGroupLayout: split.layout
    }
    this.deps.persistHeadlessTabGroups(worktreeId, split.groups, split.layout)
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  moveHeadlessMobileSessionTabToGroup(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: Extract<RuntimeMobileSessionTabMove, { kind: 'move-to-group' }>
  ): RuntimeMobileSessionTabMoveResult {
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const moved = buildHeadlessTabGroupMove({
      groups: snapshot.tabGroups ?? [],
      layout: snapshot.tabGroupLayout,
      tabId: hostTabId,
      targetGroupId: move.targetGroupId,
      index: move.index
    })
    if (!moved) {
      // Same-group / missing-target drop is a renderer no-op; mirror that.
      return { moved: true }
    }
    const layout = moved.layout ?? { type: 'leaf' as const, groupId: move.targetGroupId }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: move.targetGroupId,
      tabGroups: moved.groups,
      tabGroupLayout: layout
    }
    this.deps.persistHeadlessTabGroups(worktreeId, moved.groups, layout)
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  normalizeMobileSessionTabOrder(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    targetGroup: RuntimeMobileSessionTabGroup,
    tabOrder: readonly string[]
  ): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const tabId of tabOrder) {
      const hostTabId = this.resolveMobileSessionHostTabId(snapshot, tabId)
      if (!hostTabId) {
        throw new Error('invalid_tab_order')
      }
      if (seen.has(hostTabId)) {
        throw new Error('duplicate_tab_order')
      }
      seen.add(hostTabId)
      normalized.push(hostTabId)
    }

    const returnedIds = this.collectPublicMobileSessionTabIds(snapshot)
    const expected = targetGroup.tabOrder
      .map((tabId) => this.resolveMobileSessionHostTabId(snapshot, tabId) ?? tabId)
      // Why: clients reorder the sanitized session.tabs.list model; raw groups
      // can still contain stale browser ids hidden from paired web clients.
      .filter((tabId) => returnedIds.has(tabId))
    const structuredIds = expected.filter((tabId) =>
      snapshot?.tabs.some((tab) => tab.type === 'agent-session' && tab.id === tabId)
    )
    if (structuredIds.some((tabId) => !seen.has(tabId))) {
      if (structuredIds.some((tabId) => seen.has(tabId))) {
        throw new Error('invalid_tab_order')
      }
      const visibleExpected = expected.filter((tabId) => !structuredIds.includes(tabId))
      if (
        normalized.length !== visibleExpected.length ||
        visibleExpected.some((tabId) => !seen.has(tabId))
      ) {
        throw new Error('invalid_tab_order')
      }
      for (const tabId of structuredIds) {
        normalized.splice(Math.min(expected.indexOf(tabId), normalized.length), 0, tabId)
      }
      return normalized
    }
    // Why: reorder is a pure permutation of one existing group. Missing or
    // extra ids would let a paired web client silently move/lose host tabs.
    if (normalized.length !== expected.length || expected.some((tabId) => !seen.has(tabId))) {
      throw new Error('invalid_tab_order')
    }
    return normalized
  }

  collectPublicMobileSessionTabIds(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  ): Set<string> {
    const ids = new Set<string>()
    if (!snapshot) {
      return ids
    }
    const liveBrowserTabsByPageId = this.deps.getLiveBrowserTabsByPageId(snapshot.worktree)
    for (const tab of snapshot.tabs) {
      if (tab.type === 'browser') {
        const liveTab = tab.browserPageId
          ? liveBrowserTabsByPageId.get(tab.browserPageId)
          : undefined
        if (!liveTab) {
          continue
        }
        ids.add(tab.id)
        ids.add(tab.browserWorkspaceId)
        continue
      }
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      }
    }
    return ids
  }

  resolveMobileSessionHostTabId(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    tabId: string
  ): string | null {
    const tab =
      snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
      ) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
      )
    if (!tab) {
      return null
    }
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    const notifier = this.requireNotifier()
    if (!notifier.readMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await notifier.readMobileMarkdownTab(worktreeId, tabId)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    const notifier = this.requireNotifier()
    if (!notifier.saveMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await notifier.saveMobileMarkdownTab(worktreeId, tabId, baseVersion, content)
  }

  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void,
    clientNavigationId?: string
  ): () => void {
    // Why: a notify coalesced before this subscriber existed is already folded
    // into the initial snapshot it was just sent. Draining it here — before the
    // listener joins — keeps that pending timer from landing as a redundant
    // `updated` frame carrying pre-subscribe state. Mirrors the unsubscribe flush.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = { listener, clientNavigationId }
    this.deps.mobileSessionTabListeners().add(subscription)
    return () => {
      // Why: flush pending coalesced notifies before dropping this listener so a
      // subscriber closing mid-window still receives the latest settled state.
      this.mobileSessionTabsNotifyCoalescer.flushAll()
      this.deps.mobileSessionTabListeners().delete(subscription)
      if (this.deps.mobileSessionTabListeners().size === 0) {
        this.deps.mobileSessionTabsAgentStatusHeartbeat().cancelPending()
      }
    }
  }

  retainAgentRowSnapshot(
    ptyId: string,
    paneKey: string,
    worktreeId: string | undefined,
    tabId: string | undefined,
    connectionId: string | null,
    payload: ParsedAgentStatusPayload
  ): boolean {
    const now = Date.now()
    const previous = this.deps.latestAgentStatusByPaneKey().get(paneKey)
    // Why: stateStartedAt must mark the transition into the current state, not
    // every within-state ping (tool/prompt updates keep the state but refresh
    // updatedAt) — mirrors AgentStatusEntry.stateStartedAt on the desktop side.
    const stateStartedAt =
      previous && previous.payload.state === payload.state ? previous.stateStartedAt : now
    this.deps.latestAgentStatusByPaneKey().set(paneKey, {
      paneKey,
      ptyId,
      worktreeId,
      tabId,
      connectionId,
      payload,
      stateStartedAt,
      updatedAt: now
    })
    // Client-visible change detection: snapshot republish is gated on this so
    // repeated same-state hook pings don't fan a rebuild out to every client.
    return (
      !previous ||
      previous.payload.state !== payload.state ||
      previous.payload.workingMode !== payload.workingMode ||
      previous.payload.prompt !== payload.prompt ||
      (previous.payload.agentType ?? null) !== (payload.agentType ?? null) ||
      (previous.payload.toolName ?? null) !== (payload.toolName ?? null) ||
      (previous.payload.interactivePrompt ?? null) !== (payload.interactivePrompt ?? null) ||
      (previous.payload.interrupted ?? false) !== (payload.interrupted ?? false) ||
      (previous.payload.turnCompletedAt ?? null) !== (payload.turnCompletedAt ?? null) ||
      (previous.payload.lastAssistantMessage ?? null) !== (payload.lastAssistantMessage ?? null)
    )
  }

  clearAgentRowSnapshotsForPty(ptyId: string): void {
    for (const [paneKey, snapshot] of this.deps.latestAgentStatusByPaneKey()) {
      if (snapshot.ptyId === ptyId) {
        this.deps.latestAgentStatusByPaneKey().delete(paneKey)
      }
    }
  }

  isMobileTerminalQueryReplyAuthority(ptyId: string, clientId: string): boolean {
    // Why: a passive phone watching desktop-sized output must not race the
    // desktop xterm. Mobile becomes reply authority only with the mobile floor.
    if (this.deps.getDriver(ptyId).kind !== 'mobile') {
      return false
    }
    const subscribers = this.deps.mobileSubscribers().get(ptyId)
    if (!subscribers) {
      return false
    }
    // Why: soft-leave resubscribe preserves the original subscription time but
    // reinserts the record. Elect fitted responders from that stable age, not
    // mutable Map order or passive desktop-mode watchers.
    let earliest: { clientId: string; subscribedAt: number } | null = null
    for (const subscriber of subscribers.values()) {
      if (!subscriber.wasResizedToPhone) {
        continue
      }
      if (earliest === null || subscriber.subscribedAt < earliest.subscribedAt) {
        earliest = subscriber
      }
    }
    return earliest?.clientId === clientId
  }

  async withVisibleSnapshotFallback(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { cursor?: number; limit?: number } = {},
    providerSnapshot: ProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    if (typeof opts.cursor === 'number') {
      return read
    }
    const blankFallback = shouldFallbackToVisibleTerminalSnapshot(read, opts)
    const recoveredWorkerFallback =
      read.tail.length === 0 && this.deps.legacyWorkerRecoveredPtys().has(ptyId)
    // Why: a live daemon session no pane ever attached has ingested zero bytes,
    // so only the provider holds its screen. Unprovable state stays empty.
    const neverAttachedProviderFallback =
      read.tail.length === 0 &&
      !recoveredWorkerFallback &&
      this.deps.isKnownUnattachedLocalDaemonPty(ptyId)
    if (recoveredWorkerFallback || neverAttachedProviderFallback) {
      const providerProjection = await this.deps.readProviderTerminalTailLines(
        ptyId,
        opts.limit,
        providerSnapshot
      )
      if (providerProjection.lines.length > 0) {
        return buildVisibleSnapshotReadFallback(
          read,
          providerProjection.lines,
          opts.limit,
          providerProjection.draft
        )
      }
    }
    const knownAlternateScreen = this.deps.isTerminalAlternateScreen(ptyId)
    const providerModeUnknown =
      this.deps.providerSnapshotPreferredPtys().has(ptyId) &&
      !this.deps.providerModeTrackersByPtyId().has(ptyId)
    if (
      !blankFallback &&
      !recoveredWorkerFallback &&
      !providerModeUnknown &&
      !knownAlternateScreen &&
      !this.deps.headlessTerminals().has(ptyId)
    ) {
      return read
    }
    const visibleState = await this.deps.readVisibleTerminalState(ptyId)
    if (
      !blankFallback &&
      !recoveredWorkerFallback &&
      !knownAlternateScreen &&
      !visibleState?.isAlternateScreen
    ) {
      return read
    }
    let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
    if (projection.lines.length === 0) {
      projection = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    if (projection.lines.length === 0) {
      return read
    }
    return buildVisibleSnapshotReadFallback(read, projection.lines, opts.limit, projection.draft)
  }

  async visibleSnapshotPreview(ptyId: string, preview: string): Promise<string> {
    const knownAlternateScreen = this.deps.isTerminalAlternateScreen(ptyId)
    const providerModeUnknown =
      this.deps.providerSnapshotPreferredPtys().has(ptyId) &&
      !this.deps.providerModeTrackersByPtyId().has(ptyId)
    if (
      !providerModeUnknown &&
      !knownAlternateScreen &&
      !this.deps.headlessTerminals().has(ptyId)
    ) {
      return preview
    }
    const visibleState = await this.deps.readVisibleTerminalState(ptyId)
    if (!knownAlternateScreen && !visibleState?.isAlternateScreen) {
      return preview
    }
    let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
    if (projection.lines.length === 0) {
      projection = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    return projection.lines.length > 0 ? buildPreview(projection.lines, '') : preview
  }

  async parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<{ lines: string[]; draft?: string }> {
    if (snapshot.data.length === 0) {
      return { lines: [] }
    }
    const emulator = new HeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: 0
    })
    try {
      await emulator.write(`\x1b[2J\x1b[3J\x1b[H${snapshot.data}`)
      return projectVisibleTerminalLines(emulator)
    } finally {
      emulator.dispose()
    }
  }

  async readRendererVisibleSnapshotLines(ptyId: string): Promise<RuntimeTerminalProjection> {
    const controller = this.deps.ptyController()
    if (!controller?.serializeBuffer) {
      return { lines: [] }
    }
    if (controller.hasRendererSerializer && !controller.hasRendererSerializer(ptyId)) {
      return { lines: [] }
    }
    try {
      // Why: raw PTY tails can be whitespace-only while a full-screen TUI is
      // visibly nonblank in renderer xterm. Ask the renderer for the active
      // screen instead of reusing the headless transcript path.
      const snapshot = await withTimeout(
        controller.serializeBuffer(ptyId, {
          scrollbackRows: 0,
          altScreenForcesZeroRows: false
        }),
        VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
        null
      )
      if (!snapshot || snapshot.data.length === 0) {
        return { lines: [] }
      }
      return this.parseVisibleSnapshot(snapshot)
    } catch {
      return { lines: [] }
    }
  }

  getMobileNotificationListenerCount(): number {
    return this.deps.notificationListeners().size
  }

  dispatchMobileNotification(event: MobileNotificationEvent): void {
    const seq = this.deps.mobileNotificationReplay().record(event)
    // Why: surface the desktop-assigned seq to live listeners so they can watermark the last event
    // delivered and feed it back to getMissedSince on reconnect (idempotent catch-up, no dupes).
    notifyRuntimeListeners(
      this.deps.notificationListeners(),
      (listener) =>
        listener({
          ...event,
          notificationSeq: seq,
          notificationEpoch: this.deps.mobileNotificationReplay().epoch
        }),
      'mobile-notification'
    )
  }

  getMobileNotificationEpoch(): string {
    return this.deps.mobileNotificationReplay().epoch
  }

  dismissMobileNotification(notificationId: string): void {
    this.dispatchMobileNotification({ type: 'dismiss', notificationId })
  }

  listMobileSpeechModels(): Promise<RuntimeSpeechSetupState> {
    return listMobileSpeechModels(this.ctx)
  }

  downloadMobileSpeechModel(modelId: string): Promise<{ started: true }> {
    return downloadMobileSpeechModel(this.ctx, modelId)
  }

  deleteMobileSpeechModel(modelId: string): Promise<RuntimeSpeechSetupState> {
    return deleteMobileSpeechModel(this.ctx, modelId)
  }

  async configureMobileDictation(params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }): Promise<RuntimeSpeechSetupState> {
    return await configureMobileDictation(this.ctx, params)
  }

  async startMobileDictation(params: {
    dictationId: string
    modelId?: string
    clientId?: string
    connectionId?: string
  }): Promise<{ dictationId: string; modelId: string }> {
    return await startMobileDictation(this.ctx, params)
  }

  feedMobileDictation(params: {
    dictationId: string
    audioBase64: string
    sampleRate: number
    clientId?: string
    connectionId?: string
  }): { dictationId: string } {
    return feedMobileDictation(this.ctx, params)
  }

  async finishMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{ dictationId: string; text: string }> {
    return await finishMobileDictation(this.ctx, params)
  }

  async cancelMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{ dictationId: string }> {
    return await cancelMobileDictation(this.ctx, params)
  }

  cancelMobileDictationSession(
    session: NonNullable<RuntimeMobileSessionFacade['mobileDictation']>
  ): void {
    return cancelMobileDictationSession(this.ctx, session)
  }

  cancelMobileDictationForConnection(connectionId: string): void {
    return cancelMobileDictationForConnection(this.ctx, connectionId)
  }

  cancelMobileDictationForClient(clientId: string): void {
    return cancelMobileDictationForClient(this.ctx, clientId)
  }

  async refreshAccountsForMobile(): Promise<void> {
    return this.deps.accountCommands().refreshAccountsForMobile()
  }

  async refreshAccountsForMobileSubscriber(): Promise<void> {
    return this.deps.accountCommands().refreshAccountsForMobileSubscriber()
  }

  ptyExit_notifyTabAndMobile(
    pty: RuntimePtyRecord | null,
    ptyId: string,
    exitIncarnationId: PtyIncarnationId | undefined,
    exitCode: number,
    exitCause: TerminalExitCause,
    preservesAbnormalSshSurface: boolean,
    preservesIntentionalHandlessSurface: boolean,
    exactSurfaces: Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[],
    incarnationId: PtyIncarnationId
  ): { handle: string; paneKey: string | null }[] {
    const pendingIncarnation = this.deps.pendingPtyRegistrationIncarnations().get(ptyId)
    const exitMatchesPendingRegistration =
      this.deps.pendingPtyRegistrationIncarnations().has(ptyId) &&
      (pendingIncarnation === null ||
        exitIncarnationId === null ||
        exitIncarnationId === undefined ||
        pendingIncarnation === exitIncarnationId)
    if (exitMatchesPendingRegistration) {
      this.deps
        .earlyExitedPtyIncarnations()
        .set(ptyId, exitIncarnationId ?? pendingIncarnation ?? pty?.incarnationId ?? null)
    }

    advertisedUrlWatcher.unbindPty(ptyId)
    agentSessionPtyWriteGate.unbindPty(ptyId)

    this.deps.mobileSubscribers().delete(ptyId)
    this.deps.remoteTerminalViewSubscriberCounts().delete(ptyId)
    this.deps.rawTerminalViewSubscriberCounts().delete(ptyId)
    this.mobileDisplayModes.delete(ptyId)
    this.deps.resizeListeners().delete(ptyId)
    this.deps.lastRendererSizes().delete(ptyId)
    this.deps.recentPtyOutputById().delete(ptyId)
    this.deps.setupCompletionTokenByPtyId().delete(ptyId)
    this.deps.clearWaitBlockedCheckState(ptyId)
    this.deps.recentPtyPathCandidatesById().delete(ptyId)
    this.deps.ptyOutputSequenceById().delete(ptyId)
    this.deps.providerSequenceInitializedPtys().delete(ptyId)
    this.deps.providerSequenceOffsetByPtyId().delete(ptyId)
    this.deps.providerSnapshotPreferredPtys().delete(ptyId)
    this.deps.providerModeTrackersByPtyId().delete(ptyId)
    this.deps.providerModeSnapshotScansByPtyId().delete(ptyId)
    this.deps.providerBufferAcquisitionsByPtyId().delete(ptyId)
    this.deps.providerVisibleStateByPtyId().delete(ptyId)
    this.deps.providerVisibleRetryAtByPtyId().delete(ptyId)
    this.deps.agentPromptExplicitStatusFloorByPtyId().delete(ptyId)
    this.deps.agentStatusOscProcessorsByPtyId().delete(ptyId)
    this.deps.terminalSpawnCommandsByPtyId().delete(ptyId)
    this.deps.disposePtyTitleTracker()(ptyId)
    this.deps.oscTitleScanTailByPtyId().delete(ptyId)
    this.deps.osc7ScanTailByPtyId().delete(ptyId)
    this.deps.terminalCwdByPtyId().delete(ptyId)
    this.deps.terminalFileUriHostnameByPtyId().delete(ptyId)
    this.deps.wslDistroByPtyId().delete(ptyId)
    this.clearAgentRowSnapshotsForPty(ptyId)

    const exitedTeamLeaderHandle = this.deps.handleByPtyId().get(ptyId)
    if (exitedTeamLeaderHandle) {
      this.deps.claudeAgentTeams().removeTeamForLeaderHandle(exitedTeamLeaderHandle)
    }

    if (this.deps.terminalFitOverrides().has(ptyId)) {
      this.deps.terminalFitOverrides().delete(ptyId)
      this.deps.notifier()?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.deps.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }

    if (this.deps.currentDriver().has(ptyId)) {
      this.deps.currentDriver().delete(ptyId)
      this.deps.notifier()?.terminalDriverChanged(ptyId, { kind: 'idle' })
    }

    this.deps.remoteDesktopViewers().delete(ptyId)
    this.deps.remoteDesktopOwners().delete(ptyId)
    this.deps.remoteDesktopHostReclaimTargets().delete(ptyId)
    this.deps.remoteDesktopViewerRevisions().delete(ptyId)
    this.deps.disposeHeadlessTerminal(ptyId)

    if (pty) {
      pty.connected = false
      pty.runtimeSessionOwned = false
      this.deps.setPairedRendererSessionOwnership(pty.ptyId, false)
      pty.disconnectedAt = Date.now()
      pty.lastExitCode = exitCode
      pty.lastExitCause = exitCause
      if (exitCode >= 0) {
        this.deps.forgetPtyLivenessVerdict(ptyId)
      }
      pty.lastAgentStatusObservedLive = false
      this.deps.resolvePtyExitWaiters(pty, ptyId)
      this.deps.pruneDisconnectedPtyTranscript(pty)
    }

    if (preservesIntentionalHandlessSurface || preservesAbnormalSshSurface) {
      this.touchMobileSessionSnapshotsForPty(ptyId, { immediate: true })
    } else {
      this.deps.retireMobileSessionSurfacesForPty(ptyId, incarnationId, exactSurfaces)
    }

    const exitedSurfaces: { handle: string; paneKey: string | null }[] = []
    for (const leaf of this.deps.getLeavesForPty(ptyId)) {
      this.deps.detachedPreAllocatedLeaves().delete(ptyId)
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      leaf.lastExitCause = exitCause
      leaf.lastAgentStatusObservedLive = false
      this.deps.resolveExitWaiters(leaf)
      const leafHandle = this.deps
        .handleByLeafKey()
        .get(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
      if (leafHandle) {
        exitedSurfaces.push({ handle: leafHandle, paneKey: `${leaf.tabId}:${leaf.leafId}` })
      }
    }

    const ptyHandle = this.deps.handleByPtyId().get(ptyId)
    if (ptyHandle && !exitedSurfaces.some((surface) => surface.handle === ptyHandle)) {
      exitedSurfaces.push({ handle: ptyHandle, paneKey: pty?.paneKey ?? null })
    }

    return exitedSurfaces
  }

  markMobileActor(ptyId: string, clientId: string): void {
    return markMobileActor(this.ctx, ptyId, clientId)
  }

  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null {
    return beginMobileInputFloor(this.ctx, ptyId, clientId)
  }

  async mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    return mobileTookFloor(this.ctx, ptyId, clientId, previousFloor, isCurrent)
  }

  async updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<{ updated: boolean; applied: boolean }> {
    return updateMobileViewport(this.ctx, ptyId, clientId, viewport)
  }

  getMobileAutoRestoreFitMs(): number | null {
    return getMobileAutoRestoreFitMs(this.ctx)
  }

  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    return setMobileAutoRestoreFitMs(this.ctx, ms)
  }

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    return setMobileDisplayMode(this.ctx, ptyId, mode)
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop' {
    return getMobileDisplayMode(this.ctx, ptyId)
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    return isMobileSubscriberActive(this.ctx, ptyId)
  }

  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void {
    return updateMobileSubscriberViewport(this.ctx, ptyId, clientId, viewport)
  }

  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    return handleMobileSubscribe(this.ctx, ptyId, clientId, viewport)
  }

  async handleMobileSubscribeInternal(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    return handleMobileSubscribeInternal(this.ctx, ptyId, clientId, viewport)
  }

  handleMobileUnsubscribe(ptyId: string, clientId: string): void {
    return handleMobileUnsubscribe(this.ctx, ptyId, clientId)
  }

  async applyMobileDisplayMode(ptyId: string): Promise<boolean> {
    return applyMobileDisplayMode(this.ctx, ptyId)
  }

  async createMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      select?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      clientMutationId?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return await createMobileSessionTerminal(this.ctx, worktreeSelector, opts)
  }

  async runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      clientNavigationId?: string
      clientMutationId?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return await runCreateMobileSessionTerminal(this.ctx, worktreeSelector, opts)
  }

  async resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: {
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
    }
  ): Promise<{
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }> {
    return await resolveMobileSessionTerminalCommand(this.ctx, workspace, opts)
  }

  async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      identity?: { tabId: string; leafId: string; sessionId?: string }
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      targetGroupId?: string
      launchConfig?: SleepingAgentLaunchConfig
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return await createRuntimeOwnedMobileSessionTerminal(
      this.ctx,
      worktreeId,
      activate,
      afterTabId,
      opts
    )
  }

  waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return waitForMobileTerminalSurface(this.ctx, worktreeId, parentTabId, options)
  }

  findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    return findMobileTerminalSurface(this.ctx, worktreeId, parentTabId, options)
  }

  findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    return findMobileTerminalSurfaceForPty(this.ctx, worktreeId, ptyId)
  }

  ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    return ensurePtyBackedMobileSurfaceForRendererTab(this.ctx, worktreeId, tabId)
  }

  restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    return restoreLivePairedRendererSessionOwnedMobileTerminals(this.ctx, worktreeId, options)
  }

  isReadyMobileTerminalSurface(surface: RuntimeMobileSessionCreateTerminalResult | null): boolean {
    return isReadyMobileTerminalSurface(surface)
  }

  replaceHeadlessTerminalFromRendererSnapshotForRecovery(
    ptyId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      cwd?: string | null
      oscLinks?: TerminalOscLinkRange[]
    },
    trailingOutput: { data: string; seq: number }[] = []
  ): void {
    return replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      this.ctx,
      ptyId,
      snapshot,
      trailingOutput
    )
  }

  syncMobileSessionTabs(
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds = new Set<string>()
  ): Set<string> {
    return syncMobileSessionTabs(this.ctx, snapshots, unchangedWorktreeIds, resyncWorktreeIds)
  }

  notifyMobileSessionTabsRemoved(worktreeId: string): void {
    return notifyMobileSessionTabsRemoved(this.ctx, worktreeId)
  }

  scheduleMobileSessionTabsChanged(worktreeId: string): void {
    return scheduleMobileSessionTabsChanged(this.ctx, worktreeId)
  }

  cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    return cancelScheduledMobileSessionTabsChanged(this.ctx, worktreeId)
  }

  flushScheduledMobileSessionTabsChanged(worktreeId: string): void {
    return flushScheduledMobileSessionTabsChanged(this.ctx, worktreeId)
  }

  notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    return notifyMobileSessionTabsChangedNow(this.ctx, worktreeId, changeSequence)
  }

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return getMobileSessionTabsForWorktree(this.ctx, worktreeId, clientNavigationId)
  }

  async resolveMobileMarkdownWorktreeId(worktreeSelector: string, tabId: string): Promise<string> {
    return resolveMobileMarkdownWorktreeId(this.ctx, worktreeSelector, tabId)
  }

  sanitizeMobileSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    returnedTabs: readonly RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined {
    return sanitizeMobileSessionTabGroups(this.ctx, groups, returnedTabs)
  }

  pruneMobileSessionTabGroupLayout(
    layout: TabGroupLayoutNode | null | undefined,
    validGroupIds: ReadonlySet<string>
  ): TabGroupLayoutNode | null {
    return pruneMobileSessionTabGroupLayout(this.ctx, layout, validGroupIds)
  }

  toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    return toMobileSessionTabsResult(this.ctx, snapshot)
  }

  renewMobileAgentStatusFromPtyTitle(
    status: AgentStatusEntry | null,
    pty: RuntimePtyWorktreeRecord | null,
    options: { preserveQuestionUnderShellTitle?: boolean } = {}
  ): AgentStatusEntry | null {
    return this.deps
      .hookAgentRowResolutionCommands()
      .renewMobileAgentStatusFromPtyTitle(status, pty, options)
  }

  buildPtyMobileAgentStatus(
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    terminalHandle: string | null,
    retained: RuntimeAgentRowSnapshot | null,
    getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
  ): { agentStatus: AgentStatusEntry } | Record<string, never> {
    return this.deps
      .hookAgentRowResolutionCommands()
      .buildPtyMobileAgentStatus(pty, tab, terminalHandle, retained, getHookRowsForPane)
  }

  getFreshRetainedAgentStatusForMobileTab(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimeAgentRowSnapshot | null {
    return this.deps
      .hookAgentRowResolutionCommands()
      .getFreshRetainedAgentStatusForMobileTab(paneKey, pty, tab)
  }

  findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    return this.deps
      .hookAgentRowResolutionCommands()
      .findPtyForMobileTerminalTab(worktreeId, tab, options)
  }

  getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    return this.deps.hookAgentRowResolutionCommands().getMobileTerminalPaneKey(tab)
  }

  mobileTerminalTabMatchesPty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    pty: RuntimePtyWorktreeRecord,
    paneKey = this.deps.hookAgentRowResolutionCommands().getMobileTerminalPaneKey(tab)
  ): boolean {
    return this.deps
      .hookAgentRowResolutionCommands()
      .mobileTerminalTabMatchesPty(worktreeId, tab, pty, paneKey)
  }

  // eslint-disable @typescript-eslint/no-explicit-any -- Delegation methods use any to forward arbitrary arguments
  headlessMobileSnapshotContentUnchanged(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).headlessMobileSnapshotContentUnchanged(
      ...args
    )
  }

  mobileSnapshotValueEqual(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).mobileSnapshotValueEqual(...args)
  }

  reconcileHeadlessMobileSessionBrowserTabs(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).reconcileHeadlessMobileSessionBrowserTabs(
      ...args
    )
  }

  clearRuntimeSessionOwnershipForMobileTab(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).clearRuntimeSessionOwnershipForMobileTab(
      ...args
    )
  }

  getMobileTerminalLeafPtyIds(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).getMobileTerminalLeafPtyIds(...args)
  }

  clearRuntimeSessionOwnershipForMobileTerminalLeaf(...args: any[]): any {
    return (
      this.deps.snapshotValueComparison() as any
    ).clearRuntimeSessionOwnershipForMobileTerminalLeaf(...args)
  }

  persistedParentStillBindsMobileTerminalLeaf(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).persistedParentStillBindsMobileTerminalLeaf(
      ...args
    )
  }

  isRuntimeOwnedHeadlessMobileTab(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).isRuntimeOwnedHeadlessMobileTab(...args)
  }

  mergeMobileSessionSnapshotTabs(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).mergeMobileSessionSnapshotTabs(...args)
  }

  mergeMobileSessionTabGroups(...args: any[]): any {
    return (this.deps.snapshotValueComparison() as any).mergeMobileSessionTabGroups(...args)
  }

  mergePreservedHeadlessMobileSessionTabs(...args: any[]): any {
    return (this.deps.mobileSnapshotMerge() as any).mergePreservedHeadlessMobileSessionTabs(...args)
  }

  buildPreservedHeadlessMobileSessionSnapshot(...args: any[]): any {
    return (this.deps.mobileSnapshotMerge() as any).buildPreservedHeadlessMobileSessionSnapshot(
      ...args
    )
  }

  storedMobileSnapshotHasStalePreservedTab(...args: any[]): any {
    return (this.deps.mobileSnapshotMerge() as any).storedMobileSnapshotHasStalePreservedTab(
      ...args
    )
  }

  notifyMobileSessionTabSnapshots(...args: any[]): any {
    return (this.deps.mobileSnapshotMerge() as any).notifyMobileSessionTabSnapshots(...args)
  }

  emitMobileSessionTabsSnapshotToClient(...args: any[]): any {
    return (this.deps.mobileSnapshotMerge() as any).emitMobileSessionTabsSnapshotToClient(...args)
  }

  touchMobileSessionSnapshotsForPty(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).touchMobileSessionSnapshotsForPty(...args)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- args forwarded by ManagedWorktrees shim separately
  getMobileSessionWorktreeIdsForPty(..._args: any[]): any {
    return this.deps.managedWorktrees().getMobileSessionWorktreeIdsForPty()
  }

  touchMobileSessionTabsForWorktree(worktreeId: string, options?: { immediate?: boolean }): void {
    return this.deps.managedWorktrees().touchMobileSessionTabsForWorktree(worktreeId, options)
  }

  touchMobileSessionTabsForPane(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).touchMobileSessionTabsForPane(...args)
  }

  buildHeadlessMobileSessionTerminalTabs(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).buildHeadlessMobileSessionTerminalTabs(...args)
  }

  buildHeadlessMobileSessionBrowserTabs(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).buildHeadlessMobileSessionBrowserTabs(...args)
  }

  buildHeadlessMobileSessionTabGroups(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).buildHeadlessMobileSessionTabGroups(...args)
  }

  emitMobileSessionTabsSnapshot(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).emitMobileSessionTabsSnapshot(...args)
  }

  projectMobileSessionTabsForClient(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).projectMobileSessionTabsForClient(...args)
  }

  getHeadlessMobileSessionGroupId(...args: any[]): any {
    return (this.deps.mobileTabSnapshots() as any).getHeadlessMobileSessionGroupId(...args)
  }
}
