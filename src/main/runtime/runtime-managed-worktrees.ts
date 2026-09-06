/* eslint-disable max-lines -- Why: extracted managed-worktree facade (bulk worktree cluster move); state-owner extraction can split further if it grows */
import { omitUndefinedProperties, ownerSurfacing } from './runtime-terminal-surface-shared'
import { RuntimeManagedWorktreeSleepCommands } from './runtime-managed-worktree-sleep-commands'
import { RuntimeWorktreeLineageCommands } from './runtime-worktree-lineage-commands'
import { RuntimeWorktreeResolutionCommands } from './runtime-worktree-resolution-commands'
import { RuntimePtyWorktreeRecordCommands } from './runtime-pty-worktree-record-commands'
import { RuntimeWorktreeDriftCommands } from './runtime-worktree-drift-commands'
import { RuntimeWorktreeNotifyCommands } from './runtime-worktree-notify-commands'
import { RuntimeWorktreeSummaryCommands } from './runtime-worktree-summary-commands'
import {
  canCheckoutExistingLocalBranch,
  getLocalGitHubPrForBranch,
  getSelectedHostedReviewForBranch,
  hasLocalGitOptions,
  pathExists,
  resolveCreateBranchName
} from './runtime-worktree-git-shared'
import type { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import type { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import type { RuntimeHookAgentRowResolutionCommands } from './runtime-hook-agent-row-resolution-commands'
import type { RuntimeClientEventPublishingCommands } from './runtime-client-event-publishing-commands'
import type { getPRForBranch } from '../github/client/lookup/get-pr-for-branch'
import {
  RuntimeLineageError,
  WORKTREE_CREATE_RESULT_TTL_MS,
  getSetupRunnerCommandPlatformForLaunch,
  hasLocalWorktreeBaseRef
} from './orca-runtime'
import type {
  OrchestrationCompatibilityTerminalAuthority,
  PtyControllerInventory,
  WorktreeLineageInput,
  RemoteFetchResult,
  RemoteTrackingBase,
  ResolvedWorkspaceParent,
  ResolvedWorktree,
  ResolvedWorktreeSnapshot,
  RuntimeLeafRecord,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyWorktreeRecord,
  RuntimeStore,
  RuntimeWorkingTerminalEvidence,
  RuntimeWorktreeLifecycleEvent,
  RuntimeWorktreeRemovalTarget,
  TerminalCreateOptions,
  TerminalHandleRecord,
  TrackedPtyLivenessVerdict,
  WorktreeLineageCandidate,
  WorktreeLineageResolution,
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './orca-runtime'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { navigationTargetsClients, navigationTargetsHost } from '../../shared/runtime-navigation'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeTerminalCreate,
  RuntimeTerminalShow,
  RuntimeTerminalSplit,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeTerminalSleepResult
} from '../../shared/runtime-types'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TaskSourceContext } from '../../shared/task-source-context'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../shared/workspace-source'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { createRetiredNameLookup } from '../../shared/worktree/retired-name-registry'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  WorkspaceLinkedItem,
  Worktree
} from '../../shared/worktree/types'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
import { resolveLocalGitUsername } from '../git/git-username'
import {
  getBaseRefDefault,
  getBranchConflictKind,
  resolveDefaultBaseRefWithLocalGit
} from '../git/repo'
import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import { addSparseWorktree, addWorktree, listWorktrees } from '../git/worktree'
import { getEffectiveHooks, loadHooks, runHook } from '../hooks'
import { findCreatedWorktree } from '../ipc/created-worktree-reconciliation'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { normalizeSparseDirectories } from '../ipc/sparse-checkout-directories'
import { formatWorktreeIncludeCopyWarning } from '../ipc/worktree-include-copy-budget'
import {
  computeWorkspaceRoot,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  mergeWorktree,
  sanitizeWorktreeName,
  shouldSetDisplayName
} from '../ipc/worktree-logic'
import {
  configureCreatedWorktreePushTarget,
  createRemoteWorktree,
  prepareWorktreePushTarget
} from '../ipc/worktree-remote'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from '../ipc/worktree-symlinks'
import type { Store } from '../persistence'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { IPtyProvider } from '../providers/types'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import {
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS,
  getBranchNameOverrideCandidate,
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName
} from '../worktree-create-candidates'
import {
  failedWorktreeCreationNeedsRetirement,
  getRetiredNameRegistryForRepo,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'
import { stripOrcaProvenanceMetaUpdates } from '../worktree-removal-safety'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import type { MobileSessionTabsAgentStatusHeartbeat } from './mobile-session-tabs-agent-status-heartbeat'
import type { OrchestrationDb } from './orchestration/db'
import { buildObservedSetupCommand } from './orchestration/setup-completion-signal'
import {
  getRuntimeFolderWorkspaceInstanceId,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-tail-projection'
import { runtimeWorktreeIdsEqual } from './runtime-tail-projection'
import {
  getSelectedReviewBranch,
  isAllowedPushTargetRemoteConflict,
  isMatchingSelectedGitHubPr
} from './selected-review-branch'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

export type RuntimeManagedWorktreesDeps = {
  _orchestrationDb: OrchestrationDb | null
  acceptedRendererMobileSnapshotByWorktree: () => Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
    }
  >
  adoptControllerTerminalHandle: (
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options?: { exactRestoredSurface?: boolean }
  ) => void
  agentBrowserBridge: AgentBrowserBridge | null
  assertGraphReady: () => void
  assertStableReadyGraph: (expectedGraphEpoch: number) => void
  attachAgentRowsToSummaries: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    mirroredWorktreeIdByTabId: ReadonlyMap<string, string>,
    connectedPtyEvidence: {
      tabIds: ReadonlySet<string>
      paneKeys: ReadonlySet<string>
      ptyIds: ReadonlySet<string>
    },
    workingTerminalEvidenceByWorktreeId: ReadonlyMap<
      string,
      readonly RuntimeWorkingTerminalEvidence[]
    >
  ) => void
  authoritativeWindowId: () => number | null
  buildResolvedWorktreeFromId: (worktreeId: string) => ResolvedWorktree | null
  buildStartupForAgent: (
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences
  ) => { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup }
  buildStartupForDraft: (
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent
  ) => Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    draftPaste?: WorktreeStartupDraftPaste
  } | null>
  captureReadyGraphEpoch: () => number
  clientEventPublishingCommands: () => RuntimeClientEventPublishingCommands
  createDefaultTabTerminals: (
    worktreeSelector: string,
    worktreeId: string,
    defaultTabs: CreateWorktreeResult['defaultTabs'] | undefined,
    surfacing: { surfaceOwner?: false }
  ) => Promise<string[]>
  createTerminal: (
    worktreeSelector?: string,
    opts?: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  emitClientEvent: (event: RuntimeClientEvent) => void
  fetchRemoteWithCache: (
    repoPath: string,
    remote: string,
    gitOptions?: { wslDistro?: string }
  ) => Promise<void>
  forgetPtyLivenessVerdict: (ptyId: string, observedNoLaterThan?: number) => void
  getAvailableAuthoritativeWindow: () => BrowserWindow | null
  getLeafKey: (tabId: string, leafId: string) => string
  getLivePtyForHandle: (handle: string) => {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  getLocalProvider: () => IPtyProvider | null
  getOrStartRemoteFetch: (
    repoPath: string,
    remote: string,
    gitOptions?: { wslDistro?: string }
  ) => Promise<RemoteFetchResult>
  getOrStartRemoteTrackingBaseRefresh: (
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions?: { wslDistro?: string }
  ) => Promise<RemoteFetchResult>
  getPtyRecordForPaneKey: (paneKey: string) => RuntimePtyWorktreeRecord | null
  getRecordedTerminalSleepHandles: (
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ) => string[]
  getResolvedWorktreeMap: () => Promise<Map<string, ResolvedWorktree>>
  getRuntimeId: () => string
  getSshProviderFn: () => ((connectionId: string) => IPtyProvider | undefined) | null
  getStartedAt: () => number
  getTerminalHandlesForPtyId: (ptyId: string) => string[]
  graphStatus: () => RuntimeGraphStatus
  hasFreshResolvedWorktreeCache: () => boolean
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions?: { wslDistro?: string }
  ) => Promise<boolean>
  hookAgentRowResolutionCommands: () => RuntimeHookAgentRowResolutionCommands
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
    worktreeId?: string,
    options?: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    }
  ) => Set<string>
  intentionalHandlelessPtyStops: () => Map<string, string | null>
  invalidatePtyIncarnationHandle: (ptyId: string) => void
  invalidateResolvedWorktreeCache: () => void
  invalidateSshWorktreeScanCacheInternal: (targetId: string) => void
  invalidateWorktreeScanCacheForRepo: (repoId: string) => void
  leafExistsForPty: (ptyId: string) => boolean
  leaves: () => Map<string, RuntimeLeafRecord>
  listResolvedWorktreeSnapshot: () => Promise<ResolvedWorktreeSnapshot>
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  makeRuntimePaneKey: (
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ) => string
  markLocalWorkspaceTrustedForAgent: (agent: TuiAgent, workspacePath: string) => Promise<void>
  markPtyLivenessUnverifiable: (ptyId: string, reason: string) => void
  markRemoteWorkspaceTrustedForAgent: (
    agent: TuiAgent,
    connectionId: string,
    workspacePath: string
  ) => Promise<void>
  mobileSessionTabsAgentStatusHeartbeat: () => MobileSessionTabsAgentStatusHeartbeat
  mobileSessionTabsByWorktree: () => Map<string, RuntimeMobileSessionTabsSnapshot>
  mobileTabSnapshots: () => RuntimeMobileSessionTabSnapshotCommands
  nextTitleObservationSequence: () => number
  notifier: RuntimeNotifier | null
  notifyMobileSessionTabsChanged: (worktreeId?: string) => void
  offscreenBrowserBackend: BrowserBackend | null
  onPtyStopped: () => ((ptyId: string) => void) | null
  pasteStartupDraftWhenReady: (handle: string, draft: WorktreeStartupDraftPaste) => void
  projectMobileSessionTabsForClient: (
    result: unknown,
    clientNavigationId?: string
  ) => RuntimeMobileSessionTabsResult
  pruneDisconnectedPtyRecords: () => void
  ptyController: RuntimePtyController | null
  ptyLivenessVerdictByPtyId: () => Map<string, TrackedPtyLivenessVerdict>
  ptyLivenessObservationSequence: () => number
  ptysById: () => Map<string, RuntimePtyWorktreeRecord>
  reconcileSubscriberDrivenProviderAttach: (ptyId: string) => void
  refreshFloatingWorkspacePtyLiveness: () => Set<string> | null
  refreshMobileSessionPtyRecords: (targetWorktreeId?: string | null) => Promise<Set<string> | null>
  refreshPtyForegroundAgent: () => (ptyId: string) => void
  rememberRestoredOrchestrationAuthority: (
    pty: RuntimePtyWorktreeRecord,
    terminalHandle: string,
    incarnationId: string
  ) => void
  requireStore: () => Store
  resolveExplicitWorktreeIdScoped: (
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ) => Promise<ResolvedWorktree | null>
  resolveFolderWorkspaceConnectionId: (workspace: FolderWorkspace) => string | null
  resolveLineageCandidateForTaskId: (taskId: string) => Promise<WorktreeLineageCandidate | null>
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    gitOptions?: { wslDistro?: string }
  ) => Promise<RemoteTrackingBase | null>
  resolveRepoSelector: (selector: string) => Promise<Repo>
  resolveWorkspaceParentSelector: (selector: string) => Promise<ResolvedWorkspaceParent>
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
  sendStartupFollowupWhenReady: (handle: string, followup: WorktreeStartupFollowup) => void
  setPtyManagementTitleFromObservedTitle: (
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ) => void
  setupCompletionTokenByPtyId: () => Map<string, string>
  showTerminal: (handle: string) => Promise<RuntimeTerminalShow>
  snapshotValueComparison: () => RuntimeMobileSnapshotValueComparisonCommands
  splitTerminal: (
    handle: string,
    opts?: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    }
  ) => Promise<RuntimeTerminalSplit>
  store: RuntimeStore | null
  tabs: () => Map<string, RuntimeSyncedTab>
  terminalMutationTailByWorktreeId: () => Map<string, Promise<void>>
  terminalSleepByWorktreeId: () => Map<string, Promise<RuntimeWorktreeTerminalSleepResult>>
  terminalSleepStateByWorktreeId: () => Map<
    string,
    {
      worktreeId: string
      generation: number
      phase: 'stopping' | 'partial' | 'sleeping'
      ptyIds: string[]
      terminalHandles: string[]
      terminalHandlesByPtyId: Record<string, string[]>
    }
  >
  toMobileSessionTabsResult: (
    snapshot: RuntimeMobileSessionTabsSnapshot
  ) => RuntimeMobileSessionTabsResult
  validateLineageParent: (child: ResolvedWorktree, parent: ResolvedWorktree) => void
  wslDistroByPtyId: () => Map<string, string>
  getHostedReviewExecutionOptions: (
    repo: Repo
  ) => { localGitExecOptions: { wslDistro?: string } } | undefined
  getLocalGitExecutionOptionArgs: (repo: Repo) => [] | [{ wslDistro?: string }]
}

export type RuntimeManagedWorktreeCreateArgs = {
  repoSelector: string
  name: string
  /** True only when `name` came from Orca's creature-name generator; gates retirement so a name
   *  the user typed stays reusable. Absent for CLI and automation callers. */
  nameWasGenerated?: boolean
  baseBranch?: string
  compareBaseRef?: string
  branchNameOverride?: string
  linkedIssue?: number | null
  linkedPR?: number | null
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
  comment?: string
  displayName?: string
  telemetrySource?: WorkspaceCreateTelemetrySource
  workspaceStatus?: string
  manualOrder?: number
  sparseCheckout?: { directories: string[]; presetId?: string }
  pushTarget?: GitPushTarget
  runHooks?: boolean
  activate?: boolean
  /** Who the create's activation is addressed to. Defaults to 'all' so host/CLI callers keep
   *  revealing on every surface; the RPC layer narrows it to 'caller' for paired clients. */
  navigation?: RuntimeNavigationTarget
  setupDecision?: 'run' | 'skip' | 'inherit'
  awaitTerminalProvisioning?: boolean
  observeSetupCompletion?: boolean
  createdWithAgent?: TuiAgent
  startupAgent?: TuiAgent
  startupLaunchPreferences?: AgentLaunchPreferences
  startupPrompt?: string
  pendingFirstAgentMessageRename?: boolean
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
  creatorProvenance?: Worktree['creatorProvenance']
  startup?: WorktreeStartupLaunch
  startupDraft?: string
  startupDraftPaste?: WorktreeStartupDraftPaste
  lineage?: WorktreeLineageInput
}

export class RuntimeManagedWorktrees {
  private readonly deps: RuntimeManagedWorktreesDeps
  private worktreeCreateByMutationId = new Map<string, Promise<unknown>>()
  readonly worktreeLifecycleListeners = new Set<(event: RuntimeWorktreeLifecycleEvent) => void>()
  readonly clientSessionTabSelections = new ClientSessionTabSelectionStore()

  constructor(deps: RuntimeManagedWorktreesDeps) {
    this.deps = deps
    this.sleepCommands = new RuntimeManagedWorktreeSleepCommands(deps, this)
    this.lineageCommands = new RuntimeWorktreeLineageCommands(deps, this)
    this.resolutionCommands = new RuntimeWorktreeResolutionCommands(deps)
    this.ptyRecordCommands = new RuntimePtyWorktreeRecordCommands(deps)
    this.driftCommands = new RuntimeWorktreeDriftCommands(deps, this)
    this.summaryCommands = new RuntimeWorktreeSummaryCommands(deps)
    this.notifyCommands = new RuntimeWorktreeNotifyCommands(deps, {
      worktreeLifecycleListeners: this.worktreeLifecycleListeners,
      clientSessionTabSelections: this.clientSessionTabSelections,
      notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId),
      notifyWorktreesChangedForRemoteClients: (repoId) =>
        this.notifyWorktreesChangedForRemoteClients(repoId),
      notifyHostActivateWorktree: (...args) => this.notifyHostActivateWorktree(...args),
      notifyClientsActivateWorktree: (...args) => this.notifyClientsActivateWorktree(...args)
    })
  }

  private readonly sleepCommands: RuntimeManagedWorktreeSleepCommands
  private readonly lineageCommands: RuntimeWorktreeLineageCommands
  private readonly resolutionCommands: RuntimeWorktreeResolutionCommands
  private readonly ptyRecordCommands: RuntimePtyWorktreeRecordCommands
  private readonly driftCommands: RuntimeWorktreeDriftCommands
  private readonly notifyCommands: RuntimeWorktreeNotifyCommands
  private readonly summaryCommands: RuntimeWorktreeSummaryCommands

  async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    return this.ptyRecordCommands.refreshPtyWorktreeRecordsFromController(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
  }

  async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    return this.ptyRecordCommands.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline,
      connectionId
    )
  }

  get optimisticReconcileTokens(): Map<string, string> {
    return this.driftCommands.optimisticReconcileTokens
  }

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.summaryCommands.getMobileSessionTabsForWorktree(worktreeId, clientNavigationId)
  }

  collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    return this.summaryCommands.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )
  }

  getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    return this.summaryCommands.getSummaryForRuntimeWorktreeId(
      summaries,
      runtimeWorktreeSummaryPathIndex,
      missingRuntimeWorktreeIds,
      runtimeWorktreeId
    )
  }

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    return this.notifyCommands.emitWorktreeBaseStatus(event)
  }

  emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    return this.notifyCommands.emitWorktreeLifecycle(event)
  }

  notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    launch: {
      setup?: CreateWorktreeResult['setup']
      startup?: WorktreeStartupLaunch
      defaultTabs?: CreateWorktreeResult['defaultTabs']
      navigationTarget: RuntimeNavigationTarget | undefined
    }
  ): void {
    return this.notifyCommands.notifyActivateWorktree(repoId, worktreeId, launch)
  }

  notifyClientsActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    return this.notifyCommands.notifyClientsActivateWorktree(
      repoId,
      worktreeId,
      setup,
      startup,
      defaultTabs
    )
  }

  notifyHostActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    return this.notifyCommands.notifyHostActivateWorktree(
      repoId,
      worktreeId,
      setup,
      startup,
      defaultTabs
    )
  }

  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    return this.notifyCommands.notifyWorktreeCatalogChangedForRemoteClients(repoId)
  }

  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    return this.notifyCommands.notifyWorktreeFolderRenamed(repoId, oldWorktreeId, newWorktreeId)
  }

  notifyWorktreesChanged(repoId: string): void {
    return this.notifyCommands.notifyWorktreesChanged(repoId)
  }

  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    return this.notifyCommands.notifyWorktreesChangedForRemoteClients(repoId)
  }

  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    return this.notifyCommands.onWorktreeLifecycle(listener)
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    return this.notifyCommands.persistManagedWorktreeSortOrder(orderedIds)
  }

  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    return this.driftCommands.probeWorktreeDrift(worktreeSelector)
  }

  async reconcileWorktreeBaseStatus(args: {
    repoId: string
    repoPath: string
    worktreeId: string
    base: RemoteTrackingBase
    branchName: string
    createdBaseSha: string
    token: string
    fetchPromise: Promise<RemoteFetchResult>
  }): Promise<void> {
    return this.driftCommands.reconcileWorktreeBaseStatus(args)
  }

  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    return this.ptyRecordCommands.getOrCreatePtyWorktreeRecord(ptyId)
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
    return this.ptyRecordCommands.recordPtyWorktree(ptyId, worktreeId, state)
  }

  async acquireWorktreeTerminalMutation(
    worktreeId: string,
    deadline?: number
  ): Promise<() => void> {
    return this.sleepCommands.acquireWorktreeTerminalMutation(worktreeId, deadline)
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    return this.sleepCommands.acquireWorktreeTerminalSpawn(worktreeId)
  }

  commitWorktreeTerminalSleepPtys(args: {
    worktreeId: string
    generation: number
    ptyIds: readonly string[]
    pendingPtyIds: Set<string>
    committedPtyIds: Set<string>
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  }): void {
    return this.sleepCommands.commitWorktreeTerminalSleepPtys(args)
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    return this.sleepCommands.sleepManagedWorktree(worktreeSelector)
  }

  async sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    return this.sleepCommands.sleepResolvedWorktreeTerminals(worktree)
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    return this.sleepCommands.sleepTerminalsForWorktree(worktreeSelector)
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
    return this.sleepCommands.stopExactTerminalsForWorktree(worktreeSelector, expectedPtyIds, opts)
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
    return this.sleepCommands.stopTerminalsForWorktree(worktreeSelector, options)
  }

  async hydrateInferredWorktreeLineage(): Promise<void> {
    return this.lineageCommands.hydrateInferredWorktreeLineage()
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.lineageCommands.listWorktreeLineage()
  }

  recordCreatedWorktreeLineage(
    worktree: Pick<Worktree, 'id' | 'instanceId'>,
    lineageResolution: WorktreeLineageResolution
  ): {
    lineage: WorktreeLineage | null
    workspaceLineage: WorkspaceLineage | null
    warnings: WorktreeLineageWarning[]
  } {
    return this.lineageCommands.recordCreatedWorktreeLineage(worktree, lineageResolution)
  }

  async resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput
  ): Promise<WorktreeLineageResolution> {
    return this.lineageCommands.resolveLineageForWorktreeCreate(input)
  }

  getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    return this.resolutionCommands.getKnownWorkspaceSessionWorktreeIds()
  }

  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    return this.resolutionCommands.resolveActiveWorktreeContext()
  }

  resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    return this.resolutionCommands.resolveBrowserNetworkExecutionHostForWorktree(worktree)
  }

  async resolveMobileMarkdownWorktreeId(worktreeSelector: string, tabId: string): Promise<string> {
    return this.resolutionCommands.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
  }

  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.resolutionCommands.resolveProjectRuntimeForWorktree(worktreeId)
  }

  async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    return this.resolutionCommands.resolveWorktreeRemovalTarget(worktreeSelector, requiredHostId)
  }

  async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    return this.resolutionCommands.resolveWorktreeSelector(selector)
  }

  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    return this.resolutionCommands.setWorkspaceSessionForWorktree(worktreeId, session)
  }

  tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    return this.resolutionCommands.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
  }

  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.resolutionCommands.getWorkspaceSessionForWorktree(worktreeId)
  }

  getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    return this.resolutionCommands.getWorkspaceSessionHostIdForWorktree(worktreeId)
  }

  getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    return this.resolutionCommands.getValidatedExplicitWorktreeIdSelector(selector)
  }

  folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    return this.resolutionCommands.folderWorkspaceToResolvedWorktree(folderWorkspace)
  }

  async activateManagedWorktree(
    worktreeSelector: string,
    opts: {
      notifyClients?: boolean
      clientKind?: 'mobile' | 'runtime'
      navigation?: RuntimeNavigationTarget
    } = {}
  ): Promise<{
    repoId: string
    worktreeId: string
    activated: boolean
    /** Mobile-scoped slept-agent wake outcome. `unsupported-headless` means no
     *  renderer holds the sleeping records (headless `orca serve`), so nothing
     *  woke — clients must not present the worktree's agents as resumed. */
    sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable'
  }> {
    this.deps.assertGraphReady()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.deps.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const targetsClients = navigationTargetsClients(navigation)

    if (!targetsHost && this.deps.store?.getWorktreeMeta(worktree.id)?.isUnread) {
      // Why: mobile/web session activation intentionally bypasses renderer
      // selection, so the runtime must acknowledge the unread state itself.
      this.deps.store.setWorktreeMeta(worktree.id, { isUnread: false })
      this.notifyWorktreesChanged(repo.id)
    }

    let sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable' =
      'not-applicable'
    if (targetsHost || targetsClients) {
      // Why: inactive worktree terminal panes are renderer-owned and may not have
      // live PTYs until the desktop activates the worktree and mounts them.
      if (targetsHost) {
        this.notifyHostActivateWorktree(repo.id, worktree.id)
      }
      if (targetsClients) {
        this.notifyClientsActivateWorktree(repo.id, worktree.id)
      }
    }
    if (!targetsHost) {
      // Why: mobile/web selection needs fresh session surfaces without forcing
      // every attached desktop renderer to navigate to the phone's workspace.
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
        allowAttachedWindow: true
      })
      await this.deps.refreshMobileSessionPtyRecords()
      this.deps.notifyMobileSessionTabsChanged(worktree.id)
      // Why: a phone open must also wake the worktree's slept agents (experimental
      // agent sleep). Only the host renderer holds the sleeping records + wake
      // authority, so fire-and-forget ask it — mobile-scoped so web/desktop are
      // unaffected. Headless serve has no renderer to wake anything, so report
      // that explicitly instead of letting mobile assume the agents resumed.
      if (opts.clientKind === 'mobile') {
        if (this.deps.getAvailableAuthoritativeWindow()) {
          this.deps.notifier?.resumeSleepingAgents?.(worktree.id)
          sleepingAgentWake = 'requested'
        } else if (
          // Why: sleeping records are partitioned by execution host; reading
          // only the local partition would miss slept agents on SSH-host
          // worktrees and skip the headless warning for them.
          Object.values(
            this.deps.store?.getWorkspaceSession?.(getRepoExecutionHostId(repo))
              .sleepingAgentSessionsByPaneKey ?? {}
          ).some((record) => record.worktreeId === worktree.id)
        ) {
          // Why: headless is only degraded when this worktree actually has a
          // persisted resume record. Ordinary mobile activation must not show
          // an unsupported warning merely because no desktop window is open.
          sleepingAgentWake = 'unsupported-headless'
        }
      }
    }
    return { repoId: repo.id, worktreeId: worktree.id, activated: true, sleepingAgentWake }
  }

  async createManagedRemoteWorktree(
    repo: Repo,
    args: {
      name: string
      nameWasGenerated?: boolean
      baseBranch?: string
      compareBaseRef?: string
      branchNameOverride?: string
      linkedIssue?: number | null
      linkedPR?: number | null
      linkedLinearIssue?: string
      linkedLinearIssueWorkspaceId?: string | null
      linkedLinearIssueOrganizationUrlKey?: string | null
      linkedGitLabMR?: number | null
      linkedGitLabIssue?: number | null
      linkedBitbucketPR?: number | null
      linkedAzureDevOpsPR?: number | null
      linkedGiteaPR?: number | null
      linkedWorkItem?: WorkspaceLinkedItem | null
      linkedTaskSourceContext?: TaskSourceContext | null
      comment?: string
      displayName?: string
      workspaceStatus?: string
      manualOrder?: number
      sparseCheckout?: { directories: string[]; presetId?: string }
      pushTarget?: GitPushTarget
      runHooks?: boolean
      activate?: boolean
      navigation?: RuntimeNavigationTarget
      setupDecision?: 'run' | 'skip' | 'inherit'
      awaitTerminalProvisioning?: boolean
      observeSetupCompletion?: boolean
      createdWithAgent?: TuiAgent
      pendingFirstAgentMessageRename?: boolean
      automationProvenance?: AutomationWorkspaceProvenance
      cliProvenance?: CliWorkspaceProvenance
      startup?: WorktreeStartupLaunch
      startupFollowup?: WorktreeStartupFollowup
      startupDraftPaste?: WorktreeStartupDraftPaste
    }
  ): Promise<CreateWorktreeResult> {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }

    // Why: runtime/mobile callers do not own a renderer BrowserWindow, but the
    // SSH create helper only uses it for progress and change notifications.
    // Runtime emits those through RuntimeNotifier after the create succeeds.
    const headlessWindow = {
      isDestroyed: () => false,
      webContents: { send: () => undefined }
    } as unknown as BrowserWindow

    const result = await createRemoteWorktree(
      {
        repoId: repo.id,
        name: args.name,
        ...(args.nameWasGenerated === true ? { nameWasGenerated: true } : {}),
        ...(args.displayName ? { displayName: args.displayName } : {}),
        ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
        ...(args.compareBaseRef ? { compareBaseRef: args.compareBaseRef } : {}),
        ...(args.branchNameOverride ? { branchNameOverride: args.branchNameOverride } : {}),
        ...(args.runHooks ? { setupDecision: 'run' as const } : {}),
        ...(!args.runHooks && args.setupDecision ? { setupDecision: args.setupDecision } : {}),
        ...(args.sparseCheckout ? { sparseCheckout: args.sparseCheckout } : {}),
        ...(args.linkedIssue != null ? { linkedIssue: args.linkedIssue } : {}),
        ...(args.linkedPR != null ? { linkedPR: args.linkedPR } : {}),
        ...(args.linkedLinearIssue ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
        ...(args.linkedLinearIssueWorkspaceId !== undefined
          ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
          : {}),
        ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
          ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
          : {}),
        ...(args.linkedGitLabMR != null ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
        ...(args.linkedGitLabIssue != null ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
        ...(args.linkedBitbucketPR != null ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
        ...(args.linkedAzureDevOpsPR != null
          ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
          : {}),
        ...(args.linkedGiteaPR != null ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
        ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
        ...(args.linkedTaskSourceContext !== undefined
          ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
          : {}),
        ...(args.pushTarget ? { pushTarget: args.pushTarget } : {}),
        ...(args.workspaceStatus ? { workspaceStatus: args.workspaceStatus as never } : {}),
        ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
        ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
        ...(args.pendingFirstAgentMessageRename === true
          ? { pendingFirstAgentMessageRename: true }
          : {}),
        ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
        ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {})
      },
      repo,
      this.deps.store as unknown as Store,
      headlessWindow
    )

    if (args.comment !== undefined) {
      this.deps.store.setWorktreeMeta(result.worktree.id, { comment: args.comment })
      result.worktree.comment = args.comment
    }

    this.deps.invalidateResolvedWorktreeCache()
    this.deps.invalidateWorktreeScanCacheForRepo(repo.id)
    this.notifyWorktreesChanged(repo.id)

    const shouldActivate = args.activate === true || args.runHooks === true
    let warning = result.warning
    let didSpawnStartup = false
    // Why: same no-double-spawn contract as the local path — once runtime
    // provisions setup, omit it from activation and the RPC result.
    let didSpawnSetup = false
    let setupTerminalHandle: string | null = null
    let startupTerminalHandle: string | null = null
    let startupTerminalTabId: string | null = null
    let startupTerminalPaneKey: string | null = null
    let startupTerminalPtyId: string | null = null

    let sequencedStartup = args.startup
    let wrappedSetupCommandStr: string | undefined
    if (args.startup && result.setup?.waitForAgentStartup === true) {
      const platform = getSetupRunnerCommandPlatformForLaunch(result.setup, 'posix')
      const sequenced = createSequencedSetupAgentCommands({
        runnerScriptPath: result.setup.runnerScriptPath,
        startupCommand: args.startup.command,
        platform,
        shell: result.setup.shell
      })
      sequencedStartup = {
        ...args.startup,
        command: sequenced.startupCommand,
        ...(sequenced.startupEnv ? { env: { ...args.startup.env, ...sequenced.startupEnv } } : {})
      }
      wrappedSetupCommandStr = sequenced.setupCommand
    }

    if (sequencedStartup && this.deps.ptyController?.spawn) {
      try {
        const startupTrustAgent = args.startupDraftPaste?.agent ?? args.createdWithAgent
        if (startupTrustAgent) {
          await this.deps.markRemoteWorkspaceTrustedForAgent(
            startupTrustAgent,
            repo.connectionId!,
            result.worktree.path
          )
        }
        const terminal = await this.deps.createTerminal(`path:${result.worktree.path}`, {
          command: sequencedStartup.command,
          ...(result.setup && args.startup
            ? { claudeAgentTeamsSourceCommand: args.startup.command }
            : {}),
          env: sequencedStartup.env,
          ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
          ...(args.createdWithAgent ? { launchAgent: args.createdWithAgent } : {}),
          ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
          startupCommandDelivery: sequencedStartup.startupCommandDelivery,
          telemetry: sequencedStartup.telemetry,
          ...ownerSurfacing(shouldActivate)
        })
        if (args.startupDraftPaste) {
          this.deps.pasteStartupDraftWhenReady(terminal.handle, args.startupDraftPaste)
        }
        if (args.startupFollowup) {
          this.deps.sendStartupFollowupWhenReady(terminal.handle, args.startupFollowup)
        }
        didSpawnStartup = true
        startupTerminalHandle = terminal.handle
        startupTerminalTabId = terminal.tabId ?? null
        startupTerminalPaneKey = terminal.paneKey ?? null
        startupTerminalPtyId = terminal.ptyId ?? null
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the startup terminal for ${result.worktree.path}: ${message}`
          : `Failed to create the startup terminal for ${result.worktree.path}: ${message}`
      }
    }

    if (shouldActivate) {
      const runtimeWillProvisionTerminals =
        didSpawnStartup && Boolean(result.setup || result.defaultTabs)
      if (runtimeWillProvisionTerminals) {
        // Why: remote/mobile task creates spawn the agent terminal in runtime,
        // so renderer activation may not materialize setup/default tabs. Await so
        // a failed setup spawn falls back to renderer activation for retry.
        const provisioned = await this.provisionManagedWorktreeTerminals({
          worktreeSelector: `path:${result.worktree.path}`,
          worktreeId: result.worktree.id,
          worktreePath: result.worktree.path,
          ...(result.setup ? { setup: result.setup } : {}),
          ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
          primaryTerminalHandle: startupTerminalHandle,
          hasStartupTerminal: didSpawnStartup,
          setupCommandPlatform: getSetupRunnerCommandPlatformForLaunch(result.setup, 'posix'),
          observeSetupCompletion: args.observeSetupCompletion,
          // Why: carry the wait-for-agent wrapped setup command (#6298) so the
          // remote Setup tab runs the same script the sequenced agent waits on.
          ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {})
        })
        didSpawnSetup = provisioned.setupSpawned
        setupTerminalHandle = provisioned.setupTerminalHandle
      }
      // Why: omit setup from activation when runtime spawned it; on spawn
      // failure fall through with the wrapped command so renderer retries.
      const activationSetup = didSpawnSetup
        ? undefined
        : result.setup
          ? {
              ...result.setup,
              ...(didSpawnStartup && wrappedSetupCommandStr
                ? { command: wrappedSetupCommandStr }
                : {})
            }
          : undefined
      const activationDefaultTabs = runtimeWillProvisionTerminals ? undefined : result.defaultTabs
      if (args.startup && !didSpawnStartup) {
        this.notifyActivateWorktree(repo.id, result.worktree.id, {
          setup: activationSetup,
          startup: args.startup,
          defaultTabs: activationDefaultTabs,
          navigationTarget: args.navigation
        })
      } else {
        this.notifyActivateWorktree(repo.id, result.worktree.id, {
          setup: activationSetup,
          defaultTabs: activationDefaultTabs,
          navigationTarget: args.navigation
        })
      }
    }

    if (
      !shouldActivate &&
      this.deps.ptyController?.spawn &&
      (result.setup || result.defaultTabs || didSpawnStartup)
    ) {
      // Why: inactive terminal materialization matches normal worktree creation,
      // but setup/default tab failures must not gate automation dispatch.
      const provisioning = this.provisionManagedWorktreeTerminals({
        worktreeSelector: `path:${result.worktree.path}`,
        worktreeId: result.worktree.id,
        worktreePath: result.worktree.path,
        ...(result.setup ? { setup: result.setup } : {}),
        ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
        primaryTerminalHandle: startupTerminalHandle,
        hasStartupTerminal: didSpawnStartup,
        setupCommandPlatform: getSetupRunnerCommandPlatformForLaunch(result.setup, 'posix'),
        observeSetupCompletion: args.observeSetupCompletion,
        ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {}),
        surfaceOwner: false
      })
      // Why: runtime owns setup spawning here, so omit setup from the RPC result
      // to keep the headless/mobile caller from launching it a second time.
      if (args.awaitTerminalProvisioning) {
        const provisioned = await provisioning
        didSpawnSetup = provisioned.setupSpawned
        setupTerminalHandle = provisioned.setupTerminalHandle
      } else {
        void provisioning
        if (result.setup) {
          didSpawnSetup = true
        }
      }
    } else if (!shouldActivate && this.deps.ptyController?.spawn) {
      try {
        await this.deps.createTerminal(`path:${result.worktree.path}`, { surfaceOwner: false })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the initial terminal for ${result.worktree.path}: ${message}`
          : `Failed to create the initial terminal for ${result.worktree.path}: ${message}`
      }
    }

    const returnedSetup = didSpawnSetup
      ? undefined
      : result.setup
        ? {
            ...result.setup,
            ...(didSpawnStartup && wrappedSetupCommandStr
              ? { command: wrappedSetupCommandStr }
              : {})
          }
        : undefined
    const resultForRenderer = returnedSetup
      ? { ...result, setup: returnedSetup }
      : (() => {
          const { setup: _setup, ...resultWithoutSetup } = result
          return resultWithoutSetup
        })()

    const resultWithStartupTerminal =
      didSpawnStartup && startupTerminalHandle
        ? {
            ...resultForRenderer,
            startupTerminal: {
              spawned: true,
              handle: startupTerminalHandle,
              ...(startupTerminalTabId ? { tabId: startupTerminalTabId } : {}),
              ...(startupTerminalPaneKey ? { paneKey: startupTerminalPaneKey } : {}),
              ...(startupTerminalPtyId ? { ptyId: startupTerminalPtyId } : {}),
              surface: 'background' as const
            }
          }
        : resultForRenderer

    const requestedSetupDecision = args.runHooks ? 'run' : (args.setupDecision ?? 'inherit')
    const setupReceipt = {
      requested: requestedSetupDecision,
      hookFound: Boolean(result.setup),
      startupPolicy: result.setup?.waitForAgentStartup
        ? ('wait-for-setup' as const)
        : ('start-immediately' as const),
      state:
        requestedSetupDecision === 'skip'
          ? ('skipped' as const)
          : !result.setup
            ? ('not_configured' as const)
            : didSpawnSetup
              ? ('running' as const)
              : ('spawn_failed' as const),
      ...(setupTerminalHandle ? { terminalHandle: setupTerminalHandle } : {})
    }
    const resultWithSetupReceipt = args.awaitTerminalProvisioning
      ? { ...resultWithStartupTerminal, setupReceipt }
      : resultWithStartupTerminal
    return warning ? { ...resultWithSetupReceipt, warning } : resultWithSetupReceipt
  }

  async createManagedWorktree(
    args: RuntimeManagedWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.deps.resolveRepoSelector(args.repoSelector)
    const createSettings = this.deps.store.getSettings()
    const requestedAgent = args.startupAgent ?? args.createdWithAgent
    const requestedAgentEnabled =
      requestedAgent !== undefined
        ? isTuiAgentEnabled(requestedAgent, createSettings.disabledTuiAgents)
        : false
    if ((args.startup || args.startupAgent) && requestedAgent && !requestedAgentEnabled) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    if (
      args.startup &&
      args.startupDraftPaste &&
      !isTuiAgentEnabled(args.startupDraftPaste.agent, createSettings.disabledTuiAgents)
    ) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    const agentStartup =
      !args.startup && args.startupAgent
        ? this.deps.buildStartupForAgent(
            repo,
            args.startupAgent,
            args.startupPrompt,
            args.startupLaunchPreferences
          )
        : null
    const draftStartup =
      !args.startup && !agentStartup && args.startupDraft
        ? await this.deps.buildStartupForDraft(repo, args.startupDraft, requestedAgent)
        : null
    const effectiveStartup = args.startup ?? agentStartup?.startup ?? draftStartup?.startup
    const effectiveStartupFollowup = agentStartup?.followup
    const effectiveCreatedWithAgent = args.startup
      ? args.createdWithAgent
      : (agentStartup?.agent ??
        draftStartup?.agent ??
        (requestedAgentEnabled ? requestedAgent : undefined))
    const effectiveDraftPaste = args.startupDraftPaste ?? draftStartup?.draftPaste
    if (isFolderRepo(repo)) {
      const now = Date.now()
      const settings = createSettings
      const instanceId = randomUUID()
      const worktreeId = getRuntimeFolderWorkspaceInstanceId(repo, instanceId)
      const meta = this.deps.store.setWorktreeMeta(worktreeId, {
        instanceId,
        ...getProjectHostSetupWorktreeMeta(this.deps.store.getProjectHostSetups?.() ?? [], repo),
        displayName: args.displayName?.trim() || args.name,
        lastActivityAt: now,
        createdAt: now,
        orcaCreatedAt: now,
        orcaCreationSource: 'runtime',
        orcaCreationWorkspaceLayout: {
          path: settings.workspaceDir,
          nestWorkspaces: settings.nestWorkspaces
        },
        ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
        ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
        creatorProvenance: args.creatorProvenance ?? { kind: 'host' },
        ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
        ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
        ...(args.linkedLinearIssue !== undefined
          ? { linkedLinearIssue: args.linkedLinearIssue }
          : {}),
        ...(args.linkedLinearIssueWorkspaceId !== undefined
          ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
          : {}),
        ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
          ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
          : {}),
        ...(args.linkedGitLabIssue !== undefined
          ? { linkedGitLabIssue: args.linkedGitLabIssue }
          : {}),
        ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
        ...(args.linkedBitbucketPR !== undefined
          ? { linkedBitbucketPR: args.linkedBitbucketPR }
          : {}),
        ...(args.linkedAzureDevOpsPR !== undefined
          ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
          : {}),
        ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
        ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
        ...(args.linkedTaskSourceContext !== undefined
          ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
          : {}),
        ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
        ...(args.comment !== undefined ? { comment: args.comment } : {}),
        ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
        ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
      })
      const worktree = mergeRuntimeFolderWorkspace(repo, worktreeId, meta)
      this.deps.invalidateResolvedWorktreeCache()
      this.notifyWorktreesChanged(repo.id)
      this.emitWorktreeLifecycle({
        kind: 'created',
        worktreeId: worktree.id,
        path: worktree.path,
        branch: worktree.branch
      })
      const shouldActivate = args.activate === true || args.runHooks === true
      let warning: string | undefined
      let didSpawnStartup = false
      let startupTerminal: CreateWorktreeResult['startupTerminal']
      if (effectiveStartup && this.deps.ptyController?.spawn) {
        try {
          const startupTrustAgent = effectiveDraftPaste?.agent ?? effectiveCreatedWithAgent
          if (startupTrustAgent) {
            await this.deps.markLocalWorkspaceTrustedForAgent(startupTrustAgent, worktree.path)
          }
          const terminal = await this.deps.createTerminal(`id:${worktree.id}`, {
            command: effectiveStartup.command,
            env: effectiveStartup.env,
            ...(effectiveStartup.launchConfig
              ? { launchConfig: effectiveStartup.launchConfig }
              : {}),
            ...(effectiveCreatedWithAgent ? { launchAgent: effectiveCreatedWithAgent } : {}),
            ...(effectiveStartup.viewMode ? { viewMode: effectiveStartup.viewMode } : {}),
            startupCommandDelivery: effectiveStartup.startupCommandDelivery,
            telemetry: effectiveStartup.telemetry,
            ...ownerSurfacing(shouldActivate)
          })
          if (effectiveDraftPaste) {
            this.deps.pasteStartupDraftWhenReady(terminal.handle, effectiveDraftPaste)
          }
          if (effectiveStartupFollowup) {
            this.deps.sendStartupFollowupWhenReady(terminal.handle, effectiveStartupFollowup)
          }
          didSpawnStartup = true
          startupTerminal = {
            spawned: true,
            handle: terminal.handle,
            ...(terminal.tabId ? { tabId: terminal.tabId } : {}),
            ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
            ...(terminal.ptyId ? { ptyId: terminal.ptyId } : {}),
            surface: 'background'
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          warning = `Failed to create the startup terminal for ${worktree.path}: ${message}`
          console.warn(`[worktree-create] ${warning}`)
        }
      }
      if (shouldActivate) {
        if (effectiveStartup && !didSpawnStartup) {
          this.notifyActivateWorktree(repo.id, worktree.id, {
            startup: effectiveStartup,
            navigationTarget: args.navigation
          })
        } else {
          this.notifyActivateWorktree(repo.id, worktree.id, {
            navigationTarget: args.navigation
          })
        }
      } else if (this.deps.ptyController?.spawn && !didSpawnStartup) {
        try {
          await this.deps.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          warning = warning
            ? `${warning} Also failed to create the initial terminal for ${worktree.path}: ${message}`
            : `Failed to create the initial terminal for ${worktree.path}: ${message}`
          console.warn(`[worktree-create] ${warning}`)
        }
      }
      return {
        worktree: {
          ...worktree,
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          git: {
            path: worktree.path,
            head: worktree.head,
            branch: worktree.branch,
            isBare: worktree.isBare,
            isMainWorktree: worktree.isMainWorktree
          }
        },
        ...(startupTerminal ? { startupTerminal } : {}),
        ...(warning ? { warning } : {})
      }
    }
    const lineageInput =
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined
    const lineageResolution = await this.resolveLineageForWorktreeCreate(lineageInput)
    if (repo.connectionId) {
      const result = await this.createManagedRemoteWorktree(repo, {
        ...args,
        activate: args.activate,
        ...(effectiveStartup ? { startup: effectiveStartup } : {}),
        ...(effectiveStartupFollowup ? { startupFollowup: effectiveStartupFollowup } : {}),
        ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
        ...(effectiveDraftPaste ? { startupDraftPaste: effectiveDraftPaste } : {})
      })
      const recordedLineage = this.recordCreatedWorktreeLineage(result.worktree, lineageResolution)
      this.emitWorktreeLifecycle({
        kind: 'created',
        worktreeId: result.worktree.id,
        path: result.worktree.path,
        branch: result.worktree.branch
      })
      return {
        ...result,
        worktree: {
          ...result.worktree,
          parentWorktreeId: recordedLineage.lineage?.parentWorktreeId ?? null,
          childWorktreeIds: result.worktree.childWorktreeIds ?? [],
          lineage: recordedLineage.lineage,
          workspaceLineage: recordedLineage.workspaceLineage
        },
        ...(lineageInput
          ? {
              lineage: recordedLineage.lineage,
              workspaceLineage: recordedLineage.workspaceLineage,
              warnings: recordedLineage.warnings
            }
          : {})
      }
    }
    const settings = createSettings
    const worktreePathSettings = getWorktreePathSettings(repo, settings)
    const localGitExecOptions = getLocalProjectGitExecOptions(this.deps.requireStore(), repo)
    const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(
      this.deps.requireStore(),
      repo
    )
    const hasLocalWorktreeGitOptions = hasLocalGitOptions(localWorktreeGitOptions)
    const localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }] = hasLocalWorktreeGitOptions
      ? [localWorktreeGitOptions]
      : []
    const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions | undefined => {
      if (!hasLocalWorktreeGitOptions) {
        return options
      }
      return { ...options, ...localWorktreeGitOptions }
    }
    const hostedReviewExecutionContext = this.deps.getHostedReviewExecutionOptions(repo)
    let effectiveRequestedName = args.name
    const requestedDisplayName = args.displayName?.trim() || undefined
    const sanitizedName = sanitizeWorktreeName(args.name)
    let effectiveSanitizedName = sanitizedName
    // Why: explicit branches and non-username prefix modes never consume this
    // value; skipping the probes preserves the exact generated branch name.
    const username =
      !args.branchNameOverride && settings.branchPrefix === 'git-username'
        ? await resolveLocalGitUsername(repo.path)
        : ''

    const baseBranch = await resolveWorktreeCreateBase({
      requestedBaseBranch: args.baseBranch,
      repoWorktreeBaseRef: repo.worktreeBaseRef,
      resolveDefaultBaseRef: () =>
        hasLocalWorktreeGitOptions
          ? resolveDefaultBaseRefWithLocalGit(localGitExecOptions)
          : getBaseRefDefault(repo.path),
      isBaseUsable: async (baseBranchCandidate) => {
        const remoteTrackingBase = await this.deps.resolveRemoteTrackingBase(
          repo.path,
          baseBranchCandidate,
          localWorktreeGitOptionArgs[0] ?? {}
        )
        if (remoteTrackingBase) {
          if (
            await this.deps.hasRemoteTrackingRef(
              repo.path,
              remoteTrackingBase,
              localWorktreeGitOptionArgs[0] ?? {}
            )
          ) {
            return true
          }
          return hasLocalWorktreeBaseRef(
            repo.path,
            baseBranchCandidate,
            hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {}
          )
        }
        return hasLocalWorktreeBaseRef(
          repo.path,
          baseBranchCandidate,
          hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {}
        )
      }
    })
    if (!baseBranch) {
      // Why: a null default means no suitable ref exists; fail clearly instead
      // of handing Git a fabricated origin/main ref.
      throw new Error(
        'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.'
      )
    }

    const workspaceRoot = computeWorkspaceRoot(repo.path, worktreePathSettings)
    // Why: CLI-managed WSL worktrees live under ~/orca/workspaces inside the
    // distro filesystem through computeWorkspaceRoot. If home lookup fails,
    // still validate against the effective workspace dir.
    let branchName = ''
    let checkoutExistingBranch = false
    let selectedExistingLocalBranchName: string | null = null
    let branchConflictKind: 'local' | 'remote' | null = null
    let worktreePath = ''
    let worktreePathResolved = false
    const shouldRetireGeneratedName =
      args.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
    const retiredNameRegistry = shouldRetireGeneratedName
      ? await getRetiredNameRegistryForRepo(
          this.deps.store,
          repo,
          this.deps.store.getRepos(),
          settings
        )
      : null
    const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
    // Why: runtime/mobile create-from-review callers should get a new workspace
    // even when the PR branch or review branch name is already in use.
    for (
      let suffix = 1, attempts = 0;
      attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS;
      suffix += 1
    ) {
      effectiveSanitizedName = shouldRetireGeneratedName
        ? getGeneratedWorktreeCreateCandidate(
            sanitizedName,
            suffix,
            retiredNameRegistry?.exhaustedTiers
          )
        : getWorktreeCreateCandidate(sanitizedName, suffix)
      effectiveRequestedName = shouldRetireGeneratedName
        ? effectiveSanitizedName
        : args.name.trim()
          ? getWorktreeCreateCandidate(args.name, suffix)
          : effectiveSanitizedName
      if (isRetiredName?.(effectiveSanitizedName)) {
        continue
      }
      attempts += 1
      branchName = await resolveCreateBranchName(
        repo.path,
        selectedExistingLocalBranchName ??
          getBranchNameOverrideCandidate(args.branchNameOverride, suffix),
        effectiveSanitizedName,
        settings,
        username,
        localWorktreeGitOptions
      )
      checkoutExistingBranch = await canCheckoutExistingLocalBranch(
        repo.path,
        branchName,
        baseBranch,
        localWorktreeGitOptionArgs[0] ?? {}
      )
      if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
        // Why: once a user-selected branch is safe to reuse, path retries should
        // keep that branch exact instead of creating a sibling branch.
        selectedExistingLocalBranchName = branchName
      }
      branchConflictKind = checkoutExistingBranch
        ? null
        : await getBranchConflictKind(
            repo.path,
            branchName,
            baseBranch,
            localWorktreeGitOptionArgs[0] ?? {}
          )
      const allowedPushTargetRemoteConflict =
        branchConflictKind &&
        isAllowedPushTargetRemoteConflict(branchConflictKind, branchName, args)
      let selectedReviewConflictMatched = false
      if (branchConflictKind) {
        if (allowedPushTargetRemoteConflict) {
          let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
          const selectedReview = getSelectedReviewBranch(args)
          if (selectedReview?.provider === 'github') {
            try {
              existingPR = await getLocalGitHubPrForBranch(
                repo.path,
                branchName,
                localWorktreeGitOptions
              )
            } catch {
              // Retry with a suffixed branch when selected review verification is unavailable.
            }
            if (isMatchingSelectedGitHubPr(existingPR, args, branchName)) {
              branchConflictKind = null
              selectedReviewConflictMatched = true
            }
          } else if (selectedReview) {
            const hostedReview = await getSelectedHostedReviewForBranch(
              repo,
              branchName,
              args,
              hostedReviewExecutionContext
            ).catch(() => null)
            if (hostedReview?.matchesSelected) {
              branchConflictKind = null
              selectedReviewConflictMatched = true
            }
          }
        }
        if (branchConflictKind) {
          continue
        }
      }

      if (!checkoutExistingBranch && !selectedReviewConflictMatched) {
        let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
        try {
          existingPR = await getLocalGitHubPrForBranch(
            repo.path,
            branchName,
            localWorktreeGitOptions
          )
        } catch {
          // Why: GitHub reachability should not block creating a suffixed
          // workspace; git conflicts still decide whether this candidate works.
        }
        if (existingPR && !isMatchingSelectedGitHubPr(existingPR, args, branchName)) {
          continue
        }
      }
      worktreePath = ensurePathWithinWorkspace(
        computeWorktreePath(effectiveSanitizedName, repo.path, worktreePathSettings),
        workspaceRoot
      )
      if (!(await pathExists(worktreePath))) {
        worktreePathResolved = true
        break
      }
    }
    if (!worktreePathResolved) {
      if (branchConflictKind) {
        throw new Error(
          `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}.`
        )
      }
      throw new Error(
        `Could not find an available worktree path for "${sanitizedName}". Pick a different worktree name.`
      )
    }
    let remoteTrackingBase = await this.deps.resolveRemoteTrackingBase(
      repo.path,
      baseBranch,
      localWorktreeGitOptionArgs[0] ?? {}
    )
    if (remoteTrackingBase) {
      const hadRemoteTrackingBaseRef = await this.deps.hasRemoteTrackingRef(
        repo.path,
        remoteTrackingBase,
        localWorktreeGitOptionArgs[0] ?? {}
      )
      const hasLocalBaseRef =
        hadRemoteTrackingBaseRef ||
        (await hasLocalWorktreeBaseRef(
          repo.path,
          baseBranch,
          hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {}
        ))
      if (!hadRemoteTrackingBaseRef && hasLocalBaseRef) {
        remoteTrackingBase = null
      } else {
        const refreshResult = await this.deps.getOrStartRemoteTrackingBaseRefresh(
          repo.path,
          remoteTrackingBase,
          localWorktreeGitOptionArgs[0] ?? {}
        )
        if (!refreshResult.ok && !hadRemoteTrackingBaseRef) {
          // Why: only block creation when the refresh failed AND there is no
          // usable local base ref to fall back on. If a local remote-tracking ref
          // already exists, `git worktree add` can create from it — a possibly
          // stale but valid base — so a transient offline/auth failure must not
          // make the workspace uncreatable. The compare-to-base view reflects any
          // drift once the remote is reachable again.
          throw new Error(
            `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
          )
        }
        if (
          !hadRemoteTrackingBaseRef &&
          !(await this.deps.hasRemoteTrackingRef(
            repo.path,
            remoteTrackingBase,
            localWorktreeGitOptionArgs[0] ?? {}
          ))
        ) {
          throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
        }
      }
    } else if (
      !(await hasLocalWorktreeBaseRef(
        repo.path,
        baseBranch,
        hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {}
      ))
    ) {
      // Why: local bases keep legacy best-effort fetch behavior. Verified PR
      // SHA bases already have the commit object needed by `git worktree add`.
      try {
        await this.deps.fetchRemoteWithCache(
          repo.path,
          'origin',
          localWorktreeGitOptionArgs[0] ?? {}
        )
      } catch {
        // Why: belt-and-suspenders. fetchRemoteWithCache already logs and does
        // not throw; the outer try/catch guarantees create-path tolerance even
        // if future refactors change that contract.
      }
    }

    const sparseDirectories = args.sparseCheckout
      ? normalizeSparseDirectories(args.sparseCheckout.directories)
      : []
    if (args.sparseCheckout && sparseDirectories.length === 0) {
      throw new Error('Sparse checkout requires at least one repo-relative directory.')
    }

    let preparedPushTarget: GitPushTarget | undefined
    if (args.pushTarget) {
      // Why: fork-PR worktrees created through a remote runtime need the same
      // upstream target setup as local desktop creates, or Push would publish
      // to the wrong remote after the client/server split.
      preparedPushTarget = await prepareWorktreePushTarget(
        repo.path,
        args.pushTarget,
        this.deps.store,
        repo.id,
        localWorktreeGitOptions
      )
    }

    const suggestLocalBaseRefUpdate =
      !settings.refreshLocalBaseRefOnWorktreeCreate &&
      !settings.localBaseRefSuggestionDismissed &&
      Boolean(remoteTrackingBase)
    const remoteTrackingBaseOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
    const existingBranchOption = {
      checkoutExistingBranch,
      ...remoteTrackingBaseOption,
      ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {})
    }
    const defaultAddWorktreeOption = addProjectGitOptions()
    let addResult: AddWorktreeResult
    try {
      addResult =
        (await (sparseDirectories.length > 0
          ? checkoutExistingBranch
            ? addSparseWorktree(
                repo.path,
                worktreePath,
                branchName,
                sparseDirectories,
                baseBranch,
                settings.refreshLocalBaseRefOnWorktreeCreate,
                addProjectGitOptions(existingBranchOption)
              )
            : suggestLocalBaseRefUpdate
              ? addSparseWorktree(
                  repo.path,
                  worktreePath,
                  branchName,
                  sparseDirectories,
                  baseBranch,
                  settings.refreshLocalBaseRefOnWorktreeCreate,
                  addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
                )
              : remoteTrackingBaseOption
                ? addSparseWorktree(
                    repo.path,
                    worktreePath,
                    branchName,
                    sparseDirectories,
                    baseBranch,
                    settings.refreshLocalBaseRefOnWorktreeCreate,
                    addProjectGitOptions(remoteTrackingBaseOption)
                  )
                : defaultAddWorktreeOption
                  ? addSparseWorktree(
                      repo.path,
                      worktreePath,
                      branchName,
                      sparseDirectories,
                      baseBranch,
                      settings.refreshLocalBaseRefOnWorktreeCreate,
                      defaultAddWorktreeOption
                    )
                  : addSparseWorktree(
                      repo.path,
                      worktreePath,
                      branchName,
                      sparseDirectories,
                      baseBranch,
                      settings.refreshLocalBaseRefOnWorktreeCreate
                    )
          : checkoutExistingBranch
            ? addWorktree(
                repo.path,
                worktreePath,
                branchName,
                baseBranch,
                settings.refreshLocalBaseRefOnWorktreeCreate,
                false,
                addProjectGitOptions(existingBranchOption)
              )
            : suggestLocalBaseRefUpdate
              ? addWorktree(
                  repo.path,
                  worktreePath,
                  branchName,
                  baseBranch,
                  settings.refreshLocalBaseRefOnWorktreeCreate,
                  false,
                  addProjectGitOptions({ ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate })
                )
              : remoteTrackingBaseOption
                ? addWorktree(
                    repo.path,
                    worktreePath,
                    branchName,
                    baseBranch,
                    settings.refreshLocalBaseRefOnWorktreeCreate,
                    false,
                    addProjectGitOptions(remoteTrackingBaseOption)
                  )
                : defaultAddWorktreeOption
                  ? addWorktree(
                      repo.path,
                      worktreePath,
                      branchName,
                      baseBranch,
                      settings.refreshLocalBaseRefOnWorktreeCreate,
                      false,
                      defaultAddWorktreeOption
                    )
                  : addWorktree(
                      repo.path,
                      worktreePath,
                      branchName,
                      baseBranch,
                      settings.refreshLocalBaseRefOnWorktreeCreate
                    ))) ?? {}
    } catch (error) {
      if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
        await retireGeneratedWorktreeName(this.deps.store, repo, settings, effectiveSanitizedName)
      }
      throw error
    }

    // Why: fallible metadata work after creation must not leave a real workspace name reusable.
    if (shouldRetireGeneratedName) {
      await retireGeneratedWorktreeName(this.deps.store, repo, settings, effectiveSanitizedName)
    }

    let configuredPushTarget: GitPushTarget | undefined
    if (preparedPushTarget) {
      configuredPushTarget = await configureCreatedWorktreePushTarget(
        worktreePath,
        branchName,
        preparedPushTarget,
        localWorktreeGitOptions
      )
    }

    const gitWorktrees = hasLocalWorktreeGitOptions
      ? await listWorktrees(repo.path, localWorktreeGitOptions)
      : await listWorktrees(repo.path)
    // Why: Git may canonicalize a symlinked create path; its exact branch identifies the listed row.
    const created = findCreatedWorktree(gitWorktrees, worktreePath, branchName)
    if (!created) {
      throw new Error('Worktree created but not found in listing')
    }

    const worktreeId = `${repo.id}::${created.path}`
    const now = Date.now()
    // Why: PR/MR-created worktrees can start from a head ref/SHA while Source
    // Control must compare against the review target branch.
    const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
    const displayNameMeta = requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
        ? { displayName: effectiveRequestedName }
        : {}
    const meta = this.deps.store.setWorktreeMeta(worktreeId, {
      // Why: worktree IDs are path-derived. If a path is deleted outside Orca
      // and later recreated, creation must mint a fresh instance identity so
      // stale lineage records tied to the old occupant fail validation.
      instanceId: randomUUID(),
      ...getProjectHostSetupWorktreeMeta(this.deps.store.getProjectHostSetups?.() ?? [], repo),
      lastActivityAt: now,
      // See createRemoteWorktree: createdAt grants the new worktree a grace
      // window in Recent sort so ambient PTY bumps in OTHER worktrees can't
      // push it down before the user has had a chance to notice it. Smart-sort
      // uses max(lastActivityAt, createdAt + CREATE_GRACE_MS).
      createdAt: now,
      orcaCreatedAt: now,
      orcaCreationSource: 'runtime',
      orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
      ...displayNameMeta,
      baseRef: metadataBaseRef,
      ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
      ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
      ...(sparseDirectories.length > 0
        ? {
            sparseDirectories,
            sparseBaseRef: metadataBaseRef,
            sparsePresetId: args.sparseCheckout?.presetId
          }
        : {}),
      ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
      ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
      ...(args.linkedLinearIssue !== undefined
        ? { linkedLinearIssue: args.linkedLinearIssue }
        : {}),
      ...(args.linkedLinearIssueWorkspaceId !== undefined
        ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
        : {}),
      ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
        ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
        : {}),
      ...(args.linkedGitLabIssue !== undefined
        ? { linkedGitLabIssue: args.linkedGitLabIssue }
        : {}),
      ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
      ...(args.linkedBitbucketPR !== undefined
        ? { linkedBitbucketPR: args.linkedBitbucketPR }
        : {}),
      ...(args.linkedAzureDevOpsPR !== undefined
        ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
        : {}),
      ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
      ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
      ...(args.linkedTaskSourceContext !== undefined
        ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
        : {}),
      ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
      ...(args.pendingFirstAgentMessageRename === true && effectiveCreatedWithAgent
        ? { pendingFirstAgentMessageRename: true }
        : {}),
      ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
      ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
      creatorProvenance: args.creatorProvenance ?? { kind: 'host' },
      ...(args.comment !== undefined ? { comment: args.comment } : {}),
      ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
      ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
    })
    const worktree = {
      ...mergeWorktree(repo.id, created, meta),
      hostId: meta.hostId ?? getRepoExecutionHostId(repo)
    }
    const {
      lineage,
      workspaceLineage,
      warnings: lineageWarnings
    } = this.recordCreatedWorktreeLineage(worktree, lineageResolution)

    const symlinkPaths = repo.symlinkPaths ?? []
    if (symlinkPaths.length > 0) {
      await createWorktreeLinkedPaths(repo.path, created.path, symlinkPaths)
    }

    // Why: project-level `orca.yaml` shared directories add to (never replace) the
    // per-user setting, so a repo's shared dirs reach every teammate (issue #10451).
    const sharedDirectories = await resolveWorktreeSharedDirectories(
      repo.path,
      localWorktreeGitOptions
    )
    if (sharedDirectories.length > 0) {
      await createWorktreeSharedPaths(repo.path, created.path, sharedDirectories)
    }

    // Why: project-level `.worktreeinclude` travels with the repo (issue #7549); copy semantics
    // (never symlink) so each worktree owns its files. Paths already linked above are skipped.
    const worktreeIncludePaths = await resolveWorktreeIncludePaths(
      repo.path,
      localWorktreeGitOptions
    )
    let includeCopyWarning: string | undefined
    if (worktreeIncludePaths.length > 0) {
      const skippedIncludePaths = await createWorktreeCopiedPaths(
        repo.path,
        created.path,
        worktreeIncludePaths
      )
      includeCopyWarning = formatWorktreeIncludeCopyWarning(skippedIncludePaths)
      if (includeCopyWarning) {
        console.warn(`[worktree-include] ${includeCopyWarning}`)
      }
    }

    let setup: CreateWorktreeResult['setup']
    let warning: string | undefined = includeCopyWarning
    // Why: CLI-created worktrees do not have a renderer preview to mismatch
    // against. Trust is granted by the direct CLI invocation (`--run-hooks`),
    // so loading the setup hook from the created worktree is intentional here.
    const yamlHooks = loadHooks(worktreePath)
    const hooks = getEffectiveHooks(repo, worktreePath)
    // Why: setupDecision lets mobile/CLI callers control whether the setup
    // script runs. 'skip' suppresses it, 'run' forces it, 'inherit' (default)
    // defers to the repo's orca.yaml setupRunPolicy. runHooks === true maps
    // to 'run' for backwards compatibility with the desktop create flow.
    const effectiveDecision = args.runHooks ? 'run' : (args.setupDecision ?? 'inherit')
    let defaultTabs: CreateWorktreeResult['defaultTabs']
    try {
      defaultTabs = getDefaultTabsLaunch(yamlHooks, repo, effectiveDecision)
    } catch (error) {
      console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
      defaultTabs = yamlHooks?.defaultTabs
        ? { tabs: yamlHooks.defaultTabs, runCommands: false }
        : undefined
    }
    const shouldRunSetup = hooks?.scripts.setup && shouldRunSetupForCreate(repo, effectiveDecision)
    // Why: the in-process hook uses a hardcoded cmd/bash shell, so it can only run
    // when nothing downstream is able to launch the shell-aware runner script.
    let didStartInProcessSetupHook = false
    if (shouldRunSetup && hooks?.scripts.setup) {
      const shouldUseSetupRunner =
        this.deps.authoritativeWindowId() !== null ||
        Boolean(effectiveStartup) ||
        Boolean(this.deps.ptyController?.spawn)
      if (shouldUseSetupRunner) {
        try {
          // Why: setup+startup must share the terminal runner path even without
          // a renderer window, so the startup shell can wait on setup completion
          // and windowless creates resolve the same Windows setup shell.
          const runtimeTarget = this.deps.getLocalGitExecutionOptionArgs(repo)[0]
          setup = createSetupRunnerScript(
            repo,
            worktreePath,
            hooks.scripts.setup,
            runtimeTarget,
            resolveSetupRunnerShell(settings),
            yamlHooks?.setupAgentStartupPolicy
          )
        } catch (error) {
          // Why: the git worktree is already real at this point. If runner
          // generation fails, keep creation successful and surface the problem in
          // logs rather than pretending the worktree was never created.
          console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
        }
      } else {
        didStartInProcessSetupHook = true
        void runHook(
          'setup',
          worktreePath,
          repo,
          worktreePath,
          this.deps.getLocalGitExecutionOptionArgs(repo)[0]
        ).then((result) => {
          if (!result.success) {
            console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
          }
        })
      }
    } else if (hooks?.scripts.setup && effectiveDecision !== 'skip') {
      // Runtime RPC calls have no renderer trust prompt, so hooks require explicit CLI opt-in.
      const setupSkipped = `orca.yaml setup hook skipped for ${worktreePath}; pass --setup run to run it.`
      warning = warning ? `${warning} Also ${setupSkipped}` : setupSkipped
      console.warn(`[hooks] ${setupSkipped}`)
    }

    this.deps.invalidateResolvedWorktreeCache()
    this.deps.invalidateWorktreeScanCacheForRepo(repo.id)
    // Why: the filesystem-auth layer maintains a separate cache of registered
    // worktree roots used by git IPC handlers (branchCompare, diff, status, etc.)
    // to authorize paths. Without invalidating it here, CLI-created worktrees
    // are not recognized and all git operations fail with "Access denied:
    // unknown repository or worktree path".
    invalidateAuthorizedRootsCache()

    this.notifyWorktreesChanged(repo.id)
    const shouldActivate = args.activate === true || args.runHooks === true
    let didSpawnStartup = false
    // Why: tracks whether runtime itself launched the setup script (via
    // provisionManagedWorktreeTerminals). When true, renderer activation and the
    // RPC return value must omit setup so the client does not spawn it a second
    // time. Mirrors the wait-for-agent setup contract from #6298.
    let didSpawnSetup = false
    let setupTerminalHandle: string | null = null
    let startupTerminalHandle: string | null = null
    let startupTerminalTabId: string | null = null
    let startupTerminalPaneKey: string | null = null
    let startupTerminalPtyId: string | null = null

    let sequencedStartup = effectiveStartup
    let wrappedSetupCommandStr: string | undefined
    if (effectiveStartup && setup?.waitForAgentStartup === true) {
      const platform = getSetupRunnerCommandPlatformForLaunch(
        setup,
        process.platform === 'win32' ? 'windows' : 'posix'
      )
      const sequenced = createSequencedSetupAgentCommands({
        runnerScriptPath: setup.runnerScriptPath,
        startupCommand: effectiveStartup.command,
        platform,
        shell: setup.shell
      })
      sequencedStartup = {
        ...effectiveStartup,
        command: sequenced.startupCommand,
        ...(sequenced.startupEnv
          ? { env: { ...effectiveStartup.env, ...sequenced.startupEnv } }
          : {})
      }
      wrappedSetupCommandStr = sequenced.setupCommand
    }

    if (sequencedStartup && this.deps.ptyController?.spawn) {
      try {
        // Why: automation startup must not depend on a renderer TerminalPane
        // mounting. Runtime-spawned PTYs run immediately and the UI adopts the
        // session later, matching `orca terminal create` background semantics.
        const startupTrustAgent = effectiveDraftPaste?.agent ?? effectiveCreatedWithAgent
        if (startupTrustAgent) {
          await this.deps.markLocalWorkspaceTrustedForAgent(startupTrustAgent, worktreePath)
        }
        const terminal = await this.deps.createTerminal(`id:${worktree.id}`, {
          command: sequencedStartup.command,
          ...(setup && effectiveStartup
            ? { claudeAgentTeamsSourceCommand: effectiveStartup.command }
            : {}),
          env: sequencedStartup.env,
          ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
          ...(effectiveCreatedWithAgent ? { launchAgent: effectiveCreatedWithAgent } : {}),
          ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
          startupCommandDelivery: sequencedStartup.startupCommandDelivery,
          telemetry: sequencedStartup.telemetry,
          ...ownerSurfacing(shouldActivate)
        })
        if (effectiveDraftPaste) {
          this.deps.pasteStartupDraftWhenReady(terminal.handle, effectiveDraftPaste)
        }
        if (effectiveStartupFollowup) {
          this.deps.sendStartupFollowupWhenReady(terminal.handle, effectiveStartupFollowup)
        }
        didSpawnStartup = true
        startupTerminalHandle = terminal.handle
        startupTerminalTabId = terminal.tabId ?? null
        startupTerminalPaneKey = terminal.paneKey ?? null
        startupTerminalPtyId = terminal.ptyId ?? null
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the startup terminal for ${worktreePath}: ${message}`
          : `Failed to create the startup terminal for ${worktreePath}: ${message}`
        console.warn(`[worktree-create] ${warning}`)
      }
    }
    if (shouldActivate) {
      // Why: plain CLI creates should not steal the user's current workspace.
      // Explicit activation and hook-running still use renderer activation so
      // the user can watch prompts/output in a visible pane.
      const runtimeWillProvisionTerminals = didSpawnStartup && Boolean(setup || defaultTabs)
      if (runtimeWillProvisionTerminals) {
        // Why: once runtime spawned the startup PTY, renderer activation may see
        // an existing terminal and skip setup/default tabs. Await provisioning so
        // a failed setup spawn falls back to renderer activation (which still
        // carries the wrapped command for retry); #6298's wait-for-setup
        // guarantee is enforced by the shell marker, not by spawn timing.
        const provisioned = await this.provisionManagedWorktreeTerminals({
          worktreeSelector: `id:${worktree.id}`,
          worktreeId: worktree.id,
          worktreePath,
          ...(setup ? { setup } : {}),
          ...(defaultTabs ? { defaultTabs } : {}),
          primaryTerminalHandle: startupTerminalHandle,
          hasStartupTerminal: didSpawnStartup,
          setupCommandPlatform: getSetupRunnerCommandPlatformForLaunch(setup, 'posix'),
          observeSetupCompletion: args.observeSetupCompletion,
          // Why: carry the wait-for-agent wrapped setup command (#6298) so the
          // Setup tab runs the same script the sequenced agent waits on.
          ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {})
        })
        didSpawnSetup = provisioned.setupSpawned
        setupTerminalHandle = provisioned.setupTerminalHandle
      }
      // Why: when runtime spawned setup, omit it from activation. When setup
      // spawn failed, fall through with the wrapped command so renderer
      // activation retries it.
      const activationSetup = didSpawnSetup
        ? undefined
        : setup
          ? {
              ...setup,
              ...(didSpawnStartup && wrappedSetupCommandStr
                ? { command: wrappedSetupCommandStr }
                : {})
            }
          : undefined
      const activationDefaultTabs = runtimeWillProvisionTerminals ? undefined : defaultTabs
      if (effectiveStartup && !didSpawnStartup) {
        this.notifyActivateWorktree(repo.id, worktree.id, {
          setup: activationSetup,
          startup: effectiveStartup,
          defaultTabs: activationDefaultTabs,
          navigationTarget: args.navigation
        })
      } else {
        this.notifyActivateWorktree(repo.id, worktree.id, {
          setup: activationSetup,
          defaultTabs: activationDefaultTabs,
          navigationTarget: args.navigation
        })
      }
    } else if (this.deps.ptyController?.spawn && (setup || defaultTabs || didSpawnStartup)) {
      // Why: inactive terminal materialization matches normal worktree creation,
      // but setup/default tab failures must not gate automation dispatch.
      const provisioning = this.provisionManagedWorktreeTerminals({
        worktreeSelector: `id:${worktree.id}`,
        worktreeId: worktree.id,
        worktreePath,
        ...(setup ? { setup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        primaryTerminalHandle: startupTerminalHandle,
        hasStartupTerminal: didSpawnStartup,
        setupCommandPlatform: getSetupRunnerCommandPlatformForLaunch(setup, 'posix'),
        observeSetupCompletion: args.observeSetupCompletion,
        ...(wrappedSetupCommandStr ? { wrappedSetupCommand: wrappedSetupCommandStr } : {}),
        surfaceOwner: false
      })
      // Why: runtime owns setup spawning here, so the RPC result must omit setup
      // to keep the headless/mobile caller from launching it a second time.
      if (args.awaitTerminalProvisioning) {
        const provisioned = await provisioning
        didSpawnSetup = provisioned.setupSpawned
        setupTerminalHandle = provisioned.setupTerminalHandle
      } else {
        void provisioning
        if (setup) {
          didSpawnSetup = true
        }
      }
    } else if (this.deps.ptyController?.spawn) {
      try {
        await this.deps.createTerminal(`id:${worktree.id}`, { surfaceOwner: false })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warning = warning
          ? `${warning} Also failed to create the initial terminal for ${worktreePath}: ${message}`
          : `Failed to create the initial terminal for ${worktreePath}: ${message}`
        console.warn(`[worktree-create] ${warning}`)
      }
    }
    const returnedSetup = didSpawnSetup
      ? undefined
      : setup
        ? {
            ...setup,
            ...(didSpawnStartup && wrappedSetupCommandStr
              ? { command: wrappedSetupCommandStr }
              : {})
          }
        : undefined
    this.emitWorktreeLifecycle({
      kind: 'created',
      worktreeId: worktree.id,
      path: worktree.path,
      branch: worktree.branch
    })
    return {
      worktree: {
        ...worktree,
        parentWorktreeId: lineage?.parentWorktreeId ?? null,
        childWorktreeIds: [],
        lineage,
        workspaceLineage,
        git: created
      },
      ...(lineageInput ? { lineage, workspaceLineage, warnings: lineageWarnings } : {}),
      ...(returnedSetup ? { setup: returnedSetup } : {}),
      ...(args.awaitTerminalProvisioning
        ? {
            setupReceipt: {
              requested: effectiveDecision,
              hookFound: Boolean(hooks?.scripts.setup),
              startupPolicy: setup?.waitForAgentStartup
                ? ('wait-for-setup' as const)
                : ('start-immediately' as const),
              state: !hooks?.scripts.setup
                ? ('not_configured' as const)
                : effectiveDecision === 'skip' || !shouldRunSetup
                  ? ('skipped' as const)
                  : // Why: the in-process hook is already executing, so reporting
                    // spawn_failed would strand callers that retry on it.
                    didSpawnSetup || didStartInProcessSetupHook
                    ? ('running' as const)
                    : ('spawn_failed' as const),
              ...(setupTerminalHandle ? { terminalHandle: setupTerminalHandle } : {})
            }
          }
        : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(warning ? { warning } : {}),
      ...(addResult.localBaseRefRefresh
        ? { localBaseRefRefresh: addResult.localBaseRefRefresh }
        : {}),
      ...(addResult.localBaseRefUpdateSuggestion
        ? { localBaseRefUpdateSuggestion: addResult.localBaseRefUpdateSuggestion }
        : {}),
      ...(didSpawnStartup && startupTerminalHandle
        ? {
            startupTerminal: {
              spawned: true,
              handle: startupTerminalHandle,
              ...(startupTerminalTabId ? { tabId: startupTerminalTabId } : {}),
              ...(startupTerminalPaneKey ? { paneKey: startupTerminalPaneKey } : {}),
              ...(startupTerminalPtyId ? { ptyId: startupTerminalPtyId } : {}),
              surface: 'background' as const
            }
          }
        : {})
    }
  }

  dedupeWorktreeCreate<T>(
    repoSelector: string,
    clientMutationId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    if (!clientMutationId) {
      return run()
    }
    const key = `${repoSelector}\0${clientMutationId}`
    const inflight = this.worktreeCreateByMutationId.get(key)
    if (inflight) {
      return inflight as Promise<T>
    }
    const created = run()
    this.worktreeCreateByMutationId.set(key, created)
    const drop = (): void => {
      if (this.worktreeCreateByMutationId.get(key) === created) {
        this.worktreeCreateByMutationId.delete(key)
      }
    }
    void created.then(() => {
      setTimeout(drop, WORKTREE_CREATE_RESULT_TTL_MS).unref?.()
    }, drop)
    return created
  }

  getLivePtyIdsForWorktree(worktreeId: string, freshPtyIds?: ReadonlySet<string>): Set<string> {
    const ptyIds = new Set<string>()
    for (const leaf of this.deps.leaves().values()) {
      if (
        runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId) &&
        leaf.connected &&
        leaf.ptyId &&
        (!freshPtyIds || freshPtyIds.has(leaf.ptyId))
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.deps.ptysById().values()) {
      if (
        runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId) &&
        pty.connected &&
        (!freshPtyIds || freshPtyIds.has(pty.ptyId))
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    return ptyIds
  }

  // eslint-disable @typescript-eslint/no-explicit-any -- Delegation methods use any to forward arbitrary arguments
  getMobileSessionWorktreeIdsForPty() {
    return (this.deps.mobileTabSnapshots() as any).getMobileSessionWorktreeIdsForPty(
      ...(arguments as any)
    )
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed
      ? this.deps.leaves().get(this.deps.getLeafKey(parsed.tabId, parsed.leafId))
      : null
    return leaf?.worktreeId ?? this.deps.getPtyRecordForPaneKey(paneKey)?.worktreeId ?? null
  }

  getWorktreeIdForTerminalHandle(handle: string): string | null {
    return this.deps.hookAgentRowResolutionCommands().getWorktreeIdForTerminalHandle(handle)
  }

  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    const graphEpoch = this.deps.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.deps.assertStableReadyGraph(graphEpoch)
    for (const leaf of this.deps.leaves().values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        return true
      }
    }
    for (const pty of this.deps.ptysById().values()) {
      if (pty.worktreeId === worktree.id && pty.connected) {
        return true
      }
    }
    return false
  }

  invalidateSshWorktreeScanCache(targetId: string): void {
    this.deps.invalidateSshWorktreeScanCacheInternal(targetId)
  }

  async provisionManagedWorktreeTerminals(args: {
    worktreeSelector: string
    worktreeId: string
    worktreePath: string
    setup?: CreateWorktreeResult['setup']
    defaultTabs?: CreateWorktreeResult['defaultTabs']
    primaryTerminalHandle?: string | null
    hasStartupTerminal: boolean
    setupCommandPlatform: 'windows' | 'posix'
    observeSetupCompletion?: boolean
    // Why: when the agent startup is sequenced to wait for setup
    // (waitForAgentStartup), the startup PTY runs a wrapper that already embeds
    // the setup command. Pass that wrapped command through so the Setup tab runs
    // the same script the agent is waiting on instead of a bare runner.
    wrappedSetupCommand?: string
    // Why: a workspace provisioned in the background must not pull the sidebar
    // to itself; the user never asked to look at these tabs.
    surfaceOwner?: false
  }): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }> {
    if (!this.deps.ptyController?.spawn) {
      return { setupSpawned: false, setupTerminalHandle: null }
    }
    const surfacing = ownerSurfacing(args.surfaceOwner !== false)
    let setupSpawned = false
    let setupTerminalHandle: string | null = null
    try {
      const defaultTabHandles = await this.deps.createDefaultTabTerminals(
        args.worktreeSelector,
        args.worktreeId,
        args.defaultTabs,
        surfacing
      )
      let primaryTerminalHandle = args.primaryTerminalHandle ?? defaultTabHandles[0] ?? null
      const setupLaunchMode =
        (
          this.deps.requireStore().getSettings() as Partial<
            Pick<GlobalSettings, 'setupScriptLaunchMode'>
          >
        ).setupScriptLaunchMode ?? 'new-tab'
      if (!args.hasStartupTerminal && !primaryTerminalHandle) {
        const terminal = await this.deps.createTerminal(args.worktreeSelector, surfacing)
        primaryTerminalHandle = terminal.handle
      }
      if (args.setup) {
        const completionToken =
          args.observeSetupCompletion && !args.wrappedSetupCommand ? randomUUID() : null
        const observedCommand = completionToken
          ? buildObservedSetupCommand(
              args.setup.runnerScriptPath,
              args.setupCommandPlatform,
              completionToken,
              args.setup.shell
            )
          : null
        const setupCommand =
          args.wrappedSetupCommand ??
          observedCommand?.command ??
          buildSetupRunnerCommand(
            args.setup.runnerScriptPath,
            args.setupCommandPlatform,
            args.setup.shell
          )
        const setupEnv = { ...args.setup.envVars, ...observedCommand?.env }
        const shouldSplitSetup =
          primaryTerminalHandle &&
          (setupLaunchMode === 'split-vertical' || setupLaunchMode === 'split-horizontal')
        const setupTerminal = await (shouldSplitSetup
          ? this.deps.splitTerminal(primaryTerminalHandle!, {
              direction: setupLaunchMode === 'split-horizontal' ? 'horizontal' : 'vertical',
              command: setupCommand,
              env: setupEnv,
              activate: false,
              ...surfacing
            })
          : this.deps.createTerminal(args.worktreeSelector, {
              title: 'Setup',
              command: setupCommand,
              env: setupEnv,
              ...surfacing
            }))
        setupTerminalHandle = setupTerminal.handle
        setupSpawned = true
        const ptyId = this.deps.getLivePtyForHandle(setupTerminal.handle)?.pty.ptyId
        if (completionToken && ptyId) {
          this.deps.setupCompletionTokenByPtyId().set(ptyId, completionToken)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        `[worktree-create] Failed to create setup/default terminals for ${args.worktreePath}: ${message}`
      )
    }
    return { setupSpawned, setupTerminalHandle }
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  touchMobileSessionTabsForWorktree(worktreeId: string, options?: { immediate?: boolean }): void {
    return this.deps.mobileTabSnapshots().touchMobileSessionTabsForWorktree(worktreeId, options)
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
      pushTarget?: GitPushTarget | null
      lineage?: {
        parentWorktree?: string
        noParent?: boolean
      }
    }
  ) {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const { lineage, ...metaUpdates } = updates
    if (lineage?.parentWorktree) {
      this.deps.invalidateResolvedWorktreeCache()
      this.deps.invalidateWorktreeScanCacheForRepo(worktree.repoId)
    }
    const shouldClearPushTarget =
      Object.hasOwn(metaUpdates, 'pushTarget') && metaUpdates.pushTarget === null
    const normalizedMetaUpdates: Partial<WorktreeMeta> = shouldClearPushTarget
      ? { ...metaUpdates, pushTarget: undefined }
      : (metaUpdates as Partial<WorktreeMeta>)
    const persistedMetaUpdates: Partial<WorktreeMeta> = omitUndefinedProperties(
      normalizedMetaUpdates.displayName !== undefined
        ? {
            ...normalizedMetaUpdates,
            pendingFirstAgentMessageRename: false,
            firstAgentMessageRenameError: null
          }
        : normalizedMetaUpdates
    )
    if (shouldClearPushTarget) {
      // Why: omitUndefinedProperties protects ordinary optional RPC fields, but
      // pushTarget:null is an explicit request to remove persisted target metadata.
      persistedMetaUpdates.pushTarget = undefined
    }
    if (lineage?.noParent === true) {
      this.deps.store.removeWorktreeLineage?.(worktree.id)
      this.deps.store.removeWorkspaceLineage?.(worktreeWorkspaceKey(worktree.id))
    } else if (lineage?.parentWorktree) {
      const parent = await this.resolveWorktreeSelector(lineage.parentWorktree)

      this.deps.validateLineageParent(worktree, parent)
      if (!worktree.instanceId || !parent.instanceId) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'Worktree instance identity was unavailable.'
        )
      }
      if (!this.deps.store.setWorktreeLineage) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'Worktree lineage storage was unavailable.'
        )
      }
      const createdAt = Date.now()
      this.deps.store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt
      })
      this.deps.store.setWorkspaceLineage?.({
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId: worktree.instanceId,
        parentWorkspaceKey: worktreeWorkspaceKey(parent.id),
        parentInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt
      })
    }
    const metadataUpdates = stripOrcaProvenanceMetaUpdates(persistedMetaUpdates)
    const executionHostId = worktree.identity?.executionHostId ?? worktree.hostId
    if (executionHostId && this.deps.store.setWorktreeMetaForHost) {
      this.deps.store.setWorktreeMetaForHost(worktree.id, executionHostId, metadataUpdates)
    } else {
      this.deps.store.setWorktreeMeta(worktree.id, metadataUpdates)
    }
    // Why: unlike renderer-initiated optimistic updates, CLI callers need an
    // explicit push so the editor refreshes metadata changed outside the UI.
    this.deps.invalidateResolvedWorktreeCache()
    this.notifyWorktreesChanged(worktree.repoId)
    return await this.showManagedWorktree(
      worktree.identity?.key ? `identity:${worktree.identity.key}` : `id:${worktree.id}`
    )
  }

  // eslint-disable @typescript-eslint/no-explicit-any -- Delegation methods use any to forward arbitrary arguments
  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate() {
    return (
      this.deps.snapshotValueComparison() as any
    ).workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(...(arguments as any))
  }
}
