/* eslint-disable max-lines -- Why: extracted managed-worktree facade (bulk worktree cluster move); state-owner extraction can split further if it grows */
import {
  canCheckoutExistingLocalBranch,
  getSelectedHostedReviewForBranch,
  hasLocalGitOptions,
  parseExactWorktreeIdSelector
} from './orca-runtime'
import type { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import type { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import type { RuntimeHookAgentRowResolutionCommands } from './runtime-hook-agent-row-resolution-commands'
import type { RuntimeClientEventPublishingCommands } from './runtime-client-event-publishing-commands'
import type { getPRForBranch } from '../github/client/lookup/get-pr-for-branch'
import {
  RuntimeLineageError,
  WORKTREE_CREATE_RESULT_TTL_MS,
  WorktreeIdRequiresFullPathError,
  extractOrchestrationTaskId,
  getLocalGitHubPrForBranch,
  getSetupRunnerCommandPlatformForLaunch,
  hasLocalWorktreeBaseRef,
  omitUndefinedProperties,
  ownerSurfacing,
  pathExists,
  resolveCreateBranchName
} from './orca-runtime'
import type {
  OrchestrationCompatibilityTerminalAuthority,
  WorktreeLineageInput,
  PtyControllerInventory,
  PtyControllerTerminalIdentity,
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
import { cloneAgentSessionOwnerBinding } from '../../shared/claimed-agent-pty-owner-snapshot'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { NO_OBSERVING_PROVIDER_REASON } from '../../shared/pty-liveness-verdict'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { toRuntimeActivateWorktreeEvent } from '../../shared/runtime-client-events'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { navigationTargetsClients, navigationTargetsHost } from '../../shared/runtime-navigation'
import type {
  RuntimeGraphStatus,
  RuntimeMobileSessionMarkdownTab,
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
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../shared/runtime-types'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { buildSetupRunnerCommand } from '../../shared/setup-runner-command'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TaskSourceContext } from '../../shared/task-source-context'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../shared/workspace-source'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import {
  WORKTREE_ID_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdComparisonKey
} from '../../shared/worktree/id'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { createRetiredNameLookup } from '../../shared/worktree/retired-name-registry'
import { planWorktreeSortOrderUpdates } from '../../shared/worktree/sort-order-update'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  WorkspaceLinkedItem,
  Worktree
} from '../../shared/worktree/types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
import { resolveLocalGitUsername } from '../git/git-username'
import {
  getBaseRefDefault,
  getBranchConflictKind,
  getRecentDriftSubjects,
  getRemoteDrift,
  resolveDefaultBaseRefWithLocalGit
} from '../git/repo'
import { gitExecFileAsync } from '../git/runner'
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
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import type { Store } from '../persistence'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { IPtyProvider } from '../providers/types'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
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
import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'
import {
  getRuntimeFolderWorkspaceInstanceId,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-tail-projection'
import {
  DRIFT_PROBE_SUBJECT_LIMIT,
  PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS,
  PTY_CONTROLLER_LIST_TIMEOUT_MS,
  WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS,
  branchSelectorMatches,
  createIncrementalResolvedWorktreeLookup,
  findResolvedWorktreeIdForPath,
  findRuntimeWorktreeSummaryByPath,
  getExplicitWorktreeIdSelector,
  includeTargetResolvedWorktree,
  indexPersistedPtySurfaceBindings,
  indexPersistedPtyWorktreeBindings,
  inferWorktreeIdFromPtyId,
  maxTimestamp,
  parseRuntimeWorktreeId,
  runtimePathsEqual,
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual,
  setsEqual,
  waitForWorktreeTerminalMutation,
  withTimeoutResult
} from './runtime-tail-projection'
import {
  getSelectedReviewBranch,
  isAllowedPushTargetRemoteConflict,
  isMatchingSelectedGitHubPr
} from './selected-review-branch'
import { teardownRpcDeadline } from './worktree-teardown'
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
  clientEventPublishingCommands: RuntimeClientEventPublishingCommands
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
  hookAgentRowResolutionCommands: RuntimeHookAgentRowResolutionCommands
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

export class RuntimeManagedWorktrees {
  ptyControllerAggregateInventoryGeneration = 0
  terminalSleepGeneration = 0
  ptyControllerInventoryGenerationByProvider = new Map<string, number>()
  ptyControllerInventorySequence = 0

  private readonly deps: RuntimeManagedWorktreesDeps
  private worktreeCreateByMutationId = new Map<string, Promise<unknown>>()
  readonly worktreeLifecycleListeners = new Set<(event: RuntimeWorktreeLifecycleEvent) => void>()
  readonly optimisticReconcileTokens = new Map<string, string>()
  readonly clientSessionTabSelections = new ClientSessionTabSelectionStore()

  constructor(deps: RuntimeManagedWorktreesDeps) {
    this.deps = deps
  }

  async acquireWorktreeTerminalMutation(
    worktreeId: string,
    deadline?: number
  ): Promise<() => void> {
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const previous = this.deps.terminalMutationTailByWorktreeId().get(key) ?? Promise.resolve()
    let releaseCurrent = (): void => {}
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => {}).then(() => current)
    this.deps.terminalMutationTailByWorktreeId().set(key, tail)
    try {
      await waitForWorktreeTerminalMutation(
        previous.catch(() => {}),
        deadline
      )
    } catch (error) {
      // Why: resolve this abandoned queue node now so it can never acquire later and stop a terminal after the caller timed out.
      releaseCurrent()
      void tail.finally(() => {
        if (this.deps.terminalMutationTailByWorktreeId().get(key) === tail) {
          this.deps.terminalMutationTailByWorktreeId().delete(key)
        }
      })
      throw error
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseCurrent()
      void tail.finally(() => {
        if (this.deps.terminalMutationTailByWorktreeId().get(key) === tail) {
          this.deps.terminalMutationTailByWorktreeId().delete(key)
        }
      })
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId)
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.deps.terminalSleepStateByWorktreeId().get(key)
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.deps.terminalSleepStateByWorktreeId().delete(key)
      this.deps.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
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

  collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = new Set<string>()
    for (const [tabId, tab] of this.deps.tabs()) {
      const prev = previousTabs.get(tabId)
      if (!prev || prev.title !== tab.title) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [tabId, tab] of previousTabs) {
      if (!this.deps.tabs().has(tabId)) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [leafKey, leaf] of this.deps.leaves()) {
      const prev = previousLeaves.get(leafKey)
      if (
        !prev ||
        prev.ptyId !== leaf.ptyId ||
        prev.connected !== leaf.connected ||
        prev.paneTitle !== leaf.paneTitle
      ) {
        changed.add(leaf.worktreeId)
      }
    }
    for (const [leafKey, leaf] of previousLeaves) {
      if (!this.deps.leaves().has(leafKey)) {
        changed.add(leaf.worktreeId)
      }
    }
    return changed
  }

  commitWorktreeTerminalSleepPtys(args: {
    worktreeId: string
    generation: number
    ptyIds: readonly string[]
    pendingPtyIds: Set<string>
    committedPtyIds: Set<string>
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  }): void {
    const newlyCommittedPtyIds = [...new Set(args.ptyIds)]
      .filter((ptyId) => !args.committedPtyIds.has(ptyId))
      .sort()
    for (const ptyId of newlyCommittedPtyIds) {
      args.pendingPtyIds.delete(ptyId)
      args.committedPtyIds.add(ptyId)
    }
    if (newlyCommittedPtyIds.length === 0) {
      return
    }
    this.deps.emitClientEvent({
      type: 'worktreeTerminalSleepState',
      worktreeId: args.worktreeId,
      generation: args.generation,
      phase: 'committed',
      ptyIds: newlyCommittedPtyIds,
      terminalHandles: this.deps.getRecordedTerminalSleepHandles(
        newlyCommittedPtyIds,
        args.terminalHandlesByPtyId
      )
    })
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

  async createManagedWorktree(args: {
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
  }): Promise<CreateWorktreeResult> {
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

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    this.deps.notifier?.worktreeBaseStatus?.(event)
  }

  emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    this.deps.clientEventPublishingCommands.emitWorktreeLifecycle(event)
  }

  folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    return {
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
    }
  }

  getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    const repos = this.deps.store?.getRepos?.() ?? []
    const repoIds = new Set(repos.map((repo) => repo.id))
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    const worktreeIds = new Set<string>()
    for (const hostId of hostIds) {
      const session = this.deps.store?.getWorkspaceSession?.(hostId)
      for (const worktreeId of Object.keys(session?.tabsByWorktree ?? {})) {
        if (repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
          worktreeIds.add(worktreeId)
        }
      }
    }
    return worktreeIds
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

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    if (!snapshot) {
      return this.deps.projectMobileSessionTabsForClient(
        {
          worktree: worktreeId,
          publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        clientNavigationId
      )
    }
    return this.deps.projectMobileSessionTabsForClient(
      this.deps.toMobileSessionTabsResult(snapshot),
      clientNavigationId
    )
  }

  // eslint-disable @typescript-eslint/no-explicit-any -- Delegation methods use any to forward arbitrary arguments
  getMobileSessionWorktreeIdsForPty() {
    return (this.deps.mobileTabSnapshots() as any).getMobileSessionWorktreeIdsForPty(
      ...(arguments as any)
    )
  }

  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    const existing = this.deps.ptysById().get(ptyId)
    if (existing) {
      return existing
    }
    const inferredWorktreeId = inferWorktreeIdFromPtyId(ptyId)
    if (!inferredWorktreeId) {
      return null
    }
    // Why: daemon-backed PTY session IDs are prefixed with the worktree ID so mobile summaries survive renderer graph gaps and reloads.
    return this.recordPtyWorktree(ptyId, inferredWorktreeId)
  }

  getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    const exact = summaries.get(runtimeWorktreeId)
    if (exact) {
      return exact
    }
    if (missingRuntimeWorktreeIds.has(runtimeWorktreeId)) {
      return null
    }
    const parsed = parseRuntimeWorktreeId(runtimeWorktreeId)
    if (!parsed) {
      return null
    }
    const comparisonPlatform =
      runtimeWorktreeSummaryPathIndex.platformByRepoId.get(parsed.repoId) ?? process.platform
    const indexed = findRuntimeWorktreeSummaryByPath(
      runtimeWorktreeSummaryPathIndex,
      parsed.repoId,
      parsed.worktreePath,
      comparisonPlatform
    )
    if (indexed) {
      return indexed
    }
    missingRuntimeWorktreeIds.add(runtimeWorktreeId)
    return null
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed
      ? this.deps.leaves().get(this.deps.getLeafKey(parsed.tabId, parsed.leafId))
      : null
    return leaf?.worktreeId ?? this.deps.getPtyRecordForPaneKey(paneKey)?.worktreeId ?? null
  }

  getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    const worktreeId = getExplicitWorktreeIdSelector(selector)
    if (
      worktreeId &&
      !worktreeId.includes(WORKTREE_ID_SEPARATOR) &&
      this.deps.store?.getRepo(worktreeId)
    ) {
      // Why: a registered repo id is a known-invalid worktree id; reject early before fast paths or Git/SSH scans hide the mistake.
      throw new WorktreeIdRequiresFullPathError()
    }
    return worktreeId
  }

  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    return hostId ? (this.deps.store?.getWorkspaceSession?.(hostId) ?? null) : null
  }

  getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    if (!hostId) {
      throw new Error('folder_workspace_not_found')
    }
    return hostId
  }

  getWorktreeIdForTerminalHandle(handle: string): string | null {
    return this.deps.hookAgentRowResolutionCommands.getWorktreeIdForTerminalHandle(handle)
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

  async hydrateInferredWorktreeLineage(): Promise<void> {
    const store = this.deps.store
    if (
      !store ||
      typeof store.getWorktreeLineage !== 'function' ||
      typeof store.setWorktreeLineage !== 'function'
    ) {
      return
    }

    const worktrees = await this.deps.listResolvedWorktrees()
    for (const worktree of worktrees) {
      if (store.getWorktreeLineage(worktree.id) || !worktree.instanceId) {
        continue
      }
      const taskId = extractOrchestrationTaskId(worktree.comment)
      if (!taskId) {
        continue
      }
      const candidate = await this.deps.resolveLineageCandidateForTaskId(taskId)
      if (
        !candidate?.parent.instanceId ||
        candidate.parent.type !== 'worktree' ||
        candidate.parent.worktree.id === worktree.id
      ) {
        continue
      }
      try {
        this.deps.validateLineageParent(worktree, candidate.parent.worktree)
      } catch {
        continue
      }
      store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: candidate.parent.worktree.id,
        parentWorktreeInstanceId: candidate.parent.instanceId,
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'inferred' },
        taskId,
        createdAt: Date.now()
      })
    }
  }

  invalidateSshWorktreeScanCache(targetId: string): void {
    this.deps.invalidateSshWorktreeScanCacheInternal(targetId)
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    await this.hydrateInferredWorktreeLineage()
    return this.deps.store?.getAllWorktreeLineage?.() ?? {}
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
    const { setup, startup, defaultTabs } = launch
    const navigation = launch.navigationTarget ?? 'all'
    if (navigationTargetsHost(navigation)) {
      this.notifyHostActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    }
    if (navigationTargetsClients(navigation)) {
      this.notifyClientsActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    }
  }

  notifyClientsActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.deps.emitClientEvent(
      toRuntimeActivateWorktreeEvent(repoId, worktreeId, setup, startup, defaultTabs)
    )
  }

  notifyHostActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.deps.notifier?.activateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
  }

  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    this.deps.invalidateWorktreeScanCacheForRepo(repoId)
    const matchingRepos = this.deps.store?.getRepos().filter((repo) => repo.id === repoId) ?? []
    if (matchingRepos.length !== 1 || matchingRepos[0]?.connectionId) {
      return
    }
    this.notifyWorktreesChangedForRemoteClients(repoId)
  }

  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    this.clientSessionTabSelections.migrateWorktree(oldWorktreeId, newWorktreeId)
    this.deps.invalidateResolvedWorktreeCache()
    this.deps.invalidateWorktreeScanCacheForRepo(repoId)
    this.deps.notifier?.worktreesChanged(repoId, { oldWorktreeId, newWorktreeId })
    // Mirror notifyBranchRenamed so in-process onClientEvent listeners also see the rename.
    this.deps.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  notifyWorktreesChanged(repoId: string): void {
    this.deps.clientEventPublishingCommands.notifyWorktreesChanged(repoId)
  }

  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    this.deps.invalidateResolvedWorktreeCache()
    this.deps.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    this.worktreeLifecycleListeners.add(listener)
    return () => {
      this.worktreeLifecycleListeners.delete(listener)
    }
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.deps.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.deps.store
    const updates = planWorktreeSortOrderUpdates(
      orderedIds,
      (worktreeId) => store.getWorktreeMeta(worktreeId),
      Date.now()
    )
    for (const update of updates) {
      store.setWorktreeMeta(update.worktreeId, { sortOrder: update.sortOrder })
    }
    if (updates.length === 0) {
      return { updated: 0 }
    }
    this.deps.invalidateResolvedWorktreeCache()
    const changedRepoIds = new Set(
      updates.flatMap((update) => {
        const parsed = splitWorktreeId(update.worktreeId)
        return parsed ? [parsed.repoId] : []
      })
    )
    for (const repoId of changedRepoIds) {
      this.notifyWorktreesChanged(repoId)
    }
    return { updated: updates.length }
  }

  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    const wt = await this.resolveWorktreeSelector(worktreeSelector)
    if (!this.deps.store) {
      return null
    }
    const repo = this.deps.store.getRepos().find((r) => r.id === wt.repoId)
    if (!repo) {
      return null
    }
    if (repo.connectionId) {
      // Why: the drift probe uses local git helpers. Until the SSH provider
      // exposes equivalent remote refs/log plumbing, fail closed to "unknown"
      // instead of probing a server path on the desktop filesystem.
      return null
    }
    const localGitExecOptions = getLocalProjectGitExecOptions(this.deps.requireStore(), repo)
    const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(
      this.deps.requireStore(),
      repo
    )
    const meta = this.deps.store.getWorktreeMeta(wt.id)
    const base =
      meta?.baseRef ||
      meta?.sparseBaseRef ||
      repo.worktreeBaseRef ||
      (await getBaseRefDefault(repo.path, localWorktreeGitOptions))
    if (!base) {
      // Why: brand-new repo with no remote primary — nothing to compare
      // against, so there's no meaningful drift to report. Dispatch should
      // not block on a probe that cannot form an opinion.
      return null
    }
    const remoteTrackingBase = await this.deps.resolveRemoteTrackingBase(
      repo.path,
      base,
      localWorktreeGitOptions
    )
    if (!remoteTrackingBase) {
      return null
    }
    const remote = remoteTrackingBase.remote
    // Why: fetch failures are non-fatal; we proceed with whatever the
    // last-known remote ref points at. `fetchRemoteWithCache` never throws.
    await this.deps.fetchRemoteWithCache(repo.path, remote, localWorktreeGitOptions)
    const drift = await getRemoteDrift(wt.path, 'HEAD', base, localGitExecOptions)
    if (!drift) {
      return null
    }
    // Why: behind=0 proves HEAD..base is empty, so git log cannot add subjects.
    const recentSubjects =
      drift.behind > 0
        ? await getRecentDriftSubjects(
            wt.path,
            'HEAD',
            base,
            DRIFT_PROBE_SUBJECT_LIMIT,
            localGitExecOptions
          )
        : []
    return { base, behind: drift.behind, recentSubjects }
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
    const stillCurrent = (): boolean =>
      this.optimisticReconcileTokens.get(args.worktreeId) === args.token
    const emit = (event: Omit<WorktreeBaseStatusEvent, 'repoId' | 'worktreeId' | 'base'>): void => {
      if (!stillCurrent()) {
        return
      }
      this.deps.notifier?.worktreeBaseStatus?.({
        repoId: args.repoId,
        worktreeId: args.worktreeId,
        base: args.base.base,
        remote: args.base.remote,
        ...event
      })
    }
    const resolvePublishRemote = async (): Promise<string> => {
      // Why: repos whose canonical publish remote is named differently (e.g.
      // `upstream`, a forked `myfork`, or any non-`origin` configuration —
      // including multi-segment names like `foo/bar` that this PR's resolver
      // explicitly supports) would otherwise silently skip the conflict
      // signal. Resolve from git config in priority order:
      //   1) branch.<name>.pushRemote (explicit per-branch override)
      //   2) remote.pushDefault (workspace-wide override)
      //   3) branch.<name>.remote (tracked remote)
      //   4) the base ref's own remote (matches resolveRemoteTrackingBase)
      //   5) `origin` as a final fallback.
      const tryConfig = async (key: string): Promise<string | null> => {
        try {
          const { stdout } = await gitExecFileAsync(['config', '--get', key], {
            cwd: args.repoPath
          })
          const value = stdout.trim()
          return value || null
        } catch {
          return null
        }
      }
      return (
        (await tryConfig(`branch.${args.branchName}.pushRemote`)) ??
        (await tryConfig('remote.pushDefault')) ??
        (await tryConfig(`branch.${args.branchName}.remote`)) ??
        args.base.remote ??
        'origin'
      )
    }
    const checkPublishRemoteConflict = async (): Promise<void> => {
      const publishRemote = await resolvePublishRemote()
      try {
        if (publishRemote !== args.base.remote) {
          const result = await this.deps.getOrStartRemoteFetch(args.repoPath, publishRemote)
          if (!result.ok) {
            return
          }
        }
        await gitExecFileAsync(
          ['rev-parse', '--verify', `refs/remotes/${publishRemote}/${args.branchName}^{commit}`],
          { cwd: args.repoPath }
        )
        if (stillCurrent()) {
          this.deps.notifier?.worktreeRemoteBranchConflict?.({
            repoId: args.repoId,
            worktreeId: args.worktreeId,
            remote: publishRemote,
            branchName: args.branchName
          })
        }
      } catch {
        // No publish-remote conflict is the common case; stay quiet.
      }
    }

    try {
      const fetchResult = await args.fetchPromise
      if (!stillCurrent()) {
        return
      }
      if (!fetchResult.ok) {
        emit({ status: 'unknown' })
        return
      }

      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', `${args.base.ref}^{commit}`],
        { cwd: args.repoPath }
      )
      const postFetchSha = stdout.trim()
      if (postFetchSha === args.createdBaseSha) {
        emit({ status: 'current' })
        await checkPublishRemoteConflict()
        return
      }

      try {
        await gitExecFileAsync(['merge-base', '--is-ancestor', args.createdBaseSha, postFetchSha], {
          cwd: args.repoPath
        })
      } catch {
        emit({ status: 'base_changed' })
        await checkPublishRemoteConflict()
        return
      }

      const { stdout: countStdout } = await gitExecFileAsync(
        ['rev-list', '--count', `${args.createdBaseSha}..${postFetchSha}`],
        { cwd: args.repoPath }
      )
      const behind = Number(countStdout.trim())
      if (!Number.isFinite(behind) || behind <= 0) {
        emit({ status: 'current' })
        await checkPublishRemoteConflict()
        return
      }
      const { stdout: logStdout } = await gitExecFileAsync(
        ['log', '--format=%s', '-n', '5', `${args.createdBaseSha}..${postFetchSha}`],
        { cwd: args.repoPath }
      )
      emit({
        status: 'drift',
        behind,
        recentSubjects: logStdout.split('\n').filter((line) => line.trim().length > 0)
      })
      await checkPublishRemoteConflict()
    } catch (err) {
      console.warn(`[worktree-base-status] reconcile failed for ${args.worktreeId}:`, err)
      emit({ status: 'unknown' })
    } finally {
      // Why: reconcile is one-shot; clear the token so long-lived sessions
      // that create many worktrees without removing them don't grow the
      // optimisticReconcileTokens map monotonically. Removal still no-ops
      // because the entry is already gone.
      if (this.optimisticReconcileTokens.get(args.worktreeId) === args.token) {
        this.optimisticReconcileTokens.delete(args.worktreeId)
      }
    }
  }

  recordCreatedWorktreeLineage(
    worktree: Pick<Worktree, 'id' | 'instanceId'>,
    lineageResolution: WorktreeLineageResolution
  ): {
    lineage: WorktreeLineage | null
    workspaceLineage: WorkspaceLineage | null
    warnings: WorktreeLineageWarning[]
  } {
    const warnings = lineageResolution.kind === 'none' ? [...lineageResolution.warnings] : []
    let lineage: WorktreeLineage | null = null
    let workspaceLineage: WorkspaceLineage | null = null
    if (lineageResolution.kind !== 'lineage') {
      return { lineage, workspaceLineage, warnings }
    }

    const childInstanceId = worktree.instanceId
    const parentInstanceId = lineageResolution.parent.instanceId
    const createdAt = Date.now()
    if (
      lineageResolution.parent.type === 'worktree' &&
      childInstanceId &&
      parentInstanceId &&
      this.deps.store?.setWorktreeLineage
    ) {
      lineage = this.deps.store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: childInstanceId,
        parentWorktreeId: lineageResolution.parent.worktree.id,
        parentWorktreeInstanceId: parentInstanceId,
        origin: lineageResolution.origin,
        capture: lineageResolution.capture,
        ...(lineageResolution.orchestrationRunId
          ? { orchestrationRunId: lineageResolution.orchestrationRunId }
          : {}),
        ...(lineageResolution.taskId ? { taskId: lineageResolution.taskId } : {}),
        ...(lineageResolution.coordinatorHandle
          ? { coordinatorHandle: lineageResolution.coordinatorHandle }
          : {}),
        ...(lineageResolution.createdByTerminalHandle
          ? { createdByTerminalHandle: lineageResolution.createdByTerminalHandle }
          : {}),
        createdAt
      })
    } else if (lineageResolution.parent.type === 'worktree') {
      warnings.push({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message:
          'Worktree created, but Orca could not record lineage because instance identity was unavailable.',
        details: {
          childHasInstanceId: Boolean(childInstanceId),
          parentHasInstanceId: Boolean(parentInstanceId),
          storeSupportsLineage: Boolean(this.deps.store?.setWorktreeLineage)
        }
      })
    }
    if (childInstanceId && this.deps.store?.setWorkspaceLineage) {
      workspaceLineage = this.deps.store.setWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId,
        parentWorkspaceKey: lineageResolution.parent.workspaceKey,
        parentInstanceId,
        origin: lineageResolution.origin,
        capture: lineageResolution.capture,
        ...(lineageResolution.taskId ? { taskId: lineageResolution.taskId } : {}),
        ...(lineageResolution.orchestrationRunId
          ? { orchestrationRunId: lineageResolution.orchestrationRunId }
          : {}),
        ...(lineageResolution.coordinatorHandle
          ? { coordinatorHandle: lineageResolution.coordinatorHandle }
          : {}),
        ...(lineageResolution.createdByTerminalHandle
          ? { createdByTerminalHandle: lineageResolution.createdByTerminalHandle }
          : {}),
        createdAt
      })
    }
    return { lineage, workspaceLineage, warnings }
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
    let pty = this.deps.ptysById().get(ptyId)
    if (!pty) {
      const titleObservedAt = state.title ? this.deps.nextTitleObservationSequence() : null
      const connectionId = state.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
      const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
      const fallbackWslDistro =
        process.platform === 'win32' && connectionId === null && worktreePath
          ? parseWslUncPath(worktreePath)?.distro
          : undefined
      const wslDistro =
        connectionId === null
          ? (state.wslDistro ??
            this.deps.wslDistroByPtyId().get(ptyId) ??
            fallbackWslDistro ??
            null)
          : null
      pty = {
        ptyId,
        incarnationId: state.incarnationId ?? null,
        worktreeId,
        connectionId,
        runtimeSessionOwned: state.runtimeSessionOwned ?? false,
        isWsl: state.isWsl ?? null,
        wslDistro,
        tabId: state.tabId ?? null,
        paneKey: state.paneKey ?? null,
        launchConfig: null,
        launchToken: null,
        launchIncarnationId: null,
        launchAgent: null,
        agentSessionOwners: (state.agentSessionOwners ?? []).map(cloneAgentSessionOwnerBinding),
        foregroundAgent: null,
        connected: state.connected ?? true,
        disconnectedAt: state.connected === false ? Date.now() : null,
        lastExitCode: null,
        lastExitCause: null,
        lastAgentStatus: null,
        lastAgentStatusObservedLive: false,
        lastAgentStatusStartedAtEpochMs: null,
        lastAgentStatusRichInvalidatedAtEpochMs: null,
        lastOscTitle: null,
        lastOscTitleAt: null,
        lastOscTitleEpochMs: null,
        managementTitle: null,
        managementTitleAt: null,
        controllerTitle: null,
        title: state.title ?? null,
        titleUpdatedAt: titleObservedAt,
        lastOutputAt: state.lastOutputAt ?? null,
        tailBuffer: [],
        tailTranscriptBuffer: [],
        tailTranscriptChars: 0,
        tailPartialLine: '',
        tailPendingAnsi: '',
        tailRedrawCursor: null,
        tailTruncated: false,
        tailLinesTotal: 0,
        preview: state.preview ?? '',
        waitBlockedAt: null
      }
      if (state.title) {
        this.deps.setPtyManagementTitleFromObservedTitle(pty, state.title, titleObservedAt ?? 0)
      }
      this.deps.ptysById().set(ptyId, pty)
      if (wslDistro) {
        this.deps.wslDistroByPtyId().set(ptyId, wslDistro)
      } else if (connectionId !== null) {
        // Why: restored SSH IDs can collide with stale local parser state; connection ownership must win before their first output is parsed.
        this.deps.wslDistroByPtyId().delete(ptyId)
      }
      // Why: restored/controller-discovered PTYs learn their worktree here without registerPty(), so URL enrichment must bind at this source.
      advertisedUrlWatcher.bindPty(ptyId, worktreeId)
      return pty
    }

    pty.worktreeId = worktreeId
    if (
      state.incarnationId !== undefined &&
      pty.incarnationId !== null &&
      state.incarnationId !== pty.incarnationId
    ) {
      pty.agentSessionOwners = []
    }
    if (state.incarnationId !== undefined) {
      if (pty.incarnationId && state.incarnationId && pty.incarnationId !== state.incarnationId) {
        this.deps.invalidatePtyIncarnationHandle(ptyId)
      }
      pty.incarnationId = state.incarnationId
    }
    if (state.agentSessionOwners !== undefined) {
      pty.agentSessionOwners = state.agentSessionOwners.map(cloneAgentSessionOwnerBinding)
    }
    if (state.connectionId !== undefined) {
      pty.connectionId = state.connectionId
      if (state.connectionId !== null) {
        pty.wslDistro = null
        this.deps.wslDistroByPtyId().delete(ptyId)
      }
    }
    if (state.runtimeSessionOwned !== undefined) {
      pty.runtimeSessionOwned = state.runtimeSessionOwned
    }
    if (state.isWsl !== undefined) {
      pty.isWsl = state.isWsl
    }
    if (state.wslDistro !== undefined) {
      pty.wslDistro = state.wslDistro
      if (state.wslDistro) {
        this.deps.wslDistroByPtyId().set(ptyId, state.wslDistro)
      } else {
        this.deps.wslDistroByPtyId().delete(ptyId)
      }
    }
    if (state.tabId !== undefined) {
      pty.tabId = state.tabId
    }
    if (state.paneKey !== undefined) {
      pty.paneKey = state.paneKey
    }
    if (state.connected !== undefined) {
      pty.connected = state.connected
      pty.disconnectedAt = state.connected ? null : (pty.disconnectedAt ?? Date.now())
    }
    if (state.lastOutputAt !== undefined) {
      pty.lastOutputAt = maxTimestamp(pty.lastOutputAt, state.lastOutputAt)
    }
    if (state.preview !== undefined && state.preview.length > 0) {
      pty.preview = state.preview
    }
    if (state.title !== undefined && state.title !== null && state.title.length > 0) {
      const observedAt = this.deps.nextTitleObservationSequence()
      pty.title = state.title
      pty.titleUpdatedAt = observedAt
      this.deps.setPtyManagementTitleFromObservedTitle(pty, state.title, observedAt)
    }
    // Why: recordPtyWorktree is the common lifecycle point for every path that resolves a PTY's worktree (renderer restore, controller list).
    advertisedUrlWatcher.bindPty(ptyId, worktreeId)
    return pty
  }

  async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
    return inventory ? new Set(inventory.livePtyIds) : null
  }

  async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    if (targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      const targetedLiveness = this.deps.refreshFloatingWorkspacePtyLiveness()
      if (targetedLiveness !== null) {
        return {
          livePtyIds: targetedLiveness,
          allLivePtyIds: targetedLiveness,
          terminalIdentityByPtyId: new Map(),
          queriedHostIds: new Set([LOCAL_EXECUTION_HOST_ID])
        }
      }
    }
    if (!this.deps.ptyController?.listProcesses) {
      return null
    }
    const inventoryGeneration = this.ptyControllerInventorySequence + 1
    this.ptyControllerInventorySequence = inventoryGeneration
    const livenessObservationAtStart = this.deps.ptyLivenessObservationSequence()
    const providerKey = typeof connectionId === 'string' ? `ssh:${connectionId}` : 'local'
    if (connectionId === undefined) {
      this.ptyControllerAggregateInventoryGeneration = inventoryGeneration
    } else {
      this.ptyControllerInventoryGenerationByProvider.set(providerKey, inventoryGeneration)
    }
    const listBudgetMs =
      deadline === undefined
        ? PTY_CONTROLLER_LIST_TIMEOUT_MS
        : Math.max(1, Math.min(PTY_CONTROLLER_LIST_TIMEOUT_MS, deadline - Date.now()))
    // Why: give each provider a deadline strictly inside our own, so a relay that
    // never answers still leaves the aggregate time to return the providers that did
    // — expiring at the same instant would discard the whole inventory instead.
    const providerListOpts = {
      deadlineMs: Date.now() + Math.max(1, listBudgetMs - PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS)
    }
    const processInventory =
      connectionId === undefined && this.deps.ptyController.listProcessesWithHostScope
        ? this.deps.ptyController.listProcessesWithHostScope(providerListOpts)
        : this.deps.ptyController
            .listProcesses(connectionId, providerListOpts)
            .then((processes) => {
              const hostIds = new Set<ExecutionHostId>()
              if (connectionId === undefined || connectionId === null) {
                hostIds.add(LOCAL_EXECUTION_HOST_ID)
              } else {
                hostIds.add(toSshExecutionHostId(connectionId))
              }
              if (connectionId === undefined) {
                for (const process of processes) {
                  const hostId = getPtyExecutionHost(process.id)
                  if (
                    hostId &&
                    hostId !== 'foreign' &&
                    parseExecutionHostId(hostId)?.kind === 'ssh'
                  ) {
                    hostIds.add(hostId)
                  }
                }
              }
              return { processes, hostIds: [...hostIds] }
            })
    const sessionsResult = await withTimeoutResult(processInventory, listBudgetMs)
    if (!sessionsResult.ok) {
      // Why: a transient controller failure is not evidence that retained PTYs exited.
      return null
    }
    const isCurrentInventory =
      connectionId === undefined
        ? this.ptyControllerAggregateInventoryGeneration === inventoryGeneration &&
          ![...this.ptyControllerInventoryGenerationByProvider.values()].some(
            (generation) => generation > inventoryGeneration
          )
        : this.ptyControllerInventoryGenerationByProvider.get(providerKey) ===
            inventoryGeneration &&
          this.ptyControllerAggregateInventoryGeneration <= inventoryGeneration
    if (!isCurrentInventory) {
      return null
    }
    const sessions = sessionsResult.value.processes
    const queriedHostIds = new Set(sessionsResult.value.hostIds)
    const controllerIdentityByPtyId = new Map<string, PtyControllerTerminalIdentity>()
    const ptyIdByControllerHandle = new Map<string, string>()
    const ambiguousControllerPtyIds = new Set<string>()
    for (const session of sessions) {
      const handle = session.terminalHandle?.trim()
      const incarnationId = session.incarnationId?.trim()
      if (!handle?.startsWith('term_') || !incarnationId) {
        continue
      }
      const priorPtyId = ptyIdByControllerHandle.get(handle)
      if (priorPtyId && priorPtyId !== session.id) {
        ambiguousControllerPtyIds.add(priorPtyId)
        ambiguousControllerPtyIds.add(session.id)
        controllerIdentityByPtyId.delete(priorPtyId)
        continue
      }
      if (controllerIdentityByPtyId.has(session.id)) {
        ambiguousControllerPtyIds.add(session.id)
        controllerIdentityByPtyId.delete(session.id)
        continue
      }
      ptyIdByControllerHandle.set(handle, session.id)
      controllerIdentityByPtyId.set(session.id, {
        handle,
        incarnationId,
        ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {})
      })
    }
    for (const ptyId of ambiguousControllerPtyIds) {
      controllerIdentityByPtyId.delete(ptyId)
    }
    const findResolvedWorktree = createIncrementalResolvedWorktreeLookup(resolvedWorktrees)
    const persistedIndexesByHostId = new Map<
      ExecutionHostId,
      {
        worktreeIdByPtyId: ReadonlyMap<string, string>
        surfaceByPtyId: ReturnType<typeof indexPersistedPtySurfaceBindings>
      }
    >()
    const getPersistedIndexes = (hostId: ExecutionHostId) => {
      const existing = persistedIndexesByHostId.get(hostId)
      if (existing) {
        return existing
      }
      const persistedSession = this.deps.store?.getWorkspaceSession?.(hostId)
      const indexes = {
        worktreeIdByPtyId: indexPersistedPtyWorktreeBindings(persistedSession),
        surfaceByPtyId: indexPersistedPtySurfaceBindings(persistedSession)
      }
      persistedIndexesByHostId.set(hostId, indexes)
      return indexes
    }
    const allLivePtyIds = new Set(sessions.map((session) => session.id))
    const selectedLivePtyIds = new Set<string>()
    for (const session of sessions) {
      // The owning inventory positively observed this PTY again; prior lost-contact doubt is stale.
      this.deps.forgetPtyLivenessVerdict(session.id, livenessObservationAtStart)
      const sessionConnectionId =
        parseAppSshPtyId(session.id)?.connectionId ??
        (typeof connectionId === 'string' ? connectionId : null)
      const persistedIndexes = getPersistedIndexes(
        sessionConnectionId ? toSshExecutionHostId(sessionConnectionId) : LOCAL_EXECUTION_HOST_ID
      )
      const controllerIdentity = controllerIdentityByPtyId.get(session.id)
      const persistedWorktreeId = persistedIndexes.worktreeIdByPtyId.get(session.id)
      const providerWorktree = session.worktreeId
        ? findResolvedWorktree(session.worktreeId)
        : undefined
      const inferredWorktreeId = inferWorktreeIdFromPtyId(session.id)
      const persistedWorktree = persistedWorktreeId
        ? findResolvedWorktree(persistedWorktreeId)
        : undefined
      const hasMigrationEvidence =
        Boolean(session.worktreeId) &&
        !providerWorktree &&
        Boolean(persistedWorktree) &&
        Boolean(inferredWorktreeId) &&
        runtimeWorktreeIdsEqual(session.worktreeId as string, inferredWorktreeId as string)
      // Why: an unresolved explicit provider owner remains authoritative unless the session id proves it was frozen before a persisted rename migration.
      const worktreeId = providerWorktree
        ? providerWorktree.id
        : hasMigrationEvidence
          ? (persistedWorktree?.id ?? null)
          : (session.worktreeId ??
            persistedWorktree?.id ??
            inferredWorktreeId ??
            findResolvedWorktreeIdForPath(resolvedWorktrees, session.cwd, targetWorktreeId))
      const persistedSurface = persistedIndexes.surfaceByPtyId.get(session.id)
      const restoresExactSurface =
        persistedSurface &&
        session.incarnationId &&
        persistedSurface.incarnationId === session.incarnationId &&
        Boolean(worktreeId) &&
        runtimeWorktreeIdsEqual(persistedSurface.worktreeId, worktreeId as string)
      this.deps.adoptControllerTerminalHandle(
        session.id,
        controllerIdentity?.handle ?? session.terminalHandle,
        controllerIdentity?.incarnationId ?? session.incarnationId,
        { exactRestoredSurface: Boolean(restoresExactSurface && controllerIdentity) }
      )
      if (
        !targetWorktreeId ||
        (worktreeId && runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        selectedLivePtyIds.add(session.id)
      }
      if (
        targetWorktreeId &&
        (!worktreeId || !runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        const receipt = this.deps.restoredOrchestrationAuthorityByPtyId().get(session.id)
        if (receipt && runtimeWorktreeIdsEqual(receipt.worktreeId, targetWorktreeId)) {
          this.deps.restoredOrchestrationAuthorityByPtyId().delete(session.id)
        }
        continue
      }
      this.deps.restoredOrchestrationAuthorityByPtyId().delete(session.id)
      if (worktreeId) {
        const pty = this.recordPtyWorktree(session.id, worktreeId, {
          connected: true,
          ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
          agentSessionOwners: session.incarnationId ? (session.agentSessionOwners ?? []) : [],
          ...(session.wslDistro !== undefined
            ? { isWsl: Boolean(session.wslDistro), wslDistro: session.wslDistro }
            : {}),
          ...(restoresExactSurface
            ? { tabId: persistedSurface.tabId, paneKey: persistedSurface.paneKey }
            : {})
        })
        if (restoresExactSurface && controllerIdentity) {
          this.deps.rememberRestoredOrchestrationAuthority(
            pty,
            controllerIdentity.handle,
            controllerIdentity.incarnationId
          )
        } else {
          this.deps.restoredOrchestrationAuthorityByPtyId().delete(session.id)
        }
        pty.controllerTitle = session.title?.trim() || null
        this.deps.reconcileSubscriberDrivenProviderAttach(session.id)
      }
      // Why: fire-and-forget so this listing hot path doesn't serialize a relay round-trip per session and a throw can't abort the sweep below.
      this.deps.refreshPtyForegroundAgent()(session.id)
    }
    for (const pty of this.deps.ptysById().values()) {
      if (connectionId !== undefined && pty.connectionId !== connectionId) {
        continue
      }
      if (!allLivePtyIds.has(pty.ptyId) && !this.deps.leafExistsForPty(pty.ptyId)) {
        const currentVerdict = this.deps.ptyLivenessVerdictByPtyId().get(pty.ptyId)
        if (
          currentVerdict &&
          currentVerdict.observedAt > livenessObservationAtStart &&
          currentVerdict.verdict.status === 'unverifiable'
        ) {
          pty.connected = false
          pty.disconnectedAt ??= Date.now()
          continue
        }
        const observed = this.deps.ptyController.hasPty?.(pty.ptyId)
        if (observed === true) {
          // Why: an SSH spawn can become addressable before an overlapping relay list includes it.
          allLivePtyIds.add(pty.ptyId)
          if (
            !targetWorktreeId ||
            (pty.worktreeId && runtimeWorktreeIdsEqual(pty.worktreeId, targetWorktreeId))
          ) {
            selectedLivePtyIds.add(pty.ptyId)
          }
          pty.connected = true
          pty.disconnectedAt = null
          this.deps.forgetPtyLivenessVerdict(pty.ptyId)
          continue
        }
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
        pty.agentSessionOwners = []
        // Why: this list only enumerates registered providers, so a dropped relay
        // clears `connected` for every one of its PTYs at once. Only `false` here
        // is an observed absence; `null` means no provider could be asked.
        if (observed === false) {
          this.deps.forgetPtyLivenessVerdict(pty.ptyId)
        } else if (observed === null) {
          this.deps.markPtyLivenessUnverifiable(pty.ptyId, NO_OBSERVING_PROVIDER_REASON)
        }
      }
    }
    // Why: runs after the hasPty rescue so a still-addressable pane keeps its receipt.
    // A provider that failed to list is absent from `sessions`, and dropping authority on
    // that silence would retire an orchestration handle the relay can still reach.
    for (const [ptyId, receipt] of this.deps.restoredOrchestrationAuthorityByPtyId()) {
      const inScope =
        connectionId === undefined ||
        (connectionId === null && receipt.hostScope.kind !== 'ssh') ||
        (typeof connectionId === 'string' &&
          receipt.hostScope.kind === 'ssh' &&
          receipt.hostScope.targetId === connectionId)
      if (inScope && !allLivePtyIds.has(ptyId)) {
        this.deps.restoredOrchestrationAuthorityByPtyId().delete(ptyId)
      }
    }
    this.deps.pruneDisconnectedPtyRecords()
    return {
      livePtyIds: targetWorktreeId ? selectedLivePtyIds : allLivePtyIds,
      allLivePtyIds,
      terminalIdentityByPtyId: controllerIdentityByPtyId,
      queriedHostIds
    }
  }

  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    let worktreeId = this.deps.store?.getWorkspaceSession?.()?.activeWorktreeId ?? null
    if (!worktreeId && this.deps.graphStatus() === 'ready') {
      for (const tab of this.deps.tabs().values()) {
        if (tab.activeLeafId && tab.worktreeId) {
          worktreeId = tab.worktreeId
          break
        }
      }
    }
    if (!worktreeId) {
      return null
    }
    try {
      const resolved = await this.resolveWorktreeSelector(`id:${worktreeId}`)
      return {
        worktreeId: resolved.id,
        path: resolved.git.path,
        branch: resolved.git.branch,
        displayName: resolved.displayName
      }
    } catch {
      return null
    }
  }

  resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    const repo = worktree?.repoId ? this.deps.requireStore().getRepo(worktree.repoId) : undefined
    const executionHostId = worktree
      ? getWorktreeExecutionHostId(worktree, repo)
      : LOCAL_EXECUTION_HOST_ID
    const parsedHost = parseExecutionHostId(executionHostId)
    return resolveRuntimeBrowserNetworkExecutionHost({
      runtimeId: this.deps.getRuntimeId(),
      runtimeRevision: this.deps.getStartedAt(),
      executionHostId,
      ...(worktree
        ? {
            projectRuntime: resolveLocalProjectRuntimeForWorktreeId(
              this.deps.requireStore(),
              worktree.id
            )
          }
        : {}),
      ...(parsedHost?.kind === 'ssh'
        ? { sshState: getRegisteredSshState(parsedHost.targetId) }
        : {})
    })
  }

  async resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput
  ): Promise<WorktreeLineageResolution> {
    const parentSelectorNextSteps = [
      'Pass a valid --parent-worktree selector such as folder:<id>, worktree:<worktreeId>, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<absolute-path>, or active/current.',
      'Retry with --no-parent to create without lineage.'
    ]
    const parentSelectorNotFoundMessage = (err: unknown): string =>
      err instanceof WorktreeIdRequiresFullPathError
        ? err.message
        : 'Parent selector was not found.'

    if (!input) {
      return { kind: 'none', warnings: [] }
    }

    if (input.noParent === true && (input.parentWorkspace || input.parentWorktree)) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Choose either one parent selector or --no-parent.'
      )
    }
    if (input.parentWorkspace && input.parentWorktree) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Choose either one parent selector or --no-parent.'
      )
    }

    if (input.noParent === true) {
      return { kind: 'none', warnings: [] }
    }

    if (input.parentWorkspace) {
      try {
        const parent = await this.deps.resolveWorkspaceParentSelector(input.parentWorkspace)
        // Why: a picker in the app must record the same provenance as a local create, or the same
        // user action would carry different cleanup semantics depending on where the repo lives.
        return {
          kind: 'lineage',
          parent,
          origin: input.parentWorkspaceOrigin === 'manual' ? 'manual' : 'cli',
          capture:
            input.parentWorkspaceOrigin === 'manual'
              ? {
                  source: parent.type === 'worktree' ? 'manual-action' : 'active-workspace',
                  confidence: 'explicit'
                }
              : { source: 'explicit-cli-flag', confidence: 'explicit' }
        }
      } catch (err) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_NOT_FOUND',
          parentSelectorNotFoundMessage(err),
          {
            nextSteps: parentSelectorNextSteps
          }
        )
      }
    }

    if (input.parentWorktree) {
      try {
        const parent = await this.resolveWorktreeSelector(input.parentWorktree)
        return {
          kind: 'lineage',
          parent: {
            type: 'worktree',
            workspaceKey: worktreeWorkspaceKey(parent.id),
            worktree: parent,
            instanceId: parent.instanceId ?? null
          },
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
        }
      } catch (err) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_NOT_FOUND',
          parentSelectorNotFoundMessage(err),
          {
            nextSteps: parentSelectorNextSteps
          }
        )
      }
    }

    const warnings: WorktreeLineageWarning[] = []
    const candidates: WorktreeLineageCandidate[] = []
    let cwdCandidate: WorktreeLineageCandidate | null = null
    let terminalContextResolved = false

    if (input.envParentWorkspace) {
      try {
        candidates.push({
          source: 'env-workspace',
          parent: await this.deps.resolveWorkspaceParentSelector(input.envParentWorkspace)
        })
      } catch {
        warnings.push({
          code: 'LINEAGE_PARENT_CONTEXT_MISSING',
          message: 'Worktree created, but Orca could not validate the environment parent context.',
          details: { envParentWorkspace: input.envParentWorkspace }
        })
      }
    }

    if (input.orchestrationContext?.parentWorktreeId) {
      try {
        const parent = await this.resolveWorktreeSelector(
          `id:${input.orchestrationContext.parentWorktreeId}`
        )
        candidates.push({
          source: 'orchestration-context',
          parent: {
            type: 'worktree',
            workspaceKey: worktreeWorkspaceKey(parent.id),
            worktree: parent,
            instanceId: parent.instanceId ?? null
          }
        })
      } catch {
        // Keep creation recoverable; the warning below covers missing inferred context.
      }
    }

    const commentTaskId = extractOrchestrationTaskId(input.comment)
    if (commentTaskId) {
      const candidate = await this.deps.resolveLineageCandidateForTaskId(commentTaskId)
      if (candidate) {
        candidates.push(candidate)
      }
    }

    if (input.callerTerminalHandle) {
      try {
        const terminal = await this.deps.showTerminal(input.callerTerminalHandle)
        const terminalParent = await this.deps.resolveWorkspaceParentSelector(
          `id:${terminal.worktreeId}`
        )
        const activeDispatch = this.deps._orchestrationDb?.getActiveDispatchForTerminal(
          input.callerTerminalHandle
        )
        const activeRun = this.deps._orchestrationDb?.getActiveCoordinatorRun()
        if (activeDispatch) {
          candidates.push({
            source: 'orchestration-context',
            parent: terminalParent,
            taskId: activeDispatch.task_id,
            ...(activeRun
              ? {
                  orchestrationRunId: activeRun.id,
                  coordinatorHandle: activeRun.coordinator_handle
                }
              : {})
          })
        } else {
          candidates.push({
            source: 'terminal-context',
            parent: terminalParent
          })
        }
        terminalContextResolved = true
      } catch {
        // Why: a stale terminal handle (reload/SSH reconnect) shouldn't drop lineage; keep resolving other inferred candidates.
        warnings.push({
          code: 'LINEAGE_PARENT_CONTEXT_MISSING',
          message:
            'Worktree created, but Orca could not validate the caller terminal as a parent context.',
          details: { callerTerminalHandle: input.callerTerminalHandle }
        })
      }
    }

    if (input.cwdParentWorktree) {
      try {
        cwdCandidate = {
          source: 'cwd-context',
          parent: await this.deps.resolveWorkspaceParentSelector(input.cwdParentWorktree)
        }
      } catch {
        warnings.push({
          code: 'LINEAGE_PARENT_CONTEXT_MISSING',
          message:
            'Worktree created, but Orca could not validate the current directory as a parent context.',
          details: { cwdParentWorktree: input.cwdParentWorktree }
        })
      }
    }

    if (candidates.length === 0 && cwdCandidate) {
      candidates.push(cwdCandidate)
    }

    if (candidates.length === 0) {
      return { kind: 'none', warnings }
    }

    const [first] = candidates
    const conflict = candidates.find(
      (candidate) => candidate.parent.workspaceKey !== first.parent.workspaceKey
    )
    if (conflict) {
      return {
        kind: 'none',
        warnings: [
          {
            code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
            message: 'Worktree created, but Orca could not prove which parent context caused it.',
            details: {
              terminalParentWorkspaceKey: candidates.find((c) => c.source === 'terminal-context')
                ?.parent.workspaceKey,
              envParentWorkspaceKey: candidates.find((c) => c.source === 'env-workspace')?.parent
                .workspaceKey,
              orchestrationParentWorkspaceKey: candidates.find(
                (c) => c.source === 'orchestration-context'
              )?.parent.workspaceKey
            }
          }
        ]
      }
    }

    const preferred =
      candidates.find((candidate) => candidate.source === 'env-workspace') ??
      candidates.find((candidate) => candidate.source === 'orchestration-context') ??
      first
    return {
      kind: 'lineage',
      parent: preferred.parent,
      origin: preferred.source === 'orchestration-context' ? 'orchestration' : 'cli',
      capture: { source: preferred.source, confidence: 'inferred' },
      ...((preferred.orchestrationRunId ?? input.orchestrationContext?.orchestrationRunId)
        ? {
            orchestrationRunId:
              preferred.orchestrationRunId ?? input.orchestrationContext?.orchestrationRunId
          }
        : {}),
      ...((preferred.taskId ?? input.orchestrationContext?.taskId)
        ? { taskId: preferred.taskId ?? input.orchestrationContext?.taskId }
        : {}),
      ...((preferred.coordinatorHandle ?? input.orchestrationContext?.coordinatorHandle)
        ? {
            coordinatorHandle:
              preferred.coordinatorHandle ?? input.orchestrationContext?.coordinatorHandle
          }
        : {}),
      ...(terminalContextResolved && input.callerTerminalHandle
        ? { createdByTerminalHandle: input.callerTerminalHandle }
        : {})
    }
  }

  async resolveMobileMarkdownWorktreeId(worktreeSelector: string, tabId: string): Promise<string> {
    const worktreeId =
      this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.deps.store && worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(this.deps.requireStore(), worktreeId)
      : undefined
  }

  async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    try {
      const exactTarget = parseExactWorktreeIdSelector(worktreeSelector)
      const worktree =
        exactTarget && requiredHostId
          ? ((await this.deps.resolveExplicitWorktreeIdScoped(exactTarget.id, requiredHostId)) ??
            (() => {
              throw new Error('selector_not_found')
            })())
          : await this.resolveWorktreeSelector(worktreeSelector)
      const removalTarget = {
        id: worktree.id,
        repoId: worktree.repoId,
        path: worktree.path
      }
      return worktree.pushTarget
        ? { ...removalTarget, pushTarget: worktree.pushTarget }
        : removalTarget
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'selector_not_found') {
        throw error
      }
      const removalTarget = parseExactWorktreeIdSelector(worktreeSelector)
      const meta = removalTarget ? this.deps.store?.getWorktreeMeta(removalTarget.id) : undefined
      if (
        !removalTarget ||
        !meta ||
        (requiredHostId !== undefined && meta.hostId !== requiredHostId)
      ) {
        throw error
      }
      // Why: delete requests can arrive after Git no longer lists the worktree.
      // Only exact IDs with persisted Orca metadata are accepted here so
      // branch/path selectors cannot resolve to an arbitrary missing path.
      return meta.pushTarget ? { ...removalTarget, pushTarget: meta.pushTarget } : removalTarget
    }
  }

  async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(selector)
    // Why only `id:`: every other selector kind is matched across the whole fleet, and their
    // `selector_ambiguous` contract is defined over all repos. Scoping those would silently pick a
    // winner where today they correctly refuse. An `id:` selector already names its repo.
    if (explicitWorktreeId && !this.deps.hasFreshResolvedWorktreeCache()) {
      const scoped = await this.deps.resolveExplicitWorktreeIdScoped(explicitWorktreeId)
      if (scoped) {
        return scoped
      }
    }
    const worktrees = await this.deps.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('identity:')) {
      const identityKey = selector.slice('identity:'.length)
      candidates = worktrees.filter((worktree) => worktree.identity?.key === identityKey)
    } else if (selector.startsWith('id:')) {
      const worktreeId = explicitWorktreeId ?? selector.slice(3)
      candidates = worktrees.filter((worktree) => worktree.id === worktreeId)
      if (candidates.length === 0) {
        // Why (#16243): `id:` is the only shape the renderer can send, and a stored id can spell
        // its path differently from the scan — the divergence `path:` has always absorbed.
        // The bare unprefixed branch below stays byte-exact on purpose: only `id:` reaches a
        // renderer caller, so `id:repo::p/` folds here while bare `repo::p/` still misses.
        const comparisonKey = worktreeIdComparisonKey(worktreeId)
        candidates = comparisonKey
          ? worktrees.filter((worktree) => worktreeIdComparisonKey(worktree.id) === comparisonKey)
          : candidates
      }
      if (candidates.length === 0) {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        const repo = parsed ? this.deps.store?.getRepo(parsed.repoId) : null
        const fallback =
          repo?.connectionId && this.deps.store?.getWorktreeMeta(worktreeId)
            ? this.deps.buildResolvedWorktreeFromId(worktreeId)
            : null
        if (fallback !== null) {
          candidates = [fallback]
        }
      }
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) =>
        runtimePathsEqual(worktree.path, selector.slice(5))
      )
      if (candidates.length > 1) {
        const hostIds = new Set(
          candidates.map((worktree) => {
            const repo = this.deps.store?.getRepo(worktree.repoId)
            return getWorktreeExecutionHostId(worktree, repo)
          })
        )
        // Why: duplicate registrations on one host describe one path; identical paths on different hosts do not.
        if (hostIds.size === 1) {
          candidates = [candidates[0]]
        }
      }
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('name:')) {
      // Keep display-name matching exact so duplicate names hit the same ambiguity path as other selectors.
      candidates = worktrees.filter((worktree) => worktree.displayName === selector.slice(5))
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          runtimePathsEqual(worktree.path, selector) ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    this.deps.store?.setWorkspaceSession?.(
      session,
      this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    )
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    // Why: sleep is renderer-initiated on desktop (it tears down tab state
    // before killing PTYs). The notifier tells the renderer to run its own
    // sleep flow so all cleanup happens in the correct order.
    this.deps.notifier?.sleepWorktree(worktree.id)
    return { worktreeId: worktree.id }
  }

  async sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const sleepDeadline = Date.now() + WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS
    const releaseMutation = await this.acquireWorktreeTerminalMutation(worktree.id, sleepDeadline)
    const key = runtimeWorktreeIdentityKey(worktree.id)
    const existingSleepState = this.deps.terminalSleepStateByWorktreeId().get(key)
    if (existingSleepState?.phase === 'sleeping') {
      try {
        const resolvedWorktrees = includeTargetResolvedWorktree(
          [...(await this.deps.getResolvedWorktreeMap()).values()],
          worktree
        )
        const refreshedPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(
          resolvedWorktrees,
          worktree.id,
          sleepDeadline
        )
        if (!refreshedPtyLiveness) {
          throw new Error('terminal_liveness_unavailable')
        }
        if (this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness).size === 0) {
          releaseMutation()
          return {
            stopped: 0,
            stoppedPtyIds: [],
            livePtyIds: [],
            postStopVerified: true
          }
        }
        this.deps.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: existingSleepState.worktreeId,
          generation: existingSleepState.generation,
          phase: 'woken',
          ptyIds: existingSleepState.ptyIds,
          terminalHandles: existingSleepState.terminalHandles
        })
        this.deps.terminalSleepStateByWorktreeId().delete(key)
      } catch (error) {
        releaseMutation()
        throw error
      }
    }
    const priorPartialState = existingSleepState?.phase === 'partial' ? existingSleepState : null
    const committedPtyIds = new Set(priorPartialState?.ptyIds ?? [])
    const terminalHandlesByPtyId = { ...priorPartialState?.terminalHandlesByPtyId }
    const pendingPtyIds = new Set<string>()
    let generation = 0
    let fullyCommitted = false
    let releaseReversibleRendererStops = (): void => {}
    try {
      const resolvedWorktrees = includeTargetResolvedWorktree(
        [...(await this.deps.getResolvedWorktreeMap()).values()],
        worktree
      )
      const refreshedPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!refreshedPtyLiveness) {
        throw new Error('terminal_liveness_unavailable')
      }
      const livePtyIds = this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
      generation = ++this.terminalSleepGeneration
      for (const ptyId of livePtyIds) {
        pendingPtyIds.add(ptyId)
        terminalHandlesByPtyId[ptyId] = this.deps.getTerminalHandlesForPtyId(ptyId)
      }
      const liveTerminalHandles = this.deps.getRecordedTerminalSleepHandles(
        livePtyIds,
        terminalHandlesByPtyId
      )
      this.deps.terminalSleepStateByWorktreeId().set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'stopping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles: this.deps.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        ),
        terminalHandlesByPtyId
      })
      this.deps.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: worktree.id,
        generation,
        phase: 'started',
        ptyIds: [...livePtyIds].sort(),
        terminalHandles: liveTerminalHandles
      })
      if (committedPtyIds.size > 0) {
        this.deps.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: worktree.id,
          generation,
          phase: 'committed',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles: this.deps.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
        })
      }
      if (livePtyIds.size === 0) {
        const terminalHandles = this.deps.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        )
        this.deps.terminalSleepStateByWorktreeId().set(key, {
          worktreeId: worktree.id,
          generation,
          phase: 'sleeping',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles,
          terminalHandlesByPtyId
        })
        fullyCommitted = true
        return {
          stopped: 0,
          stoppedPtyIds: [],
          livePtyIds: [],
          postStopVerified: true
        }
      }
      const ptyController = this.deps.ptyController
      if (!ptyController?.stopAndWait) {
        throw new Error('terminal_worktree_sleep_unavailable')
      }
      const stopAndWait = ptyController.stopAndWait.bind(ptyController)

      const orderedLivePtyIds = [...livePtyIds].sort()
      releaseReversibleRendererStops =
        ptyController.markReversibleStops?.(orderedLivePtyIds) ?? (() => {})
      const stopResults = await Promise.allSettled(
        orderedLivePtyIds.map(async (ptyId) => ({
          ptyId,
          stopped: await stopAndWait(ptyId, {
            keepHistory: true,
            deadlineMs: teardownRpcDeadline(sleepDeadline)
          })
        }))
      )
      const successfulStopPtyIds = orderedLivePtyIds.filter((_, index) => {
        const result = stopResults[index]
        return result?.status === 'fulfilled' && result.value.stopped
      })
      const failedStopIndex = stopResults.findIndex((result) =>
        result.status === 'rejected' ? true : !result.value.stopped
      )

      const postStopLiveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!postStopLiveness) {
        this.commitWorktreeTerminalSleepPtys({
          worktreeId: worktree.id,
          generation,
          ptyIds: successfulStopPtyIds,
          pendingPtyIds,
          committedPtyIds,
          terminalHandlesByPtyId
        })
        if (failedStopIndex !== -1) {
          const failedStop = stopResults[failedStopIndex]
          throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
            ptyId: orderedLivePtyIds[failedStopIndex],
            ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
          })
        }
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_liveness_unavailable'
        }
      }
      const remainingLivePtyIds = this.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
      const provenStoppedPtyIds = orderedLivePtyIds.filter(
        (ptyId) => !remainingLivePtyIds.has(ptyId)
      )
      this.commitWorktreeTerminalSleepPtys({
        worktreeId: worktree.id,
        generation,
        ptyIds: provenStoppedPtyIds,
        pendingPtyIds,
        committedPtyIds,
        terminalHandlesByPtyId
      })
      if (failedStopIndex !== -1 && remainingLivePtyIds.size > 0) {
        const failedStop = stopResults[failedStopIndex]
        console.error('[runtime] worktree terminal sleep physical stop failed', {
          worktreeId: worktree.id,
          ptyId: orderedLivePtyIds[failedStopIndex],
          cause: failedStop.status === 'rejected' ? failedStop.reason : 'stop_not_acknowledged'
        })
        throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
          ptyId: orderedLivePtyIds[failedStopIndex],
          remainingLivePtyIds: [...remainingLivePtyIds].sort(),
          ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
        })
      }
      if (remainingLivePtyIds.size > 0) {
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_worktree_sleep_still_live',
          remainingLivePtyIds: [...remainingLivePtyIds].sort()
        }
      }
      const terminalHandles = this.deps.getRecordedTerminalSleepHandles(
        committedPtyIds,
        terminalHandlesByPtyId
      )
      this.deps.terminalSleepStateByWorktreeId().set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'sleeping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles,
        terminalHandlesByPtyId
      })
      fullyCommitted = true
      return {
        stopped: provenStoppedPtyIds.length,
        stoppedPtyIds: provenStoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: true
      }
    } finally {
      releaseReversibleRendererStops()
      if (!fullyCommitted && generation > 0) {
        const cancelledPtyIds = [...pendingPtyIds].sort()
        if (cancelledPtyIds.length > 0) {
          this.deps.emitClientEvent({
            type: 'worktreeTerminalSleepState',
            worktreeId: worktree.id,
            generation,
            phase: 'cancelled',
            ptyIds: cancelledPtyIds,
            terminalHandles: this.deps.getRecordedTerminalSleepHandles(
              cancelledPtyIds,
              terminalHandlesByPtyId
            )
          })
        }
        if (committedPtyIds.size > 0) {
          const terminalHandles = this.deps.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
          this.deps.terminalSleepStateByWorktreeId().set(key, {
            worktreeId: worktree.id,
            generation,
            phase: 'partial',
            ptyIds: [...committedPtyIds].sort(),
            terminalHandles,
            terminalHandlesByPtyId
          })
        } else {
          this.deps.terminalSleepStateByWorktreeId().delete(key)
        }
      }
      releaseMutation()
    }
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const existing = this.deps.terminalSleepByWorktreeId().get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.deps.terminalSleepByWorktreeId().set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.deps.terminalSleepByWorktreeId().get(worktree.id) === sleeping) {
        this.deps.terminalSleepByWorktreeId().delete(worktree.id)
      }
    }
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
    // Why: exact stop hibernates one known pane; worktree sleep discovers its complete host-owned set separately.
    const graphEpoch = this.deps.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.deps.assertStableReadyGraph(graphEpoch)
    const expected = new Set(expectedPtyIds.filter((ptyId) => ptyId.length > 0))
    if (expected.size !== 1) {
      throw new Error('terminal_exact_stop_requires_single_pty')
    }
    const resolvedWorktrees = [...(await this.deps.getResolvedWorktreeMap()).values()]
    const refreshedPtyLiveness =
      await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!refreshedPtyLiveness) {
      throw new Error('terminal_liveness_unavailable')
    }
    const livePtyIds = this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
    const targetOnly = opts.targetOnly === true
    const expectedIsLive = [...expected].every((ptyId) => livePtyIds.has(ptyId))
    if (targetOnly ? !expectedIsLive : !setsEqual(livePtyIds, expected)) {
      const error = Object.assign(new Error('terminal_stop_pty_set_mismatch'), {
        livePtyIds: [...livePtyIds].sort(),
        expectedPtyIds: [...expected].sort()
      })
      throw error
    }

    if (!this.deps.ptyController?.stopAndWait) {
      throw new Error('terminal_exact_stop_unavailable')
    }

    const stoppedPtyIds: string[] = []
    for (const ptyId of [...expected].sort()) {
      if (opts.keepHistory) {
        this.deps
          .intentionalHandlelessPtyStops()
          .set(ptyId, this.deps.ptysById().get(ptyId)?.incarnationId ?? null)
      }
      try {
        if (
          !(await this.deps.ptyController.stopAndWait(ptyId, { keepHistory: opts.keepHistory }))
        ) {
          throw Object.assign(new Error('terminal_exact_stop_failed'), { ptyId })
        }
      } finally {
        this.deps.intentionalHandlelessPtyStops().delete(ptyId)
      }
      stoppedPtyIds.push(ptyId)
    }
    const postStopLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!postStopLiveness) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      }
    }
    const remainingLivePtyIds = this.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
    const stoppedTargetsStillLive = [...expected].filter((ptyId) => remainingLivePtyIds.has(ptyId))
    if (targetOnly ? stoppedTargetsStillLive.length > 0 : remainingLivePtyIds.size > 0) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_exact_stop_still_live',
        remainingLivePtyIds: [...remainingLivePtyIds].sort()
      }
    }
    return {
      stopped: stoppedPtyIds.length,
      stoppedPtyIds,
      livePtyIds: [...livePtyIds].sort(),
      postStopVerified: true,
      ...(targetOnly && remainingLivePtyIds.size > 0
        ? { remainingLivePtyIds: [...remainingLivePtyIds].sort() }
        : {})
    }
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
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.deps.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorktreeSelector(worktreeSelector)
    this.deps.assertStableReadyGraph(graphEpoch)
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const ownsWorktree = options.resolvedWorktreeId
      ? (candidate: string | undefined): boolean =>
          candidate ? runtimeWorktreeIdsEqual(candidate, worktree.id) : false
      : (candidate: string | undefined): boolean => candidate === worktree.id
    const ownsHost = (ptyId: string, connectionId?: string | null): boolean => {
      if (options.resolvedRuntimeEnvironmentId !== undefined) {
        return ptyId.startsWith(
          `remote:${encodeURIComponent(options.resolvedRuntimeEnvironmentId)}@@`
        )
      }
      return (
        options.resolvedConnectionId === undefined || connectionId === options.resolvedConnectionId
      )
    }
    const ptyIds = new Set<string>()
    for (const leaf of this.deps.leaves().values()) {
      if (
        ownsWorktree(leaf.worktreeId) &&
        leaf.ptyId &&
        ownsHost(leaf.ptyId, this.deps.ptysById().get(leaf.ptyId)?.connectionId)
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.deps.ptysById().values()) {
      if (ownsWorktree(pty.worktreeId) && pty.connected && ownsHost(pty.ptyId, pty.connectionId)) {
        ptyIds.add(pty.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        break
      }
      const stop = (): boolean | Promise<boolean> => {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          return false
        }
        if (options.stopPty) {
          // Why: destructive worktree cleanup must not let its cross-surface
          // dedupe treat fire-and-forget controller.kill as physical exit.
          // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep
          // deadline so a wedged daemon yields the accurate stop failure; no deadline
          // (non-destructive) keeps the provider default RPC timeout.
          if (options.deadline !== undefined) {
            return (
              this.deps.ptyController?.stopAndWait?.(ptyId, {
                deadlineMs: teardownRpcDeadline(options.deadline)
              }) ?? false
            )
          }
          return this.deps.ptyController?.stopAndWait?.(ptyId) ?? false
        }
        return Boolean(this.deps.ptyController?.kill(ptyId))
      }
      const stopResult = options.stopPty
        ? await options.stopPty(ptyId, stop)
        : { stopped: stop(), owner: true }
      if (stopResult.owner && stopResult.stopped) {
        stopped += 1
      }
    }
    return { stopped }
  }

  touchMobileSessionTabsForWorktree() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Delegation forwards arbitrary arguments
    return (this.deps.mobileTabSnapshots() as any).touchMobileSessionTabsForWorktree(
      ...(arguments as any)
    )
  }

  tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const workspace = this.deps.store
        ?.getFolderWorkspaces?.()
        .find((entry) => entry.id === scope.folderWorkspaceId)
      if (!workspace) {
        return null
      }
      if (workspace.executionHostId != null) {
        return parseExecutionHostId(workspace.executionHostId)?.id ?? null
      }
      const connectionId = this.deps.resolveFolderWorkspaceConnectionId(workspace)
      return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
    }
    const resolvedWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
    const repo = this.deps.store?.getRepo?.(getRepoIdFromWorktreeId(resolvedWorktreeId))
    return repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
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
