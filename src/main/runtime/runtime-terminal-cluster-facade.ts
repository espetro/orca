/* eslint-disable max-lines -- Why: extracted terminal cluster (create/split/wait/show, headless persistence, layout/fit-restore, tail projection) */
import type { AgentStatus } from '../../shared/agent-detection'
import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle,
  isOpenCodeNativeTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  normalizeTerminalTitle
} from '../../shared/agent-detection'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import {
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { createAgentStatusOscProcessor } from '../../shared/agent-status-osc'
import type {
  AgentStatusEntry,
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-message-wait-timeout'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSessionTabCloseReason,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeTerminalAgentStatus,
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalDriverState,
  RuntimeTerminalFocus,
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalListHostScope,
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalResolvePane,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit,
  RuntimeTerminalSummary,
  RuntimeTerminalVisualGroupNode,
  RuntimeTerminalVisualLayout,
  RuntimeTerminalVisualLayoutNode,
  RuntimeTerminalVisualPaneNode,
  RuntimeTerminalVisualTab,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalWaitCondition,
  RuntimeWorktreeTerminalSleepResult
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../../shared/terminal-quick-commands'
import {
  MAX_QUICK_COMMANDS,
  applyTerminalQuickCommandMutation
} from '../../shared/terminal-quick-commands'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../shared/terminal-side-effect-facts'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { resolveLocalProjectRuntimeForWorktreeId } from '../../main/local-project-runtime-resolution'
import type { Store } from '../persistence'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  inferFolderWorkspacePathConnection
} from '../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import {
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import type { AgentSessionPtyWriteAdmittance } from './agent-session-pty-write-gate'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import { buildHeadlessTerminalSplitLayout } from './headless-terminal-split-layout'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import { resolveTerminalOrchestrationCliCommand } from './orchestration/cli-command'
import type { OrchestrationDb } from './orchestration/db'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import type { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import type {
  RemoteTerminalSourceRangeConsumerHooks,
  RemoteTerminalSourceRangeReplacementPublication,
  RemoteTerminalSourceRangeReplacementReservation,
  RemoteTerminalSourceRangeStreamIdentity
} from './remote-terminal-source-range-consumer'
import type { RuntimeManagedWorktrees } from './runtime-managed-worktrees'
import type { RuntimeMobileSessionFacade } from './runtime-mobile-session-facade'
import type { RuntimeOrchestrationCommands } from './runtime-orchestration-commands'
import type { RuntimePtyWorktrees } from './runtime-pty-worktrees'
import type { RuntimeResolvedWorktreeCache } from './runtime-resolved-worktree-cache'
import type { TerminalTailWaitState } from './runtime-tail-projection'
import {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  DEFAULT_TERMINAL_LIST_LIMIT,
  DEFAULT_TERMINAL_READ_LIMIT,
  MOBILE_AUTO_RESTORE_FIT_MAX_MS,
  MOBILE_AUTO_RESTORE_FIT_MIN_MS,
  PTY_CONTROLLER_LIST_TIMEOUT_MS,
  TUI_IDLE_DEFAULT_TIMEOUT_MS,
  agentTitleProvesAgentPresence,
  applyRestoredTerminalTailSeed,
  assertTerminalInputWithinLimitWithYield,
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildRestoredTerminalTailSeed,
  buildSendPayload,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult,
  buildTerminalWaitText,
  buildVisibleSnapshotReadFallback,
  classifyAgentTitle,
  computeTerminalTailWaitState,
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason,
  expandTerminalInteractiveWait,
  getLatestLeafTitle,
  getTerminalState,
  includeTargetResolvedWorktree,
  inferWorktreeIdFromPtyId,
  isKnownReadyPromptPreview,
  isTerminalSendSettlementAgent,
  labelTerminalReadSource,
  mapExplicitAgentStateToRuntimeTerminalStatus,
  notifyRuntimeListeners,
  projectTerminalTailLines,
  projectVisibleTerminalLines,
  ptyTitleProvesAgentPresence,
  readTerminalTail,
  resolveTerminalSessionWorktreeId,
  restoredTerminalTailSeedAllowed,
  runtimeWorktreeIdsEqual,
  terminalReadLimit,
  terminalTitleBlocksExplicitAgentStatus,
  withTimeoutResult
} from './runtime-tail-projection'
import type { TerminalFocusNavigationCoalescer } from './terminal-focus-navigation-coalescer'
import {
  appendRecentPtyPathCandidates,
  recentTerminalOutputIncludesPath,
  recentTerminalPathCandidatesIncludePath
} from './terminal-output-path-candidates'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from './orca-runtime'
import {
  applyLayout,
  applyRemoteDesktopLayout,
  enqueueLayout,
  runLayoutSlot
} from './runtime-terminal-layout-commands'
import type { RuntimeTerminalLayoutCtx } from './runtime-terminal-layout-commands'
import {
  focusTerminal,
  startTuiIdleFallbackPoll,
  resolveAgentTerminalCreateOptions,
  resolveTerminalSplitSourceAuthority,
  startPtyTuiIdleFallbackPoll
} from './runtime-terminal-focus-commands'
import {
  adoptTerminalOrphansFromInventory,
  createTerminal
} from './runtime-terminal-create-commands'
import {
  maybeHydrateHeadlessFromRenderer,
  emitTerminalAgentStatusEvents,
  readVisibleTerminalState,
  resolveActiveTerminal,
  startTuiIdleVisibleReadProbe,
  waitForSetupTerminalCompletion,
  reclaimTerminalForDesktop
} from './runtime-terminal-session-commands'
import {
  closeTerminal,
  stopExplicitlyClosedTabPtys,
  describeTerminalClose,
  getPtyIdsForExplicitTabClose
} from './runtime-terminal-close-commands'
import type { RuntimeTerminalCloseCtx } from './runtime-terminal-close-commands'
import { addListenerToMap } from './runtime-worktree-git-shared'
import {
  REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS,
  ownerSurfacing
} from './runtime-terminal-surface-shared'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise,
  yieldBetweenTerminalInputChunks
} from './agent-session-terminal-operations'
import type {
  ApplyLayoutResult,
  DriverState,
  HeadlessSeedMetadata,
  LayoutQueueEntry,
  LegacyWorkerTerminalRecoveryResolution,
  LegacyWorkerTerminalRecoveryResult,
  MessageWaitResult,
  MessageWaiter,
  ProviderBufferAcquisition,
  ProviderSnapshotReadOptions,
  PtyControllerInventory,
  PtyLayoutState,
  PtyLayoutTarget,
  ResolvedTerminalWorkspaceLaunchTarget,
  ResolvedWorktree,
  RuntimeAgentRowSnapshot,
  RuntimeHeadlessTerminal,
  RuntimeLeafRecord,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyTitleTrackerEntry,
  RuntimePtyWorktreeRecord,
  RuntimeStore,
  RuntimeTerminalAgentStatusEvent,
  RuntimeTerminalBufferSnapshot,
  RuntimeTerminalDataMeta,
  RuntimeTerminalProjection,
  RuntimeVisibleTerminalState,
  TerminalAgentStatusSnapshot,
  TerminalCreateOptions,
  TerminalHandleRecord,
  TerminalWaiter,
  TerminalWorkspaceLaunchScope,
  WorktreeStartupFollowup
} from './orca-runtime'
import type { RuntimeTerminalAgentStatusBindingCommands } from './runtime-terminal-agent-status-binding-commands'
import type { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import type { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import type { RuntimeHookAgentRowResolutionCommands } from './runtime-hook-agent-row-resolution-commands'
import type { RuntimeClientEventPublishingCommands } from './runtime-client-event-publishing-commands'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

export type RuntimeTerminalClusterDeps = {
  ptyWorktrees: () => RuntimePtyWorktrees
  // Why: the runtime may intercept launch-scope resolution (tests spy this).
  resolveTerminalWorkspaceLaunchScopeHook?: (
    selector: string
  ) => Promise<TerminalWorkspaceLaunchScope>
  recentPtyOutputById: () => Map<string, RecentPtyOutputBuffer>
  recentPtyPathCandidatesById: () => Map<string, string[]>
  leaves: () => Map<string, RuntimeLeafRecord>
  mobileSessionTabsByWorktree: () => Map<string, RuntimeMobileSessionTabsSnapshot>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
    worktreeId: string | undefined,
    options: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    }
  ) => Set<string>
  notifyMobileSessionTabsChanged: (worktreeId?: string) => void
  layouts: () => Map<string, PtyLayoutState>
  isFreshSubscribe: (ptyId: string) => boolean
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
  pickEarliestRestoreTarget: (
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ) => { previousCols: number; previousRows: number } | null
  lastRendererSizes: () => Map<string, { cols: number; rows: number }>
  suppressResizesForMs: (ms: number) => void
  mobileSessionFacade: () => RuntimeMobileSessionFacade
  activeRemoteDesktopViewport: (ptyId: string) => { cols: number; rows: number } | null
  remoteDesktopViewerRevisions: () => Map<string, number>
  remoteDesktopOwners: () => Map<string, string>
  resolveRemoteDesktopHostReclaimTarget: (ptyId: string) => { cols: number; rows: number }
  freshSubscribeGuard: () => Set<string>
  remoteDesktopHostReclaimTargets: () => Map<string, { cols: number; rows: number }>
  graphStatus: () => RuntimeGraphStatus
  rendererGraphEpoch: () => number
  mobileTabSnapshots: () => RuntimeMobileSessionTabSnapshotCommands
  resolvedWorktreeCache: () => RuntimeResolvedWorktreeCache
  listKnownExecutionHostIds: (
    additionalHostIds: Iterable<ExecutionHostId>,
    includeConfiguredHosts
  ) => Set<ExecutionHostId>
  tryGetWorkspaceSessionHostIdForWorktree: (worktreeId: string) => ExecutionHostId | null
  tabs: () => Map<string, RuntimeSyncedTab>
  terminalExecutionHostField: (
    ptyId: string | null,
    worktreeId: string
  ) => { executionHostId?: ExecutionHostId }
  resolvePaneAgentIdentityField: (
    launchAgent: TuiAgent | null | undefined,
    foregroundAgent: TuiAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ) => { agentIdentity?: TuiAgent }
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
  providerModeSnapshotScansByPtyId: () => Map<string, Set<TerminalKittyKeyboardModeTracker>>
  providerModeTrackersByPtyId: () => Map<string, TerminalKittyKeyboardModeTracker>
  providerSequenceOffsetByPtyId: () => Map<string, number>
  preferTrackedLastTitle: () => <T extends { lastTitle?: string }>(ptyId: string, snapshot: T) => T
  providerSnapshotsWithLiveModeTransition: () => WeakSet<PtyProviderBufferSnapshot>
  headlessTerminals: () => Map<string, RuntimeHeadlessTerminal>
  closeMobileSessionTab: (
    worktreeSelector: string,
    tabId: string,
    options?: {
      reason?: RuntimeSessionTabCloseReason
      expectedPublicationEpoch?: string
      expectedTerminalHandle?: string
      clientNavigationId?: string
      localPtyTeardownOwnedExternally?: boolean
    }
  ) => Promise<MobileSessionTabCloseOutcome>
  clientEventPublishingCommands: () => RuntimeClientEventPublishingCommands
  getAvailableAuthoritativeWindow: () => BrowserWindow | null
  assertPtyDidNotExitBeforeRegistration: (
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ) => void
  releaseRejectedPtyRegistrationFence: (
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ) => void
  registerPreAllocatedHandleForPty: (ptyId: string, handle: string) => void
  preparePtyExecutionContext: (
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean }
  ) => boolean
  registerPty: (
    ptyId: string,
    worktreeId: string,
    connectionId: string | null,
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: PtyIncarnationId
      agentLaunchAuthority?: { launchToken: string; launchAgent: TuiAgent }
      providerReattachLaunchIdentity?: {
        incarnationId: PtyIncarnationId
        launchAgent: TuiAgent
      }
    },
    isWsl?: boolean
  ) => void
  issuePtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  handles: () => Map<string, TerminalHandleRecord>
  terminalCreateIdempotency: () => RemoteRuntimeTerminalCreateIdempotency
  getPtyLivenessVerdict: (ptyId: string) => PtyLivenessVerdict | null
  headlessHydrationState: () => Map<string, 'pending' | 'done'>
  terminalSideEffectConsumerAvailable: () => boolean
  ptyOutputSequenceById: () => Map<string, number>
  terminalSideEffectLocalConsumerAvailable: () => boolean
  layoutQueues: () => Map<string, LayoutQueueEntry>
  coalescesWith: (prev: PtyLayoutTarget, next: PtyLayoutTarget) => boolean
  subscriberDrivenProviderAttachesByPtyId: () => Map<string, Promise<boolean>>
  isKnownUnattachedLocalDaemonPty: (ptyId: string) => boolean
  terminalFocusNavigationCoalescer: () => TerminalFocusNavigationCoalescer<RuntimeTerminalFocus>
  currentDriver: () => Map<string, RuntimeTerminalDriverState>
  latestAgentStatusByPaneKey: () => Map<string, RuntimeAgentRowSnapshot>
  orchestrationCommands: () => RuntimeOrchestrationCommands
  hookAgentRowResolutionCommands: () => RuntimeHookAgentRowResolutionCommands
  agentPromptLifecycleByPtyId: () => Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >
  ptyTitleTrackersByPtyId: () => Map<string, RuntimePtyTitleTrackerEntry>
  terminalTopologyRevisionByRepoId: () => Map<string, number>
  managedWorktrees: () => RuntimeManagedWorktrees
  rawTerminalViewSubscriberCounts: () => Map<string, number>
  remoteTerminalViewSubscriberCounts: () => Map<string, number>
  providerSnapshotPreferredPtys: () => Set<string>
  getPrimaryLeafForPty: (ptyId: string) => RuntimeLeafRecord | null
  isPtyRunningAgent: (
    pty: RuntimePtyWorktreeRecord,
    leaf: RuntimeLeafRecord | null,
    options: { retryForegroundWrappers?: boolean }
  ) => Promise<boolean>
  isRecognizedForegroundAgentProcess: (
    ptyId: string,
    foregroundProcess: string,
    options: { suppressClaude?: boolean; retryWrappers?: boolean }
  ) => Promise<boolean>
  markRemoteWorkspaceTrustedForAgent: (
    agent: TuiAgent,
    connectionId: string,
    workspacePath: string
  ) => Promise<void>
  markLocalWorkspaceTrustedForAgent: (agent: TuiAgent, workspacePath: string) => Promise<void>
  terminalSpawnCommandsByPtyId: () => Map<string, string>
  fitOverrideListeners: () => Map<
    string,
    Set<
      (event: {
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    >
  >
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
  waitBlockedCheckStateByPtyId: () => Map<
    string,
    {
      lastAt: number
      lastWaitState: TerminalTailWaitState | null
      appended: string
      keywordCarry: string
      timer: ReturnType<typeof setTimeout> | null
    }
  >
  agentStatusOscProcessorsByPtyId: () => Map<string, (data: string) => ProcessedAgentStatusChunk>
  providerVisibleStateByPtyId: () => Map<string, RuntimeVisibleTerminalState>
  providerVisibleRetryAtByPtyId: () => Map<string, number>
  reconcileLegacyWorkerTerminalsNow: (options: {
    connectionId?: string
    materializeRenderer?: boolean
  }) => Promise<LegacyWorkerTerminalRecoveryResult>
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
  recordAgentPromptPermissionObservation: (ptyId: string) => void
  terminalPaneRecoveryByIdentity: () => Map<string, Promise<RuntimeTerminalResolvePane>>
  terminalCwdByPtyId: () => Map<string, string>
  waitersByHandle: () => Map<string, Set<TerminalWaiter>>
  folderWorkspaceToResolvedWorktree: (folderWorkspace: FolderWorkspace) => ResolvedWorktree
  agentPromptSubmissionTailByPtyId: () => Map<string, Promise<void>>
  providerBufferAcquisitionsByPtyId: () => Map<string, ProviderBufferAcquisition>
  driverListeners: () => Map<string, Set<(driver: DriverState) => void>>
  setPairedRendererSessionOwnership: (ptyId: string, owned: boolean) => void
  pairedRendererSessionOwnedPtyIds: () => Set<string>
  dataListeners: () => Map<string, Set<(data: string, meta?: RuntimeTerminalDataMeta) => void>>
  messageWaitersByHandle: () => Map<string, Set<MessageWaiter>>
  graphSyncCallbacks: () => (() => void)[]
  setupCompletionTokenByPtyId: () => Map<string, string>
  getPtyWriteHostPlatform: (ptyId: string) => NodeJS.Platform
  getAgentPromptActivity: (
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ) => AgentPromptActivity
  assertAgentPromptPermissionSafe: (
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ) => void
  createAgentPromptRenderGate: (
    ptyId: string,
    pasteIngestMs: number
  ) => {
    arm: () => void
    wait: () => Promise<void>
    dispose: () => void
  } | null
  getPtyAgent: (ptyId: string) => TuiAgent | null
  store: () => RuntimeStore | null
  ptyController: () => RuntimePtyController | null
  notifier: () => RuntimeNotifier | null
  ptysById: () => Map<string, RuntimePtyWorktreeRecord>
  handleByPtyId: () => Map<string, string>
  claudeAgentTeams: () => ClaudeAgentTeamsService
  terminalAgentStatusBinding: () => RuntimeTerminalAgentStatusBindingCommands
  onTerminalAgentStatus: () => ((event: RuntimeTerminalAgentStatusEvent) => void) | null
  onTerminalSideEffects: () => ((batch: TerminalSideEffectBatch) => void) | null
  getAgentStatusSnapshotFn: () => (() => AgentStatusIpcPayload[]) | null
  buildAgentHookPtyEnv: () => (() => Record<string, string>) | null
  onRemoteTerminalViewPresenceChanged: () => ((ptyId: string) => void) | null
  snapshotValueComparison: () => RuntimeMobileSnapshotValueComparisonCommands
  getAgentLaunchPlatformForRepo: (repo: Repo) => NodeJS.Platform
  getAgentLaunchPlatformForWorkspace: (scope: TerminalWorkspaceLaunchScope) => NodeJS.Platform
  getOrCreatePtyTitleTrackerEntry: (ptyId: string) => RuntimePtyTitleTrackerEntry
  getTrackedRawTitleForPty: (ptyId: string) => string | null
  recordOsc7MetadataForPty: (
    ptyId: string,
    data: string
  ) => { cwd: string | null; cwdChanged: boolean }
  cloneTerminalLayoutSnapshot: (layout: TerminalLayoutSnapshot) => TerminalLayoutSnapshot
  collectPersistedTerminalLeafIds: (layout: TerminalLayoutSnapshot | undefined) => string[]
  getTerminalAgentStatusPtyId: (handle: string) => string
  assertTerminalAgentStatusPtyBinding: (handle: string, expectedPtyId: string) => void
  getTerminalAgentStatusSnapshot: (
    handle: string,
    expectedPtyId: string,
    waitTextOverride?: string
  ) => TerminalAgentStatusSnapshot
  hasAuthoritativeTerminalWaitPermission: (
    terminal: TerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ) => boolean
}

export class RuntimeTerminalCluster {
  readonly deps: RuntimeTerminalClusterDeps
  private recentPtyPathCandidateTrackingActive = false
  private titleObservationSequence = 0
  private legacyWorkerTerminalRecoveryQueue: Promise<void> = Promise.resolve()
  private remoteTerminalSourceRangeConsumerHooks: RemoteTerminalSourceRangeConsumerHooks | null =
    null

  constructor(deps: RuntimeTerminalClusterDeps) {
    this.deps = deps
  }

  private layoutCtx(): RuntimeTerminalLayoutCtx {
    return {
      deps: this.deps,
      applyLayout,
      enqueueLayout,
      runLayoutSlot,
      getDriver: (ptyId) => this.getDriver(ptyId),
      getTerminalSize: (ptyId) => this.getTerminalSize(ptyId),
      resizeHeadlessTerminal: (ptyId, cols, rows) => this.resizeHeadlessTerminal(ptyId, cols, rows),
      notifyFitOverrideListeners: (ptyId, mode, cols, rows) =>
        this.notifyFitOverrideListeners(ptyId, mode, cols, rows),
      notifyTerminalResize: (ptyId, event) => this.notifyTerminalResize(ptyId, event)
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    return this.deps.ptyWorktrees().acquireWorktreeTerminalSpawn(worktreeId)
  }

  activateRecentPtyPathCandidateTracking(): void {
    if (this.recentPtyPathCandidateTrackingActive) {
      return
    }
    this.recentPtyPathCandidateTrackingActive = true
    // Why: synchronous backfill from the retained raw windows so a file tap
    // right after first mobile connect resolves exactly as before the gate.
    // Replay each retained chunk in its original full form: joining or
    // trimming chunks would change the candidate set (e.g. a window cut can
    // shorten an over-4KiB line under the extractor's line guard, minting
    // candidates the eager extractor rejected).
    // Accepted best-effort loss: output that scrolled past the raw window
    // before the first-ever connect no longer yields candidates.
    for (const [ptyId, buffer] of this.deps.recentPtyOutputById()) {
      let candidates = this.deps.recentPtyPathCandidatesById().get(ptyId)
      const { chunks, headChunkIsPartial } = buffer.retainedChunks()
      for (let index = 0; index < chunks.length; index += 1) {
        if (index === 0 && headChunkIsPartial) {
          // A pre-sliced over-window chunk was already extracted eagerly at
          // append time (while its original text was intact); replaying its
          // truncated remainder would mint or drop candidates spuriously.
          continue
        }
        candidates = appendRecentPtyPathCandidates(candidates, chunks[index]!)
      }
      if (candidates) {
        this.deps.recentPtyPathCandidatesById().set(ptyId, candidates)
      }
      // Chunk boundaries were owed only to this one-time backfill; return
      // the buffer to the compact read-collapsing steady state.
      buffer.compact()
    }
  }

  adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    return this.deps
      .ptyWorktrees()
      .adoptControllerTerminalHandle(ptyId, handle, incarnationId, options)
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    return this.deps.ptyWorktrees().adoptTerminalOrphans(request)
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
    return closeTerminal(this.closeCtx(), handle)
  }

  async stopExplicitlyClosedTabPtys(ptyIds: string[], addressedPtyId: string): Promise<boolean> {
    return stopExplicitlyClosedTabPtys(this.closeCtx(), ptyIds, addressedPtyId)
  }

  describeTerminalClose(
    handle: string,
    tabId: string,
    ptyId: string | null,
    ptyKilled: boolean
  ): RuntimeTerminalClose {
    return describeTerminalClose(this.closeCtx(), handle, tabId, ptyId, ptyKilled)
  }

  getPtyIdsForExplicitTabClose(worktreeId: string, tabId: string): string[] {
    return getPtyIdsForExplicitTabClose(this.closeCtx(), worktreeId, tabId)
  }

  private closeCtx(): RuntimeTerminalCloseCtx {
    return {
      deps: this.deps,
      assertGraphReady: () => this.assertGraphReady(),
      countLeavesInTab: (tabId) => this.countLeavesInTab(tabId),
      findMobileTerminalSurface: (worktreeId, tabId) =>
        this.findMobileTerminalSurface(worktreeId, tabId),
      findMobileTerminalSurfaceForPty: (worktreeId, ptyId) =>
        this.findMobileTerminalSurfaceForPty(worktreeId, ptyId),
      getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle),
      getLivePtyForHandle: (handle) => this.getLivePtyForHandle(handle),
      describeTerminalClose,
      getPtyIdsForExplicitTabClose,
      stopExplicitlyClosedTabPtys
    }
  }

  async adoptTerminalOrphansFromInventory(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    return adoptTerminalOrphansFromInventory(this, request, workspace, inventory)
  }

  async createTerminal(
    worktreeSelector?: string,
    opts: TerminalCreateOptions = {}
  ): Promise<RuntimeTerminalCreate> {
    return createTerminal(this, worktreeSelector, opts)
  }

  async focusTerminal(
    handle: string,
    options: { navigateHost?: boolean } = {}
  ): Promise<RuntimeTerminalFocus> {
    return focusTerminal(this, handle, options)
  }

  startTuiIdleFallbackPoll(
    waiter: TerminalWaiter,
    leaf: RuntimeLeafRecord,
    waiterTimeoutMs: number
  ): void {
    return startTuiIdleFallbackPoll(this, waiter, leaf, waiterTimeoutMs)
  }

  async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    return resolveAgentTerminalCreateOptions(this, workspace, opts)
  }

  startPtyTuiIdleFallbackPoll(
    waiter: TerminalWaiter,
    pty: RuntimePtyWorktreeRecord,
    waiterTimeoutMs: number
  ): void {
    return startPtyTuiIdleFallbackPoll(this, waiter, pty, waiterTimeoutMs)
  }

  maybeHydrateHeadlessFromRenderer(ptyId: string): void {
    return maybeHydrateHeadlessFromRenderer(this, ptyId)
  }

  emitTerminalAgentStatusEvents(ptyId: string, chunk: ProcessedAgentStatusChunk): boolean {
    return emitTerminalAgentStatusEvents(this, ptyId, chunk)
  }

  async readVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null> {
    return readVisibleTerminalState(this, ptyId)
  }

  async resolveActiveTerminal(worktreeSelector?: string): Promise<string> {
    return resolveActiveTerminal(this, worktreeSelector)
  }

  startTuiIdleVisibleReadProbe(waiter: TerminalWaiter, waiterTimeoutMs: number): void {
    return startTuiIdleVisibleReadProbe(this, waiter, waiterTimeoutMs)
  }

  async waitForSetupTerminalCompletion(handle: string): Promise<{ exitCode: number | null }> {
    return waitForSetupTerminalCompletion(this, handle)
  }

  async reclaimTerminalForDesktop(ptyId: string): Promise<boolean> {
    return reclaimTerminalForDesktop(this, ptyId)
  }

  async applyLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    return applyLayout(this.layoutCtx(), ptyId, target)
  }

  async applyRemoteDesktopLayout(ptyId: string): Promise<boolean> {
    return applyRemoteDesktopLayout(this.layoutCtx(), ptyId)
  }

  async applyMobileDisplayMode(ptyId: string): Promise<boolean> {
    return this.deps.mobileSessionFacade().applyMobileDisplayMode(ptyId)
  }

  applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    // Why: a relaunched main starts its per-PTY title tracker cold — without
    // this seed it misses the parked working→idle completion and never arms
    // the stale-title timer for a persisted 'working' title. Seeding no-ops
    // once a live title was observed, so live state always wins.
    this.deps.getOrCreatePtyTitleTrackerEntry(ptyId).tracker.seedInitialTitle(title)
    const status = detectAgentStatusFromTitle(title)
    // Why: live observations store normalized titles, so seeds must match —
    // otherwise the first live frame after hydration compares unequal and
    // touches session tabs once for no visible change.
    const seededTitle = normalizeTerminalTitle(title)
    const pty = this.deps.ptysById().get(ptyId)
    if (pty) {
      const observedAt = this.nextTitleObservationSequence()
      pty.lastOscTitle = seededTitle
      pty.lastOscTitleAt = observedAt
      this.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why: seed lastOscTitle even when the seeded title doesn't classify
      // as an agent state, so worktree.ps recomputes status from the live
      // title rather than treating the leaf as agentless.
      leaf.lastOscTitle = seededTitle
      leaf.lastOscTitleAt = this.nextTitleObservationSequence()
      if (status !== null) {
        leaf.lastAgentStatus = status
      }
    }
  }

  assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }

  assertGraphReady(): void {
    const status = this.deps.graphStatus()
    if (status !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    return this.deps.ptyWorktrees().assertLiveTerminalHandleTargetsPty(handle, expectedPtyId)
  }

  assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (
      this.deps.graphStatus() !== 'ready' ||
      this.deps.rendererGraphEpoch() !== expectedGraphEpoch
    ) {
      throw new Error('runtime_unavailable')
    }
  }

  attachRemoteTerminalSourceRangeConsumer(
    identity: RemoteTerminalSourceRangeStreamIdentity
  ): boolean {
    return this.remoteTerminalSourceRangeConsumerHooks?.attach(identity) ?? false
  }

  bindTerminalWaiterAbort(waiter: TerminalWaiter, signal: AbortSignal | undefined): boolean {
    return this.deps.ptyWorktrees().bindTerminalWaiterAbort(waiter, signal)
  }

  buildHeadlessMobileSessionBrowserTabs() {
    return this.deps.mobileSessionFacade().buildHeadlessMobileSessionBrowserTabs()
  }

  buildHeadlessMobileSessionTabGroups() {
    return this.deps.mobileSessionFacade().buildHeadlessMobileSessionTabGroups()
  }

  buildHeadlessMobileSessionTerminalTabs() {
    return this.deps.mobileSessionFacade().buildHeadlessMobileSessionTerminalTabs()
  }

  buildMaterializedHeadlessParentLayout(...args: unknown[]) {
    return (
      this.deps.mobileTabSnapshots() as never as {
        buildMaterializedHeadlessParentLayout: (...a: unknown[]) => unknown
      }
    ).buildMaterializedHeadlessParentLayout(...args)
  }

  buildPreservedHeadlessMobileSessionSnapshot() {
    return this.deps.mobileSessionFacade().buildPreservedHeadlessMobileSessionSnapshot()
  }

  buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    return this.deps.ptyWorktrees().buildPtyTerminalSummary(pty, worktreesById)
  }

  buildResolvedWorktreeFromId(worktreeId: string): ResolvedWorktree | null {
    return this.deps.resolvedWorktreeCache().buildResolvedWorktreeFromId(worktreeId)
  }

  buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences
  ): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
    if (!this.deps.store()) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.requireStore().getSettings()
    if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    // Why: CLI clients may target SSH runtimes from macOS/Windows, so quote for
    // the workspace shell rather than the client shell.
    const agentLaunchPlatform = this.deps.getAgentLaunchPlatformForRepo(repo)
    const isRemote = repoIsRemote(repo)
    const queuedShell = resolveLocalWindowsAgentStartupShell({
      platform: agentLaunchPlatform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const sessionOptions = this.toAgentSessionOptions(launchPreferences)
    const startupPlan = buildAgentStartupPlan({
      agent,
      prompt: prompt ?? '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
      sessionOptions,
      sessionOptionsOverrideAgentArgs: Boolean(sessionOptions),
      platform: agentLaunchPlatform,
      shell: queuedShell,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      throw new Error(`Could not build launch command for ${agent}.`)
    }
    return {
      agent,
      startup: {
        command: startupPlan.launchCommand,
        launchConfig: startupPlan.launchConfig,
        ...(startupPlan.startupCommandDelivery
          ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
          : {}),
        ...(startupPlan.env ? { env: startupPlan.env } : {})
      },
      ...(startupPlan.followupPrompt
        ? {
            followup: {
              expectedProcess: startupPlan.expectedProcess,
              prompt: startupPlan.followupPrompt
            }
          }
        : {})
    }
  }

  buildTerminalListHostScope(
    targetWorktreeId: string | null,
    terminals: readonly RuntimeTerminalSummary[],
    worktrees: Iterable<ResolvedWorktree>,
    queriedHostIds: ReadonlySet<ExecutionHostId>
  ): RuntimeTerminalListHostScope {
    const knownHostIds = this.deps.listKnownExecutionHostIds(
      queriedHostIds,
      targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID
    )
    let resolvedTargetHostId: ExecutionHostId | null = null
    for (const worktree of worktrees) {
      if (worktree.hostId) {
        knownHostIds.add(worktree.hostId)
        if (worktree.id === targetWorktreeId) {
          resolvedTargetHostId = worktree.hostId
        }
      }
    }
    for (const terminal of terminals) {
      if (terminal.executionHostId) {
        knownHostIds.add(terminal.executionHostId)
      }
    }
    const scopedHostId = targetWorktreeId
      ? (resolvedTargetHostId ??
        this.deps.tryGetWorkspaceSessionHostIdForWorktree(targetWorktreeId))
      : null
    if (scopedHostId) {
      knownHostIds.add(scopedHostId)
    }
    const candidates = targetWorktreeId ? (scopedHostId ? [scopedHostId] : []) : knownHostIds
    // Paired runtimes own a separate control plane. Mirrored rows are evidence
    // for those rows only; this runtime cannot claim their complete inventory.
    const coveredHostIds = new Set(
      [...candidates].filter(
        (hostId) => queriedHostIds.has(hostId) && parseExecutionHostId(hostId)?.kind !== 'runtime'
      )
    )
    return {
      hostIds: [...coveredHostIds].sort(),
      omittedHostIds: [...knownHostIds].filter((hostId) => !coveredHostIds.has(hostId)).sort()
    }
  }

  buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds: ReadonlySet<string> | null = null
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.deps.tabs().get(leaf.tabId) ?? null

    const pty = leaf.ptyId ? this.deps.ptysById().get(leaf.ptyId) : undefined
    const title = getLatestLeafTitle(leaf, tab?.title ?? null)
    // Why: leaf.connected mirrors the renderer graph (`ptyId !== null`), so a
    // restored surface whose PTY died with a prior run still reads connected.
    // Demote only on a controller-proven absence, and only for locally-scoped
    // ids the aggregate inventory authoritatively covers — SSH/remote scopes may
    // be legitimately missing from it, and unknown liveness never demotes.
    // The sync hasPty rescue closes the spawn/list race: a just-spawned PTY can
    // register after the inventory snapshot, and federation reads one
    // connected:false as exited.
    const provenAbsent =
      provenLivePtyIds !== null &&
      leaf.ptyId !== null &&
      !provenLivePtyIds.has(leaf.ptyId) &&
      !leaf.ptyId.startsWith('remote:') &&
      parseAppSshPtyId(leaf.ptyId) === null &&
      this.deps.ptyController()?.hasPty?.(leaf.ptyId) !== true
    return {
      handle: this.issueHandle(leaf),
      ptyId: leaf.ptyId,
      incarnationId: pty?.incarnationId ?? null,
      orphaned: false,
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title,
      connected: provenAbsent ? false : leaf.connected,
      writable: provenAbsent ? false : leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview,
      ...(leaf.lastExitCause ? { exitCause: leaf.lastExitCause } : {}),
      ...this.deps.terminalExecutionHostField(leaf.ptyId, leaf.worktreeId),
      ...this.deps.resolvePaneAgentIdentityField(
        pty?.launchAgent,
        pty?.foregroundAgent,
        title,
        // Why guarded: makePaneKey THROWS on a non-UUID leaf id, and an unguarded call here took
        // down terminal.list for every pane in the list, not just the odd one.
        isTerminalLeafId(leaf.leafId) ? makePaneKey(leaf.tabId, leaf.leafId) : null
      )
    }
  }

  buildTerminalVisualGroupLayout(
    node: TabGroupLayoutNode | null | undefined,
    groupsById: ReadonlyMap<string, RuntimeTerminalVisualGroupNode>
  ): RuntimeTerminalVisualLayoutNode | null {
    if (!node) {
      return null
    }
    if (node.type === 'leaf') {
      return groupsById.get(node.groupId) ?? null
    }
    const first = this.buildTerminalVisualGroupLayout(node.first, groupsById)
    const second = this.buildTerminalVisualGroupLayout(node.second, groupsById)
    if (first && second) {
      return { type: 'split', direction: node.direction, first, second }
    }
    return first ?? second
  }

  buildTerminalVisualGroups(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
  ): RuntimeTerminalVisualGroupNode[] {
    const terminalTabs = snapshot.tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    if (terminalTabs.length === 0) {
      return []
    }
    const tabsByParentId = new Map<string, RuntimeMobileSessionTerminalTab[]>()
    const parentOrder: string[] = []
    for (const tab of terminalTabs) {
      const existing = tabsByParentId.get(tab.parentTabId)
      if (existing) {
        existing.push(tab)
      } else {
        parentOrder.push(tab.parentTabId)
        tabsByParentId.set(tab.parentTabId, [tab])
      }
    }
    const groupSources =
      snapshot.tabGroups && snapshot.tabGroups.length > 0
        ? snapshot.tabGroups
        : [{ id: null, activeTabId: snapshot.activeTabId, tabOrder: parentOrder }]
    return groupSources
      .map((group): RuntimeTerminalVisualGroupNode | null => {
        const tabs = group.tabOrder
          .map((tabId) => {
            const surfaces =
              tabsByParentId.get(tabId) ?? terminalTabs.filter((tab) => tab.id === tabId)
            return this.buildTerminalVisualTab(tabId, surfaces, summariesByLeafKey)
          })
          .filter((tab): tab is RuntimeTerminalVisualTab => tab !== null)
        if (tabs.length === 0) {
          return null
        }
        return {
          type: 'group',
          groupId: group.id,
          activeTabId:
            group.activeTabId && tabs.some((tab) => tab.tabId === group.activeTabId)
              ? group.activeTabId
              : (tabs[0]?.tabId ?? null),
          tabs
        }
      })
      .filter((group): group is RuntimeTerminalVisualGroupNode => group !== null)
  }

  buildTerminalVisualLayouts(
    terminals: RuntimeTerminalSummary[],
    worktreesById: Map<string, ResolvedWorktree>,
    targetWorktreeId: string | null
  ): RuntimeTerminalVisualLayout[] {
    if (terminals.length === 0) {
      return []
    }
    // Why: the mobile/session snapshot supplies topology, but terminal.list
    // must print the same handles in both the flat list and visual tree.
    const summariesByLeafKey = new Map(
      terminals.map((terminal) => [this.getLeafKey(terminal.tabId, terminal.leafId), terminal])
    )
    const summariesByWorktree = new Map<string, RuntimeTerminalSummary[]>()
    for (const terminal of terminals) {
      const existing = summariesByWorktree.get(terminal.worktreeId)
      if (existing) {
        existing.push(terminal)
      } else {
        summariesByWorktree.set(terminal.worktreeId, [terminal])
      }
    }
    const snapshots = targetWorktreeId
      ? [this.deps.mobileSessionTabsByWorktree().get(targetWorktreeId)].filter(
          (snapshot): snapshot is RuntimeMobileSessionTabsSnapshot => snapshot !== undefined
        )
      : [...this.deps.mobileSessionTabsByWorktree().values()]
    const layouts: RuntimeTerminalVisualLayout[] = []
    for (const snapshot of snapshots) {
      const worktreeTerminals = summariesByWorktree.get(snapshot.worktree)
      if (!worktreeTerminals || worktreeTerminals.length === 0) {
        continue
      }
      const groups = this.buildTerminalVisualGroups(snapshot, summariesByLeafKey)
      if (groups.length === 0) {
        continue
      }
      const groupsById = new Map(
        groups
          .filter((group): group is RuntimeTerminalVisualGroupNode & { groupId: string } =>
            Boolean(group.groupId)
          )
          .map((group) => [group.groupId, group])
      )
      const root =
        this.buildTerminalVisualGroupLayout(snapshot.tabGroupLayout, groupsById) ?? groups[0]
      if (!root) {
        continue
      }
      const worktree = worktreesById.get(snapshot.worktree)
      layouts.push({
        worktreeId: snapshot.worktree,
        worktreePath: worktree?.path ?? worktreeTerminals[0]?.worktreePath ?? '',
        root
      })
    }
    return layouts
  }

  buildTerminalVisualPane(
    node: TerminalPaneLayoutNode,
    tabId: string,
    activeLeafId: string | null,
    summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
  ): RuntimeTerminalVisualPaneNode | null {
    if (node.type === 'leaf') {
      const summary = summariesByLeafKey.get(this.getLeafKey(tabId, node.leafId))
      if (!summary) {
        return null
      }
      return {
        type: 'terminal',
        handle: summary.handle,
        tabId: summary.tabId,
        leafId: summary.leafId,
        title: summary.title,
        connected: summary.connected,
        active: summary.leafId === activeLeafId
      }
    }
    const first = this.buildTerminalVisualPane(node.first, tabId, activeLeafId, summariesByLeafKey)
    const second = this.buildTerminalVisualPane(
      node.second,
      tabId,
      activeLeafId,
      summariesByLeafKey
    )
    if (first && second) {
      return { type: 'pane-split', direction: node.direction, first, second }
    }
    return first ?? second
  }

  buildTerminalVisualTab(
    tabId: string,
    surfaces: RuntimeMobileSessionTerminalTab[],
    summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
  ): RuntimeTerminalVisualTab | null {
    const firstSurface = surfaces[0]
    if (!firstSurface) {
      return null
    }
    const parentTabId = firstSurface.parentTabId
    const requestedActiveLeafId =
      firstSurface.parentLayout?.activeLeafId ??
      surfaces.find((surface) => surface.isActive)?.leafId ??
      firstSurface.leafId
    const root = firstSurface.parentLayout?.root ?? {
      type: 'leaf' as const,
      leafId: firstSurface.leafId
    }
    const visibleLeafIds = this.collectVisibleTerminalLeafIds(root, parentTabId, summariesByLeafKey)
    if (visibleLeafIds.length === 0) {
      return null
    }
    const activeLeafId =
      (requestedActiveLeafId && visibleLeafIds.includes(requestedActiveLeafId)
        ? requestedActiveLeafId
        : surfaces.find((surface) => surface.isActive && visibleLeafIds.includes(surface.leafId))
            ?.leafId) ?? visibleLeafIds[0]!
    const panes = this.buildTerminalVisualPane(root, parentTabId, activeLeafId, summariesByLeafKey)
    if (!panes) {
      return null
    }
    return {
      tabId: parentTabId || tabId,
      title: this.deps.tabs().get(parentTabId)?.title ?? firstSurface.title ?? null,
      activeLeafId,
      panes
    }
  }

  buildTerminalWorkspaceEnv(
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ): Record<string, string> {
    const cleanBaseEnv = { ...baseEnv }
    for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
      delete cleanBaseEnv[key]
    }
    const env = {
      ...cleanBaseEnv,
      ...agentTeamsEnv,
      ...this.deps.buildAgentHookPtyEnv()?.(),
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: tabId,
      ORCA_WORKTREE_ID: scope.id
    }
    if (!scope.folderWorkspace) {
      return env
    }
    return {
      ...env,
      ORCA_WORKSPACE_ID: scope.id,
      ORCA_PROJECT_GROUP_ID: scope.folderWorkspace.projectGroupId,
      ORCA_WORKSPACE_ROOT: scope.folderWorkspace.folderPath
    }
  }

  buildTuiIdleProbeResult(
    handle: string,
    blockedReason: RuntimeTerminalWaitBlockedReason | null
  ): RuntimeTerminalWait {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      return blockedReason
        ? buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty.pty, blockedReason)
        : buildPtyTerminalWaitResult(handle, 'tui-idle', pty.pty)
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    return blockedReason
      ? buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, blockedReason)
      : buildTerminalWaitResult(handle, 'tui-idle', leaf)
  }

  cancelAllPendingFitRestoreTimers(): void {
    for (const [, entry] of this.deps.pendingRestoreTimers()) {
      clearTimeout(entry.timer)
    }
    this.deps.pendingRestoreTimers().clear()
  }

  cancelLegacyWorkerTerminalRecoveryRetry(scopeKey: string): void {
    return this.deps.ptyWorktrees().cancelLegacyWorkerTerminalRecoveryRetry(scopeKey)
  }

  cancelMessageWaiters(handle: string): void {
    return this.deps.ptyWorktrees().cancelMessageWaiters(handle)
  }

  cancelPendingDriverMutations(ptyId: string): void {
    const pendingRestore = this.deps.pendingRestoreTimers().get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.deps.pendingRestoreTimers().delete(ptyId)
    }
    const pendingSoft = this.deps.pendingSoftLeavers().get(ptyId)
    if (pendingSoft) {
      clearTimeout(pendingSoft.timer)
      this.deps.pendingSoftLeavers().delete(ptyId)
    }
  }

  cancelRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[],
    reason: string
  ): void {
    this.remoteTerminalSourceRangeConsumerHooks?.cancel(identity, ranges, reason)
  }

  async captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number
  ): Promise<PtyProviderBufferSnapshot | null> {
    const liveModeTracker = new TerminalKittyKeyboardModeTracker()
    let liveModeTrackers = this.deps.providerModeSnapshotScansByPtyId().get(ptyId)
    if (!liveModeTrackers) {
      liveModeTrackers = new Set()
      this.deps.providerModeSnapshotScansByPtyId().set(ptyId, liveModeTrackers)
    }
    liveModeTrackers.add(liveModeTracker)
    try {
      // Why: daemon PTYs survive an app relaunch before any renderer mounts.
      // Mobile still needs their retained history without navigating desktop.
      const snapshot = await this.deps.ptyController()?.serializeProviderBuffer?.(ptyId, opts)
      if (!snapshot || this.getPtyLifecycleGeneration(ptyId) !== generation) {
        return null
      }
      const snapshotModeTracker = new TerminalKittyKeyboardModeTracker()
      if (typeof snapshot.alternateScreen === 'boolean') {
        snapshotModeTracker.scan(snapshot.alternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      } else {
        // Why: older providers omit mode metadata, but their ANSI snapshot
        // still carries the DECSET/DECRST needed to classify the active screen.
        snapshotModeTracker.scanReplay(snapshot.data)
      }
      const observedSnapshotMode = snapshotModeTracker.hasObservedAlternateScreenSwitch
      let effectiveAlternateScreen: boolean | undefined
      if (observedSnapshotMode || liveModeTracker.hasObservedAlternateScreenSwitch) {
        const modeTracker = new TerminalKittyKeyboardModeTracker()
        if (observedSnapshotMode) {
          modeTracker.scan(snapshotModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
        }
        // Why: stream bytes received after the request began can be newer
        // than snapshot metadata, so an observed live transition wins.
        if (liveModeTracker.hasObservedAlternateScreenSwitch) {
          modeTracker.scan(liveModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
        }
        this.deps.providerModeTrackersByPtyId().set(ptyId, modeTracker)
        effectiveAlternateScreen = modeTracker.isAlternateScreen
      }
      const providerOffset = this.deps.providerSequenceOffsetByPtyId().get(ptyId) ?? 0
      const reconciledSnapshot = this.deps.preferTrackedLastTitle()(ptyId, {
        ...snapshot,
        seq: providerOffset + snapshot.seq,
        ...(effectiveAlternateScreen !== undefined
          ? { alternateScreen: effectiveAlternateScreen }
          : {})
      })
      if (liveModeTracker.hasObservedAlternateScreenSwitch) {
        this.deps.providerSnapshotsWithLiveModeTransition().add(reconciledSnapshot)
      }
      return reconciledSnapshot
    } catch {
      return null
    } finally {
      liveModeTrackers.delete(liveModeTracker)
      if (liveModeTrackers.size === 0) {
        this.deps.providerModeSnapshotScansByPtyId().delete(ptyId)
      }
    }
  }

  captureReadyGraphEpoch(): number {
    this.assertGraphReady()
    return this.deps.rendererGraphEpoch()
  }

  async clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    const state = this.deps.headlessTerminals().get(ptyId)
    if (!state) {
      return
    }
    // Why: headless writes are queued to preserve xterm parser order. Clear
    // must join that same chain or an earlier PTY chunk can finish after the
    // clear request and repopulate mobile scrollback.
    state.writeChain = state.writeChain.then(() => state.emulator.clearScrollback())
    await state.writeChain
  }

  clearRuntimeSessionOwnershipForMobileTerminalLeaf() {
    return this.deps.mobileSessionFacade().clearRuntimeSessionOwnershipForMobileTerminalLeaf()
  }

  async clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (!leaf?.ptyId) {
      throw new Error('terminal_not_found')
    }
    // Why: clear is a terminal UI action (Cmd+K on desktop), not shell input.
    // Route through the controller so renderer-owned xterm buffers, daemon
    // sessions, and SSH relay sessions all drop scrollback before the next
    // mobile snapshot.
    await this.deps.ptyController()?.clearBuffer?.(leaf.ptyId)
    await this.clearHeadlessTerminalBuffer(leaf.ptyId)
    return { handle, cleared: true }
  }

  closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowMissingPersistedTab?: boolean; killPtys?: boolean } = {}
  ): void {
    return this.deps
      .mobileSessionFacade()
      .closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, options)
  }

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const tabId = pty.pty.tabId
      if (!tabId) {
        return this.closeTerminal(handle)
      }
      // Why: a handle-addressed CLI/automation close is an explicit intent, so
      // it must stay destructive under the non-user close adjudication gate.
      await this.deps.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, { reason: 'user' })
      this.deps.claudeAgentTeams().removeTeamForLeaderHandle(handle)
      return { handle, tabId, closeMode: 'tab', ptyKilled: false }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    await this.deps.closeMobileSessionTab(`id:${leaf.worktreeId}`, leaf.tabId, { reason: 'user' })
    this.deps.claudeAgentTeams().removeTeamForLeaderHandle(handle)
    return { handle, tabId: leaf.tabId, closeMode: 'tab', ptyKilled: false }
  }

  collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    return this.deps
      .mobileSessionFacade()
      .collectMobileVisibleGraphChangedWorktrees(previousTabs, previousLeaves)
  }

  collectVisibleTerminalLeafIds(
    node: TerminalPaneLayoutNode,
    tabId: string,
    summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
  ): string[] {
    if (node.type === 'leaf') {
      return summariesByLeafKey.has(this.getLeafKey(tabId, node.leafId)) ? [node.leafId] : []
    }
    return [
      ...this.collectVisibleTerminalLeafIds(node.first, tabId, summariesByLeafKey),
      ...this.collectVisibleTerminalLeafIds(node.second, tabId, summariesByLeafKey)
    ]
  }

  commitRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    publication: RemoteTerminalSourceRangeReplacementPublication
  ): boolean {
    return (
      this.remoteTerminalSourceRangeConsumerHooks?.commitReplacement(reservation, publication) ??
      false
    )
  }

  countLeavesInTab(tabId: string): number {
    let count = 0
    for (const leaf of this.deps.leaves().values()) {
      if (leaf.tabId === tabId) {
        count++
      }
    }
    return count
  }

  countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.deps
      .clientEventPublishingCommands()
      .countTerminalSideEffectConsumingClientEventListeners()
  }

  async createDefaultTabTerminals(
    worktreeSelector: string,
    worktreeId: string,
    defaultTabs: CreateWorktreeResult['defaultTabs'] | undefined,
    surfacing: { surfaceOwner?: false } = {}
  ): Promise<string[]> {
    if (!defaultTabs || defaultTabs.tabs.length === 0 || !this.deps.ptyController()?.spawn) {
      return []
    }
    const handles: string[] = []
    for (const template of defaultTabs.tabs) {
      try {
        const command = template.command?.trim()
        const terminal = await this.createTerminal(worktreeSelector, {
          ...(template.title ? { title: template.title } : {}),
          ...(command && defaultTabs.runCommands ? { command } : {}),
          ...surfacing
        })
        handles.push(terminal.handle)
        if (template.color && terminal.tabId) {
          await this.setMobileSessionTabProps(`id:${worktreeId}`, {
            tabId: terminal.tabId,
            color: template.color
          })
        }
      } catch (error) {
        console.warn(`[worktree-create] Failed to create default tab for ${worktreeId}:`, error)
      }
    }
    return handles
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
    return this.deps.mobileSessionFacade().createMobileSessionTerminal(worktreeSelector, opts)
  }

  createPreAllocatedTerminalHandle(): string {
    return this.deps.ptyWorktrees().createPreAllocatedTerminalHandle()
  }

  createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number }
  ): RuntimeHeadlessTerminal {
    return this.deps.ptyWorktrees().createPtyHeadlessTerminalState(ptyId, dims)
  }

  async dedupeTerminalCreate(
    clientIdentity: string,
    worktreeSelector: string | undefined,
    clientMutationId: string | undefined,
    reconcileExisting: boolean,
    run: (
      canonicalWorktreeSelector: string | undefined,
      preAllocatedHandle: string | undefined
    ) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate> {
    if (!clientMutationId || !worktreeSelector) {
      if (reconcileExisting) {
        throw new Error('runtime_unavailable')
      }
      return await run(worktreeSelector, undefined)
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const canonicalWorktreeSelector = `id:${workspace.id}`
    const preAllocatedHandle = deriveRemoteRuntimeTerminalCreateHandle(
      clientIdentity,
      workspace.id,
      clientMutationId
    )
    return this.deps
      .terminalCreateIdempotency()
      .run(clientIdentity, workspace.id, clientMutationId, async () => {
        if (reconcileExisting) {
          const adopted = await this.reconcileRemoteTerminalCreate(workspace.id, preAllocatedHandle)
          if (adopted) {
            return adopted
          }
        }
        return await run(canonicalWorktreeSelector, preAllocatedHandle)
      })
  }

  disposeHeadlessTerminal(ptyId: string): void {
    this.deps.headlessHydrationState().delete(ptyId)
    const state = this.deps.headlessTerminals().get(ptyId)
    if (!state) {
      return
    }
    this.deps.headlessTerminals().delete(ptyId)
    // Why: queued chain links still parse below before the emulator disposes;
    // sever the reply sink now so they cannot write to a respawned PTY that
    // reused this id (belt to the sink's state-identity check).
    state.emulator.disableQueryReplyForwarding()
    state.ownership.dispose()
    state.writeChain.finally(() => state.emulator.dispose()).catch(() => state.emulator.dispose())
  }

  emitClientEvent(event: RuntimeClientEvent): void {
    this.deps.clientEventPublishingCommands().emitClientEvent(event)
  }

  emitTerminalSideEffectBatch(
    ptyId: string,
    facts: TerminalSideEffectFact[],
    options: { replay?: boolean } = {}
  ): void {
    if (!this.deps.terminalSideEffectConsumerAvailable() || facts.length === 0) {
      return
    }
    const batch: TerminalSideEffectBatch = {
      ptyId,
      seq: this.deps.ptyOutputSequenceById().get(ptyId) ?? 0,
      facts,
      ...(options.replay ? { replay: true } : {}),
      ...this.resolveTerminalSideEffectAttribution(ptyId)
    }
    if (this.deps.terminalSideEffectLocalConsumerAvailable()) {
      try {
        this.deps.onTerminalSideEffects()?.(batch)
      } catch (err) {
        console.error('[runtime] terminal side-effect listener threw', { ptyId, err })
      }
    }
    if (this.countTerminalSideEffectConsumingClientEventListeners() > 0) {
      this.emitClientEvent({ type: 'terminalSideEffects', batch })
    }
  }

  enqueueLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    return enqueueLayout(this.layoutCtx(), ptyId, target)
  }

  ensureSubscriberDrivenProviderAttach(ptyId: string): void {
    const controller = this.deps.ptyController()
    if (
      !controller?.attach ||
      this.deps.subscriberDrivenProviderAttachesByPtyId().has(ptyId) ||
      !this.deps.isKnownUnattachedLocalDaemonPty(ptyId)
    ) {
      return
    }
    const attach = controller.attach
    // Async wrapper: a synchronous controller throw must not break subscribe.
    const attempt = (async () => attach(ptyId))().catch(() => false)
    this.deps.subscriberDrivenProviderAttachesByPtyId().set(ptyId, attempt)
    void attempt.then((attached) => {
      // Why: an unprovable session must not be pinned as attached; a later
      // subscriber may retry once the daemon can prove it.
      if (!attached && this.deps.subscriberDrivenProviderAttachesByPtyId().get(ptyId) === attempt) {
        this.deps.subscriberDrivenProviderAttachesByPtyId().delete(ptyId)
      }
    })
  }

  filterTerminalSideEffectEventForClient(
    listener: (event: RuntimeClientEvent) => void,
    event: Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }>
  ): Extract<RuntimeClientEvent, { type: 'terminalSideEffects' }> | null {
    return this.deps
      .clientEventPublishingCommands()
      .filterTerminalSideEffectEventForClient(listener, event)
  }

  findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    return this.deps
      .mobileSessionFacade()
      .findMobileTerminalSurface(worktreeId, parentTabId, options)
  }

  findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    return this.deps.mobileSessionFacade().findMobileTerminalSurfaceForPty(worktreeId, ptyId)
  }

  findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    return this.deps.mobileSessionFacade().findPtyForMobileTerminalTab(worktreeId, tab, options)
  }

  flushPendingTerminalSideEffectFacts(ptyId: string, entry: RuntimePtyTitleTrackerEntry): void {
    if (entry.pendingFacts.length === 0) {
      return
    }
    const facts = entry.pendingFacts
    entry.pendingFacts = []
    this.emitTerminalSideEffectBatch(ptyId, facts)
  }

  async flushWorkspaceSessionOrThrowAsync(): Promise<void> {
    const store = this.deps.store()
    if (store?.flushPendingOrThrowAsync) {
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return
    }
    if (store?.flushOrThrow) {
      store.flushOrThrow()
      return
    }
    throw new Error('workspace_session_persistence_unavailable')
  }

  getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    return this.deps.ptyWorktrees().getAdoptedPtyExplicitIdleStatus(pty)
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.getTerminalHandleForPaneKey(paneKey) ?? undefined
  }

  getAllTerminalDrivers(): Map<string, DriverState> {
    return new Map(this.deps.currentDriver())
  }

  getAllTerminalFitOverrides(): Map<
    string,
    { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
  > {
    const result = new Map<
      string,
      { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
    >()
    for (const [ptyId, override] of this.deps.terminalFitOverrides()) {
      result.set(ptyId, { mode: override.mode, cols: override.cols, rows: override.rows })
    }
    for (const [ptyId] of this.deps.remoteDesktopOwners()) {
      if (result.has(ptyId)) {
        continue
      }
      const size = this.getTerminalSize(ptyId)
      if (size) {
        result.set(ptyId, { mode: 'remote-desktop-fit', ...size })
      }
    }
    return result
  }

  getAuthoritativeWindow(): BrowserWindow {
    const win = this.deps.getAvailableAuthoritativeWindow()
    if (!win || win.isDestroyed()) {
      throw new Error('No renderer window available')
    }
    return win
  }

  getAutoRestoreFitMs(): number | null {
    const raw = this.deps.store()?.getSettings().mobileAutoRestoreFitMs ?? null
    if (raw == null) {
      return null
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return null
    }
    return Math.min(Math.max(raw, MOBILE_AUTO_RESTORE_FIT_MIN_MS), MOBILE_AUTO_RESTORE_FIT_MAX_MS)
  }

  getClientTerminalQuickCommands(): TerminalQuickCommand[] {
    if (!this.deps.store()?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore().getSettings().terminalQuickCommands ?? []
  }

  getDriver(ptyId: string): DriverState {
    return this.deps.currentDriver().get(ptyId) ?? { kind: 'idle' }
  }

  getFreshExplicitAgentStatusForHandle(
    handle: string,
    paneKeyOverride?: string | null
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    /** When this state was entered. Pinned across same-state pings, so it identifies the turn. */
    stateStartedAt: number
  } | null {
    const paneKey = paneKeyOverride ?? this.getPaneKeyForTerminalHandle(handle)
    const now = Date.now()
    let bestStatus: NonNullable<RuntimeTerminalAgentStatus['status']> | null = null
    let bestUpdatedAt = -1
    let bestStateStartedAt = -1

    const consider = (
      state: AgentStatusEntry['state'] | undefined,
      updatedAt: number | null | undefined,
      restoredUnconfirmed = false,
      stateStartedAt?: number | null
    ): void => {
      if (!state || restoredUnconfirmed) {
        return
      }
      if (typeof updatedAt !== 'number' || now - updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
        return
      }
      const status = mapExplicitAgentStateToRuntimeTerminalStatus(state)
      // Why: older retained permission rows can remain visible after the agent
      // resumes. Prefer the newest explicit state; only let permission win ties.
      if (updatedAt > bestUpdatedAt || (updatedAt === bestUpdatedAt && status === 'permission')) {
        bestStatus = status
        bestUpdatedAt = updatedAt
        bestStateStartedAt = typeof stateStartedAt === 'number' ? stateStartedAt : updatedAt
      }
    }

    if (paneKey) {
      const retained = this.deps.latestAgentStatusByPaneKey().get(paneKey)
      consider(retained?.payload.state, retained?.updatedAt, false, retained?.stateStartedAt)
    }

    for (const entry of this.deps.getAgentStatusSnapshotFn()?.() ?? []) {
      if (entry.terminalHandle !== handle && (!paneKey || entry.paneKey !== paneKey)) {
        continue
      }
      consider(entry.state, entry.receivedAt, entry.restoredUnconfirmed, entry.stateStartedAt)
    }

    return bestStatus
      ? { status: bestStatus, updatedAt: bestUpdatedAt, stateStartedAt: bestStateStartedAt }
      : null
  }

  getHeadlessMobileSessionGroupId() {
    return this.deps.mobileSessionFacade().getHeadlessMobileSessionGroupId()
  }

  getLayout(ptyId: string): PtyLayoutState | null {
    return this.deps.layouts().get(ptyId) ?? null
  }

  getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }

  getLeavesForPty(ptyId: string): RuntimeLeafRecord[] {
    return this.deps.ptyWorktrees().getLeavesForPty(ptyId)
  }

  getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    return this.deps.ptyWorktrees().getLiveLeafForHandle(handle)
  }

  getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    return this.deps.ptyWorktrees().getLivePtyForHandle(handle)
  }

  getLiveTerminalPaneKey(handle: string): string | null {
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      return runtimePty.pty.connected ? (runtimePty.pty.paneKey ?? null) : null
    }
    try {
      const leaf = this.resolveLiveLeafForHandle(handle)
      if (!leaf?.ptyId) {
        return null
      }
      const pty = this.deps.ptysById().get(leaf.ptyId)
      return pty?.connected === false ? null : this.getPaneKeyForTerminalHandle(handle)
    } catch {
      return null
    }
  }

  getMobileAutoRestoreFitMs(): number | null {
    return this.deps.mobileSessionFacade().getMobileAutoRestoreFitMs()
  }

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.deps
      .mobileSessionFacade()
      .getMobileSessionTabsForWorktree(worktreeId, clientNavigationId)
  }

  getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    return this.deps.mobileSessionFacade().getMobileSessionTerminalHandle(worktreeId, tab)
  }

  getMobileTerminalLeafPtyIds() {
    return this.deps.mobileSessionFacade().getMobileTerminalLeafPtyIds()
  }

  getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    return this.deps.mobileSessionFacade().getMobileTerminalPaneKey(tab)
  }

  getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal {
    const existing = this.deps.headlessTerminals().get(ptyId)
    if (existing) {
      return existing
    }
    const size = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, size)
    this.deps.headlessTerminals().set(ptyId, state)
    return state
  }

  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    return this.deps.ptyWorktrees().getOrCreatePtyWorktreeRecord(ptyId)
  }

  getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    return this.deps.orchestrationCommands().getOrchestrationDbIfAvailable()
  }

  getPaneKeyForTerminalHandle(handle: string): string | null {
    return this.deps.hookAgentRowResolutionCommands().getPaneKeyForTerminalHandle(handle)
  }

  getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform'> {
    return this.deps.ptyWorktrees().getPtyExecutionHostMetadata(ptyId)
  }

  getPtyLifecycleGeneration(ptyId: string): number {
    return this.deps.ptyWorktrees().getPtyLifecycleGeneration(ptyId)
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.deps.ptyWorktrees().getPtyOutputSequence(ptyId)
  }

  getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null {
    return this.deps.hookAgentRowResolutionCommands().getPtyRecordForPaneKey(paneKey)
  }

  getRecentExpiredSshLease(worktreeId: string, tabId: string, leafId: string, ptyId: string) {
    return (
      this.deps.snapshotValueComparison() as {
        getRecentExpiredSshLease: (...args: unknown[]) => unknown
      }
    ).getRecentExpiredSshLease(worktreeId, tabId, leafId, ptyId)
  }

  getRecentSettledDispatchForTerminal(
    handle: string,
    db = this.getOrchestrationDbIfAvailable()
  ): ReturnType<OrchestrationDb['getLatestDispatchForTerminal']> {
    return this.deps
      .hookAgentRowResolutionCommands()
      .getRecentSettledDispatchForTerminal(handle, db)
  }

  getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[] {
    return this.deps
      .clientEventPublishingCommands()
      .getRecordedTerminalSleepHandles(ptyIds, terminalHandlesByPtyId)
  }

  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    const size = this.getTerminalSize(ptyId) ?? { cols: 0, rows: 0 }
    return {
      mode: this.isRemoteDesktopViewerOwner(ptyId, subscriptionKey)
        ? 'desktop-fit'
        : 'remote-desktop-fit',
      ...size
    }
  }

  getRendererTerminalSerializerGeneration(ptyId: string): number {
    return this.deps.ptyController()?.getRendererSerializerGeneration?.(ptyId) ?? 0
  }

  getRendererTerminalSerializerGenerationForHandle(handle: string): number {
    return this.deps.ptyWorktrees().getRendererTerminalSerializerGenerationForHandle(handle)
  }

  async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return this.deps.resolvedWorktreeCache().getResolvedWorktreeMap()
  }

  async getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.deps.getTerminalAgentStatusPtyId(handle)
    const terminal = this.deps.getTerminalAgentStatusSnapshot(handle, ptyId)
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle)
    const lifecycle = this.deps.agentPromptLifecycleByPtyId().get(ptyId)
    if (
      (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) ||
      this.deps.hasAuthoritativeTerminalWaitPermission(terminal, explicitStatus, lifecycle)
    ) {
      return { handle, isRunningAgent: true, status: 'permission' }
    }
    if (explicitStatus) {
      // Why: permission titles can linger after hooks report the agent resumed.
      // Fresh hook state is tighter, but current shell/management evidence wins.
      const isRunningAgent =
        !terminalTitleBlocksExplicitAgentStatus(terminal.title) &&
        !(await this.terminalHasShellForegroundProcess(handle, ptyId))
      this.deps.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return {
        handle,
        isRunningAgent,
        status: isRunningAgent ? explicitStatus.status : null
      }
    }
    if (terminal.titleStatus) {
      // Why: an OpenCode marker and a lone quarter-circle spinner (STA-4028) are activity,
      // not identity, so resolve both through the identity/foreground evidence path.
      if (
        isOpenCodeNativeTitle(terminal.title) ||
        isQuarterCircleSpinnerOnlyAgentTitle(terminal.title)
      ) {
        const isRunningAgent = await this.isTerminalRunningAgent(handle)
        this.deps.assertTerminalAgentStatusPtyBinding(handle, ptyId)
        return {
          handle,
          isRunningAgent,
          status: isRunningAgent ? terminal.titleStatus : null
        }
      }
      return { handle, isRunningAgent: true, status: terminal.titleStatus }
    }

    const isRunningAgent = await this.isTerminalRunningAgent(handle)
    this.deps.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    return { handle, isRunningAgent, status: null }
  }

  getTerminalFitOverride(ptyId: string) {
    return this.deps.terminalFitOverrides().get(ptyId) ?? null
  }

  getTerminalHandleForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed
      ? this.deps.leaves().get(this.getLeafKey(parsed.tabId, parsed.leafId))
      : undefined
    if (leaf?.ptyId && leaf.connected) {
      return this.issueHandle(leaf)
    }
    const panePty = this.getPtyRecordForPaneKey(paneKey)
    if (panePty?.connected) {
      return this.deps.issuePtyHandle(panePty)
    }
    if (leaf?.ptyId) {
      return this.issueHandle(leaf)
    }
    return panePty ? this.deps.issuePtyHandle(panePty) : null
  }

  getTerminalHandlesForPtyId(ptyId: string): string[] {
    return this.deps.ptyWorktrees().getTerminalHandlesForPtyId(ptyId)
  }

  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    return this.deps.terminalAgentStatusBinding().getTerminalInteractiveWait(handle)
  }

  getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null {
    return this.deps.ptyWorktrees().getTerminalLivenessVerdict(handle)
  }

  getTerminalOrchestrationCliCommand(handle: string): 'orca' | 'orca-ide' {
    let pty: RuntimePtyWorktreeRecord | null = null
    try {
      const ptyId = this.resolveLeafForHandle(handle)?.ptyId
      pty = ptyId ? (this.deps.ptysById().get(ptyId) ?? null) : null
    } catch {
      return 'orca'
    }
    if (!pty) {
      return 'orca'
    }
    return resolveTerminalOrchestrationCliCommand({
      connectionId: pty.connectionId,
      isWsl: pty.isWsl,
      worktreeId: pty.worktreeId,
      projectRuntime: this.deps.store()
        ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), pty.worktreeId)
        : undefined
    })
  }

  getTerminalOrphanAdoptionSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
    return this.deps.ptyWorktrees().getTerminalOrphanAdoptionSnapshot(worktreeId)
  }

  getTerminalPaneKey(handle: string): string | null {
    return this.getPaneKeyForTerminalHandle(handle)
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    return this.deps.ptyWorktrees().getTerminalProcessIncarnation(handle)
  }

  getTerminalSideEffectSnapshot(ptyId: string): TerminalSideEffectBatch | null {
    const tracker = this.deps.ptyTitleTrackersByPtyId().get(ptyId)?.tracker
    const recordTitle = this.deps.ptysById().get(ptyId)?.lastOscTitle
    const normalizedTitle = tracker?.getLastNormalizedTitle() ?? null
    // Why: a record-fallback snapshot must not replay the bare cursor-agent literal over a
    // tracker title Orca synthesized from hooks — but with no tracker title it is the pane's
    // only Cursor identity, so restored/mobile tabs keep it (#10258).
    const rawTitle =
      recordTitle && (normalizedTitle === null || !isCursorNativeAgentTitle(recordTitle))
        ? recordTitle
        : null
    if (normalizedTitle === null && !rawTitle) {
      return null
    }
    return {
      ptyId,
      seq: this.deps.ptyOutputSequenceById().get(ptyId) ?? 0,
      replay: true,
      facts: [
        {
          kind: 'title',
          normalizedTitle: normalizedTitle ?? normalizeTerminalTitle(rawTitle!),
          rawTitle: rawTitle ?? normalizedTitle!
        }
      ],
      ...this.resolveTerminalSideEffectAttribution(ptyId)
    }
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.deps.ptyController()?.getSize?.(ptyId) ?? null
  }

  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    return this.deps.clientEventPublishingCommands().getTerminalSleepClientEventSnapshot()
  }

  getTerminalTopologyRevision(worktreeId: string): number {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalTopologyRevisionByRepoId?.[repoId] ??
      this.deps.terminalTopologyRevisionByRepoId().get(repoId) ??
      0
    )
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    return this.deps.managedWorktrees().getTerminalWorktreeIdForPaneKey(paneKey)
  }

  getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    return this.deps.managedWorktrees().getValidatedExplicitWorktreeIdSelector(selector)
  }

  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.deps.managedWorktrees().getWorkspaceSessionForWorktree(worktreeId)
  }

  getWorktreeIdForTerminalHandle(handle: string): string | null {
    return this.deps.ptyWorktrees().getWorktreeIdForTerminalHandle(handle)
  }

  hasExactPersistedTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }): boolean {
    const session = this.getWorkspaceSessionForWorktree(expected.worktreeId)
    const sessionWorktreeId = session
      ? resolveTerminalSessionWorktreeId(session, expected.worktreeId)
      : null
    if (!session || !sessionWorktreeId) {
      return false
    }
    const tab = session.tabsByWorktree[sessionWorktreeId]?.find(
      (candidate) => candidate.id === expected.tabId
    )
    const paneKey = makePaneKey(expected.tabId, expected.leafId)
    return Boolean(
      tab &&
      session.terminalLayoutsByTabId[expected.tabId]?.ptyIdsByLeafId?.[expected.leafId] ===
        expected.ptyId &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === expected.incarnationId
    )
  }

  hasExactTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    terminalHandle: string
    incarnationId: string
  }): boolean {
    if (this.deps.graphStatus() !== 'ready') {
      return false
    }
    const pty = this.deps.ptysById().get(expected.ptyId)
    if (
      !pty?.connected ||
      pty.incarnationId !== expected.incarnationId ||
      pty.tabId !== expected.tabId ||
      pty.paneKey !== makePaneKey(expected.tabId, expected.leafId) ||
      !runtimeWorktreeIdsEqual(pty.worktreeId, expected.worktreeId) ||
      this.deps.handleByPtyId().get(expected.ptyId) !== expected.terminalHandle
    ) {
      return false
    }
    const tab = this.deps.tabs().get(expected.tabId)
    const leaf = this.deps.leaves().get(this.getLeafKey(expected.tabId, expected.leafId))
    const ptyLeaves = this.getLeavesForPty(expected.ptyId)
    return (
      Boolean(tab && runtimeWorktreeIdsEqual(tab.worktreeId, expected.worktreeId)) &&
      Boolean(
        leaf &&
        leaf.ptyId === expected.ptyId &&
        runtimeWorktreeIdsEqual(leaf.worktreeId, expected.worktreeId)
      ) &&
      ptyLeaves.length === 1 &&
      ptyLeaves[0]?.tabId === expected.tabId &&
      ptyLeaves[0]?.leafId === expected.leafId
    )
  }

  hasHeadlessTerminalState(ptyId: string): boolean {
    return this.deps.headlessTerminals().has(ptyId)
  }

  hasRawTerminalViewSubscriber(ptyId: string): boolean {
    return (
      (this.deps.rawTerminalViewSubscriberCounts().get(ptyId) ?? 0) > 0 ||
      this.hasRemoteTerminalViewSubscriber(ptyId)
    )
  }

  hasRecentTerminalOutputPath(handle: string, pathText: string, absolutePath: string): boolean {
    // Why: safety net for any query path that never saw a mobile onReady —
    // lazily backfill so the answer matches pre-gate behavior.
    if (!this.recentPtyPathCandidateTrackingActive) {
      this.activateRecentPtyPathCandidateTracking()
    }
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const recentOutput = ptyId ? this.deps.recentPtyOutputById().get(ptyId)?.read() : null
    if (recentOutput && recentTerminalOutputIncludesPath(recentOutput, pathText, absolutePath)) {
      return true
    }
    const candidates = ptyId ? this.deps.recentPtyPathCandidatesById().get(ptyId) : null
    return candidates
      ? recentTerminalPathCandidatesIncludePath(candidates, pathText, absolutePath)
      : false
  }

  hasRemoteDesktopLayoutState(ptyId: string): boolean {
    return (
      this.deps.remoteDesktopOwners().has(ptyId) ||
      this.deps.remoteDesktopHostReclaimTargets().has(ptyId)
    )
  }

  hasRemoteTerminalViewSubscriber(ptyId: string): boolean {
    if ((this.deps.remoteTerminalViewSubscriberCounts().get(ptyId) ?? 0) > 0) {
      return true
    }
    return (this.deps.mobileSubscribers().get(ptyId)?.size ?? 0) > 0
  }

  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    return this.deps.managedWorktrees().hasTerminalsForWorktree(worktreeSelector)
  }

  headlessMobileSnapshotContentUnchanged() {
    return this.deps.mobileSessionFacade().headlessMobileSnapshotContentUnchanged()
  }

  ingestSyntheticTitleFrame(ptyId: string, data: string): void {
    const entry = this.deps.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.applyingChunk = true
    entry.chunkTouchedSessionTabs = false
    try {
      entry.tracker.applySyntheticTitleFrame(data)
    } finally {
      entry.applyingChunk = false
      this.flushPendingTerminalSideEffectFacts(ptyId, entry)
    }
    if (entry.chunkTouchedSessionTabs) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }

  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'> {
    return this.deps
      .ptyWorktrees()
      .inspectTerminalProcessIncarnationLiveness(processIncarnation, serializedHostScope)
  }

  isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    return this.deps.ptyWorktrees().isLeafPtyProvenAbsent(ptyId)
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    return this.deps.mobileSessionFacade().isMobileSubscriberActive(ptyId)
  }

  isMobileTerminalQueryReplyAuthority(ptyId: string, clientId: string): boolean {
    return this.deps.mobileSessionFacade().isMobileTerminalQueryReplyAuthority(ptyId, clientId)
  }

  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.deps.remoteDesktopOwners().get(ptyId) === subscriptionKey
  }

  isRuntimeOwnedHeadlessMobileTab() {
    return this.deps.mobileSessionFacade().isRuntimeOwnedHeadlessMobileTab()
  }

  isTerminalAlternateScreen(ptyId: string): boolean {
    if (this.deps.providerSnapshotPreferredPtys().has(ptyId)) {
      return this.deps.providerModeTrackersByPtyId().get(ptyId)?.isAlternateScreen ?? false
    }
    return (
      this.deps.headlessTerminals().get(ptyId)?.emulator.isAlternateScreen ??
      this.deps.providerModeTrackersByPtyId().get(ptyId)?.isAlternateScreen ??
      false
    )
  }

  async isTerminalRunningAgent(
    handle: string,
    options: { retryForegroundWrappers?: boolean } = {}
  ): Promise<boolean> {
    try {
      const pty = this.getLivePtyForHandle(handle)
      if (pty) {
        const leaf = this.deps.getPrimaryLeafForPty(pty.pty.ptyId)
        return await this.deps.isPtyRunningAgent(pty.pty, leaf, options)
      }
      const { leaf } = this.getLiveLeafForHandle(handle)
      const trackedPty = leaf.ptyId ? this.deps.ptysById().get(leaf.ptyId) : null
      // Why: check the leaf pane title and the tab title, which already carries OSC-enriched agent indicators (e.g. ✳ prefix).
      const paneTitle = getLatestLeafTitle(leaf, null)
      const paneTitleClassification = classifyAgentTitle(paneTitle)
      if (
        trackedPty
          ? ptyTitleProvesAgentPresence(trackedPty, paneTitle, paneTitleClassification)
          : agentTitleProvesAgentPresence(paneTitle, paneTitleClassification)
      ) {
        return true
      }
      const tabTitle = this.deps.tabs().get(leaf.tabId)?.title?.trim() || null
      const tabTitleClassification = paneTitle === null ? classifyAgentTitle(tabTitle) : 'neutral'
      if (
        trackedPty
          ? ptyTitleProvesAgentPresence(trackedPty, tabTitle, tabTitleClassification)
          : agentTitleProvesAgentPresence(tabTitle, tabTitleClassification)
      ) {
        return true
      }
      const openCodeMarkerTitle = paneTitle ?? tabTitle
      const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      if (!isOpenCodeNativeTitle(openCodeMarkerTitle) && isKnownReadyPromptPreview(waitText)) {
        return true
      }
      const hasCurrentTitleEvidence = paneTitle !== null || tabTitle !== null
      if (leaf.lastAgentStatus !== null && !hasCurrentTitleEvidence) {
        return true
      }
      if (!leaf.ptyId || !this.deps.ptyController()) {
        return false
      }
      const fg = await this.deps.ptyController()!.getForegroundProcess(leaf.ptyId)
      // Why: a bare `Cursor Agent` title is identity, not liveness — it reads the same
      // whether cursor-agent is parked or long exited with the shell back. A null
      // foreground is untracked, not alive, so no-evidence must stay a refusal. A live
      // pane wrongly refused here means the read failed; fix that, not this.
      if (!fg) {
        return false
      }
      // Why: Claude's management UI runs under the Claude process but isn't a task-capable session; suppress only that process.
      const shouldSuppressClaudeForeground =
        paneTitleClassification === 'management' || tabTitleClassification === 'management'
      if (shouldSuppressClaudeForeground && isExpectedAgentProcess(fg, 'claude')) {
        return false
      }
      // Why: review-note delivery auto-submits with Enter, so only known agent processes are safe (not arbitrary focused TUIs).
      return await this.deps.isRecognizedForegroundAgentProcess(leaf.ptyId, fg, {
        suppressClaude: shouldSuppressClaudeForeground,
        retryWrappers: options.retryForegroundWrappers !== false
      })
    } catch {
      return false
    }
  }

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    try {
      const livePty = this.getLivePtyForHandle(handle)
      const leaf = livePty ? null : this.getLiveLeafForHandle(handle).leaf
      const ptyId = livePty?.pty.ptyId ?? leaf?.ptyId ?? null
      const trackedPty = livePty?.pty ?? (ptyId ? this.deps.ptysById().get(ptyId) : null)
      if (!ptyId || !trackedPty || !this.deps.ptyController()) {
        return false
      }
      const recognized = recognizeAgentProcess(
        await this.deps.ptyController()!.getForegroundProcess(ptyId)
      )
      const recognizedAgent = recognized?.agent
      if (!isTerminalSendSettlementAgent(recognizedAgent)) {
        return false
      }
      if (!(await this.isTerminalRunningAgent(handle, { retryForegroundWrappers: false }))) {
        return false
      }
      trackedPty.foregroundAgent = recognizedAgent
      return true
    } catch {
      return false
    }
  }

  issueHandle(leaf: RuntimeLeafRecord): string {
    return this.deps.ptyWorktrees().issueHandle(leaf)
  }

  async launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<RuntimeTerminalCreate> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.deps.store()?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('Repository for the selected workspace is no longer available.')
    }
    const startup = this.buildStartupForAgent(repo, opts.agent, opts.prompt)
    await this.markWorkspaceTrustedForAgent(opts.agent, repo.connectionId, worktree.path)
    return await this.createTerminal(`id:${worktree.id}`, {
      command: startup.startup.command,
      env: startup.startup.env,
      ...(startup.startup.launchConfig ? { launchConfig: startup.startup.launchConfig } : {}),
      launchAgent: startup.agent,
      startupCommandDelivery: startup.startup.startupCommandDelivery,
      telemetry: startup.startup.telemetry,
      title: opts.title
    })
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return this.deps.mobileSessionFacade().listAllMobileSessionTabs(clientNavigationId)
  }

  listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    return this.deps
      .resolvedWorktreeCache()
      .listKnownResolvedWorktreesForExplicitTarget(targetWorktreeId, targetWorktree)
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT,
    opts: {
      handles?: readonly string[]
      requireFreshPtyLiveness?: boolean
      includeVisualLayouts?: boolean
    } = {}
  ): Promise<RuntimeTerminalListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const graphEpoch = this.deps.graphStatus() === 'ready' ? this.deps.rendererGraphEpoch() : null
    const explicitTargetWorktreeId = worktreeSelector
      ? this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
      : null
    const initialResolvedWorktreeCache = this.deps.resolvedWorktreeCache().peekSnapshot()
    const cachedResolvedWorktrees =
      initialResolvedWorktreeCache && initialResolvedWorktreeCache.expiresAt > Date.now()
        ? initialResolvedWorktreeCache.worktrees
        : null
    const cachedExplicitTargetWorktree =
      explicitTargetWorktreeId && cachedResolvedWorktrees
        ? (cachedResolvedWorktrees.find((worktree) => worktree.id === explicitTargetWorktreeId) ??
          null)
        : null
    const parsedExplicitTargetWorktree =
      explicitTargetWorktreeId && !cachedExplicitTargetWorktree
        ? this.buildResolvedWorktreeFromId(explicitTargetWorktreeId)
        : null
    const targetWorktree =
      worktreeSelector && !explicitTargetWorktreeId
        ? await this.resolveWorktreeSelector(worktreeSelector)
        : (cachedExplicitTargetWorktree ?? parsedExplicitTargetWorktree)
    const targetWorktreeId = explicitTargetWorktreeId ?? targetWorktree?.id ?? null
    const classificationResolvedWorktreeCache = this.deps.resolvedWorktreeCache().peekSnapshot()
    const classificationResolvedWorktrees =
      targetWorktreeId &&
      classificationResolvedWorktreeCache &&
      classificationResolvedWorktreeCache.expiresAt > Date.now()
        ? includeTargetResolvedWorktree(
            classificationResolvedWorktreeCache.worktrees,
            targetWorktree
          )
        : targetWorktreeId && explicitTargetWorktreeId
          ? this.listKnownResolvedWorktreesForExplicitTarget(targetWorktreeId, targetWorktree)
          : null
    const worktreesById =
      targetWorktreeId && targetWorktree
        ? new Map([[targetWorktree.id, targetWorktree]])
        : targetWorktreeId
          ? new Map()
          : await this.getResolvedWorktreeMap()
    if (graphEpoch !== null) {
      this.assertStableReadyGraph(graphEpoch)
    }

    const resolvedWorktrees =
      targetWorktreeId && classificationResolvedWorktrees
        ? classificationResolvedWorktrees
        : targetWorktreeId && targetWorktree
          ? [targetWorktree]
          : targetWorktreeId
            ? []
            : [...worktreesById.values()]
    const controllerInventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId
    )
    const refreshedPtyLiveness = controllerInventory
      ? new Set(controllerInventory.livePtyIds)
      : null
    if (opts.requireFreshPtyLiveness && !refreshedPtyLiveness) {
      throw new Error('terminal_liveness_unavailable')
    }
    // Why: a proof of absence, not a proof of liveness — leaves whose PTY the
    // controller answered for but did not list must not read as connected. An
    // unavailable inventory (null) proves nothing and demotes nothing.
    const provenLivePtyIds = controllerInventory?.allLivePtyIds ?? null

    const livePtyWorktreeIds = new Set<string>()
    for (const pty of this.deps.ptysById().values()) {
      if (pty.connected) {
        livePtyWorktreeIds.add(pty.worktreeId)
      }
    }

    const terminals: RuntimeTerminalSummary[] = []
    const ptyIdsFromLeaves = new Set<string>()
    if (graphEpoch !== null) {
      for (const leaf of this.deps.leaves().values()) {
        if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
          continue
        }
        if (
          opts.requireFreshPtyLiveness &&
          (!leaf.ptyId || !refreshedPtyLiveness?.has(leaf.ptyId))
        ) {
          continue
        }
        if (!leaf.ptyId && livePtyWorktreeIds.has(leaf.worktreeId)) {
          continue
        }
        if (leaf.ptyId) {
          ptyIdsFromLeaves.add(leaf.ptyId)
        }
        terminals.push(this.buildTerminalSummary(leaf, worktreesById, provenLivePtyIds))
      }
    }

    // Why: worktree.ps can classify active worktrees from PTY records even when
    // the renderer graph is missing a leaf. terminal.list needs the same fallback
    // so mobile does not show a false "No terminals" create flow.
    for (const pty of this.deps.ptysById().values()) {
      if (!pty.connected || ptyIdsFromLeaves.has(pty.ptyId)) {
        continue
      }
      if (opts.requireFreshPtyLiveness && !refreshedPtyLiveness?.has(pty.ptyId)) {
        continue
      }
      if (targetWorktreeId && pty.worktreeId !== targetWorktreeId) {
        continue
      }
      terminals.push(this.buildPtyTerminalSummary(pty, worktreesById))
    }

    const requestedHandles = opts.handles ? new Set(opts.handles) : null
    const matchingTerminals = requestedHandles
      ? terminals.filter((terminal) => requestedHandles.has(terminal.handle))
      : terminals
    const listedTerminals = matchingTerminals.slice(0, limit)
    // Why: undefined (pre-flag client) must still get layouts; only an explicit
    // `false` opts out.
    const visualLayouts =
      opts.includeVisualLayouts === false
        ? []
        : this.buildTerminalVisualLayouts(listedTerminals, worktreesById, targetWorktreeId)

    return {
      terminals: listedTerminals,
      hostScope: this.buildTerminalListHostScope(
        targetWorktreeId,
        matchingTerminals,
        worktreesById.values(),
        controllerInventory?.queriedHostIds ?? new Set()
      ),
      ...(visualLayouts.length > 0 ? { visualLayouts } : {}),
      topologyRevisions: Object.fromEntries(
        [...new Set(matchingTerminals.map((terminal) => terminal.worktreeId))].map((worktreeId) => [
          worktreeId,
          this.getTerminalTopologyRevision(worktreeId)
        ])
      ),
      totalCount: matchingTerminals.length,
      truncated: matchingTerminals.length > limit
    }
  }

  makeRuntimePaneKey(leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>): string {
    return isTerminalLeafId(leaf.leafId)
      ? makePaneKey(leaf.tabId, leaf.leafId)
      : `${leaf.tabId}:${leaf.paneRuntimeId}`
  }

  markWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string | null | undefined,
    workspacePath: string
  ): Promise<void> {
    return connectionId
      ? this.deps.markRemoteWorkspaceTrustedForAgent(agent, connectionId, workspacePath)
      : this.deps.markLocalWorkspaceTrustedForAgent(agent, workspacePath)
  }

  mergePreservedHeadlessMobileSessionTabs() {
    return this.deps.mobileSessionFacade().mergePreservedHeadlessMobileSessionTabs()
  }

  nextTitleObservationSequence(): number {
    this.titleObservationSequence += 1
    return this.titleObservationSequence
  }

  noteTerminalSpawnCommand(ptyId: string, command: string | null | undefined): void {
    const trimmed = typeof command === 'string' ? command.trim() : ''
    if (trimmed.length > 0) {
      this.deps.terminalSpawnCommandsByPtyId().set(ptyId, trimmed)
    }
  }

  notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void {
    const listeners = this.deps.fitOverrideListeners().get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener({ mode, cols, rows }), 'fit-override')
  }

  notifyRemoteTerminalViewPresenceChanged(ptyId: string): void {
    try {
      this.deps.onRemoteTerminalViewPresenceChanged()?.(ptyId)
    } catch (err) {
      console.error('[runtime] remote view presence listener threw', { ptyId, err })
    }
  }

  notifyRendererOfHeadlessTerminalClose(parentTabId: string): void {
    // Why: this relay is advisory after main owns teardown; renderer failure must
    // not prevent the authoritative session flush or turn the close into failure.
    try {
      this.deps.notifier()?.closeTerminal(parentTabId)
    } catch (error) {
      console.warn('[runtime] failed to notify renderer after headless terminal close', {
        parentTabId,
        error
      })
    }
  }

  notifyReposChanged(): void {
    this.deps.clientEventPublishingCommands().notifyReposChanged()
  }

  notifyReposChangedForRemoteClients(): void {
    this.emitClientEvent({ type: 'reposChanged' })
  }

  notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void {
    const listeners = this.deps.resizeListeners().get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener(event), 'pty-resize')
  }

  async parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<{ lines: string[]; draft?: string }> {
    return this.deps.mobileSessionFacade().parseVisibleSnapshot(snapshot)
  }

  persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.deps.store()?.setWorkspaceSession) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabGroups: {
        ...session.tabGroups,
        [worktreeId]: groups.map((group) => ({
          id: group.id,
          worktreeId,
          activeTabId: group.activeTabId,
          tabOrder: [...group.tabOrder],
          ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
        }))
      },
      tabGroupLayouts: {
        ...session.tabGroupLayouts,
        [worktreeId]: layout
      }
    })
  }

  persistHeadlessTerminalActiveLeaf(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.deps.store()?.setWorkspaceSession) {
      return
    }
    const existingLayout = session.terminalLayoutsByTabId?.[tab.parentTabId]
    const nextLayouts = existingLayout
      ? {
          ...session.terminalLayoutsByTabId,
          [tab.parentTabId]: {
            ...this.deps.cloneTerminalLayoutSnapshot(existingLayout),
            activeLeafId: tab.leafId
          }
        }
      : session.terminalLayoutsByTabId
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      activeTabId: tab.parentTabId,
      activeTabIdByWorktree: {
        ...session.activeTabIdByWorktree,
        [worktreeId]: tab.parentTabId
      },
      terminalLayoutsByTabId: nextLayouts
    })
  }

  persistHeadlessTerminalSplit(args: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    splitFromLeafId: string
    direction: 'horizontal' | 'vertical'
  }): boolean {
    const session = this.getWorkspaceSessionForWorktree(args.worktreeId)
    if (!session || !this.deps.store()?.setWorkspaceSession) {
      return false
    }
    const existing = session.terminalLayoutsByTabId?.[args.tabId]
    const nextLayout = buildHeadlessTerminalSplitLayout(
      existing ? this.deps.cloneTerminalLayoutSnapshot(existing) : undefined,
      args
    )
    this.setWorkspaceSessionForWorktree(args.worktreeId, {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: nextLayout
      }
    })
    return true
  }

  persistHeadlessTerminalTabOrder(worktreeId: string, tabOrder: string[]) {
    return (
      this.deps.mobileTabSnapshots() as {
        persistHeadlessTerminalTabOrder: (w: string, t: string[]) => void
      }
    ).persistHeadlessTerminalTabOrder(worktreeId, tabOrder)
  }

  persistHeadlessTerminalTitle(worktreeId: string, tabId: string, title: string | null): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.deps.store()?.setWorkspaceSession) {
      return
    }
    const tabs = session.tabsByWorktree[worktreeId]
    if (!tabs?.some((tab) => tab.id === tabId)) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, customTitle: title } : tab))
      }
    })
  }

  async persistLegacyWorkerTerminalRecoveryBatch(
    resolutions: readonly LegacyWorkerTerminalRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    return this.deps.ptyWorktrees().persistLegacyWorkerTerminalRecoveryBatch(resolutions)
  }

  persistedParentStillBindsMobileTerminalLeaf() {
    return this.deps.mobileSessionFacade().persistedParentStillBindsMobileTerminalLeaf()
  }

  prepareLegacyWorkerTerminalRecovery(): LegacyWorkerTerminalRecoveryPlan {
    return this.deps.ptyWorktrees().prepareLegacyWorkerTerminalRecovery()
  }

  primeWaitBlockedBaselineFromSeededTail(ptyId: string): void {
    const pty = this.deps.ptysById().get(ptyId)
    if (!pty) {
      return
    }
    let state = this.deps.waitBlockedCheckStateByPtyId().get(ptyId)
    if (!state) {
      state = { lastAt: 0, lastWaitState: null, appended: '', keywordCarry: '', timer: null }
      this.deps.waitBlockedCheckStateByPtyId().set(ptyId, state)
    }
    if (state.lastWaitState === null) {
      state.lastWaitState = computeTerminalTailWaitState(
        pty.tailBuffer,
        pty.tailPartialLine,
        pty.preview
      )
    }
  }

  processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    let processor = this.deps.agentStatusOscProcessorsByPtyId().get(ptyId)
    if (!processor) {
      processor = createAgentStatusOscProcessor()
      this.deps.agentStatusOscProcessorsByPtyId().set(ptyId, processor)
    }
    return processor(data)
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
    return this.deps
      .mobileSessionFacade()
      .publishPtyBackedMobileSessionTerminal(worktreeId, pty, args)
  }

  async readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const state = this.deps.headlessTerminals().get(ptyId)
    if (!state) {
      return null
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    await state.writeChain
    if (
      this.deps.headlessTerminals().get(ptyId) !== state ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return null
    }
    const projection = projectVisibleTerminalLines(state.emulator)
    return {
      lines: projection.lines,
      ...(projection.draft ? { draft: projection.draft } : {}),
      isAlternateScreen: state.emulator.isAlternateScreen,
      sequence: state.outputSequence,
      generation
    }
  }

  async readProviderTerminalTailLines(
    ptyId: string,
    limit: number | undefined,
    snapshotOptions: ProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalProjection> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
    const snapshot = await this.serializeProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: snapshotOptions.visibleScreenOnly ? 0 : lineLimit },
      snapshotOptions
    )
    if (!snapshot) {
      return { lines: [] }
    }
    // Why: a cached acquisition can carry scrollback this caller did not ask for,
    // so visible-only reads parse the grid itself rather than trusting the request.
    if (snapshotOptions.visibleScreenOnly) {
      const projection = await this.parseVisibleSnapshot(snapshot)
      // Live bytes ordered after the provider frame make that frame stale.
      return this.getPtyLifecycleGeneration(ptyId) === generation &&
        this.getPtyOutputSequence(ptyId) <= snapshot.seq
        ? projection
        : { lines: [] }
    }
    const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
    if (data.length === 0) {
      return { lines: [] }
    }
    const emulator = new HeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: lineLimit
    })
    try {
      await emulator.write(data)
      const projection = projectTerminalTailLines(emulator, lineLimit)
      return this.getPtyLifecycleGeneration(ptyId) === generation &&
        this.getPtyOutputSequence(ptyId) <= snapshot.seq
        ? projection
        : { lines: [] }
    } finally {
      emulator.dispose()
    }
  }

  readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts: { cursor?: number; limit?: number } = {}
  ): RuntimeTerminalRead {
    return this.deps.ptyWorktrees().readPtyTerminal(handle, pty, opts)
  }

  async readRenderedScreen(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { limit?: number } = {}
  ): Promise<RuntimeTerminalRead> {
    const visibleState = await this.readVisibleTerminalState(ptyId)
    const projection = visibleState ?? (await this.readProviderTerminalTailLines(ptyId, opts.limit))
    if (projection.lines.length === 0) {
      return { ...read, source: 'screen-unavailable' }
    }
    return buildVisibleSnapshotReadFallback(read, projection.lines, opts.limit, projection.draft)
  }

  async readTerminal(
    handle: string,
    opts: { cursor?: number; limit?: number; screen?: boolean } = {},
    providerSnapshot: ProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const read = this.readPtyTerminal(handle, pty.pty, opts)
      const visibleRead = opts.screen
        ? await this.readRenderedScreen(pty.pty.ptyId, read, opts)
        : await this.withVisibleSnapshotFallback(pty.pty.ptyId, read, opts, providerSnapshot)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      return labelTerminalReadSource(visibleRead)
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    const read = readTerminalTail({
      handle,
      status: getTerminalState(leaf),
      previewLines: leaf.tailBuffer,
      completedLines: leaf.tailTranscriptBuffer,
      partialLine: leaf.tailPartialLine,
      completedLineCount: leaf.tailLinesTotal,
      bufferTruncated: leaf.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
    if (!leaf.ptyId) {
      return { ...read, source: opts.screen ? 'screen-unavailable' : 'stream' }
    }
    const visibleRead = opts.screen
      ? await this.readRenderedScreen(leaf.ptyId, read, opts)
      : await this.withVisibleSnapshotFallback(leaf.ptyId, read, opts, providerSnapshot)
    this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    return labelTerminalReadSource(visibleRead)
  }

  reconcileHeadlessMobileSessionBrowserTabs() {
    return this.deps.mobileSessionFacade().reconcileHeadlessMobileSessionBrowserTabs()
  }

  async reconcileLegacyWorkerTerminals(
    options: { connectionId?: string; materializeRenderer?: boolean } = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    let resolveResult!: (result: LegacyWorkerTerminalRecoveryResult) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<LegacyWorkerTerminalRecoveryResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const run = this.legacyWorkerTerminalRecoveryQueue.then(async () => {
      try {
        resolveResult(await this.deps.reconcileLegacyWorkerTerminalsNow(options))
      } catch (error) {
        rejectResult(error)
      }
    })
    this.legacyWorkerTerminalRecoveryQueue = run.catch(() => undefined)
    return result
  }

  reconcileMissingLegacyWorkerTerminal(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): boolean {
    return this.deps.ptyWorktrees().reconcileMissingLegacyWorkerTerminal(candidate)
  }

  async reconcileRemoteTerminalCreate(
    worktreeId: string,
    terminalHandle: string
  ): Promise<RuntimeTerminalCreate | null> {
    if (!this.deps.ptyController()?.listProcesses) {
      throw new Error('runtime_unavailable')
    }
    const listed = await withTimeoutResult(
      this.deps.ptyController()!.listProcesses!(),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      // Why: unknown inventory cannot prove the first create failed, so spawning could duplicate a live shell.
      throw new Error('runtime_unavailable')
    }
    const matches = listed.value.filter((session) => session.terminalHandle === terminalHandle)
    if (matches.length > 1) {
      throw new Error('terminal_create_identity_conflict')
    }
    if (matches.length === 0) {
      const sameWorktreeHasUnknownIdentity = listed.value.some(
        (session) =>
          (session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)) === worktreeId &&
          !session.terminalHandle
      )
      if (sameWorktreeHasUnknownIdentity) {
        // Why: older retained providers may list the first shell without its handle; absence is not authoritative in that shape.
        throw new Error('runtime_unavailable')
      }
      return null
    }
    const session = matches[0]
    const authoritativeWorktreeId = session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)
    if (authoritativeWorktreeId !== worktreeId) {
      // Why: a reused address or forged provider record must never adopt a PTY from another workspace.
      throw new Error('terminal_create_identity_conflict')
    }
    this.adoptControllerTerminalHandle(session.id, terminalHandle)
    const pty = this.deps.recordPtyWorktree(session.id, worktreeId, {
      connected: true,
      title: session.title
    })
    const adoptedHandle = this.deps.issuePtyHandle(pty)
    if (adoptedHandle !== terminalHandle) {
      throw new Error('terminal_create_identity_conflict')
    }
    return {
      handle: adoptedHandle,
      ptyId: session.id,
      worktreeId,
      title: session.title || null,
      surface: 'background'
    }
  }

  recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void {
    if (status === 'permission') {
      this.deps.recordAgentPromptPermissionObservation(ptyId)
    }
    const current = this.deps.agentPromptLifecycleByPtyId().get(ptyId)
    const updatedAt = Date.now()
    if (!current) {
      this.deps.agentPromptLifecycleByPtyId().set(ptyId, {
        status,
        workingSequence: status === 'working' ? 1 : 0,
        updatedAt
      })
      return
    }
    this.deps.agentPromptLifecycleByPtyId().set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && current.status !== 'working' ? 1 : 0),
      updatedAt
    })
  }

  recordRecentPtyOutputForPathProvenance(ptyId: string, data: string): void {
    let recentOutputBuffer = this.deps.recentPtyOutputById().get(ptyId)
    if (!recentOutputBuffer) {
      // Boundaries are only owed to the one-time activation backfill; once
      // tracking is live, new buffers keep the read-collapsing hot path.
      recentOutputBuffer = new RecentPtyOutputBuffer({
        preserveChunkBoundaries: !this.recentPtyPathCandidateTrackingActive
      })
      this.deps.recentPtyOutputById().set(ptyId, recentOutputBuffer)
    }
    recentOutputBuffer.append(data)
    if (
      this.recentPtyPathCandidateTrackingActive ||
      // Why: an over-window chunk is stored pre-sliced, so activation backfill
      // could never replay its original text. Extract while intact; oversized
      // chunks are rare, so the desktop-only gate still skips the hot path.
      data.length > RECENT_PTY_OUTPUT_LIMIT
    ) {
      this.deps
        .recentPtyPathCandidatesById()
        .set(
          ptyId,
          appendRecentPtyPathCandidates(this.deps.recentPtyPathCandidatesById().get(ptyId), data)
        )
    }
  }

  recordTerminalSideEffectFact(ptyId: string, fact: TerminalSideEffectFact): void {
    if (!this.deps.terminalSideEffectConsumerAvailable()) {
      return
    }
    const entry = this.deps.ptyTitleTrackersByPtyId().get(ptyId)
    if (entry?.applyingChunk) {
      entry.pendingFacts.push(fact)
      return
    }
    this.emitTerminalSideEffectBatch(ptyId, [fact])
  }

  async recoverTerminalPane(
    paneKey: string,
    expectedWorktreeId: string,
    expectedHandle?: string
  ): Promise<RuntimeTerminalResolvePane> {
    const parsed = parsePaneKey(paneKey)
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (
      !parsed ||
      !pty ||
      !expectedHandle ||
      pty.worktreeId !== expectedWorktreeId ||
      this.getPaneKeyForTerminalHandle(expectedHandle) !== paneKey
    ) {
      throw new Error('terminal_not_found')
    }
    const recoveryKey = `${expectedWorktreeId}\0${paneKey}`
    const pending = this.deps.terminalPaneRecoveryByIdentity().get(recoveryKey)
    if (pending) {
      return pending
    }
    if (pty?.connected) {
      const current = this.resolveTerminalPane(paneKey, expectedWorktreeId)
      if (expectedHandle === undefined || current.handle !== expectedHandle) {
        return current
      }
      throw new Error('terminal_not_recoverable')
    }
    if (
      !this.getRecentExpiredSshLease(expectedWorktreeId, parsed.tabId, parsed.leafId, pty.ptyId)
    ) {
      // Why: an explicit close leaves a terminated lease; only relay expiry authorizes shell recreation.
      throw new Error('terminal_not_recoverable')
    }
    // Why: disconnected PTYs can reissue handles during graph cleanup; only a connected replacement satisfies the pane CAS.
    const recovery = this.createTerminal(`id:${expectedWorktreeId}`, {
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      focus: false
    }).then((terminal) => ({
      handle: terminal.handle,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      ptyId: terminal.ptyId ?? null,
      worktreeId: expectedWorktreeId
    }))
    this.deps.terminalPaneRecoveryByIdentity().set(recoveryKey, recovery)
    const clearRecovery = (): void => {
      if (this.deps.terminalPaneRecoveryByIdentity().get(recoveryKey) === recovery) {
        this.deps.terminalPaneRecoveryByIdentity().delete(recoveryKey)
      }
    }
    void recovery.then(clearRecovery, clearRecovery)
    return recovery
  }

  async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    return this.deps
      .ptyWorktrees()
      .refreshPtyWorktreeRecordsWithControllerInventory(
        resolvedWorktrees,
        targetWorktreeId,
        deadline,
        connectionId
      )
  }

  registerRawTerminalViewSubscriber(ptyId: string): () => void {
    this.deps
      .rawTerminalViewSubscriberCounts()
      .set(ptyId, (this.deps.rawTerminalViewSubscriberCounts().get(ptyId) ?? 0) + 1)
    this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const next = (this.deps.rawTerminalViewSubscriberCounts().get(ptyId) ?? 1) - 1
      if (next <= 0) {
        this.deps.rawTerminalViewSubscriberCounts().delete(ptyId)
      } else {
        this.deps.rawTerminalViewSubscriberCounts().set(ptyId, next)
      }
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    }
  }

  registerRemoteTerminalViewSubscriber(ptyId: string): () => void {
    this.deps
      .remoteTerminalViewSubscriberCounts()
      .set(ptyId, (this.deps.remoteTerminalViewSubscriberCounts().get(ptyId) ?? 0) + 1)
    this.ensureSubscriberDrivenProviderAttach(ptyId)
    this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const next = (this.deps.remoteTerminalViewSubscriberCounts().get(ptyId) ?? 1) - 1
      if (next <= 0) {
        this.deps.remoteTerminalViewSubscriberCounts().delete(ptyId)
      } else {
        this.deps.remoteTerminalViewSubscriberCounts().set(ptyId, next)
      }
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    }
  }

  rejectAllWaiters(code: string): void {
    return this.deps.ptyWorktrees().rejectAllWaiters(code)
  }

  rejectWaitersForHandle(handle: string, code: string): void {
    return this.deps.ptyWorktrees().rejectWaitersForHandle(handle, code)
  }

  releaseDesktopTakeBack(ptyId: string): void {
    this.setDriver(ptyId, { kind: 'desktop' })
    if (this.deps.terminalFitOverrides().has(ptyId)) {
      this.deps.terminalFitOverrides().delete(ptyId)
      this.deps.notifier()?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }
  }

  removeMessageWaiter(waiter: MessageWaiter): void {
    return this.deps.ptyWorktrees().removeMessageWaiter(waiter)
  }

  removeWaiter(waiter: TerminalWaiter): void {
    return this.deps.ptyWorktrees().removeWaiter(waiter)
  }

  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      pty.pty.title = title
      // Why: a manual rename must outrank later agent OSC title updates (which
      // win by timestamp), so stamp it as the freshest title.
      pty.pty.titleUpdatedAt = Date.now()
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      // Why: without a renderer the rename only lived on the live pty and was
      // lost on restart. Persist customTitle so a headless rebuild keeps it.
      if (!this.deps.notifier()?.renameTerminal && pty.pty.tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, pty.pty.tabId, title)
      }
      for (const leaf of this.deps.leaves().values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.deps.notifier()?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      return { handle, tabId: pty.pty.tabId ?? pty.record.tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.deps.notifier()?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  replaceHeadlessTerminalAfterExecutionContextChange(ptyId: string): void {
    this.disposeHeadlessTerminal(ptyId)
    this.deps.providerSnapshotPreferredPtys().add(ptyId)
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    this.deps.headlessTerminals().set(ptyId, state)
    state.writeChain = state.writeChain
      .then(async () => {
        const snapshot = await this.serializeProviderTerminalBuffer(ptyId)
        if (!snapshot) {
          return
        }
        const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
        // Why: a newer live OSC 7 can arrive while the snapshot is in flight;
        // only seed metadata while no post-correction CWD has won the race.
        if (!this.deps.terminalCwdByPtyId().has(ptyId)) {
          this.deps.recordOsc7MetadataForPty(ptyId, data)
        }
        await state.emulator.write(data)
        if (snapshot.cwd !== undefined) {
          state.emulator.setCwd(snapshot.cwd)
          if (!this.deps.terminalCwdByPtyId().has(ptyId) && snapshot.cwd?.trim()) {
            this.deps.terminalCwdByPtyId().set(ptyId, snapshot.cwd)
          }
        }
        if (snapshot.oscLinks !== undefined) {
          state.emulator.setRestoredOscLinks(snapshot.oscLinks)
        }
        state.ownership.seedOwner(snapshot.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        state.outputSequence = snapshot.seq
      })
      .catch(() => {
        // Best-effort: live bytes already chain behind this replacement state.
      })
      .finally(() => {
        this.deps.providerSnapshotPreferredPtys().delete(ptyId)
      })
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
    return this.deps
      .mobileSessionFacade()
      .replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, snapshot, trailingOutput)
  }

  requestRendererTerminalTabMount(handle: string): boolean {
    const record = this.deps.handles().get(handle)
    if (!record?.worktreeId) {
      return false
    }
    const tabId = record.tabId.startsWith('pty:') ? undefined : record.tabId
    const ptyId = record.ptyId ?? undefined
    if (!tabId && !ptyId) {
      return false
    }
    try {
      this.getAuthoritativeWindow().webContents.send('terminal:requestTabMount', {
        worktreeId: record.worktreeId,
        ...(tabId ? { tabId } : {}),
        ...(ptyId ? { ptyId } : {})
      })
      return true
    } catch {
      // No authoritative window (shutdown/headless): subscribe keeps its empty-snapshot fallback.
      return false
    }
  }

  requireStore(): Store {
    if (!this.deps.store()) {
      throw new Error('runtime_unavailable')
    }
    return this.deps.store() as unknown as Store
  }

  reserveRemoteTerminalSourceRangeReplacement(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    requiredSeq: number,
    reason: string
  ): RemoteTerminalSourceRangeReplacementReservation | null {
    return (
      this.remoteTerminalSourceRangeConsumerHooks?.reserveReplacement(
        identity,
        requiredSeq,
        reason
      ) ?? null
    )
  }

  resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    const state = this.deps.headlessTerminals().get(ptyId)
    if (!state) {
      return
    }
    // Why: terminal reflow is a parser operation. It must sit in the same
    // per-PTY stream as output bytes or restore snapshots can bake in wraps
    // from the wrong terminal width.
    state.writeChain = state.writeChain
      .then(() => {
        state.emulator.resize(cols, rows)
      })
      .catch(() => {
        // Best-effort mirror tracking; live PTY streaming must continue even
        // if xterm rejects a raced resize during teardown.
      })
  }

  resolveAiVaultSessionTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number } {
    // 1. Earliest-by-subscribedAt subscriber with non-null baseline.
    const inner = this.deps.mobileSubscribers().get(ptyId)
    if (inner) {
      const earliest = this.deps.pickEarliestRestoreTarget(inner)
      if (earliest) {
        return { cols: earliest.previousCols, rows: earliest.previousRows }
      }
    }
    // 2. Most-recent desktop renderer geometry report.
    const renderer = this.deps.lastRendererSizes().get(ptyId)
    if (renderer) {
      return { cols: renderer.cols, rows: renderer.rows }
    }
    // 3. Current PTY size.
    const size = this.getTerminalSize(ptyId)
    if (size) {
      return { cols: size.cols, rows: size.rows }
    }
    // 4. Hard default.
    return { cols: 80, rows: 24 }
  }

  resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    return this.deps.ptyWorktrees().resolveExitWaiters(leaf)
  }

  resolveFolderWorkspaceConnectionId(workspace: FolderWorkspace): string | null {
    const repos = this.deps.store()?.getRepos() ?? []
    const projectGroups = this.deps.store()?.getProjectGroups?.() ?? []
    const connection = inferFolderWorkspacePathConnection({
      folderPath: workspace.folderPath,
      projectGroupId: workspace.projectGroupId,
      connectionId: workspace.connectionId ?? null,
      projectGroups,
      repos
    })
    if (connection.kind === 'ambiguous') {
      // Why: a PTY spawns on one runtime target; mixed child-repo connections need an explicit V2 routing decision.
      throw new Error('folder_workspace_connection_ambiguous')
    }
    return connection.kind === 'ssh' ? connection.connectionId : null
  }

  async resolveFolderWorkspaceLaunchScope(
    selector: string
  ): Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null> {
    const workspace = this.resolveFolderWorkspaceSelector(selector)
    if (!workspace) {
      return null
    }
    if (!this.deps.store()) {
      throw new Error('runtime_unavailable')
    }
    const status = await getFolderWorkspacePathStatus(
      this.requireStore(),
      { scope: 'folder-workspace', folderWorkspaceId: workspace.id },
      { getSshFilesystemProvider }
    )
    assertFolderWorkspacePathUsable(status)
    return {
      id: folderWorkspaceKey(workspace.id),
      path: workspace.folderPath,
      connectionId: this.resolveFolderWorkspaceConnectionId(workspace),
      repo: null,
      folderWorkspace: workspace
    }
  }

  resolveFolderWorkspaceSelector(selector: string): FolderWorkspace | null {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    if (parsed?.type !== 'folder') {
      return null
    }
    const workspace = this.deps
      .store()
      ?.getFolderWorkspaces?.()
      .find((entry) => entry.id === parsed.folderWorkspaceId)
    if (!workspace) {
      throw new Error('selector_not_found')
    }
    return workspace
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    return this.deps.ptyWorktrees().resolveLeafForHandle(handle)
  }

  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    return this.deps.ptyWorktrees().resolveLiveLeafForHandle(handle)
  }

  resolveMessageWaiter(waiter: MessageWaiter, result: MessageWaitResult): void {
    return this.deps.ptyWorktrees().resolveMessageWaiter(waiter, result)
  }

  resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    return this.deps.ptyWorktrees().resolvePtyExitWaiters(pty, ptyId)
  }

  resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.deps.handleByPtyId().get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.deps.waitersByHandle().get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of waiters) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'tui-idle', pty))
      }
    }
  }

  resolveTerminalContext(
    handle: string
  ): { worktreeId: string; connectionId: string | null } | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const pty = ptyId ? this.deps.ptysById().get(ptyId) : null
    return pty ? { worktreeId: pty.worktreeId, connectionId: pty.connectionId } : null
  }

  async resolveTerminalCwd(handle: string): Promise<string | null> {
    return this.deps.ptyWorktrees().resolveTerminalCwd(handle)
  }

  resolveTerminalFileUriHostname(handle: string): string | null {
    return this.deps.ptyWorktrees().resolveTerminalFileUriHostname(handle)
  }

  resolveTerminalPane(paneKey: string, expectedWorktreeId?: string): RuntimeTerminalResolvePane {
    // Why: the renderer context menu only knows the stable pane key; main owns
    // the runtime terminal handle that agents and CLI commands can address.
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      throw new Error('terminal_not_found')
    }
    const record = this.deps.handles().get(handle)
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed
      ? this.deps.leaves().get(this.getLeafKey(parsed.tabId, parsed.leafId))
      : null
    const pty = this.getPtyRecordForPaneKey(paneKey)
    const candidateWorktreeIds = [leaf?.worktreeId, pty?.worktreeId].filter(
      (worktreeId): worktreeId is string => Boolean(worktreeId)
    )
    const worktreeId = candidateWorktreeIds[0] ?? null
    if (
      (candidateWorktreeIds.length > 1 && new Set(candidateWorktreeIds).size > 1) ||
      (expectedWorktreeId && candidateWorktreeIds.some((id) => id !== expectedWorktreeId)) ||
      (expectedWorktreeId && candidateWorktreeIds.length === 0)
    ) {
      // Why: pane coordinates restored by a paired client must not cross workspace ownership.
      throw new Error('terminal_not_found')
    }
    return {
      handle,
      tabId: parsed?.tabId ?? record?.tabId ?? '',
      leafId: parsed?.leafId ?? record?.leafId ?? '',
      ptyId: record?.ptyId ?? null,
      connected: pty?.connected === true,
      ...(worktreeId ? { worktreeId } : {}),
      ...this.getPtyExecutionHostMetadata(record?.ptyId ?? pty?.ptyId ?? null)
    }
  }

  resolveTerminalSideEffectAttribution(ptyId: string): {
    worktreeId?: string
    tabId?: string
    paneKey?: string
    connectionId?: string | null
  } {
    const pty = this.deps.ptysById().get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.getLeavesForPty(ptyId)) {
      return {
        worktreeId: leaf.worktreeId,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf),
        connectionId
      }
    }
    if (pty?.paneKey) {
      return {
        worktreeId: pty.worktreeId,
        ...(pty.tabId ? { tabId: pty.tabId } : {}),
        paneKey: pty.paneKey,
        connectionId
      }
    }
    return {}
  }

  resolveTerminalSplitSourceAuthority(
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ): {
    persisted: boolean
    rendererMounted: boolean
    persistedWorktreeId: string | null
    persistedIncarnationId: string | null
    liveIncarnationId: string | null
  } | null {
    return resolveTerminalSplitSourceAuthority(this, worktreeId, tabId, leafId, ptyId)
  }

  resolveTerminalSplitSourceAuthorityLegacy(handle: string): Promise<string | null> {
    const ptyId = this.deps.handleByPtyId().get(handle)
    return Promise.resolve(ptyId ? (this.deps.ptysById().get(ptyId)?.worktreeId ?? null) : null)
  }

  async resolveTerminalWorkspaceLaunchScope(
    selector: string
  ): Promise<TerminalWorkspaceLaunchScope> {
    const hook = this.deps.resolveTerminalWorkspaceLaunchScopeHook
    if (hook) {
      return hook(selector)
    }
    return (await this.resolveTerminalWorkspaceLaunchTarget(selector)).scope
  }

  async resolveTerminalWorkspaceLaunchTarget(
    selector: string
  ): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
    const floatingTerminalSelector =
      selector === FLOATING_TERMINAL_WORKTREE_ID ||
      selector === `id:${FLOATING_TERMINAL_WORKTREE_ID}`
    if (floatingTerminalSelector) {
      // Why: the floating sentinel is terminal-only — no backing repo/worktree record for other workspace APIs.
      return {
        scope: {
          id: FLOATING_TERMINAL_WORKTREE_ID,
          path: homedir(),
          connectionId: null,
          repo: null,
          folderWorkspace: null
        },
        managedWorktree: null
      }
    }

    const folderScope = await this.resolveFolderWorkspaceLaunchScope(selector)
    if (folderScope) {
      return {
        scope: folderScope,
        managedWorktree: this.deps.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace)
      }
    }

    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    const worktreeSelector = parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.deps.store()?.getRepo(worktree.repoId) ?? null
    return {
      scope: {
        id: worktree.id,
        path: worktree.path,
        connectionId: repo?.connectionId ?? null,
        repo,
        folderWorkspace: null
      },
      managedWorktree: worktree
    }
  }

  resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    return this.deps.ptyWorktrees().resolveTuiIdleWaiters(leaf)
  }

  resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    return this.deps.ptyWorktrees().resolveWaiter(waiter, result)
  }

  resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined {
    return resolveTerminalStartupCwd(workspace.path, requestedCwd)
  }

  async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    return this.deps.managedWorktrees().resolveWorktreeSelector(selector)
  }

  restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    return this.deps
      .mobileSessionFacade()
      .restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId, options)
  }

  retainAgentRowSnapshot(
    ptyId: string,
    paneKey: string,
    worktreeId: string | undefined,
    tabId: string | undefined,
    connectionId: string | null,
    payload: ParsedAgentStatusPayload
  ): boolean {
    return this.deps
      .mobileSessionFacade()
      .retainAgentRowSnapshot(ptyId, paneKey, worktreeId, tabId, connectionId, payload)
  }

  rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    return this.deps.ptyWorktrees().rollbackLegacyWorkerTerminalSurface(candidate)
  }

  rollbackRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    reason: string
  ): boolean {
    return (
      this.remoteTerminalSourceRangeConsumerHooks?.rollbackReplacement(reservation, reason) ?? false
    )
  }

  async runLayoutSlot(
    ptyId: string,
    target: PtyLayoutTarget,
    waiters: ((r: ApplyLayoutResult) => void)[]
  ): Promise<ApplyLayoutResult> {
    return runLayoutSlot(this.layoutCtx(), ptyId, target, waiters)
  }

  seedHeadlessTerminal(
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata: HeadlessSeedMetadata = {}
  ): void {
    if (!data) {
      return
    }
    const existing = this.deps.headlessTerminals().get(ptyId)
    if (existing) {
      // Why: emulator already has live data — re-seeding would duplicate
      // every byte. The seed is only valid when the emulator is fresh.
      if (metadata.preferProviderIfExisting) {
        this.deps.providerSnapshotPreferredPtys().add(ptyId)
      }
      return
    }
    const dims = size ?? this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.getPtyOutputSequence(ptyId)
    this.deps.headlessTerminals().set(ptyId, state)
    this.deps.recordOsc7MetadataForPty(ptyId, data)
    this.recordRecentPtyOutputForPathProvenance(ptyId, data)
    state.writeChain = state.writeChain
      .then(async () => {
        // Why: seed writes never set forwardQueryReplies — the main-side
        // replay guard. A snapshot containing old queries must answer no one.
        await state.emulator.write(data)
        // Why AFTER the seed write: the snapshot payload cannot carry kitty
        // pushes (rehydrateSequences deliberately omits them), but ordering
        // behind it keeps the parse deterministic. Unflagged like the seed —
        // re-applying flags must answer no one.
        if (typeof metadata.kittyKeyboardFlags === 'number') {
          await state.emulator.applyKittyKeyboardFlags(metadata.kittyKeyboardFlags)
        }
        if (metadata.cwd !== undefined) {
          state.emulator.setCwd(metadata.cwd)
        }
        if (metadata.oscLinks !== undefined) {
          state.emulator.setRestoredOscLinks(metadata.oscLinks)
        }
        // Why derived from the emulator: the seed bytes bypass ownership.scan,
        // so the scanner must inherit the restored alternate-screen state or a
        // pane seeded mid-TUI never arms its recovery trigger.
        state.ownership.seedOwner(metadata.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        this.deps.providerSnapshotPreferredPtys().delete(ptyId)
      })
      .catch(() => {
        // Seeding is best-effort; live data will continue to populate the
        // emulator even if the snapshot replay fails.
      })
  }

  seedTerminalRestoreTail(ptyId: string, restore: { text?: string; lastTitle?: string }): void {
    const seed = restore.text ? buildRestoredTerminalTailSeed(restore.text) : null
    if (seed) {
      const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
      // Why: live bytes outrank the seed — only never-written records take it,
      // so a same-run remount reattach cannot re-apply history it already has.
      if (pty && restoredTerminalTailSeedAllowed(pty)) {
        applyRestoredTerminalTailSeed(pty, seed)
        this.primeWaitBlockedBaselineFromSeededTail(ptyId)
      }
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (restoredTerminalTailSeedAllowed(leaf)) {
          applyRestoredTerminalTailSeed(leaf, seed)
        }
      }
    }
    if (restore.lastTitle) {
      // Why: mirror renderer hydration — a title main already tracked live outranks the payload's persisted one.
      this.applySeededAgentStatus(
        ptyId,
        this.deps.getTrackedRawTitleForPty(ptyId) ?? restore.lastTitle
      )
    }
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    },
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      // Why: the pre-Enter wait now scales with the payload, so an abandoned request must be
      // able to stop it instead of writing Enter minutes after the caller gave up.
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = buildSendPayload(action)
      if (payload === null) {
        throw new Error('invalid_terminal_send')
      }
      await assertTerminalInputWithinLimitWithYield(action.text)
      await this.writeTerminalAction(pty.pty.ptyId, action, payload, options)
      return {
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(payload, 'utf8')
      }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    await assertTerminalInputWithinLimitWithYield(action.text)
    // Why: leaf.writable mirrors the renderer graph, which can still answer for
    // a prior process's ptyId — and provider writes to unknown ids are accepted
    // no-ops. Only controller-proven absence rejects; unknown proceeds (a
    // restored daemon session takes writes before its pane remounts).
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }

    await this.writeTerminalAction(leaf.ptyId, action, payload, options)

    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeTerminalSend> {
    const payload = buildAgentPromptPasteBytes(prompt)
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      await assertTerminalInputWithinLimitWithYield(payload)
      const generation = this.getPtyLifecycleGeneration(pty.pty.ptyId)
      const submits = await this.serializeAgentPromptSubmission(
        pty.pty.ptyId,
        generation,
        async () => {
          this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
          this.assertAgentPromptGeneration(pty.pty.ptyId, generation)
          return await this.writeTerminalAgentPrompt(
            handle,
            pty.pty.ptyId,
            generation,
            payload,
            options
          )
        }
      )
      const bytesWritten = Buffer.byteLength(payload, 'utf8') + submits
      return { handle, accepted: true, bytesWritten }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    await assertTerminalInputWithinLimitWithYield(payload)
    // Why: same absence gate as sendTerminal — a stale graph mirror must not
    // accept a prompt into a void; unknown liveness still proceeds.
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(leaf.ptyId)
    const submits = await this.serializeAgentPromptSubmission(leaf.ptyId, generation, async () => {
      this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId!)
      this.assertAgentPromptGeneration(leaf.ptyId!, generation)
      return await this.writeTerminalAgentPrompt(handle, leaf.ptyId!, generation, payload, options)
    })
    const bytesWritten = Buffer.byteLength(payload, 'utf8') + submits
    return { handle, accepted: true, bytesWritten }
  }

  async serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T> {
    const queueKey = `${ptyId}\u0000${generation}`
    const previous = this.deps.agentPromptSubmissionTailByPtyId().get(queueKey) ?? Promise.resolve()
    const submission = previous.catch(() => undefined).then(submit)
    const tail = submission.then(
      () => undefined,
      () => undefined
    )
    this.deps.agentPromptSubmissionTailByPtyId().set(queueKey, tail)
    try {
      return await submission
    } finally {
      if (this.deps.agentPromptSubmissionTailByPtyId().get(queueKey) === tail) {
        this.deps.agentPromptSubmissionTailByPtyId().delete(queueKey)
      }
    }
  }

  async serializeAuthoritativeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts, {
      timeoutMs: AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      retireOnTimeout: true
    })
    if (providerSnapshot) {
      return providerSnapshot
    }
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  async serializeHeadlessTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number; includeEmpty?: boolean } = {}
  ): Promise<{
    data: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
    // Why: dangling mid-escape tail the restorer must write LAST, after any
    // reset, so the next live chunk completes it instead of rendering it
    // literally (Bug E / #7329).
    pendingEscapeTailAnsi?: string
  } | null> {
    const state = this.deps.headlessTerminals().get(ptyId)
    if (!state) {
      return null
    }
    await state.writeChain
    await state.ownership.settle()
    // Why: normal history is separated from an active alternate frame, so the
    // caller's scrollback policy can be honored without painting it into alt.
    const scrollbackRows = opts.scrollbackRows ?? 0
    const snapshot = state.emulator.getSnapshot({ scrollbackRows })
    const terminalOwner = state.ownership.owner
    const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
    return data.length > 0 || opts.includeEmpty === true
      ? this.deps.preferTrackedLastTitle()(ptyId, {
          data,
          frameRestoreAnsi: snapshot.frameRestoreAnsi,
          cols: snapshot.cols,
          rows: snapshot.rows,
          cwd: snapshot.cwd ?? this.deps.terminalCwdByPtyId().get(ptyId),
          lastTitle: snapshot.lastTitle,
          seq: state.outputSequence,
          source: 'headless' as const,
          oscLinks: snapshot.oscLinks,
          scrollbackAnsi: snapshot.scrollbackAnsi,
          // Why beside outputSequence and never re-read later: the flags must
          // describe the same stream position as the image, or replay would
          // apply push/pop transitions twice or out of order.
          ...(parseTerminalKittyKeyboardFlags(snapshot.modes?.kittyKeyboardFlags) !== undefined
            ? { kittyKeyboardFlags: snapshot.modes.kittyKeyboardFlags }
            : {}),
          ...(snapshot.pendingEscapeTailAnsi
            ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
            : {}),
          ...(terminalOwner ? { terminalOwner } : {}),
          // Why: lets the renderer skip the destructive scrollback clear when
          // restoring an alt-screen snapshot — clearing wipes xterm's own
          // history that the TUI relies on for scroll-up after a tab return.
          alternateScreen: snapshot.modes?.alternateScreen ?? state.emulator.isAlternateScreen,
          // Why NOT folded into data: the renderer writes its post-replay
          // reset after data, and any ESC after a dangling partial aborts it.
          // The restorer writes this last (Bug E fix).
          pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
        })
      : null
  }

  serializeMainTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    return this.serializeHeadlessTerminalBuffer(ptyId, { ...opts, includeEmpty: true })
  }

  async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
    let acquisition = this.deps.providerBufferAcquisitionsByPtyId().get(ptyId)
    // Why before the re-acquire branch: an unresponsive provider is a property of
    // the process, not of the row count one caller asked for. Checking retirement
    // only after re-acquiring let a wider request replace the retired entry and
    // hang again; the hung call's own settle still clears it and allows recovery.
    if (acquisition?.generation === generation && acquisition.timedOut) {
      return null
    }
    if (
      !acquisition ||
      acquisition.generation !== generation ||
      acquisition.scrollbackRows < scrollbackRows
    ) {
      const promise = this.captureProviderTerminalBuffer(ptyId, opts, generation)
      acquisition = { generation, scrollbackRows, promise, timedOut: false }
      this.deps.providerBufferAcquisitionsByPtyId().set(ptyId, acquisition)
      void promise.finally(() => {
        if (this.deps.providerBufferAcquisitionsByPtyId().get(ptyId) === acquisition) {
          this.deps.providerBufferAcquisitionsByPtyId().delete(ptyId)
        }
      })
    }
    if (acquisition.timedOut) {
      return null
    }
    if (typeof wait.timeoutMs !== 'number') {
      return acquisition.promise
    }
    const result = await withTimeout<
      { settled: true; value: PtyProviderBufferSnapshot | null } | { settled: false }
    >(
      acquisition.promise.then((value) => ({ settled: true as const, value })),
      wait.timeoutMs,
      { settled: false as const }
    )
    if (!result.settled) {
      if (wait.retireOnTimeout) {
        acquisition.timedOut = true
      }
      return null
    }
    return result.value
  }

  async serializeRendererTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    kittyKeyboardFlags?: number
  } | null> {
    if (this.deps.ptyController()?.hasRendererSerializer?.(ptyId) === false) {
      return null
    }
    let rendererSnapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      cwd?: string | null
      lastTitle?: string
      oscLinks?: TerminalOscLinkRange[]
      kittyKeyboardFlags?: number
    } | null = null
    try {
      // Why: recovery/read fallback wants visible alt-screen content (e.g. an
      // active TUI), so altScreenForcesZeroRows is FALSE here. Hydration is
      // the only path that suppresses alt-screen scrollback.
      rendererSnapshot = await (this.deps.ptyController()?.serializeBuffer?.(ptyId, {
        scrollbackRows: opts.scrollbackRows,
        altScreenForcesZeroRows: false
      }) ?? Promise.resolve(null))
    } catch {
      // Why: terminal snapshots should not depend on a mounted renderer pane.
      // If renderer serialization races reload/unmount, callers can still use
      // their existing null fallback paths.
    }
    return rendererSnapshot
      ? this.deps.preferTrackedLastTitle()(ptyId, {
          ...rendererSnapshot,
          cwd: rendererSnapshot.cwd ?? this.deps.terminalCwdByPtyId().get(ptyId),
          source: 'renderer' as const
        })
      : null
  }

  serializeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  async serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> {
    if (this.deps.providerSnapshotPreferredPtys().has(ptyId)) {
      // Why: pre-attach stream bytes only form a suffix of restored state. A
      // sequenced provider snapshot safely reconciles live bytes; renderer is
      // the fallback when an older provider cannot expose that boundary.
      const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
      if (providerSnapshot) {
        return providerSnapshot
      }
      const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
      if (rendererSnapshot) {
        return rendererSnapshot
      }
    }
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, opts)
    if (headlessSnapshot) {
      return headlessSnapshot
    }

    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    if (!rendererSnapshot) {
      return this.serializeProviderTerminalBuffer(ptyId, opts)
    }
    if (rendererSnapshot.data.length > 0) {
      return rendererSnapshot
    }
    // Why: parked desktop panes register serializers before their xterm has
    // hydrated. Treat that empty shell as provisional so retained provider
    // history can restore mobile without forcing the desktop pane to mount.
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
    return providerSnapshot &&
      (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
      ? providerSnapshot
      : rendererSnapshot
  }

  setDriver(ptyId: string, next: DriverState): void {
    const prev = this.getDriver(ptyId)
    if (prev.kind === next.kind) {
      if (prev.kind === 'mobile' && next.kind === 'mobile' && prev.clientId === next.clientId) {
        return
      }
      if (prev.kind !== 'mobile' && next.kind !== 'mobile') {
        return
      }
    }
    if (next.kind === 'idle') {
      this.deps.currentDriver().delete(ptyId)
    } else {
      this.deps.currentDriver().set(ptyId, next)
    }
    this.deps.notifier()?.terminalDriverChanged(ptyId, next)
    const listeners = this.deps.driverListeners().get(ptyId)
    if (listeners) {
      notifyRuntimeListeners(listeners, (listener) => listener(next), 'pty-driver')
    }
  }

  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    return this.deps.mobileSessionFacade().setMobileAutoRestoreFitMs(ms)
  }

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    return this.deps.mobileSessionFacade().setMobileDisplayMode(ptyId, mode)
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
    return this.deps.mobileSessionFacade().setMobileSessionTabProps(worktreeSelector, args)
  }

  setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void {
    const trimmed = title?.trim()
    if (!trimmed) {
      return
    }
    if (isClaudeManagementTitle(trimmed)) {
      pty.managementTitle = trimmed
      pty.managementTitleAt = observedAt
      return
    }
    if (
      detectAgentStatusFromTitle(trimmed) !== null &&
      observedAt >= (pty.managementTitleAt ?? -1)
    ) {
      pty.managementTitle = null
      pty.managementTitleAt = null
    }
  }

  setRemoteTerminalSourceRangeConsumerHooks(
    hooks: RemoteTerminalSourceRangeConsumerHooks | null
  ): void {
    this.remoteTerminalSourceRangeConsumerHooks = hooks
  }

  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    return this.deps.managedWorktrees().setWorkspaceSessionForWorktree(worktreeId, session)
  }

  settleRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[]
  ): void {
    this.remoteTerminalSourceRangeConsumerHooks?.settle(identity, ranges)
  }

  async showManagedTerminalWorkspace(worktreeSelector: string) {
    const target = await this.resolveTerminalWorkspaceLaunchTarget(worktreeSelector)
    if (!target.managedWorktree) {
      throw new Error('selector_not_found')
    }
    return target.managedWorktree
  }

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const worktreesById = await this.getResolvedWorktreeMap()
      const summary = this.buildPtyTerminalSummary(pty.pty, worktreesById)
      const preview = await this.visibleSnapshotPreview(pty.pty.ptyId, summary.preview)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      return {
        ...summary,
        preview,
        tabId: pty.pty.tabId ?? pty.record.tabId,
        leafId: parsePaneKey(pty.pty.paneKey ?? '')?.leafId ?? pty.record.leafId,
        paneRuntimeId: -1,
        ptyId: pty.pty.ptyId,
        rendererGraphEpoch: this.deps.rendererGraphEpoch(),
        ...expandTerminalInteractiveWait(await this.getTerminalInteractiveWait(handle))
      }
    }
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)
    const { leaf } = this.getLiveLeafForHandle(handle)
    const summary = this.buildTerminalSummary(leaf, worktreesById)
    const preview = leaf.ptyId
      ? await this.visibleSnapshotPreview(leaf.ptyId, summary.preview)
      : summary.preview
    this.assertStableReadyGraph(graphEpoch)
    if (leaf.ptyId) {
      this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    }
    return {
      ...summary,
      preview,
      paneRuntimeId: leaf.paneRuntimeId,
      ptyId: leaf.ptyId,
      rendererGraphEpoch: this.deps.rendererGraphEpoch(),
      ...expandTerminalInteractiveWait(await this.getTerminalInteractiveWait(handle))
    }
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    return this.deps.managedWorktrees().sleepTerminalsForWorktree(worktreeSelector)
  }

  async splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {}
  ): Promise<RuntimeTerminalSplit> {
    if (!this.deps.ptyController()?.spawn) {
      throw new Error('runtime_unavailable')
    }
    if (!pty.connected) {
      throw new Error('terminal_exited')
    }
    const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
    const parentTabId = pty.tabId?.trim()
    if (!parentTabId || !parsedPaneKey) {
      throw new Error('terminal_handle_stale')
    }
    const direction = opts.direction ?? 'horizontal'
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${pty.worktreeId}`)
    const sourceAuthority = this.resolveTerminalSplitSourceAuthority(
      workspace.id,
      parentTabId,
      parsedPaneKey.leafId,
      pty.ptyId
    )
    if (!sourceAuthority) {
      throw new Error('terminal_split_source_not_found')
    }
    const sourceIncarnationId =
      sourceAuthority.liveIncarnationId ?? sourceAuthority.persistedIncarnationId
    const leafId = randomUUID()
    const preAllocatedHandle = this.createPreAllocatedTerminalHandle()
    const paneKey = makePaneKey(parentTabId, leafId)
    const result = await this.deps.ptyController()!.spawn!({
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: this.buildTerminalWorkspaceEnv(workspace, opts.env ?? {}, paneKey, parentTabId),
      envToDelete: opts.envToDelete,
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: parentTabId,
      leafId,
      persistHostSessionBinding: true,
      ...(sourceAuthority.persisted
        ? {
            expectedSourceBinding: {
              ...(sourceAuthority.persistedWorktreeId
                ? { worktreeId: sourceAuthority.persistedWorktreeId }
                : {}),
              tabId: parentTabId,
              leafId: parsedPaneKey.leafId,
              ptyId: pty.ptyId,
              // Why: the store can only match its own persisted map, so a live-only id it never
              // recorded would reject every split from a session restored without incarnations.
              // The live id is fenced by revalidateSourceAuthority below instead.
              ...(sourceAuthority.persistedIncarnationId
                ? { incarnationId: sourceAuthority.persistedIncarnationId }
                : {})
            }
          }
        : {})
    })
    this.deps.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.deps.preparePtyExecutionContext(result.id, result.wslDistro ?? null, {})
    }
    this.deps.registerPty(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (createdPty) {
      createdPty.tabId = parentTabId
      createdPty.paneKey = paneKey
      createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
      this.deps.setPairedRendererSessionOwnership(
        createdPty.ptyId,
        this.deps.pairedRendererSessionOwnedPtyIds().has(pty.ptyId)
      )
    }

    const revealSplit = async (): Promise<void> => {
      await this.deps.notifier()?.revealTerminalSession?.(workspace.id, {
        ptyId: result.id,
        title: null,
        activate: opts.activate !== false,
        ...ownerSurfacing(opts.surfaceOwner !== false),
        tabId: parentTabId,
        leafId,
        splitFromLeafId: parsedPaneKey.leafId,
        splitDirection: direction,
        splitTelemetrySource: opts.telemetrySource
      })
    }

    try {
      const revalidateSourceAuthority = (): void => {
        const current = this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
        if (
          !current ||
          (sourceAuthority.persisted && !current.persisted) ||
          (sourceIncarnationId !== null &&
            (current.liveIncarnationId ?? current.persistedIncarnationId) !== sourceIncarnationId)
        ) {
          throw new Error('terminal_split_source_not_found')
        }
      }
      revalidateSourceAuthority()
      if (!sourceAuthority.persisted) {
        await revealSplit()
        // Why: rejecting here unmounts the pane the reveal just added only because the retire
        // below always emits its exit and the tab still holds the source sibling — the renderer's
        // exit handler closes non-final panes. Never close it by tabId: that drops the whole tab.
        revalidateSourceAuthority()
      }
      if (createdPty) {
        const persisted = this.persistHeadlessTerminalSplit({
          worktreeId: workspace.id,
          tabId: parentTabId,
          leafId,
          ptyId: createdPty.ptyId,
          splitFromLeafId: parsedPaneKey.leafId,
          direction
        })
        if (sourceAuthority.persisted && !persisted) {
          throw new Error('workspace_session_unavailable')
        }
        this.publishPtyBackedMobileSessionTerminal(workspace.id, createdPty, {
          tabId: parentTabId,
          leafId,
          title: null,
          activate: opts.activate !== false,
          split: { splitFromLeafId: parsedPaneKey.leafId, direction }
        })
      }
    } catch (error) {
      this.deps.setPairedRendererSessionOwnership(result.id, false)
      let stopped = false
      try {
        stopped =
          (await this.deps.ptyController()!.stopAndWait?.(result.id, {
            deadlineMs: Date.now() + REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS
          })) ?? false
      } catch {
        // Best-effort fallback below preserves the original split authority error.
      }
      if (!stopped) {
        try {
          this.deps.ptyController()!.kill(result.id)
        } catch {
          // Best-effort cleanup; retirement below still runs and the original error still throws.
        }
      }
      try {
        this.deps.ptyController()!.retireRejectedPty?.(result.id, stopped)
      } catch {
        // Best-effort cleanup; preserve the original split authority error.
      }
      throw error
    }
    const committedSourceAuthority = sourceAuthority.persisted
      ? this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
      : null
    if (sourceAuthority.persisted && committedSourceAuthority?.rendererMounted) {
      // Why: renderer adoption is a projection after the durable main commit; rejection cannot undo it.
      void revealSplit().catch(() => undefined)
    }

    return {
      handle: this.deps.issuePtyHandle(createdPty ?? pty),
      tabId: parentTabId,
      paneRuntimeId: -1
    }
  }

  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {}
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'

    // Snapshot current leaf keys so the post-split graph-sync delta reveals the new pane.
    const leafKeysBefore = new Set<string>()
    for (const [key, l] of this.deps.leaves()) {
      if (l.tabId === leaf.tabId) {
        leafKeysBefore.add(key)
      }
    }

    this.deps.notifier()?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      telemetrySource: opts.telemetrySource
    })

    const newHandle = await this.waitForNewLeafInTab(leaf.tabId, leafKeysBefore)
    return { handle: newHandle, tabId: leaf.tabId, paneRuntimeId: leaf.paneRuntimeId }
  }

  async stopExactTerminalsForWorktree(
    worktreeSelector: string,
    expectedPtyIds: readonly string[],
    opts: { keepHistory?: boolean; targetOnly?: boolean } = {}
  ): Promise<{
    stopped: number
    stoppedPtyIds: string[]
    livePtyIds: string[]
    postStopVerified: boolean
    postStopFailure?: string
    remainingLivePtyIds?: string[]
  }> {
    return this.deps
      .managedWorktrees()
      .stopExactTerminalsForWorktree(worktreeSelector, expectedPtyIds, opts)
  }

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: {
      deadline?: number
      stopPty?: (
        ptyId: string,
        stop: () => boolean | Promise<boolean>
      ) => Promise<{ stopped: boolean; owner: boolean }>
      /** Authoritative id for an orphan whose selector no longer resolves. */
      resolvedWorktreeId?: string
      resolvedConnectionId?: string
      resolvedRuntimeEnvironmentId?: string
    } = {}
  ): Promise<{ stopped: number }> {
    return this.deps.managedWorktrees().stopTerminalsForWorktree(worktreeSelector, options)
  }

  subscribeToFitOverrideChanges(
    ptyId: string,
    listener: (event: {
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }) => void
  ): () => void {
    return addListenerToMap(this.deps.fitOverrideListeners(), ptyId, listener)
  }

  subscribeToTerminalData(
    ptyId: string,
    listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
  ): () => void {
    return addListenerToMap(this.deps.dataListeners(), ptyId, listener)
  }

  subscribeToTerminalResize(
    ptyId: string,
    listener: (event: {
      cols: number
      rows: number
      displayMode: string
      reason: string
      seq?: number
    }) => void
  ): () => void {
    return addListenerToMap(this.deps.resizeListeners(), ptyId, listener)
  }

  async terminalHasShellForegroundProcess(handle: string, ptyId: string): Promise<boolean> {
    return this.deps.terminalAgentStatusBinding().terminalHasShellForegroundProcess(handle, ptyId)
  }

  toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined {
    if (!preferences) {
      return undefined
    }
    const options = {
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.effort ? { effort: preferences.effort } : {}),
      ...(preferences.mode ? { mode: preferences.mode } : {})
    }
    return Object.keys(options).length > 0 ? options : undefined
  }

  touchMobileSessionSnapshotsForPty(ptyId: string, options?: { immediate?: boolean }): void {
    return this.deps.mobileSessionFacade().touchMobileSessionSnapshotsForPty(ptyId, options)
  }

  trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): Promise<void> {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const completion = state.writeChain.then(async () => {
      // Why: the ingestion-time ownership decision is closed over this
      // chain link; async scheduling cannot retroactively change it.
      // Why inside the chain: the ownership mirror must observe live bytes in
      // the same total order as seeds (seedOwner also runs on this chain).
      state.ownership.scan(data)
      await state.emulator.write(data, { forwardQueryReplies })
      state.outputSequence = outputSequence
    })
    // Legacy callers remain best-effort; bounded SSH admission observes the raw receipt.
    state.writeChain = completion.catch(() => {})
    return completion
  }

  updateClientTerminalQuickCommands(
    mutation: TerminalQuickCommandMutation
  ): TerminalQuickCommand[] {
    if (!this.deps.store()?.getSettings || !this.requireStore().updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const current = this.getClientTerminalQuickCommands()
    if (
      mutation.type === 'upsert' &&
      !current.some((command) => command.id === mutation.command.id) &&
      current.length >= MAX_QUICK_COMMANDS
    ) {
      throw new Error('Quick command limit reached')
    }
    const next = applyTerminalQuickCommandMutation(current, mutation)
    this.requireStore().updateSettings({ terminalQuickCommands: next }, { notifyListeners: true })
    return this.getClientTerminalQuickCommands()
  }

  updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    return this.deps
      .ptyWorktrees()
      .updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
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
    return this.deps.mobileSessionFacade().updateMobileSessionPaneLayout(worktreeSelector, args)
  }

  async visibleSnapshotPreview(ptyId: string, preview: string): Promise<string> {
    return this.deps.mobileSessionFacade().visibleSnapshotPreview(ptyId, preview)
  }

  waitForMessage(
    handle: string,
    options?: {
      typeFilter?: string[]
      timeoutMs?: number
      signal?: AbortSignal
      exclusive?: boolean
    }
  ): Promise<MessageWaitResult> {
    return new Promise((resolve) => {
      const currentWaiters = this.deps.messageWaitersByHandle().get(handle)
      if (options?.exclusive && currentWaiters && currentWaiters.size > 0) {
        resolve('waiter_exists')
        return
      }
      const timeoutMs = options?.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS

      const waiter: MessageWaiter = {
        handle,
        typeFilter: options?.typeFilter,
        resolve,
        timeout: null,
        abortCleanup: null
      }

      // Why: on caller abort (RPC socket closed — design doc §3.1), resolve now to release the long-poll slot instead of waiting out timeoutMs.
      const signal = options?.signal
      const onAbort = (): void => {
        this.removeMessageWaiter(waiter)
        resolve('cancelled')
      }
      if (signal) {
        if (signal.aborted) {
          resolve('cancelled')
          return
        }
        waiter.abortCleanup = () => signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', onAbort, { once: true })
      }

      waiter.timeout = setTimeout(() => {
        this.removeMessageWaiter(waiter)
        resolve('timed_out')
      }, timeoutMs)

      let waiters = this.deps.messageWaitersByHandle().get(handle)
      if (!waiters) {
        waiters = new Set()
        this.deps.messageWaitersByHandle().set(handle, waiters)
      }
      waiters.add(waiter)
    })
  }

  waitForNewLeafInTab(
    tabId: string,
    existingLeafKeys: Set<string>,
    timeoutMs = 10_000
  ): Promise<string> {
    const tryResolve = (): string | null => {
      for (const [key, leaf] of this.deps.leaves()) {
        if (leaf.tabId === tabId && !existingLeafKeys.has(key) && leaf.ptyId !== null) {
          return this.issueHandle(leaf)
        }
      }
      return null
    }

    const existing = tryResolve()
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.deps.graphSyncCallbacks().indexOf(check)
        if (idx !== -1) {
          this.deps.graphSyncCallbacks().splice(idx, 1)
        }
        reject(new Error('Timed out waiting for split pane handle'))
      }, timeoutMs)

      const check = (): void => {
        const handle = tryResolve()
        if (handle) {
          clearTimeout(timer)
          const idx = this.deps.graphSyncCallbacks().indexOf(check)
          if (idx !== -1) {
            this.deps.graphSyncCallbacks().splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.deps.graphSyncCallbacks().push(check)
      check()
    })
  }

  waitForRendererTerminalSerializer(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return (
      this.deps
        .ptyController()
        ?.waitForRendererSerializer?.(ptyId, afterGeneration, timeoutMs, signal) ??
      Promise.resolve(false)
    )
  }

  async waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<RuntimeTerminalWait> {
    const condition = options?.condition ?? 'exit'
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (condition === 'exit' && !pty.pty.connected) {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      const ptyWaitText = buildTerminalWaitText(
        pty.pty.tailBuffer,
        pty.pty.tailPartialLine,
        pty.pty.preview
      )
      const ptyBlockedReason = detectTerminalWaitBlockedReason(ptyWaitText)
      if (condition === 'tui-idle' && ptyBlockedReason) {
        return buildPtyTerminalWaitBlockedResult(handle, condition, pty.pty, ptyBlockedReason)
      }
      if (condition === 'tui-idle' && pty.pty.lastAgentStatus === 'idle') {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      if (
        condition === 'tui-idle' &&
        (this.getAdoptedPtyExplicitIdleStatus(pty.pty) === 'idle' ||
          isKnownReadyPromptPreview(ptyWaitText))
      ) {
        return buildPtyTerminalWaitResult(handle, condition, pty.pty)
      }
      return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
        const effectiveTimeoutMs =
          typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : condition === 'tui-idle'
              ? TUI_IDLE_DEFAULT_TIMEOUT_MS
              : 0
        const waiter: TerminalWaiter = {
          handle,
          condition,
          resolve,
          reject,
          timeout: null,
          pollInterval: null,
          abortCleanup: null
        }
        if (!this.bindTerminalWaiterAbort(waiter, options?.signal)) {
          reject(new Error('request_aborted'))
          return
        }
        if (effectiveTimeoutMs > 0) {
          waiter.timeout = setTimeout(() => {
            this.removeWaiter(waiter)
            reject(new Error('timeout'))
          }, effectiveTimeoutMs)
        }
        let waiters = this.deps.waitersByHandle().get(handle)
        if (!waiters) {
          waiters = new Set()
          this.deps.waitersByHandle().set(handle, waiters)
        }
        waiters.add(waiter)
        const live = this.getLivePtyForHandle(handle)
        if (!live) {
          this.removeWaiter(waiter)
          reject(new Error('terminal_handle_stale'))
        } else if (condition === 'exit' && !live.pty.connected) {
          this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
        } else if (condition === 'tui-idle') {
          const livePtyWaitText = buildTerminalWaitText(
            live.pty.tailBuffer,
            live.pty.tailPartialLine,
            live.pty.preview
          )
          const blockedReason = detectTerminalWaitBlockedReason(livePtyWaitText)
          if (blockedReason) {
            this.resolveWaiter(
              waiter,
              buildPtyTerminalWaitBlockedResult(handle, condition, live.pty, blockedReason)
            )
          } else if (live.pty.lastAgentStatus === 'idle') {
            this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
          } else if (
            this.getAdoptedPtyExplicitIdleStatus(live.pty) === 'idle' ||
            isKnownReadyPromptPreview(livePtyWaitText)
          ) {
            this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, condition, live.pty))
          } else {
            this.startPtyTuiIdleFallbackPoll(waiter, live.pty, effectiveTimeoutMs)
          }
        }
      })
    }
    const { leaf } = this.getLiveLeafForHandle(handle)

    if (condition === 'exit' && getTerminalState(leaf) === 'exited') {
      return buildTerminalWaitResult(handle, condition, leaf)
    }

    const leafWaitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    const leafBlockedReason = detectTerminalWaitBlockedReason(leafWaitText)
    if (condition === 'tui-idle' && leafBlockedReason) {
      return buildTerminalWaitBlockedResult(handle, condition, leaf, leafBlockedReason)
    }

    // Why: if the agent already transitioned to idle (or permission) before the
    // waiter was registered, resolve immediately. This uses the same OSC title
    // detection that powers the renderer's "Task complete" notifications.
    // Why: only 'idle' satisfies tui-idle, not 'permission'. Permission means the
    // agent is blocked on user approval, not finished with its task.
    if (condition === 'tui-idle' && leaf.lastAgentStatus === 'idle') {
      return buildTerminalWaitResult(handle, condition, leaf)
    }
    if (condition === 'tui-idle') {
      const fastPathTitle = leaf.paneTitle ?? this.deps.tabs().get(leaf.tabId)?.title
      if (
        (fastPathTitle && detectExplicitIdleStatusFromTitle(fastPathTitle) === 'idle') ||
        isKnownReadyPromptPreview(leafWaitText)
      ) {
        return buildTerminalWaitResult(handle, condition, leaf)
      }
    }

    return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
      // Why: tui-idle depends on OSC title transitions from a recognized agent.
      // If no agent is detected, the waiter would hang forever. Enforce a default
      // timeout so unsupported CLIs fail predictably instead of silently blocking.
      const effectiveTimeoutMs =
        typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : condition === 'tui-idle'
            ? TUI_IDLE_DEFAULT_TIMEOUT_MS
            : 0

      const waiter: TerminalWaiter = {
        handle,
        condition,
        resolve,
        reject,
        timeout: null,
        pollInterval: null,
        abortCleanup: null
      }

      if (!this.bindTerminalWaiterAbort(waiter, options?.signal)) {
        reject(new Error('request_aborted'))
        return
      }

      if (effectiveTimeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(waiter)
          reject(new Error('timeout'))
        }, effectiveTimeoutMs)
      }

      let waiters = this.deps.waitersByHandle().get(handle)
      if (!waiters) {
        waiters = new Set()
        this.deps.waitersByHandle().set(handle, waiters)
      }
      waiters.add(waiter)

      // Why: the handle may go stale or exit in the small gap between the first
      // validation and waiter registration. Re-checking here keeps wait --for
      // exit honest instead of hanging on a terminal that already changed.
      try {
        const live = this.getLiveLeafForHandle(handle)
        if (getTerminalState(live.leaf) === 'exited') {
          this.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
        } else if (condition === 'tui-idle') {
          const liveLeafWaitText = buildTerminalWaitText(
            live.leaf.tailBuffer,
            live.leaf.tailPartialLine,
            live.leaf.preview
          )
          const blockedReason = detectTerminalWaitBlockedReason(liveLeafWaitText)
          if (blockedReason) {
            this.resolveWaiter(
              waiter,
              buildTerminalWaitBlockedResult(handle, condition, live.leaf, blockedReason)
            )
          } else if (live.leaf.lastAgentStatus === 'idle') {
            // Why: don't clear lastAgentStatus here. It's a factual record of the
            // last detected OSC state, not a one-shot signal. Clearing it causes
            // subsequent tui-idle waiters to hang even though the agent is idle —
            // the first waiter consumes the status and all later ones see null.
            this.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
          } else {
            // Why: renderer-synced previews can show a known ready prompt even
            // while the last OSC title is still "working"; keep polling the
            // preview/title until the waiter resolves or hits its timeout.
            const fastPathTitle =
              live.leaf.paneTitle ?? this.deps.tabs().get(live.leaf.tabId)?.title
            if (
              (fastPathTitle && detectExplicitIdleStatusFromTitle(fastPathTitle) === 'idle') ||
              isKnownReadyPromptPreview(liveLeafWaitText)
            ) {
              this.resolveWaiter(waiter, buildTerminalWaitResult(handle, condition, live.leaf))
            } else {
              this.startTuiIdleFallbackPoll(waiter, live.leaf, effectiveTimeoutMs)
            }
          }
        }
      } catch (error) {
        this.removeWaiter(waiter)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    return this.deps.ptyWorktrees().waitForTerminalHandle(tabId, timeoutMs)
  }

  async withVisibleSnapshotFallback(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { cursor?: number; limit?: number } = {},
    providerSnapshot: ProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    return this.deps
      .mobileSessionFacade()
      .withVisibleSnapshotFallback(ptyId, read, opts, providerSnapshot)
  }

  async writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      signal?: AbortSignal
    } = {}
  ): Promise<void> {
    // Why: the lease is checked before the mobile floor is reserved, so a refused send never takes
    // a claim it will not use.
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    // Why: direct terminal.send can carry paste-sized text from RPC/mobile
    // clients; chunk text before PTY/ConPTY while preserving suffix separation.
    const text = typeof action.text === 'string' ? action.text : ''
    const hasSuffix = action.enter || action.interrupt
    if (text) {
      await this.writeTerminalInputChunks(ptyId, text, options, admitted)
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      if (text) {
        // Why: same hazard as the agent-prompt path -- Enter must not overtake text the
        // execution host is still ingesting, and a flat 500 ms cannot cover 16 MB.
        await waitForAgentPromptDelay(
          getAgentPromptSubmitDelayMs(
            this.deps.getPtyWriteHostPlatform(ptyId),
            Buffer.byteLength(text, 'utf8')
          ),
          options.signal
        )
      }
      // Why: the 500ms text/suffix pause is long enough for a handoff to complete, so the submit
      // is re-checked against the fence the text was admitted under.
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      try {
        await options.beforeWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      options.reserveWrite?.(ptyId)
      const suffixWrote = this.deps.ptyController()?.write(ptyId, suffix) ?? false
      if (!suffixWrote) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      return
    }
    if (text) {
      return
    }

    await options.beforeWrite?.(ptyId)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    options.reserveWrite?.(ptyId)
    const wrote = this.deps.ptyController()?.write(ptyId, payload) ?? false
    if (!wrote) {
      throw new Error('terminal_not_writable')
    }
    await options.afterWrite?.(ptyId)
  }

  async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      signal?: AbortSignal
    } = {}
  ): Promise<number> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.deps.getAgentPromptActivity(handle, ptyId)
    this.deps.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    // Why: the floor for every wait below. Enter must never overtake bytes the execution
    // host is still feeding the child, and that cost is proportional to the payload.
    const writeHostPlatform = this.deps.getPtyWriteHostPlatform(ptyId)
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const renderGate = this.deps.createAgentPromptRenderGate(ptyId, pasteIngestMs)
    let wrotePasteBytes = false
    let completedPaste = false
    try {
      const chunks = iterateTerminalInputChunks(pastePayload)
      let chunk = chunks.next()
      let firstChunk = true
      while (!chunk.done) {
        const nextChunk = chunks.next()
        assertAgentPromptRequestActive(options.signal)
        this.assertAgentPromptGeneration(ptyId, generation)
        // Why: the first chunk was just admitted above; re-checking the lease there would only
        // re-read what `assertAdmitted` established.
        if (!firstChunk) {
          agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        }
        firstChunk = false
        await options.beforeWrite?.(ptyId)
        assertAgentPromptRequestActive(options.signal)
        this.assertAgentPromptGeneration(ptyId, generation)
        this.deps.assertAgentPromptPermissionSafe(
          permissionBaseline,
          this.deps.getAgentPromptActivity(handle, ptyId)
        )
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        if (nextChunk.done) {
          renderGate?.arm()
        }
        const wrote = this.deps.ptyController()?.write(ptyId, chunk.value) ?? false
        if (!wrote) {
          throw new Error('terminal_not_writable')
        }
        wrotePasteBytes = true
        chunk = nextChunk
        if (!chunk.done) {
          await yieldBetweenTerminalInputChunks()
        }
      }
      completedPaste = true
    } catch (error) {
      if (
        wrotePasteBytes &&
        !completedPaste &&
        this.getPtyLifecycleGeneration(ptyId) === generation
      ) {
        // Why: a lease that moved mid-paste also refuses this terminator, leaving the TUI in paste
        // mode — the incoming owner re-establishes the mode, and feeding a session we no longer own
        // is the worse outcome.
        try {
          agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
          this.deps.ptyController()?.write(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
        } catch {
          // The original refusal is the actionable error.
        }
      }
      renderGate?.dispose()
      throw error
    }

    if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), options.signal)
      } finally {
        renderGate.dispose()
      }
    } else {
      await waitForAgentPromptDelay(
        getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength),
        options.signal
      )
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    try {
      await options.beforeWrite?.(ptyId)
    } catch (error) {
      if (options.suffixFailureError) {
        throw new Error(options.suffixFailureError)
      }
      throw error
    }
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const waitTextCache: AgentPromptWaitTextCache = {}
    const baseline = this.deps.getAgentPromptActivity(handle, ptyId, waitTextCache)
    this.deps.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    const suffixWrote = this.deps.ptyController()?.write(ptyId, AGENT_PROMPT_SUBMIT) ?? false
    if (!suffixWrote) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
    await verifyAgentPromptSubmission({
      baseline,
      readActivity: () => this.deps.getAgentPromptActivity(handle, ptyId, waitTextCache),
      timeoutMs: resolveAgentPromptEffectTimeoutMs(this.deps.getPtyAgent(ptyId)),
      signal: options.signal
    })
    return 1
  }

  async writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
    } = {},
    admitted: AgentSessionPtyWriteAdmittance
  ): Promise<void> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    let firstChunk = true
    while (!chunk.done) {
      // Why: every inter-chunk yield is a window for a handoff to take the lease; the rest of a
      // paste must not land in a session this runtime no longer owns.
      if (!firstChunk) {
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      }
      firstChunk = false
      await options.beforeWrite?.(ptyId)
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      options.reserveWrite?.(ptyId)
      const wrote = this.deps.ptyController()?.write(ptyId, chunk.value) ?? false
      if (!wrote) {
        throw new Error('terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      chunk = chunks.next()
      if (!chunk.done) {
        await yieldBetweenTerminalInputChunks()
      }
    }
  }

  async writeTerminalPreviewInput(ptyId: string, data: string): Promise<boolean> {
    if (data.length === 0 || this.getDriver(ptyId).kind === 'mobile') {
      return false
    }
    try {
      await assertTerminalInputWithinLimitWithYield(data)
      const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
      await this.writeTerminalInputChunks(
        ptyId,
        data,
        {
          // Why: a phone can claim the floor while a paste yields between chunks.
          beforeWrite: () => {
            if (this.getDriver(ptyId).kind === 'mobile') {
              throw new Error('terminal_mobile_driver_active')
            }
          }
        },
        admitted
      )
      return true
    } catch {
      return false
    }
  }
}
