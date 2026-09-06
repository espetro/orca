/* eslint-disable max-lines -- Why: extracted PTY lifecycle cluster moved wholesale from the god class */
import type {
  TerminalWorkspaceLaunchScope,
  PtyControllerInventory,
  RuntimeTerminalDataMeta,
  ResolvedWorktree,
  DriverState,
  PtyIncarnationHandleRecord,
  TerminalHandleRecord,
  RuntimeHeadlessTerminal,
  LayoutQueueEntry,
  PtyLayoutState,
  RuntimeLeafRecord,
  MessageWaiter,
  RuntimeNotifier,
  RuntimePtyWorktreeRecord,
  ProviderBufferAcquisition,
  RuntimeVisibleTerminalState,
  TrackedPtyLivenessVerdict,
  LegacyWorkerTerminalRecoveryResult,
  LegacyWorkerTerminalRecoveryResolution,
  OrchestrationCompatibilityTerminalAuthority,
  RuntimeStore,
  TerminalWaiter,
  RuntimePtyController,
  RuntimePtyDataAdmission,
  RuntimePtyTitleTrackerEntry,
  MessageWaitResult
} from './orca-runtime'
import {
  beginPtyRegistration,
  cancelPendingPtyRegistration,
  markPtyStopRequested
} from './orca-runtime'
import {
  EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS,
  MAX_TRACKED_PTY_LIVENESS_VERDICTS
} from './runtime-terminal-surface-shared'

type RuntimePtyRecord = OrcaRuntimeService['ptysById'] extends Map<string, infer T> ? T : never

import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import type { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import type { AgentStatus } from '../../shared/agent-detection'
import type { OrcaRuntimeLivenessVerdictApi } from './runtime-liveness-verdict'
import {
  isLeafPtyProvenAbsent as probeLeafPtyAbsence,
  isPtyStopRequested as checkPtyStopRequested
} from './runtime-liveness-verdict'

import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { extractOscTitleScanTail } from '../../shared/osc-title-scan-tail'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../shared/pty-liveness-verdict'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeTerminalCreate,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult,
  RuntimeTerminalRead,
  RuntimeTerminalSummary,
  RuntimeTerminalWait
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { StructuredTuiOwner } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  probeAgentSessionProcessIdentity
} from './agent-session-process-identity-probe'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { OrchestrationDb } from './orchestration/db'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import {
  classifyWorkerTerminalProcessIncarnation,
  parseWorkerTerminalHostScope
} from './orchestration/worker-terminal-process-liveness'
import { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'
import type { RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import type { RuntimeManagedWorktrees } from './runtime-managed-worktrees'
import {
  PTY_CONTROLLER_LIST_TIMEOUT_MS,
  appendCompletedTerminalTranscript,
  appendNormalizedToTailBuffer,
  buildPreview,
  buildTerminalWaitText,
  classifyAgentTitle,
  classifyLatestAgentTitle,
  computeTerminalTailWaitState,
  detectExplicitIdleStatusFromTitle,
  getLatestAgentCandidateTitle,
  getLatestPtyTitle,
  getPtyTerminalState,
  getTerminalState,
  isKnownReadyPromptPreview,
  normalizeTerminalChunk,
  ptyTitleProvesAgentPresence,
  readTerminalTail,
  tailGainedNewerBlockedReason,
  tailStateMatches,
  withTimeoutResult
} from './runtime-tail-projection'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'
import { isNativeWindowsConptyPty } from './terminal-model-query-authority'
import { getTerminalViewAttributes } from './terminal-view-attribute-store'
import { RuntimePtyExitPipeline } from './runtime-pty-exit-pipeline'
import { RuntimePtyIncarnationRegistry } from './runtime-pty-incarnation-registry'
import { RuntimePtyWaiterQueue } from './runtime-pty-waiter-queue'
import { RuntimePtyLegacyWorkerRecovery } from './runtime-pty-legacy-worker-recovery'

export type RuntimePtyWorktreesDeps = {
  adoptTerminalOrphansFromInventory: (
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ) => Promise<RuntimeTerminalOrphanAdoptionResult>
  agentPromptExplicitStatusFloorByPtyId: () => Map<string, number>
  agentPromptLifecycleByPtyId: () => Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >
  agentPromptPermissionSequenceByPtyId: () => Map<string, number>
  agentStatusOscProcessorsByPtyId: () => Map<string, (data: string) => ProcessedAgentStatusChunk>
  assertGraphReady: () => void
  cancelPendingDriverMutations: (ptyId: string) => void
  claudeAgentTeams: () => ClaudeAgentTeamsService
  clearAgentRowSnapshotsForPty: (ptyId: string) => void
  clearWaitBlockedCheckState: (ptyId: string) => void
  dataListeners: () => Map<string, Set<(data: string, meta?: RuntimeTerminalDataMeta) => void>>
  disposeHeadlessTerminal: (ptyId: string) => void
  disposePtyTitleTracker: () => (ptyId: string) => void
  earlyExitedPtyIncarnations: () => Map<string, string | null>
  emitTerminalAgentStatusEvents: (ptyId: string, chunk: ProcessedAgentStatusChunk) => boolean
  ensurePtyBackedMobileSurfaceForRendererTab: (
    worktreeId: string,
    tabId: string
  ) => RuntimeMobileSessionCreateTerminalResult | null
  failActiveDispatchOnExit: (
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ) => void
  flushPendingTerminalSideEffectFacts: (ptyId: string, entry: RuntimePtyTitleTrackerEntry) => void
  flushWorkspaceSessionOrThrowAsync: () => Promise<void>
  folderWorkspaceToResolvedWorktree: (folderWorkspace: FolderWorkspace) => ResolvedWorktree
  freshSubscribeGuard: () => Set<string>
  getDriver: (ptyId: string) => DriverState
  getLeafKey: (tabId: string, leafId: string) => string
  getMobileSessionTabsForWorktree: (
    worktreeId: string,
    clientNavigationId?: string
  ) => RuntimeMobileSessionTabsResult
  getMobileTerminalPaneKey: (tab: RuntimeMobileSessionTerminalTab) => string
  getOrCreatePtyTitleTrackerEntry: () => (ptyId: string) => {
    applyingChunk: boolean
    chunkTouchedSessionTabs: boolean
    pendingFacts: unknown[]
    tracker: {
      handleChunk: (data: string, meta?: unknown) => void
      getLastNormalizedTitle?: () => string | null
    }
    commandCodeDetector?: { observe: (data: string) => void }
  }
  getOrchestrationDb: () => OrchestrationDb
  getRendererTerminalSerializerGeneration: (ptyId: string) => number
  getWorkspaceSessionHostIdForWorktree: (worktreeId: string) => ExecutionHostId
  graphStatus: () => RuntimeGraphStatus
  graphSyncCallbacks: () => (() => void)[]
  handleByLeafKey: () => Map<string, string>
  handleByPtyId: () => Map<string, string>
  handleByPtyIncarnation: () => Map<string, PtyIncarnationHandleRecord>
  handles: () => Map<string, TerminalHandleRecord>
  headlessTerminals: () => Map<string, RuntimeHeadlessTerminal>
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
  intentionalHandlelessPtyStops: () => Map<string, string | null>
  isRecognizedForegroundAgentProcess: (
    ptyId: string,
    foregroundProcess: string,
    options: { suppressClaude?: boolean; retryWrappers?: boolean }
  ) => Promise<boolean>
  isRemoteDesktopResizeDriven: (ptyId: string) => boolean
  layoutQueues: () => Map<string, LayoutQueueEntry>
  layouts: () => Map<string, PtyLayoutState>
  leaves: () => Map<string, RuntimeLeafRecord>
  leavesByPtyId: () => Map<string, RuntimeLeafRecord[]>
  legacyWorkerRecoveredPtys: () => Set<string>
  legacyWorkerTerminalRecoveryRetries: () => Map<
    string,
    {
      attempt: number
      connectionId?: string
      materializeRenderer: boolean
      timer: ReturnType<typeof setTimeout> | null
    }
  >
  makeRuntimePaneKey: (
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ) => string
  managedWorktrees: () => RuntimeManagedWorktrees
  maybeHydrateHeadlessFromRenderer: (ptyId: string) => void
  messageWaitersByHandle: () => Map<string, Set<MessageWaiter>>
  mobileSessionTabsByWorktree: () => Map<string, RuntimeMobileSessionTabsSnapshot>
  mobileTabSnapshots: () => RuntimeMobileSessionTabSnapshotCommands
  notifier: () => RuntimeNotifier | null
  notifyMobileSessionTabsChanged: (worktreeId?: string) => void
  osc7ScanTailByPtyId: () => Map<string, string>
  oscTitleScanTailByPtyId: () => Map<string, string>
  pairedRendererSessionOwnedPtyIds: () => Set<string>
  pathFlavorForPty: () => (pty?: RuntimePtyWorktreeRecord | null) => 'posix' | 'win32'
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
  processAgentStatusOscForPty: (ptyId: string, data: string) => ProcessedAgentStatusChunk
  providerBufferAcquisitionsByPtyId: () => Map<string, ProviderBufferAcquisition>
  providerModeSnapshotScansByPtyId: () => Map<string, Set<TerminalKittyKeyboardModeTracker>>
  providerModeTrackersByPtyId: () => Map<string, TerminalKittyKeyboardModeTracker>
  providerSequenceInitializedPtys: () => Set<string>
  providerSequenceOffsetByPtyId: () => Map<string, number>
  providerSnapshotPreferredPtys: () => Set<string>
  providerVisibleRetryAtByPtyId: () => Map<string, number>
  providerVisibleStateByPtyId: () => Map<string, RuntimeVisibleTerminalState>
  ptyExitListenersByPtyId: () => Map<string, Set<() => void>>
  ptyExit_notifyTabAndMobile: (
    pty: RuntimePtyRecord | null,
    ptyId: string,
    exitIncarnationId: PtyIncarnationId | undefined,
    exitCode: number,
    exitCause: TerminalExitCause,
    preservesAbnormalSshSurface: boolean,
    preservesIntentionalHandlessSurface: boolean,
    exactSurfaces: Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[],
    incarnationId: PtyIncarnationId
  ) => { handle: string; paneKey: string | null }[]
  ptyLifecycleGenerationById: () => Map<string, number>
  ptyLivenessObservationSequence: () => number
  livenessApi: () => OrcaRuntimeLivenessVerdictApi
  setPtyLivenessObservationSequence: (value: number) => void
  ptyLivenessVerdictByPtyId: () => Map<string, TrackedPtyLivenessVerdict>
  ptyOutputSequenceById: () => Map<string, number>
  ptysById: () => Map<string, RuntimePtyWorktreeRecord>
  recentPtyOutputById: () => Map<string, RecentPtyOutputBuffer>
  recentPtyPathCandidatesById: () => Map<string, string[]>
  reconcileAgentStatusForEndedProcessFn: () => ((paneKeys: Iterable<string>) => void) | null
  reconcileLegacyWorkerTerminalsNow: (options: {
    connectionId?: string
    materializeRenderer?: boolean
  }) => Promise<LegacyWorkerTerminalRecoveryResult>
  recordOsc7MetadataForPty: () => (
    ptyId: string,
    data: string
  ) => { cwd: string | null; cwdChanged: boolean }
  recordRecentPtyOutputForPathProvenance: (ptyId: string, data: string) => void
  refreshPtyForegroundAgent: () => (ptyId: string) => void
  rendererGraphEpoch: () => number
  replaceHeadlessTerminalAfterExecutionContextChange: (ptyId: string) => void
  resetTrackedTerminalStateForProviderGeneration: () => (ptyId: string) => void
  resolvePaneAgentIdentityField: (
    launchAgent: TuiAgent | null | undefined,
    foregroundAgent: TuiAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ) => { agentIdentity?: TuiAgent }
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  restoreAgentPromptLifecycleByteOrder: (
    ptyId: string,
    titleInput: string,
    lastPayloadTitleOffset: number | null
  ) => void
  restoredOrchestrationAuthorityByPtyId: () => Map<
    string,
    Readonly<{
      ptyId: string
      worktreeId: string
      terminalHandle: string
      paneKey: string
      processIncarnation: string
      hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
    }>
  >
  retireAgentHookCompatibilityAuthorityFn: () => ((paneKey: string) => void) | null
  retireOrchestrationMailboxDeliveryForPty: (ptyId: string) => void
  runtimeId: () => `${string}-${string}-${string}-${string}-${string}`
  scheduleWaitBlockedCheck: (ptyId: string, appendedText: string, at: number) => void
  setupCompletionTokenByPtyId: () => Map<string, string>
  shouldAnswerQueriesForLiveChunk: (ptyId: string) => boolean
  snapshotValueComparison: () => RuntimeMobileSnapshotValueComparisonCommands
  spawnPublishedPtys: () => Set<string>
  stopRequestedPtyIds: () => Set<string>
  store: () => RuntimeStore | null
  subscriberDrivenProviderAttachInventoryWaiters: () => Set<string>
  subscriberDrivenProviderAttachesByPtyId: () => Map<string, Promise<boolean>>
  syntheticTerminalHandles: () => Set<string>
  tabs: () => Map<string, RuntimeSyncedTab>
  terminalCwdByPtyId: () => Map<string, string>
  terminalExecutionHostField: (
    ptyId: string | null,
    worktreeId: string
  ) => { executionHostId?: ExecutionHostId }
  terminalFileUriHostnameByPtyId: () => Map<string, string>
  terminalSpawnCommandsByPtyId: () => Map<string, string>
  trackHeadlessTerminalData: (
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies
  ) => Promise<void>
  tryGetWorkspaceSessionHostIdForWorktree: (worktreeId: string) => ExecutionHostId | null
  waitersByHandle: () => Map<string, Set<TerminalWaiter>>
  wslDistroByPtyId: () => Map<string, string>
  reconcileLegacyWorkerTerminals: (options: {
    connectionId?: string
    materializeRenderer?: boolean
  }) => Promise<LegacyWorkerTerminalRecoveryResult>
  nextPtyLifecycleGeneration: () => number
  setNextPtyLifecycleGeneration: (value: number) => void
  ptyController: () => RuntimePtyController | null
  setPtyControllerRef: (controller: RuntimePtyController | null) => void
}

export class RuntimePtyWorktrees {
  readonly provenAbsentLeafPtyVerdicts = new Map<string, number>()
  readonly leafPtyAbsenceProbes = new Map<string, Promise<boolean>>()
  private readonly deps: RuntimePtyWorktreesDeps
  private readonly exitPipeline: RuntimePtyExitPipeline
  private readonly incarnationRegistry: RuntimePtyIncarnationRegistry
  private readonly waiterQueue: RuntimePtyWaiterQueue
  private readonly legacyWorkerRecovery: RuntimePtyLegacyWorkerRecovery

  constructor(deps: RuntimePtyWorktreesDeps) {
    this.deps = deps
    this.exitPipeline = new RuntimePtyExitPipeline(this, deps)
    this.incarnationRegistry = new RuntimePtyIncarnationRegistry(this, deps)
    this.waiterQueue = new RuntimePtyWaiterQueue(this, deps)
    this.legacyWorkerRecovery = new RuntimePtyLegacyWorkerRecovery(this, deps)
  }

  acceptPtyDataBounded(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false,
    sourceRanges?: readonly TerminalOutputSourceRange[]
  ): RuntimePtyDataAdmission {
    let completion: Promise<void> | null = null
    const sequence = this.onPtyData(
      ptyId,
      data,
      at,
      sequenceChars,
      transformed,
      (receipt) => {
        completion = receipt
      },
      sourceRanges
    )
    if (!completion) {
      throw new Error('PTY model admission receipt was not captured')
    }
    return Object.freeze({ sequence, completion })
  }

  acceptPtyIncarnationForExit(ptyId: string, incarnationId: PtyIncarnationId): void {
    const pty = this.deps.ptysById().get(ptyId)
    if (pty) {
      // Why: a reconnect attach reply can prove the exit generation after stale local proof was cleared.
      pty.incarnationId = incarnationId
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    return this.deps.managedWorktrees().acquireWorktreeTerminalSpawn(worktreeId)
  }

  adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    return this.incarnationRegistry.adoptControllerTerminalHandle(
      ptyId,
      handle,
      incarnationId,
      options
    )
  }

  adoptFirstPtyForLeafHandle(
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    return this.incarnationRegistry.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    return this.incarnationRegistry.adoptPreAllocatedHandle(leaf)
  }

  armLegacyWorkerTerminalRecoveryRetry(
    scopeKey: string,
    retry: {
      attempt: number
      connectionId?: string
      materializeRenderer: boolean
      timer: ReturnType<typeof setTimeout> | null
    }
  ): void {
    return this.legacyWorkerRecovery.armLegacyWorkerTerminalRecoveryRetry(scopeKey, retry)
  }

  bindPtyIncarnationHandle(retained: PtyIncarnationHandleRecord, leaf: RuntimeLeafRecord): void {
    return this.incarnationRegistry.bindPtyIncarnationHandle(retained, leaf)
  }

  bindTerminalWaiterAbort(waiter: TerminalWaiter, signal: AbortSignal | undefined): boolean {
    return this.waiterQueue.bindTerminalWaiterAbort(waiter, signal)
  }

  cancelLegacyWorkerTerminalRecoveryRetry(scopeKey: string): void {
    return this.legacyWorkerRecovery.cancelLegacyWorkerTerminalRecoveryRetry(scopeKey)
  }

  cancelMessageWaiters(handle: string): void {
    return this.waiterQueue.cancelMessageWaiters(handle)
  }

  clearPtyIncarnationHandles(): void {
    return this.incarnationRegistry.clearPtyIncarnationHandles()
  }

  collectPaneKeysForPty(ptyId: string): Set<string> {
    return this.exitPipeline.collectPaneKeysForPty(ptyId)
  }

  createPreAllocatedTerminalHandle(): string {
    return this.incarnationRegistry.createPreAllocatedTerminalHandle()
  }

  findHandleForPtyRecord(ptyId: string): string | null {
    return this.incarnationRegistry.findHandleForPtyRecord(ptyId)
  }

  getLegacyWorkerTerminalRecoveryPlan(): LegacyWorkerTerminalRecoveryPlan {
    return this.legacyWorkerRecovery.getLegacyWorkerTerminalRecoveryPlan()
  }

  invalidateAllHandlesForPty(ptyId: string): void {
    return this.incarnationRegistry.invalidateAllHandlesForPty(ptyId)
  }

  invalidateLeafHandle(leafKey: string): void {
    return this.incarnationRegistry.invalidateLeafHandle(leafKey)
  }

  invalidatePtyIncarnationHandle(ptyId: string): void {
    return this.incarnationRegistry.invalidatePtyIncarnationHandle(ptyId)
  }

  isTerminalHandleAdoptionBlocked(ptyId: string, handle: string): boolean {
    return this.incarnationRegistry.isTerminalHandleAdoptionBlocked(ptyId, handle)
  }

  issueHandle(leaf: RuntimeLeafRecord): string {
    return this.incarnationRegistry.issueHandle(leaf)
  }

  issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    return this.incarnationRegistry.issuePtyHandle(pty)
  }

  issueStructuredTuiPtyHandle(pty: RuntimePtyWorktreeRecord): string {
    return this.incarnationRegistry.issueStructuredTuiPtyHandle(pty)
  }

  notifyPtyExitListeners(ptyId: string): void {
    return this.exitPipeline.notifyPtyExitListeners(ptyId)
  }

  onPtyExit(
    ptyId: string,
    exitCode: number,
    exitIncarnationId?: PtyIncarnationId,
    options?: {
      hostExitConfirmed?: boolean
      cause?: TerminalExitCause
      providerExitObserved?: boolean
    }
  ): void {
    return this.exitPipeline.onPtyExit(ptyId, exitCode, exitIncarnationId, options)
  }

  async persistLegacyWorkerTerminalRecoveryBatch(
    resolutions: readonly LegacyWorkerTerminalRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    return this.legacyWorkerRecovery.persistLegacyWorkerTerminalRecoveryBatch(resolutions)
  }

  preAllocateHandleForPty(ptyId: string): string {
    return this.incarnationRegistry.preAllocateHandleForPty(ptyId)
  }

  prepareLegacyWorkerTerminalRecovery(): LegacyWorkerTerminalRecoveryPlan {
    return this.legacyWorkerRecovery.prepareLegacyWorkerTerminalRecovery()
  }

  pruneDisconnectedPtyRecords(): void {
    return this.exitPipeline.pruneDisconnectedPtyRecords()
  }

  ptyExit_cleanupLeaves(
    pty: RuntimePtyRecord | null,
    ptyId: string
  ): Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[] {
    return this.exitPipeline.ptyExit_cleanupLeaves(pty, ptyId)
  }

  ptyExit_collectExitPaneKeys(
    _pty: RuntimePtyRecord | null,
    ptyId: string,
    exitCode: number,
    options?: { hostExitConfirmed?: boolean; providerExitObserved?: boolean },
    preservesAbnormalSshSurface?: boolean
  ): void {
    return this.exitPipeline.ptyExit_collectExitPaneKeys(
      _pty,
      ptyId,
      exitCode,
      options,
      preservesAbnormalSshSurface
    )
  }

  ptyExit_decideSshSurface(
    pty: RuntimePtyRecord | null,
    ptyId: string,
    exitCode: number,
    options?: { hostExitConfirmed?: boolean }
  ): {
    preservesAbnormalSshSurface: boolean
    preservesIntentionalHandlessSurface: boolean
    incarnationId: PtyIncarnationId
  } {
    return this.exitPipeline.ptyExit_decideSshSurface(pty, ptyId, exitCode, options)
  }

  ptyExit_guardIncarnation(
    ptyId: string,
    exitIncarnationId?: PtyIncarnationId
  ): RuntimePtyRecord | null {
    return this.exitPipeline.ptyExit_guardIncarnation(ptyId, exitIncarnationId)
  }

  ptyExit_releaseLayout(ptyId: string): void {
    return this.exitPipeline.ptyExit_releaseLayout(ptyId)
  }

  ptyExit_resolveExitCause(
    ptyId: string,
    exitCode: number,
    cause?: TerminalExitCause
  ): { exitCause: TerminalExitCause; stopNeverConfirmed: boolean } {
    return this.exitPipeline.ptyExit_resolveExitCause(ptyId, exitCode, cause)
  }

  ptyExit_settleDispatch(
    _ptyId: string,
    exitCode: number,
    exitCause: TerminalExitCause,
    preservesAbnormalSshSurface: boolean,
    exitedSurfaces: { handle: string; paneKey: string | null }[]
  ): void {
    return this.exitPipeline.ptyExit_settleDispatch(
      _ptyId,
      exitCode,
      exitCause,
      preservesAbnormalSshSurface,
      exitedSurfaces
    )
  }

  ptyExit_teardown(_ptyId: string): void {
    return this.exitPipeline.ptyExit_teardown(_ptyId)
  }

  ptyExit_updateLivenessVerdict(ptyId: string, preservesAbnormalSshSurface: boolean): void {
    return this.exitPipeline.ptyExit_updateLivenessVerdict(ptyId, preservesAbnormalSshSurface)
  }

  reconcileMissingLegacyWorkerTerminal(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): boolean {
    return this.legacyWorkerRecovery.reconcileMissingLegacyWorkerTerminal(candidate)
  }

  reconcilePtyIncarnationHandles(): void {
    return this.incarnationRegistry.reconcilePtyIncarnationHandles()
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    return this.incarnationRegistry.registerPreAllocatedHandleForPty(ptyId, handle)
  }

  rejectAllWaiters(code: string): void {
    return this.waiterQueue.rejectAllWaiters(code)
  }

  rejectWaitersForHandle(handle: string, code: string): void {
    return this.waiterQueue.rejectWaitersForHandle(handle, code)
  }

  removeMessageWaiter(waiter: MessageWaiter): void {
    return this.waiterQueue.removeMessageWaiter(waiter)
  }

  removeWaiter(waiter: TerminalWaiter): void {
    return this.waiterQueue.removeWaiter(waiter)
  }

  replaceSyntheticTerminalHandlesForRestoredPty(ptyId: string, controllerHandle: string): boolean {
    return this.incarnationRegistry.replaceSyntheticTerminalHandlesForRestoredPty(
      ptyId,
      controllerHandle
    )
  }

  resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    return this.waiterQueue.resolveExitWaiters(leaf)
  }

  resolveHandleForTab(tabId: string): string | null {
    return this.waiterQueue.resolveHandleForTab(tabId)
  }

  resolveMessageWaiter(waiter: MessageWaiter, result: MessageWaitResult): void {
    return this.waiterQueue.resolveMessageWaiter(waiter, result)
  }

  resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    return this.waiterQueue.resolvePtyExitWaiters(pty, ptyId)
  }

  resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    return this.waiterQueue.resolveTuiIdleWaiters(leaf)
  }

  resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    return this.waiterQueue.resolveWaiter(waiter, result)
  }

  rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    return this.legacyWorkerRecovery.rollbackLegacyWorkerTerminalSurface(candidate)
  }

  updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    return this.legacyWorkerRecovery.updateLegacyWorkerTerminalRecoveryRetry(
      plan,
      deferredDispatchIds,
      options
    )
  }

  waitForLeafPtyId(handle: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    return this.waiterQueue.waitForLeafPtyId(handle, timeoutMs, signal)
  }

  waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    return this.waiterQueue.waitForTerminalHandle(tabId, timeoutMs)
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    if (request.claims.length === 0) {
      throw new Error('terminal_orphan_claims_required')
    }
    const workspace = await this.deps.resolveTerminalWorkspaceLaunchScope(request.worktree)
    const resolvedWorkspace = workspace.folderWorkspace
      ? this.deps.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
      : await this.deps.resolveWorktreeSelector(`id:${workspace.id}`)
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [resolvedWorkspace],
      workspace.id,
      undefined,
      workspace.connectionId ?? null
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
    return this.deps.adoptTerminalOrphansFromInventory(request, workspace, inventory)
  }

  advancePtyLifecycleGeneration(ptyId: string): void {
    this.deps.ptyLifecycleGenerationById().set(
      ptyId,
      (() => {
        const v = this.deps.nextPtyLifecycleGeneration()
        this.deps.setNextPtyLifecycleGeneration(v + 1)
        return v
      })()
    )
    // Why: a stop whose exit never arrived would otherwise stay armed across a
    // same-id respawn and label the NEXT process's crash an operator close —
    // the exact lie this cause model exists to remove.
    this.deps.stopRequestedPtyIds().delete(ptyId)
    this.deps.agentPromptLifecycleByPtyId().delete(ptyId)
    this.deps.agentPromptPermissionSequenceByPtyId().delete(ptyId)
    this.deps.agentPromptExplicitStatusFloorByPtyId().set(ptyId, Date.now())
    this.deps.legacyWorkerRecoveredPtys().delete(ptyId)
    // Why: a respawn under the same session id needs its own subscriber-driven attach.
    this.deps.subscriberDrivenProviderAttachesByPtyId().delete(ptyId)
    this.deps.subscriberDrivenProviderAttachInventoryWaiters().delete(ptyId)
    this.deps.spawnPublishedPtys().delete(ptyId)
    // Why: a provider response belongs to the process generation that issued
    // it; a respawn must neither reuse its frame nor join its in-flight call.
    this.deps.providerBufferAcquisitionsByPtyId().delete(ptyId)
    this.deps.providerVisibleStateByPtyId().delete(ptyId)
    this.deps.providerVisibleRetryAtByPtyId().delete(ptyId)
  }

  assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      if (runtimePty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_handle_stale')
      }
      return
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (leaf.ptyId !== expectedPtyId) {
      throw new Error('terminal_handle_stale')
    }
  }

  assertPtyDidNotExitBeforeRegistration(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    if (this.deps.earlyExitedPtyIncarnations().has(ptyId)) {
      const exitedIncarnation = this.deps.earlyExitedPtyIncarnations().get(ptyId) ?? null
      const nextIncarnation = candidateIncarnation ?? null
      if (
        exitedIncarnation === null ||
        nextIncarnation === null ||
        exitedIncarnation === nextIncarnation
      ) {
        throw new Error('agent_session_exited_during_start')
      }
      this.deps.earlyExitedPtyIncarnations().delete(ptyId)
    }
  }

  assertPtyRegistrationAllowed(ptyId: string, incarnationId?: PtyIncarnationId): void {
    // Why: the controller must reject an early exit before persisting bindings or handles.
    this.assertPtyDidNotExitBeforeRegistration(ptyId, incarnationId)
  }

  beginPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    return beginPtyRegistration(
      ptyId,
      incarnationId,
      this as unknown as OrcaRuntimeLivenessVerdictApi
    )
  }

  buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(pty.worktreeId)
    const title = getLatestPtyTitle(pty)

    const pane = parsePaneKey(pty.paneKey ?? '')
    const orphaned = !pty.tabId || !pane || pane.tabId !== pty.tabId
    return {
      handle: this.issuePtyHandle(pty),
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      orphaned,
      worktreeId: pty.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: orphaned ? `pty:${pty.ptyId}` : pty.tabId!,
      leafId: orphaned ? `pty:${pty.ptyId}` : pane.leafId,
      title,
      connected: pty.connected,
      writable: pty.connected,
      lastOutputAt: pty.lastOutputAt,
      preview: pty.preview,
      ...(pty.lastExitCause ? { exitCause: pty.lastExitCause } : {}),
      ...this.deps.terminalExecutionHostField(pty.ptyId, pty.worktreeId),
      ...this.deps.resolvePaneAgentIdentityField(
        pty.launchAgent,
        pty.foregroundAgent,
        title,
        pty.paneKey ?? null
      )
    }
  }

  cancelPendingPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    return cancelPendingPtyRegistration(
      ptyId,
      incarnationId,
      this as unknown as OrcaRuntimeLivenessVerdictApi
    )
  }

  controllerKnowsPtyIsLive(ptyId: string): boolean {
    try {
      return this.deps.ptyController()?.hasPty?.(ptyId) === true
    } catch {
      // Why: liveness lookup failures are doubt; doubt never gates a write.
      return false
    }
  }

  createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number }
  ): RuntimeHeadlessTerminal {
    let state: RuntimeHeadlessTerminal | null = null
    const pathFlavor = this.deps.pathFlavorForPty()(this.deps.ptysById().get(ptyId))
    const emulator = new HeadlessEmulator({
      cols: dims.cols,
      rows: dims.rows,
      pathFlavor,
      remotePosixFileUriAuthority:
        !!this.deps.ptysById().get(ptyId)?.connectionId && pathFlavor !== 'win32',
      wslDistro: this.deps.ptysById().get(ptyId)?.connectionId
        ? undefined
        : (this.deps.wslDistroByPtyId().get(ptyId) ??
          this.deps.ptysById().get(ptyId)?.wslDistro ??
          undefined),
      // Why: replies take the provider input path (same entry as pty:write —
      // daemon shell-ready gating and the SSH relay write apply unchanged),
      // NOT writePtyInput, so renderer interactive-output metering never
      // counts responder traffic as user-input echo.
      onQueryReply: (reply) => {
        // Why the identity check: queued writeChain links can parse after
        // disposeHeadlessTerminal, and daemon respawns reuse session ids — a
        // stale link's reply must never reach a successor PTY under this id.
        if (state !== null && this.deps.headlessTerminals().get(ptyId) === state) {
          if (
            !shouldForwardHeadlessTerminalQueryReply(
              this.deps.ptysById().get(ptyId)?.launchAgent,
              reply
            )
          ) {
            return
          }
          // Why this write is safe pre-shell-ready: daemon Session.write
          // QUEUES (never drops) input while the POSIX shell-ready gate is
          // pending and flushes at the ready marker or the 15s
          // SHELL_READY_TIMEOUT_MS bound (session.ts) — a spawn-time query
          // reply is delayed at most that bound, not lost.
          this.deps.ptyController()?.write(ptyId, reply)
        }
      }
    })
    if (isNativeWindowsConptyPty(ptyId)) {
      emulator.installConptyPrimaryDeviceAttributesOverride()
    }
    // Why the lazy getter: replies must use the freshest renderer push at
    // parse time, and stay silent (never default) before the first push.
    emulator.installViewAttributeResponder(() => getTerminalViewAttributes())
    const viewAttributes = getTerminalViewAttributes()
    if (viewAttributes) {
      emulator.applyPushedViewAttributes(viewAttributes)
    }
    const constructed: RuntimeHeadlessTerminal = {
      emulator,
      outputSequence: 0,
      writeChain: Promise.resolve(),
      ownership: new PtyShellOwnershipMirror(async () => {
        const controller = this.deps.ptyController()
        const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
        if (
          !controller?.confirmShellForeground ||
          this.deps.headlessTerminals().get(ptyId) !== constructed
        ) {
          return false
        }
        const confirmed = await controller.confirmShellForeground(ptyId)
        return (
          confirmed &&
          this.deps.headlessTerminals().get(ptyId) === constructed &&
          this.getPtyLifecycleGeneration(ptyId) === lifecycleGeneration
        )
      })
    }
    state = constructed
    return state
  }

  dropDisconnectedPtyRecord(ptyId: string): void {
    // Why: pruning can remove a PTY without the normal exit callback.
    this.advancePtyLifecycleGeneration(ptyId)
    this.deps.pairedRendererSessionOwnedPtyIds().delete(ptyId)
    this.deps.ptysById().delete(ptyId)
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
    this.deps.agentStatusOscProcessorsByPtyId().delete(ptyId)
    this.deps.terminalSpawnCommandsByPtyId().delete(ptyId)
    this.deps.disposePtyTitleTracker()(ptyId)
    this.invalidatePtyIncarnationHandle(ptyId)
    this.deps.oscTitleScanTailByPtyId().delete(ptyId)
    this.deps.osc7ScanTailByPtyId().delete(ptyId)
    this.deps.terminalCwdByPtyId().delete(ptyId)
    this.deps.terminalFileUriHostnameByPtyId().delete(ptyId)
    this.deps.wslDistroByPtyId().delete(ptyId)
    this.deps.clearAgentRowSnapshotsForPty(ptyId)
    const handle = this.deps.handleByPtyId().get(ptyId)
    if (handle) {
      // Why: pruning can remove a PTY without onPtyExit firing; release this leader's agent team so it doesn't leak.
      this.deps.claudeAgentTeams().removeTeamForLeaderHandle(handle)
      this.deps.handleByPtyId().delete(ptyId)
      this.deps.syntheticTerminalHandles().delete(handle)
      const record = this.deps.handles().get(handle)
      if (record?.tabId.startsWith('pty:')) {
        this.deps.handles().delete(handle)
      }
    }
  }

  findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null {
    for (const pty of this.deps.ptysById().values()) {
      if (
        pty.worktreeId === worktreeId &&
        pty.tabId === tabId &&
        pty.connected &&
        parsePaneKey(pty.paneKey ?? '')?.leafId
      ) {
        return pty
      }
    }
    return null
  }

  forgetPtyLivenessVerdict(ptyId: string, observedNoLaterThan?: number): void {
    const tracked = this.deps.ptyLivenessVerdictByPtyId().get(ptyId)
    if (observedNoLaterThan !== undefined && tracked && tracked.observedAt > observedNoLaterThan) {
      return
    }
    this.deps.ptyLivenessVerdictByPtyId().delete(ptyId)
  }

  getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    for (const leaf of this.deps.leaves().values()) {
      if (leaf.ptyId !== pty.ptyId) {
        continue
      }
      const title = leaf.paneTitle ?? this.deps.tabs().get(leaf.tabId)?.title
      if (!title) {
        continue
      }
      const status = detectExplicitIdleStatusFromTitle(title)
      if (status !== null) {
        return status
      }
    }
    return null
  }

  getLeavesForPty(ptyId: string): RuntimeLeafRecord[] {
    return this.deps.leavesByPtyId().get(ptyId) ?? []
  }

  getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.deps.assertGraphReady()
    const record = this.deps.handles().get(handle)
    if (!record || record.runtimeId !== this.deps.runtimeId()) {
      throw new Error('terminal_handle_stale')
    }
    if (record.rendererGraphEpoch !== this.deps.rendererGraphEpoch()) {
      throw new Error('terminal_handle_stale')
    }

    const leaf = this.deps.leaves().get(this.deps.getLeafKey(record.tabId, record.leafId))
    if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
      throw new Error('terminal_handle_stale')
    }
    return { record, leaf }
  }

  getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    let record = this.deps.handles().get(handle)
    if (!record) {
      const ptyId = [...this.deps.handleByPtyId().entries()].find(
        ([, mappedHandle]) => mappedHandle === handle
      )?.[0]
      const pty = ptyId ? this.deps.ptysById().get(ptyId) : null
      if (pty) {
        // Why: graph reload clears renderer handle records, but runtime-owned PTY handles remain the caller's control identity.
        this.issuePtyHandle(pty)
        record = this.deps.handles().get(handle)
      }
    }
    if (!record || record.runtimeId !== this.deps.runtimeId() || !record.tabId.startsWith('pty:')) {
      return null
    }
    if (!record.ptyId) {
      return null
    }
    const pty = this.deps.ptysById().get(record.ptyId)
    if (!pty || pty.ptyId !== record.ptyId) {
      return null
    }
    // Why: renderer adoption can race with CLI reads; keep ptyId → handle populated so summaries don't mint a second handle for the same terminal.
    this.deps.handleByPtyId().set(record.ptyId, handle)
    return { record, pty }
  }

  getLivePtyIdsForWorktree(worktreeId: string, freshPtyIds?: ReadonlySet<string>): Set<string> {
    return this.deps.managedWorktrees().getLivePtyIdsForWorktree(worktreeId, freshPtyIds)
  }

  getMobileSessionWorktreeIdsForPty(ptyId: string): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- facade type revision lacks the param
    return (this.deps.managedWorktrees() as any).getMobileSessionWorktreeIdsForPty(ptyId)
  }

  getMobileTerminalLeafPtyIds(tab: RuntimeMobileSessionTerminalTab): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- command class lacks the member at this type revision
    return (this.deps.mobileTabSnapshots() as any).getMobileTerminalLeafPtyIds(tab)
  }

  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    return this.deps.managedWorktrees().getOrCreatePtyWorktreeRecord(ptyId)
  }

  getPrimaryLeafForPty(ptyId: string): RuntimeLeafRecord | null {
    return this.getLeavesForPty(ptyId)[0] ?? null
  }

  getPtyAgent(ptyId: string): TuiAgent | null {
    const pty = this.deps.ptysById().get(ptyId)
    return pty?.launchAgent ?? pty?.foregroundAgent ?? null
  }

  getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform'> {
    if (!ptyId) {
      return {}
    }
    const pty = this.deps.ptysById().get(ptyId)
    if (!pty) {
      return {}
    }
    if (pty.connectionId) {
      const remotePlatform = getRegisteredSshState(pty.connectionId)?.remotePlatform
      return {
        executionHostId: toSshExecutionHostId(pty.connectionId),
        ...(remotePlatform ? { hostPlatform: remotePlatform } : {})
      }
    }
    return {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      hostPlatform: pty.isWsl || pty.wslDistro ? 'linux' : process.platform
    }
  }

  getPtyIdsForExplicitTabClose(worktreeId: string, tabId: string): string[] {
    const ptyIds = new Set<string>()
    for (const pty of this.deps.ptysById().values()) {
      if (pty.connected && pty.worktreeId === worktreeId && pty.tabId === tabId) {
        ptyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.deps.leaves().values()) {
      if (leaf.worktreeId === worktreeId && leaf.tabId === tabId && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }
    return [...ptyIds]
  }

  getPtyLifecycleGeneration(ptyId: string): number {
    const existing = this.deps.ptyLifecycleGenerationById().get(ptyId)
    if (existing !== undefined) {
      return existing
    }
    const generation = (() => {
      const v = this.deps.nextPtyLifecycleGeneration()
      this.deps.setNextPtyLifecycleGeneration(v + 1)
      return v
    })()
    this.deps.ptyLifecycleGenerationById().set(ptyId, generation)
    return generation
  }

  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null {
    return this.deps.ptyLivenessVerdictByPtyId().get(ptyId)?.verdict ?? null
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.deps.ptyOutputSequenceById().get(ptyId) ?? 0
  }

  getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    const pty = this.deps.ptysById().get(ptyId)
    const connectionId = pty?.connectionId
    if (!connectionId) {
      return process.platform
    }
    const remotePlatform = getRegisteredSshState(connectionId)?.remotePlatform
    if (remotePlatform) {
      return remotePlatform
    }
    // Why: remotePlatform only arrives with the relay handshake; until then the worktree path
    // flavor is the same signal getAgentLaunchPlatformForRepo already trusts for a remote repo.
    const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
  }

  getRendererTerminalSerializerGenerationForHandle(handle: string): number {
    const ptyId = this.deps.handles().get(handle)?.ptyId
    return ptyId ? this.deps.getRendererTerminalSerializerGeneration(ptyId) : 0
  }

  getTerminalHandlesForPtyId(ptyId: string): string[] {
    const handles = new Set(
      this.getLeavesForPty(ptyId)
        .filter((candidate) => candidate.connected)
        .map((leaf) => this.issueHandle(leaf))
    )
    const runtimeHandle = this.deps.handleByPtyId().get(ptyId)
    if (runtimeHandle) {
      handles.add(runtimeHandle)
    }
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (!pty) {
      throw Object.assign(new Error('terminal_worktree_sleep_handle_unavailable'), { ptyId })
    }
    if (handles.size === 0) {
      handles.add(this.issuePtyHandle(pty))
    }
    return [...handles].sort()
  }

  getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null {
    const record = this.getLivePtyForHandle(handle)?.record ?? this.deps.handles().get(handle)
    return record?.ptyId ? this.getPtyLivenessVerdict(record.ptyId) : null
  }

  getTerminalOrphanAdoptionSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {})
    return this.deps.getMobileSessionTabsForWorktree(worktreeId)
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    const live = this.getLivePtyForHandle(handle)
    const record = live?.record ?? this.deps.handles().get(handle)
    if (!record?.ptyId) {
      return null
    }
    const incarnationId =
      live?.pty.incarnationId ?? this.deps.ptysById().get(record.ptyId)?.incarnationId
    if (incarnationId) {
      return `${record.ptyId}:${incarnationId}`
    }
    // Why: legacy providers may omit process incarnation; retain the prior restart-degraded fence.
    return `${this.deps.runtimeId()}:${record.ptyId}:${record.ptyGeneration}`
  }

  getWorktreeIdForTerminalHandle(handle: string): string | null {
    return this.deps.managedWorktrees().getWorktreeIdForTerminalHandle(handle)
  }

  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'> {
    const hostScope = parseWorkerTerminalHostScope(serializedHostScope)
    const ptyController = this.deps.ptyController()
    if (!hostScope || !ptyController?.listProcesses) {
      return 'unverifiable'
    }
    const listed = await withTimeoutResult(
      ptyController.listProcesses(hostScope.kind === 'ssh' ? hostScope.targetId : null),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      return 'unverifiable'
    }
    return classifyWorkerTerminalProcessIncarnation(processIncarnation, listed.value)
  }

  isKnownUnattachedLocalDaemonPty(ptyId: string): boolean {
    if (
      this.deps.headlessTerminals().has(ptyId) ||
      this.deps.providerSnapshotPreferredPtys().has(ptyId)
    ) {
      return false
    }
    // A spawn published (or admission pending) this generation already
    // attaches the provider stream; a replacement under a reused id must not
    // read as the discovered never-attached session it replaced.
    if (
      this.deps.spawnPublishedPtys().has(ptyId) ||
      this.deps.pendingPtyRegistrationIncarnations().has(ptyId)
    ) {
      return false
    }
    // SSH panes have their own lease/reattach machinery.
    if (parseAppSshPtyId(ptyId)) {
      return false
    }
    const pty = this.deps.ptysById().get(ptyId)
    return pty !== undefined && pty.connectionId === null && pty.connected
  }

  isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    return probeLeafPtyAbsence(ptyId, this.deps.livenessApi())
  }

  isPtyKnownExited(ptyId: string): boolean {
    const pty = this.deps.ptysById().get(ptyId)
    if (pty) {
      // Why: `!connected` is an inference, not proof. The liveness sweep clears it with no
      // exit code for every PTY of a dropped relay, so reading that as an exit retires the
      // lease of a process still running on the host — 'unknown' must keep watching.
      return getPtyTerminalState(pty) === 'exited'
    }
    return this.getLeavesForPty(ptyId).some((leaf) => getTerminalState(leaf) === 'exited')
  }

  isPtyResizeDrivenRemotely(ptyId: string): boolean {
    if (this.deps.getDriver(ptyId).kind === 'mobile') {
      return true
    }
    return this.deps.isRemoteDesktopResizeDriven(ptyId)
  }

  async isPtyRunningAgent(
    pty: RuntimePtyWorktreeRecord,
    leaf: RuntimeLeafRecord | null = null,
    options: { retryForegroundWrappers?: boolean } = {}
  ): Promise<boolean> {
    const leafTitle = leaf
      ? getLatestAgentCandidateTitle(
          { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
          { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
        )
      : null
    const leafTitleClassification = classifyAgentTitle(leafTitle)
    if (ptyTitleProvesAgentPresence(pty, leafTitle, leafTitleClassification)) {
      return true
    }
    const ptyTitle = getLatestAgentCandidateTitle(
      { title: pty.title, updatedAt: pty.titleUpdatedAt },
      { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
    )
    const ptyTitleClassification = classifyAgentTitle(ptyTitle)
    if (leafTitle === null && ptyTitleProvesAgentPresence(pty, ptyTitle, ptyTitleClassification)) {
      return true
    }
    const managementTitleClassification = classifyLatestAgentTitle({
      title: pty.managementTitle,
      updatedAt: pty.managementTitleAt
    })
    const openCodeMarkerTitle = leafTitle ?? ptyTitle
    if (isOpenCodeNativeTitle(openCodeMarkerTitle) && pty.launchAgent === 'opencode') {
      return true
    }
    const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    if (!isOpenCodeNativeTitle(openCodeMarkerTitle) && isKnownReadyPromptPreview(waitText)) {
      return true
    }
    // Why: stale status is a fallback only when no current title evidence exists; neutral titles (shells) clear it.
    if (
      pty.lastAgentStatus !== null &&
      leafTitle === null &&
      ptyTitle === null &&
      managementTitleClassification !== 'management'
    ) {
      return true
    }
    if (!this.deps.ptyController()) {
      return false
    }
    const fg = await this.deps.ptyController()?.getForegroundProcess(pty.ptyId)
    // Why: mirrors the leaf path — an unreadable foreground is indistinguishable from an
    // exited one, so a bare Cursor identity title never substitutes for corroboration.
    if (!fg) {
      return false
    }
    const shouldSuppressClaudeForeground =
      leafTitle !== null
        ? leafTitleClassification === 'management'
        : managementTitleClassification === 'management'
    if (shouldSuppressClaudeForeground && isExpectedAgentProcess(fg, 'claude')) {
      return false
    }
    // Why: review-note delivery auto-submits with Enter, so only known agent processes are safe (not arbitrary focused TUIs).
    return await this.deps.isRecognizedForegroundAgentProcess(pty.ptyId, fg, {
      suppressClaude: shouldSuppressClaudeForeground,
      retryWrappers: options.retryForegroundWrappers !== false
    })
  }

  isPtyStopRequested(ptyId: string): boolean {
    return checkPtyStopRequested(ptyId, this.deps.livenessApi())
  }

  isServeOrSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return this.isServeOwnedPtyId(ptyId) || this.isSshOwnedPtyId(ptyId)
  }

  isServeOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && ptyId.startsWith('serve-')
  }

  isSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return this.deps.snapshotValueComparison().isSshOwnedPtyId(ptyId)
  }

  leafExistsForPty(ptyId: string): boolean {
    return (this.deps.leavesByPtyId().get(ptyId)?.length ?? 0) > 0
  }

  markPtyLivenessLive(ptyId: string): void {
    this.rememberPtyLivenessVerdict(ptyId, { status: 'live', ptyIds: [ptyId] })
  }

  markPtyLivenessUnverifiable(ptyId: string, reason: string): void {
    this.rememberPtyLivenessVerdict(ptyId, { status: 'unverifiable', reason })
  }

  markPtyStopRequested(ptyId: string): void {
    return markPtyStopRequested(ptyId, this as unknown as OrcaRuntimeLivenessVerdictApi)
  }

  notePtyDataGap(ptyId: string, droppedChars = 0): void {
    if (droppedChars > 0) {
      // Why: the daemon snapshot's seq counts bytes its monitoring stream
      // dropped. Advancing without parsing preserves that absolute domain so
      // post-snapshot live chunks can be reconciled instead of duplicated.
      const outputSequence = (this.deps.ptyOutputSequenceById().get(ptyId) ?? 0) + droppedChars
      this.deps.ptyOutputSequenceById().set(ptyId, outputSequence)
    }
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      pty.tailPendingAnsi = ''
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.tailPendingAnsi = ''
    }
    this.deps.oscTitleScanTailByPtyId().delete(ptyId)
    this.deps.osc7ScanTailByPtyId().delete(ptyId)
    this.deps.agentStatusOscProcessorsByPtyId().delete(ptyId)
    this.deps.disposeHeadlessTerminal(ptyId)
  }

  onPtyData(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false,
    captureModelReceipt?: (completion: Promise<void>) => void,
    sourceRanges?: readonly TerminalOutputSourceRange[]
  ): number {
    const outputSequence = (this.deps.ptyOutputSequenceById().get(ptyId) ?? 0) + sequenceChars
    this.deps.ptyOutputSequenceById().set(ptyId, outputSequence)
    this.deps.providerModeTrackersByPtyId().get(ptyId)?.scan(data)
    for (const tracker of this.deps.providerModeSnapshotScansByPtyId().get(ptyId) ?? []) {
      tracker.scan(data)
    }
    const osc7Metadata = this.deps.recordOsc7MetadataForPty()(ptyId, data)
    const cwd = osc7Metadata.cwd
    const cwdChanged = osc7Metadata.cwdChanged
    const agentStatusChunk = this.deps.processAgentStatusOscForPty(ptyId, data)
    this.deps.recordRecentPtyOutputForPathProvenance(ptyId, data)
    // Why: watch terminal output for advertised dev-server URLs (e.g. Vite's
    // `Network: https://local.example.com:3001/`) so the workspace ports
    // panel can surface them in place of the kernel bind address.
    advertisedUrlWatcher.ingest(ptyId, data, at)
    // Why: reply ownership is captured per chunk, here at ingestion — the
    // same module state and tick as the hidden-gate drop sites — and rides
    // the writeChain link. A mark/setting/subscriber flip before the queued
    // emulator write runs must not change who answers (terminal-query-
    // authority.md invariant 1).
    const forwardQueryReplies = this.deps.shouldAnswerQueriesForLiveChunk(ptyId)
    // Ordering invariant (DO NOT REORDER): maybeHydrateHeadlessFromRenderer
    // MUST run before trackHeadlessTerminalData so the eager-state pattern
    // (set headlessTerminals + writeChain head = seedPromise) is in place
    // before the live byte's chain link is queued. Without this ordering,
    // trackHeadlessTerminalData would lazy-create a fresh state at PTY dims
    // that the later seed-resolve would overwrite, dropping the live byte.
    // See docs/mobile-prefer-renderer-scrollback.md.
    this.deps.maybeHydrateHeadlessFromRenderer(ptyId)
    // Our structure wins: OSC title/agent-status extraction runs through the
    // shared per-PTY title tracker below (getOrCreatePtyTitleTrackerEntry →
    // applyTrackedPtyTitle) in byte order, superseding main's inline
    // extractLastOscTitleForPty block (#7880/#7852 title/status semantics are
    // preserved via the tracker + detectAgentStatusFromTitle path).
    const modelCompletion = this.deps.trackHeadlessTerminalData(
      ptyId,
      data,
      outputSequence,
      forwardQueryReplies
    )
    captureModelReceipt?.(modelCompletion)

    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    const ptyTailBefore = pty
      ? {
          lines: pty.tailBuffer,
          transcriptLines: pty.tailTranscriptBuffer,
          partialLine: pty.tailPartialLine,
          pendingAnsi: pty.tailPendingAnsi,
          redrawCursor: pty.tailRedrawCursor,
          truncated: pty.tailTruncated,
          linesTotal: pty.tailLinesTotal
        }
      : null
    let ptyTailAfter: ReturnType<typeof appendNormalizedToTailBuffer> | null = null
    if (pty) {
      pty.connected = true
      pty.disconnectedAt = null
      pty.lastOutputAt = at
      const normalized = normalizeTerminalChunk(data, pty.tailPendingAnsi)
      pty.tailPendingAnsi = normalized.pendingAnsi
      const nextTail = appendNormalizedToTailBuffer(
        pty.tailBuffer,
        pty.tailPartialLine,
        normalized.text,
        pty.tailRedrawCursor
      )
      ptyTailAfter = nextTail
      const nextTranscript = appendCompletedTerminalTranscript(
        pty.tailTranscriptBuffer,
        pty.tailTranscriptChars,
        nextTail.newlyCompletedLines,
        nextTail.newCompleteLines
      )
      pty.tailBuffer = nextTail.lines
      pty.tailTranscriptBuffer = nextTranscript.lines
      pty.tailTranscriptChars = nextTranscript.characters
      pty.tailPartialLine = nextTail.partialLine
      pty.tailRedrawCursor = nextTail.redrawCursor
      pty.tailTruncated = pty.tailTruncated || nextTail.truncated || nextTranscript.truncated
      pty.tailLinesTotal += nextTail.newCompleteLines
      pty.preview = buildPreview(pty.tailBuffer, pty.tailPartialLine)
      this.deps.scheduleWaitBlockedCheck(ptyId, normalized.text, at)
    }

    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.recordPtyWorktree(ptyId, leaf.worktreeId, {
        connected: true,
        lastOutputAt: pty?.lastOutputAt ?? at,
        preview: pty?.preview ?? leaf.preview,
        tabId: leaf.tabId,
        paneKey: this.deps.makeRuntimePaneKey(leaf)
      })
      leaf.connected = true
      leaf.writable = this.deps.graphStatus() === 'ready'
      leaf.lastOutputAt = at
      if (
        pty &&
        ptyTailBefore &&
        ptyTailAfter &&
        tailStateMatches(
          leaf.tailBuffer,
          leaf.tailTranscriptBuffer,
          leaf.tailPartialLine,
          leaf.tailPendingAnsi,
          leaf.tailRedrawCursor,
          leaf.tailTruncated,
          leaf.tailLinesTotal,
          ptyTailBefore
        )
      ) {
        // Why: the leaf and PTY record usually mirror the same terminal. Reuse
        // the PTY tail update instead of splitting large output twice.
        leaf.tailBuffer = pty.tailBuffer
        leaf.tailTranscriptBuffer = pty.tailTranscriptBuffer
        leaf.tailTranscriptChars = pty.tailTranscriptChars
        leaf.tailPartialLine = pty.tailPartialLine
        leaf.tailPendingAnsi = pty.tailPendingAnsi
        leaf.tailRedrawCursor = pty.tailRedrawCursor
        leaf.tailTruncated = pty.tailTruncated
        leaf.tailLinesTotal = pty.tailLinesTotal
        leaf.preview = pty.preview
        leaf.waitBlockedAt = pty.waitBlockedAt
        // Why undefined on this branch: the PTY record's wait scan is throttled
        // (scheduleWaitBlockedCheck), so pty.tailWaitState is never populated;
        // copying it here intentionally invalidates the leaf cache and the
        // mismatch branch below recomputes an exact state on its next chunk.
        leaf.tailWaitState = pty.tailWaitState
      } else {
        const normalized = normalizeTerminalChunk(data, leaf.tailPendingAnsi)
        leaf.tailPendingAnsi = normalized.pendingAnsi
        const previousWaitState =
          leaf.tailWaitState?.fromTail === true
            ? leaf.tailWaitState
            : computeTerminalTailWaitState(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
        const nextTail = appendNormalizedToTailBuffer(
          leaf.tailBuffer,
          leaf.tailPartialLine,
          normalized.text,
          leaf.tailRedrawCursor
        )
        const nextTranscript = appendCompletedTerminalTranscript(
          leaf.tailTranscriptBuffer,
          leaf.tailTranscriptChars,
          nextTail.newlyCompletedLines,
          nextTail.newCompleteLines
        )
        const nextWaitState = computeTerminalTailWaitState(
          nextTail.lines,
          nextTail.partialLine,
          leaf.preview
        )
        if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, normalized.text)) {
          leaf.waitBlockedAt = at
        }
        leaf.tailWaitState = nextWaitState
        leaf.tailBuffer = nextTail.lines
        leaf.tailTranscriptBuffer = nextTranscript.lines
        leaf.tailTranscriptChars = nextTranscript.characters
        leaf.tailPartialLine = nextTail.partialLine
        leaf.tailRedrawCursor = nextTail.redrawCursor
        leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated || nextTranscript.truncated
        leaf.tailLinesTotal += nextTail.newCompleteLines
        leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)
      }
    }

    // Why: feed the chunk's OSC titles through the shared per-PTY tracker in
    // byte order — the same ordering the renderer transport uses — so
    // coalesced working→idle transitions reach tui-idle waiters and
    // pending-message delivery instead of being masked by the chunk's last
    // title (issue #1083). Uses the OSC 9999-stripped cleanData like the
    // renderer, so pure status chunks don't perturb the stale-title probe.
    const titleTrackerEntry = this.deps.getOrCreatePtyTitleTrackerEntry()(ptyId)
    const previousTitleScanTail = this.deps.oscTitleScanTailByPtyId().get(ptyId)
    const titleInput = previousTitleScanTail
      ? `${previousTitleScanTail}${agentStatusChunk.cleanData}`
      : agentStatusChunk.cleanData
    const nextTitleScanTail = extractOscTitleScanTail(titleInput)
    if (nextTitleScanTail.length > 0) {
      this.deps.oscTitleScanTailByPtyId().set(ptyId, nextTitleScanTail)
    } else {
      this.deps.oscTitleScanTailByPtyId().delete(ptyId)
    }
    titleTrackerEntry.applyingChunk = true
    titleTrackerEntry.chunkTouchedSessionTabs = false
    let retainedAgentStatusChanged = false
    try {
      for (const payload of agentStatusChunk.payloads) {
        titleTrackerEntry.pendingFacts.push({ kind: 'agent-status', payload })
      }
      titleTrackerEntry.tracker.handleChunk(agentStatusChunk.cleanData, {
        titleScanData: titleInput
      })
      // Why: the Command Code scrape rides the same per-chunk batch (its facts
      // trail the tracker's). cleanData keeps OSC 9999 payloads out of the
      // detector's bounded recent-text window; the detector strips remaining
      // control sequences itself, exactly like the renderer byte path.
      titleTrackerEntry.commandCodeDetector?.observe(agentStatusChunk.cleanData)
    } finally {
      titleTrackerEntry.applyingChunk = false
      try {
        // Why: per-chunk cross-channel contract order is status → titles →
        // bell — the chunk's agentStatus:set events must reach the renderer
        // before its pty:sideEffect batch.
        retainedAgentStatusChanged = this.deps.emitTerminalAgentStatusEvents(
          ptyId,
          agentStatusChunk
        )
        const lastPayloadTitleOffset =
          agentStatusChunk.lastPayloadCleanOffset === null
            ? null
            : (previousTitleScanTail?.length ?? 0) + agentStatusChunk.lastPayloadCleanOffset
        this.deps.restoreAgentPromptLifecycleByteOrder(ptyId, titleInput, lastPayloadTitleOffset)
      } finally {
        // Why: flushed in the finally so a throwing tracker callback cannot
        // strand this chunk's facts to be emitted under the next chunk's seq.
        this.deps.flushPendingTerminalSideEffectFacts(
          ptyId,
          titleTrackerEntry as Parameters<typeof this.deps.flushPendingTerminalSideEffectFacts>[1]
        )
      }
    }
    // Why: hook (OSC 9999) transitions often arrive without a title change, so
    // headless-serve snapshots would never republish and paired remote clients
    // kept the stale agent state until the next title change (#7970).
    if (titleTrackerEntry.chunkTouchedSessionTabs || retainedAgentStatusChanged) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }

    const listeners = this.deps.dataListeners().get(ptyId)
    if (listeners) {
      const meta = {
        seq: outputSequence,
        rawLength: sequenceChars,
        ...(transformed ? { transformed: true } : {}),
        ...(cwdChanged && cwd !== null ? { cwd } : {}),
        ...(sourceRanges && sourceRanges.length > 0 ? { sourceRanges } : {})
      }
      for (const listener of listeners) {
        try {
          listener(data, meta)
        } catch (error) {
          // Why: inlined rather than via notifyRuntimeListeners to avoid a per-chunk closure
          // allocation on the terminal-output hot path; isolation semantics match the helper.
          console.error('[runtime] pty-data listener threw', error)
        }
      }
    }
    return outputSequence
  }

  onPtySpawned(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    options: { awaitsRegistration?: boolean } = {}
  ): void {
    this.forgetPtyLivenessVerdict(ptyId)
    if (options.awaitsRegistration !== false) {
      // Why: surface absence cannot distinguish an in-flight admission from a completed headless lifecycle.
      this.deps.pendingPtyRegistrationIncarnations().set(ptyId, incarnationId ?? null)
    }
    this.deps.spawnPublishedPtys().add(ptyId)
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      if (incarnationId) {
        pty.incarnationId = incarnationId
      }
      pty.connected = true
      pty.disconnectedAt = null
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.connected = true
      leaf.writable = this.deps.graphStatus() === 'ready'
      this.adoptPreAllocatedHandle(leaf)
    }
  }

  preparePtyExecutionContext(
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean } = {}
  ): boolean {
    const pty = this.deps.ptysById().get(ptyId)
    const hadExistingContext = this.deps.wslDistroByPtyId().has(ptyId) || pty !== undefined
    if (options.preserveExisting && hadExistingContext) {
      // Why: attach-time settings are only a fallback; a live PTY's recorded
      // execution namespace remains authoritative until its provider replies.
      return false
    }

    if (options.resetIncarnation) {
      // Why: an explicit new lifecycle supersedes an unidentifiable exit from the reused PTY id.
      this.deps.earlyExitedPtyIncarnations().delete(ptyId)
      this.deps.disposeHeadlessTerminal(ptyId)
      this.deps.osc7ScanTailByPtyId().delete(ptyId)
      this.deps.terminalCwdByPtyId().delete(ptyId)
      this.deps.terminalFileUriHostnameByPtyId().delete(ptyId)
      this.deps.wslDistroByPtyId().delete(ptyId)
    }

    const previous = this.deps.wslDistroByPtyId().get(ptyId) ?? null
    if (wslDistro) {
      this.deps.wslDistroByPtyId().set(ptyId, wslDistro)
    } else {
      this.deps.wslDistroByPtyId().delete(ptyId)
    }
    if (pty) {
      pty.wslDistro = wslDistro
    }
    if (
      !options.resetIncarnation &&
      previous !== wslDistro &&
      this.deps.headlessTerminals().has(ptyId)
    ) {
      // Why: bytes parsed with two distro namespaces would leave an internally
      // inconsistent CWD; rebuild from the provider's authoritative snapshot.
      this.deps.terminalCwdByPtyId().delete(ptyId)
      this.deps.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
    }
    return options.resetIncarnation === true || !hadExistingContext || previous !== wslDistro
  }

  async proveRecoveredStructuredTuiPtyProcess(
    pty: RuntimePtyWorktreeRecord,
    identity: NonNullable<AgentSessionRecord['lease']['ownerProcess']>,
    provider: 'codex' | 'claude' = 'codex'
  ): Promise<boolean> {
    const listings = await this.deps.ptyController()?.listProcesses?.(pty.connectionId)
    const listed = listings?.find(
      (candidate) => candidate.id === pty.ptyId && candidate.incarnationId === pty.incarnationId
    )
    if (!listed?.rootProcessId || identity.processStartTimeMs === null) {
      console.warn('[structured-tui-recovery] claimed PTY process mismatch', {
        ptyId: pty.ptyId,
        incarnationId: pty.incarnationId,
        rootProcessId: listed?.rootProcessId ?? null,
        mismatchedFields: [
          ...(!listed?.rootProcessId ? ['root-process-id'] : []),
          ...(identity.processStartTimeMs === null ? ['persisted-process-start-time'] : [])
        ]
      })
      return false
    }
    try {
      const observed = await readStructuredTuiProcessIdentity({
        hostId: identity.hostId,
        rootPid: listed.rootProcessId,
        spawnToken: identity.spawnToken,
        agent: provider
      })
      const matched = {
        hostId: observed.hostId === identity.hostId,
        pid: observed.pid === identity.pid,
        processStartTime:
          observed.processStartTimeMs !== null &&
          Math.abs(observed.processStartTimeMs - identity.processStartTimeMs) <=
            PROCESS_START_TIME_TOLERANCE_MS
      }
      if (!Object.values(matched).every(Boolean)) {
        console.warn('[structured-tui-recovery] claimed PTY process mismatch', {
          ptyId: pty.ptyId,
          incarnationId: pty.incarnationId,
          rootProcessId: listed.rootProcessId,
          persisted: {
            hostId: identity.hostId,
            pid: identity.pid,
            processStartTimeMs: identity.processStartTimeMs
          },
          observed: {
            hostId: observed.hostId,
            pid: observed.pid,
            processStartTimeMs: observed.processStartTimeMs
          },
          mismatchedFields: Object.entries(matched)
            .filter(([, matches]) => !matches)
            .map(([field]) => field)
        })
      }
      return Object.values(matched).every(Boolean)
    } catch (error) {
      console.warn('[structured-tui-recovery] claimed PTY process mismatch', {
        ptyId: pty.ptyId,
        incarnationId: pty.incarnationId,
        rootProcessId: listed.rootProcessId,
        mismatchedFields: [`${provider}-child-proof`],
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  pruneDisconnectedPtyTranscript(pty: RuntimePtyWorktreeRecord): void {
    if (pty.connected) {
      return
    }
    // Why: disconnected PTY records stay addressable for status/exit reads, but their transcripts must not accumulate after the process dies.
    pty.tailBuffer = []
    pty.tailTranscriptBuffer = []
    pty.tailTranscriptChars = 0
    pty.tailPartialLine = ''
    pty.tailPendingAnsi = ''
    pty.tailRedrawCursor = null
    pty.tailTruncated = false
    pty.tailLinesTotal = 0
    pty.waitBlockedAt = null
    // Why: tail is now empty, so clear the memoized wait scan; onPtyData must recompute from the reset tail if this record resumes output.
    pty.tailWaitState = undefined
  }

  readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts: { cursor?: number; limit?: number } = {}
  ): RuntimeTerminalRead {
    return readTerminalTail({
      handle,
      status: pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown',
      previewLines: pty.tailBuffer,
      completedLines: pty.tailTranscriptBuffer,
      partialLine: pty.tailPartialLine,
      completedLineCount: pty.tailLinesTotal,
      bufferTruncated: pty.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
  }

  rebuildLeafPtyIndex(): void {
    const next = new Map<string, RuntimeLeafRecord[]>()
    for (const leaf of this.deps.leaves().values()) {
      if (!leaf.ptyId) {
        continue
      }
      const leaves = next.get(leaf.ptyId)
      if (leaves) {
        leaves.push(leaf)
      } else {
        next.set(leaf.ptyId, [leaf])
      }
    }
    const current = this.deps.leavesByPtyId()
    current.clear()
    for (const [ptyId, list] of next) {
      current.set(ptyId, list)
    }
  }

  recordPtyWorktree(
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
    > = {}
  ): RuntimePtyWorktreeRecord {
    return this.deps.managedWorktrees().recordPtyWorktree(ptyId, worktreeId, state)
  }

  refreshFloatingWorkspacePtyLiveness(): Set<string> | null {
    const controller = this.deps.ptyController()
    if (!controller?.hasPty) {
      return null
    }
    const knownPtyIds = new Set<string>()
    const persistedBindingByPtyId = new Map<string, { tabId: string; paneKey: string }>()
    for (const pty of this.deps.ptysById().values()) {
      if (pty.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        knownPtyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.deps.leaves().values()) {
      if (leaf.worktreeId === FLOATING_TERMINAL_WORKTREE_ID && leaf.ptyId) {
        knownPtyIds.add(leaf.ptyId)
      }
    }
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(FLOATING_TERMINAL_WORKTREE_ID)
    for (const tab of snapshot?.tabs ?? []) {
      if (tab.type !== 'terminal') {
        continue
      }
      if (tab.ptyId) {
        knownPtyIds.add(tab.ptyId)
        persistedBindingByPtyId.set(tab.ptyId, {
          tabId: tab.parentTabId,
          paneKey: this.deps.getMobileTerminalPaneKey(tab)
        })
      }
      for (const [leafId, ptyId] of Object.entries(tab.parentLayout?.ptyIdsByLeafId ?? {})) {
        knownPtyIds.add(ptyId)
        persistedBindingByPtyId.set(ptyId, {
          tabId: tab.parentTabId,
          paneKey: isTerminalLeafId(leafId)
            ? makePaneKey(tab.parentTabId, leafId)
            : `${tab.parentTabId}:${/^pane:(\d+)$/.exec(leafId)?.[1] ?? leafId}`
        })
      }
    }

    const liveness = new Map<string, boolean>()
    try {
      for (const ptyId of knownPtyIds) {
        const live = controller.hasPty(ptyId)
        if (live === null) {
          return null
        }
        liveness.set(ptyId, live)
      }
    } catch {
      return null
    }

    const livePtyIds = new Set<string>()
    for (const [ptyId, live] of liveness) {
      let pty = this.deps.ptysById().get(ptyId)
      if (live) {
        livePtyIds.add(ptyId)
        const binding = persistedBindingByPtyId.get(ptyId)
        if (!pty && binding) {
          // Why: a live daemon PTY restored from disk needs its pane identity before mobile can issue a safe handle.
          pty = this.recordPtyWorktree(ptyId, FLOATING_TERMINAL_WORKTREE_ID, {
            connected: true,
            tabId: binding.tabId,
            paneKey: binding.paneKey
          })
        }
        if (pty) {
          pty.connected = true
          pty.disconnectedAt = null
          this.forgetPtyLivenessVerdict(ptyId)
          this.deps.refreshPtyForegroundAgent()(ptyId)
        }
      } else if (pty && !this.leafExistsForPty(ptyId)) {
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
      }
    }
    this.pruneDisconnectedPtyRecords()
    return livePtyIds
  }

  async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    return this.deps
      .managedWorktrees()
      .refreshPtyWorktreeRecordsFromController(resolvedWorktrees, targetWorktreeId, deadline)
  }

  async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    return this.deps
      .managedWorktrees()
      .refreshPtyWorktreeRecordsWithControllerInventory(
        resolvedWorktrees,
        targetWorktreeId,
        deadline,
        connectionId
      )
  }

  registerPty(
    ptyId: string,
    worktreeId: string,
    connectionId: string | null = null,
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
  ): void {
    this.assertPtyDidNotExitBeforeRegistration(ptyId, binding?.incarnationId)
    this.forgetPtyLivenessVerdict(ptyId)
    this.deps.spawnPublishedPtys().add(ptyId)
    // Why: record the renderer pane identity at spawn time so a stalled graph
    // sync can't hide that a live PTY already backs a pending mobile create.
    const paneKey =
      binding && isValidTerminalTabId(binding.tabId) && isTerminalLeafId(binding.leafId)
        ? makePaneKey(binding.tabId, binding.leafId)
        : null
    const pty = this.recordPtyWorktree(ptyId, worktreeId, {
      connected: true,
      connectionId,
      ...(binding &&
      this.deps.pendingMobileTerminalCreatesByKey().has(`${worktreeId}::${binding.tabId}`)
        ? { runtimeSessionOwned: true }
        : {}),
      ...(isWsl !== undefined ? { isWsl } : {}),
      ...(binding && paneKey ? { tabId: binding.tabId, paneKey } : {}),
      ...(binding?.incarnationId ? { incarnationId: binding.incarnationId } : {})
    })
    const agentLaunchAuthority = binding?.agentLaunchAuthority
    if (
      agentLaunchAuthority &&
      paneKey &&
      binding.incarnationId &&
      pty.incarnationId === binding.incarnationId &&
      pty.paneKey === paneKey &&
      pty.launchToken === null &&
      agentLaunchAuthority.launchToken.length > 0 &&
      agentLaunchAuthority.launchToken.length <= 128 &&
      isTuiAgent(agentLaunchAuthority.launchAgent)
    ) {
      pty.launchToken = agentLaunchAuthority.launchToken
      pty.launchIncarnationId = binding.incarnationId
      pty.launchAgent = agentLaunchAuthority.launchAgent
    }
    const providerReattachLaunchIdentity = binding?.providerReattachLaunchIdentity
    if (
      providerReattachLaunchIdentity &&
      paneKey &&
      binding.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      pty.incarnationId === providerReattachLaunchIdentity.incarnationId &&
      pty.paneKey === paneKey &&
      isTuiAgent(providerReattachLaunchIdentity.launchAgent)
    ) {
      // Why: daemon metadata owns the surviving process; its incarnation fence restores identity without minting renderer launch authority.
      pty.launchAgent = providerReattachLaunchIdentity.launchAgent
    }
    const pendingIncarnation = this.deps.pendingPtyRegistrationIncarnations().get(ptyId)
    if (
      pendingIncarnation === null ||
      pendingIncarnation === undefined ||
      binding?.incarnationId === undefined ||
      pendingIncarnation === binding.incarnationId
    ) {
      this.deps.pendingPtyRegistrationIncarnations().delete(ptyId)
    }
    // Why: the renderer's own PTY spawn is the reliable signal that the pending
    // mobile create's tab is live; publish its surface main-side (#7587).
    if (binding && paneKey) {
      this.deps.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, binding.tabId)
    }
  }

  releaseRejectedPtyRegistrationFence(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    if (!this.deps.earlyExitedPtyIncarnations().has(ptyId)) {
      return
    }
    const exitedIncarnation = this.deps.earlyExitedPtyIncarnations().get(ptyId) ?? null
    if (
      exitedIncarnation === null ||
      candidateIncarnation === undefined ||
      exitedIncarnation === candidateIncarnation
    ) {
      // Why: the rejected spawn call was the fence's sole late publisher; retaining it leaks fresh PTY ids.
      this.deps.earlyExitedPtyIncarnations().delete(ptyId)
      this.deps.pendingPtyRegistrationIncarnations().delete(ptyId)
    }
  }

  rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void {
    if (verdict.status === 'exited') {
      // An earned death certificate ends the question; nothing left to remember.
      this.deps.ptyLivenessVerdictByPtyId().delete(ptyId)
      return
    }
    this.deps.ptyLivenessVerdictByPtyId().delete(ptyId)
    this.deps.setPtyLivenessObservationSequence(this.deps.ptyLivenessObservationSequence() + 1)
    this.deps.ptyLivenessVerdictByPtyId().set(ptyId, {
      verdict,
      observedAt: this.deps.ptyLivenessObservationSequence()
    })
    while (this.deps.ptyLivenessVerdictByPtyId().size > MAX_TRACKED_PTY_LIVENESS_VERDICTS) {
      let oldestOrphaned: string | null = null
      for (const candidate of this.deps.ptyLivenessVerdictByPtyId().keys()) {
        if (
          !this.deps.ptysById().has(candidate) &&
          !this.deps.handleByPtyId().has(candidate) &&
          !this.leafExistsForPty(candidate)
        ) {
          oldestOrphaned = candidate
          break
        }
      }
      if (!oldestOrphaned) {
        return
      }
      this.deps.ptyLivenessVerdictByPtyId().delete(oldestOrphaned)
    }
  }

  resetPtyModelAfterMigrationFailure(ptyId: string): void {
    this.deps.providerSnapshotPreferredPtys().add(ptyId)
    this.deps.disposeHeadlessTerminal(ptyId)
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.deps.handles().get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.deps.leaves().get(this.deps.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    return { ptyId: leaf.ptyId }
  }

  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.deps.handles().get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.deps.leaves().get(this.deps.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    if (
      record.ptyId !== null &&
      (leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration)
    ) {
      throw new Error('terminal_handle_stale')
    }
    return { ptyId: leaf.ptyId }
  }

  async resolveTerminalCwd(handle: string): Promise<string | null> {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    if (!ptyId) {
      return null
    }
    const tracked = this.deps.terminalCwdByPtyId().get(ptyId)
    if (tracked) {
      return tracked
    }
    try {
      const cwd = await this.deps.ptyController()?.getCwd?.(ptyId)
      return cwd && cwd.trim().length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  resolveTerminalFileUriHostname(handle: string): string | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    return ptyId ? (this.deps.terminalFileUriHostnameByPtyId().get(ptyId) ?? null) : null
  }

  retirePtyAgentLaunchAuthority(ptyId: string): void {
    const pty = this.deps.ptysById().get(ptyId)
    if (!pty) {
      return
    }
    const receipt = this.deps.restoredOrchestrationAuthorityByPtyId().get(ptyId)
    if (!pty.launchToken && !receipt && !pty.launchAgent) {
      return
    }
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    this.deps.restoredOrchestrationAuthorityByPtyId().delete(ptyId)
    pty.launchToken = null
    pty.launchIncarnationId = null
    pty.launchAgent = null
    for (const paneKey of paneKeys) {
      this.deps.retireAgentHookCompatibilityAuthorityFn()?.(paneKey)
    }
  }

  setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void {
    if (owned) {
      this.deps.pairedRendererSessionOwnedPtyIds().add(ptyId)
    } else {
      this.deps.pairedRendererSessionOwnedPtyIds().delete(ptyId)
    }
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    this.deps.setPtyControllerRef(controller)
  }

  async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string
  ): Promise<boolean> {
    let addressedPtyStopped = false
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      // Why here: this is the single funnel for an explicit close, and the
      // intent must be on record before the stop, since the provider may report
      // the exit itself with a status that reads like a natural finish.
      this.markPtyStopRequested(ptyId)
      let stopped = false
      const stopAndWait = this.deps.ptyController()?.stopAndWait?.bind(this.deps.ptyController())
      if (stopAndWait) {
        try {
          stopped = await stopAndWait(ptyId, { deadlineMs })
        } catch (error) {
          this.markPtyLivenessUnverifiable(
            ptyId,
            error instanceof Error ? error.message : String(error)
          )
        }
        if (!stopped) {
          const verdict = this.getPtyLivenessVerdict(ptyId)
          const providerAlreadyRetiredPty =
            verdict?.status === 'unverifiable' &&
            verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
          if (!providerAlreadyRetiredPty) {
            this.deps.ptyController()?.kill(ptyId)
            if (!verdict || verdict.status === 'live') {
              this.markPtyLivenessUnverifiable(
                ptyId,
                'a follow-up stop was issued but its outcome could not be verified'
              )
            }
          }
        }
      } else {
        stopped = this.deps.ptyController()?.kill(ptyId) ?? false
      }
      if (ptyId === addressedPtyId) {
        addressedPtyStopped = stopped
      }
    }
    return addressedPtyStopped
  }

  subscribeToPtyExit(ptyId: string, listener: () => void): () => void {
    const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
    if (this.isPtyKnownExited(ptyId)) {
      listener()
      return () => {}
    }
    let listeners = this.deps.ptyExitListenersByPtyId().get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.deps.ptyExitListenersByPtyId().set(ptyId, listeners)
    }
    let active = true
    const unsubscribe = (): void => {
      if (!active) {
        return
      }
      active = false
      listeners.delete(listener)
      if (listeners.size === 0 && this.deps.ptyExitListenersByPtyId().get(ptyId) === listeners) {
        this.deps.ptyExitListenersByPtyId().delete(ptyId)
      }
    }
    listeners.add(listener)
    if (
      this.getPtyLifecycleGeneration(ptyId) !== lifecycleGeneration ||
      this.isPtyKnownExited(ptyId)
    ) {
      unsubscribe()
      listener()
    }
    return unsubscribe
  }

  synchronizePtyOutputSequenceFromProvider(
    ptyId: string,
    providerSequence: { value: number; generation: 'continued' | 'reset' },
    runtimeSequenceAtSpawnStart = 0
  ): number {
    if (
      !Number.isFinite(providerSequence.value) ||
      providerSequence.value < 0 ||
      !Number.isFinite(runtimeSequenceAtSpawnStart) ||
      runtimeSequenceAtSpawnStart < 0
    ) {
      return this.getPtyOutputSequence(ptyId)
    }
    const baseline = Math.floor(providerSequence.value)
    const currentSequence = this.getPtyOutputSequence(ptyId)
    const sequenceAtSpawnStart = Math.min(currentSequence, Math.floor(runtimeSequenceAtSpawnStart))
    const postSpawnSequence = currentSequence - sequenceAtSpawnStart
    const wasInitialized = this.deps.providerSequenceInitializedPtys().has(ptyId)
    const replacesExistingRuntimeGeneration = wasInitialized || sequenceAtSpawnStart > 0
    const providerOffset =
      providerSequence.generation === 'reset'
        ? sequenceAtSpawnStart
        : (this.deps.providerSequenceOffsetByPtyId().get(ptyId) ?? 0)
    const providerBaseline = providerOffset + baseline

    if (providerSequence.generation === 'reset') {
      this.advancePtyLifecycleGeneration(ptyId)
      // Why: daemon respawn/cold restore starts a new absolute domain. Old
      // emulator state cannot remain authoritative over the replacement.
      if (replacesExistingRuntimeGeneration) {
        this.deps.disposeHeadlessTerminal(ptyId)
      }
      this.deps.providerModeTrackersByPtyId().delete(ptyId)
      this.deps.wslDistroByPtyId().delete(ptyId)
      this.deps.terminalCwdByPtyId().delete(ptyId)
      this.deps.terminalFileUriHostnameByPtyId().delete(ptyId)
      const pty = this.deps.ptysById().get(ptyId)
      if (pty) {
        pty.wslDistro = null
      }
      // Why: raced post-spawn bytes may already contain the replacement's permission state.
      if (replacesExistingRuntimeGeneration && postSpawnSequence === 0) {
        this.deps.resetTrackedTerminalStateForProviderGeneration()(ptyId)
      }
    }

    const synchronizedSequence =
      providerSequence.generation === 'reset'
        ? currentSequence
        : wasInitialized
          ? currentSequence
          : providerBaseline + postSpawnSequence
    this.deps.ptyOutputSequenceById().set(ptyId, synchronizedSequence)
    this.deps.providerSequenceInitializedPtys().add(ptyId)
    this.deps.providerSequenceOffsetByPtyId().set(ptyId, providerOffset)

    const snapshotMayCoverMissingState =
      (providerSequence.generation === 'continued' && !wasInitialized) ||
      (postSpawnSequence > 0 &&
        providerSequence.generation === 'reset' &&
        replacesExistingRuntimeGeneration) ||
      (providerSequence.generation === 'continued' &&
        wasInitialized &&
        providerBaseline > currentSequence)
    if (snapshotMayCoverMissingState) {
      // Why: bytes can cross the control/stream sockets around attach. Until a
      // full renderer/provider snapshot is available, a partial model is unsafe.
      this.deps.providerSnapshotPreferredPtys().add(ptyId)
    } else if (providerSequence.generation === 'reset') {
      this.deps.providerSnapshotPreferredPtys().delete(ptyId)
    }

    const headless = this.deps.headlessTerminals().get(ptyId)
    if (headless && !wasInitialized && providerSequence.generation === 'continued') {
      // Why: daemon bytes can reach main just before spawn resolves. Queue the
      // baseline behind those writes so their emulator sequence is rebased too.
      headless.writeChain = headless.writeChain.then(() => {
        headless.outputSequence = synchronizedSequence
      })
    }
    return synchronizedSequence
  }

  touchMobileSessionSnapshotsForPty(ptyId: string, options: { immediate?: boolean } = {}): void {
    return this.deps.mobileTabSnapshots().touchMobileSessionSnapshotsForPty(ptyId, options)
  }

  async waitForAdoptedStructuredTuiProof(input: {
    owner: StructuredTuiOwner
    threadId: string
    codexHome: string
  }): Promise<{ transcriptPath: string; leafUuid?: never }> {
    const assertPaneIdentity = (): void => {
      const pty = this.deps.ptysById().get(input.owner.terminal.ptyId)
      if (!pty?.connected || pty.paneKey !== input.owner.terminal.paneKey) {
        throw new Error('The adopted terminal lost its pane identity.')
      }
    }
    assertPaneIdentity()
    const transcriptPath = await resolvePinnedCodexRolloutProof(input.codexHome, input.threadId)
    if (!transcriptPath) {
      throw new Error('The agent terminal did not prove the expected Codex rollout.')
    }
    assertPaneIdentity()
    const processProof = await probeAgentSessionProcessIdentity({ identity: input.owner.process })
    if (processProof.outcome !== 'identity-matched' || processProof.matchedOn.length === 0) {
      throw new Error('The resumed Codex process could not be re-proved.')
    }
    return { transcriptPath }
  }

  async waitForStructuredTuiPtyExit(ptyId: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (this.deps.ptysById().get(ptyId)?.connected === true) {
      if (Date.now() >= deadline) {
        throw new Error('terminal_handle_stale')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
