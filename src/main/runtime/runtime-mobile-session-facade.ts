import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type {
  RuntimeFileListResult,
  RuntimeFileOpenResult,
  RuntimeFileReadResult
} from '../../shared/runtime-file-contracts'
import type { ClientSessionTabSelectionStore } from './client-session-tab-selection'
/* eslint-disable max-lines -- Why: extracted mobile-session facade (bulk mobile cluster move); snapshot/tab publication ownership can split further if it grows */
import { repoIsRemote } from '../../shared/agent-launch-remote'

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
import {
  MOBILE_TERMINAL_CREATE_RESULT_TTL_MS,
  MOBILE_TERMINAL_READY_FALLBACK_MS,
  MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
  clampTerminalViewport,
  isClientDisconnectedError
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
import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../shared/agent-title-owner'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultVoiceSettings } from '../../shared/constants'
import { resolvePaneAgentOwner } from '../../shared/pane-agent-owner'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { navigationTargetsClients, navigationTargetsHost } from '../../shared/runtime-navigation'
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
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSpeechModelSummary,
  RuntimeSpeechSetupState,
  RuntimeSyncedTab,
  RuntimeTerminalCreate,
  RuntimeTerminalDriverState,
  RuntimeTerminalRead
} from '../../shared/runtime-types'
import type { VoiceSettings } from '../../shared/speech-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { TabActivationIntent } from '../../shared/tab-activation-intent'
import { isAutomaticTabActivation } from '../../shared/tab-activation-intent'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { indexAgentStatusRowsByPaneKey } from '../agent-hooks/agent-status-pane-index'
import type { BrowserBackend } from '../browser/browser-backend'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import { SPEECH_MODEL_CATALOG, getCatalogModel, isLocalSpeechModel } from '../speech/model-catalog'
import {
  deleteLocalSpeechModel,
  getSpeechModelDeletionErrorCode
} from '../speech/speech-model-deletion'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import type { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import {
  activateClientSessionTabSelection,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from './client-session-tab-selection'
import {
  buildHeadlessTabGroupMove,
  buildHeadlessTabGroupSplit
} from './headless-tab-group-split-layout'
import type { MobileNotificationReplayBuffer } from './mobile-notification-replay'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import { refusedMobileSessionTabClose } from './mobile-session-tab-close-outcome'
import type { MobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'
import type { MobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import { createMobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import type { RuntimeAccountCommands } from './runtime-account-commands'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { RuntimeManagedWorktrees } from './runtime-managed-worktrees'
import {
  MOBILE_AUTO_RESTORE_FIT_MAX_MS,
  MOBILE_AUTO_RESTORE_FIT_MIN_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  buildPreview,
  buildVisibleSnapshotReadFallback,
  getLatestAgentCandidateTitle,
  getLatestPtyTitle,
  notifyRuntimeListeners,
  projectVisibleTerminalLines,
  runtimeWorktreeIdsEqual,
  shouldFallbackToVisibleTerminalSnapshot,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-tail-projection'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

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
  private mobileDictation: {
    id: string
    owner: string
    clientId?: string
    connectionId?: string
    state: 'starting' | 'active' | 'closing'
    partialText: string
    finalTexts: string[]
    errors: string[]
  } | null = null
  private mobileDisplayModes = new Map<string, 'desktop'>()
  private mobileInputFloorClaims = new Map<
    string,
    {
      base: DriverState
      generation: number
      committedGeneration: number
      pending: Map<symbol, { clientId: string; generation: number }>
    }
  >()
  private readonly mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer =
    createMobileSessionTabsNotifyCoalescer((worktreeId) =>
      this.flushScheduledMobileSessionTabsChanged(worktreeId)
    )
  private mobileTerminalCreateByMutationId = new Map<
    string,
    Promise<RuntimeMobileSessionCreateTerminalResult>
  >()
  private pendingMobileSessionPtyAggregateInventoryRefresh: Promise<PtyControllerInventory | null> | null =
    null
  private pendingMobileSessionTabsChangeSequenceByWorktree = new Map<string, number>()

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

  retireResolvedNativeChatLaunchDraftFromMobileSnapshot(
    resolution: NativeChatLaunchDraftResolutionTombstone
  ): void {
    this.deps
      .clientEventPublishingCommands()
      .retireResolvedNativeChatLaunchDraftFromMobileSnapshot(resolution)
  }

  async publishRecoveredSshMobileSessionTabs(targetId: string, generation: number): Promise<void> {
    await this.deps
      .clientEventPublishingCommands()
      .publishRecoveredSshMobileSessionTabs(targetId, generation)
    // Update the mobile session tabs change sequence after recovery
    for (const worktreeId of this.deps.mobileSessionTabsByWorktree().keys()) {
      this.notifyMobileSessionTabsChangedNow(
        worktreeId,
        this.deps.nextMobileSessionTabsChangeSequence()
      )
    }
  }

  collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    return this.deps
      .managedWorktrees()
      .collectMobileVisibleGraphChangedWorktrees(previousTabs, previousLeaves)
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
    if (tab.type === 'terminal') {
      // Why: split terminal leaves share one parent tab; merge dedup must stay
      // leaf-scoped or preserved siblings collapse into a single surface.
      const keys = [tab.id, `${tab.parentTabId}::${tab.leafId}`]
      if (typeof tab.ptyId === 'string' && tab.ptyId.length > 0) {
        // Why: renderer and headless sources can derive different leafIds for the same
        // terminal; real PTYs collapse those duplicates without merging pending splits.
        keys.push(`${tab.parentTabId}::pty:${tab.ptyId}`)
      }
      return keys
    }
    if (tab.type === 'browser') {
      return [tab.id, tab.browserWorkspaceId]
    }
    return [tab.id]
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
    if (
      !this.deps.isMobileSessionSurfaceMembershipAllowed(
        worktreeId,
        args.tabId,
        args.leafId,
        pty.ptyId
      )
    ) {
      return
    }
    const existing = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const ownerAgent = pty.launchAgent ?? pty.foregroundAgent
    const title = normalizeCompatibleAgentTitleForOwner(
      args.title ?? getLatestPtyTitle(pty) ?? 'Terminal',
      ownerAgent
    )
    const existingTab = existing?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === args.tabId &&
        candidate.leafId === args.leafId
    )
    // Why: a split inserts into the parent tab's layout, which lives on the
    // sibling surface, not this new leaf's (empty) existing surface.
    const baseLayout = args.split
      ? (existing?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === args.tabId &&
            candidate.leafId === args.split!.splitFromLeafId
        )?.parentLayout ?? existingTab?.parentLayout)
      : existingTab?.parentLayout
    const parentLayout = this.deps.buildMaterializedHeadlessParentLayout(
      args.leafId,
      pty.ptyId,
      baseLayout,
      args.split
    )
    // Why: a main-side PTY rescue or split publication must not erase the
    // host's explicit tab mode before the renderer graph catches up.
    const viewMode =
      args.viewMode ??
      existingTab?.viewMode ??
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.viewMode !== undefined
      )?.viewMode
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${args.tabId}::${args.leafId}`,
      parentTabId: args.tabId,
      leafId: args.leafId,
      ptyId: pty.ptyId,
      title,
      ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
      ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
      ...(viewMode ? { viewMode } : {}),
      parentLayout,
      isActive:
        args.activate || (args.selectIfNoActiveTab !== false && existing?.activeTabId == null)
    }
    const existingTabs = (existing?.tabs ?? []).filter(
      (candidate) =>
        !(
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.leafId === args.leafId
        )
    )
    const tabs = this.mergeMobileSessionSnapshotTabs(
      existingTabs.map((candidate) => ({
        ...candidate,
        // Why: the client picks one sibling's parentLayout to render the whole
        // tab; a split must update every sibling surface to the new tree, or a
        // stale single-leaf sibling makes the client fall back to a default
        // direction ("Split Right" renders as down).
        ...(args.split && candidate.type === 'terminal' && candidate.parentTabId === args.tabId
          ? { parentLayout }
          : {}),
        isActive: tab.isActive ? false : candidate.isActive
      })),
      [tab]
    )
    const activeTab =
      (tab.isActive ? tab : tabs.find((candidate) => candidate.id === existing?.activeTabId)) ??
      tabs.find((candidate) => candidate.isActive) ??
      (args.selectIfNoActiveTab !== false ? tabs[0] : null) ??
      null
    const terminalTabs = tabs.filter(
      (candidate): candidate is RuntimeMobileSessionTerminalTab => candidate.type === 'terminal'
    )
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch:
        existing?.publicationEpoch ?? `headless:pty-backed:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: existing?.activeGroupId ?? this.getHeadlessMobileSessionGroupId(worktreeId),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: this.mergeMobileSessionTabGroups(
        worktreeId,
        existing?.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, next)
    if (args.notify !== false) {
      this.deps.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  async refreshMobileSessionPtyRecords(
    targetWorktreeId: string | null = null
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshMobileSessionPtyInventory(targetWorktreeId)
    return inventory ? new Set(inventory.livePtyIds) : null
  }

  async refreshMobileSessionPtyInventory(
    targetWorktreeId: string | null = null
  ): Promise<PtyControllerInventory | null> {
    if (targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      // Non-floating refreshes all query the aggregate controller inventory;
      // coalesce targeted and all-worktree callers so they cannot invalidate
      // one another through the shared aggregate generation fence.
      const pending = this.pendingMobileSessionPtyAggregateInventoryRefresh
      if (pending) {
        return pending
      }
      // Why: reconnect exit bursts share one authoritative daemon inventory
      // instead of multiplying a full cross-generation list RPC per stale tab.
      const refresh = this.performMobileSessionPtyRecordsRefresh(targetWorktreeId).finally(() => {
        if (this.pendingMobileSessionPtyAggregateInventoryRefresh === refresh) {
          this.pendingMobileSessionPtyAggregateInventoryRefresh = null
        }
      })
      this.pendingMobileSessionPtyAggregateInventoryRefresh = refresh
      return refresh
    }
    return await this.performMobileSessionPtyRecordsRefresh(targetWorktreeId)
  }

  async performMobileSessionPtyRecordsRefresh(
    targetWorktreeId: string | null
  ): Promise<PtyControllerInventory | null> {
    if (!this.deps.ptyController()?.listProcesses && !this.deps.ptyController()?.hasPty) {
      return null
    }
    // Why: floating PTY identity is explicit, so polling must not resolve every Git/SSH worktree.
    const isFloatingWorkspace = targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID
    const resolvedWorktrees = isFloatingWorkspace ? [] : await this.deps.listResolvedWorktrees()
    return await this.deps.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      isFloatingWorkspace ? targetWorktreeId : null
    )
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
    let callerSnapshot: RuntimeMobileSessionTabsResult | null = null
    if (navigationTargetsClients(navigation)) {
      // Why: follow is live intent; disconnected devices must not inherit stale navigation on reconnect.
      const ids = new Set(
        [...this.deps.mobileSessionTabListeners()]
          .map((subscription) => subscription.clientNavigationId)
          .filter((id): id is string => Boolean(id))
      )
      if (clientNavigationId) {
        ids.add(clientNavigationId)
      }
      for (const id of ids) {
        const projected = this.deps
          .clientSessionTabSelections()
          .activate(this.deps.withClientHostedPagesHold(snapshot, id), id, activeTabId)
        this.emitMobileSessionTabsSnapshotToClient(projected, id, true)
        if (id === clientNavigationId) {
          callerSnapshot = projected
        }
      }
    } else if (clientNavigationId) {
      // Why: follow-host still starts as caller navigation; the host is an additional target, not a replacement owner.
      callerSnapshot = this.deps
        .clientSessionTabSelections()
        .activate(
          this.deps.withClientHostedPagesHold(snapshot, clientNavigationId),
          clientNavigationId,
          activeTabId
        )
      this.emitMobileSessionTabsSnapshotToClient(callerSnapshot, clientNavigationId)
    }
    if (clientNavigationId) {
      return callerSnapshot ?? this.projectMobileSessionTabsForClient(snapshot, clientNavigationId)
    }
    if (navigation === 'caller') {
      const selection = activateClientSessionTabSelection(
        snapshot,
        deriveClientSessionTabSelection(snapshot),
        activeTabId
      )
      return projectClientSessionTabSelection(snapshot, selection).snapshot
    }
    return snapshot
  }

  shouldMaterializeHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return (
      this.deps.isHeadlessMobileSessionPublication(snapshot.publicationEpoch) ||
      this.deps.hasServeOrSshOwnedBinding(tab)
    )
  }

  shouldPersistHeadlessMobileSessionActivation(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (snapshot.publicationEpoch.includes(':headless-merge:')) {
      return false
    }
    if (this.deps.authoritativeWindowId() !== null && this.deps.graphStatus() === 'ready') {
      return false
    }
    return this.shouldMaterializeHeadlessMobileSessionTab(snapshot, tab)
  }

  activateHeadlessMobileSessionTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    activeTab: RuntimeMobileSessionTerminalTab
  ): void {
    const tabs = snapshot.tabs.map((candidate) => ({
      ...candidate,
      isActive: candidate.id === activeTab.id
    }))
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: activeTab.id,
      activeTabType: 'terminal',
      tabGroups: this.buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activeTab,
        snapshot.tabGroups
      ),
      tabs
    }
    this.deps.persistHeadlessTerminalActiveLeaf(worktreeId, activeTab)
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string
  ): Promise<MobileSessionTabCloseOutcome> {
    const snapshot = await this.listMobileSessionTabs(worktreeSelector)
    const tabExists = snapshot.tabs.some(
      (candidate) =>
        candidate.id === tabId ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
        (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
    )
    if (!tabExists) {
      throw new Error('tab_not_found')
    }
    // Why: a legacy client may already have hidden its mirror; a new snapshot
    // restores it without granting an unattributed request destructive authority.
    this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    return refusedMobileSessionTabClose('missing-intent', {
      snapshotRepublished: true
    })
  }

  republishMobileSessionTabsSnapshot(worktreeId: string): void {
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    if (snapshot) {
      this.deps.mobileSessionTabsByWorktree().set(worktreeId, {
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1
      })
    }
    this.deps.notifyMobileSessionTabsChanged(worktreeId)
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

  async listMobileSpeechModels(): Promise<RuntimeSpeechSetupState> {
    const store = this.deps.store()
    if (!store) {
      throw new Error('voice_dictation_unavailable')
    }
    const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
    const states = await getSpeechModelManager(store).getModelStates()
    const stateById = new Map(states.map((state) => [state.id, state]))
    const models: RuntimeSpeechModelSummary[] = SPEECH_MODEL_CATALOG.map((manifest) => {
      const state = stateById.get(manifest.id)
      return {
        id: manifest.id,
        label: manifest.label,
        provider: manifest.provider === 'openai' ? 'openai' : 'local',
        sizeBytes: manifest.sizeBytes ?? null,
        recommended: manifest.recommended === true,
        status: state?.status ?? 'not-downloaded',
        progress: state?.progress ?? null
      }
    })
    return {
      enabled: voice.enabled === true,
      selectedModelId: voice.sttModel ?? '',
      dictationMode: voice.dictationMode === 'hold' ? 'hold' : 'toggle',
      models
    }
  }

  async downloadMobileSpeechModel(modelId: string): Promise<{ started: true }> {
    const store = this.deps.store()
    if (!store) {
      throw new Error('voice_dictation_unavailable')
    }
    const manifest = getCatalogModel(modelId)
    if (!manifest || !isLocalSpeechModel(manifest)) {
      throw new Error('voice_model_not_downloadable')
    }
    // Why: do not await — downloads run for tens of seconds; the call returns
    // immediately and mobile polls for progress/ready.
    void getSpeechModelManager(store)
      .downloadModel(modelId)
      .catch((err) => {
        console.error('[runtime] mobile speech model download failed', { modelId, err })
      })
    return { started: true }
  }

  async deleteMobileSpeechModel(modelId: string): Promise<RuntimeSpeechSetupState> {
    const store = this.deps.store()
    if (!store?.getSettings || !store.updateSettings) {
      throw new Error('voice_dictation_unavailable')
    }
    try {
      // The runtime store is adapted to the minimal speech settings contract used by deletion.
      await deleteLocalSpeechModel({
        store: {
          getSettings: () => store.getSettings(),
          updateSettings: (updates, options) => store.updateSettings?.(updates, options)
        },
        modelManager: getSpeechModelManager(store),
        sttService: getSpeechSttService(store),
        modelId
      })
    } catch (error) {
      throw new Error(getSpeechModelDeletionErrorCode(error) ?? 'voice_model_delete_failed')
    }
    return this.listMobileSpeechModels()
  }

  async configureMobileDictation(params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }): Promise<RuntimeSpeechSetupState> {
    const store = this.deps.store()
    if (!store?.getSettings || !store.updateSettings) {
      throw new Error('voice_dictation_unavailable')
    }
    const current = store.getSettings().voice ?? getDefaultVoiceSettings()
    // An explicit '' clears the selected model (the OptionalString RPC schema
    // maps '' → undefined, so this only matters for direct callers); any other
    // non-empty modelId must be a known catalog entry.
    if (params.modelId !== undefined && params.modelId !== '' && !getCatalogModel(params.modelId)) {
      throw new Error('voice_model_unknown')
    }
    const nextVoice: VoiceSettings = {
      ...current,
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.modelId !== undefined ? { sttModel: params.modelId } : {}),
      ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {})
    }
    this.deps.store()!.updateSettings?.({ voice: nextVoice }, { notifyListeners: true })
    return this.listMobileSpeechModels()
  }

  async startMobileDictation(params: {
    dictationId: string
    modelId?: string
    clientId?: string
    connectionId?: string
  }): Promise<{
    dictationId: string
    modelId: string
  }> {
    const store = this.deps.store()
    if (!store) {
      throw new Error('voice_dictation_unavailable')
    }

    const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
    if (!voice.enabled) {
      throw new Error('voice_dictation_disabled')
    }

    const modelId = params.modelId || voice.sttModel
    if (!modelId) {
      throw new Error('voice_model_not_selected')
    }

    const modelState = await getSpeechModelManager(store).getModelState(modelId)
    if (modelState.status !== 'ready') {
      throw new Error(`voice_model_not_ready:${modelState.status}`)
    }

    if (!params.clientId) {
      throw new Error('dictation_requires_mobile_client')
    }

    if (this.mobileDictation) {
      throw new Error('dictation_already_active')
    }

    const owner = `mobile:${params.dictationId}`
    this.mobileDictation = {
      id: params.dictationId,
      owner,
      clientId: params.clientId,
      connectionId: params.connectionId,
      state: 'starting',
      partialText: '',
      finalTexts: [],
      errors: []
    }

    try {
      await getSpeechSttService(store).startDictation(
        modelId,
        (event) => {
          const session = this.mobileDictation
          if (!session || session.id !== params.dictationId) {
            return
          }
          if (event.type === 'partial') {
            session.partialText = event.text ?? ''
          } else if (event.type === 'final') {
            const text = event.text?.trim()
            if (text) {
              session.finalTexts.push(text)
              session.partialText = ''
            }
          } else if (event.type === 'error') {
            session.errors.push(event.error ?? 'Speech worker error')
          }
        },
        undefined,
        owner
      )
      if (this.mobileDictation?.id !== params.dictationId) {
        throw new Error('dictation_canceled')
      }
      this.mobileDictation.state = 'active'
    } catch (error) {
      if (this.mobileDictation?.id === params.dictationId) {
        this.mobileDictation = null
      }
      throw error
    }

    return { dictationId: params.dictationId, modelId }
  }

  feedMobileDictation(params: {
    dictationId: string
    audioBase64: string
    sampleRate: number
    clientId?: string
    connectionId?: string
  }): {
    dictationId: string
  } {
    const session = this.mobileDictation
    if (!session || session.id !== params.dictationId) {
      throw new Error('dictation_stream_not_started')
    }
    if (!params.clientId || session.clientId !== params.clientId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.connectionId && session.connectionId !== params.connectionId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.state !== 'active') {
      throw new Error('dictation_stream_closing')
    }
    if (session.errors.length > 0) {
      throw new Error(session.errors[0])
    }

    const pcm = Buffer.from(params.audioBase64, 'base64')
    const samples = new Float32Array(Math.floor(pcm.length / 2))
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768
    }
    getSpeechSttService(this.deps.store()!).feedAudio(samples, params.sampleRate, session.owner)
    return { dictationId: params.dictationId }
  }

  async finishMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{
    dictationId: string
    text: string
  }> {
    const session = this.mobileDictation
    if (!session || session.id !== params.dictationId) {
      throw new Error('dictation_stream_not_started')
    }
    if (!params.clientId || session.clientId !== params.clientId) {
      throw new Error('dictation_owner_mismatch')
    }
    if (session.connectionId && session.connectionId !== params.connectionId) {
      throw new Error('dictation_owner_mismatch')
    }
    session.state = 'closing'
    try {
      await getSpeechSttService(this.deps.store()!).stopDictation(session.owner)
      if (session.errors.length > 0) {
        throw new Error(session.errors[0])
      }
      const text = [...session.finalTexts, session.partialText].join(' ').trim()
      return { dictationId: params.dictationId, text }
    } finally {
      if (this.mobileDictation?.id === session.id) {
        this.mobileDictation = null
      }
    }
  }

  async cancelMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{ dictationId: string }> {
    const session = this.mobileDictation
    if (
      session?.id === params.dictationId &&
      params.clientId &&
      session.clientId === params.clientId &&
      (!session.connectionId || session.connectionId === params.connectionId)
    ) {
      session.state = 'closing'
      try {
        await getSpeechSttService(this.deps.store()!).stopDictation(session.owner)
      } finally {
        if (this.mobileDictation?.id === session.id) {
          this.mobileDictation = null
        }
      }
    }
    return { dictationId: params.dictationId }
  }

  cancelMobileDictationSession(session: NonNullable<typeof this.mobileDictation>): void {
    if (session.state === 'closing') {
      return
    }
    session.state = 'closing'
    void getSpeechSttService(this.deps.store()!)
      .stopDictation(session.owner)
      .finally(() => {
        if (this.mobileDictation?.id === session.id) {
          this.mobileDictation = null
        }
      })
  }

  cancelMobileDictationForConnection(connectionId: string): void {
    const session = this.mobileDictation
    if (!session || session.connectionId !== connectionId) {
      return
    }
    this.cancelMobileDictationSession(session)
  }

  cancelMobileDictationForClient(clientId: string): void {
    const session = this.mobileDictation
    if (!session || session.clientId !== clientId) {
      return
    }
    this.cancelMobileDictationSession(session)
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
    const inner = this.deps.mobileSubscribers().get(ptyId)
    const sub = inner?.get(clientId)
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    this.deps.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null {
    // Why: admit a client still inside its soft-leave grace (mirrors
    // mobileTookFloor) so a write landing in that window reserves the floor
    // instead of being dropped; post-grace/orphaned writers stay rejected.
    const softLeaver = this.deps.pendingSoftLeavers().get(ptyId)
    if (
      !this.deps.mobileSubscribers().get(ptyId)?.has(clientId) &&
      softLeaver?.clientId !== clientId
    ) {
      return null
    }
    const state = this.mobileInputFloorClaims.get(ptyId) ?? {
      base: this.deps.getDriver(ptyId),
      generation: 0,
      committedGeneration: 0,
      pending: new Map<symbol, { clientId: string; generation: number }>()
    }
    this.mobileInputFloorClaims.set(ptyId, state)
    const token = Symbol('mobile-input-floor')
    const generation = ++state.generation
    state.pending.set(token, { clientId, generation })
    this.deps.setDriver(ptyId, { kind: 'mobile', clientId })
    let settled = false
    return {
      commit: async () => {
        if (settled) {
          return
        }
        settled = true
        state.pending.delete(token)
        // Why: a newer accepted write owns the floor; an older claim that was
        // delayed before commit must not replace its rollback baseline or driver.
        if (generation < state.committedGeneration) {
          if (state.pending.size === 0 && this.mobileInputFloorClaims.get(ptyId) === state) {
            this.mobileInputFloorClaims.delete(ptyId)
          }
          return
        }
        const previousFloor = state.base
        // Why: a successful write becomes the rollback baseline for any
        // overlapping reservations that have not reached the PTY yet.
        state.committedGeneration = generation
        state.base = { kind: 'mobile', clientId }
        await this.mobileTookFloor(
          ptyId,
          clientId,
          previousFloor,
          () =>
            this.mobileInputFloorClaims.get(ptyId) === state &&
            state.committedGeneration === generation
        )
        if (state.pending.size === 0 && this.mobileInputFloorClaims.get(ptyId) === state) {
          this.mobileInputFloorClaims.delete(ptyId)
        }
      },
      rollback: () => {
        if (settled) {
          return
        }
        settled = true
        state.pending.delete(token)
        if (this.mobileInputFloorClaims.get(ptyId) !== state) {
          return
        }
        const current = this.deps.getDriver(ptyId)
        if (current.kind === 'mobile' && current.clientId === clientId) {
          const pendingClientId = Array.from(state.pending.values()).at(-1)?.clientId
          this.deps.setDriver(
            ptyId,
            pendingClientId ? { kind: 'mobile', clientId: pendingClientId } : state.base
          )
        }
        if (state.pending.size === 0) {
          this.mobileInputFloorClaims.delete(ptyId)
        }
      }
    }
  }

  async mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const inner = this.deps.mobileSubscribers().get(ptyId)
    const sub = inner?.get(clientId)
    const softLeaver = this.deps.pendingSoftLeavers().get(ptyId)
    // Why: native chat pauses terminal output, so its later sends have no
    // subscriber lifecycle that could release a newly-created desktop lock.
    if (!sub && softLeaver?.clientId !== clientId) {
      return
    }
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    const prev = previousFloor ?? this.deps.getDriver(ptyId)
    const currentMode = this.mobileDisplayModes.get(ptyId)
    // Why: a deliberate mobile action implies mobile is resuming control.
    // If the display mode is currently 'desktop' (set by an earlier
    // take-back), flip it back to 'auto' (= map absence) and re-apply so
    // phone-fit takes hold again. See docs/mobile-presence-lock.md.
    if (prev.kind === 'desktop' || currentMode === 'desktop') {
      if (currentMode === 'desktop') {
        this.mobileDisplayModes.delete(ptyId)
      }
      await this.applyMobileDisplayMode(ptyId)
    }
    // Why: display changes are async; a later PTY write must keep the floor
    // when an older phone-fit operation eventually completes.
    if (!isCurrent()) {
      return
    }
    this.deps.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  async updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<{ updated: boolean; applied: boolean }> {
    const inner = this.deps.mobileSubscribers().get(ptyId)
    const sub = inner?.get(clientId)
    if (!sub) {
      return { updated: false, applied: false }
    }
    sub.viewport = viewport
    sub.lastActedAt = Date.now()

    const mode = this.getMobileDisplayMode(ptyId)
    if (mode === 'desktop') {
      // Watching at desktop dims — viewport is informational only.
      return { updated: true, applied: false }
    }
    // Why: a desktop take-back is released only by a deliberate mobile gesture
    // (mobileTookFloor / setDisplayMode / fresh subscribe). A passive viewport report
    // — iOS resume and every reconnect force one — must not re-phone-fit and re-take
    // the floor, or the take-back looks like a no-op to the desktop user.
    if (this.deps.getDriver(ptyId).kind === 'desktop') {
      return { updated: true, applied: false }
    }
    // Drive PTY dims by the most-recent-actor (just updated to this client).
    const winner = this.deps.pickMostRecentActor(inner!)
    if (!winner) {
      return { updated: false, applied: false }
    }
    const winnerSub = inner!.get(winner.clientId)
    const driveViewport = winnerSub?.viewport ?? viewport
    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
      driveViewport.cols,
      driveViewport.rows
    )

    sub.wasResizedToPhone = true
    // The driver is already mobile{this client} when we got here; refresh
    // to update lastActedAt-based ordering on later actor selection.
    this.deps.setDriver(ptyId, { kind: 'mobile', clientId })

    const needsFreshSubscribeGuard = !this.deps.layouts().has(ptyId)
    if (needsFreshSubscribeGuard) {
      this.deps.freshSubscribeGuard().add(ptyId)
    }
    let result: ApplyLayoutResult
    try {
      result = await this.deps.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: winner.clientId
      })
    } finally {
      if (needsFreshSubscribeGuard) {
        this.deps.freshSubscribeGuard().delete(ptyId)
      }
    }
    return { updated: true, applied: result.ok }
  }

  getMobileAutoRestoreFitMs(): number | null {
    return this.deps.getAutoRestoreFitMs()
  }

  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    if (!this.deps.store()?.updateSettings) {
      return this.deps.getAutoRestoreFitMs()
    }
    let normalized: number | null
    if (ms == null) {
      normalized = null
    } else if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      normalized = null
    } else {
      normalized = Math.min(
        Math.max(ms, MOBILE_AUTO_RESTORE_FIT_MIN_MS),
        MOBILE_AUTO_RESTORE_FIT_MAX_MS
      )
    }
    this.deps
      .store()!
      .updateSettings?.({ mobileAutoRestoreFitMs: normalized }, { notifyListeners: true })
    if (normalized == null) {
      this.deps.cancelAllPendingFitRestoreTimers()
    }
    return normalized
  }

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    if (mode === 'auto') {
      this.mobileDisplayModes.delete(ptyId)
    } else {
      this.mobileDisplayModes.set(ptyId, mode)
    }
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop' {
    return this.mobileDisplayModes.get(ptyId) ?? 'auto'
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    const inner = this.deps.mobileSubscribers().get(ptyId)
    return inner !== undefined && inner.size > 0
  }

  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void {
    const inner = this.deps.mobileSubscribers().get(ptyId)
    const record = inner?.get(clientId)
    if (!record) {
      return
    }
    record.viewport = viewport
  }

  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    try {
      return await this.handleMobileSubscribeInternal(ptyId, clientId, viewport)
    } finally {
      // Every subscribe path mutates mobileSubscribers — resync the daemon
      // background mark once, whatever branch returned.
      this.deps.notifyRemoteTerminalViewPresenceChanged(ptyId)
    }
  }

  async handleMobileSubscribeInternal(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    const mode = this.getMobileDisplayMode(ptyId)

    // Cancel pending restore timer for this ptyId — any new subscriber
    // supersedes any old client's pending restore.
    const pendingRestore = this.deps.pendingRestoreTimers().get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.deps.pendingRestoreTimers().delete(ptyId)
    }

    // Resubscribe-grace honor: same client returning within soft-leave
    // window restores prior record (preserving baseline so we don't capture
    // phone-fitted dims as the new baseline).
    const softLeaver = this.deps.pendingSoftLeavers().get(ptyId)
    if (softLeaver && softLeaver.clientId === clientId) {
      clearTimeout(softLeaver.timer)
      this.deps.pendingSoftLeavers().delete(ptyId)
      let inner = this.deps.mobileSubscribers().get(ptyId)
      if (!inner) {
        inner = new Map()
        this.deps.mobileSubscribers().set(ptyId, inner)
      }
      inner.set(clientId, {
        ...softLeaver.record,
        viewport: viewport ?? null,
        lastActedAt: Date.now()
      })
      if (!viewport) {
        return false
      }
      this.deps.setDriver(ptyId, { kind: 'mobile', clientId })
      if (mode !== 'desktop') {
        const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
          viewport.cols,
          viewport.rows
        )
        this.deps.freshSubscribeGuard().add(ptyId)
        try {
          await this.deps.enqueueLayout(ptyId, {
            kind: 'phone',
            cols: clampedCols,
            rows: clampedRows,
            ownerClientId: clientId
          })
        } finally {
          this.deps.freshSubscribeGuard().delete(ptyId)
        }
      }
      return true
    }

    let inner = this.deps.mobileSubscribers().get(ptyId)
    if (!inner) {
      inner = new Map()
      this.deps.mobileSubscribers().set(ptyId, inner)
    }

    // Capture restore baseline BEFORE applyLayout writes the override.
    // Multi-mobile: peer joiner against an already-fitted PTY captures null
    // — the existing baseline-holder's snapshot remains canonical. See
    // docs/mobile-presence-lock.md.
    //
    // Resubscribe-after-indefinite-hold: the held override carries the only
    // authoritative pre-fit dims across the no-subscriber gap. Inherit it
    // first; otherwise rendererSize/currentSize would be the held phone dims
    // and applyLayout would clobber the override's previousCols with phone
    // dims, making any subsequent Restore a no-op.
    const heldOverride = this.deps.terminalFitOverrides().get(ptyId)
    const existing = inner.get(clientId)
    const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
    const currentSize = this.deps.getTerminalSize(ptyId)
    const rendererSize = this.deps.lastRendererSizes().get(ptyId)
    const previousCols =
      existing?.previousCols ??
      heldOverride?.previousCols ??
      (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
    const previousRows =
      existing?.previousRows ??
      heldOverride?.previousRows ??
      (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
    const now = Date.now()
    const subscribedAt = existing?.subscribedAt ?? now

    if (!viewport) {
      // Why: mobile can subscribe before its WebView has measured. Keep the
      // subscriber + desktop baseline so updateViewport/setDisplayMode can
      // late-bind the viewport without recapturing phone dims.
      inner.set(clientId, {
        clientId,
        viewport: null,
        wasResizedToPhone: false,
        previousCols,
        previousRows,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
      viewport.cols,
      viewport.rows
    )

    if (mode === 'desktop') {
      // Passive watch — null baseline (we'll capture later if user toggles
      // to auto/phone, since safeFit will have converged by then). Do not
      // flip driver.
      inner.set(clientId, {
        clientId,
        viewport,
        wasResizedToPhone: false,
        previousCols: null,
        previousRows: null,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    inner.set(clientId, {
      clientId,
      viewport,
      wasResizedToPhone: true,
      previousCols,
      previousRows,
      subscribedAt,
      lastActedAt: now
    })

    // Subscribe-fresh with auto/phone counts as "take the floor".
    this.deps.setDriver(ptyId, { kind: 'mobile', clientId })

    // Route the actual resize through the state machine. The fresh-subscribe
    // gate lets enqueueLayout's "no layouts entry" short-circuit pass on
    // the very first transition for this PTY.
    this.deps.freshSubscribeGuard().add(ptyId)
    try {
      await this.deps.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: clientId
      })
    } finally {
      this.deps.freshSubscribeGuard().delete(ptyId)
    }

    return true
  }

  handleMobileUnsubscribe(ptyId: string, clientId: string): void {
    const inner = this.deps.mobileSubscribers().get(ptyId)
    if (!inner) {
      return
    }
    const subscriber = inner.get(clientId)
    if (!subscriber) {
      return
    }
    const wasResizedToPhone = subscriber.wasResizedToPhone

    inner.delete(clientId)
    this.deps.notifyRemoteTerminalViewPresenceChanged(ptyId)

    if (inner.size > 0) {
      // Why: if the leaving client was the only one with a non-null restore
      // baseline (typical when peer joiners subscribed against an
      // already-phone-fitted PTY and got null prevCols), donate the baseline
      // to the earliest surviving subscriber so a future last-leaver can
      // still restore correctly. See docs/mobile-presence-lock.md.
      if (
        subscriber.previousCols != null &&
        subscriber.previousRows != null &&
        !this.deps.pickEarliestRestoreTarget(inner)
      ) {
        let earliestSurvivor: { clientId: string; subscribedAt: number } | null = null
        for (const sub of inner.values()) {
          if (earliestSurvivor === null || sub.subscribedAt < earliestSurvivor.subscribedAt) {
            earliestSurvivor = { clientId: sub.clientId, subscribedAt: sub.subscribedAt }
          }
        }
        if (earliestSurvivor) {
          const heir = inner.get(earliestSurvivor.clientId)
          if (heir) {
            heir.previousCols = subscriber.previousCols
            heir.previousRows = subscriber.previousRows
          }
        }
      }
      // Peers still on the line. If the disconnecting client was the active
      // mobile driver, re-elect the most-recent surviving subscriber so the
      // banner remains correct and active phone-fit dims follow them.
      const driver = this.deps.getDriver(ptyId)
      if (driver.kind === 'mobile' && driver.clientId === clientId) {
        const next = this.deps.pickMostRecentActor(inner)
        if (next) {
          this.deps.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
          // Fire-and-forget — handleMobileUnsubscribe stays sync; applyLayout
          // failures self-recover on the next gesture.
          void this.applyMobileDisplayMode(ptyId)
        }
      }
      return
    }

    // Last subscriber leaving — clean up.
    this.deps.mobileSubscribers().delete(ptyId)
    const mode = this.getMobileDisplayMode(ptyId)

    // Resubscribe-grace: hold driver=mobile{clientId} for ~250ms so a quick
    // re-subscribe (older clients without updateViewport) doesn't flash the
    // desktop banner. See docs/mobile-presence-lock.md.
    const SOFT_LEAVE_GRACE_MS = 250
    const existingSoft = this.deps.pendingSoftLeavers().get(ptyId)
    if (existingSoft) {
      clearTimeout(existingSoft.timer)
      this.deps.pendingSoftLeavers().delete(ptyId)
    }
    const softTimer = setTimeout(() => {
      this.deps.pendingSoftLeavers().delete(ptyId)
      if (!this.deps.mobileSubscribers().has(ptyId)) {
        this.deps.setDriver(ptyId, { kind: 'idle' })
        if (this.deps.hasRemoteDesktopViewers(ptyId)) {
          void this.deps.applyRemoteDesktopLayout(ptyId)
        }
      }
    }, SOFT_LEAVE_GRACE_MS)
    if (typeof softTimer.unref === 'function') {
      softTimer.unref()
    }
    this.deps.pendingSoftLeavers().set(ptyId, {
      clientId,
      timer: softTimer,
      record: {
        clientId: subscriber.clientId,
        viewport: subscriber.viewport,
        wasResizedToPhone: subscriber.wasResizedToPhone,
        previousCols: subscriber.previousCols,
        previousRows: subscriber.previousRows,
        subscribedAt: subscriber.subscribedAt,
        lastActedAt: subscriber.lastActedAt
      }
    })

    if (mode === 'auto' && wasResizedToPhone) {
      const existingTimer = this.deps.pendingRestoreTimers().get(ptyId)
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
        this.deps.pendingRestoreTimers().delete(ptyId)
      }
      // Why: scheduling is conditional on the user's mobileAutoRestoreFitMs
      // preference. `null` (default, "Indefinite") leaves the PTY at phone
      // dims until the user clicks Restore on the desktop banner — the
      // central UX promise of docs/mobile-fit-hold.md. A finite value runs
      // the restore that long after the last unsubscribe.
      const autoRestoreMs = this.deps.getAutoRestoreFitMs()
      if (autoRestoreMs == null) {
        // Indefinite hold: the fit override persists, the SOFT_LEAVE_GRACE
        // driver-state grace above still releases the input lock, and the
        // banner's Restore button is the explicit return path.
      } else {
        // Snapshot the disconnecting subscriber's baseline NOW, before the
        // timer fires. By the time the timer runs, the subscriber map has
        // been deleted; resolveDesktopRestoreTarget would fall through to
        // lastRendererSizes → current PTY size (which is at phone dims,
        // wrong). The disconnecting subscriber's baseline is the correct
        // restore target.
        const fallback = this.deps.lastRendererSizes().get(ptyId)
        const restoreCols =
          subscriber.previousCols ?? fallback?.cols ?? this.deps.getTerminalSize(ptyId)?.cols ?? 80
        const restoreRows =
          subscriber.previousRows ?? fallback?.rows ?? this.deps.getTerminalSize(ptyId)?.rows ?? 24
        const timer = setTimeout(() => {
          this.deps.pendingRestoreTimers().delete(ptyId)
          if (this.isMobileSubscriberActive(ptyId)) {
            return
          }
          if (this.deps.hasRemoteDesktopLayoutState(ptyId)) {
            void this.deps.applyRemoteDesktopLayout(ptyId)
            return
          }
          void this.deps.enqueueLayout(ptyId, {
            kind: 'desktop',
            cols: restoreCols,
            rows: restoreRows
          })
        }, autoRestoreMs)
        // Why: a delayed mobile restore should not keep Electron main alive
        // after the last window/runtime transport has otherwise shut down.
        if (typeof timer.unref === 'function') {
          timer.unref()
        }

        this.deps.pendingRestoreTimers().set(ptyId, { timer, clientId })
      }
    }
    // 'desktop' mode: was never resized, nothing to restore.
  }

  async applyMobileDisplayMode(ptyId: string): Promise<boolean> {
    const mode = this.getMobileDisplayMode(ptyId)
    const inner = this.deps.mobileSubscribers().get(ptyId)
    const subscriber = inner ? this.deps.pickMostRecentActor(inner) : null
    const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

    if (mode === 'desktop') {
      // Reset wasResizedToPhone on every fitted subscriber so a future
      // toggle back to auto re-issues the resize. applyLayout owns the
      // actual PTY resize + override delete + renderer notify. Track which
      // subscribers we cleared so a failed resize can re-arm them.
      const clearedFitSubscribers = inner
        ? [...inner.values()].filter((sub) => sub.wasResizedToPhone)
        : []
      for (const sub of clearedFitSubscribers) {
        sub.wasResizedToPhone = false
      }
      const anyWasResized = clearedFitSubscribers.length > 0
      // Why (#7588): also restore when a fit-override is still held but no
      // subscriber carries wasResizedToPhone — e.g. a null-viewport resubscribe
      // after an indefinite hold resets the flag yet leaves the override,
      // stranding the desktop "phone size" modal. Reuse resolveDesktopRestoreTarget
      // (the same resolver the anyWasResized branch uses) so the two adjacent
      // restore paths can never resolve to different dims for the same state.
      if (anyWasResized || this.deps.terminalFitOverrides().has(ptyId)) {
        const restore = this.deps.resolveDesktopRestoreTarget(ptyId)
        const result = await this.deps.enqueueLayout(ptyId, {
          kind: 'desktop',
          cols: restore.cols,
          rows: restore.rows
        })
        // Why (#7588): a failed resize rolls the override back (still held), so
        // re-arm the flags we cleared. Otherwise a later unsubscribe under a
        // finite mobileAutoRestoreFitMs would see wasResizedToPhone=false, skip
        // scheduling its auto-restore timer, and strand the held phone-fit.
        if (!result.ok) {
          for (const sub of clearedFitSubscribers) {
            sub.wasResizedToPhone = true
          }
        }
      } else {
        // Nothing was fitted or held — emit a mode-change resize event so
        // the mobile client still learns the toggle landed.
        const size = this.deps.getTerminalSize(ptyId)
        this.deps.notifyTerminalResize(ptyId, {
          cols: size?.cols ?? 0,
          rows: size?.rows ?? 0,
          displayMode: 'desktop',
          reason: 'mode-change',
          seq: this.deps.layouts().get(ptyId)?.seq
        })
      }
    } else {
      // mode === 'auto' — the only non-desktop mode after the 'phone'
      // (sticky-fit) collapse. Phone-fit if the active subscriber has a
      // viewport and we haven't already applied it.
      if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
        const viewport = subscriberRecord.viewport
        if (viewport) {
          await this.handleMobileSubscribe(ptyId, subscriberRecord.clientId, viewport)
          // After a phone-fit an override IS held, so this reports false. The
          // auto branch is never reached from reclaim (it sets 'desktop'
          // first); computed here only to keep the post-condition uniform.
          return !this.deps.terminalFitOverrides().has(ptyId)
        }
      }
      // Why: always emit the mode change even when no resize occurred — the
      // mobile client needs to learn the toggle landed even if dims didn't
      // actually change. Carry the current seq (or undefined if no layout
      // entry yet) so the mobile-side stale-event filter behaves correctly.
      const size = this.deps.getTerminalSize(ptyId)
      this.deps.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'auto',
        reason: 'mode-change',
        seq: this.deps.layouts().get(ptyId)?.seq
      })
    }
    return !this.deps.terminalFitOverrides().has(ptyId)
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
    const navigation = opts.navigation ?? 'all'
    const select = opts.select ?? opts.activate !== false
    const runOpts = {
      ...opts,
      activate: select && navigationTargetsHost(navigation)
    }
    const mutationId = opts.clientMutationId
    let result: RuntimeMobileSessionCreateTerminalResult
    if (!mutationId) {
      result = await this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
    } else {
      // Why: idempotency is caller-owned; two paired devices may reuse the same mutation id without sharing a result.
      const mutationKey = `${opts.clientNavigationId ?? 'local'}\0${worktreeSelector}\0${mutationId}`
      // Why: a retried create (double-tap, reconnect replay) with the same
      // idempotency key must return the in-flight operation instead of spawning a
      // duplicate terminal. Successes are kept briefly so a retry whose response
      // was lost in transit reuses the created terminal; failures are dropped
      // immediately so a retry can start a fresh create.
      const inflight = this.mobileTerminalCreateByMutationId.get(mutationKey)
      const run = inflight ?? this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
      if (!inflight) {
        this.mobileTerminalCreateByMutationId.set(mutationKey, run)
        const drop = (): void => {
          if (this.mobileTerminalCreateByMutationId.get(mutationKey) === run) {
            this.mobileTerminalCreateByMutationId.delete(mutationKey)
          }
        }
        void run.then(() => {
          setTimeout(drop, MOBILE_TERMINAL_CREATE_RESULT_TTL_MS).unref?.()
        }, drop)
      }
      result = await run
    }
    if (select) {
      const worktreeId =
        this.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
        (await this.deps.resolveWorktreeSelector(worktreeSelector)).id
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        result.tab.id,
        navigation,
        opts.clientNavigationId
      )
    }
    return result
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
    const pairedCreate = Boolean(opts.clientNavigationId)
    const graphEpoch = this.deps.captureReadyGraphEpoch()
    const workspace = await this.deps.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const worktreeId = workspace.id
    const cwd = this.deps.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    let afterDesktopTabId: string | undefined
    if (opts.afterTabId) {
      const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
      const anchor = snapshot?.tabs.find((tab) => tab.id === opts.afterTabId)
      if (!anchor) {
        throw new Error('after_tab_not_found')
      }
      afterDesktopTabId = anchor.type === 'terminal' ? anchor.parentTabId : anchor.id
    }
    const startupCommand = await this.resolveMobileSessionTerminalCommand(workspace, opts)
    this.deps.assertStableReadyGraph(graphEpoch)
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const win = this.deps.getAvailableAuthoritativeWindow()
    if (!win) {
      return await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        opts.afterTabId,
        {
          command: startupCommand.command,
          cwd,
          env: startupCommand.env,
          envToDelete: startupCommand.envToDelete,
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          launchAgent: startupCommand.launchAgent,
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          launchConfig: startupCommand.launchConfig,
          signal: opts.signal
        }
      )
    }
    if (win.webContents.isDestroyed?.()) {
      throw new Error('runtime_unavailable')
    }
    const releasePublicationThrottle = pairedCreate
      ? this.deps.rendererPublicationThrottle().acquire(win.webContents)
      : () => {}
    try {
      const requestId = randomUUID()
      const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          reject(new Error('Terminal creation timed out'))
        }, 10_000)
        // Why: a dead client connection cancels the wait; the renderer tab (and
        // its shell) stays alive for the host and mirrors on reconnect (#7718).
        const onAbort = (): void => {
          clearTimeout(timer)
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          reject(new Error('client_disconnected'))
        }

        const handler = (
          event: Electron.IpcMainEvent,
          r: { requestId: string; tabId?: string; title?: string; error?: string }
        ): void => {
          if (event.sender !== win.webContents || r.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          if (r.error) {
            reject(new Error(r.error))
          } else {
            resolve({ tabId: r.tabId!, title: r.title ?? '' })
          }
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
        win.webContents.send('terminal:requestTabCreate', {
          requestId,
          worktreeId,
          afterTabId: afterDesktopTabId,
          targetGroupId: opts.targetGroupId,
          command: startupCommand.command,
          cwd,
          ...(startupCommand.env ? { env: startupCommand.env } : {}),
          ...(startupCommand.envToDelete ? { envToDelete: startupCommand.envToDelete } : {}),
          ...(startupCommand.launchConfig ? { launchConfig: startupCommand.launchConfig } : {}),
          ...(startupCommand.launchAgent ? { launchAgent: startupCommand.launchAgent } : {}),
          ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          source: 'runtime-session',
          activate: opts.activate
        })
      })

      if (opts.activate !== false) {
        this.deps.notifier()?.focusTerminal(reply.tabId, worktreeId, null)
      }
      // Why: register the wait before the renderer's PTY spawn arrives so that
      // spawn (registerPty) can publish the pty-backed surface main-side even if
      // graph-sync is stalled (#7587). Removed in the finally below.
      const pendingCreateKey = `${worktreeId}::${reply.tabId}`
      // Why: a rescue publishes into the active group (opts.targetGroupId is not
      // threaded); the renderer's reconciling publication then moves the tab to the
      // requested group, so any wrong-group placement is cosmetic and stall-window-only.
      this.deps.pendingMobileTerminalCreatesByKey().set(pendingCreateKey, {
        activate: opts.activate !== false,
        paired: pairedCreate,
        selectIfNoActiveTab: true,
        ...(startupCommand.command ? { startupCommand: startupCommand.command } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {})
      })
      try {
        // Why: the PTY spawn and the tabCreate reply race on independent IPC
        // channels; if the spawn already registered, publish immediately so the
        // wait resolves without depending on a graph sync.
        this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
        const surface = await this.waitForMobileTerminalSurface(worktreeId, reply.tabId, {
          timeoutMs: MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
          signal: opts.signal
        })
        if (this.isReadyMobileTerminalSurface(surface)) {
          this.deps.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return surface
        }
        const readySurface = await this.waitForMobileTerminalSurface(worktreeId, reply.tabId, {
          timeoutMs: MOBILE_TERMINAL_READY_FALLBACK_MS,
          requireReady: true,
          signal: opts.signal
        }).catch(() => null)
        if (readySurface) {
          this.deps.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return readySurface
        }
        if (opts.signal?.aborted) {
          // Why: nobody awaits this create anymore; don't materialize or roll back — the renderer's own publication settles the tab.
          throw new Error('client_disconnected')
        }
        const pendingSurface = this.findMobileTerminalSurface(worktreeId, reply.tabId)
        if (!pendingSurface) {
          throw new Error('Timed out waiting for terminal surface after creation')
        }
        // Why: a hidden renderer can publish the tab shell before the PTY spawns; reuse the same identity so later focus adopts instead of creating another tab.
        return await this.createRuntimeOwnedMobileSessionTerminal(
          worktreeId,
          opts.activate !== false,
          opts.afterTabId,
          {
            command: startupCommand.command,
            cwd,
            env: startupCommand.env,
            envToDelete: startupCommand.envToDelete,
            startupCommandDelivery: startupCommand.startupCommandDelivery,
            identity: { tabId: pendingSurface.tab.parentTabId, leafId: pendingSurface.tab.leafId },
            launchAgent: startupCommand.launchAgent,
            viewMode: opts.viewMode,
            targetGroupId: opts.targetGroupId,
            launchConfig: startupCommand.launchConfig,
            signal: opts.signal
          }
        )
      } catch (error) {
        // Why: publication latency (hidden renderer) can trip the surface timeout; rescue only when a live PTY backs the tab, else a ghost tab skips rollback (#7587).
        if (this.deps.findLiveRegisteredPtyForRendererTab(worktreeId, reply.tabId)) {
          const rescued = this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
          if (rescued) {
            this.deps.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
            return rescued
          }
        }
        // Why: don't roll back on a client disconnect or a live shell already backing the tab — that would kill a visible terminal ("tab dies after ~10s", #7718).
        if (
          isClientDisconnectedError(error) ||
          this.deps.hasLiveShellForRendererTab(worktreeId, reply.tabId)
        ) {
          throw error
        }
        // Why: renderer made the tab but no live PTY backs it (real spawn/handle failure); roll it back so it can't linger as a ghost in mobile snapshots.
        this.deps.notifier()?.closeTerminal(reply.tabId)
        throw error
      } finally {
        this.deps.pendingMobileTerminalCreatesByKey().delete(pendingCreateKey)
      }
    } finally {
      releasePublicationThrottle()
    }
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
    if (opts.command || !opts.agent) {
      return {
        command: opts.command,
        env: opts.env,
        envToDelete: opts.envToDelete,
        launchConfig: opts.launchConfig,
        launchAgent: opts.launchAgent,
        startupCommandDelivery: opts.startupCommandDelivery
      }
    }
    const store = this.deps.store()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    const settings = store.getSettings()
    if (!isTuiAgentEnabled(opts.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    // Why: mobile may be iOS while the shell host is Windows/macOS/Linux or SSH Linux; quote for the host shell.
    const platform = this.deps.getAgentLaunchPlatformForWorkspace(workspace)
    // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
    const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : repoIsRemote(workspace)
    const queuedShell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const startupPlan = buildAgentStartupPlan({
      agent: opts.agent,
      prompt: opts.agentPrompt ?? '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(opts.agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(opts.agent, settings.agentDefaultEnv),
      platform,
      shell: queuedShell,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      throw new Error(`Could not build launch command for ${opts.agent}.`)
    }
    if (opts.agentPrompt && startupPlan.followupPrompt) {
      throw new Error(`Agent ${opts.agent} does not support startup prompt quick commands.`)
    }
    await this.deps.markWorkspaceTrustedForAgent(opts.agent, workspace.connectionId, workspace.path)
    return {
      command: startupPlan.launchCommand,
      env: startupPlan.env,
      // Why: a real-home Codex resume strips inherited CODEX_HOME via
      // envToDelete; dropping it here would resume against the wrong home.
      envToDelete: opts.envToDelete,
      launchConfig: startupPlan.launchConfig,
      launchAgent: opts.agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery
    }
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
    const workspace = await this.deps.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const cwd = this.deps.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: SshPtyProvider treats sessionId as a relay reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const terminal = await this.deps.createTerminal(`id:${worktreeId}`, {
      focus: false,
      command: opts.command,
      cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      startupCommandDelivery: opts.startupCommandDelivery,
      ...(opts.identity
        ? {
            tabId: opts.identity.tabId,
            leafId: opts.identity.leafId,
            ...(stableSessionId ? { sessionId: stableSessionId } : {})
          }
        : stableSessionId
          ? { sessionId: stableSessionId }
          : {}),
      ...(isNewSession ? { isNewSession: true } : {}),
      // Why: this method publishes the authoritative snapshot below; skip the intermediate publish to avoid a wrong-group flash.
      deferMobileSessionPublish: true,
      signal: opts.signal
    })
    const livePty = this.deps.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
    if (opts.viewMode) {
      // Why: the runtime-owned binding must survive a serve restart with the same initial mode, not a later client's local default.
      this.deps.persistHeadlessSessionTabProps()(worktreeId, parentTabId, {
        viewMode: opts.viewMode
      })
    }
    const existing = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    const parentLayout = this.deps.buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(cwd ? { startupCwd: cwd } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      parentLayout,
      isActive: activate
    }
    const tabs = (existing?.tabs ?? [])
      .filter((candidate) => candidate.id !== tab.id)
      .map((candidate) => ({
        ...candidate,
        ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
          ? { parentLayout }
          : {}),
        isActive: activate ? false : candidate.isActive
      }))
    const insertAfter = afterTabId ? tabs.findIndex((candidate) => candidate.id === afterTabId) : -1
    if (insertAfter >= 0) {
      tabs.splice(insertAfter + 1, 0, tab)
    } else {
      tabs.push(tab)
    }
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Why: activating the new tab also focuses its group, so a "+" targeting a specific split group makes that group active too.
      activeGroupId:
        activate && opts.targetGroupId
          ? opts.targetGroupId
          : (existing?.activeGroupId ?? this.getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups: this.buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activate ? tab : null,
        existing?.tabGroups,
        opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
      ),
      // Why: keep group split geometry on new-tab creation, else opening a terminal while split loses the arrangement.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, next)
    const result = this.toMobileSessionTabsResult(next)
    const changeSequence = this.deps.nextMobileSessionTabsChangeSequence()
    for (const subscription of this.deps.mobileSessionTabListeners()) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const timeoutMs = options.timeoutMs ?? MOBILE_TERMINAL_SURFACE_TIMEOUT_MS
    const existing = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
    if (existing) {
      return Promise.resolve(existing)
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('client_disconnected'))
    }

    return new Promise<RuntimeMobileSessionCreateTerminalResult>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const idx = this.deps.graphSyncCallbacks().indexOf(check)
        if (idx !== -1) {
          this.deps.graphSyncCallbacks().splice(idx, 1)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for terminal surface after creation'))
      }, timeoutMs)
      // Why: a dead client connection cancels the wait immediately instead of running down the timeout into rollback (#7718).
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const check = (): void => {
        const next = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
        if (!next) {
          return
        }
        cleanup()
        resolve(next)
      }
      this.deps.graphSyncCallbacks().push(check)
      check()
    })
  }

  findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tab = result.tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
    )
    if (!tab || tab.type !== 'terminal') {
      return null
    }
    const surface = {
      tab,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
    if (options.requireReady === true && !this.isReadyMobileTerminalSurface(surface)) {
      return null
    }
    return surface
  }

  findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate) =>
        candidate.type === 'terminal' &&
        (candidate.ptyId === ptyId ||
          candidate.parentLayout?.ptyIdsByLeafId?.[candidate.leafId] === ptyId)
    )
    return tab?.type === 'terminal'
      ? this.findMobileTerminalSurface(worktreeId, tab.parentTabId)
      : null
  }

  ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const pending = this.deps.pendingMobileTerminalCreatesByKey().get(`${worktreeId}::${tabId}`)
    if (!pending) {
      return null
    }
    const existing = this.findMobileTerminalSurface(worktreeId, tabId)
    const pty = this.deps.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (pty) {
      pty.runtimeSessionOwned = true
      if (pending.paired) {
        this.deps.setPairedRendererSessionOwnership(pty.ptyId, true)
      }
    }
    if (
      existing &&
      this.isReadyMobileTerminalSurface(existing) &&
      (pending.viewMode === undefined || existing.tab.viewMode === pending.viewMode)
    ) {
      // Why: the renderer's ready publication already landed with the intended mode; only a pending shell needs the main-side rescue.
      return existing
    }
    const leafId = pty ? parsePaneKey(pty.paneKey ?? '')?.leafId : undefined
    if (!pty || !leafId) {
      return existing
    }
    this.publishPtyBackedMobileSessionTerminal(worktreeId, pty, {
      tabId,
      leafId,
      title: null,
      activate: pending.activate,
      selectIfNoActiveTab: pending.selectIfNoActiveTab,
      ...(pending.viewMode ? { viewMode: pending.viewMode } : {})
    })
    // Why: check closures normally drain only inside syncWindowGraph; a main-side publish must drain them too or the pending wait misses the insertion.
    for (const cb of this.deps.graphSyncCallbacks()) {
      cb()
    }
    return this.findMobileTerminalSurface(worktreeId, tabId)
  }

  restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    for (const ptyId of this.deps.pairedRendererSessionOwnedPtyIds()) {
      const pty = this.deps.ptysById().get(ptyId)
      if (
        !pty?.connected ||
        !pty.tabId ||
        (worktreeId !== null && !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId))
      ) {
        continue
      }
      const targetWorktreeId = worktreeId ?? pty.worktreeId
      const pane = parsePaneKey(pty.paneKey ?? '')
      if (!pane || pane.tabId !== pty.tabId) {
        continue
      }
      const existing = this.deps.mobileSessionTabsByWorktree().get(targetWorktreeId)
      if (existing && options.missingSnapshotOnly) {
        continue
      }
      if (
        existing?.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            (tab.ptyId === pty.ptyId ||
              (tab.parentTabId === pty.tabId && tab.leafId === pane.leafId))
        )
      ) {
        continue
      }
      if (!existing) {
        this.deps.mobileSessionTabsByWorktree().set(targetWorktreeId, {
          worktree: targetWorktreeId,
          publicationEpoch: `renderer-rescue:${Date.now().toString(36)}`,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabGroups: [],
          tabs: []
        })
      }
      this.publishPtyBackedMobileSessionTerminal(targetWorktreeId, pty, {
        tabId: pty.tabId,
        leafId: pane.leafId,
        title: null,
        activate: false,
        selectIfNoActiveTab: false,
        notify: options.notify
      })
    }
  }

  isReadyMobileTerminalSurface(surface: RuntimeMobileSessionCreateTerminalResult | null): boolean {
    return (
      surface?.tab.status === 'ready' &&
      typeof surface.tab.terminal === 'string' &&
      surface.tab.terminal.length > 0
    )
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
    if (!snapshot.data) {
      return
    }
    // Why: a redraw byte can create a suffix-only model before the renderer settles; replace it with the exact snapshot already sent mobile.
    this.deps.providerSnapshotPreferredPtys().add(ptyId)
    this.deps.disposeHeadlessTerminal(ptyId)
    this.deps.seedHeadlessTerminal(
      ptyId,
      snapshot.data,
      { cols: snapshot.cols, rows: snapshot.rows },
      { cwd: snapshot.cwd, oscLinks: snapshot.oscLinks }
    )
    for (const chunk of trailingOutput) {
      this.deps.trackHeadlessTerminalData(ptyId, chunk.data, chunk.seq)
    }
    // The seed's write chain owns subsequent live bytes; suppress on-data hydration from replacing this known-good seed.
    this.deps.headlessHydrationState().set(ptyId, 'done')
  }

  syncMobileSessionTabs(
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds = new Set<string>()
  ): Set<string> {
    const changedWorktreeIds = new Set<string>()
    if (snapshots === undefined) {
      return changedWorktreeIds
    }
    // Why: snapshots are immutable — every writer replaces the map entry with a
    // new object, and the accept gate below drops semantically-unchanged
    // renderer resends before they replace an entry — so reference identity
    // before/after detects exactly the entries that actually changed.
    const before = new Map(this.deps.mobileSessionTabsByWorktree())
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null, {
      missingSnapshotOnly: true,
      notify: false
    })
    // Why: graph sync must scan each persisted host session once, not once per workspace.
    const worktreeSessionsToHydrate = new Map<string, WorkspaceSessionState | null>(
      this.deps.getWorkspaceSessionHydrationTargets(Boolean(this.deps.offscreenBrowserBackend()))
    )
    if (this.deps.offscreenBrowserBackend()) {
      for (const snapshot of snapshots) {
        if (!worktreeSessionsToHydrate.has(snapshot.worktree)) {
          worktreeSessionsToHydrate.set(snapshot.worktree, null)
        }
      }
    }
    // Why: an empty renderer publication after HUB restart must not hide SSH panes persisted in this HUB's host partition.
    for (const [worktreeId, workspaceSession] of worktreeSessionsToHydrate) {
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true,
        ...(workspaceSession ? { runtimeOwnedTerminalCandidateKnown: true, workspaceSession } : {})
      })
    }
    const nextWorktrees = new Set<string>()
    const incomingWorktreeIds = new Set(snapshots.map((snapshot) => snapshot.worktree))
    // Why: the renderer withholds unchanged snapshots to keep the graph payload
    // small, so these worktrees are still live and must not fall into the prune
    // below. Ask for a republish when main no longer holds that accepted renderer
    // publication or a formerly-preserved runtime tab has gone stale.
    for (const worktreeId of unchangedWorktreeIds ?? []) {
      const existing = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
      const accepted = this.deps.acceptedRendererMobileSnapshotByWorktree().get(worktreeId)
      if (existing) {
        nextWorktrees.add(worktreeId)
      }
      if (
        existing &&
        accepted &&
        (existing.publicationEpoch === accepted.publicationEpoch ||
          existing.publicationEpoch.startsWith(`${accepted.publicationEpoch}:headless-merge:`)) &&
        existing.tabs.length >= accepted.rendererTabCount &&
        (existing.tabs.length === accepted.rendererTabCount ||
          !this.storedMobileSnapshotHasStalePreservedTab(
            existing,
            accepted.rendererTabIdentityKeys
          ))
      ) {
        continue
      }
      if (!incomingWorktreeIds.has(worktreeId)) {
        resyncWorktreeIds.add(worktreeId)
      }
      // Why: the accept gate compares against the renderer's last accepted pair,
      // which outlives the dropped snapshot and would reject the republish.
      this.deps.acceptedRendererMobileSnapshotByWorktree().delete(worktreeId)
    }
    for (const snapshot of snapshots) {
      nextWorktrees.add(snapshot.worktree)
      const existing = this.deps.mobileSessionTabsByWorktree().get(snapshot.worktree)
      // Why: judge renderer publication ordering against the renderer's own
      // last-accepted (epoch, version) — the renderer reuses one pair for
      // byte-identical content, so a same-epoch version <= the accepted one is
      // a no-op resend (or a stale frame) and must be skipped. Never compare
      // against the stored snapshot's version: main-local touches bump it
      // independently and would reject genuinely newer renderer revisions.
      const accepted = this.deps.acceptedRendererMobileSnapshotByWorktree().get(snapshot.worktree)
      if (
        accepted &&
        accepted.publicationEpoch === snapshot.publicationEpoch &&
        snapshot.snapshotVersion <= accepted.rendererVersion &&
        // Why: preservation is main-only state — a serve/SSH binding (or live
        // browser page) can disappear without the renderer bumping its version,
        // so a resend of the EXACT accepted revision (content-identical to the
        // accepted publication, safe to re-merge) must still fall through to
        // the merge, which prunes stale preserved tabs. Strictly-older frames
        // stay skipped: their content is outdated, and the next accepted-pair
        // resend performs the prune.
        !(
          existing &&
          snapshot.snapshotVersion === accepted.rendererVersion &&
          this.storedMobileSnapshotHasStalePreservedTab(existing, accepted.rendererTabIdentityKeys)
        )
      ) {
        continue
      }
      this.deps.reconcileNativeChatLaunchDraftResolutionTombstones(snapshot)
      const launchDraftFencedSnapshot =
        this.deps.applyNativeChatLaunchDraftResolutionFence(snapshot)
      const fencedSnapshot = this.deps.applyMobileSessionRetirementFences(launchDraftFencedSnapshot)
      this.deps.releaseRuntimeSessionOwnershipForRendererRetiredTabs(fencedSnapshot, existing)
      const nextSnapshot = this.mergePreservedHeadlessMobileSessionTabs(fencedSnapshot, existing)
      // Why: clients drop same-epoch frames whose version isn't strictly newer,
      // and main-local touches may already have emitted a higher version than
      // the renderer's counter — keep the stored version strictly monotonic so
      // the accepted content is never discarded as stale downstream.
      const storedVersion = existing
        ? Math.max(nextSnapshot.snapshotVersion, existing.snapshotVersion + 1)
        : nextSnapshot.snapshotVersion
      this.deps
        .mobileSessionTabsByWorktree()
        .set(
          snapshot.worktree,
          storedVersion === nextSnapshot.snapshotVersion
            ? nextSnapshot
            : { ...nextSnapshot, snapshotVersion: storedVersion }
        )
      this.deps.acceptedRendererMobileSnapshotByWorktree().set(snapshot.worktree, {
        publicationEpoch: snapshot.publicationEpoch,
        rendererVersion: snapshot.snapshotVersion,
        rendererTabCount: fencedSnapshot.tabs.length,
        rendererTabIdentityKeys: new Set(
          fencedSnapshot.tabs.flatMap((tab) => this.getMobileSessionSnapshotTabIdentityKeys(tab))
        )
      })
    }
    for (const [worktreeId, existing] of this.deps.mobileSessionTabsByWorktree().entries()) {
      if (!nextWorktrees.has(worktreeId)) {
        const preserved = this.buildPreservedHeadlessMobileSessionSnapshot(existing)
        if (preserved) {
          // Why: preservation filters existing.tabs in place (same objects) and
          // the merge epoch hashes the preserved identities idempotently, so an
          // equal epoch with every tab object retained means the recomputation
          // was a no-op — keep the entry so no-op syncs don't fan out.
          const preservedIsNoOp =
            preserved.publicationEpoch === existing.publicationEpoch &&
            preserved.tabs.length === existing.tabs.length &&
            preserved.tabs.every((tab, index) => tab === existing.tabs[index])
          if (!preservedIsNoOp) {
            this.deps.mobileSessionTabsByWorktree().set(worktreeId, preserved)
          }
          // Why: the stored entry is no longer the renderer's publication, so a
          // future renderer frame must be re-merged even if it reuses the pair.
          this.deps.acceptedRendererMobileSnapshotByWorktree().delete(worktreeId)
          nextWorktrees.add(worktreeId)
        } else {
          this.deps.mobileSessionTabsByWorktree().delete(worktreeId)
          this.deps.mobileSessionTabsAgentStatusHeartbeat().removeWorktree(worktreeId)
          this.deps.acceptedRendererMobileSnapshotByWorktree().delete(worktreeId)
          // Why: drop any pending coalesced notify so a stale snapshot can't land after the removed frame.
          this.cancelScheduledMobileSessionTabsChanged(worktreeId)
          this.notifyMobileSessionTabsRemoved(worktreeId)
        }
      }
    }
    for (const [worktreeId, snapshot] of this.deps.mobileSessionTabsByWorktree()) {
      if (before.get(worktreeId) !== snapshot) {
        changedWorktreeIds.add(worktreeId)
      }
    }
    return changedWorktreeIds
  }

  notifyMobileSessionTabsRemoved(worktreeId: string): void {
    const removed: RuntimeMobileSessionTabsRemovedResult = {
      worktree: worktreeId,
      publicationEpoch: `removed:${Date.now().toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const changeSequence = this.deps.nextMobileSessionTabsChangeSequence()
    for (const subscription of this.deps.mobileSessionTabListeners()) {
      subscription.listener(
        this.deps.clientSessionTabSelections().project(removed, subscription.clientNavigationId),
        changeSequence
      )
    }
    this.deps.clientSessionTabSelections().forgetWorktree(worktreeId)
  }

  scheduleMobileSessionTabsChanged(worktreeId: string): void {
    this.pendingMobileSessionTabsChangeSequenceByWorktree.set(
      worktreeId,
      this.deps.nextMobileSessionTabsChangeSequence()
    )
    this.mobileSessionTabsNotifyCoalescer.schedule(worktreeId)
  }

  cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    this.mobileSessionTabsNotifyCoalescer.cancel(worktreeId)
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
  }

  flushScheduledMobileSessionTabsChanged(worktreeId: string): void {
    const changeSequence = this.pendingMobileSessionTabsChangeSequenceByWorktree.get(worktreeId)
    if (changeSequence === undefined) {
      return
    }
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    if (this.deps.mobileSessionTabListeners().size === 0) {
      return
    }
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    if (!snapshot) {
      return
    }
    // Why: browser bridge events are already worktree-scoped; don't fan out every workspace snapshot during navigation/tab churn.
    const result = this.toMobileSessionTabsResult(snapshot)
    for (const subscription of this.deps.mobileSessionTabListeners()) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
  }

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.deps
      .managedWorktrees()
      .getMobileSessionTabsForWorktree(worktreeId, clientNavigationId)
  }

  async resolveMobileMarkdownWorktreeId(worktreeSelector: string, tabId: string): Promise<string> {
    return this.deps.managedWorktrees().resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
  }

  sanitizeMobileSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    returnedTabs: readonly RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined {
    if (!groups || groups.length === 0) {
      return undefined
    }
    const returnedIds = this.deps.collectReturnedSessionTabIds(returnedTabs)
    const sanitized = groups
      .map((group): RuntimeMobileSessionTabGroup | null => {
        const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
        if (tabOrder.length === 0) {
          return null
        }
        const activeTabId =
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder[0] ?? null)
        const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
        return {
          id: group.id,
          activeTabId,
          tabOrder,
          ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
        }
      })
      .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
    return sanitized.length > 0 ? sanitized : undefined
  }

  pruneMobileSessionTabGroupLayout(
    layout: TabGroupLayoutNode | null | undefined,
    validGroupIds: ReadonlySet<string>
  ): TabGroupLayoutNode | null {
    if (!layout) {
      return null
    }
    if (layout.type === 'leaf') {
      return validGroupIds.has(layout.groupId) ? layout : null
    }
    const first = this.pruneMobileSessionTabGroupLayout(layout.first, validGroupIds)
    const second = this.pruneMobileSessionTabGroupLayout(layout.second, validGroupIds)
    if (first && second) {
      return { ...layout, first, second }
    }
    return first ?? second
  }

  toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    const tabs: RuntimeMobileSessionClientTab[] = []
    const liveBrowserTabsByPageId = this.deps.getLiveBrowserTabsByPageId(snapshot.worktree)
    // Production reads hook rows by pane; the snapshot fallback remains for tests
    // and embedders that have not adopted the narrow getter.
    let hookRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
    const hookRowsForPane = new Map<string, AgentStatusIpcPayload[]>()
    const getHookRowsForPane = (paneKey: string): AgentStatusIpcPayload[] => {
      const cached = hookRowsForPane.get(paneKey)
      if (cached) {
        return cached
      }
      const direct = this.deps.getAgentProviderSessionRowsForPaneFn()?.(paneKey)
      if (direct) {
        hookRowsForPane.set(paneKey, direct)
        return direct
      }
      hookRowsByPaneKey ??= indexAgentStatusRowsByPaneKey(
        this.deps.getAgentProviderSessionSnapshotFn()?.() ?? []
      )
      const rows = hookRowsByPaneKey.get(paneKey) ?? []
      hookRowsForPane.set(paneKey, rows)
      return rows
    }
    // Why: a live PTY backs one surface; claim each once so two leaves resolving to it can't emit duplicate React keys and crash the client.
    const claimedLivePtyIds = new Set<string>()
    for (const tab of snapshot.tabs) {
      if (tab.type === 'browser') {
        const liveTab = tab.browserPageId
          ? liveBrowserTabsByPageId.get(tab.browserPageId)
          : undefined
        if (!liveTab) {
          continue
        }
        // Why: renderer snapshots lag BrowserView teardown/process swaps; only surface pages the browser bridge can still route to.
        tabs.push({
          ...tab,
          title: liveTab.title || tab.title,
          url: liveTab.url || tab.url,
          // Why: bridge "active" means active BrowserView/webContents, not active Orca tab; preserve the renderer's session focus.
          isActive: tab.isActive
        })
        continue
      }
      if (tab.type === 'markdown' || tab.type === 'file' || tab.type === 'agent-session') {
        tabs.push(tab)
        continue
      }
      const syncedTab = this.deps.tabs().get(tab.parentTabId)
      const leaf = this.deps.leaves().get(this.deps.getLeafKey(tab.parentTabId, tab.leafId)) ?? null
      const liveLeaf = leaf?.ptyId && leaf.connected ? leaf : null
      const liveLeafPtyId = liveLeaf?.ptyId ?? null
      const liveLeafPty = liveLeafPtyId ? (this.deps.ptysById().get(liveLeafPtyId) ?? null) : null
      const pty = liveLeaf
        ? null
        : this.findPtyForMobileTerminalTab(snapshot.worktree, tab, {
            allowWorktreeOnlyMatch: !snapshot.publicationEpoch.startsWith('headless')
          })
      const livePty = pty?.connected ? pty : null
      // Why: enforce one-live-PTY-per-tab; drop a later tab resolving to an already-claimed PTY so no two tabs share a handle.
      const resolvedLivePtyId = liveLeafPtyId ?? livePty?.ptyId ?? null
      if (resolvedLivePtyId !== null) {
        if (claimedLivePtyIds.has(resolvedLivePtyId)) {
          continue
        }
        claimedLivePtyIds.add(resolvedLivePtyId)
      }
      const legacyPaneId = /^pane:(\d+)$/.exec(tab.leafId)?.[1] ?? null
      const paneKey = isTerminalLeafId(tab.leafId)
        ? makePaneKey(tab.parentTabId, tab.leafId)
        : `${tab.parentTabId}:${legacyPaneId ?? tab.leafId}`
      const mobileStatusPty = livePty ?? pty
      // Why: headless hooks live only in main's retained rows; reuse this lookup
      // for both title ownership and status publication so the two cannot diverge.
      const retainedAgentStatus = tab.agentStatus
        ? null
        : this.getFreshRetainedAgentStatusForMobileTab(paneKey, liveLeafPty ?? mobileStatusPty, tab)
      const hookAgentStatus = tab.agentStatus
        ? this.deps.getHookAgentRowForPane(getHookRowsForPane(paneKey))
        : null
      // Why not tab.ptyId: findPtyForMobileTerminalTab already rejected it when it returned
      // null, because persisted ids can collide with an unrelated pane after restart — reading
      // that pane's tracker would publish its title here, ahead of every other source.
      const trackerOnlyTitle = this.deps.getUnpersistedTrackedTitleForPty()(
        liveLeafPtyId ?? pty?.ptyId ?? null
      )
      const leafTitle = leaf
        ? getLatestAgentCandidateTitle(
            { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
            { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
          )
        : null
      const ptyTitle = pty
        ? getLatestAgentCandidateTitle(
            { title: pty.title, updatedAt: pty.titleUpdatedAt },
            { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
          )
        : null
      // Renderer omission is authoritative: PTY launch provenance outlives agent exit.
      const launchAgent = tab.launchAgent ?? null
      const launchOwnerAgent = launchAgent ?? liveLeafPty?.launchAgent ?? pty?.launchAgent ?? null
      // Why: a retained OMP hook stays stable while wrapper foreground reads can report Pi.
      const ownerAgent =
        resolvePaneAgentOwner({
          launchAgent: launchOwnerAgent,
          hookAgent:
            tab.agentStatus?.agentType ??
            hookAgentStatus?.agentType ??
            retainedAgentStatus?.payload.agentType ??
            null
        }) ??
        liveLeafPty?.foregroundAgent ??
        pty?.foregroundAgent ??
        null
      const title = normalizeCompatibleAgentTitleForOwner(
        trackerOnlyTitle ?? leafTitle ?? ptyTitle ?? syncedTab?.title ?? tab.title,
        ownerAgent
      )
      const liveTitleEvidence = leafTitle ?? ptyTitle
      // Why: renderer status can precede hook session identity, leaving native chat with no transcript address.
      const rendererStatusAgent =
        resolveCompatibleAgentTypeForOwner(tab.agentStatus?.agentType, ownerAgent) ??
        ownerAgent ??
        undefined
      const hookSessionAgent = resolveCompatibleAgentTypeForOwner(
        hookAgentStatus?.providerSessionAgentType,
        ownerAgent
      )
      const hookSessionMatchesRenderer =
        !rendererStatusAgent || !hookSessionAgent || rendererStatusAgent === hookSessionAgent
      const hookProviderSession =
        hookAgentStatus?.providerSession &&
        hookSessionMatchesRenderer &&
        (!tab.agentStatus?.providerSession ||
          (hookAgentStatus.providerSessionReceivedAt ?? -1) >= tab.agentStatus.updatedAt)
          ? hookAgentStatus.providerSession
          : tab.agentStatus?.providerSession
      const statusPty = liveLeafPty ?? mobileStatusPty
      const normalizedTabAgentStatus = this.renewMobileAgentStatusFromPtyTitle(
        tab.agentStatus
          ? normalizeCompatibleAgentStatusEntryForOwner(
              {
                ...tab.agentStatus,
                ...(hookProviderSession ? { providerSession: hookProviderSession } : {})
              },
              ownerAgent
            )
          : null,
        statusPty,
        { preserveQuestionUnderShellTitle: true }
      )
      // Why: keep rich status on a live prompt/tool, or interactivePrompt is lost under a non-agent title.
      const hasLiveAgentSignal =
        normalizedTabAgentStatus?.interactivePrompt != null ||
        normalizedTabAgentStatus?.toolName != null
      // Why: only shell/management evidence proves the agent released the pane
      // (same predicate as the terminal-status API). A merely neutral live title
      // — 'Terminal', an editor, a cwd — proves nothing, and treating it as
      // completion published a synthetic `done` that fought the client's own
      // live status on every republication.
      const keepFullAgentStatus =
        normalizedTabAgentStatus &&
        (!terminalTitleBlocksExplicitAgentStatus(liveTitleEvidence) || hasLiveAgentSignal)
      const agentStatus = keepFullAgentStatus
        ? { agentStatus: normalizedTabAgentStatus }
        : // Why: idle live title → drop stale "working" (no spinner) but keep agent identity so native chat can still address the transcript.
          normalizedTabAgentStatus?.agentType != null
          ? {
              agentStatus: {
                state: 'done' as const,
                prompt: '',
                updatedAt: statusPty?.lastOscTitleEpochMs ?? normalizedTabAgentStatus.updatedAt,
                stateStartedAt:
                  statusPty?.lastAgentStatusStartedAtEpochMs ??
                  normalizedTabAgentStatus.stateStartedAt,
                paneKey: normalizedTabAgentStatus.paneKey,
                stateHistory: [],
                agentType: normalizedTabAgentStatus.agentType,
                ...(normalizedTabAgentStatus.providerSession
                  ? { providerSession: normalizedTabAgentStatus.providerSession }
                  : {})
              }
            }
          : null
      // Why: web/mobile clients hold handles across renderer graph syncs; leaf handles are epoch-bound but PTY handles stay streamable.
      const terminalHandle = liveLeafPtyId
        ? this.deps.issuePtyHandle(
            this.deps.recordPtyWorktree(liveLeafPtyId, snapshot.worktree, {
              tabId: tab.parentTabId,
              paneKey,
              connected: true
            })
          )
        : livePty
          ? this.deps.issuePtyHandle(livePty)
          : null
      const projectedAgentStatus =
        agentStatus ??
        this.buildPtyMobileAgentStatus(
          mobileStatusPty,
          tab,
          terminalHandle,
          retainedAgentStatus,
          getHookRowsForPane
        )
      const projectedStatusEntry = projectedAgentStatus.agentStatus as
        | (AgentStatusEntry & { turnCompletedAt?: number })
        | undefined
      const { turnCompletedAt: projectedTurnCompletedAt, ...clientStatusFields } =
        projectedStatusEntry ?? {}
      const clientAgentStatus = projectedStatusEntry
        ? { agentStatus: clientStatusFields as AgentStatusEntry }
        : {}
      const rawTurnCompletedAt =
        hookAgentStatus?.live?.payload.turnCompletedAt ??
        this.deps.getHookAgentRowForPane(getHookRowsForPane(paneKey)).live?.payload
          .turnCompletedAt ??
        projectedTurnCompletedAt
      const turnCompletedAt =
        typeof rawTurnCompletedAt === 'number' && Number.isFinite(rawTurnCompletedAt)
          ? rawTurnCompletedAt
          : undefined
      tabs.push({
        type: 'terminal',
        id: tab.id,
        parentTabId: tab.parentTabId,
        leafId: tab.leafId,
        title,
        ...(tab.ptyId ? { ptyId: tab.ptyId } : {}),
        ...(tab.terminalTheme ? { terminalTheme: tab.terminalTheme } : {}),
        ...(launchAgent ? { launchAgent } : {}),
        ...clientAgentStatus,
        ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
        ...(tab.parentLayout ? { parentLayout: tab.parentLayout } : {}),
        ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
        ...(tab.color != null ? { color: tab.color } : {}),
        ...(tab.isPinned ? { isPinned: true } : {}),
        ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
        ...(tab.launchDraft ? { launchDraft: tab.launchDraft } : {}),
        ...(tab.launchDraftCreatedAt !== undefined
          ? { launchDraftCreatedAt: tab.launchDraftCreatedAt }
          : {}),
        isActive: tab.isActive,
        ...(terminalHandle
          ? { status: 'ready' as const, terminal: terminalHandle }
          : { status: 'pending-handle' as const, terminal: null })
      })
    }
    const active =
      tabs.find((tab) => tab.isActive && tab.id === snapshot.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      (snapshot.activeTabId ? (tabs[0] ?? null) : null)
    const normalizedTabs =
      active && !tabs.some((tab) => tab.isActive)
        ? tabs.map((tab) => (tab.id === active.id ? { ...tab, isActive: true } : tab))
        : tabs
    const tabGroups = this.sanitizeMobileSessionTabGroups(snapshot.tabGroups, normalizedTabs)
    const validGroupIds = new Set(tabGroups?.map((group) => group.id) ?? [])
    const tabGroupLayout =
      snapshot.tabGroupLayout === undefined
        ? undefined
        : this.pruneMobileSessionTabGroupLayout(snapshot.tabGroupLayout, validGroupIds)
    const activeGroupId =
      snapshot.activeGroupId && validGroupIds.has(snapshot.activeGroupId)
        ? snapshot.activeGroupId
        : (tabGroups?.find((group) =>
            active
              ? group.tabOrder.some((tabId) =>
                  this.deps.collectReturnedSessionTabIds([active]).has(tabId)
                )
              : false
          )?.id ??
          tabGroups?.[0]?.id ??
          null)
    return {
      worktree: snapshot.worktree,
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      ...(tabGroups ? { tabGroups } : {}),
      ...(snapshot.tabGroupLayout !== undefined ? { tabGroupLayout } : {}),
      tabs: normalizedTabs
    }
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
