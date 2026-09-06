/* eslint-disable max-lines -- Why: OrcaRuntimeService still owns the mutable live graph, PTY handles, waiters, mobile floor/layout state, and managed-worktree reconciliation. Stateless browser and file command adapters live beside it; the remaining split points need state-owner extraction before enforcing max-lines. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Why: delegation trampolines forward variadic args to extracted command facades; typing them precisely requires the facades to expose param tuples. */
import { isShellProcess } from '../../shared/agent-detection'

import { resolveNestedWorkerMaxDepth } from '../../shared/nested-worker-depth'
import { RuntimeLinearCommands } from './runtime-linear-commands'
import { RuntimeProjectWorktreeCommands } from './runtime-project-worktree-commands'
import { RuntimeRepoGitCommandsFacade } from './runtime-repo-git-commands'
import { RuntimeSkillArtifactCommands } from './runtime-skill-artifact-commands'
import { RuntimeSkillInstallCommands } from './runtime-skill-install-commands'
import {
  RuntimeAccountCommands,
  type AccountsSnapshot,
  type CodexRateLimitResetRpcResult
} from './runtime-account-commands'
import { RuntimeAutomationCommands } from './runtime-automation-commands'
import { RuntimeDisposalTree, type SubscriptionRegistration } from './runtime-disposal-tree'
import {
  removeManagedWorktree as removeManagedWorktreeImpl,
  forceDeletePreservedBranch as forceDeletePreservedBranchImpl,
  rememberPreservedBranchCleanupTarget as rememberPreservedBranchCleanupTargetImpl
} from './runtime-worktree-lifecycle'
import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import type { SkillCloudService } from '../skills/skill-cloud-service'
import { RuntimeOrchestrationCommands } from './runtime-orchestration-commands'
import type { RuntimeOrchestrationCommandsDeps } from './runtime-orchestration-commands-deps'
import { RuntimeOrchestrationGraphReloadCommands } from './runtime-orchestration-graph-reload-commands'
import type {
  AgentSkillShareOperation,
  AgentSkillShareRequest
} from '../../shared/agent-skill-sharing-contract'
import type { DiscoveredSkill } from '../../shared/skills'
import type {
  SkillCloudDownloadGrant,
  SkillCloudOperation,
  SkillCloudOptions,
  SkillCloudPackageDetails,
  SkillCloudPublishRequest,
  SkillCloudPublishResult,
  SkillCloudVersion
} from '../../shared/skill-cloud-contract'
import type {
  SkillInstallPreview,
  SkillInstallPreviewRequest,
  SkillInstallRequest,
  SkillInstallResult,
  ManagedSkillInstall,
  SkillRemoveRequest
} from '../../shared/skill-install-contract'
import type {
  SkillBundleInstallPreview,
  SkillBundleInstallPreviewRequest,
  SkillBundleInstallProgress,
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import type { SkillProviderRootOverrides } from '../skills/skill-provider-destinations'
import type {
  SkillUploadBeginRequest,
  SkillUploadChunkRequest
} from '../../shared/skill-upload-session-contract'
import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactListItem,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import type { AgentStatus } from '../../shared/agent-detection'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import type {
  RemoteTerminalSourceRangeConsumerHooks,
  RemoteTerminalSourceRangeReplacementPublication,
  RemoteTerminalSourceRangeReplacementReservation,
  RemoteTerminalSourceRangeStreamIdentity
} from './remote-terminal-source-range-consumer'
import type { TerminalTitleFactMeta } from '../../shared/terminal-output-side-effects'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../shared/terminal-side-effect-facts'
import type { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type AgentStatusOrchestrationContext
} from '../../shared/agent-status-types'
import type { AgentHookAuthorityAttestation } from '../agent-hooks/server'
import type {
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import {
  createEphemeralAgentSessionClaimSigner,
  type AgentSessionClaimSigner
} from './agent-session-claim-identity'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredTuiOwner } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { stopStructuredSessionProcess } from './agent-session-owner-process-stop'
import { waitForStructuredTuiExitProof } from './structured-tui-exit-proof'
import { hasStructuredTuiIdleEvidence } from './structured-tui-idle-evidence'
import type { AgentSessionPtyWriteAdmittance } from './agent-session-pty-write-gate'
import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner
} from '../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../shared/pane-agent-owner'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
type AgentStatusOscProcessor = (data: string) => ProcessedAgentStatusChunk
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { gitExecFileAsync } from '../git/runner'
import { wakeFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade-wake'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { OrchestrationDb } from './orchestration/db'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from './orchestration/environment-transport'
import {
  syncOrchestrationFederatedDispatch as federatedDispatchFn,
  syncOrchestrationFederatedDispatchAfterCurrent as federatedDispatchAfterCurrentFn,
  ensureOrchestrationFederationRelay as ensureFederationRelayFn,
  stopOrchestrationFederationRelay as stopFederationRelayFn,
  verifyOrchestrationCompatibilityCaller as verifyCompatibilityCallerFn
} from './runtime-orchestration-federation'
import { MailPointerRepointScheduler } from './orchestration/mail-pointer-repoint-scheduler'
import { OrchestrationMailboxOwner } from './orchestration/mailbox-owner'
import { OrchestrationMailboxNotificationCoordinator } from './orchestration/mailbox-notification-coordinator'
import { OrchestrationMailboxDeliveryTarget } from './orchestration/mailbox-delivery-target'
import { OrchestrationMailboxPointerDelivery } from './orchestration/mailbox-pointer-delivery'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AutomationListParams, AutomationListResult } from '../../shared/automation-list-scope'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../shared/automation-owner-precondition'
import type { DirEntry, FilesystemPathFlavor } from '../../shared/filesystem-entry-types'
import type { FolderWorkspace, WorkspaceKey } from '../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { MemorySnapshot, StatsSummary } from '../../shared/process-stats-types'
import type {
  NestedRepoScanResult,
  ProjectGroup,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { getAgentLaunchPlatformForRepo } from './agent-launch-platform'
import { resolveLocalProjectRuntimeForRepo } from '../../main/local-project-runtime-resolution'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { TuiAgent } from '../../shared/tui-agent'

import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { hasHostAuthoritativeTerminalMembership } from './workspace-session-terminal-membership-authority'
import { buildHeadlessTerminalSplitLayout } from './headless-terminal-split-layout'
import type { TerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type { PtyRuntimeRecord } from './pty-runtime-record'
import {
  installBrowserEmulatorCommandDelegations,
  installFileCommandDelegations,
  installMobileTabCommandDelegations,
  installGitCommandDelegations,
  installLinearCommandDelegations
} from './runtime-browser-emulator-delegations'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import type {
  CreateWorktreeResult,
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitHubPrStartPoint, GitPushTarget } from '../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import type { BrowserSessionTabSelectionOptions } from './browser-tab-create-publication'
import type { BrowserScreencastSubscriber } from './browser-screencast-driver-scope'
import type {
  AutomationsChangedPayload,
  RuntimeClientEvent
} from '../../shared/runtime-client-events'

import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { TabActivationIntent } from '../../shared/tab-activation-intent'
import type { SshConnectionState } from '../../shared/ssh-types'
import { getPublicSshState } from './public-ssh-state'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeDesktopWindowStatus,
  type RuntimeGraphStatus,
  type RuntimeTerminalRead,
  type RuntimeTerminalRename,
  type RuntimeTerminalAgentStatus,
  type RuntimeTerminalSend,
  type RuntimeTerminalCreate,
  type RuntimeTerminalSplit,
  type RuntimeTerminalFocus,
  type RuntimeTerminalClose,
  type RuntimeTerminalListResult,
  type RuntimeTerminalOrphanAdoptionRequest,
  type RuntimeTerminalOrphanAdoptionResult,
  type RuntimeWorktreeTerminalSleepResult,
  type RuntimeTerminalResolvePane,
  type RuntimeStatus,
  type RuntimeSyncWindowGraphResult,
  type RuntimeTerminalWait,
  type RuntimeTerminalWaitCondition,
  type RuntimeWorktreePsSummary,
  type RuntimeSpeechSetupState,
  type RuntimeTerminalInteractiveWait,
  type RuntimeTerminalShow,
  type RuntimeSyncedLeaf,
  type RuntimeSyncedTab,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult,
  type RuntimeMobileSessionCreateTerminalResult,
  type RuntimeMobileSessionAgentTab,
  type RuntimeMobileSessionClientTab,
  type RuntimeMobileSessionTabMove,
  type RuntimeMobileSessionTabMoveResult,
  type RuntimeMobileSessionTabGroup,
  type RuntimeMobileSessionSnapshotTab,
  type RuntimeMobileSessionTerminalTab,
  type RuntimeMobileSessionBrowserTab,
  type RuntimeMobileSessionTabsResult,
  type RuntimeMobileSessionTabsSnapshot,
  type RuntimeSessionTabCloseReason,
  type RuntimeBrowserDriverState,
  type RuntimeRendererSyncWindowGraph,
  type RuntimeSyncWindowGraph,
  type BrowserTabInfo
} from '../../shared/runtime-types'
import {
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  RuntimeGraphReloadLifecycle
} from './runtime-graph-reload-lifecycle'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import { splitWorktreeId } from '../../shared/worktree/id'

import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import type { TerminalQuickCommandMutation } from '../../shared/terminal-quick-commands'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { resolveCodexStructuredAppServerArgs } from '../codex/codex-structured-app-server-args'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'

import { RuntimeFileCommands } from './orca-runtime-files'
import type { AgentSessionCreateOperation } from './agent-session-terminal-operations'
import { addListenerToMap, clampTerminalViewport } from './runtime-worktree-git-shared'
import { RuntimeStartupDraftCommands } from './runtime-startup-draft-commands'
import { RuntimeWorkspaceSessionHydrationCommands } from './runtime-workspace-session-hydration-commands'
import { callOrchestrationWorkerServerViaTransport } from './orchestration/call-worker-server-via-transport'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import { validateLineageParent } from './runtime-lineage-parent-validation'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions
} from '../ai-vault/cached-session-list'
import { configureHostReadableTranscriptPathSources } from '../native-chat/host-readable-transcript-path'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import {
  filterWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../ports/workspace-port-ownership'
import type { AutomationService } from '../automations/service'
import { createRuntimeBrowserCommands } from './runtime-browser-commands-factory'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import {
  rehydrateClientHostedBrowserPages,
  persistClientHostedBrowserPagesForWorktree,
  getAllBrowserDrivers,
  getBrowserDriver,
  setBrowserDriver,
  getBrowserRemoteViewerPages,
  publishBrowserRemoteViewers,
  reclaimBrowserForDesktop
} from './runtime-browser-screencast'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'

import {
  routeRuntimeBrowserClientAutomation,
  type ClientHostedBrowserRpcRoute
} from './runtime-browser-client-automation'

import { ClientHostedPageReconciliationWindow } from './client-hosted-page-reconciliation-window'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import { browserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'
import type { RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { RuntimeEmulatorCommands } from './orca-runtime-emulator'
import type { RuntimeBrowserCommands } from './orca-runtime-browser'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { RuntimeGitCommands } from './orca-runtime-git'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import type { PtyProviderBufferSnapshot, IPtyProvider, PtyTransientFact } from '../providers/types'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import type {
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from './claude-agent-teams-service'
import { collectMemorySnapshot } from '../memory/collector'
import type { BrowserWindow } from 'electron'
import { getAppEnvironment } from '../../shared/app-environment'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { RuntimeBrowserScreencastCommands } from './runtime-browser-screencast-commands'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'

import { getWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  type WatcherRemovalDeadline
} from '../ipc/watcher-removal-drain'
import { RuntimeHeadlessSessionTabPersistenceCommands } from './runtime-headless-session-tab-persistence-commands'
import type { RuntimeHeadlessSessionTabPersistenceDeps } from './runtime-headless-session-tab-persistence-commands-deps'
import type { RuntimeClientEventPublishingCommandsDeps } from './runtime-client-event-publishing-commands-deps'
import type { RuntimeHookAgentRowResolutionCommandsDeps } from './runtime-hook-agent-row-resolution-commands-deps'
import type { RuntimeMobileSessionTabSnapshotCommandsDeps } from './runtime-mobile-session-tab-snapshot-commands-deps'
import type { RuntimeTerminalAgentStatusBindingCommandsDeps } from './runtime-terminal-agent-status-binding-commands-deps'
import { RuntimeClientEventPublishingCommands } from './runtime-client-event-publishing-commands'
import { RuntimeHookAgentRowResolutionCommands } from './runtime-hook-agent-row-resolution-commands'
import { RuntimeMobileSessionTabSnapshotCommands } from './runtime-mobile-session-tab-snapshot-commands'
import { RuntimeMobileSnapshotMergeCommands } from './runtime-mobile-snapshot-merge-commands'
import { RuntimeMobileSnapshotValueComparisonCommands } from './runtime-mobile-snapshot-value-comparison-commands'
import { RuntimePtyTitleTrackingCommands } from './runtime-pty-title-tracking-commands'
import { RuntimeTerminalAgentStatusBindingCommands } from './runtime-terminal-agent-status-binding-commands'
import {
  isNativeWindowsConptyPty,
  registerConptyDa1OverrideInstaller,
  shouldModelAnswerHiddenPtyQueries
} from './terminal-model-query-authority'
import { registerTerminalViewAttributesApplier } from './terminal-view-attribute-store'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import {
  MobileNotificationReplayBuffer,
  type ReplayableMobileNotification
} from './mobile-notification-replay'
import {
  createMobileSessionTabsAgentStatusHeartbeat,
  type MobileSessionTabsAgentStatusHeartbeat
} from './mobile-session-tabs-agent-status-heartbeat'
import { TerminalFocusNavigationCoalescer } from './terminal-focus-navigation-coalescer'
import { nativeChatTranscriptIncludesPath } from '../native-chat/native-chat-file-provenance'
import { inferFolderWorkspacePathConnection } from '../project-groups/folder-workspace-path-status'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { RateLimitService } from '../rate-limits/service'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'

export type RemoteFetchResult = { ok: true } | { ok: false; errorKind: 'git_error' }

export type RemoteTrackingBase = {
  remote: string
  branch: string
  ref: string
  base: string
}

type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

type RuntimePtyRecord = OrcaRuntimeService['ptysById'] extends Map<string, infer T> ? T : never

export type RuntimePtyTitleTrackerEntry = {
  tracker: TerminalTitleTracker
  // the stale-working-title timer fires between chunks and must touch
  // immediately. This flag routes the tracker callback to the right mode.
  applyingChunk: boolean
  lastMobileTitleGateKey: string | null
  chunkTouchedSessionTabs: boolean
  // Why: facts observed while applying a chunk are batched into one
  // pty:sideEffect emission per chunk, preserving status/title/bell order.
  // Timer-fired facts emit immediately between chunks.
  pendingFacts: TerminalSideEffectFact[]
  // Why: Command Code lacks hooks, so its working/done state is scraped from
  // TUI output. Null when no side-effect consumer exists (headless serve) —
  // the scrape produces facts only.
  commandCodeDetector: { observe: (data: string) => boolean } | null
}

// Why: the full OSC 9999 payload flows through emitTerminalAgentStatusEvents and
// is then forwarded to the renderer and dropped. Mobile is served by the main
// process and has no renderer store, so we retain the latest payload per pane
// here to feed worktree.ps's inline agent rows (1:1 with the desktop sidebar).
import type {
  ApplyLayoutResult,
  DriverState,
  HeadlessSeedMetadata,
  HookLiveAgentRow,
  LayoutQueueEntry,
  LegacyWorkerTerminalRecoveryResolution,
  LegacyWorkerTerminalRecoveryResult,
  MessageWaitResult,
  MessageWaiter,
  MobileNotificationEvent,
  NativeChatLaunchDraftResolutionTombstone,
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  ProviderBufferAcquisition,
  ProviderSnapshotReadOptions,
  PtyControllerInventory,
  PtyIncarnationHandleRecord,
  PtyLayoutState,
  PtyLayoutTarget,
  ResolvedWorkspaceParent,
  ResolvedWorktree,
  ResolvedWorktreeSnapshot,
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput,
  RuntimeHeadlessTerminal,
  RuntimeLeafRecord,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyDataAdmission,
  RuntimePtyWorktreeRecord,
  RuntimeRendererReloadFence,
  RuntimeStore,
  RuntimeTerminalAgentStatusEvent,
  RuntimeTerminalBufferSnapshot,
  RuntimeTerminalDataMeta,
  RuntimeTerminalProjection,
  RuntimeVisibleTerminalState,
  RuntimeWorkingTerminalEvidence,
  RuntimeWorktreeLifecycleEvent,
  TerminalAgentStatusSnapshot,
  TerminalCreateOptions,
  TerminalHandleRecord,
  TerminalWaiter,
  TerminalWorkspaceLaunchScope,
  TrackedPtyLivenessVerdict,
  WorktreeLineageCandidate,
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-contracts'
import {
  BRACKETED_PASTE_BEGIN,
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_QUIET_MS,
  listRuntimeFolderWorkspaces,
  MAX_NATIVE_CHAT_LAUNCH_DRAFT_RESOLUTION_TOMBSTONES
} from './runtime-contracts'
import type {
  PtyForegroundAgentRefresh,
  PtyForegroundProcessReadEntry,
  RestoredOrchestrationAuthorityReceipt,
  OrchestrationCompatibilitySshAttachmentAuthority
} from './runtime-contracts'

import type { RuntimeAgentRowSnapshot } from './runtime-contracts'
export type { RuntimeAgentRowSnapshot } from './runtime-contracts'
export {
  RuntimeLineageError,
  WorktreeIdRequiresFullPathError,
  extractOrchestrationTaskId,
  hasLocalWorktreeBaseRef
} from './runtime-contracts'
export type {
  ApplyLayoutResult,
  DriverState,
  HeadlessSeedMetadata,
  HookLiveAgentRow,
  LayoutQueueEntry,
  LegacyWorkerTerminalRecoveryResolution,
  LegacyWorkerTerminalRecoveryResult,
  MessageWaitResult,
  MessageWaiter,
  MobileNotificationDismissEvent,
  MobileNotificationDispatchEvent,
  MobileNotificationEvent,
  NativeChatLaunchDraftResolutionTombstone,
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  ProviderBufferAcquisition,
  ProviderSnapshotReadOptions,
  PtyControllerInventory,
  PtyControllerTerminalIdentity,
  PtyIncarnationHandleRecord,
  PtyLayoutState,
  PtyLayoutTarget,
  ResolvedTerminalWorkspaceLaunchTarget,
  ResolvedWorkspaceParent,
  ResolvedWorktree,
  ResolvedWorktreeSnapshot,
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput,
  RuntimeHeadlessTerminal,
  RuntimeLeafRecord,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyDataAdmission,
  RuntimePtyWorktreeRecord,
  RuntimeRendererReloadFence,
  RuntimeStore,
  RuntimeTerminalAgentStatusEvent,
  RuntimeTerminalBufferSnapshot,
  RuntimeTerminalDataMeta,
  RuntimeTerminalProjection,
  RuntimeVisibleTerminalState,
  RuntimeWorkingTerminalEvidence,
  RuntimeWorktreeAgentSource,
  RuntimeWorktreeLifecycleEvent,
  RuntimeWorktreeRemovalTarget,
  SubscriptionRegistration,
  TerminalAgentStatusSnapshot,
  TerminalCreateOptions,
  TerminalHandleRecord,
  TerminalWaiter,
  TerminalWorkspaceLaunchScope,
  TrackedPtyLivenessVerdict,
  WorktreeLineageCandidate,
  WorktreeLineageInput,
  WorktreeLineageResolution,
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-contracts'
export {
  AGENT_HOOK_RUNTIME_ENV_KEYS,
  FOREGROUND_AGENT_WRAPPER_RETRY_INTERVAL_MS,
  FOREGROUND_AGENT_WRAPPER_RETRY_TIMEOUT_MS,
  MOBILE_TERMINAL_CREATE_RESULT_TTL_MS,
  WORKTREE_CREATE_RESULT_TTL_MS,
  createTerminalRevealWarning,
  getSetupRunnerCommandPlatformForLaunch,
  listRuntimeFolderWorkspaces
} from './runtime-contracts'

/* oxlint-disable typescript/consistent-type-definitions, typescript/no-unsafe-declaration-merging -- interface+class merge is the mechanism for prototype-installed delegations */
export interface OrcaRuntimeService {
  browserSnapshot: RuntimeBrowserCommands['browserSnapshot']
  browserClick: RuntimeBrowserCommands['browserClick']
  browserGoto: RuntimeBrowserCommands['browserGoto']
  browserFill: RuntimeBrowserCommands['browserFill']
  browserType: RuntimeBrowserCommands['browserType']
  browserSelect: RuntimeBrowserCommands['browserSelect']
  browserScroll: RuntimeBrowserCommands['browserScroll']
  browserBack: RuntimeBrowserCommands['browserBack']
  browserReload: RuntimeBrowserCommands['browserReload']
  browserScreenshot: RuntimeBrowserCommands['browserScreenshot']
  browserEval: RuntimeBrowserCommands['browserEval']
  browserTabList: RuntimeBrowserCommands['browserTabList']
  browserProceedCertificate: RuntimeBrowserCommands['browserProceedCertificate']
  browserTabShow: RuntimeBrowserCommands['browserTabShow']
  browserTabCurrent: RuntimeBrowserCommands['browserTabCurrent']
  browserTabSwitch: RuntimeBrowserCommands['browserTabSwitch']
  browserHover: RuntimeBrowserCommands['browserHover']
  browserDrag: RuntimeBrowserCommands['browserDrag']
  browserUpload: RuntimeBrowserCommands['browserUpload']
  browserWait: RuntimeBrowserCommands['browserWait']
  browserCheck: RuntimeBrowserCommands['browserCheck']
  browserFocus: RuntimeBrowserCommands['browserFocus']
  browserClear: RuntimeBrowserCommands['browserClear']
  browserSelectAll: RuntimeBrowserCommands['browserSelectAll']
  browserKeypress: RuntimeBrowserCommands['browserKeypress']
  browserPdf: RuntimeBrowserCommands['browserPdf']
  browserFullScreenshot: RuntimeBrowserCommands['browserFullScreenshot']
  browserCookieGet: RuntimeBrowserCommands['browserCookieGet']
  browserCookieSet: RuntimeBrowserCommands['browserCookieSet']
  browserCookieDelete: RuntimeBrowserCommands['browserCookieDelete']
  browserSetViewport: RuntimeBrowserCommands['browserSetViewport']
  browserSetGeolocation: RuntimeBrowserCommands['browserSetGeolocation']
  browserInterceptEnable: RuntimeBrowserCommands['browserInterceptEnable']
  browserInterceptDisable: RuntimeBrowserCommands['browserInterceptDisable']
  browserInterceptList: RuntimeBrowserCommands['browserInterceptList']
  browserCaptureStart: RuntimeBrowserCommands['browserCaptureStart']
  browserCaptureStop: RuntimeBrowserCommands['browserCaptureStop']
  browserConsoleLog: RuntimeBrowserCommands['browserConsoleLog']
  browserNetworkLog: RuntimeBrowserCommands['browserNetworkLog']
  browserDblclick: RuntimeBrowserCommands['browserDblclick']
  browserForward: RuntimeBrowserCommands['browserForward']
  browserScrollIntoView: RuntimeBrowserCommands['browserScrollIntoView']
  browserGet: RuntimeBrowserCommands['browserGet']
  browserIs: RuntimeBrowserCommands['browserIs']
  browserKeyboardInsertText: RuntimeBrowserCommands['browserKeyboardInsertText']
  browserMouseMove: RuntimeBrowserCommands['browserMouseMove']
  browserMouseDown: RuntimeBrowserCommands['browserMouseDown']
  browserMouseClick: RuntimeBrowserCommands['browserMouseClick']
  browserMouseUp: RuntimeBrowserCommands['browserMouseUp']
  browserMouseWheel: RuntimeBrowserCommands['browserMouseWheel']
  browserFind: RuntimeBrowserCommands['browserFind']
  browserSetDevice: RuntimeBrowserCommands['browserSetDevice']
  browserSetOffline: RuntimeBrowserCommands['browserSetOffline']
  browserSetHeaders: RuntimeBrowserCommands['browserSetHeaders']
  browserSetCredentials: RuntimeBrowserCommands['browserSetCredentials']
  browserSetMedia: RuntimeBrowserCommands['browserSetMedia']
  browserClipboardRead: RuntimeBrowserCommands['browserClipboardRead']
  browserClipboardWrite: RuntimeBrowserCommands['browserClipboardWrite']
  browserDialogAccept: RuntimeBrowserCommands['browserDialogAccept']
  browserDialogDismiss: RuntimeBrowserCommands['browserDialogDismiss']
  browserStorageLocalGet: RuntimeBrowserCommands['browserStorageLocalGet']
  browserStorageLocalSet: RuntimeBrowserCommands['browserStorageLocalSet']
  browserStorageLocalClear: RuntimeBrowserCommands['browserStorageLocalClear']
  browserStorageSessionGet: RuntimeBrowserCommands['browserStorageSessionGet']
  browserStorageSessionSet: RuntimeBrowserCommands['browserStorageSessionSet']
  browserStorageSessionClear: RuntimeBrowserCommands['browserStorageSessionClear']
  browserDownload: RuntimeBrowserCommands['browserDownload']
  browserHighlight: RuntimeBrowserCommands['browserHighlight']
  browserExec: RuntimeBrowserCommands['browserExec']
  browserTabCreate: RuntimeBrowserCommands['browserTabCreate']
  browserTabSetProfile: RuntimeBrowserCommands['browserTabSetProfile']
  browserTabProfileShow: RuntimeBrowserCommands['browserTabProfileShow']
  browserTabProfileClone: RuntimeBrowserCommands['browserTabProfileClone']
  browserProfileList: RuntimeBrowserCommands['browserProfileList']
  browserProfileCreate: RuntimeBrowserCommands['browserProfileCreate']
  browserProfileDelete: RuntimeBrowserCommands['browserProfileDelete']
  browserProfileDetectBrowsers: RuntimeBrowserCommands['browserProfileDetectBrowsers']
  browserProfileImportFromBrowser: RuntimeBrowserCommands['browserProfileImportFromBrowser']
  browserProfileClearDefaultCookies: RuntimeBrowserCommands['browserProfileClearDefaultCookies']
  browserTabClose: RuntimeBrowserCommands['browserTabClose']
  browserScreencast: RuntimeBrowserCommands['browserScreencast']
  emulatorTap: RuntimeEmulatorCommands['emulatorTap']
  emulatorType: RuntimeEmulatorCommands['emulatorType']
  emulatorRotate: RuntimeEmulatorCommands['emulatorRotate']
  emulatorExec: RuntimeEmulatorCommands['emulatorExec']
  emulatorList: RuntimeEmulatorCommands['emulatorList']
  emulatorShutdown: RuntimeEmulatorCommands['emulatorShutdown']
  emulatorListSimulators: RuntimeEmulatorCommands['emulatorListSimulators']
  emulatorAvailability: RuntimeEmulatorCommands['emulatorAvailability']
  emulatorListDevices: RuntimeEmulatorCommands['emulatorListDevices']
  emulatorInstall: RuntimeEmulatorCommands['emulatorInstall']
  emulatorLaunch: RuntimeEmulatorCommands['emulatorLaunch']
  emulatorPermissions: RuntimeEmulatorCommands['emulatorPermissions']
  emulatorAx: RuntimeEmulatorCommands['emulatorAx']
  emulatorUnregisterActive: RuntimeEmulatorCommands['emulatorUnregisterActive']
  emulatorAttach: RuntimeEmulatorCommands['emulatorAttach']
  emulatorGesture: RuntimeEmulatorCommands['emulatorGesture']
  emulatorButton: RuntimeEmulatorCommands['emulatorButton']
  emulatorLogcat: RuntimeEmulatorCommands['emulatorLogcat']
  emulatorKill: RuntimeEmulatorCommands['emulatorKill']
  linearConnect: RuntimeLinearCommands['linearConnect']
  linearDisconnect: RuntimeLinearCommands['linearDisconnect']
  linearSelectWorkspace: RuntimeLinearCommands['linearSelectWorkspace']
  linearStatus: RuntimeLinearCommands['linearStatus']
  linearTestConnection: RuntimeLinearCommands['linearTestConnection']
  linearSearchIssues: RuntimeLinearCommands['linearSearchIssues']
  linearSearchForAgents: RuntimeLinearCommands['linearSearchForAgents']
  linearIssueContext: RuntimeLinearCommands['linearIssueContext']
  linearTeamListForAgents: RuntimeLinearCommands['linearTeamListForAgents']
  linearTeamMembersForAgents: RuntimeLinearCommands['linearTeamMembersForAgents']
  linearTeamStatesForAgents: RuntimeLinearCommands['linearTeamStatesForAgents']
  linearTeamLabelsForAgents: RuntimeLinearCommands['linearTeamLabelsForAgents']
  linearProjectListForAgents: RuntimeLinearCommands['linearProjectListForAgents']
  linearIssueListForAgents: RuntimeLinearCommands['linearIssueListForAgents']
  linearMcpIssueList: RuntimeLinearCommands['linearMcpIssueList']
  linearResolveCurrentIssue: RuntimeLinearCommands['linearResolveCurrentIssue']
  linearListIssues: RuntimeLinearCommands['linearListIssues']
  linearCreateIssue: RuntimeLinearCommands['linearCreateIssue']
  linearGetIssue: RuntimeLinearCommands['linearGetIssue']
  linearUpdateIssue: RuntimeLinearCommands['linearUpdateIssue']
  linearAddIssueComment: RuntimeLinearCommands['linearAddIssueComment']
  linearIssueSetState: RuntimeLinearCommands['linearIssueSetState']
  linearIssueRelationWrite: RuntimeLinearCommands['linearIssueRelationWrite']
  linearSaveIssue: RuntimeLinearCommands['linearSaveIssue']
  linearIssueUpdateTask: RuntimeLinearCommands['linearIssueUpdateTask']
  linearIssueAddComment: RuntimeLinearCommands['linearIssueAddComment']
  linearIssueAttachLink: RuntimeLinearCommands['linearIssueAttachLink']
  linearIssueCreate: RuntimeLinearCommands['linearIssueCreate']
  linearIssueComments: RuntimeLinearCommands['linearIssueComments']
  linearListTeams: RuntimeLinearCommands['linearListTeams']
  linearListProjects: RuntimeLinearCommands['linearListProjects']
  linearCreateProject: RuntimeLinearCommands['linearCreateProject']
  linearGetProject: RuntimeLinearCommands['linearGetProject']
  linearListProjectIssues: RuntimeLinearCommands['linearListProjectIssues']
  linearListCustomViews: RuntimeLinearCommands['linearListCustomViews']
  linearGetCustomView: RuntimeLinearCommands['linearGetCustomView']
  linearListCustomViewIssues: RuntimeLinearCommands['linearListCustomViewIssues']
  linearListCustomViewProjects: RuntimeLinearCommands['linearListCustomViewProjects']
  linearTeamStates: RuntimeLinearCommands['linearTeamStates']
  linearTeamLabels: RuntimeLinearCommands['linearTeamLabels']
  linearTeamMembers: RuntimeLinearCommands['linearTeamMembers']
  jiraConnect: RuntimeLinearCommands['jiraConnect']
  jiraDisconnect: RuntimeLinearCommands['jiraDisconnect']
  jiraSelectSite: RuntimeLinearCommands['jiraSelectSite']
  jiraStatus: RuntimeLinearCommands['jiraStatus']
  jiraReadStatus: RuntimeLinearCommands['jiraReadStatus']
  jiraTestConnection: RuntimeLinearCommands['jiraTestConnection']
  jiraSearchIssues: RuntimeLinearCommands['jiraSearchIssues']
  jiraListIssues: RuntimeLinearCommands['jiraListIssues']
  jiraCreateIssue: RuntimeLinearCommands['jiraCreateIssue']
  jiraGetIssue: RuntimeLinearCommands['jiraGetIssue']
  jiraLookupIssueSummary: RuntimeLinearCommands['jiraLookupIssueSummary']
  jiraUpdateIssue: RuntimeLinearCommands['jiraUpdateIssue']
  jiraAddIssueComment: RuntimeLinearCommands['jiraAddIssueComment']
  jiraIssueComments: RuntimeLinearCommands['jiraIssueComments']
  jiraListProjects: RuntimeLinearCommands['jiraListProjects']
  jiraListIssueTypes: RuntimeLinearCommands['jiraListIssueTypes']
  jiraListCreateFields: RuntimeLinearCommands['jiraListCreateFields']
  jiraListPriorities: RuntimeLinearCommands['jiraListPriorities']
  jiraListAssignableUsers: RuntimeLinearCommands['jiraListAssignableUsers']
  jiraListTransitions: RuntimeLinearCommands['jiraListTransitions']
  jiraGetProjectStatusOrder: RuntimeLinearCommands['jiraGetProjectStatusOrder']
  getRuntimeGitStatus: RuntimeGitCommands['getRuntimeGitStatus']
  getRuntimeGitSubmoduleStatus: RuntimeGitCommands['getRuntimeGitSubmoduleStatus']
  checkRuntimeGitIgnoredPaths: RuntimeGitCommands['checkRuntimeGitIgnoredPaths']
  getRuntimeGitHistory: RuntimeGitCommands['getRuntimeGitHistory']
  getRuntimeGitConflictOperation: RuntimeGitCommands['getRuntimeGitConflictOperation']
  abortRuntimeGitMerge: RuntimeGitCommands['abortRuntimeGitMerge']
  abortRuntimeGitRebase: RuntimeGitCommands['abortRuntimeGitRebase']
  checkoutRuntimeGitBranch: RuntimeGitCommands['checkoutRuntimeGitBranch']
  listRuntimeGitLocalBranches: RuntimeGitCommands['listRuntimeGitLocalBranches']
  getRuntimeGitDiff: RuntimeGitCommands['getRuntimeGitDiff']
  getRuntimeGitBranchCompare: RuntimeGitCommands['getRuntimeGitBranchCompare']
  getRuntimeGitCommitCompare: RuntimeGitCommands['getRuntimeGitCommitCompare']
  getRuntimeGitUpstreamStatus: RuntimeGitCommands['getRuntimeGitUpstreamStatus']
  fetchRuntimeGit: RuntimeGitCommands['fetchRuntimeGit']
  syncRuntimeGitForkDefaultBranch: RuntimeGitCommands['syncRuntimeGitForkDefaultBranch']
  pullRuntimeGit: RuntimeGitCommands['pullRuntimeGit']
  fastForwardRuntimeGit: RuntimeGitCommands['fastForwardRuntimeGit']
  rebaseRuntimeGitFromBase: RuntimeGitCommands['rebaseRuntimeGitFromBase']
  pushRuntimeGit: RuntimeGitCommands['pushRuntimeGit']
  getRuntimeGitBranchDiff: RuntimeGitCommands['getRuntimeGitBranchDiff']
  getRuntimeGitCommitDiff: RuntimeGitCommands['getRuntimeGitCommitDiff']
  commitRuntimeGit: RuntimeGitCommands['commitRuntimeGit']
  generateRuntimeCommitMessage: RuntimeGitCommands['generateRuntimeCommitMessage']
  discoverRuntimeCommitMessageModels: RuntimeGitCommands['discoverRuntimeCommitMessageModels']
  cancelRuntimeGenerateCommitMessage: RuntimeGitCommands['cancelRuntimeGenerateCommitMessage']
  generateRuntimePullRequestFields: RuntimeGitCommands['generateRuntimePullRequestFields']
  cancelRuntimeGeneratePullRequestFields: RuntimeGitCommands['cancelRuntimeGeneratePullRequestFields']
  stageRuntimeGitPath: RuntimeGitCommands['stageRuntimeGitPath']
  unstageRuntimeGitPath: RuntimeGitCommands['unstageRuntimeGitPath']
  bulkStageRuntimeGitPaths: RuntimeGitCommands['bulkStageRuntimeGitPaths']
  bulkUnstageRuntimeGitPaths: RuntimeGitCommands['bulkUnstageRuntimeGitPaths']
  bulkDiscardRuntimeGitPaths: RuntimeGitCommands['bulkDiscardRuntimeGitPaths']
  discardRuntimeGitPath: RuntimeGitCommands['discardRuntimeGitPath']
  getRuntimeGitRemoteFileUrl: RuntimeGitCommands['getRuntimeGitRemoteFileUrl']
  getRuntimeGitRemoteCommitUrl: RuntimeGitCommands['getRuntimeGitRemoteCommitUrl']
  listMobileFiles: RuntimeFileCommands['listMobileFiles']
  searchMobileFilePaths: RuntimeFileCommands['searchMobileFilePaths']
  searchQuickOpenFilePaths: RuntimeFileCommands['searchQuickOpenFilePaths']
  openMobileFile: RuntimeFileCommands['openMobileFile']
  openMobileDiff: RuntimeFileCommands['openMobileDiff']
  readMobileFile: RuntimeFileCommands['readMobileFile']
  resolveTerminalPath: RuntimeFileCommands['resolveTerminalPath']
  readTerminalArtifactFile: RuntimeFileCommands['readTerminalArtifactFile']
  readTerminalArtifactPreview: RuntimeFileCommands['readTerminalArtifactPreview']
  writeTerminalArtifactFile: RuntimeFileCommands['writeTerminalArtifactFile']
  revokeTerminalFileGrantsForClient: RuntimeFileCommands['revokeTerminalFileGrantsForClient']
  readFileExplorerDir: RuntimeFileCommands['readFileExplorerDir']
  watchFileExplorer: RuntimeFileCommands['watchFileExplorer']
  readFileExplorerPreview: RuntimeFileCommands['readFileExplorerPreview']
  readDocPreviewFile: RuntimeFileCommands['readDocPreviewFile']
  readFileExplorerChunk: RuntimeFileCommands['readFileExplorerChunk']
  writeFileExplorerFile: RuntimeFileCommands['writeFileExplorerFile']
  createFileExplorerFile: RuntimeFileCommands['createFileExplorerFile']
  createFileExplorerDir: RuntimeFileCommands['createFileExplorerDir']
  createFileExplorerDirNoClobber: RuntimeFileCommands['createFileExplorerDirNoClobber']
  commitFileExplorerUpload: RuntimeFileCommands['commitFileExplorerUpload']
  renameFileExplorerPath: RuntimeFileCommands['renameFileExplorerPath']
  copyFileExplorerPath: RuntimeFileCommands['copyFileExplorerPath']
  deleteFileExplorerPath: RuntimeFileCommands['deleteFileExplorerPath']
  searchRuntimeFiles: RuntimeFileCommands['searchRuntimeFiles']
  listRuntimeFiles: RuntimeFileCommands['listRuntimeFiles']
  listRuntimeMarkdownDocuments: RuntimeFileCommands['listRuntimeMarkdownDocuments']
  statRuntimeFile: RuntimeFileCommands['statRuntimeFile']
  writeFileExplorerFileBase64: RuntimeFileCommands['writeFileExplorerFileBase64']
  writeFileExplorerFileBase64Chunk: RuntimeFileCommands['writeFileExplorerFileBase64Chunk']
  headlessMobileSnapshotContentUnchanged: RuntimeMobileSessionFacade['headlessMobileSnapshotContentUnchanged']
  getMobileTerminalLeafPtyIds: RuntimeMobileSessionFacade['getMobileTerminalLeafPtyIds']
  clearRuntimeSessionOwnershipForMobileTerminalLeaf: RuntimeMobileSessionFacade['clearRuntimeSessionOwnershipForMobileTerminalLeaf']
  persistedParentStillBindsMobileTerminalLeaf: RuntimeMobileSessionFacade['persistedParentStillBindsMobileTerminalLeaf']
  isRuntimeOwnedHeadlessMobileTab: RuntimeMobileSessionFacade['isRuntimeOwnedHeadlessMobileTab']
  mergePreservedHeadlessMobileSessionTabs: RuntimeMobileSessionFacade['mergePreservedHeadlessMobileSessionTabs']
  buildPreservedHeadlessMobileSessionSnapshot: RuntimeMobileSessionFacade['buildPreservedHeadlessMobileSessionSnapshot']
  buildHeadlessMobileSessionTerminalTabs: RuntimeMobileSessionFacade['buildHeadlessMobileSessionTerminalTabs']
  buildHeadlessMobileSessionBrowserTabs: RuntimeMobileSessionFacade['buildHeadlessMobileSessionBrowserTabs']
  buildHeadlessMobileSessionTabGroups: RuntimeMobileSessionFacade['buildHeadlessMobileSessionTabGroups']
  mobileSnapshotValueEqual: RuntimeMobileSessionFacade['mobileSnapshotValueEqual']
  reconcileHeadlessMobileSessionBrowserTabs: RuntimeMobileSessionFacade['reconcileHeadlessMobileSessionBrowserTabs']
  mergeMobileSessionSnapshotTabs: RuntimeMobileSessionFacade['mergeMobileSessionSnapshotTabs']
  mergeMobileSessionTabGroups: RuntimeMobileSessionFacade['mergeMobileSessionTabGroups']
  storedMobileSnapshotHasStalePreservedTab: RuntimeMobileSessionFacade['storedMobileSnapshotHasStalePreservedTab']
  notifyMobileSessionTabSnapshots: RuntimeMobileSessionFacade['notifyMobileSessionTabSnapshots']
  emitMobileSessionTabsSnapshotToClient: RuntimeMobileSessionFacade['emitMobileSessionTabsSnapshotToClient']
  getMobileSessionWorktreeIdsForPty: RuntimeMobileSessionFacade['getMobileSessionWorktreeIdsForPty']
  touchMobileSessionTabsForPane: RuntimeMobileSessionFacade['touchMobileSessionTabsForPane']
}

export class OrcaRuntimeService {
  static {
    installBrowserEmulatorCommandDelegations(
      OrcaRuntimeService,
      (service) => service.browserScreencastCommands as never,
      (service) => service.emulatorCommands
    )
    installLinearCommandDelegations(
      OrcaRuntimeService,
      (service) => service.linearCommands as never
    )
    installGitCommandDelegations(OrcaRuntimeService, (service) => service.gitCommands)
    installFileCommandDelegations(OrcaRuntimeService, (service) => service.fileCommands)
    installMobileTabCommandDelegations(OrcaRuntimeService, (service) => service.mobileSessionFacade)
  }

  private readonly runtimeId = randomUUID()
  private readonly startedAt = Date.now()
  private readonly store: RuntimeStore | null
  private readonly linearCommands: RuntimeLinearCommands
  private readonly automationCommands: RuntimeAutomationCommands
  private readonly skillArtifactCommands: RuntimeSkillArtifactCommands
  private readonly skillInstallCommands: RuntimeSkillInstallCommands
  private readonly projectWorktreeCommands: RuntimeProjectWorktreeCommands
  private readonly repoGitCommands: RuntimeRepoGitCommandsFacade
  private readonly orchestrationCommands: RuntimeOrchestrationCommands
  private readonly orchestrationGraphReloadCommands: RuntimeOrchestrationGraphReloadCommands
  private readonly headlessSessionTabPersistenceCommands: RuntimeHeadlessSessionTabPersistenceCommands
  private readonly ptyTitleTrackingCommands: RuntimePtyTitleTrackingCommands
  private readonly terminalAgentStatusBinding: RuntimeTerminalAgentStatusBindingCommands
  private readonly clientEventPublishingCommands: RuntimeClientEventPublishingCommands
  private readonly hookAgentRowResolutionCommands: RuntimeHookAgentRowResolutionCommands
  private readonly managedBaseCommands: RuntimeManagedBaseCommands
  private readonly remoteDesktopCommands: RuntimeRemoteDesktopCommands
  private readonly clientConnectionCommands: RuntimeClientConnectionCommands
  private readonly windowGraphClientCommands: RuntimeWindowGraphClientCommands
  private readonly terminalRecoveryCommands: RuntimeTerminalRecoveryCommands
  private readonly worktreePs: RuntimeWorktreePs
  private readonly mobileTabOperations: RuntimeMobileTabOperations
  private readonly agentClusterFacade: RuntimeAgentClusterFacade
  private readonly mobileSessionFacade: RuntimeMobileSessionFacade
  private readonly ptyWorktrees: RuntimePtyWorktrees
  private readonly terminalClusterFacade: RuntimeTerminalCluster
  private readonly managedWorktrees: RuntimeManagedWorktrees
  private readonly resolvedWorktreeCache: RuntimeResolvedWorktreeCache
  private readonly disposalTree: RuntimeDisposalTree
  private readonly orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport | null
  // Why: consumed via bracket access by runtime-orchestration-federation.ts; a
  // regression silently dropped these declarations and left every read as `any`/undefined.
  private readonly orchestrationFederationTimers = new Map<string, ReturnType<typeof setInterval>>()
  private orchestrationTerminalHistoryRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private orchestrationTerminalHistoryRecoveryInFlight: Promise<void> | null = null
  private orchestrationTerminalRecoveryRowId = 0
  private orchestrationFederationRelayGeneration = 0
  private readonly orchestrationFederationSyncs = new Map<
    string,
    { db: OrchestrationDb; promise: Promise<void> }
  >()
  private readonly orchestrationFederationWarnings = new Set<string>()
  private rendererGraphEpoch = 0
  private graphStatus: RuntimeGraphStatus = 'unavailable'
  private authoritativeWindowId: number | null = null
  private headlessGraphFallbackAvailable = false
  private pendingHeadlessPromotionWindowId: number | null = null
  private rendererGeneration: string | null = null
  private mobileSessionTabsChangeSequence = 0
  private readonly graphReloadLifecycle = new RuntimeGraphReloadLifecycle({
    timeoutMs: RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
    onSettled: ({ revision, windowId, outcome, durationMs }) => {
      console.info(
        `[runtime-graph] reload revision=${revision} window=${windowId} outcome=${outcome} durationMs=${durationMs}`
      )
    },
    onTimeout: (_revision, windowId) => this.handleGraphReloadTimeout(windowId)
  })
  // Why: paired graph transactions need foreground timer cadence only until their publication settles.
  private readonly rendererPublicationThrottle = new RendererPublicationThrottle()
  private tabs = new Map<string, RuntimeSyncedTab>()
  private mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()
  private readonly clientHostedPageReconciliation = new ClientHostedPageReconciliationWindow(
    Date.now()
  )
  // Why: renderer publication ordering must be judged against the renderer's
  // own last-accepted (epoch, version) — never against the stored snapshot's
  // version, which main-local touches bump independently and can push
  // permanently ahead of the renderer's counter. The renderer reuses one pair
  // for byte-identical content, so a same-epoch version <= this one is a no-op
  // resend (or stale) and is skipped without touching the stored entry.
  private acceptedRendererMobileSnapshotByWorktree = new Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
    }
  >()
  // Why: idempotency map for mobile terminal creation — a retried create with the
  // same clientMutationId returns the in-flight operation instead of duplicating.
  private readonly terminalCreateIdempotency = new RemoteRuntimeTerminalCreateIdempotency()
  // Why: concurrent clients sleeping one host workspace must share one physical teardown.
  private terminalSleepByWorktreeId = new Map<string, Promise<RuntimeWorktreeTerminalSleepResult>>()
  private terminalMutationTailByWorktreeId = new Map<string, Promise<void>>()
  private terminalSleepStateByWorktreeId = new Map<
    string,
    {
      worktreeId: string
      generation: number
      phase: 'stopping' | 'partial' | 'sleeping'
      ptyIds: string[]
      terminalHandles: string[]
      terminalHandlesByPtyId: Record<string, string[]>
    }
  >()
  private terminalPaneRecoveryByIdentity = new Map<string, Promise<RuntimeTerminalResolvePane>>()
  // Why: idempotency map for worktree.create — a create interrupted by a mobile
  // connection migration is retried with the same clientMutationId and returns
  // the in-flight (or just-finished) operation instead of a duplicate worktree.
  // Why: a mobile create waits for the renderer to publish the new tab's surface
  // via graph-sync, but a throttled/hidden renderer can park that past the surface
  // timeout and the create would then destroy the live PTY (#7587). This lets the
  // renderer's own PTY spawn publish the surface main-side, scoped to in-flight
  // creates so ordinary renderer spawns never publish here.
  private pendingMobileTerminalCreatesByKey = new Map<
    string,
    {
      activate: boolean
      paired: boolean
      selectIfNoActiveTab: boolean
      viewMode?: 'terminal' | 'chat'
      /** Resolved agent launch command, kept so a settle over a bare renderer
       *  PTY can still deliver the launch instead of succeeding silently (STA-3214). */
      startupCommand?: string
    }
  >()
  private mobileSessionTabListeners = new Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void
    clientNavigationId?: string
  }>()
  // Why: one watermark per repo replaces per-closed-pane fences while preserving stale-write safety.
  private terminalTopologyRevisionByRepoId = new Map<string, number>()
  // Why: provider exit can beat surface registration; that exact dead incarnation must never publish.
  private earlyExitedPtyIncarnations = new Map<string, PtyIncarnationId | null>()
  private pendingPtyRegistrationIncarnations = new Map<string, PtyIncarnationId | null>()
  // Why: exact-stop is the current sleep transaction boundary; its exit must
  // leave the renderer's intentional sleeping surface available for wake.
  private intentionalHandlelessPtyStops = new Map<string, string | null>()
  // Why: coalesces title/status-driven session.tabs emits so spinner churn
  // doesn't fan out (and per-client JSON.stringify) a snapshot several times a
  // second. Emit reads the latest snapshot, so only the freshest version ships.
  private readonly mobileSessionTabsAgentStatusHeartbeat: MobileSessionTabsAgentStatusHeartbeat =
    createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => this.getMobileSessionWorktreeIdsForPty(ptyId),
      (worktreeId) => this.touchMobileSessionTabsForWorktree(worktreeId)
    )
  // Why: concurrent host terminal.focus storms (CLI switch fan-out / bulk open)
  // each await a full host reveal; only one terminal can be focused, so latest-wins
  // single-flight bounds host work. Does not replace cheaper activation or
  // reconnect-scan bounding for sequential soft freezes.
  private readonly terminalFocusNavigationCoalescer =
    new TerminalFocusNavigationCoalescer<RuntimeTerminalFocus>()
  private leaves = new Map<string, RuntimeLeafRecord>()
  // Why: consolidated store for all pty-keyed state. Fields are optional to support
  // lazy initialization and deletion on pty exit. Access via ptyRecordsById.get(ptyId)?.fieldName
  private ptyRecordsById = new Map<string, PtyRuntimeRecord>()
  // Why: PTY output is a per-keystroke hot path. Looking up affected leaves by
  // ptyId keeps active TUI redraws independent of the total open terminal count.
  private leavesByPtyId = new Map<string, RuntimeLeafRecord[]>()
  private handles = new Map<string, TerminalHandleRecord>()
  private handleByLeafKey = new Map<string, string>()
  private handleByPtyId = new Map<string, string>()
  private handleByPtyIncarnation = new Map<string, PtyIncarnationHandleRecord>()
  private readonly mailPointerRepointScheduler = new MailPointerRepointScheduler((handle) =>
    this.repointPendingMessagesForHandle(handle)
  )
  private syntheticTerminalHandles = new Set<string>()
  private detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()
  private graphSyncCallbacks: (() => void)[] = []
  private sessionTabsInventoryPublicationEpoch: number | null = null
  private sessionTabsInventoryWaiters = new Set<() => void>()
  private waitersByHandle = new Map<string, Set<TerminalWaiter>>()
  private ptyExitListenersByPtyId = new Map<string, Set<() => void>>()
  private ptyController: RuntimePtyController | null = null
  private notifier: RuntimeNotifier | null = null
  private clientEventListeners = new Set<(event: RuntimeClientEvent) => void>()
  // Why: mobile subscribers discard terminalSideEffects; exclude them from batch delivery and production.
  private terminalSideEffectExcludedClientEventListeners = new Set<
    (event: RuntimeClientEvent) => void
  >()
  private terminalSideEffectTitleGateKeysByClientEventListener = new Map<
    (event: RuntimeClientEvent) => void,
    Map<string, string>
  >()
  private nativeChatLaunchDraftResolutionByTabId = new Map<
    string,
    NativeChatLaunchDraftResolutionTombstone
  >()
  private forkBackfillStarted = false
  private agentBrowserBridge: AgentBrowserBridge | null = null
  private offscreenBrowserBackend: BrowserBackend | null = null
  private emulatorBridge: EmulatorBridge | null = null
  private cloneInFlightByPath = new Map<string, Promise<void>>()
  private ptyForegroundAgentRefreshes = new Map<string, PtyForegroundAgentRefresh>()
  private ptyForegroundProcessReads = new Map<string, PtyForegroundProcessReadEntry>()
  private ptyDelayedForegroundSnapshotTitleObservations = new Map<string, number>()
  // Why a set and not a timer: the intent is retired by the exit it explains, or
  // by the next lifecycle generation on that id (advancePtyLifecycleGeneration),
  // so a stop that never produced an exit cannot outlive its process.
  private readonly stopRequestedPtyIds = new Set<string>()
  private _orchestrationDb: OrchestrationDb | null = null
  private messageWaitersByHandle = new Map<string, Set<MessageWaiter>>()
  private readonly orchestrationMailboxOwner = new OrchestrationMailboxOwner({
    getDb: () => this._orchestrationDb,
    getLeaf: (leafKey) => this.leaves.get(leafKey),
    getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
    getTerminalHandleForLeafKey: (leafKey) => this.handleByLeafKey.get(leafKey),
    getTerminalProcessIncarnation: (handle) => this.getTerminalProcessIncarnation(handle),
    onRoutedMessageTypes: (mailboxHandle, types) =>
      this.orchestrationMailboxNotifications.wakeRoutedMessageWaiters(mailboxHandle, types),
    onForeignMailboxRouted: (mailboxHandle, messageType) =>
      this.notifyMessageArrived(mailboxHandle, messageType)
  })
  private readonly orchestrationMailboxDeliveryTarget = new OrchestrationMailboxDeliveryTarget({
    getDb: () => this._orchestrationDb,
    getTerminalHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    hasTerminalHandle: (handle) => this.handles.has(handle),
    canProbePtyLiveness: () => Boolean(this.ptyController?.probePtyLiveness),
    controllerKnowsPtyIsLive: (ptyId) => this.controllerKnowsPtyIsLive(ptyId),
    isLeafPtyProvenAbsent: (ptyId) => this.isLeafPtyProvenAbsent(ptyId)
  })
  private readonly orchestrationMailboxPointerDelivery =
    new OrchestrationMailboxPointerDelivery<MessageWaiter>({
      mailboxOwner: this.orchestrationMailboxOwner,
      deliveryTarget: this.orchestrationMailboxDeliveryTarget,
      getDb: () => this._orchestrationDb,
      getLeaf: (leafKey) => this.leaves.get(leafKey),
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle).leaf,
      getMessageWaiters: (mailboxHandle) => this.messageWaitersByHandle.get(mailboxHandle),
      getTabTitle: (tabId) => this.tabs.get(tabId)?.title,
      getTerminalHandleForLeafKey: (leafKey) => this.handleByLeafKey.get(leafKey),
      isLeafPtyProvenAbsent: (ptyId) => this.isLeafPtyProvenAbsent(ptyId),
      redriveMailbox: (mailboxHandle, reservedTypes) =>
        this.deliverPendingMessagesForHandle(mailboxHandle, reservedTypes),
      writePty: (ptyId, data) => this.writeOrchestrationPointerPty(ptyId, data)
    })
  private readonly orchestrationMailboxNotifications =
    new OrchestrationMailboxNotificationCoordinator<MessageWaiter>({
      mailboxOwner: this.orchestrationMailboxOwner,
      pointerDelivery: this.orchestrationMailboxPointerDelivery,
      getDb: () => this._orchestrationDb,
      getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle).leaf,
      getPaneKeyForHandle: (handle) => {
        const record = this.handles.get(handle)
        return record ? `${record.tabId}:${record.leafId}` : undefined
      },
      getMessageWaiters: (mailboxHandle) => this.messageWaitersByHandle.get(mailboxHandle),
      hasTerminalHandle: (handle) => this.handles.has(handle),
      deliverForHandle: (handle, reservedTypes) =>
        this.deliverPendingMessagesForHandle(handle, reservedTypes),
      notifyMessageArrived: (handle, messageType) => this.notifyMessageArrived(handle, messageType),
      resolveMessageWaiter: (waiter) => this.resolveMessageWaiter(waiter, 'notified')
    })
  // Why: mobile clients subscribe to terminal output via terminal.subscribe.
  // These listeners fire on every onPtyData call, enabling real-time streaming
  // without polling. Keyed by ptyId for O(1) lookup per data event.
  private dataListeners = new Map<
    string,
    Set<(data: string, meta?: RuntimeTerminalDataMeta) => void>
  >()
  // Why: startup draft paste can subscribe after the agent already emitted its
  // ready marker. Keep a bounded raw buffer so fast startup output is replayed.
  private recentPtyOutputById = new Map<string, RecentPtyOutputBuffer>()
  private setupCompletionTokenByPtyId = new Map<string, string>()
  // Why: mobile clients need to know when the desktop restores a terminal
  // from mobile-fit so they can update their UI. These listeners are
  // invoked from resizeForClient and onClientDisconnected/onPtyExit.
  private fitOverrideListeners = new Map<
    string,
    Set<
      (event: {
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    >
  >()
  private driverListeners = new Map<string, Set<(driver: DriverState) => void>>()
  private subscriptionCleanups = new Map<string, () => void | Promise<void>>()
  private subscriptionCleanupPromises = new Map<
    string,
    { cleanup: () => void | Promise<void>; promise: Promise<void> }
  >()
  // Why: index of subscriptionIds by per-WebSocket connectionId so the
  // server can sweep all subscriptions for a closing socket without
  // touching subscriptions on other live sockets that share the same
  // deviceToken (multi-screen mobile).
  private subscriptionsByConnection = new Map<string, Set<string>>()
  private subscriptionConnectionByEntry = new Map<string, string>()
  // Why: a connection record replaces whatever else that socket was streaming regardless of who
  // is driving, so it deliberately carries no pairing scope.
  private activeBrowserScreencastsByConnection = new Map<
    string,
    Omit<BrowserScreencastSubscriber, 'drivesAsMobile'>
  >()
  private activeBrowserScreencastsByPage = new Map<string, Set<BrowserScreencastSubscriber>>()
  // Why: paint retention, not control — Chromium stops painting a display:none guest, so the host
  // renderer must keep any page a remote client is watching mounted even when nobody drives it.
  private browserRemoteViewerPages = new Set<string>()
  // Why: mobile clients subscribe to desktop notifications via
  // notifications.subscribe. This set enables fan-out — each connected
  // mobile client gets its own listener, and dispatchMobileNotification
  // iterates them all. Listeners are cleaned up via subscriptionCleanups.
  private notificationListeners = new Set<(event: MobileNotificationEvent) => void>()
  private ptysById = new Map<string, RuntimePtyWorktreeRecord>()
  // Why a separate map: `connected` is a wire field that any inventory gap
  // clears, so it cannot distinguish an observed exit from lost contact. This
  // records the last liveness verdict we actually earned, and outlives the pty
  // record so a close/stop receipt can still say the stop was unconfirmed.
  private ptyLivenessVerdictByPtyId = new Map<string, TrackedPtyLivenessVerdict>()
  private ptyLivenessObservationSequence = 0
  private readonly pairedRendererSessionOwnedPtyIds = new Set<string>()
  private wslDistroByPtyId = new Map<string, string>()
  private headlessTerminals = new Map<string, RuntimeHeadlessTerminal>()
  private ptyOutputSequenceById = new Map<string, number>()
  private agentPromptLifecycleByPtyId = new Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >()
  private agentPromptPermissionSequenceByPtyId = new Map<string, number>()
  private agentPromptExplicitStatusFloorByPtyId = new Map<string, number>()
  private agentPromptSubmissionTailByPtyId = new Map<string, Promise<void>>()
  private providerSequenceInitializedPtys = new Set<string>()
  private providerSequenceOffsetByPtyId = new Map<string, number>()
  private providerSnapshotPreferredPtys = new Set<string>()
  private providerModeTrackersByPtyId = new Map<string, TerminalKittyKeyboardModeTracker>()
  private providerModeSnapshotScansByPtyId = new Map<
    string,
    Set<TerminalKittyKeyboardModeTracker>
  >()
  private providerBufferAcquisitionsByPtyId = new Map<string, ProviderBufferAcquisition>()
  private providerVisibleStateByPtyId = new Map<string, RuntimeVisibleTerminalState>()
  private providerVisibleRetryAtByPtyId = new Map<string, number>()
  private providerSnapshotsWithLiveModeTransition = new WeakSet<PtyProviderBufferSnapshot>()
  private ptyLifecycleGenerationById = new Map<string, number>()
  private nextPtyLifecycleGeneration = 1
  private recentPtyPathCandidatesById = new Map<string, string[]>()
  // Why: candidates only feed mobile file-tap provenance; desktop-only
  // sessions skip the 3-regex extraction on every PTY chunk until a
  // mobile/remote client authenticates (sticky, backfilled on activation).
  // Why: OSC 9999 status can span PTY chunks. Keeping parser state in the
  // runtime lets hidden/model-owned terminals observe agent state without a
  // mounted xterm view.
  // Why a throttle: the blocked-reason check builds and scans two full wait
  // texts (<=256KB each, lowercased) — measured at ~85% of onPtyData's cost
  // under a TUI flood (findings log 2026-07-03). PTY chunk boundaries are
  // arbitrary, so running the identical computation over coalesced chunks at
  // a bounded cadence (plus a trailing-edge timer so burst-final state is
  // always evaluated) preserves semantics while removing it from the hot path.
  private waitBlockedCheckStateByPtyId = new Map<
    string,
    {
      lastAt: number
      lastWaitState: TerminalTailWaitState | null
      appended: string
      keywordCarry: string
      timer: ReturnType<typeof setTimeout> | null
    }
  >()

  private agentStatusOscProcessorsByPtyId = new Map<string, AgentStatusOscProcessor>()
  // Why: per-PTY shared title trackers (all-titles ordering + stale-working
  // timer) replace last-title-per-chunk scanning so main observes the same
  // intra-chunk working→idle transitions the renderer does (issue #1083).
  // Lazily created like agentStatusOscProcessorsByPtyId; disposed on PTY exit.
  private ptyTitleTrackersByPtyId = new Map<string, RuntimePtyTitleTrackerEntry>()
  // Why: the Command Code output detector arms early from the launch command
  // when known (banner detection covers user-typed launches), mirroring the
  // renderer detector's startupCommand seed.
  private terminalSpawnCommandsByPtyId = new Map<string, string>()
  // Why: ordinary OSC 0/1/2 titles can split across PTY chunks, especially over
  // SSH/relay buffering. Keep a small raw scan tail and feed reconstructed
  // chunks into the title tracker instead of falling back to last-title scans.
  private oscTitleScanTailByPtyId = new Map<string, string>()
  // Why: mobile file taps resolve relative paths on the host. OSC 7 is the
  // terminal-owned cwd signal, and it can arrive in live output between snapshots.
  private osc7ScanTailByPtyId = new Map<string, string>()
  private terminalCwdByPtyId = new Map<string, string>()
  private terminalFileUriHostnameByPtyId = new Map<string, string>()
  // Why: latest agent-status payload per pane, retained so worktree.ps can serve
  // mobile the same inline agent rows the desktop sidebar renders. Cleared on pty
  // teardown so dead agents don't linger. See RuntimeAgentRowSnapshot.
  private latestAgentStatusByPaneKey = new Map<string, RuntimeAgentRowSnapshot>()
  // Why: per-PTY hydration state guards against double-hydration. Keys:
  //   'pending'  → maybeHydrateHeadlessFromRenderer is in flight
  //   'done'     → hydration completed (success or skip); never run again
  // Absent  → hydration has not been considered yet for this PTY.
  // See docs/mobile-prefer-renderer-scrollback.md.
  private headlessHydrationState = new Map<string, 'pending' | 'done'>()
  // Why: mobile-fit overrides are keyed by ptyId (not terminal handle) because
  // handles can be reissued while the PTY identity is stable. In-memory only —
  // a stale phone override should not survive an app restart.
  private terminalFitOverrides = new Map<
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
  >()

  // Why: server-authoritative display mode per terminal. 'auto' (default)
  // means phone-fit when mobile subscribes, desktop otherwise. 'desktop'
  // locks to no-resize regardless of subscriber state. The third historical
  // value ('phone' = sticky phone-fit after unsubscribe) was removed since
  // the toggle UI never produced it and nothing in product depended on it.
  // In-memory only — modes reset on restart.
  // Why: tracks active mobile subscribers per PTY so the runtime can restore
  // desktop dimensions on unsubscribe and prevent orphaned overrides during
  // rapid tab switches. Keyed by ptyId → inner map of clientId → subscriber.
  // The two-level map preserves multi-mobile soundness: phone B subscribing
  // does not silently overwrite phone A's record. See
  // docs/mobile-presence-lock.md "Multi-mobile subscriber model".
  // subscribedAt drives "earliest-by-subscribe-time" restore-target selection
  // (only among subscribers with non-null previousCols/Rows; desktop-mode
  // joins carry null and are skipped). lastActedAt drives "most-recent
  // actor's viewport wins" for active phone-fit dims.
  private mobileSubscribers = new Map<
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
  >()

  // Why: Phase-5 query-responder suppression — a terminal-RPC subscribe
  // stream feeds a remote xterm view (mobile/web/remote desktop) that answers
  // queries with view authority, so main must yield while one is attached
  // (terminal-query-authority.md). Ref-counted per PTY because multiple
  // streams can attach concurrently; mobileSubscribers is consulted too so
  // grace-window mobile records keep suppressing.
  private remoteTerminalViewSubscriberCounts = new Map<string, number>()
  // Preview windows consume the raw stream but deliberately leave terminal
  // query replies to main's headless emulator.
  private rawTerminalViewSubscriberCounts = new Map<string, number>()
  // Why a sticky promise per PTY: the daemon only emits data for sessions this
  // app has attached, so the first remote view subscriber of a never-attached
  // local daemon session triggers a main-side attach. The map dedupes
  // concurrent first-subscribes and keeps later subscribes no-ops; it is
  // cleared per lifecycle generation (exit/respawn) and on failed attempts.
  private subscriberDrivenProviderAttachesByPtyId = new Map<string, Promise<boolean>>()
  private subscriberDrivenProviderAttachInventoryWaiters = new Set<string>()
  // Why: a spawn through this app already attaches its provider stream, so
  // subscriber-driven attach and the never-attached read fallback must target
  // only inventory-discovered sessions no local spawn published this
  // generation (a replacement spawn under a reused id starts clean).
  private spawnPublishedPtys = new Set<string>()

  // Why: per-PTY driver state. The "driver" is whoever currently owns the
  // input/resize floor. While `kind === 'mobile'` the desktop renderer drops
  // xterm.onData/onResize and shows the lock banner; `terminal.send` /
  // `pty:write` and `pty:resize` IPC handlers also drop desktop-side calls
  // server-side as defense-in-depth. The `clientId` carried on the mobile
  // variant is the most recent mobile actor — used by
  // `applyMobileDisplayMode` to pick the active phone-fit viewport. See
  // docs/mobile-presence-lock.md.
  private currentDriver = new Map<string, DriverState>()
  private currentBrowserDriver = new Map<string, RuntimeBrowserDriverState>()

  // Why: remote (relay/shared-control) desktop viewers of a PTY are keyed by
  // subscription, not client, because one client can open duplicate streams and
  // each stream must release only the width floor it registered.
  private remoteDesktopViewers = new Map<
    string,
    Map<string, { clientId: string; cols: number; rows: number; activity: number }>
  >()
  private remoteDesktopOwners = new Map<string, string>()
  private remoteDesktopActivity = 0
  private remoteDesktopHostReclaimTargets = new Map<string, { cols: number; rows: number }>()
  // Why: a completed host reclaim must not consume the cache if a newer
  // viewer mutation landed while that serialized layout was in flight.
  private remoteDesktopViewerRevisions = new Map<string, number>()

  // Why: resubscribe-grace window. When the last mobile subscriber for a
  // PTY unsubscribes, we hold the driver=mobile{clientId} state and the
  // inner-map record open for ~250ms. If the same (ptyId, clientId)
  // re-subscribes inside the window — typically because the mobile app
  // tore down the stream to reconfigure (rare with the new
  // updateMobileViewport path, but still possible on reconnects, network
  // hiccups, or older client builds) — we cancel the deferred idle and
  // restore-timer so the desktop banner doesn't flash and the new
  // subscriber doesn't capture an already-phone-fitted PTY size as its
  // restore baseline. Keyed by ptyId; carries the timer plus the snapshot
  // of the leaving subscriber so we can re-insert it on cancel. See
  // docs/mobile-presence-lock.md.
  private pendingSoftLeavers = new Map<
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
  >()

  // Why: tracks the last PTY size set by the desktop renderer (via pty:resize
  // IPC). Unlike ptySizes (which is overwritten by server-side phone-fit
  // resizes), this map preserves the actual pane geometry. Used as the
  // preferred source for previousCols so desktop restore uses the correct
  // split-pane width instead of a stale full-width value.
  private lastRendererSizes = new Map<string, { cols: number; rows: number }>()

  // Why: when a desktop-fit override change fires, the desktop renderer's
  // re-render cascade (triggered by setOverrideTick) runs safeFit on ALL
  // panes — not just the affected one. Background tab panes get measured at
  // full-width (214) instead of their correct split width (105). The stale
  // pty:resize IPCs overwrite both the actual PTY size and lastRendererSizes.
  // This global window suppresses ALL pty:resize for 200ms after any
  // desktop-fit notification. The server has already set the correct PTY
  // size via ptyController.resize(), so desktop renderer resizes during
  // this window are redundant (for the restored pane) or wrong (collateral).
  private resizeSuppressedUntil = 0

  // Why: delays PTY restore by 300ms after mobile unsubscribe so rapid tab
  // switches don't cause unnecessary resize thrashing. Keyed by clientId
  // Why: keyed by ptyId so each PTY gets its own independent restore timer.
  // The old clientId-keyed design lost timers when two PTYs were unsubscribed
  // back-to-back (only the last timer survived).
  private pendingRestoreTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >()

  // Why: inline resize events replace the unsubscribe→resubscribe pattern.
  // Listeners are notified when mode changes or desktop restores, allowing
  // the subscribe stream to emit a 'resized' event with fresh scrollback.
  // `seq` is the layout state-machine sequence number bumped on every
  // applyLayout success; mobile clients use it to drop stale events that
  // arrive after a newer transition. See docs/mobile-terminal-layout-state-machine.md.
  private resizeListeners = new Map<
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
  >()

  // Why: per-PTY layout state machine. `applyLayout` is the sole writer of
  // `layouts`, `terminalFitOverrides`, and `ptyController.resize`; every
  // trigger method routes through `enqueueLayout`. The monotonic `seq` is
  // emitted on the mobile subscribe stream so clients can drop stale events.
  // See docs/mobile-terminal-layout-state-machine.md.
  private layouts = new Map<string, PtyLayoutState>()

  // Why: per-PTY async serialization queue for applyLayout. Without
  // serialization, two concurrent triggers can interleave around the
  // ptyController.resize await and bump seq in the wrong order, defeating
  // seq-as-truth. Coalesces same-kind same-owner viewport ticks so the
  // keyboard-show/hide animation doesn't queue 10+ resizes; mode flips,
  // take-floor, and different-owner targets always append (preserves
  // multi-mobile fairness). See docs/mobile-terminal-layout-state-machine.md
  // "enqueueLayout coalescing".
  private layoutQueues = new Map<string, LayoutQueueEntry>()

  // Why: gate so enqueueLayout's "no layouts entry" short-circuit doesn't
  // fire on the very first transition for a PTY (where the entry doesn't
  // exist yet *because* we're about to create it). `handleMobileSubscribe`
  // adds the ptyId before calling enqueueLayout and removes it after the
  // call resolves.
  private freshSubscribeGuard = new Set<string>()

  private stats: StatsCollector | null = null
  // Why (§3.3 + §7.1): the renderer-create path and coordinator
  // `probeWorktreeDrift` share this cache so a create that already fetched
  // `origin` within the last 30s does not re-fetch during dispatch, and
  // vice-versa. Keyed by `<repoPath>::<remote>` so multi-remote repos (even
  // though v1 only uses `origin`) don't cross-contaminate. The in-flight Map
  // also provides serialization — two concurrent callers share a single
  // underlying `git fetch`. Full-remote fetch lifecycle rules:
  //   - entry inserted BEFORE await,
  //   - `.finally()` removes the entry on BOTH success and rejection,
  //   - timestamp written ONLY on success (rejection must not make the
  //     30s freshness cache lie).
  // A literal "insert before await / read-back after await" without these
  // three rules wedges future fetches on the same repo after a single
  // DNS hiccup until process restart (see §3.3 Lifecycle). Exact base-ref
  // refreshes share the in-flight rule and maintain their own exact-base
  // freshness entries; a full-remote fetch may be narrowed by repo refspecs,
  // so it must not prove a specific branch for create.
  // Why: `git fetch origin` and `git fetch origin <refspec>` contend for the
  // same repo remote/ref locks. This queue serializes all fetch shapes for one
  // canonical repo+remote while still letting same-shape callers share promises.
  private fetchLastCompletedAt = new Map<string, number>()
  // Why: `getCanonicalFetchKey` is awaited from every freshness probe and
  // every getOrStartRemoteFetch call. Without memoization the warm-cache hot
  // path spawns a `git rev-parse --git-common-dir` subprocess per touch
  // (twice in createLocalWorktree). Cache by `<repoPath>::<remote>` so the
  // canonical key is resolved at most once per repo+remote in the process.
  private canonicalFetchKeyCache = new Map<string, string>()
  private readonly getLocalProviderFn: (() => IPtyProvider) | null
  private readonly getSshProviderFn: ((connectionId: string) => IPtyProvider | undefined) | null
  private readonly onPtyStopped: ((ptyId: string) => void) | null
  private readonly onTerminalAgentStatus: ((event: RuntimeTerminalAgentStatusEvent) => void) | null
  private readonly onTerminalSideEffects: ((batch: TerminalSideEffectBatch) => void) | null
  private terminalSideEffectLocalConsumerAvailable = false
  private terminalSideEffectConsumerAvailable = false
  private readonly getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  private readonly getAgentProviderSessionSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  private readonly getAgentProviderSessionRowsForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null
  private readonly retireAgentHookCompatibilityAuthorityFn: ((paneKey: string) => void) | null
  private readonly reconcileAgentStatusForEndedProcessFn:
    | ((paneKeys: Iterable<string>) => void)
    | null
  private readonly canRecoverPersistentLocalPtysFn: () => boolean
  private readonly getPairedDeviceNameFn: (pairedDeviceId: string) => string | null
  private readonly buildAgentHookPtyEnv: (() => Record<string, string>) | null
  private readonly getDesktopWindowStatusFn: () => RuntimeDesktopWindowStatus
  private readonly prepareAiVaultSessionResumeFn:
    | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
    | null
  private readonly prepareCodexStructuredLaunchFn:
    | ((input: {
        workspacePath: string
        launchEnv: NodeJS.ProcessEnv
      }) => string | null | Promise<string | null>)
    | null
  private readonly agentSessionClaimSigner: AgentSessionClaimSigner
  private readonly agentSessionCreateOperations = new Map<string, AgentSessionCreateOperation>()
  private readonly orchestrationCompatibilitySshAttachments = new Map<
    string,
    OrchestrationCompatibilitySshAttachmentAuthority
  >()
  private sshRelayRecoveryGenerationByTargetId = new Map<string, number>()
  private legacyWorkerTerminalRecoveryRetries = new Map<
    string,
    {
      attempt: number
      connectionId?: string
      materializeRenderer: boolean
      timer: ReturnType<typeof setTimeout> | null
    }
  >()
  private legacyWorkerTerminalReceiptEpochByPane = new Map<string, number>()
  private legacyWorkerRecoveredPtys = new Set<string>()
  private restoredOrchestrationAuthorityByPtyId = new Map<
    string,
    RestoredOrchestrationAuthorityReceipt
  >()
  private readonly accountCommands = new RuntimeAccountCommands()
  private commitMessageAgentEnv: CommitMessageAgentEnvironmentResolvers | null = null
  private automationService: AutomationService | null = null
  private readonly skillTransactionRecovery: Promise<unknown>
  private readonly claudeAgentTeams = new ClaudeAgentTeamsService()

  constructor(
    store: RuntimeStore | null = null,
    stats?: StatsCollector,
    deps?: {
      getLocalProvider?: () => IPtyProvider
      getSshProvider?: (connectionId: string) => IPtyProvider | undefined
      onPtyStopped?: (ptyId: string) => void
      onTerminalAgentStatus?: (event: RuntimeTerminalAgentStatusEvent) => void
      onTerminalSideEffects?: (batch: TerminalSideEffectBatch) => void
      // Why: agent status mostly arrives via hooks (agent-hooks/server), not OSC
      // terminal output. worktree.ps reads this at query time so mobile shows the
      // same inline agent rows the desktop sidebar does — same source, 1:1.
      getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
      /** Same rows, but including the resume-identity-only ones `getAgentStatusSnapshot`
       *  filters out so they can't read as running agents. Mobile native chat needs
       *  them: for an agent that publishes identity separately (Pi), that row is the
       *  only carrier of the provider session a transcript is addressed by. */
      getAgentProviderSessionSnapshot?: () => AgentStatusIpcPayload[]
      getAgentProviderSessionRowsForPane?: (paneKey: string) => AgentStatusIpcPayload[]
      attestAgentHookCompatibilityAuthority?: (candidate: {
        paneKey: string
        launchTokenHash: string
        connectionId: string | null
        terminalProvenance: 'current_runtime' | 'restored'
      }) => AgentHookAuthorityAttestation | null
      retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
      reconcileAgentStatusForEndedProcess?: (paneKeys: Iterable<string>) => void
      canRecoverPersistentLocalPtys?: () => boolean
      // Why: the device registry lives on the RPC server, which is constructed with this runtime;
      // a closure defers the lookup past that ordering instead of inverting ownership.
      getPairedDeviceName?: (pairedDeviceId: string) => string | null
      // Why: codex-home paths for the Agent Session History scan must be sourced
      // here, not via the window-only registerCoreHandlers path — that path never
      // runs under `orca serve`, so remote/SSH hosts would silently drop
      // managed-Codex sessions. The runtime ctor runs in BOTH window and serve.
      getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
      prepareAiVaultSessionResume?: (
        args: AiVaultPrepareSessionResumeArgs
      ) => Promise<AiVaultPrepareSessionResumeResult>
      prepareCodexStructuredLaunch?: (input: {
        workspacePath: string
        launchEnv: NodeJS.ProcessEnv
      }) => string | null | Promise<string | null>
      buildAgentHookPtyEnv?: () => Record<string, string>
      getDesktopWindowStatus?: () => RuntimeDesktopWindowStatus
      agentSessionClaimSigner?: AgentSessionClaimSigner
      orchestrationEnvironmentTransport?: OrchestrationEnvironmentTransport
      skillTransactionRecovery?: Promise<unknown>
    }
  ) {
    this.store = store
    this.startupDraftCommands = new RuntimeStartupDraftCommands({
      store: this.store,
      getAgentLaunchPlatformForRepo: (repo) => this.getAgentLaunchPlatformForRepo(repo)
    })
    this.workspaceFileTargetCommands = new RuntimeWorkspaceFileTargetCommands({
      store: this.store,
      listResolvedWorktrees: () => this.listResolvedWorktrees(),
      buildRuntimeVisibilitySourceMatchersByRepoId: (worktrees, visibilityDefaults) =>
        this.buildRuntimeVisibilitySourceMatchersByRepoId(worktrees, visibilityDefaults),
      isRuntimeWorktreeVisible: (worktree, matcher, settings) =>
        this.isRuntimeWorktreeVisible(worktree, matcher, settings),
      resolveFolderWorkspaceConnectionId: (folderWorkspace) =>
        this.resolveFolderWorkspaceConnectionId(folderWorkspace),
      folderWorkspaceToResolvedWorktree: (folderWorkspace) =>
        this.folderWorkspaceToResolvedWorktree(folderWorkspace)
    })
    this.terminalRecoveryCommands = new RuntimeTerminalRecoveryCommands(
      buildTerminalRecoveryCommandsDepsImpl(this)
    )
    this.windowGraphClientCommands = new RuntimeWindowGraphClientCommands(
      buildWindowGraphClientCommandsDepsImpl(this)
    )
    this.worktreePs = new RuntimeWorktreePs(buildWorktreePsDepsImpl(this))
    this.mobileTabOperations = new RuntimeMobileTabOperations(
      buildMobileTabOperationsDepsImpl(this)
    )
    this.clientConnectionCommands = new RuntimeClientConnectionCommands({
      store: this.store,
      notifyReposChanged: (...args) => this.notifyReposChanged(...args),
      reconcileManagedAgentHooks: (...args) => this.reconcileManagedAgentHooks(...args)
    })
    this.remoteDesktopCommands = new RuntimeRemoteDesktopCommands({
      terminalClusterFacade: () => this.terminalClusterFacade,
      resolveDesktopRestoreTarget: (...args) => this.resolveDesktopRestoreTarget(...args),
      getTerminalSize: (...args) => this.getTerminalSize(...args),
      remoteDesktopViewers: this.remoteDesktopViewers,
      remoteDesktopOwners: this.remoteDesktopOwners,
      remoteDesktopActivity: this.remoteDesktopActivity,
      remoteDesktopHostReclaimTargets: this.remoteDesktopHostReclaimTargets,
      remoteDesktopViewerRevisions: this.remoteDesktopViewerRevisions
    })
    this.managedBaseCommands = new RuntimeManagedBaseCommands({
      getCanonicalFetchKey: (...args) => this.getCanonicalFetchKey(...args),
      getFreshFetchCompletedAt: (...args) => this.getFreshFetchCompletedAt(...args),
      rememberFreshFetchCompletedAt: (...args) => this.rememberFreshFetchCompletedAt(...args),
      store: this.store,
      resolveRepoSelector: (...args) => this.resolveRepoSelector(...args),
      requireStore: (...args) => this.requireStore(...args)
    })
    this.agentClusterFacade = new RuntimeAgentClusterFacade(this.buildAgentClusterFacadeDeps())
    this.mobileSessionFacade = new RuntimeMobileSessionFacade(this.buildMobileSessionFacadeDeps())

    this.ptyWorktrees = new RuntimePtyWorktrees(this.buildPtyWorktreesDeps())

    this.terminalClusterFacade = new RuntimeTerminalCluster(this.buildTerminalClusterFacadeDeps())
    this.managedWorktrees = new RuntimeManagedWorktrees(this.buildManagedWorktreesDeps())
    this.resolvedWorktreeCache = new RuntimeResolvedWorktreeCache({
      store: () => this.store as Store | null,
      requireStore: () => this.requireStore(),
      listFolderWorkspaces: (repo, repoOwnerCount) =>
        listRuntimeFolderWorkspaces(this.requireStore(), repo, repoOwnerCount)
    })
    this.automationCommands = new RuntimeAutomationCommands({
      store: this.store,
      automationService: () => this.automationService,
      notifier: () => this.notifier,
      emitClientEvent: (event) => this.emitClientEvent(event),
      showRepo: (repoSelector) => this.showRepo(repoSelector),
      showManagedWorktree: (worktreeSelector) => this.showManagedWorktree(worktreeSelector)
    })
    this.disposalTree = new RuntimeDisposalTree({
      logger: console
    })
    this.linearCommands = new RuntimeLinearCommands({
      store: this.store,
      showTerminal: (handle) => this.showTerminal(handle),
      resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
      resolveWorktreeForContainedPath: (cwd) => this.resolveWorktreeForContainedPath(cwd),
      listResolvedWorktrees: () => this.listResolvedWorktrees(),
      emitClientEvent: (event) => this.emitClientEvent(event)
    })
    const skillArtifactCommandsDeps = {
      getStatus: () => this.getStatus(),
      skillTransactionRecovery: deps?.skillTransactionRecovery ?? Promise.resolve(),
      listRepos: () => this.listRepos(),
      listFolderWorkspaces: () => this.listFolderWorkspaces(),
      assertAgentSkillSharingAllowed: () => this.assertAgentSkillSharingAllowed(),
      listResolvedWorktrees: () => this.listResolvedWorktrees(),
      showManagedWorktree: (selector: string) => this.showManagedWorktree(selector),
      resolveProjectRuntimeForWorktree: (worktreeId: string | null | undefined) =>
        this.resolveProjectRuntimeForWorktree(worktreeId),
      getSshProviderFn: this.getSshProviderFn
    }
    this.skillArtifactCommands = new RuntimeSkillArtifactCommands({
      ...skillArtifactCommandsDeps,
      accountServices: () => this.accountCommands.getAccountServices()
    })
    this.skillInstallCommands = new RuntimeSkillInstallCommands({
      ...skillArtifactCommandsDeps,
      accountServices: () => this.accountCommands.getAccountServices()
    })
    this.projectWorktreeCommands = new RuntimeProjectWorktreeCommands({
      store: this.store,
      notifyReposChanged: () => this.notifyReposChanged(),
      invalidateResolvedWorktreeCache: () => this.invalidateResolvedWorktreeCache(),
      invalidateWorktreeScanCacheForRepo: (repoId) =>
        this.invalidateWorktreeScanCacheForRepo(repoId),
      listProjectHostSetups: () => this.listProjectHostSetups(),
      resolveRepoSelector: (selector) => this.resolveRepoSelector(selector),
      cloneInFlightByPath: this.cloneInFlightByPath
    })
    this.repoGitCommands = new RuntimeRepoGitCommandsFacade({
      store: this.store as Store | null,
      stats: this.statsCollector,
      ptyController: null,
      terminalTopologyRevisionByRepoId: this.terminalTopologyRevisionByRepoId,
      getSshProviderFn: this.getSshProviderFn,
      onPtyStopped: null,
      resolveRepoSelector: (selector) => this.resolveRepoSelector(selector),
      selectReposBySelector: (selector) => this.selectReposBySelector(selector),
      requireStore: () => this.requireStore(),
      notifyReposChanged: () => this.notifyReposChanged(),
      invalidateResolvedWorktreeCache: () => this.invalidateResolvedWorktreeCache(),
      invalidateWorktreeScanCacheForRepo: (repoId) =>
        this.invalidateWorktreeScanCacheForRepo(repoId),
      resolveLiveLeafForHandle: (handle) => this.resolveLiveLeafForHandle(handle),
      resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
      listResolvedWorktrees: () => this.listResolvedWorktrees(),
      listRepoWorktreesForResolution: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId),
      getLocalProvider: () => this.getLocalProvider()
    })
    const orchestrationDeps: RuntimeOrchestrationCommandsDeps = {
      store: this.store as Store | null | undefined,
      orchestrationDb: this._orchestrationDb,
      orchestrationMailboxNotifications: this.orchestrationMailboxNotifications,
      orchestrationPointerAdmissionByPtyId: this.orchestrationPointerAdmissionByPtyId,
      orchestrationCompatibilitySshAttachments: this.orchestrationCompatibilitySshAttachments,
      restoredOrchestrationAuthorityByPtyId: this.restoredOrchestrationAuthorityByPtyId,
      ptyController: null,
      leaves: this.leaves,
      ptysById: this.ptysById,
      issueHandle: (leaf) => this.issueHandle(leaf),
      issuePtyHandle: (pty) => this.issuePtyHandle(pty),
      makeRuntimePaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
      getRecentSettledDispatchForTerminal: (handle, db) =>
        this.getRecentSettledDispatchForTerminal(handle, db),
      getWorktreeIdForTerminalHandle: (handle) => this.getWorktreeIdForTerminalHandle(handle),
      getTerminalHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
      getPaneKeyForTerminalHandle: (handle) =>
        this.getPaneKeyForTerminalHandle(handle) ?? undefined,
      getOrchestrationDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle),
      getLeavesForPty: (ptyId) => this.getLeavesForPty(ptyId),
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      handleByLeafKey: this.handleByLeafKey
    }
    this.orchestrationCommands = new RuntimeOrchestrationCommands(orchestrationDeps)
    this.orchestrationGraphReloadCommands = new RuntimeOrchestrationGraphReloadCommands(
      buildOrchestrationGraphReloadDepsImpl(this)
    )
    const headlessSessionTabPersistenceDeps: RuntimeHeadlessSessionTabPersistenceDeps = {
      getWorkspaceSessionForWorktree: (worktreeId) =>
        this.getWorkspaceSessionForWorktree(worktreeId),
      setWorkspaceSessionForWorktree: (worktreeId, session) =>
        this.setWorkspaceSessionForWorktree(worktreeId, session),
      getMobileSessionTabsByWorktree: (worktreeId) =>
        this.mobileSessionTabsByWorktree.get(worktreeId),
      setMobileSessionTabsByWorktree: (worktreeId, snapshot) =>
        this.mobileSessionTabsByWorktree.set(worktreeId, snapshot),
      emitMobileSessionTabsSnapshot: (snapshot) => this.emitMobileSessionTabsSnapshot(snapshot),
      setTerminalLayoutsByTabId: (tabId, layout) => {
        this.terminalLayoutsByTabId.set(tabId, layout)
      },
      setExpandedLeafIdByTabId: (tabId, leafId) => {
        this.expandedLeafIdByTabId.set(tabId, leafId)
      },
      store
    }
    this.headlessSessionTabPersistenceCommands = new RuntimeHeadlessSessionTabPersistenceCommands(
      headlessSessionTabPersistenceDeps
    )
    const terminalAgentStatusBindingDeps: RuntimeTerminalAgentStatusBindingCommandsDeps = {
      ptyController: null,
      ptysById: this.ptysById,
      getLivePtyForHandle: (handle) => this.getLivePtyForHandle(handle),
      getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle),
      getPrimaryLeafForPty: (ptyId) => this.getPrimaryLeafForPty(ptyId),
      getLeavesForPty: (ptyId) => this.getLeavesForPty(ptyId),
      ptyTitleTrackersByPtyId: this.ptyTitleTrackersByPtyId as never,
      ptyForegroundProcessReads: this.ptyForegroundProcessReads,
      ptyForegroundAgentRefreshes: this.ptyForegroundAgentRefreshes,
      ptyDelayedForegroundSnapshotTitleObservations:
        this.ptyDelayedForegroundSnapshotTitleObservations,
      mobileSessionTabListeners: this.mobileSessionTabListeners,
      mobileSessionTabsAgentStatusHeartbeat: this.mobileSessionTabsAgentStatusHeartbeat as never,
      agentPromptLifecycleByPtyId: this.agentPromptLifecycleByPtyId,
      recordTerminalSideEffectFact: (ptyId, fact) => this.recordTerminalSideEffectFact(ptyId, fact),
      deliverPendingMessagesForLeaf: (leaf) => this.deliverPendingMessagesForLeaf(leaf),
      touchMobileSessionSnapshotsForPty: (ptyId) => this.touchMobileSessionSnapshotsForPty(ptyId),
      getFreshExplicitAgentStatusForHandle: (handle) =>
        this.getFreshExplicitAgentStatusForHandle(handle),
      getTerminalAgentStatus: (handle) => this.getTerminalAgentStatus(handle)
    }
    this.terminalAgentStatusBinding = new RuntimeTerminalAgentStatusBindingCommands(
      terminalAgentStatusBindingDeps
    )
    this.ptyTitleTrackingCommands = new RuntimePtyTitleTrackingCommands(
      buildPtyTitleTrackingCommandsDepsImpl(this)
    )
    const clientEventPublishingCommandsDeps: RuntimeClientEventPublishingCommandsDeps = {
      store,
      notifier: null,
      clientEventListeners: this.clientEventListeners,
      terminalSideEffectExcludedClientEventListeners:
        this.terminalSideEffectExcludedClientEventListeners,
      terminalSideEffectTitleGateKeysByClientEventListener:
        this.terminalSideEffectTitleGateKeysByClientEventListener,
      terminalSleepStateByWorktreeId: this.terminalSleepStateByWorktreeId,
      nativeChatLaunchDraftResolutionByTabId: this.nativeChatLaunchDraftResolutionByTabId,
      mobileSessionTabsByWorktree: this.mobileSessionTabsByWorktree,
      sshRelayRecoveryGenerationByTargetId: this.sshRelayRecoveryGenerationByTargetId,
      worktreeLifecycleListeners: this.worktreeLifecycleListeners,
      makeDecorativeTitleGateKey: (rawTitle: string, normalizedTitle: string) =>
        this.makeDecorativeTitleGateKey(rawTitle, normalizedTitle),
      notifyRuntimeListeners: notifyRuntimeListeners,
      notifyMobileSessionTabsChangedNow: (worktreeId, changeSequence) =>
        this.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence),
      scheduleMobileSessionTabsChanged: (worktreeId) =>
        this.scheduleMobileSessionTabsChanged(worktreeId),
      handles: this.handles,
      ptysById: this.ptysById,
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (worktreeId, options) =>
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, options as never),
      getKnownWorkspaceSessionWorktreeIds: () =>
        Array.from(this.getKnownWorkspaceSessionWorktreeIds()),
      refreshMobileSessionPtyRecords: async () => {
        await this.refreshMobileSessionPtyRecords()
      },
      runtimeWorktreeIdsEqual: runtimeWorktreeIdsEqual as never,
      parsePaneKey: parsePaneKey as never,
      splitWorktreeId: splitWorktreeId as never,
      getPublicSshState: getPublicSshState as never,
      wakeFolderRepoGitUpgradeWatch
    }
    this.clientEventPublishingCommands = new RuntimeClientEventPublishingCommands(
      clientEventPublishingCommandsDeps
    )
    const hookAgentRowResolutionCommandsDeps: RuntimeHookAgentRowResolutionCommandsDeps = {
      ptysById: this.ptysById,
      leaves: this.leaves,
      latestAgentStatusByPaneKey: this.latestAgentStatusByPaneKey,
      handles: this.handles,
      tabs: this.tabs,
      runtimeId: this.runtimeId,
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      getLivePtyForHandle: (handle) => this.getLivePtyForHandle(handle),
      parsePaneKey,
      isTerminalLeafId,
      makePaneKey,
      pickParsedAgentStatusPayload,
      getUnpersistedTrackedTitleForPty: (ptyId) =>
        this.ptyTitleTrackingCommands.getUnpersistedTrackedTitleForPty(ptyId),
      getLatestAgentCandidateTitle: getLatestAgentCandidateTitle as never,
      getLatestPtyTitle: getLatestPtyTitle as never,
      classifyAgentTitle: classifyAgentTitle as never,
      terminalTitleBlocksExplicitAgentStatus: terminalTitleBlocksExplicitAgentStatus as never,
      resolvePaneAgentOwner: resolvePaneAgentOwner as never,
      normalizeCompatibleAgentTitleForOwner: normalizeCompatibleAgentTitleForOwner as never,
      normalizeCompatibleAgentStatusEntryForOwner:
        normalizeCompatibleAgentStatusEntryForOwner as never,
      orchestrationCommands: this.orchestrationCommands
    }
    this.hookAgentRowResolutionCommands = new RuntimeHookAgentRowResolutionCommands(
      hookAgentRowResolutionCommandsDeps
    )
    // Why: per-device tab selections must survive host restarts, or every phone snaps back to the first tab on return.
    const persistedClientTabSelections = store?.getMobileClientTabSelections?.()
    if (persistedClientTabSelections) {
      this.clientSessionTabSelections.hydrate(persistedClientTabSelections)
    }
    this.clientSessionTabSelections.setPersistListener((state) => {
      this.store?.setMobileClientTabSelections?.(state)
    })
    this.orchestrationEnvironmentTransport = deps?.orchestrationEnvironmentTransport ?? null
    this.skillTransactionRecovery = (deps?.skillTransactionRecovery ?? Promise.resolve()).catch(
      (error) => {
        console.warn('[skills] startup transaction recovery failed:', error)
      }
    )
    if (stats) {
      this.stats = stats
    }
    this.getAgentStatusSnapshotFn = deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionSnapshotFn =
      deps?.getAgentProviderSessionSnapshot ?? deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionRowsForPaneFn = deps?.getAgentProviderSessionRowsForPane ?? null
    this.retireAgentHookCompatibilityAuthorityFn =
      deps?.retireAgentHookCompatibilityAuthority ?? null
    this.reconcileAgentStatusForEndedProcessFn = deps?.reconcileAgentStatusForEndedProcess ?? null
    this.canRecoverPersistentLocalPtysFn = deps?.canRecoverPersistentLocalPtys ?? (() => true)
    this.getPairedDeviceNameFn = deps?.getPairedDeviceName ?? (() => null)
    // Why: configure the shared AiVault scan cache from a serve-mode-reachable
    // seam so the aiVault.listSessions RPC includes managed-Codex + WSL sessions
    // even on headless `orca serve` hosts where registerCoreHandlers never runs.
    if (deps?.getAdditionalAiVaultCodexHomePaths) {
      configureAiVaultSessionSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
      configureHostReadableTranscriptPathSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
    }
    // Why: the daemon adapter is installed via `setLocalPtyProvider()` during
    // attachMainWindowServices, AFTER this service is constructed. Capturing
    // `getLocalPtyProvider()` at construction time would freeze a reference to
    // the pre-daemon `LocalPtyProvider` and miss the routed adapter. Resolve
    // lazily via thunk so teardown always sees the currently-installed
    // provider (design §4.3 wire-up).
    this.getLocalProviderFn = deps?.getLocalProvider ?? null
    this.getSshProviderFn = deps?.getSshProvider ?? null
    this.onPtyStopped = deps?.onPtyStopped ?? null
    this.onTerminalAgentStatus = deps?.onTerminalAgentStatus ?? null
    this.buildAgentHookPtyEnv = deps?.buildAgentHookPtyEnv ?? null
    this.getDesktopWindowStatusFn = deps?.getDesktopWindowStatus ?? (() => 'openable')
    this.prepareAiVaultSessionResumeFn = deps?.prepareAiVaultSessionResume ?? null
    this.prepareCodexStructuredLaunchFn = deps?.prepareCodexStructuredLaunch ?? null
    this.agentSessionClaimSigner =
      deps?.agentSessionClaimSigner ?? createEphemeralAgentSessionClaimSigner(this.runtimeId)
    this.onTerminalSideEffects = deps?.onTerminalSideEffects ?? null
    // Why: the ConPTY spawn mark can land after daemon stream data already
    // created this PTY's emulator; the mark retrofits the DA1 override here
    // (terminal-query-authority.md §ConPTY DA1).
    registerConptyDa1OverrideInstaller((ptyId) => this.ensureNativeWindowsConptyDa1Override(ptyId))
    // Why: a renderer attribute push must reach already-live emulators too —
    // cursor options for DECRQSS/DECRQM parity plus the per-PTY OSC color
    // override reset a theme apply implies (terminal-query-authority.md
    // §View-attribute bridge).
    registerTerminalViewAttributesApplier((attributes) => {
      for (const state of this.headlessTerminals.values()) {
        state.emulator.applyPushedViewAttributes(attributes)
      }
    })
    this.snapshotValueComparison = new RuntimeMobileSnapshotValueComparisonCommands({
      ptysById: this.ptysById as never,
      tabs: this.tabs as never,
      store: this.store as never,
      startedAt: this.startedAt,
      pendingMobileTerminalCreatesByKey: this.pendingMobileTerminalCreatesByKey as never,
      mobileSessionTabsByWorktree: this.mobileSessionTabsByWorktree,
      getWorkspaceSessionForWorktree: (worktreeId) =>
        this.getWorkspaceSessionForWorktree(worktreeId),
      findPtyForMobileTerminalTab: (worktreeId, tab) =>
        this.findPtyForMobileTerminalTab(worktreeId, tab),
      getMobileSessionSnapshotTabIdentityKeys: (tab) =>
        this.getMobileSessionSnapshotTabIdentityKeys(tab)
    })
    const mobileSessionTabsChangeSequence = { value: this.mobileSessionTabsChangeSequence }
    this.mobileSnapshotMerge = new RuntimeMobileSnapshotMergeCommands({
      mobileSessionTabsByWorktree: this.mobileSessionTabsByWorktree as never,
      mobileSessionTabListeners: this.mobileSessionTabListeners as never,
      mobileSessionTabsChangeSequence,
      offscreenBrowserBackend: this.offscreenBrowserBackend as never,
      mergeMobileSessionSnapshotTabs: (a, b) => this.mergeMobileSessionSnapshotTabs(a, b),
      mergeMobileSessionTabGroups: (worktreeId, groups, terminalTabs, activeTab) =>
        this.mergeMobileSessionTabGroups(worktreeId, groups, terminalTabs, activeTab),
      getMobileSessionSnapshotTabIdentityKeys: (tab) =>
        this.getMobileSessionSnapshotTabIdentityKeys(tab as never),
      getHeadlessMobileSessionGroupId: (worktreeId) =>
        this.mobileSessionFacade.getHeadlessMobileSessionGroupId(worktreeId),
      getRuntimeBrowserPageForTab: (tab: any, _worktreeId) => {
        if (typeof tab.browserPageId === 'string') {
          return getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        }
        return undefined
      },
      sameRuntimeBrowserPlacement: (a, b) => sameRuntimeBrowserPlacement(a as never, b as never),
      getLiveBrowserTabsByPageId: (worktreeId) => this.getLiveBrowserTabsByPageId(worktreeId),
      hasLiveRuntimeSessionOwnedPtyBinding: (worktreeId, tab) =>
        this.hasLiveRuntimeSessionOwnedPtyBinding(worktreeId, tab),
      hasLiveOrPersistedServeOrSshOwnedPtyBinding: (worktreeId, tab) =>
        this.hasLiveOrPersistedServeOrSshOwnedPtyBinding(worktreeId, tab),
      toMobileSessionTabsResult: (snapshot) => this.toMobileSessionTabsResult(snapshot),
      projectMobileSessionTabsForClient: (result, clientNavigationId) =>
        this.projectMobileSessionTabsForClient(result, clientNavigationId)
    })
    Object.defineProperty(this, 'mobileSessionTabsChangeSequence', {
      get: () => mobileSessionTabsChangeSequence.value,
      set: (v: number) => {
        mobileSessionTabsChangeSequence.value = v
      }
    })
    const mobileSessionTabSnapshotCommandsDeps: RuntimeMobileSessionTabSnapshotCommandsDeps = {
      mobileSessionTabsByWorktree: this.mobileSessionTabsByWorktree,
      mobileSessionTabListeners: this.mobileSessionTabListeners,
      mobileSessionTabsChangeSequence,
      offscreenBrowserBackend: this.offscreenBrowserBackend,
      agentBrowserBridge: this.agentBrowserBridge as never,
      notifyMobileSessionTabsChanged: (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      scheduleMobileSessionTabsChanged: (worktreeId) =>
        this.scheduleMobileSessionTabsChanged(worktreeId),
      getTerminalWorktreeIdForPaneKey: (paneKey) => this.getTerminalWorktreeIdForPaneKey(paneKey),
      getWorkspaceSessionForWorktree: (worktreeId) =>
        this.getWorkspaceSessionForWorktree(worktreeId) ?? undefined,
      getWorkspaceSessionForHostId: (hostId) =>
        this.store?.getWorkspaceSession?.(hostId) ?? undefined,
      tryGetWorkspaceSessionHostIdForWorktree: (worktreeId) =>
        this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId),
      setWorkspaceSession: (session, hostId) => this.store?.setWorkspaceSession?.(session, hostId),
      setWorkspaceSessionForWorktree: (worktreeId, session) =>
        this.setWorkspaceSessionForWorktree(worktreeId, session as never),
      canSetWorkspaceSession: () => Boolean(this.store?.setWorkspaceSession),
      flushOrThrow: this.flushOrThrow,
      hasHostAuthoritativeTerminalMembership: (session, worktreeId) =>
        this.hasHostAuthoritativeTerminalMembership(session, worktreeId),
      terminalTopologyRevisionByRepoId: this.terminalTopologyRevisionByRepoId,
      ptysById: this.ptysById as never,
      parsePaneKey: (key) => parsePaneKey(key),
      buildHeadlessTerminalSplitLayout: (layout, options) =>
        buildHeadlessTerminalSplitLayout(layout, options),
      getRuntimeInstance: () => this,
      toMobileSessionTabsResult: (snapshot) => this.toMobileSessionTabsResult(snapshot),
      projectMobileSessionTabsForClient: (result, clientNavigationId) =>
        this.projectMobileSessionTabsForClient(result, clientNavigationId),
      withClientHostedPagesHold: (result, clientNavigationId) =>
        this.withClientHostedPagesHold(result, clientNavigationId)
    }
    this.mobileTabSnapshots = new RuntimeMobileSessionTabSnapshotCommands(
      mobileSessionTabSnapshotCommandsDeps
    )
    this.wiringReferencedHostMembers()
  }

  /**
   * Republishes persisted client-hosted pages as held rows, before any host can attach.
   *
   * Without this a runtime restart takes the only record of a client-hosted page with it. When the
   * client restarted too -- a fleet update restarts both -- its guests died with it, so its
   * inventory has nothing to adopt from and no participant can name the page any more.
   *
   * Called from each host's startup rather than the constructor so the ordering against attach is
   * explicit, and so constructing a runtime stays free of persistence reads.
   */
  rehydrateClientHostedBrowserPages(): void {
    rehydrateClientHostedBrowserPages(this)
  }

  private getAgentLaunchPlatformForRepo(repo: Repo): NodeJS.Platform {
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
    return getAgentLaunchPlatformForRepo(repo, projectRuntime)
  }

  private getAgentLaunchPlatformForWorkspace(scope: TerminalWorkspaceLaunchScope): NodeJS.Platform {
    if (scope.repo) {
      return this.getAgentLaunchPlatformForRepo(scope.repo)
    }
    if (scope.connectionId) {
      return isWindowsAbsolutePathLike(scope.path) ? 'win32' : 'linux'
    }
    return isWslUncPath(scope.path) ? 'linux' : process.platform
  }

  getLocalProvider(): IPtyProvider | null {
    return this.getLocalProviderFn ? this.getLocalProviderFn() : null
  }

  getStatsSummary(): StatsSummary | null {
    return this.stats?.getSummary() ?? null
  }

  getMemorySnapshot(): Promise<MemorySnapshot> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return collectMemorySnapshot(this.store)
  }

  getUIState(): PersistedUIState {
    if (!this.store?.getUI) {
      throw new Error('runtime_unavailable')
    }
    return this.store.getUI()
  }

  updateUIState(updates: Partial<PersistedUIState>): PersistedUIState {
    if (!this.store?.getUI || !this.store.updateUI) {
      throw new Error('runtime_unavailable')
    }
    this.store.updateUI(updates)
    return this.store.getUI()
  }

  recordFeatureInteraction(id: FeatureInteractionId): PersistedUIState {
    if (!this.store?.recordFeatureInteraction) {
      throw new Error('runtime_unavailable')
    }
    return this.store.recordFeatureInteraction(id)
  }

  getClientSettings(): Pick<
    GlobalSettings,
    | 'worktreeVisibilityDefaults'
    | 'defaultTuiAgent'
    | 'disabledTuiAgents'
    | 'agentCmdOverrides'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentStatusHooksEnabled'
    | 'defaultTaskSource'
    | 'defaultTaskViewPreset'
    | 'visibleTaskProviders'
    | 'defaultRepoSelection'
    | 'defaultLinearTeamSelection'
    | 'githubProjects'
    | 'experimentalNewWorktreeCardStyle'
    | 'compactWorktreeCards'
    | 'minimaxGroupId'
    | 'minimaxUsageModels'
    | 'prBotAuthorOverrides'
    // Read-only on purpose: clients preflight the publish capability here, but SettingsUpdate
    // still omits the key so no RPC caller can grant it to itself.
    | 'artifactSharingEnabled'
    | 'agentSkillSharingEnabled'
  > {
    return this.clientConnectionCommands.getClientSettings()
  }

  private reconcileManagedAgentHooks(): Promise<void> {
    return this.agentClusterFacade.reconcileManagedAgentHooks()
  }

  async updateClientSettings(
    ...args: Parameters<RuntimeClientConnectionCommands['updateClientSettings']>
  ): ReturnType<RuntimeClientConnectionCommands['updateClientSettings']> {
    return this.clientConnectionCommands.updateClientSettings(...args)
  }

  getClientTerminalQuickCommands(): TerminalQuickCommand[] {
    return this.terminalClusterFacade.getClientTerminalQuickCommands()
  }

  updateClientTerminalQuickCommands(
    mutation: TerminalQuickCommandMutation
  ): TerminalQuickCommand[] {
    return this.terminalClusterFacade.updateClientTerminalQuickCommands(mutation)
  }

  updateClientPRBotAuthorOverride(args: { author: string; isBot: boolean }) {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const current = this.store.getSettings().prBotAuthorOverrides
    this.store.updateSettings(
      { prBotAuthorOverrides: applyPRBotAuthorOverride(current, args.author, args.isBot) },
      { notifyListeners: true }
    )
    return this.getClientSettings()
  }

  listAutomations(): Automation[] {
    return this.automationCommands.listAutomations()
  }

  listAutomationsForScope(params: AutomationListParams): AutomationListResult {
    return this.automationCommands.listAutomationsForScope(params)
  }

  listAutomationRuns(
    automationId?: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): AutomationRun[] {
    return this.automationCommands.listAutomationRuns(automationId, expectedOwner)
  }

  /** Null when the store predates the projection: the caller then sends no precondition. */
  automationOwnerPrecondition(id: string): AutomationOwnerPrecondition | null {
    return this.automationCommands.automationOwnerPrecondition(id)
  }

  showAutomation(id: string, expectedOwner?: AutomationOwnerPrecondition): Automation {
    return this.automationCommands.showAutomation(id, expectedOwner)
  }

  async createAutomation(input: RuntimeAutomationCreateInput): Promise<Automation> {
    return this.automationCommands.createAutomation(input)
  }

  async updateAutomation(
    id: string,
    updates: RuntimeAutomationUpdateInput,
    options?: { expectedOwner?: AutomationOwnerPrecondition; destination?: AutomationDestination }
  ): Promise<Automation> {
    return this.automationCommands.updateAutomation(id, updates, options)
  }

  deleteAutomation(
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): { removed: boolean; id: string } {
    return this.automationCommands.deleteAutomation(id, expectedOwner)
  }

  async runAutomationNow(
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): Promise<AutomationRun> {
    return this.automationCommands.runAutomationNow(id, expectedOwner)
  }

  // Why: lazy initialization — the DB path depends on userData, which on the desktop
  // is not finalized until after app.ready. Also allows unit tests to inject an
  // in-memory DB without touching the filesystem.
  getOrchestrationDb(): OrchestrationDb {
    if (!this._orchestrationDb) {
      const dbPath = join(getAppEnvironment().getPath('userData'), 'orchestration.db')
      this._orchestrationDb = new OrchestrationDb(dbPath)
      this.ensureOrchestrationFederationRelay()
      this.scheduleRestoredMessageRepoints()
    }
    return this._orchestrationDb
  }

  setOrchestrationDb(db: OrchestrationDb): void {
    this.stopOrchestrationFederationRelay()
    this.mailPointerRepointScheduler.clear()
    this._orchestrationDb = db
    this.ensureOrchestrationFederationRelay()
    this.scheduleRestoredMessageRepoints()
  }

  prepareLegacyWorkerTerminalRecovery(): LegacyWorkerTerminalRecoveryPlan {
    return this.terminalClusterFacade.prepareLegacyWorkerTerminalRecovery()
  }

  private async flushWorkspaceSessionOrThrowAsync(): Promise<void> {
    return this.terminalClusterFacade.flushWorkspaceSessionOrThrowAsync()
  }

  async reconcileLegacyWorkerTerminals(
    options: { connectionId?: string; materializeRenderer?: boolean } = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    return this.terminalClusterFacade.reconcileLegacyWorkerTerminals(options)
  }

  async refreshRestoredOrchestrationAuthority(connectionId: string | null = null): Promise<void> {
    if (connectionId === null && !this.canRecoverPersistentLocalPtysFn()) {
      return
    }
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [...(await this.getResolvedWorktreeMap()).values()],
      null,
      undefined,
      connectionId
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
  }

  private hasExactTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    terminalHandle: string
    incarnationId: string
  }): boolean {
    return this.terminalClusterFacade.hasExactTerminalSurfaceIdentity(expected)
  }

  private hasExactPersistedTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }): boolean {
    return this.terminalClusterFacade.hasExactPersistedTerminalSurfaceIdentity(expected)
  }

  private async persistLegacyWorkerTerminalRecoveryBatch(
    resolutions: readonly LegacyWorkerTerminalRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    return this.terminalClusterFacade.persistLegacyWorkerTerminalRecoveryBatch(resolutions)
  }

  private reconcileMissingLegacyWorkerTerminal(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): boolean {
    return this.terminalClusterFacade.reconcileMissingLegacyWorkerTerminal(candidate)
  }

  private rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    return this.terminalClusterFacade.rollbackLegacyWorkerTerminalSurface(candidate)
  }

  private updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    return this.terminalClusterFacade.updateLegacyWorkerTerminalRecoveryRetry(
      plan,
      deferredDispatchIds,
      options
    )
  }

  private cancelLegacyWorkerTerminalRecoveryRetry(scopeKey: string): void {
    return this.terminalClusterFacade.cancelLegacyWorkerTerminalRecoveryRetry(scopeKey)
  }

  private async reconcileLegacyWorkerTerminalsNow(options: {
    connectionId?: string
    materializeRenderer?: boolean
  }): Promise<LegacyWorkerTerminalRecoveryResult> {
    return this.terminalRecoveryCommands.reconcileLegacyWorkerTerminalsNow(options)
  }

  setAutomationService(service: AutomationService): void {
    this.automationService = service
  }

  setArtifactService(service: ArtifactCloudService): void {
    this.skillArtifactCommands.setArtifactService(service)
  }

  setSkillCloudService(service: SkillCloudService): void {
    this.skillArtifactCommands.setSkillCloudService(service)
  }

  assertAgentSkillSharingAllowed(): void {
    return this.agentClusterFacade.assertAgentSkillSharingAllowed()
  }

  /** Renderer-owned; read here because dispatch enforcement lives in main. */
  getNestedWorkerMaxDepth(): number {
    return resolveNestedWorkerMaxDepth(this.store?.getSettings())
  }

  publishDiscoveredSkillsFromAgent(
    request: AgentSkillShareRequest,
    discoveredSkills: readonly DiscoveredSkill[],
    signal?: AbortSignal
  ): Promise<AgentSkillShareOperation> {
    return this.agentClusterFacade.publishDiscoveredSkillsFromAgent(
      request,
      discoveredSkills,
      signal
    )
  }

  publishSkillPackage(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudPublishResult>> {
    return this.skillArtifactCommands.publishSkillPackage(request)
  }

  publishSkillPackageVersion(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudVersion>> {
    return this.skillArtifactCommands.publishSkillPackageVersion(request)
  }

  createSkillPackageShare(
    packageId: string,
    request: SkillCloudOptions & {
      pinnedVersionId?: string
      idempotencyKey?: string
    }
  ) {
    return this.skillArtifactCommands.createSkillPackageShare(packageId, request)
  }

  resolveSkillShare(
    shareId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<{ id: string; version: SkillCloudVersion }>> {
    return this.skillArtifactCommands.resolveSkillShare(shareId, options)
  }

  createSkillDownloadGrant(
    shareId: string,
    options: SkillCloudOptions & {
      versionId?: string
      installTarget?: 'local' | 'remote'
    }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>> {
    return this.skillArtifactCommands.createSkillDownloadGrant(shareId, options)
  }

  createSkillPackageVersionDownloadGrant(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions & { installTarget?: 'local' | 'remote' }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>> {
    return this.skillArtifactCommands.createSkillPackageVersionDownloadGrant(
      packageId,
      versionId,
      options
    )
  }

  getSkillPackage(
    packageId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<SkillCloudPackageDetails>> {
    return this.skillArtifactCommands.getSkillPackage(packageId, options)
  }

  listOwnedSkillShares(options: SkillCloudOptions) {
    return this.skillArtifactCommands.listOwnedSkillShares(options)
  }

  revokeSkillShare(
    shareId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.skillArtifactCommands.revokeSkillShare(shareId, options)
  }

  deleteSkillPackageVersion(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.skillArtifactCommands.deleteSkillPackageVersion(packageId, versionId, options)
  }

  deleteSkillPackage(
    packageId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.skillArtifactCommands.deleteSkillPackage(packageId, options)
  }

  installSharedSkillRequest(
    request: SkillInstallRequest,
    signal?: AbortSignal
  ): Promise<SkillInstallResult> {
    return this.skillInstallCommands.installSharedSkillRequest(request, signal)
  }

  installSharedSkillBundleRequest(
    request: SkillBundleInstallRequest,
    signal?: AbortSignal,
    onProgress?: (progress: SkillBundleInstallProgress) => void
  ): Promise<SkillBundleInstallResult> {
    return this.skillInstallCommands.installSharedSkillBundleRequest(request, signal, onProgress)
  }

  getSharedSkillInstallProgress(operationId: string): SkillBundleInstallProgress | null {
    return this.skillInstallCommands.getSharedSkillInstallProgress(operationId)
  }

  cancelSharedSkillInstall(operationId: string): boolean {
    return this.skillInstallCommands.cancelSharedSkillInstall(operationId)
  }

  previewSharedSkillInstallRequest(
    request: SkillInstallPreviewRequest
  ): Promise<SkillInstallPreview> {
    return this.skillArtifactCommands.previewSharedSkillInstallRequest(request)
  }

  previewSharedSkillBundleInstallRequest(
    request: SkillBundleInstallPreviewRequest
  ): Promise<SkillBundleInstallPreview> {
    return this.skillArtifactCommands.previewSharedSkillBundleInstallRequest(request)
  }

  removeSharedSkillInstallRequest(request: SkillRemoveRequest): Promise<SkillInstallResult> {
    return this.skillArtifactCommands.removeSharedSkillInstallRequest(request)
  }

  listManagedSkillInstalls(connectionId?: string): Promise<ManagedSkillInstall[]> {
    return this.skillArtifactCommands.listManagedSkillInstalls(connectionId)
  }

  skillInstallDestinationUsesSsh(
    destination: SkillInstallRequest['destination']
  ): Promise<boolean> {
    return this.skillInstallCommands.skillInstallDestinationUsesSsh(destination)
  }

  resolveSkillDiscoveryProviderRoots(target: {
    kind: 'native-host' | 'wsl'
    distro?: string
  }): Promise<SkillProviderRootOverrides> {
    return this.skillInstallCommands.resolveSkillDiscoveryProviderRoots(target)
  }

  beginSkillUpload(request: SkillUploadBeginRequest): Promise<{
    uploadId: string
    chunkBytes: number
    acknowledgedOffset: number
  }> {
    return this.skillArtifactCommands.beginSkillUpload(request)
  }

  appendSkillUploadChunk(
    request: SkillUploadChunkRequest
  ): Promise<{ acknowledgedOffset: number }> {
    return this.skillArtifactCommands.appendSkillUploadChunk(request)
  }

  commitSkillUpload(uploadId: string): Promise<{ uploadId: string }> {
    return this.skillArtifactCommands.commitSkillUpload(uploadId)
  }

  cancelSkillUpload(uploadId: string): Promise<void> {
    return this.skillArtifactCommands.cancelSkillUpload(uploadId)
  }

  listArtifacts(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.skillArtifactCommands.listArtifacts(options)
  }

  getPublishedArtifactLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.skillArtifactCommands.getPublishedArtifactLink(request)
  }

  shareArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.skillArtifactCommands.shareArtifact(request)
  }

  publishArtifact(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    return this.skillArtifactCommands.publishArtifact(request)
  }

  updateArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.skillArtifactCommands.updateArtifact(request)
  }

  unshareArtifact(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.skillArtifactCommands.unshareArtifact(request)
  }

  deleteArtifact(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.skillArtifactCommands.deleteArtifact(id, options)
  }

  async disposeSkillUploadSessions(): Promise<void> {
    await this.skillArtifactCommands.disposeSkillUploadSessions()
  }

  getRuntimeId(): string {
    return this.runtimeId
  }

  resolveOrchestrationWorkerServer(selector: string): OrchestrationWorkerServer {
    if (!this.orchestrationEnvironmentTransport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    return this.orchestrationEnvironmentTransport.resolve(selector)
  }

  async callOrchestrationWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope,
    internal?: { contractVerified?: boolean }
  ): Promise<unknown> {
    return callOrchestrationWorkerServerViaTransport({
      transport: this.orchestrationEnvironmentTransport,
      selector,
      method,
      params,
      timeoutMs,
      envelope,
      internal
    })
  }

  async syncOrchestrationFederation(runId?: string): Promise<void> {
    if (!this.orchestrationEnvironmentTransport) {
      return
    }
    const dispatches = this.getOrchestrationDb().listActiveFederatedDispatches(runId)
    await Promise.allSettled(
      dispatches.map((dispatch) => this.syncOrchestrationFederatedDispatch(dispatch.dispatch_id))
    )
  }

  syncOrchestrationFederatedDispatch(dispatchId: string): Promise<void> {
    return federatedDispatchFn(this, dispatchId)
  }

  async syncOrchestrationFederatedDispatchAfterCurrent(dispatchId: string): Promise<void> {
    return federatedDispatchAfterCurrentFn(this, dispatchId)
  }

  ensureOrchestrationFederationRelay(runId?: string): void {
    return ensureFederationRelayFn(this, runId)
  }

  stopOrchestrationFederationRelay(): void {
    return stopFederationRelayFn(this)
  }

  getStartedAt(): number {
    return this.startedAt
  }

  private tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    return this.managedWorktrees.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
  }

  private getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    return this.managedWorktrees.getWorkspaceSessionHostIdForWorktree(worktreeId)
  }

  private getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.terminalClusterFacade.getWorkspaceSessionForWorktree(worktreeId)
  }

  private setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    return this.terminalClusterFacade.setWorkspaceSessionForWorktree(worktreeId, session)
  }

  private getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    return this.managedWorktrees.getKnownWorkspaceSessionWorktreeIds()
  }

  // Every execution host known to this runtime; knowledge is not coverage.
  private listKnownExecutionHostIds(
    additionalHostIds: Iterable<ExecutionHostId> = [],
    includeConfiguredHosts = true
  ): Set<ExecutionHostId> {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const hostId of this.store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }
    for (const hostId of additionalHostIds) {
      hostIds.add(hostId)
    }
    if (!includeConfiguredHosts) {
      return hostIds
    }
    const repos = this.store?.getRepos?.() ?? []
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    const projectGroups = this.store?.getProjectGroups?.() ?? []
    for (const workspace of this.store?.getFolderWorkspaces?.() ?? []) {
      if (workspace.executionHostId != null) {
        const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
        if (explicitHostId) {
          hostIds.add(explicitHostId)
        }
        continue
      }
      const connection = inferFolderWorkspacePathConnection({
        folderPath: workspace.folderPath,
        projectGroupId: workspace.projectGroupId,
        connectionId: workspace.connectionId ?? null,
        projectGroups,
        repos
      })
      if (connection.kind === 'ssh') {
        hostIds.add(toSshExecutionHostId(connection.connectionId))
      }
    }
    return hostIds
  }

  private getWorkspaceSessionHydrationTargets = (includeAllPersistedWorktrees: boolean) =>
    this.workspaceSessionHydrationCommands.getWorkspaceSessionHydrationTargets(
      includeAllPersistedWorktrees
    )

  private readonly workspaceSessionHydrationCommands = new RuntimeWorkspaceSessionHydrationCommands(
    {
      store: () => this.store,
      resolveFolderWorkspaceConnectionId: (workspace) =>
        this.resolveFolderWorkspaceConnectionId(workspace),
      workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: (session, worktreeId, tabs) =>
        this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs)
    }
  )

  getStatus(): RuntimeStatus {
    return this.windowGraphClientCommands.getStatus()
  }

  // Why: scans the transcript-owning host's disk (correct by construction over
  // RPC — a remote/SSH host scans its own disk). Delegates to the one shared
  // cache so the desktop panel and the mobile screen never double-scan.
  listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
    return listAiVaultSessions(args)
  }

  resolveAiVaultSessionTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return this.terminalClusterFacade.resolveAiVaultSessionTitles(requests, signal)
  }

  prepareAiVaultSessionResume(
    args: AiVaultPrepareSessionResumeArgs
  ): Promise<AiVaultPrepareSessionResumeResult> {
    return (
      this.prepareAiVaultSessionResumeFn?.(args) ?? Promise.resolve({ useRealCodexHome: false })
    )
  }

  isPtyKnownExited(ptyId: string): boolean {
    return this.ptyWorktrees.isPtyKnownExited(ptyId)
  }

  setPtyController(controller: RuntimePtyController | null): void {
    return this.ptyWorktrees.setPtyController(controller)
  }

  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
    this.clientEventPublishingCommands.setNotifier(notifier)
    // Why: run the one-shot fork-upstream backfill once a renderer is attached,
    // so existing forks self-correct on launch and the result can be broadcast.
    if (notifier && !this.forkBackfillStarted) {
      this.forkBackfillStarted = true
      void this.backfillForkUpstreams()
    }
  }

  private backfillForkUpstreams(): Promise<void> {
    return this.repoGitCommands.backfillForkUpstreams()
  }

  onClientEvent(
    listener: (event: RuntimeClientEvent) => void,
    options?: { consumesTerminalSideEffects?: boolean }
  ): () => void {
    this.clientEventListeners.add(listener)
    if (options?.consumesTerminalSideEffects === false) {
      this.terminalSideEffectExcludedClientEventListeners.add(listener)
    } else {
      this.terminalSideEffectTitleGateKeysByClientEventListener.set(listener, new Map())
    }
    this.refreshTerminalSideEffectConsumerAvailability()
    return () => {
      this.clientEventListeners.delete(listener)
      this.terminalSideEffectExcludedClientEventListeners.delete(listener)
      this.terminalSideEffectTitleGateKeysByClientEventListener.delete(listener)
      this.refreshTerminalSideEffectConsumerAvailability()
    }
  }

  private countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.terminalClusterFacade.countTerminalSideEffectConsumingClientEventListeners()
  }

  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    return this.terminalClusterFacade.getTerminalSleepClientEventSnapshot()
  }

  getNativeChatLaunchDraftResolutionClientEventSnapshot(): Extract<
    RuntimeClientEvent,
    { type: 'nativeChatLaunchDraftResolved' }
  >[] {
    return [...this.nativeChatLaunchDraftResolutionByTabId.values()]
      .sort((a, b) => a.tabId.localeCompare(b.tabId))
      .map(({ tabId, text, createdAt }) => ({
        type: 'nativeChatLaunchDraftResolved',
        tabId,
        text,
        createdAt
      }))
  }

  private emitClientEvent(event: RuntimeClientEvent): void {
    return this.terminalClusterFacade.emitClientEvent(event)
  }

  notifyNativeChatLaunchDraftResolved(
    handle: string,
    resolution: { text: string; createdAt: number }
  ): void {
    const owner = this.resolveNativeChatLaunchDraftOwner(handle)
    if (!owner) {
      return
    }
    const tombstone = { ...owner, ...resolution }
    this.nativeChatLaunchDraftResolutionByTabId.delete(owner.tabId)
    this.nativeChatLaunchDraftResolutionByTabId.set(owner.tabId, tombstone)
    while (
      this.nativeChatLaunchDraftResolutionByTabId.size >
      MAX_NATIVE_CHAT_LAUNCH_DRAFT_RESOLUTION_TOMBSTONES
    ) {
      const oldestTabId = this.nativeChatLaunchDraftResolutionByTabId.keys().next().value
      if (typeof oldestTabId !== 'string') {
        break
      }
      this.nativeChatLaunchDraftResolutionByTabId.delete(oldestTabId)
    }
    this.retireResolvedNativeChatLaunchDraftFromMobileSnapshot(tombstone)
    this.notifier?.nativeChatLaunchDraftResolved?.(owner.tabId, resolution)
    this.emitClientEvent({
      type: 'nativeChatLaunchDraftResolved',
      tabId: owner.tabId,
      ...resolution
    })
  }

  private resolveNativeChatLaunchDraftOwner(
    handle: string
  ): { tabId: string; worktreeId: string } | null {
    return this.clientEventPublishingCommands.resolveNativeChatLaunchDraftOwner(handle)
  }

  private retireResolvedNativeChatLaunchDraftFromMobileSnapshot(
    resolution: NativeChatLaunchDraftResolutionTombstone
  ): void {
    return this.mobileSessionFacade.retireResolvedNativeChatLaunchDraftFromMobileSnapshot(
      resolution
    )
  }

  private applyNativeChatLaunchDraftResolutionFence(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    return this.clientEventPublishingCommands.applyNativeChatLaunchDraftResolutionFence(
      snapshot
    ) as RuntimeMobileSessionTabsSnapshot
  }

  private reconcileNativeChatLaunchDraftResolutionTombstones(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): void {
    this.clientEventPublishingCommands.reconcileNativeChatLaunchDraftResolutionTombstones(snapshot)
  }

  private notifyWorktreesChanged(repoId: string): void {
    return this.managedWorktrees.notifyWorktreesChanged(repoId)
  }

  /** Detail-level worktree lifecycle tap (plugin event bus). The coarse
   *  worktreesChanged client event carries only repoId, which is not enough
   *  for subscribers that need the affected worktree's identity.
   *  Removal payloads carry no branch: the removal target resolves before
   *  the git worktree is torn down and only pins id + path. */
  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    return this.managedWorktrees.onWorktreeLifecycle(listener)
  }

  private notifyReposChanged(): void {
    return this.terminalClusterFacade.notifyReposChanged()
  }

  // Why: automation writes land in the automation service and IPC handlers, so
  // like SSH state they need a public entry point onto the client-event stream.
  // Old clients drop the unknown event type; nothing is negotiated for it.
  notifyAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    return this.automationCommands.notifyAutomationsChanged(payload)
  }

  // Why: SSH state changes originate in main's ssh handlers, not in runtime
  // methods, so they need a public entry point onto the client-event stream.
  notifySshStateChanged(targetId: string, state: SshConnectionState): void {
    this.bumpSshRelayRecoveryGeneration(targetId)
    this.invalidateSshWorktreeScanCache(targetId)
    if (state.status !== 'connected') {
      this.cancelLegacyWorkerTerminalRecoveryRetry(`ssh:${targetId}`)
    }
    this.emitClientEvent({ type: 'sshStateChanged', targetId, state: getPublicSshState(state)! })
  }

  notifySshRelayReady(targetId: string): void {
    const generation = this.bumpSshRelayRecoveryGeneration(targetId)
    const publish = async (): Promise<void> => {
      try {
        await this.publishRecoveredSshMobileSessionTabs(targetId, generation)
      } catch (error) {
        if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) === generation) {
          console.warn('[runtime] failed to publish recovered SSH session tabs', {
            targetId,
            error
          })
        }
      }
    }
    const initialPublication = publish()
    void initialPublication
    void this.refreshRestoredOrchestrationAuthority(targetId)
      .then(() =>
        this.reconcileLegacyWorkerTerminals({
          connectionId: targetId,
          materializeRenderer: this.notifier !== null
        })
      )
      .then(async () => {
        await initialPublication
        await publish()
      })
      .catch((error) => {
        if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) !== generation) {
          return
        }
        console.warn('[orchestration] legacy worker reconcile failed on relay ready', {
          targetId,
          error
        })
      })
  }

  private bumpSshRelayRecoveryGeneration(targetId: string): number {
    return this.clientEventPublishingCommands.bumpSshRelayRecoveryGeneration(targetId)
  }

  private async publishRecoveredSshMobileSessionTabs(
    targetId: string,
    generation: number
  ): Promise<void> {
    return this.mobileSessionFacade.publishRecoveredSshMobileSessionTabs(targetId, generation)
  }

  invalidateSshWorktreeScanCache(targetId: string): void {
    return this.managedWorktrees.invalidateSshWorktreeScanCache(targetId)
  }

  // Why: renderer-initiated meta updates intentionally skip the renderer
  // notifier (the renderer already applied them optimistically), but remote
  // clients hold no optimistic copy and need the invalidation event.
  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    return this.managedWorktrees.notifyWorktreesChangedForRemoteClients(repoId)
  }

  // Why: structural catalog changes require a fresh Git scan; renderer metadata edits do not.
  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    return this.managedWorktrees.notifyWorktreeCatalogChangedForRemoteClients(repoId)
  }

  // Why: host-local repo IPC mutations never enter runtime methods, so paired
  // clients need an explicit catalog invalidation; the local renderer already
  // got its own repos:changed and must not be re-notified (#11994).
  notifyReposChangedForRemoteClients(): void {
    return this.terminalClusterFacade.notifyReposChangedForRemoteClients()
  }

  setAgentBrowserBridge(bridge: AgentBrowserBridge | null): void {
    this.agentBrowserBridge = bridge
  }

  getAgentBrowserBridge(): AgentBrowserBridge | null {
    return this.agentBrowserBridge
  }

  setOffscreenBrowserBackend(backend: BrowserBackend | null): void {
    this.offscreenBrowserBackend = backend
  }

  getOffscreenBrowserBackend(): BrowserBackend | null {
    return this.offscreenBrowserBackend
  }

  setEmulatorBridge(bridge: EmulatorBridge | null): void {
    this.emulatorBridge = bridge
  }

  getEmulatorBridge(): EmulatorBridge | null {
    return this.emulatorBridge
  }

  attachWindow(windowId: number): void {
    if (this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID) {
      if (
        this.pendingHeadlessPromotionWindowId !== null &&
        windowId !== this.pendingHeadlessPromotionWindowId
      ) {
        return
      }
      // Why: promotion is a renderer reload of the same graph owner, not a new
      // runtime; stale handles must transition before the real window publishes.
      this.persistWindowlessPtyBindingsForDesktopAttach()
      this.pendingHeadlessPromotionWindowId = windowId
      this.authoritativeWindowId = windowId
      this.beginGraphReload(windowId)
      return
    }
    if (this.authoritativeWindowId === null) {
      // Why: a promoted serve can close and later reopen its window while new
      // background PTYs keep arriving; every windowless gap needs this handoff.
      this.persistWindowlessPtyBindingsForDesktopAttach()
      this.authoritativeWindowId = windowId
    }
  }

  private persistWindowlessPtyBindingsForDesktopAttach(): void {
    this.clientEventPublishingCommands.persistWindowlessPtyBindingsForDesktopAttach()
  }

  syncWindowGraph(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): RuntimeSyncWindowGraphResult {
    return this.windowGraphClientCommands.syncWindowGraph(windowId, graph)
  }

  // Why: toMobileSessionTabsResult resolves handles/titles from this.tabs and
  // this.leaves, so any tab/leaf delta a graph sync installs can flip the
  // client payload (pending-handle → ready, tab title) with zero change to the
  // stored snapshot. Compare exactly the projection-relevant fields and report
  // the affected worktrees; false positives only cost a coalesced no-op emit.
  private collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    return this.terminalClusterFacade.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )
  }

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    return this.mobileSessionFacade.listMobileSessionTabs(worktreeSelector, clientNavigationId)
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    return this.terminalClusterFacade.listAllMobileSessionTabs(clientNavigationId)
  }

  async listAllMobileSessionTabsWithChangeSequence(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    changeSequence: number
  }> {
    return this.mobileSessionFacade.listAllMobileSessionTabsWithChangeSequence(clientNavigationId)
  }

  private async collectAllMobileSessionTabs(clientNavigationId?: string): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    ptyInventory: PtyControllerInventory | null
    changeSequence: number
  }> {
    return this.mobileSessionFacade.collectAllMobileSessionTabs(clientNavigationId)
  }

  async listAllMobileSessionTabsInventory(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }> {
    return this.mobileSessionFacade.listAllMobileSessionTabsInventory(clientNavigationId, signal)
  }

  async listAllMobileSessionTabsInventoryWithChangeSequence(
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    return this.mobileSessionFacade.listAllMobileSessionTabsInventoryWithChangeSequence(
      clientNavigationId,
      signal
    )
  }

  // Why: a failed census only invalidates the emptiness verdict, never the
  // list. An incomplete census usually means a concurrent scan invalidated
  // this one mid-relaunch and daemon-backed tabs could not be restored yet, so
  // retry the collection once; a still-incomplete retry serves its snapshots
  // unlabeled rather than erroring the request.
  private async settleSessionTabsInventory(
    inventory: {
      snapshots: RuntimeMobileSessionTabsResult[]
      ptyInventory: PtyControllerInventory | null
      changeSequence: number
    },
    clientNavigationId?: string,
    signal?: AbortSignal
  ): Promise<{
    snapshots: RuntimeMobileSessionTabsResult[]
    authoritative?: true
    changeSequence: number
  }> {
    if (this.isCompleteSessionTabsPtyCensus(inventory.ptyInventory)) {
      return {
        snapshots: inventory.snapshots,
        authoritative: true,
        changeSequence: inventory.changeSequence
      }
    }
    const retried = await this.collectAllMobileSessionTabs(clientNavigationId)
    this.assertSessionTabsInventoryRequestActive(signal)
    // Why: the retry ran outside the epoch fence, so it never claims authority.
    return { snapshots: retried.snapshots, changeSequence: retried.changeSequence }
  }

  supportsAuthoritativeSessionTabsInventory(): boolean {
    return process.env.ORCA_E2E_DISABLE_AUTHORITATIVE_SESSION_TABS_INVENTORY !== '1'
  }

  private assertSessionTabsInventoryRequestActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }

  private isCompleteSessionTabsPtyCensus(inventory: PtyControllerInventory | null): boolean {
    if (!inventory) {
      return false
    }
    const knownHostIds = this.listKnownExecutionHostIds(inventory.queriedHostIds)
    return ![...knownHostIds].some((hostId) => {
      const parsed = parseExecutionHostId(hostId)
      return parsed?.kind !== 'runtime' && !inventory.queriedHostIds.has(hostId)
    })
  }

  private waitForSessionTabsInventoryPublication(signal?: AbortSignal): Promise<void> {
    if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.sessionTabsInventoryWaiters.delete(onPublished)
        signal?.removeEventListener('abort', onAbort)
      }
      const onPublished = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      this.sessionTabsInventoryWaiters.add(onPublished)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
      } else if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
        onPublished()
      }
    })
  }

  private getAuthoritativeSessionTabsInventoryEpoch(): number | null {
    return this.graphStatus === 'ready' &&
      this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch
      ? this.rendererGraphEpoch
      : null
  }

  private markSessionTabsInventoryPublished(): void {
    if (this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch) {
      return
    }
    this.sessionTabsInventoryPublicationEpoch = this.rendererGraphEpoch
    for (const publish of [...this.sessionTabsInventoryWaiters]) {
      publish()
    }
  }

  // Why: the ctor deps-literals moved to *-wiring.ts read these members through a
  // keyed view (Record<string, any>), which TS cannot attribute as usage. This
  // explicit reference list keeps noUnusedLocals honest about real runtime reads.
  private wiringReferencedHostMembers(): readonly unknown[] {
    return [
      // Why: consumed only by extracted wiring builders via bracket access (see runtime-ctor-wiring.ts).
      this.assertStableReadyGraph,
      this.attachAgentRowsToSummaries,
      this.captureReadyGraphEpoch,
      this.getAutoRestoreFitMs,
      this.getValidatedExplicitWorktreeIdSelector,
      this.graphSyncCallbacks,
      this.handleByPtyIncarnation,
      this.headlessGraphFallbackAvailable,
      this.headlessHydrationState,
      this.layouts,
      this.legacyWorkerRecoveredPtys,
      this.listResolvedWorktreeSnapshot,
      this.nextTitleObservationSequence,
      this.notifyFitOverrideListeners,
      this.notifyRemoteTerminalViewPresenceChanged,
      this.pendingRestoreTimers,
      this.pendingSoftLeavers,
      this.pickMostRecentActor,
      this.providerSnapshotPreferredPtys,
      this.recordPtyWorktree,
      this.rendererGeneration,
      this.rendererPublicationThrottle,
      this.resolveTerminalWorkspaceLaunchScope,
      this.setDriver,
      this.adoptFirstPtyForLeafHandle,
      this.adoptTerminalOrphansFromInventory,
      this.applySeededAgentStatus,
      this.buildAgentOrchestrationByPaneKey,
      this.cancelMobileDictationForClient,
      this.closeStructuredAgentSessionTab,
      this.collectMobileVisibleGraphChangedWorktrees,
      this.getDesktopWindowStatusFn,
      this.getSummaryForRuntimeWorktreeId,
      this.getTerminalTopologyRevision,
      this.getTrackedRawTitleForPty,
      this.hasExactPersistedTerminalSurfaceIdentity,
      this.hasExactTerminalSurfaceIdentity,
      this.invalidateLeafHandle,
      this.legacyWorkerTerminalReceiptEpochByPane,
      this.persistLegacyWorkerTerminalRecoveryBatch,
      this.persistedClientHostedBrowserWorktreeIds,
      this.rebuildLeafPtyIndex,
      this.reconcileMissingLegacyWorkerTerminal,
      this.reconcileMobileSessionRetirementFences,
      this.recordOsc7MetadataForPty,
      this.recordRecentPtyOutputForPathProvenance,
      this.refreshPtyWorktreeRecordsFromController,
      this.republishMobileSessionTabsSnapshot,
      this.rollbackLegacyWorkerTerminalSurface,
      this.syncMobileSessionTabs,
      this.updateLegacyWorkerTerminalRecoveryRetry,
      // Why: federation relay state is read/written via bracket access in
      // runtime-orchestration-federation.ts, invisible to noUnusedLocals.
      this.agentPromptPermissionSequenceByPtyId,
      this.oscTitleScanTailByPtyId,
      this.osc7ScanTailByPtyId,
      this.terminalFileUriHostnameByPtyId,
      this.terminalCwdByPtyId,
      this.wslDistroByPtyId,
      this.terminalSpawnCommandsByPtyId,
      this.clearAgentRowSnapshotsForPty,
      this.clearWaitBlockedCheckState,
      this.countTerminalSideEffectConsumingClientEventListeners,
      this.primeWaitBlockedBaselineFromSeededTail,
      this.recordAgentPromptLifecycleState,
      this.resolvePtyTuiIdleWaiters,
      this.resolveTuiIdleWaiters,
      this.setPtyManagementTitleFromObservedTitle,
      this.retirePtyAgentLaunchAuthority,
      this.getFreshExplicitAgentStatusForHandle,
      this.deliverPendingMessagesForLeaf,
      this.recordTerminalSideEffectFact,
      this.getLeavesForPty,
      this.getLivePtyForHandle,
      this.getPrimaryLeafForPty,
      this.getLiveLeafForHandle,
      this.getTerminalAgentStatus,
      this.agentStatusOscProcessorsByPtyId,
      this.leavesByPtyId,
      this.graphReloadLifecycle,
      this.onTerminalSideEffects,
      this.clearPtyIncarnationHandles,
      this.rememberDetachedPreAllocatedLeaves,
      this.refreshWritableFlags,
      this.rejectWaitersForHandle,
      this.rejectAllWaiters,
      this.reconcilePtyIncarnationHandles,
      this.markSessionTabsInventoryPublished,
      this.setTerminalSideEffectConsumerAvailable,
      this.adoptPreAllocatedHandle,
      this.attachWindow,
      this.terminalSideEffectConsumerAvailable,
      this.terminalSideEffectLocalConsumerAvailable,
      this.waitersByHandle,
      this.orchestrationFederationTimers,
      this.orchestrationTerminalHistoryRecoveryTimer,
      this.orchestrationTerminalHistoryRecoveryInFlight,
      this.orchestrationTerminalRecoveryRowId,
      this.orchestrationFederationRelayGeneration,
      this.orchestrationFederationSyncs,
      this.orchestrationFederationWarnings,
      this.hookAgentRowResolutionCommands,
      this.disposalTree,
      this.acceptedRendererMobileSnapshotByWorktree,
      this.terminalCreateIdempotency,
      this.terminalSleepByWorktreeId,
      this.terminalMutationTailByWorktreeId,
      this.terminalPaneRecoveryByIdentity,
      this.earlyExitedPtyIncarnations,
      this.pendingPtyRegistrationIncarnations,
      this.intentionalHandlelessPtyStops,
      this.terminalFocusNavigationCoalescer,
      this.ptyRecordsById,
      this.syntheticTerminalHandles,
      this.ptyExitListenersByPtyId,
      this.stopRequestedPtyIds,
      this.dataListeners,
      this.setupCompletionTokenByPtyId,
      this.fitOverrideListeners,
      this.ptyLivenessVerdictByPtyId,
      this.ptyLivenessObservationSequence,
      this.pairedRendererSessionOwnedPtyIds,
      this.ptyOutputSequenceById,
      this.agentPromptExplicitStatusFloorByPtyId,
      this.agentPromptSubmissionTailByPtyId,
      this.providerSequenceInitializedPtys,
      this.providerSequenceOffsetByPtyId,
      this.providerModeTrackersByPtyId,
      this.providerModeSnapshotScansByPtyId,
      this.providerBufferAcquisitionsByPtyId,
      this.providerVisibleStateByPtyId,
      this.providerVisibleRetryAtByPtyId,
      this.providerSnapshotsWithLiveModeTransition,
      this.ptyLifecycleGenerationById,
      this.nextPtyLifecycleGeneration,
      this.recentPtyPathCandidatesById,
      this.remoteTerminalViewSubscriberCounts,
      this.rawTerminalViewSubscriberCounts,
      this.spawnPublishedPtys,
      this.currentDriver,
      this.resizeListeners,
      this.layoutQueues,
      this.onTerminalAgentStatus,
      this.getAgentProviderSessionSnapshotFn,
      this.getAgentProviderSessionRowsForPaneFn,
      this.retireAgentHookCompatibilityAuthorityFn,
      this.reconcileAgentStatusForEndedProcessFn,
      this.buildAgentHookPtyEnv,
      this.prepareCodexStructuredLaunchFn,
      this.agentSessionClaimSigner,
      this.agentSessionCreateOperations,
      this.legacyWorkerTerminalRecoveryRetries,
      this.skillTransactionRecovery,
      this.claudeAgentTeams,
      this.getAgentLaunchPlatformForWorkspace,
      this.flushWorkspaceSessionOrThrowAsync,
      this.reconcileLegacyWorkerTerminalsNow,
      this.getWorkspaceSessionHostIdForWorktree,
      this.getWorkspaceSessionHydrationTargets,
      this.applyNativeChatLaunchDraftResolutionFence,
      this.reconcileNativeChatLaunchDraftResolutionTombstones,
      this.settleSessionTabsInventory,
      this.waitForSessionTabsInventoryPublication,
      this.isDeliberatelyParkedPane,
      this.persistHeadlessTerminalActiveLeaf,
      this.persistHeadlessSessionTabProps,
      this.applyHeadlessSessionTabPropsToSnapshot,
      this.getMobileSessionTopLevelTabId,
      this.persistHeadlessTerminalPaneLayout,
      this.applyHeadlessTerminalPaneLayoutToSnapshot,
      this.persistHeadlessTabGroups,
      this.resolveConfiguredCodexStructuredArgs,
      this.proveRecoveredStructuredTuiPtyProcess,
      this.closeStructuredTuiOwner,
      this.waitForStructuredTuiIdleOrExit,
      this.stopStructuredSessionProcess,
      this.adoptControllerTerminalHandle,
      this.assertPtyDidNotExitBeforeRegistration,
      this.scheduleWaitBlockedCheck,
      this.processAgentStatusOscForPty,
      this.flushPendingTerminalSideEffectFacts,
      this.isLiveCursorNativeTitle,
      this.getTrackedDisplayTitleForPty,
      this.getUnpersistedTrackedTitleForPty,
      this.preferTrackedLastTitle,
      this.applyTrackedPtyTitle,
      this.disposePtyTitleTracker,
      this.resetTrackedTerminalStateForProviderGeneration,
      this.createTerminalSideEffectCommandCodeDetector,
      this.extractLastOsc7CwdForPty,
      this.pathFlavorForPty,
      this.assertTerminalAgentStatusPtyBinding,
      this.getTerminalAgentStatusSnapshot,
      this.probeAgentStatusOncePerPty,
      this.shouldDelayPtyBackedMobileSnapshotForForegroundAgent,
      this.refreshPtyForegroundAgent,
      this.getPendingForegroundAgentRefreshForTitle,
      this.delayPtyBackedMobileSnapshotForForegroundAgent,
      this.refreshPtyForegroundAgentFromController,
      this.hasAuthoritativeTerminalWaitPermission,
      this.resolveAuthoritativeTerminalWaitPermission,
      this.readPtyForegroundProcessFromController,
      this.emitTerminalAgentStatusEvents,
      this.restoreAgentPromptLifecycleByteOrder,
      this.getPtyLifecycleGeneration,
      this.isKnownUnattachedLocalDaemonPty,
      this.reconcileSubscriberDrivenProviderAttach,
      this.maybeHydrateHeadlessFromRenderer,
      this.shouldAnswerQueriesForLiveChunk,
      this.trackHeadlessTerminalData,
      this.replaceHeadlessTerminalAfterExecutionContextChange,
      this.readProviderTerminalTailLines,
      this.readVisibleTerminalState,
      this.disposeHeadlessTerminal,
      this.rememberRestoredOrchestrationAuthority,
      this.ptyExit_notifyTabAndMobile,
      this.activeRemoteDesktopViewport,
      this.resolveRemoteDesktopHostReclaimTarget,
      this.hasRemoteDesktopLayoutState,
      this.cancelPendingDriverMutations,
      this.pickEarliestRestoreTarget,
      this.isFreshSubscribe,
      this.coalescesWith,
      this.suppressResizesForMs,
      this.notifyTerminalResize,
      this.failActiveDispatchOnExit,
      this.forgetPtyLivenessVerdict,
      this.getPtyWriteHostPlatform,
      this.buildStartupForDraft,
      this.buildStartupForAgent,
      this.markWorkspaceTrustedForAgent,
      this.markLocalWorkspaceTrustedForAgent,
      this.markRemoteWorkspaceTrustedForAgent,
      this.pasteStartupDraftWhenReady,
      this.sendStartupFollowupWhenReady,
      this.createDefaultTabTerminals,
      this.rememberPreservedBranchCleanupTarget,
      this.preserveBranchHeadFallback,
      this.ensurePtyBackedMobileSurfaceForRendererTab,
      this.setPairedRendererSessionOwnership,
      this.hasLiveShellForRendererTab,
      this.deliverPendingStartupCommandToBareRendererPty,
      this.listWorkspaceSessionPartitions,
      this.stopPtysForDestructiveWorktreeRemoval,
      this.getTerminalHandlesForPtyId,
      this.getRecordedTerminalSleepHandles,
      this.resolveWorkspaceTerminalStartupCwd,
      this.resolveWorkspaceParentSelector,
      this.validateLineageParent,
      this.resolveLineageCandidateForTaskId,
      this.buildResolvedWorktreeFromId,
      this.hasFreshResolvedWorktreeCache,
      this.resolveExplicitWorktreeIdScoped,
      this.invalidateSshWorktreeScanCacheInternal,
      this.getOrCreatePtyWorktreeRecord,
      this.refreshFloatingWorkspacePtyLiveness,
      this.pruneDisconnectedPtyTranscript,
      this.pruneDisconnectedPtyRecords,
      this.leafExistsForPty,
      this.resolvePaneAgentIdentityField,
      this.terminalExecutionHostField,
      this.collectReturnedSessionTabIds,
      this.getHookAgentRowForPane,
      this.getMobileTerminalPaneKey,
      this.getPtyRecordForPaneKey,
      this.isRecognizedForegroundAgentProcess,
      this.retireOrchestrationMailboxDeliveryForPty,
      this.assertLiveTerminalHandleTargetsPty,
      this.invalidatePtyIncarnationHandle,
      this.findHandleForPtyRecord,
      this.resolveExitWaiters,
      this.resolvePtyExitWaiters,
      this.isHeadlessMobileSessionPublication,
      this.applyMobileSessionRetirementFences
    ]
  }

  private buildMobileSessionFacadeDeps() {
    return buildMobileSessionFacadeDepsImpl(this)
  }

  private buildPtyWorktreesDeps() {
    return buildPtyWorktreesDepsImpl(this)
  }

  private buildTerminalClusterFacadeDeps() {
    return buildTerminalClusterFacadeDepsImpl(this)
  }

  private buildManagedWorktreesDeps() {
    return buildManagedWorktreesDepsImpl(this)
  }

  private buildAgentClusterFacadeDeps() {
    return buildAgentClusterFacadeDepsImpl(this)
  }

  private hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    } = {}
  ): Set<string> {
    return this.mobileTabOperations.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
      worktreeId,
      options
    )
  }

  // Why: content equality for the hydrate's idempotence check — compares every
  // client-visible field EXCEPT publicationEpoch/snapshotVersion (both are
  // freshly minted on each rebuild and would defeat the comparison). Tab and
  // group objects are rebuilt each hydrate, so compare by value, not identity.
  // Deep structural equality over plain snapshot JSON (objects/arrays/scalars).
  // Key order is irrelevant; a mismatch only costs a coalesced no-op emit.
  // Why: keep an existing snapshot's browser tabs in sync with the live bridge
  // without rebuilding stable terminal state. Replaces browser entries with the
  // current live set and rewrites the browser portion of the primary group order.
  // Why: browser session tabs have no parentTabId so the terminal-only group
  // builder drops them from tabOrder; this re-adds their ids to a group.
  // Browser tabs are live-only (no persisted session entry), but their GROUP
  // membership must still survive snapshot rebuilds like terminals'. The
  // passed-in groups already encode each browser's group (carried from the prior
  // snapshot / persisted tabGroups), so keep each existing browser id where it
  // is; only a genuinely-new browser id goes to its create-target group (when
  // that group exists) and otherwise to the first group. Previously every
  // browser was force-pushed into group[0], so opening a browser in the right
  // split group always snapped it back to the left on the next rebuild.
  // browserPageId -> groupId from a set of groups (the persisted/prior layout),
  // so a browser stays in its group across rebuilds that drop browser ids.
  // Why: serve-* (local serve) and ssh:<conn>@@<relay> (SSH relay) ids are minted
  // ONLY for runtime-owned terminals and are preserved/re-hydrated, so tear them
  // down even if the renderer adopted a view (else they resurrect). The daemon
  // session form <worktreeId>@@<shortUuid> is deliberately NOT here: the daemon
  // mints it for ordinary renderer-owned local terminals too, so id shape can't
  // classify ownership for that form — renderer-graph membership does (below).
  // Why: a snapshot tab can keep a serve/SSH-owned ptyId after the runtime
  // terminal died and was de-persisted, so id shape alone must not preserve it
  // against a renderer publication. Require the binding to be backed by a live
  // PTY or by the persisted workspace session (a dormant persisted serve/SSH
  // binding is still re-hydratable, so it stays preserved).
  // Why: only positive evidence that the persisted parent dropped this leaf may
  // release it — a parent with no persisted layout is no evidence of a split.
  // Why: omitted from the publication AND from persistence = durably closed, so release
  // ownership — else a lagging or failed kill preserves the tab back into every merge.
  // A create still in flight has not been retired, only not published yet.
  // Why: a tab needs authoritative runtime teardown (kill + de-persist + prune)
  // only when the renderer can't durably tear it down: either it's serve/SSH
  // (preserved + re-hydrated, would resurrect) or the renderer graph never
  // published it (a leaked/unadopted shell — incl. daemon-session `@@` tabs the
  // host materialized but the renderer never showed). A tab the renderer graph
  // DOES list — including an ordinary daemon-backed local terminal or a pending
  // tab whose PTY hasn't bound — is renderer-owned: delegate, do not de-persist.

  private getMobileSessionSnapshotTabIdentityKeys(tab: RuntimeMobileSessionSnapshotTab): string[] {
    return this.mobileSessionFacade.getMobileSessionSnapshotTabIdentityKeys(tab)
  }

  private async refreshMobileSessionPtyRecords(
    targetWorktreeId: string | null = null
  ): Promise<Set<string> | null> {
    return this.mobileTabOperations.refreshMobileSessionPtyRecords(targetWorktreeId)
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
    return this.mobileSessionFacade.activateMobileSessionTab(worktreeSelector, tabId, leafId, opts)
  }

  /**
   * Whether persistence proves this pane's PTY was deliberately taken down and parked
   * (workspace sleep or completed-agent hibernation) rather than lost and awaiting reconnect.
   * Why: `pending-handle` alone cannot tell those apart — a parked pane publishes it
   * indefinitely — and respawning a parked pane re-launches its agent behind the user.
   * Only an automatic activation consults this; a user opening the tab is the wake gesture.
   */
  private isDeliberatelyParkedPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const record =
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey?.[
        makePaneKey(tab.parentTabId, tab.leafId)
      ]
    // Why: 'live'/'quit' captures describe a pane that was still running, so a reconnect
    // must still mint its replacement PTY (#11542). Only a worktree-owned capture records
    // a deliberate takedown the user did not ask to undo.
    return (
      record?.origin === 'worktree-sleep' && runtimeWorktreeIdsEqual(record.worktreeId, worktreeId)
    )
  }

  private persistHeadlessTerminalActiveLeaf(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    return this.terminalClusterFacade.persistHeadlessTerminalActiveLeaf(worktreeId, tab)
  }

  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string
  ): Promise<MobileSessionTabCloseOutcome> {
    return this.mobileSessionFacade.refuseUnattributedMobileSessionTabClose(worktreeSelector, tabId)
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
    return this.mobileTabOperations.closeMobileSessionTab(worktreeSelector, tabId, options)
  }

  // Why: a refused echoed close means the echoing client already pruned its
  // local mirror. Bump the version and emit the unchanged snapshot so clients
  // that dedupe by snapshotVersion re-add and re-attach the still-live tab.
  private republishMobileSessionTabsSnapshot(worktreeId: string): void {
    return this.mobileSessionFacade.republishMobileSessionTabsSnapshot(worktreeId)
  }

  // Public so runtime-side page release (lease fencing) can prune a tab whose page is gone.
  retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean {
    // Why: before the snapshot guard — worktree removal drops the snapshot first, and the host
    // rows for its client pages would otherwise be stranded on screen with nothing to retract them.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return false
    }
    const retiredTab = snapshot.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!retiredTab) {
      return false
    }
    const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== retiredTab.id)
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => id !== retiredTab.id),
        activeTabId: group.activeTabId === retiredTab.id ? null : group.activeTabId
      })),
      tabs: nextTabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return true
  }

  private closeStructuredAgentSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionAgentTab
  ): void {
    return this.agentClusterFacade.closeStructuredAgentSessionTab(worktreeId, snapshot, tab)
  }

  private markHeadlessBrowserSessionTabActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void {
    return this.mobileTabOperations.markHeadlessBrowserSessionTabActive(
      worktreeId,
      browserPageId,
      options
    )
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    return this.mobileSessionFacade.moveMobileSessionTab(worktreeSelector, move)
  }

  // Why: pane geometry inside a tab (split ratios, expanded pane, pane titles)
  // is host-authoritative for remote-server tabs but had no push path, so a
  // client divider-drag / expand / pane-rename reverted on the next snapshot.
  // Persist the structural fields onto the tab's layout, keeping host-owned
  // pty bindings and active leaf.
  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): Promise<{ updated: true }> {
    return this.terminalClusterFacade.updateMobileSessionPaneLayout(worktreeSelector, args)
  }

  // Why: tab color/pin are host-authoritative for remote-server tabs but had no
  // push path, so pinning or coloring a tab reverted on the next snapshot and
  // was never persisted. Persist to the workspace session + live snapshot.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }
  ): Promise<{ updated: true }> {
    return this.mobileTabOperations.setMobileSessionTabProps(worktreeSelector, args)
  }

  // Delegation methods
  private persistHeadlessSessionTabProps = (
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ) =>
    this.headlessSessionTabPersistenceCommands.persistHeadlessSessionTabProps(
      worktreeId,
      tabId,
      props
    )

  private applyHeadlessSessionTabPropsToSnapshot = (
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ) =>
    this.headlessSessionTabPersistenceCommands.applyHeadlessSessionTabPropsToSnapshot(
      worktreeId,
      tabId,
      props
    )

  private getMobileSessionTopLevelTabId = (tab: RuntimeMobileSessionSnapshotTab) =>
    this.headlessSessionTabPersistenceCommands.getMobileSessionTopLevelTabId(tab)

  private persistHeadlessTerminalPaneLayout = (
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ) => {
    this.headlessSessionTabPersistenceCommands.persistHeadlessTerminalPaneLayout(worktreeId, args)
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    return session?.terminalLayoutsByTabId?.[args.tabId]
  }

  private applyHeadlessTerminalPaneLayoutToSnapshot = (
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ) =>
    this.headlessSessionTabPersistenceCommands.applyHeadlessTerminalPaneLayoutToSnapshot(
      worktreeId,
      args.tabId,
      args.expandedLeafId
    )

  // Persist the headless tab-GROUP layout so snapshot rebuilds keep the split.
  private persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ): void {
    return this.mobileTabOperations.persistHeadlessTabGroups(worktreeId, groups, layout)
  }

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    return this.mobileSessionFacade.readMobileMarkdownTab(worktreeSelector, tabId)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    return this.mobileTabOperations.saveMobileMarkdownTab(
      worktreeSelector,
      tabId,
      baseVersion,
      content
    )
  }

  private readonly workspaceFileTargetCommands: RuntimeWorkspaceFileTargetCommands
  private readonly fileCommands = new RuntimeFileCommands({
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
    resolveKnownWorkspaceFileTarget: (absolutePath, executionHostId) =>
      this.workspaceFileTargetCommands.resolveKnownWorkspaceFileTarget(
        absolutePath,
        executionHostId
      ),
    resolveTerminalCwd: (terminalHandle) => this.resolveTerminalCwd(terminalHandle),
    resolveTerminalContext: (terminalHandle) => this.resolveTerminalContext(terminalHandle),
    resolveTerminalFileUriHostname: (terminalHandle) =>
      this.resolveTerminalFileUriHostname(terminalHandle),
    hasRecentTerminalOutputPath: (terminalHandle, pathText, absolutePath) =>
      this.hasRecentTerminalOutputPath(terminalHandle, pathText, absolutePath),
    hasRecentNativeChatOutputPath: (worktreeId, context, pathText, absolutePath) =>
      nativeChatTranscriptIncludesPath({
        tabs: this.getMobileSessionTabsForWorktree(worktreeId).tabs,
        context,
        pathText,
        absolutePath
      }),
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId) => {
      if (!this.notifier?.openFile) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openFile(worktreeId, filePath, relativePath, runtimeEnvironmentId)
    },
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId) => {
      if (!this.notifier?.openDiff) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openDiff(worktreeId, filePath, relativePath, staged, runtimeEnvironmentId)
    }
  })

  closeFileWatchersForRemoval = async (
    worktreePath: string,
    connectionId?: string,
    deadline: WatcherRemovalDeadline = createWatcherRemovalDeadline()
  ): Promise<void> => {
    // Why drain the remote/explorer closes: they await SSH round trips and lease suspends that a dead
    // link never answers. The local close bounds its own awaits against the same deadline internally.
    const results = await Promise.allSettled([
      connectionId
        ? drainBeforeWatcherRemoval(
            getWorktreeWatcherRemoval().closeRemote(connectionId, worktreePath),
            deadline,
            `remote watcher close for ${worktreePath}`
          )
        : getWorktreeWatcherRemoval().closeLocal(worktreePath, deadline),
      drainBeforeWatcherRemoval(
        this.fileCommands.closeFileExplorerWatchersForPath(worktreePath, connectionId),
        deadline,
        `file explorer watcher close for ${worktreePath}`
      )
    ])
    const failure = results.find((result): result is PromiseRejectedResult => {
      return result.status === 'rejected'
    })
    if (failure) {
      // Why: restoration must start only after every bounded teardown settles;
      // otherwise a late close can stale a just-restored logical subscription.
      throw failure.reason
    }
  }
  restoreFileWatchersAfterFailedRemoval = async (
    worktreePath: string,
    connectionId?: string
  ): Promise<void> => {
    await Promise.all([
      connectionId
        ? getWorktreeWatcherRemoval().restoreRemote(connectionId, worktreePath)
        : getWorktreeWatcherRemoval().restoreLocal(worktreePath),
      this.fileCommands.restoreFileExplorerWatchersAfterFailedRemoval(worktreePath, connectionId)
    ])
  }
  forgetFileWatchersAfterRemoval = (worktreePath: string, connectionId?: string): void => {
    if (connectionId) {
      getWorktreeWatcherRemoval().forgetRemote(connectionId, worktreePath)
    } else {
      getWorktreeWatcherRemoval().forgetLocal(worktreePath)
    }
    this.fileCommands.forgetFileExplorerWatchersAfterRemoval(worktreePath, connectionId)
  }
  acquireFileWatcherRemoval = async (
    worktreePath: string,
    connectionId?: string
  ): Promise<{ finish(removed: boolean): Promise<void> }> => {
    const gate = acquireWatcherRemovalGate(worktreePath, connectionId)
    // Why: one budget for the whole preparation — independent per-await timeouts would compose into minutes.
    const deadline = createWatcherRemovalDeadline()
    try {
      // Why: the first pass aborts desktop setup immediately; the second catches
      // any pre-gate runtime install that published after the first snapshot.
      await this.closeFileWatchersForRemoval(worktreePath, connectionId, deadline)
      // Why: a wedged install never releases its fence slot, so gate.ready can hang forever; the delete
      // must proceed instead, or the gate stays held and every later install under this root is rejected.
      const fenceDrain = await drainBeforeWatcherRemoval(
        gate.ready,
        deadline,
        `watcher install fence for ${worktreePath}`
      )
      if (fenceDrain === 'timeout') {
        // Why: a wedged install holds its fence slot for the process lifetime, so leaving it counted
        // makes every later removal of this root burn the whole drain budget again.
        gate.abandonPendingInstalls()
      }
      await this.closeFileWatchersForRemoval(worktreePath, connectionId, deadline)
      let finished = false
      return {
        finish: async (removed) => {
          if (finished) {
            return
          }
          finished = true
          if (removed) {
            this.forgetFileWatchersAfterRemoval(worktreePath, connectionId)
          }
          gate.release()
          if (!removed) {
            await this.restoreFileWatchersAfterFailedRemoval(worktreePath, connectionId).catch(
              (restoreError: unknown) => {
                console.error('[worktrees] failed to restore watchers after removal failed', {
                  worktreePath,
                  restoreError
                })
              }
            )
          }
        }
      }
    } catch (error) {
      gate.release()
      await this.restoreFileWatchersAfterFailedRemoval(worktreePath, connectionId).catch(
        (restoreError: unknown) => {
          console.error('[worktrees] failed to restore watchers after removal setup failed', {
            worktreePath,
            restoreError
          })
        }
      )
      throw error
    }
  }

  private readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    getRuntimeSettings: () => this.requireStore().getSettings() as GlobalSettings,
    getCommitMessageAgentEnvironment: () => this.commitMessageAgentEnv ?? undefined,
    // Why: resolved worktrees are cached for a second, so link/unlink would lag
    // generation; meta is keyed by the same id the resolver returns.
    getWorktreeLinkedIssue: (worktreeId) => {
      const store = this.store
      // Why: an unreadable store is "unknown", not "unlinked" — undefined keeps
      // the resolver's cached linkedIssue instead of suppressing {linkedIssue}.
      if (!store?.getWorktreeMeta) {
        return undefined
      }
      return store.getWorktreeMeta(worktreeId)?.linkedIssue ?? null
    },
    getWorktreeLinkedIssueMeta: (worktreeId) => {
      const store = this.store
      if (!store?.getWorktreeMeta) {
        return undefined
      }
      const meta = store.getWorktreeMeta(worktreeId)
      return meta
        ? {
            linkedIssue: meta.linkedIssue,
            linkedGitLabIssue: meta.linkedGitLabIssue,
            linkedWorkItem: meta.linkedWorkItem
          }
        : null
    }
  })

  /**
   * Installs the structured agent-session host on first use. Lazy for the same
   * reason the orchestration DB is: the profile's user-data path is not final
   * until the app is ready, and a runtime nobody drives a chat session on
   * should never open the record store.
   */
  async ensureStructuredAgentSessionHost(): Promise<void> {
    return this.agentClusterFacade.ensureStructuredAgentSessionHost()
  }

  private resolveConfiguredCodexStructuredArgs(): string[] {
    const settings = this.requireStore().getSettings()
    const shell = resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    return resolveCodexStructuredAppServerArgs(
      resolveTuiAgentLaunchArgs('codex', settings.agentDefaultArgs),
      shell ?? 'posix'
    )
  }

  private async proveRecoveredStructuredTuiPtyProcess(
    pty: RuntimePtyWorktreeRecord,
    identity: NonNullable<AgentSessionRecord['lease']['ownerProcess']>,
    provider: 'codex' | 'claude' = 'codex'
  ): Promise<boolean> {
    return this.ptyWorktrees.proveRecoveredStructuredTuiPtyProcess(pty, identity, provider)
  }

  private async closeStructuredTuiOwner(
    owner: StructuredTuiOwner
  ): Promise<{ transcriptPath?: string }> {
    if (this.ptysById.get(owner.terminal.ptyId)?.connected) {
      const current = this.refreshStructuredTuiOwnerBinding(owner)
      try {
        await this.closeTerminal(current.terminal.handle)
      } catch (error) {
        if (this.ptysById.get(owner.terminal.ptyId)?.connected) {
          throw error
        }
      }
    }
    await this.waitForStructuredTuiOwnerExit(owner)
    return owner.transcriptPath ? { transcriptPath: owner.transcriptPath } : {}
  }

  // The new exact `codex resume <thread>` child proves the resumed owner without
  // a first turn; the pinned rollout then binds its durable transcript.
  private refreshStructuredTuiOwnerBinding(owner: StructuredTuiOwner): StructuredTuiOwner {
    const pty = this.ptysById.get(owner.terminal.ptyId)
    if (!pty?.connected) {
      throw new Error('The owning agent terminal lost its launch identity.')
    }
    const handle = this.issueStructuredTuiPtyHandle(pty)
    if (handle === owner.terminal.handle) {
      return owner
    }
    return { ...owner, terminal: { ...owner.terminal, handle } }
  }

  private issueStructuredTuiPtyHandle(pty: RuntimePtyWorktreeRecord): string {
    return this.ptyWorktrees.issueStructuredTuiPtyHandle(pty)
  }

  private async waitForStructuredTuiPtyExit(ptyId: string): Promise<void> {
    return this.ptyWorktrees.waitForStructuredTuiPtyExit(ptyId)
  }

  private async waitForStructuredTuiOwnerExit(owner: StructuredTuiOwner): Promise<void> {
    await waitForStructuredTuiExitProof({
      identity: owner.process,
      waitForExit: () => this.waitForStructuredTuiPtyExit(owner.terminal.ptyId)
    })
  }

  private async waitForStructuredTuiIdleOrExit(
    owner: StructuredTuiOwner,
    signal: AbortSignal
  ): Promise<'idle' | 'exited' | null> {
    const deadline = Date.now() + 250
    while (!signal.aborted && Date.now() < deadline) {
      if (!this.ptysById.get(owner.terminal.ptyId)?.connected) {
        await this.waitForStructuredTuiOwnerExit(owner)
        return 'exited'
      }
      if (this.structuredTuiStatus(owner) === 'idle') {
        return 'idle'
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return null
  }

  private stopStructuredSessionProcess(record: AgentSessionRecord): Promise<void> {
    return stopStructuredSessionProcess(record)
  }

  private structuredTuiStatus(owner: StructuredTuiOwner): 'idle' | 'busy' {
    const pty = this.ptysById.get(owner.terminal.ptyId)
    const paneKey = pty?.paneKey ?? owner.terminal.paneKey
    const explicit = this.getFreshExplicitAgentStatusForHandle(owner.terminal.handle, paneKey)
    if (explicit) {
      return explicit.status === 'idle' ? 'idle' : 'busy'
    }
    if (pty?.connected) {
      const text = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      const blocked = detectTerminalWaitBlockedReason(text) !== null
      if (!blocked && isKnownReadyPromptPreview(text)) {
        return 'idle'
      }
      return hasStructuredTuiIdleEvidence({
        blocked,
        status: pty.lastAgentStatus,
        statusObservedLive: pty.lastAgentStatusObservedLive
      })
        ? 'idle'
        : 'busy'
    }
    return 'busy'
  }

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: 'codex'
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    return this.agentClusterFacade.getStructuredAgentSessionCreateSupport(worktreeSelector, agent)
  }

  async resolveStructuredAgentSessionCreateIntent(input: {
    envelope: { sessionId: string; clientOperationId: string }
    worktree: string
    agent: 'codex'
  }): Promise<AgentSessionAttachParams> {
    return this.agentClusterFacade.resolveStructuredAgentSessionCreateIntent(input)
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    return this.agentClusterFacade.restoreStructuredAgentSessionTabs()
  }

  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    return this.agentClusterFacade.prepareStructuredAgentSessionStartupRestoration()
  }

  publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'codex'
    activate: boolean
    notify?: boolean
  }): void {
    return this.agentClusterFacade.publishStructuredAgentSessionTab(input)
  }

  private async resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    connectionId?: string
    localGitOptions?: { wslDistro?: string }
  }> {
    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = store.getRepo(worktree.repoId)
    const connectionId = repo?.connectionId ?? undefined
    const localGitOptions =
      repo && !connectionId ? getLocalProjectWorktreeGitOptions(store, repo) : {}
    return { worktree, repo, connectionId, localGitOptions }
  }

  private async resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
  }> {
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(worktreeSelector)
    if (folderScope?.folderWorkspace) {
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace),
        connectionId: folderScope.connectionId ?? undefined
      }
    }

    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = store.getRepo(worktree.repoId)
    return { worktree, connectionId: repo?.connectionId ?? undefined }
  }

  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void,
    clientNavigationId?: string
  ): () => void {
    return this.mobileSessionFacade.onMobileSessionTabsChanged(listener, clientNavigationId)
  }

  forgetClientNavigationState(clientNavigationId: string): void {
    this.clientSessionTabSelections.forgetClient(clientNavigationId)
  }

  // Why: terminal handles are normally created lazily when first referenced via
  // RPC, but agents need their own handle at spawn time (via ORCA_TERMINAL_HANDLE
  // env var) so they can self-identify in orchestration messages without an
  // extra RPC round-trip. Pre-allocating by ptyId lets issueHandle reuse it.
  preAllocateHandleForPty(ptyId: string): string {
    return this.ptyWorktrees.preAllocateHandleForPty(ptyId)
  }

  createPreAllocatedTerminalHandle(): string {
    return this.terminalClusterFacade.createPreAllocatedTerminalHandle()
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    return this.ptyWorktrees.registerPreAllocatedHandleForPty(ptyId, handle)
  }

  private adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    return this.terminalClusterFacade.adoptControllerTerminalHandle(
      ptyId,
      handle,
      incarnationId,
      options
    )
  }

  onPtySpawned(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    options: { awaitsRegistration?: boolean } = {}
  ): void {
    return this.ptyWorktrees.onPtySpawned(ptyId, incarnationId, options)
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
    return this.ptyWorktrees.registerPty(ptyId, worktreeId, connectionId, binding, isWsl)
  }

  assertPtyRegistrationAllowed(ptyId: string, incarnationId?: PtyIncarnationId): void {
    return this.ptyWorktrees.assertPtyRegistrationAllowed(ptyId, incarnationId)
  }

  releaseRejectedPtyRegistrationFence(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    return this.ptyWorktrees.releaseRejectedPtyRegistrationFence(ptyId, candidateIncarnation)
  }

  beginPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    return this.ptyWorktrees.beginPtyRegistration(ptyId, incarnationId)
  }

  acceptPtyIncarnationForExit(ptyId: string, incarnationId: PtyIncarnationId): void {
    return this.ptyWorktrees.acceptPtyIncarnationForExit(ptyId, incarnationId)
  }

  cancelPendingPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    return this.ptyWorktrees.cancelPendingPtyRegistration(ptyId, incarnationId)
  }

  private assertPtyDidNotExitBeforeRegistration(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    return this.ptyWorktrees.assertPtyDidNotExitBeforeRegistration(ptyId, candidateIncarnation)
  }

  preparePtyExecutionContext(
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean } = {}
  ): boolean {
    return this.ptyWorktrees.preparePtyExecutionContext(ptyId, wslDistro, options)
  }

  /** Record the spawn launch command so the per-PTY Command Code detector can
   *  arm from it (renderer startupCommand parity). Best-effort: a chunk that
   *  beats this call falls back to the detector's banner arming. */
  noteTerminalSpawnCommand(ptyId: string, command: string | null | undefined): void {
    return this.terminalClusterFacade.noteTerminalSpawnCommand(ptyId, command)
  }

  resetPtyModelAfterMigrationFailure(ptyId: string): void {
    return this.ptyWorktrees.resetPtyModelAfterMigrationFailure(ptyId)
  }

  /**
   * Handles incoming data from a PTY process, running agent detection,
   * updating terminal tail buffers, and triggering foreground agent refreshes.
   */
  acceptPtyDataBounded(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false,
    sourceRanges?: readonly TerminalOutputSourceRange[]
  ): RuntimePtyDataAdmission {
    return this.ptyWorktrees.acceptPtyDataBounded(
      ptyId,
      data,
      at,
      sequenceChars,
      transformed,
      sourceRanges
    )
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
    return this.ptyWorktrees.onPtyData(
      ptyId,
      data,
      at,
      sequenceChars,
      transformed,
      captureModelReceipt,
      sourceRanges
    )
  }

  private scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void {
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = { lastAt: 0, lastWaitState: null, appended: '', keywordCarry: '', timer: null }
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    const appendedLower = appendedText.toLowerCase()
    const keywordHit = WAIT_BLOCKED_KEYWORD_PATTERN.test(`${state.keywordCarry}${appendedLower}`)
    state.keywordCarry = appendedLower.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
    // Why the cap keeps the tail: the accumulated text only anchors boundary-
    // spanning prompt detection; anything past the tail cap has scrolled out
    // of the retained tail the check reads anyway.
    state.appended =
      state.appended.length + appendedText.length > MAX_TAIL_CHARS
        ? `${state.appended}${appendedText}`.slice(-MAX_TAIL_CHARS)
        : `${state.appended}${appendedText}`
    const elapsed = at - state.lastAt
    if (keywordHit || elapsed >= WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS || elapsed < 0) {
      this.runWaitBlockedCheck(ptyId, state, at)
      return
    }
    if (!state.timer) {
      // Why trailing edge: the final chunks of a burst must still be
      // evaluated or a prompt arriving right after a flood would go
      // unstamped until the next output.
      state.timer = setTimeout(() => {
        state.timer = null
        this.runWaitBlockedCheck(ptyId, state, Date.now())
      }, WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS - elapsed)
    }
  }

  private runWaitBlockedCheck(
    ptyId: string,
    state: {
      lastAt: number
      lastWaitState: TerminalTailWaitState | null
      appended: string
      keywordCarry: string
      timer: ReturnType<typeof setTimeout> | null
    },
    at: number
  ): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      state.appended = ''
      return
    }
    const nextWaitState = computeTerminalTailWaitState(
      pty.tailBuffer,
      pty.tailPartialLine,
      pty.preview
    )
    const previousWaitState = state.lastWaitState ?? {
      waitText: '',
      signal: null,
      fromTail: false
    }
    if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, state.appended)) {
      pty.waitBlockedAt = at
      this.recordAgentPromptPermissionObservation(ptyId)
    }
    state.lastAt = at
    state.lastWaitState = nextWaitState
    state.appended = ''
  }

  // Why: the scanner's first run after a restore seed compares against a null
  // baseline, so a permission prompt visible only in seeded HISTORY would read
  // as newly gained and stamp waitBlockedAt "now" on the next benign chunk.
  // Store the seeded tail's wait state as the baseline WITHOUT stamping; only
  // a signal that appears in genuinely new output counts as gained.
  private primeWaitBlockedBaselineFromSeededTail(ptyId: string): void {
    return this.terminalClusterFacade.primeWaitBlockedBaselineFromSeededTail(ptyId)
  }

  private clearWaitBlockedCheckState(ptyId: string): void {
    const state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.waitBlockedCheckStateByPtyId.delete(ptyId)
  }

  private processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    return this.agentClusterFacade.processAgentStatusOscForPty(ptyId, data)
  }

  /** Emit the facts batched while applying one chunk/frame as a single
   *  pty:sideEffect batch, preserving byte order. */
  private flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void {
    return this.terminalClusterFacade.flushPendingTerminalSideEffectFacts(ptyId, entry)
  }

  /** Feed a main-fabricated OSC title/BEL frame (agent hook spinners) through
   *  the per-PTY tracker — NOT onPtyData, so emulator state, tails,
   *  transcripts, and stats never see synthetic bytes. Parsed via the
   *  tracker's stateless synthetic path: the shared chunk bell detector must
   *  never observe fabricated bytes, or a tick interleaved with a split real
   *  OSC corrupts its escape state (phantom/swallowed bells). While the
   *  side-effect kill switch is off the legacy pty:data copy still drives
   *  renderer parsers; this ingest keeps main's facts and records
   *  authoritative. */
  ingestSyntheticTitleFrame(ptyId: string, data: string): void {
    return this.terminalClusterFacade.ingestSyntheticTitleFrame(ptyId, data)
  }

  /** Scan-authority handoff for a backgrounded PTY (daemon keep-tail
   *  thinning): while delegated, the daemon relays bell/133/pr-link/2031
   *  facts itself and the delivered bytes may be gapped — feeding them to
   *  main's transient scanners would mint phantom or duplicate facts. Title
   *  processing stays main-side either way. */
  setPtyTransientFactDelegation(
    ptyId: string,
    delegated: boolean,
    scanSeedAnsi?: string,
    mode2031PendingSubscribe?: true
  ): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.tracker.setTransientFactScanningSuppressed(delegated)
    if (!delegated && scanSeedAnsi) {
      // Prime the freshly reset scanner carry with the emulator's dangling
      // incomplete escape at the handoff position — a sequence split across
      // the un-background toggle must not mint a phantom bell or lose its
      // fact. titleScanData:'' keeps titles out (they were never suppressed).
      entry.tracker.handleChunk(scanSeedAnsi, {
        titleScanData: '',
        mode2031PendingSubscribe
      })
    }
  }

  /** A transient fact the daemon detected while it held scan authority —
   *  emitted through the same fact channel as byte-scanned facts. Arrives
   *  between chunks, so recordTerminalSideEffectFact emits it immediately. */
  emitDaemonPtyTransientFact(ptyId: string, fact: PtyTransientFact): void {
    switch (fact.kind) {
      case 'bell':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        return
      case 'command-finished':
        this.retirePtyAgentLaunchAuthority(ptyId)
        this.recordTerminalSideEffectFact(ptyId, {
          kind: 'command-finished',
          exitCode: fact.exitCode
        })
        return
      case 'pr-link':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link: fact.link })
        return
      case '2031-subscribe':
        this.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
        return
      case '2031-unsubscribe':
        this.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
    }
  }

  /** The daemon keep-tail dropped this PTY's oldest undelivered output; the
   *  next delivered chunk is discontinuous. Reset every cross-chunk parse
   *  carry so a half-open escape from before the gap cannot corrupt what
   *  follows, and drop the mobile headless mirror — it rebuilds from the
   *  delivered tail / snapshot seeds instead of parsing a gapped stream. */
  notePtyDataGap(ptyId: string, droppedChars = 0): void {
    return this.ptyWorktrees.notePtyDataGap(ptyId, droppedChars)
  }

  /** Record one derived side-effect fact: batched per chunk while applying
   *  bytes, emitted immediately for between-chunk facts (stale-title timer). */
  private recordTerminalSideEffectFact(ptyId: string, fact: TerminalSideEffectFact): void {
    return this.terminalClusterFacade.recordTerminalSideEffectFact(ptyId, fact)
  }

  /** Title-only replay batch for renderer (re)attach — the no-attention-replay
   *  rule: snapshots restore title state, never historical bells/completions. */
  getTerminalSideEffectSnapshot(ptyId: string): TerminalSideEffectBatch | null {
    return this.terminalClusterFacade.getTerminalSideEffectSnapshot(ptyId)
  }

  /** Raw last title from main's tracked PTY/leaf records — the title surface
   *  the tracker (live bytes + synthetic frames) keeps current. */

  // PTY title tracking methods delegated to ptyTitleTrackingCommands facade
  private getTrackedRawTitleForPty = (ptyId: string): string | null =>
    this.ptyTitleTrackingCommands.getTrackedRawTitleForPty(ptyId)

  private isLiveCursorNativeTitle = (rawTitle: string, meta?: TerminalTitleFactMeta): boolean =>
    this.ptyTitleTrackingCommands.isLiveCursorNativeTitle(rawTitle, meta)

  private getTrackedDisplayTitleForPty = (ptyId: string): string | null =>
    this.ptyTitleTrackingCommands.getTrackedDisplayTitleForPty(ptyId)

  private getUnpersistedTrackedTitleForPty = (ptyId: string | null): string | null =>
    this.ptyTitleTrackingCommands.getUnpersistedTrackedTitleForPty(ptyId)

  private preferTrackedLastTitle = <T extends { lastTitle?: string }>(
    ptyId: string,
    snapshot: T
  ): T => this.ptyTitleTrackingCommands.preferTrackedLastTitle(ptyId, snapshot)

  private makeDecorativeTitleGateKey = (rawTitle: string, normalizedTitle: string): string =>
    this.ptyTitleTrackingCommands.makeDecorativeTitleGateKey(rawTitle, normalizedTitle)

  private getOrCreatePtyTitleTrackerEntry = (ptyId: string) =>
    this.ptyTitleTrackingCommands.getOrCreatePtyTitleTrackerEntry(ptyId)

  private applyTrackedPtyTitle = (
    ptyId: string,
    rawTitle: string,
    normalizedTitle: string,
    meta?: TerminalTitleFactMeta
  ): boolean =>
    this.ptyTitleTrackingCommands.applyTrackedPtyTitle(ptyId, rawTitle, normalizedTitle, meta)

  private disposePtyTitleTracker = (ptyId: string): void =>
    this.ptyTitleTrackingCommands.disposePtyTitleTracker(ptyId)

  private resetTrackedTerminalStateForProviderGeneration = (ptyId: string): void =>
    this.ptyTitleTrackingCommands.resetTrackedTerminalStateForProviderGeneration(ptyId)

  private setTerminalSideEffectConsumerAvailable = (available: boolean): void =>
    this.ptyTitleTrackingCommands.setTerminalSideEffectConsumerAvailable(available)

  private refreshTerminalSideEffectConsumerAvailability = (): void =>
    this.ptyTitleTrackingCommands.refreshTerminalSideEffectConsumerAvailability()

  private createTerminalSideEffectCommandCodeDetector = (ptyId: string) =>
    this.ptyTitleTrackingCommands.createTerminalSideEffectCommandCodeDetector(ptyId)

  private extractLastOsc7CwdForPty = (
    ptyId: string,
    data: string
  ): { path: string; hostname: string } | null =>
    this.ptyTitleTrackingCommands.extractLastOsc7CwdForPty(ptyId, data)

  private recordOsc7MetadataForPty = (
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean } =>
    this.ptyTitleTrackingCommands.recordOsc7MetadataForPty(ptyId, data)

  private pathFlavorForPty = (pty?: RuntimePtyWorktreeRecord | null): 'posix' | 'win32' =>
    this.ptyTitleTrackingCommands.pathFlavorForPty(pty)

  // Terminal agent status binding methods delegated to terminalAgentStatusBinding facade
  private getTerminalAgentStatusPtyId = (handle: string): string =>
    this.terminalAgentStatusBinding.getTerminalAgentStatusPtyId(handle)

  private assertTerminalAgentStatusPtyBinding = (handle: string, expectedPtyId: string): void =>
    this.terminalAgentStatusBinding.assertTerminalAgentStatusPtyBinding(handle, expectedPtyId)

  private getTerminalAgentStatusSnapshot = (
    handle: string,
    expectedPtyId: string,
    waitTextOverride?: string
  ) =>
    this.terminalAgentStatusBinding.getTerminalAgentStatusSnapshot(
      handle,
      expectedPtyId,
      waitTextOverride
    )

  private probeAgentStatusOncePerPty = (
    handle: string,
    ptyId: string
  ): Promise<RuntimeTerminalAgentStatus | undefined> =>
    this.terminalAgentStatusBinding.probeAgentStatusOncePerPty(handle, ptyId)

  private shouldDelayPtyBackedMobileSnapshotForForegroundAgent = (
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean =>
    this.terminalAgentStatusBinding.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(pty, title)

  resolveTerminalSplitSourceAuthority(handle: string) {
    return this.terminalClusterFacade.resolveTerminalSplitSourceAuthorityLegacy(handle)
  }

  getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    return this.terminalClusterFacade.getTerminalInteractiveWait(handle)
  }

  private refreshPtyForegroundAgent = (ptyId: string): void =>
    this.terminalAgentStatusBinding.refreshPtyForegroundAgent(ptyId)

  private getPendingForegroundAgentRefreshForTitle = (
    ptyId: string,
    titleObservedAt: number
  ): Promise<boolean> | undefined =>
    this.terminalAgentStatusBinding.getPendingForegroundAgentRefreshForTitle(ptyId, titleObservedAt)

  private delayPtyBackedMobileSnapshotForForegroundAgent = (
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ): void =>
    this.terminalAgentStatusBinding.delayPtyBackedMobileSnapshotForForegroundAgent(
      ptyId,
      titleObservedAt,
      foregroundRefresh
    )

  private refreshPtyForegroundAgentFromController = (
    ptyId: string,
    options?: { afterTitleObservation?: number }
  ): Promise<boolean> =>
    this.terminalAgentStatusBinding.refreshPtyForegroundAgentFromController(ptyId, options)

  private hasAuthoritativeTerminalWaitPermission = (
    terminal: TerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): boolean =>
    this.terminalAgentStatusBinding.hasAuthoritativeTerminalWaitPermission(
      terminal,
      explicitStatus,
      lifecycle
    )

  private resolveAuthoritativeTerminalWaitPermission = (
    terminal: TerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ) =>
    this.terminalAgentStatusBinding.resolveAuthoritativeTerminalWaitPermission(
      terminal,
      explicitStatus,
      lifecycle
    )

  private readPtyForegroundProcessFromController = (
    ptyId: string,
    afterTitleObservation?: number
  ) =>
    this.terminalAgentStatusBinding.readPtyForegroundProcessFromController(
      ptyId,
      afterTitleObservation
    )

  /** Returns true when any retained agent-row snapshot changed in a
   *  client-visible way, so the caller can republish session snapshots. */
  private emitTerminalAgentStatusEvents(ptyId: string, chunk: ProcessedAgentStatusChunk): boolean {
    return this.agentClusterFacade.emitTerminalAgentStatusEvents(ptyId, chunk)
  }

  private clearAgentRowSnapshotsForPty(ptyId: string): void {
    return this.agentClusterFacade.clearAgentRowSnapshotsForPty(ptyId)
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.terminalClusterFacade.getPtyOutputSequence(ptyId)
  }

  private recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void {
    return this.agentClusterFacade.recordAgentPromptLifecycleState(ptyId, status)
  }

  private recordAgentPromptPermissionObservation(ptyId: string): void {
    return this.agentClusterFacade.recordAgentPromptPermissionObservation(ptyId)
  }

  private restoreAgentPromptLifecycleByteOrder(
    ptyId: string,
    titleInput: string,
    lastPayloadTitleOffset: number | null
  ): void {
    return this.agentClusterFacade.restoreAgentPromptLifecycleByteOrder(
      ptyId,
      titleInput,
      lastPayloadTitleOffset
    )
  }

  private getPtyLifecycleGeneration(ptyId: string): number {
    return this.terminalClusterFacade.getPtyLifecycleGeneration(ptyId)
  }

  synchronizePtyOutputSequenceFromProvider(
    ptyId: string,
    providerSequence: { value: number; generation: 'continued' | 'reset' },
    runtimeSequenceAtSpawnStart = 0
  ): number {
    return this.ptyWorktrees.synchronizePtyOutputSequenceFromProvider(
      ptyId,
      providerSequence,
      runtimeSequenceAtSpawnStart
    )
  }

  subscribeToTerminalData(
    ptyId: string,
    listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
  ): () => void {
    return this.terminalClusterFacade.subscribeToTerminalData(ptyId, listener)
  }

  setRemoteTerminalSourceRangeConsumerHooks(
    hooks: RemoteTerminalSourceRangeConsumerHooks | null
  ): void {
    return this.terminalClusterFacade.setRemoteTerminalSourceRangeConsumerHooks(hooks)
  }

  attachRemoteTerminalSourceRangeConsumer(
    identity: RemoteTerminalSourceRangeStreamIdentity
  ): boolean {
    return this.terminalClusterFacade.attachRemoteTerminalSourceRangeConsumer(identity)
  }

  settleRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[]
  ): void {
    return this.terminalClusterFacade.settleRemoteTerminalSourceRanges(identity, ranges)
  }

  reserveRemoteTerminalSourceRangeReplacement(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    requiredSeq: number,
    reason: string
  ): RemoteTerminalSourceRangeReplacementReservation | null {
    return this.terminalClusterFacade.reserveRemoteTerminalSourceRangeReplacement(
      identity,
      requiredSeq,
      reason
    )
  }

  commitRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    publication: RemoteTerminalSourceRangeReplacementPublication
  ): boolean {
    return this.terminalClusterFacade.commitRemoteTerminalSourceRangeReplacement(
      reservation,
      publication
    )
  }

  rollbackRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    reason: string
  ): boolean {
    return this.terminalClusterFacade.rollbackRemoteTerminalSourceRangeReplacement(
      reservation,
      reason
    )
  }

  cancelRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[],
    reason: string
  ): void {
    return this.terminalClusterFacade.cancelRemoteTerminalSourceRanges(identity, ranges, reason)
  }

  /** Set by pty IPC: fires when a PTY gains/loses remote view subscribers so
   *  the daemon background mark (keep-tail stream thinning) can resync — a
   *  live mobile/web view consumes raw bytes and must never be thinned, even
   *  while the desktop pane is hidden. */
  onRemoteTerminalViewPresenceChanged: ((ptyId: string) => void) | null = null

  private notifyRemoteTerminalViewPresenceChanged(ptyId: string): void {
    return this.terminalClusterFacade.notifyRemoteTerminalViewPresenceChanged(ptyId)
  }

  /** Registered by terminal-RPC subscribe/multiplex streams: while a remote
   *  view subscriber is attached its xterm answers queries with view
   *  authority and the model responder must stay silent. Returns an
   *  idempotent release. */
  registerRemoteTerminalViewSubscriber(ptyId: string): () => void {
    return this.terminalClusterFacade.registerRemoteTerminalViewSubscriber(ptyId)
  }

  /** A local daemon session main knows is live but has never ingested a byte
   *  from — i.e. no pane ever attached it, so the daemon is not emitting.
   *  Headless state exists only after the first ingested byte; a snapshot
   *  reconcile in flight implies a spawn-path attach already happened. */
  private isKnownUnattachedLocalDaemonPty(ptyId: string): boolean {
    return this.ptyWorktrees.isKnownUnattachedLocalDaemonPty(ptyId)
  }

  /** First remote view subscriber of a never-attached local daemon session:
   *  have main attach so output starts flowing. Attach-only (never spawns),
   *  no resize, no renderer mount/focus — works headless. Releases never
   *  detach: continued ingestion is the point, and daemon detach is stubbed. */
  private ensureSubscriberDrivenProviderAttach(ptyId: string): void {
    return this.terminalClusterFacade.ensureSubscriberDrivenProviderAttach(ptyId)
  }

  private reconcileSubscriberDrivenProviderAttach(ptyId: string): void {
    if (!this.hasRemoteTerminalViewSubscriber(ptyId)) {
      return
    }
    const pending = this.subscriberDrivenProviderAttachesByPtyId.get(ptyId)
    if (!pending) {
      this.ensureSubscriberDrivenProviderAttach(ptyId)
      return
    }
    if (this.subscriberDrivenProviderAttachInventoryWaiters.has(ptyId)) {
      return
    }
    this.subscriberDrivenProviderAttachInventoryWaiters.add(ptyId)
    void pending.then((attached) => {
      this.subscriberDrivenProviderAttachInventoryWaiters.delete(ptyId)
      if (attached || !this.hasRemoteTerminalViewSubscriber(ptyId)) {
        return
      }
      if (this.subscriberDrivenProviderAttachesByPtyId.get(ptyId) === pending) {
        this.subscriberDrivenProviderAttachesByPtyId.delete(ptyId)
      }
      this.ensureSubscriberDrivenProviderAttach(ptyId)
    })
  }

  /** Mark a raw-output viewer without transferring terminal query authority. */
  registerRawTerminalViewSubscriber(ptyId: string): () => void {
    return this.terminalClusterFacade.registerRawTerminalViewSubscriber(ptyId)
  }

  /** Raw stream presence prevents provider thinning without changing reply ownership. */
  hasRawTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalClusterFacade.hasRawTerminalViewSubscriber(ptyId)
  }

  hasRemoteTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalClusterFacade.hasRemoteTerminalViewSubscriber(ptyId)
  }

  isMobileTerminalQueryReplyAuthority(ptyId: string, clientId: string): boolean {
    return this.terminalClusterFacade.isMobileTerminalQueryReplyAuthority(ptyId, clientId)
  }

  subscribeToFitOverrideChanges(
    ptyId: string,
    listener: (event: {
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }) => void
  ): () => void {
    return this.terminalClusterFacade.subscribeToFitOverrideChanges(ptyId, listener)
  }

  subscribeToDriverChanges(ptyId: string, listener: (driver: DriverState) => void): () => void {
    return addListenerToMap(this.driverListeners, ptyId, listener)
  }

  private notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void {
    return this.terminalClusterFacade.notifyFitOverrideListeners(ptyId, mode, cols, rows)
  }

  serializeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    return this.terminalClusterFacade.serializeTerminalBuffer(ptyId, opts)
  }

  async serializeAuthoritativeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    return this.terminalClusterFacade.serializeAuthoritativeTerminalBuffer(ptyId, opts)
  }

  /** Raw keystroke pass-through for the pop-out dashboard's terminal preview.
   *  Honors the mobile-presence lock like the main window's pty:write path. */
  async writeTerminalPreviewInput(ptyId: string, data: string): Promise<boolean> {
    return this.terminalClusterFacade.writeTerminalPreviewInput(ptyId, data)
  }

  hasHeadlessTerminalState(ptyId: string): boolean {
    return this.terminalClusterFacade.hasHeadlessTerminalState(ptyId)
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
    return this.terminalClusterFacade.serializeMainTerminalBuffer(ptyId, opts)
  }

  async serializeHiddenOutputRecoveryBuffer(
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
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, {
      ...opts,
      includeEmpty: true
    })
    if (headlessSnapshot) {
      return headlessSnapshot
    }
    // Why: hidden-output recovery is initiated by the desktop renderer. If the
    // runtime has not built headless state yet, the mounted xterm is still the
    // best available state and avoids a false "snapshot unavailable" result.
    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    return rendererSnapshot ?? this.serializeProviderTerminalBuffer(ptyId, opts)
  }

  async clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    return this.terminalClusterFacade.clearTerminalBuffer(handle)
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.terminalClusterFacade.getTerminalSize(ptyId)
  }

  // Why: a width reflow on a normal-buffer PTY must re-stream the full
  // scrollback to mobile so it rewraps at the new cols, but alternate-screen
  // TUIs (vim, Claude Code) own their repaint and have no scrollback — for
  // those the mobile client just resizes xterm geometry and consumes the
  // TUI's own redraw, so the resize re-stream must be skipped. Provider state
  // covers restored PTYs whose main-side emulator is only a partial suffix.
  isTerminalAlternateScreen(ptyId: string): boolean {
    return this.terminalClusterFacade.isTerminalAlternateScreen(ptyId)
  }

  // Why: daemon-backed PTYs that the runtime adopted after an Orca relaunch
  // start with a fresh headless emulator that has zero scrollback, even though
  // the daemon's on-disk checkpoint and the desktop xterm both contain the
  // full prior history. Without this hydration, mobile subscribers see only
  // the bare current prompt because serializeHeadlessTerminalBuffer always
  // wins over the renderer-path fallback. Seeding the emulator with the
  // adapter's snapshot/cold-restore data makes mobile and desktop agree on
  // what scrollback is available.
  seedHeadlessTerminal(
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata: HeadlessSeedMetadata = {}
  ): void {
    return this.terminalClusterFacade.seedHeadlessTerminal(ptyId, data, size, metadata)
  }

  // Why: reattach/cold-restore/replay payloads arrive as spawn RPC results and
  // never pass through onPtyData, so after a relaunch the records backing
  // `terminal list`/`terminal read` stayed blank while the session was alive.
  // Seed semantics (applySeededAgentStatus precedent): write state only — no
  // waiters, no orchestration events, and no lastOutputAt, because restored
  // bytes are historical output, not fresh activity.
  seedTerminalRestoreTail(ptyId: string, restore: { text?: string; lastTitle?: string }): void {
    return this.terminalClusterFacade.seedTerminalRestoreTail(ptyId, restore)
  }

  // Why: hydrate the runtime headless emulator from the desktop renderer's
  // xterm buffer on the first onPtyData byte after a PTY is taken over by a
  // pane. Eager-state pattern matches seedHeadlessTerminal: headlessTerminals
  // is populated synchronously so concurrent live writes from
  // trackHeadlessTerminalData chain after the seed via the same writeChain.
  // See docs/mobile-prefer-renderer-scrollback.md.
  private maybeHydrateHeadlessFromRenderer(ptyId: string): void {
    return this.mobileTabOperations.maybeHydrateHeadlessFromRenderer(ptyId)
  }

  // Why: seed-derived agent status reflects historical state. Orchestration
  // waiters (resolveTuiIdleWaiters, deliverPendingMessages) must only react
  // to LIVE transitions, so this helper writes leaf.lastAgentStatus only,
  // leaves lastAgentStatusObservedLive untouched, and never resolves waiters.
  // detectAgentStatusFromTitle wrap mirrors the live path so seeded and live
  // values are the same union member, keeping downstream `=== 'idle'` checks
  // correct.
  private applySeededAgentStatus(ptyId: string, title: string): void {
    return this.agentClusterFacade.applySeededAgentStatus(ptyId, title)
  }

  /** Per-chunk reply-ownership capture (Phase 5). Evaluated synchronously at
   *  ingestion only — never re-read at reply time. */
  private shouldAnswerQueriesForLiveChunk(ptyId: string): boolean {
    return shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: this.store?.getSettings(),
      hasRemoteViewSubscriber: this.hasRemoteTerminalViewSubscriber(ptyId)
    })
  }

  private trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): Promise<void> {
    return this.terminalClusterFacade.trackHeadlessTerminalData(
      ptyId,
      data,
      outputSequence,
      forwardQueryReplies
    )
  }

  /** Phase-5 ConPTY DA1 retrofit (terminal-query-authority.md): invoked via
   *  markNativeWindowsConptyPty when the spawn mark lands after daemon stream
   *  data already created this PTY's emulator. Idempotent emulator-side. */
  private ensureNativeWindowsConptyDa1Override(ptyId: string): void {
    if (isNativeWindowsConptyPty(ptyId)) {
      this.headlessTerminals.get(ptyId)?.emulator.installConptyPrimaryDeviceAttributesOverride()
    }
  }

  private replaceHeadlessTerminalAfterExecutionContextChange(ptyId: string): void {
    return this.terminalClusterFacade.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
  }

  private resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    return this.terminalClusterFacade.resizeHeadlessTerminal(ptyId, cols, rows)
  }

  // Public: desktop-initiated clears (ipc/pty.ts) must also drop this mobile
  // mirror or a resubscribing mobile client resurrects the cleared scrollback.
  async clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    return this.terminalClusterFacade.clearHeadlessTerminalBuffer(ptyId)
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
    return this.terminalClusterFacade.serializeRendererTerminalBuffer(ptyId, opts)
  }

  private async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    return this.terminalClusterFacade.serializeProviderTerminalBuffer(ptyId, opts, wait)
  }

  private async readProviderTerminalTailLines(
    ptyId: string,
    limit: number | undefined,
    snapshotOptions: ProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalProjection> {
    return this.terminalClusterFacade.readProviderTerminalTailLines(ptyId, limit, snapshotOptions)
  }

  private async readVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    return this.terminalClusterFacade.readVisibleTerminalState(ptyId)
  }

  private async serializeHeadlessTerminalBuffer(
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
    return this.terminalClusterFacade.serializeHeadlessTerminalBuffer(ptyId, opts)
  }

  private disposeHeadlessTerminal(ptyId: string): void {
    return this.mobileTabOperations.disposeHeadlessTerminal(ptyId)
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    return this.terminalClusterFacade.resolveLeafForHandle(handle)
  }

  // Why: remote clients hold handles across transport reconnects. A handle
  // minted for a concrete PTY must never silently adopt a different PTY that
  // later occupies the same pane — that misroutes keystrokes (#7718). Handles
  // still awaiting their first PTY (ptyId null) may adopt it, which preserves
  // the mobile pre-spawn subscribe flow.
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    return this.terminalClusterFacade.resolveLiveLeafForHandle(handle)
  }

  getOrchestrationCompatibilityHostId(): 'local' {
    return 'local'
  }

  registerOrchestrationCompatibilitySshAttachment(
    targetId: string,
    connectionIncarnation: string
  ): OrchestrationCompatibilitySshAttachmentAuthority {
    const authority = Object.freeze({
      kind: 'ssh' as const,
      targetId,
      connectionIncarnation,
      attachmentId: randomUUID()
    })
    this.orchestrationCompatibilitySshAttachments.set(authority.attachmentId, authority)
    return authority
  }

  releaseOrchestrationCompatibilitySshAttachment(attachmentId: string): void {
    this.orchestrationCompatibilitySshAttachments.delete(attachmentId)
  }

  verifyOrchestrationCompatibilityCaller(
    evidence: OrchestrationCompatibilityEvidence | null | undefined,
    options?: { currentRuntimeLaunchSufficient?: boolean }
  ): OrchestrationCompatibilityCallerAuthority | null {
    return verifyCompatibilityCallerFn(this, evidence, options)
  }

  private getOrchestrationCompatibilityHostScope(
    pty: RuntimePtyWorktreeRecord
  ): OrchestrationCompatibilityTerminalAuthority['hostScope'] | null {
    return this.orchestrationCommands.getOrchestrationCompatibilityHostScope(pty)
  }

  private rememberRestoredOrchestrationAuthority(
    pty: RuntimePtyWorktreeRecord,
    terminalHandle: string,
    incarnationId: string
  ): void {
    return this.orchestrationCommands.rememberRestoredOrchestrationAuthority(
      pty,
      terminalHandle,
      incarnationId
    )
  }

  getOrchestrationDispatchAuthority(
    terminalHandle: string
  ): OrchestrationCompatibilityTerminalAuthority | null {
    let ptyId: string | null
    try {
      ptyId =
        this.getLivePtyForHandle(terminalHandle)?.pty.ptyId ??
        this.resolveLiveLeafForHandle(terminalHandle)?.ptyId ??
        null
    } catch {
      return null
    }
    if (!ptyId) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return null
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!hostScope) {
      return null
    }
    return {
      runtimeId: this.runtimeId,
      terminalHandle,
      ptyId,
      worktreeId: pty.worktreeId,
      processIncarnation: this.getTerminalProcessIncarnation(terminalHandle),
      paneKey: pty.paneKey,
      launchTokenHash: pty.launchToken
        ? createHash('sha256').update(pty.launchToken).digest('hex')
        : null,
      hostScope
    }
  }

  private retirePtyAgentLaunchAuthority(ptyId: string): void {
    return this.agentClusterFacade.retirePtyAgentLaunchAuthority(ptyId)
  }

  async resolveTerminalCwd(handle: string): Promise<string | null> {
    return this.terminalClusterFacade.resolveTerminalCwd(handle)
  }

  resolveTerminalFileUriHostname(handle: string): string | null {
    return this.terminalClusterFacade.resolveTerminalFileUriHostname(handle)
  }

  private recordRecentPtyOutputForPathProvenance(ptyId: string, data: string): void {
    return this.terminalClusterFacade.recordRecentPtyOutputForPathProvenance(ptyId, data)
  }

  activateRecentPtyPathCandidateTracking(): void {
    return this.terminalClusterFacade.activateRecentPtyPathCandidateTracking()
  }

  resolveTerminalContext(
    handle: string
  ): { worktreeId: string; connectionId: string | null } | null {
    return this.terminalClusterFacade.resolveTerminalContext(handle)
  }

  // Why: remote clients cannot resolve this runtime's WSL project preference,
  // so host-affecting RPCs (skill discovery) resolve it from the owning store.
  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.managedWorktrees.resolveProjectRuntimeForWorktree(worktreeId)
  }

  getTerminalOrchestrationCliCommand(handle: string): 'orca' | 'orca-ide' {
    return this.terminalClusterFacade.getTerminalOrchestrationCliCommand(handle)
  }

  hasRecentTerminalOutputPath(handle: string, pathText: string, absolutePath: string): boolean {
    return this.terminalClusterFacade.hasRecentTerminalOutputPath(handle, pathText, absolutePath)
  }

  registerSubscriptionCleanup(
    subscriptionId: string,
    cleanup: () => void | Promise<void>,
    connectionId?: string
  ): void {
    // Why: mobile clients reconnect frequently (phone lock, network switch).
    // The RPC client re-sends terminal.subscribe on reconnect, creating a new
    // handler before the old one is cleaned up. Without this, the old data
    // listener leaks in dataListeners and duplicates every PTY data event.
    const existing = this.subscriptionCleanups.get(subscriptionId)
    if (existing) {
      // Why: the stable id is about to belong to a newer connection; detach
      // the old owner before its asynchronous cleanup can overlap the rebind.
      this.removeSubscriptionConnectionIndex(subscriptionId)
      // Why: evict by the owner we captured, never by the key — a keyed evict
      // would resolve to whoever holds the id at call time.
      this.cleanupOwnedSubscription(subscriptionId, existing)
    }
    this.subscriptionCleanups.set(subscriptionId, cleanup)
    if (connectionId) {
      let set = this.subscriptionsByConnection.get(connectionId)
      if (!set) {
        set = new Set()
        this.subscriptionsByConnection.set(connectionId, set)
      }
      set.add(subscriptionId)
      this.subscriptionConnectionByEntry.set(subscriptionId, connectionId)
    }
  }

  // Why: teardown keyed only by a string tears down whoever owns that key *now*.
  // A mobile reconnect rebinds the stable `${terminal}:${clientId}` id, so a late
  // teardown from the dead connection would kill the replacement stream (STA-4510).
  // Callers that own a registration must go through this handle instead.
  registerOwnedSubscriptionCleanup(
    subscriptionId: string,
    cleanup: () => void | Promise<void>,
    connectionId?: string
  ): SubscriptionRegistration {
    this.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
    return {
      releaseIfCurrent: () => this.cleanupOwnedSubscription(subscriptionId, cleanup)
    }
  }

  cleanupSubscription(subscriptionId: string): void {
    void this.cleanupSubscriptionAndWait(subscriptionId).catch((error) => {
      console.error(`[runtime] subscription cleanup failed for ${subscriptionId}:`, error)
    })
  }

  // Why: a client-supplied unsubscribe names a stable id it may no longer own — a
  // reconnect or make-before-break migration rebinds that id to a newer connection,
  // and honoring the stale message would kill the live stream (STA-4510).
  // Returns whether the subscription was actually torn down.
  cleanupSubscriptionIfOwnedByConnection(
    subscriptionId: string,
    connectionId: string | undefined
  ): boolean {
    // Why: an absent connectionId means a connection-less caller — the local
    // unix-socket dispatch path, gated by the 0o600 metadata token. That tier keeps
    // unconditional teardown authority; this guard scopes socket clients only.
    if (!connectionId) {
      this.cleanupSubscription(subscriptionId)
      return true
    }
    // Why: an id with no registration is already gone, not a refusal. Reporting
    // false there would tell a retrying client to keep chasing a dead id.
    if (!this.subscriptionCleanups.has(subscriptionId)) {
      return true
    }
    if (this.subscriptionConnectionByEntry.get(subscriptionId) !== connectionId) {
      return false
    }
    this.cleanupSubscription(subscriptionId)
    return true
  }

  private cleanupOwnedSubscription(
    subscriptionId: string,
    expectedCleanup: () => void | Promise<void>
  ): void {
    // Why: the ownership check is synchronous and cleanupSubscriptionAndWait re-reads
    // the map before its first await, so nothing can rebind in between. Delegating
    // preserves the in-flight join, the retain-on-failure, and the retry contract.
    if (this.subscriptionCleanups.get(subscriptionId) !== expectedCleanup) {
      return
    }
    this.cleanupSubscription(subscriptionId)
  }

  retrySubscriptionCleanupAfter(
    subscriptionId: string,
    cleanupOwner: () => void | Promise<void>,
    gate: Promise<void>
  ): void {
    const failedGeneration = this.subscriptionCleanupPromises.get(subscriptionId)
    void gate.then(
      async () => {
        await (failedGeneration?.cleanup === cleanupOwner
          ? failedGeneration.promise.catch(() => undefined)
          : undefined)
        while (this.subscriptionCleanups.get(subscriptionId) === cleanupOwner) {
          const newerGeneration = this.subscriptionCleanupPromises.get(subscriptionId)
          if (newerGeneration?.cleanup === cleanupOwner) {
            // Why: a caller may already be retrying this owner; wait for that
            // exact generation so a rejected join cannot consume our retry.
            await newerGeneration.promise.catch(() => undefined)
            continue
          }
          this.cleanupSubscription(subscriptionId)
          return
        }
      },
      () => undefined
    )
  }

  async cleanupSubscriptionAndWait(subscriptionId: string): Promise<void> {
    const cleanup = this.subscriptionCleanups.get(subscriptionId)
    if (!cleanup) {
      return
    }
    const inFlight = this.subscriptionCleanupPromises.get(subscriptionId)
    if (inFlight?.cleanup === cleanup) {
      return inFlight.promise
    }
    let cleanupResult: void | Promise<void>
    try {
      cleanupResult = cleanup()
    } catch (error) {
      cleanupResult = Promise.reject(error)
    }
    const promise = Promise.resolve(cleanupResult)
      .then(() => {
        // Why: a reconnect can replace this id while old async cleanup runs;
        // only the generation that registered this callback may remove it.
        if (this.subscriptionCleanups.get(subscriptionId) !== cleanup) {
          return
        }
        this.subscriptionCleanups.delete(subscriptionId)
        this.removeSubscriptionConnectionIndex(subscriptionId)
      })
      .finally(() => {
        if (this.subscriptionCleanupPromises.get(subscriptionId)?.promise === promise) {
          this.subscriptionCleanupPromises.delete(subscriptionId)
        }
      })
    this.subscriptionCleanupPromises.set(subscriptionId, { cleanup, promise })
    return promise
  }

  private removeSubscriptionConnectionIndex(subscriptionId: string): void {
    const connectionId = this.subscriptionConnectionByEntry.get(subscriptionId)
    if (connectionId) {
      this.subscriptionConnectionByEntry.delete(subscriptionId)
      const set = this.subscriptionsByConnection.get(connectionId)
      if (set) {
        set.delete(subscriptionId)
        if (set.size === 0) {
          this.subscriptionsByConnection.delete(connectionId)
        }
      }
    }
  }

  cleanupSubscriptionsByPrefix(prefix: string): void {
    const ids = Array.from(this.subscriptionCleanups.keys()).filter((id) => id.startsWith(prefix))
    for (const id of ids) {
      this.cleanupSubscription(id)
    }
  }

  // Why: invoked from the WebSocket transport's on-close hook so streaming
  // listeners registered for this exact socket get torn down even when other
  // sockets sharing the same deviceToken are still alive (multi-screen
  // mobile). Without this sweep, listeners leak across every reconnect.
  cleanupSubscriptionsForConnection(connectionId: string): void {
    const set = this.subscriptionsByConnection.get(connectionId)
    if (!set) {
      return
    }
    // Why: snapshot the ids before iterating because cleanupSubscription
    // mutates both the set and the index map.
    const ids = Array.from(set)
    for (const id of ids) {
      if (this.subscriptionConnectionByEntry.get(id) !== connectionId) {
        set.delete(id)
        continue
      }
      this.cleanupSubscription(id)
    }
    if (set.size === 0) {
      this.subscriptionsByConnection.delete(connectionId)
    }
  }

  // Why: mobile clients subscribe via notifications.subscribe streaming RPC.
  // Each subscriber gets its own listener. Returns an unsubscribe function
  // that the subscription cleanup mechanism calls on disconnect.
  onNotificationDispatched(listener: (event: MobileNotificationEvent) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  getMobileNotificationListenerCount(): number {
    return this.mobileSessionFacade.getMobileNotificationListenerCount()
  }

  // Why: bounded replay buffer for the mobile reconnect catch-up (#8129).
  // Every dispatched notification is recorded with a monotonic seq so a
  // reconnecting client can fetch exactly the events it missed. Kept on the
  // service instance (not per-client) because the buffer is a global,
  // idempotent-by-seq source of truth; clients watermark their own position.
  private readonly mobileNotificationReplay = new MobileNotificationReplayBuffer()

  dispatchMobileNotification(event: MobileNotificationEvent): void {
    return this.mobileSessionFacade.dispatchMobileNotification(event)
  }

  // Returns notifications dispatched after lastSeenSeq. Idempotent: the same
  // watermark always yields the same set, so a client cannot be re-pushed an
  // already-delivered event (the adversarial-review gate for #8129).
  getMissedNotificationsSince(lastSeenSeq: number, epoch?: string): ReplayableMobileNotification[] {
    return this.mobileNotificationReplay.getMissedSince(lastSeenSeq, epoch)
  }

  // Why (#8591): the seq counter is per-process and restarts at 0 on every desktop
  // launch, but the client's watermark is persisted. Clients need the epoch to tell
  // a stale watermark from a valid one — see MobileNotificationReplayBuffer.
  getMobileNotificationEpoch(): string {
    return this.mobileSessionFacade.getMobileNotificationEpoch()
  }

  dismissMobileNotification(notificationId: string): void {
    return this.mobileSessionFacade.dismissMobileNotification(notificationId)
  }

  /** Plugin panel action notifications.show. Native on desktop, relayed to
   *  paired mobile clients either way (mirrors notifications:dispatch). */
  async dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }> {
    // Why: prefix with the plugin id so a plugin cannot spoof an Orca system
    // notification or impersonate another plugin.
    const title = `${input.pluginId}: ${input.title}`
    const body = input.body ?? ''
    let delivered = false
    try {
      delivered = getRuntimeDesktopSurface().showNotification({ title, body })
    } catch {
      // A host with no notification display still relays to paired clients below.
    }
    this.dispatchMobileNotification({ type: 'notification', source: 'plugin', title, body })
    return { delivered }
  }

  // ─── Account Services (mobile RPC bridge) ─────────────────────

  setAccountServices(services: RuntimeAccountServices): void {
    this.accountCommands.setAccountServices(services)
  }

  setCommitMessageAgentEnvironmentResolvers(
    resolvers: CommitMessageAgentEnvironmentResolvers
  ): void {
    this.commitMessageAgentEnv = resolvers
  }

  getCommitMessageAgentEnvironmentResolvers(): CommitMessageAgentEnvironmentResolvers | undefined {
    return this.commitMessageAgentEnv ?? undefined
  }

  // Lists the speech-model catalog joined with live download/ready state, plus
  // the current enabled flag + selected model, so mobile can present a dictation
  // setup sheet and drive remote enable/download. Always targets this (paired)
  // desktop — speech never routes to a worktree's SSH host.
  async listMobileSpeechModels(): Promise<RuntimeSpeechSetupState> {
    return this.mobileSessionFacade.listMobileSpeechModels()
  }

  // Fire-and-forget model download; the ModelManager writes progress into its
  // per-model state, which mobile reads back via listMobileSpeechModels polling.
  async downloadMobileSpeechModel(modelId: string): Promise<{ started: true }> {
    return this.mobileSessionFacade.downloadMobileSpeechModel(modelId)
  }

  async deleteMobileSpeechModel(modelId: string): Promise<RuntimeSpeechSetupState> {
    return this.mobileSessionFacade.deleteMobileSpeechModel(modelId)
  }

  // Enables/disables dictation and/or selects the model, merging into the
  // existing voice settings so other voice fields are preserved.
  async configureMobileDictation(params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }): Promise<RuntimeSpeechSetupState> {
    return this.mobileSessionFacade.configureMobileDictation(params)
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
    return this.mobileSessionFacade.startMobileDictation(params)
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
    return this.mobileSessionFacade.feedMobileDictation(params)
  }

  async finishMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{
    dictationId: string
    text: string
  }> {
    return this.mobileSessionFacade.finishMobileDictation(params)
  }

  async cancelMobileDictation(params: {
    dictationId: string
    clientId?: string
    connectionId?: string
  }): Promise<{ dictationId: string }> {
    return this.mobileSessionFacade.cancelMobileDictation(params)
  }

  cancelMobileDictationForConnection(connectionId: string): void {
    return this.mobileSessionFacade.cancelMobileDictationForConnection(connectionId)
  }

  private cancelMobileDictationForClient(clientId: string): void {
    return this.mobileSessionFacade.cancelMobileDictationForClient(clientId)
  }

  getAccountsSnapshot(): AccountsSnapshot {
    return this.accountCommands.getAccountsSnapshot()
  }

  // Why: RateLimitService polls only when the Electron window is visible AND
  // focused, and the inactive-account caches fill lazily when the user opens
  // the desktop AccountsPane. Mobile has neither trigger, so without this the
  // phone shows 0% / "—" against a backgrounded desktop. Errors swallowed
  // because partial usage is still useful for the rest of the snapshot.
  async refreshAccountsForMobile(): Promise<void> {
    return this.mobileSessionFacade.refreshAccountsForMobile()
  }

  // Why: connection migration replays subscriptions; use the stale-aware lane
  // so a reconnect cannot turn one mobile viewer into continuous forced fetches.
  async refreshAccountsForMobileSubscriber(): Promise<void> {
    return this.mobileSessionFacade.refreshAccountsForMobileSubscriber()
  }

  selectClaudeAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.accountCommands.selectClaudeAccount(accountId)
  }

  selectCodexAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.accountCommands.selectCodexAccount(accountId)
  }

  selectCodexAccountForTarget(
    accountId: string | null,
    target: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    return this.accountCommands.selectCodexAccountForTarget(accountId, target)
  }

  async consumeCodexRateLimitResetCredit(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexRateLimitResetRpcResult> {
    return this.accountCommands.consumeCodexRateLimitResetCredit(idempotencyKey, expectedScope)
  }

  removeClaudeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.accountCommands.removeClaudeAccount(accountId)
  }

  // Why: register a managed Claude account from a CLAUDE_CONFIG_DIR the caller
  // already logged into. Lets the `orca account add` CLI drive `claude login` in
  // the user's terminal on a headless host, then capture the credentials here —
  // the desktop GUI's interactive add flow is unreachable over a remote runtime.
  addClaudeAccountFromConfigDir(
    configDir: string,
    options?: {
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
      previousLegacyCredentialsSha256?: string | null
    }
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.accountCommands.addClaudeAccountFromConfigDir(configDir, options)
  }

  removeCodexAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.accountCommands.removeCodexAccount(accountId)
  }

  // Why: Codex counterpart of addClaudeAccountFromConfigDir — register a managed
  // Codex account from a CODEX_HOME the caller already logged into, so headless
  // hosts can add accounts via `orca account add --agent codex`.
  addCodexAccountFromHome(
    sourceHome: string,
    target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
  ): Promise<CodexRateLimitAccountsState> {
    return this.accountCommands.addCodexAccountFromHome(sourceHome, target)
  }

  // Why: rate-limit polling fires every 5 minutes and on account switch.
  // Mobile clients subscribe to receive a fresh AccountsSnapshot whenever
  // RateLimitService pushes new usage data, mirroring the existing
  // `rateLimits:update` IPC channel desktop already uses.
  onAccountsChanged(listener: (snapshot: AccountsSnapshot) => void): () => void {
    return this.accountCommands.onAccountsChanged(listener)
  }

  // ─── Mobile Fit Override Management ─────────────────────────

  // Why: legacy mobile RPC entrypoint. After the state-machine rewrite this
  // is a thin shim that computes a `PtyLayoutTarget` and routes through
  // `enqueueLayout`. Keeps the same observable return shape so older mobile
  // builds continue to work. See docs/mobile-terminal-layout-state-machine.md.
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
    return this.windowGraphClientCommands.resizeForClient(ptyId, mode, clientId, cols, rows)
  }

  getTerminalFitOverride(ptyId: string) {
    return this.terminalClusterFacade.getTerminalFitOverride(ptyId)
  }

  getAllTerminalFitOverrides(): Map<
    string,
    { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
  > {
    return this.terminalClusterFacade.getAllTerminalFitOverrides()
  }

  getAllTerminalDrivers(): Map<string, DriverState> {
    return this.terminalClusterFacade.getAllTerminalDrivers()
  }

  getAllBrowserDrivers(): Map<string, RuntimeBrowserDriverState> {
    return getAllBrowserDrivers(this)
  }

  private getBrowserDriver(browserPageId: string): RuntimeBrowserDriverState {
    return getBrowserDriver(this, browserPageId)
  }

  private setBrowserDriver(browserPageId: string, next: RuntimeBrowserDriverState): void {
    setBrowserDriver(this, browserPageId, next)
  }

  getBrowserRemoteViewerPages(): string[] {
    return getBrowserRemoteViewerPages(this)
  }

  /** Republishes from the live subscriber set, so every add and remove has one settling point. */
  private publishBrowserRemoteViewers(browserPageId: string): void {
    publishBrowserRemoteViewers(this, browserPageId)
  }

  reclaimBrowserForDesktop(browserPageId: string): boolean {
    return reclaimBrowserForDesktop(this, browserPageId)
  }

  onClientDisconnected(clientId: string): void {
    return this.windowGraphClientCommands.onClientDisconnected(clientId)
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
    return this.ptyWorktrees.onPtyExit(ptyId, exitCode, exitIncarnationId, options)
  }

  private ptyExit_notifyTabAndMobile(
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
    return this.mobileSessionFacade.ptyExit_notifyTabAndMobile(
      pty,
      ptyId,
      exitIncarnationId,
      exitCode,
      exitCause,
      preservesAbnormalSshSurface,
      preservesIntentionalHandlessSurface,
      exactSurfaces,
      incarnationId
    )
  }

  // ─── Driver state (mobile-presence lock) ──────────────────────────
  //
  // See docs/mobile-presence-lock.md.

  getDriver(ptyId: string): DriverState {
    return this.terminalClusterFacade.getDriver(ptyId)
  }

  private setDriver(ptyId: string, next: DriverState): void {
    return this.terminalClusterFacade.setDriver(ptyId, next)
  }

  // Why: the host's own fit cascade (window resize, split drag, tab reveal,
  // "+"-new-tab re-render) must not resize a PTY whose width a remote client
  // owns — that is the remote "porridge" bug. True while a phone (mobile driver)
  // OR an active remote desktop viewer owns the PTY. Input is deliberately NOT gated
  // here (see the `writePtyInput` mobile-only checks): shared-control desktop
  // viewers may still type alongside the host.
  // Note: this is intentionally NOT a driver kind. An active remote viewer needs
  // only resize suppression, not the mobile driver machinery (input lock,
  // phone-fit, driver-change banners), so it lives in its own registry and does
  // not perturb the presence-lock state machine. It also coexists with mobile:
  // while a phone drives, the registry still suppresses host resize, and when
  // the phone leaves the surviving viewer keeps the PTY suppressed.
  isPtyResizeDrivenRemotely(ptyId: string): boolean {
    return this.ptyWorktrees.isPtyResizeDrivenRemotely(ptyId)
  }

  isRemoteDesktopResizeDriven(ptyId: string): boolean {
    return this.remoteDesktopCommands.isRemoteDesktopResizeDriven(ptyId)
  }

  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.remoteDesktopCommands.isRemoteDesktopViewerOwner(ptyId, subscriptionKey)
  }

  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    return this.remoteDesktopCommands.getRemoteDesktopFitHold(ptyId, subscriptionKey)
  }

  private hasRemoteDesktopViewers(ptyId: string): boolean {
    return this.remoteDesktopCommands.hasRemoteDesktopViewers(ptyId)
  }

  private activeRemoteDesktopViewport(ptyId: string): { cols: number; rows: number } | null {
    return this.remoteDesktopCommands.activeRemoteDesktopViewport(ptyId)
  }

  private resolveRemoteDesktopHostReclaimTarget(ptyId: string): { cols: number; rows: number } {
    return this.remoteDesktopCommands.resolveRemoteDesktopHostReclaimTarget(ptyId)
  }

  recordRemoteDesktopHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    return this.remoteDesktopCommands.recordRemoteDesktopHostReclaimTarget(ptyId, cols, rows)
  }

  private hasRemoteDesktopLayoutState(ptyId: string): boolean {
    return this.remoteDesktopCommands.hasRemoteDesktopLayoutState(ptyId)
  }

  async applyRemoteDesktopLayout(ptyId: string): Promise<boolean> {
    return this.remoteDesktopCommands.applyRemoteDesktopLayout(ptyId)
  }

  // Why: attachment only records geometry. Passive hydration/reconnect must not
  // steal the shared PTY from the desktop where the user is actively working.
  async updateRemoteDesktopViewer(
    ptyId: string,
    subscriptionKey: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = true
  ): Promise<boolean> {
    return this.remoteDesktopCommands.updateRemoteDesktopViewer(
      ptyId,
      subscriptionKey,
      clientId,
      cols,
      rows,
      claim
    )
  }

  claimRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.remoteDesktopCommands.claimRemoteDesktopViewer(ptyId, subscriptionKey)
  }

  claimRemoteDesktopHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    return this.remoteDesktopCommands.claimRemoteDesktopHost(ptyId, cols, rows)
  }

  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.remoteDesktopCommands.unregisterRemoteDesktopViewer(ptyId, subscriptionKey)
  }

  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean> {
    return this.remoteDesktopCommands.unregisterRemoteDesktopViewers(ptyId, subscriptionKeys)
  }

  // Why: the one-shot `terminal.updateViewport` RPC has no disconnect hook, so
  // it must never *create* a width floor (that floor would leak — nothing
  // releases it, pinning the host at a stale width after the viewer is gone).
  // It only refreshes the floor(s) this client already owns via its stream
  // subscription, keyed by clientId. Mirrors the mobile `updateMobileViewport`
  // no-op-without-subscription invariant. Returns false when the client owns no
  // floor (passive/stream-less viewer) — a stream-less viewer must not lock host
  // resize.
  refreshRemoteDesktopViewer(
    ptyId: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = false
  ): Promise<boolean> {
    return this.remoteDesktopCommands.refreshRemoteDesktopViewer(ptyId, clientId, cols, rows, claim)
  }

  async updateDesktopViewport(
    ptyId: string,
    viewport: { cols: number; rows: number }
  ): Promise<boolean> {
    const { cols, rows } = clampTerminalViewport(viewport.cols, viewport.rows)
    if (this.terminalFitOverrides.has(ptyId) || this.getDriver(ptyId).kind === 'mobile') {
      this.recordRendererGeometry(ptyId, cols, rows)
      return true
    }
    if (this.isResizeSuppressed()) {
      return false
    }
    this.freshSubscribeGuard.add(ptyId)
    try {
      const result = await this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      if (result.ok) {
        this.refreshRendererGeometry(ptyId, cols, rows)
      }
      return result.ok
    } finally {
      this.freshSubscribeGuard.delete(ptyId)
    }
  }

  markMobileActor(ptyId: string, clientId: string): void {
    return this.mobileSessionFacade.markMobileActor(ptyId, clientId)
  }

  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null {
    return this.mobileSessionFacade.beginMobileInputFloor(ptyId, clientId)
  }

  // Why: invoked from mobile RPC method handlers (terminal.send / setDisplayMode /
  // resizeForClient / fresh subscribe with auto). Records the actor as the
  // most recent mobile driver and re-applies phone-fit if we were previously
  // in `desktop` mode (mobile reclaims a take-back). Mobile-to-mobile hand-offs
  // are no-ops for resize.
  async mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    return this.mobileSessionFacade.mobileTookFloor(ptyId, clientId, previousFloor, isCurrent)
  }

  // Why: in-place viewport update on the existing mobile subscription —
  // used when the mobile keyboard opens/closes and shrinks/grows the
  // visible terminal area. We refresh the subscriber's viewport, re-fit
  // the PTY to the new dims, and emit a 'resized' event so the mobile
  // xterm reinits inline at the new dims without re-subscribing. This
  // avoids the unsubscribe → resubscribe cycle which would (a) flash the
  // desktop lock banner during the brief idle gap and (b) cause the new
  // subscribe to capture the already-phone-fitted PTY size as its
  // restore baseline (stuck-dim bug on later disconnect).
  // No-op when the client isn't actually subscribed to this PTY.
  async updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<{ updated: boolean; applied: boolean }> {
    return this.mobileSessionFacade.updateMobileViewport(ptyId, clientId, viewport)
  }

  // Why: invoked from `runtime:restoreTerminalFit` IPC (the desktop "Take
  // back" / "Restore" button). Forces the PTY back to desktop dims and flips
  // the driver to `desktop`, suppressing further mobile-driven dim changes
  // until a mobile actor takes the floor again. Three cases, each ending in
  // releaseDesktopTakeBack:
  //   1. Active mobile subscriber: route through applyMobileDisplayMode so the
  //      existing 'resized' event reaches the phone.
  //   2. Held override, no subscriber (post-indefinite-hold): resolve the
  //      restore target and enqueueLayout directly.
  //   3. Stale mobile driver, no subscriber and no override: nothing to resize,
  //      just drop the lock. See docs/mobile-fit-hold.md.
  //
  // Why: explicit desktop take-back is a user command to reclaim input control
  // NOW. Unlike the auto-restore timer and phone-initiated setDisplayMode paths
  // (which keep the lock when a resize can't converge, #7588), this gesture
  // ALWAYS drops the presence lock and banner. "Take back all terminals"
  // reclaims several PTYs at once; a background pane whose desktop resize can't
  // converge must not strand its banner on the other terminals. The resize is
  // best-effort — the desktop renderer refits the PTY on its next settled
  // frame. Returns `true` whenever there was a lock to reclaim, `false` only
  // when there was nothing to reclaim.
  async reclaimTerminalForDesktop(ptyId: string): Promise<boolean> {
    return this.terminalClusterFacade.reclaimTerminalForDesktop(ptyId)
  }

  // Why: teardown and desktop reclaim supersede delayed mobile mutations,
  // revoking soft-leave grace admission for input floors.
  private cancelPendingDriverMutations(ptyId: string): void {
    return this.terminalClusterFacade.cancelPendingDriverMutations(ptyId)
  }

  // Why: read-side clamp for mobileAutoRestoreFitMs. `null` means
  // indefinite hold (no auto-restore timer). A finite value is clamped
  // to [MIN, MAX] to defend against bad config — the smallest useful
  // value is a few seconds, the largest is one hour. See
  // docs/mobile-fit-hold.md.
  private getAutoRestoreFitMs(): number | null {
    return this.terminalClusterFacade.getAutoRestoreFitMs()
  }

  // Why: invoked when the user changes mobileAutoRestoreFitMs to `null`
  // (Indefinite). Clears every pending restore timer so the just-expressed
  // preference "do not auto-restore" is honored for ALL currently-pending
  // PTYs, not just one. See docs/mobile-fit-hold.md.
  cancelAllPendingFitRestoreTimers(): void {
    return this.terminalClusterFacade.cancelAllPendingFitRestoreTimers()
  }

  // Why: read the persisted user preference (clamped) for surfacing to UI
  // callers (mobile RPC, desktop preferences). Returns null when the
  // setting is unset or `null` ("Indefinite").
  getMobileAutoRestoreFitMs(): number | null {
    return this.terminalClusterFacade.getMobileAutoRestoreFitMs()
  }

  // Why: persisted-preference setter routed through the same `Store` the
  // desktop preferences UI writes to. Transitions to `null` (Indefinite)
  // clear every pending restore timer to honor the preference change for
  // already-held PTYs. Transitions to a finite value do NOT retroactively
  // schedule timers for PTYs that are currently held — those PTYs were
  // already-not-restored under the old preference, and silently scheduling
  // a restore on a settings change would be surprising. The new value
  // takes effect on the next unsubscribe. See docs/mobile-fit-hold.md.
  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    return this.terminalClusterFacade.setMobileAutoRestoreFitMs(ms)
  }

  // Why: with multiple subscribers, the active phone-fit dims follow the
  // most recent mobile actor (argmax(lastActedAt)). See
  // docs/mobile-presence-lock.md "Active phone-fit dim selection".
  private pickMostRecentActor(
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ): { clientId: string; lastActedAt: number } | null {
    let best: { clientId: string; lastActedAt: number } | null = null
    for (const sub of inner.values()) {
      if (best === null || sub.lastActedAt > best.lastActedAt) {
        best = sub
      }
    }
    return best
  }

  // Why: restore-target selection on last-subscriber-leaves picks the
  // earliest-by-subscribe-time subscriber AMONG those with non-null
  // previousCols/Rows. Desktop-mode joins carry null and are skipped — they
  // never captured pre-fit dims by design.
  private pickEarliestRestoreTarget(
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ): { previousCols: number; previousRows: number } | null {
    let best: { subscribedAt: number; previousCols: number; previousRows: number } | null = null
    for (const sub of inner.values()) {
      if (sub.previousCols == null || sub.previousRows == null) {
        continue
      }
      if (best === null || sub.subscribedAt < best.subscribedAt) {
        best = {
          subscribedAt: sub.subscribedAt,
          previousCols: sub.previousCols,
          previousRows: sub.previousRows
        }
      }
    }
    return best ? { previousCols: best.previousCols, previousRows: best.previousRows } : null
  }

  // ─── Layout state machine ─────────────────────────────────────────
  //
  // See docs/mobile-terminal-layout-state-machine.md.
  //
  // applyLayout is the SOLE writer of:
  //   - this.layouts
  //   - this.terminalFitOverrides (except the sanctioned dead-pty cleanups in
  //     onPtyExit and reclaimTerminalForDesktop's orphan branch, which delete)
  //   - this.ptyController.resize (i.e. the actual PTY dims)
  //
  // Every trigger that wants to change PTY dims or flip mode goes through
  // enqueueLayout, which serializes calls behind a per-PTY async queue
  // (the await on ptyController.resize would otherwise let seq bumps reach
  // the wire out of order).

  getLayout(ptyId: string): PtyLayoutState | null {
    return this.terminalClusterFacade.getLayout(ptyId)
  }

  // Why: `enqueueLayout`'s "no layouts entry" short-circuit must not fire
  // on the very first transition for a PTY (where the entry doesn't exist
  // yet *because* we're about to create it). handleMobileSubscribe adds
  // the ptyId to `freshSubscribeGuard` before calling enqueueLayout and
  // removes it in a finally block.
  private isFreshSubscribe(ptyId: string): boolean {
    return this.freshSubscribeGuard.has(ptyId)
  }

  // Why: four-step fallback chain for desktop-restore targets. Always
  // returns a value; the terminal {80,24} branch is reached only under
  // bug. Wrapping the chain as a single helper prevents callsite drift.
  private resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number } {
    return this.terminalClusterFacade.resolveDesktopRestoreTarget(ptyId)
  }

  // Why: a new viewport-only update from the same owner supersedes a
  // queued same-shape tail. Mode flips, owner changes, and take-back
  // append (losing a take-floor to a viewport tick would be a fairness
  // hole — see "enqueueLayout coalescing" in the design doc).
  private coalescesWith(prev: PtyLayoutTarget, next: PtyLayoutTarget): boolean {
    if (prev.kind !== next.kind) {
      return false
    }
    if (prev.kind === 'phone' && next.kind === 'phone') {
      return prev.ownerClientId === next.ownerClientId
    }
    if (prev.kind === 'remote-desktop' && next.kind === 'remote-desktop') {
      // Why: each owner's claim promise gates its following input. Sharing a
      // waiter across owners could release A's input only after B's grid lands.
      return prev.ownerSubscriptionKey === next.ownerSubscriptionKey
    }
    return true
  }

  private enqueueLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    return this.terminalClusterFacade.enqueueLayout(ptyId, target)
  }

  // ─── Server-Authoritative Mobile Display Mode ─────────────────────

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    return this.terminalClusterFacade.setMobileDisplayMode(ptyId, mode)
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop' {
    return this.mobileSessionFacade.getMobileDisplayMode(ptyId)
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    return this.terminalClusterFacade.isMobileSubscriberActive(ptyId)
  }

  // Why: late-bind viewport on an existing subscriber record. Subscribers
  // that registered before the mobile side measured (e.g. terminal first
  // mounted while the WebView was still loading) have null viewport, and
  // applyMobileDisplayMode's auto branch needs a viewport to phone-fit.
  // The setDisplayMode RPC carries the latest viewport so we can patch it
  // here just before applyMobileDisplayMode runs.
  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void {
    return this.mobileSessionFacade.updateMobileSubscriberViewport(ptyId, clientId, viewport)
  }

  // Why: server-side auto-fit on mobile subscribe. The runtime is the single
  // source of truth — the mobile client just passes its viewport and the runtime
  // decides whether to resize. This eliminates the measure→RPC→resubscribe
  // pipeline that caused race conditions.
  //
  // Multi-mobile keying: each subscriber lives in `mobileSubscribers[ptyId]`'s
  // inner map under its own clientId. Phone B subscribing does not overwrite
  // phone A's record — both stay until each unsubscribes.
  //
  // Subscribe-in-desktop-mode rule: a subscribe with displayMode='desktop' is
  // a passive watch; it does NOT take the floor. The driver remains
  // `idle`/`desktop`. The lock banner is reserved for actual mobile
  // interaction (input/resize/setDisplayMode/auto-or-phone subscribe).
  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    return this.mobileSessionFacade.handleMobileSubscribe(ptyId, clientId, viewport)
  }

  // Why: delayed restore prevents resize thrashing during rapid tab switches.
  // The 300ms debounce means only the final tab triggers a PTY restore;
  // intermediate terminals keep their current dims harmlessly.
  //
  // Multi-mobile: only the last subscriber leaving for this ptyId triggers
  // restore + driver=idle. Peer mobile clients still on the inner map keep
  // the lock banner mounted; if the disconnecting client was the active
  // driver, we re-elect the most-recent surviving subscriber.
  handleMobileUnsubscribe(ptyId: string, clientId: string): void {
    return this.mobileSessionFacade.handleMobileUnsubscribe(ptyId, clientId)
  }

  // Why: called when mode changes via terminal.setDisplayMode. Applies the
  // mode change immediately if there's an active subscriber, and emits a
  // 'resized' event so the mobile client can reinitialize xterm inline.
  //
  // Multi-mobile: the most recent mobile actor's viewport drives the active
  // phone-fit dims. The earliest-by-subscribe-time subscriber's
  // previousCols/Rows drive the desktop-restore target.
  //
  // Returns the post-condition "no fit-override remains held" (#7588): `true`
  // when it cleared a held override OR nothing was held to begin with, `false`
  // only when a restore was attempted and the resize failed (override rolled
  // back, still held). Informational for every caller today —
  // reclaimTerminalForDesktop deliberately does NOT gate on it, because an
  // explicit take-back must drop the lock even when the resize cannot
  // converge. Do not reinstate a convergence gate there.
  async applyMobileDisplayMode(ptyId: string): Promise<boolean> {
    return this.terminalClusterFacade.applyMobileDisplayMode(ptyId)
  }

  // Why: called after a desktop renderer path has successfully resized the
  // PTY (local IPC or remote desktop viewport). The runtime mirror must take
  // the same accepted geometry so hidden-output restore parses at PTY width.
  onExternalPtyResize(ptyId: string, cols: number, rows: number): void {
    // The pty:resize IPC handler is supposed to gate via `isResizeSuppressed`
    // before calling here, but defend against callers that don't.
    if (this.isResizeSuppressed()) {
      return
    }
    // Why: while a mobile-fit override is in place, the desktop renderer's
    // safeFit echoes pty:resize(override.cols, override.rows). Treating that
    // echo as legitimate geometry would overwrite each subscriber's
    // previousCols/Rows baseline with phone dims, so the next take-back
    // enqueues a no-op {kind:'desktop', cols:49, rows:40} and leaves xterm
    // stuck. Only filter reports that EXACTLY match the override — a fresh
    // measurement from a now-visible pane (e.g. user activated a previously
    // hidden tab on desktop, container went 0×0 → 1782×1195) reports
    // different dims and is the right baseline to remember.
    const activeOverride = this.terminalFitOverrides.get(ptyId)
    if (activeOverride && activeOverride.cols === cols && activeOverride.rows === rows) {
      return
    }
    // Why: a successful host resize supersedes any target retained after a
    // failed viewer reclaim; a later viewer cycle must capture this new truth.
    if (!this.hasRemoteDesktopViewers(ptyId)) {
      this.remoteDesktopHostReclaimTargets.delete(ptyId)
    }
    this.resizeHeadlessTerminal(ptyId, cols, rows)
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Why: pty:reportGeometry IPC sibling. The renderer calls this when a
  // desktop pane container goes from 0×0 to a real size while a mobile-fit
  // override is active (e.g. user activates a previously-hidden tab on
  // desktop after the phone has already taken the floor). We need the
  // restore-target baseline to track real desktop dims even during the
  // fit period — otherwise resolveDesktopRestoreTarget falls back to the
  // PTY's spawn default (typically 80×24) and Take Back leaves the
  // terminal partially restored. This is a measurement-only channel: it
  // refreshes lastRendererSizes and non-null subscriber baselines, never
  // resizes the PTY, and bypasses both isResizeSuppressed and the
  // override-echo gate by design — the renderer only fires it when it
  // has just measured fresh real geometry. See docs/mobile-fit-hold.md.
  recordRendererGeometry(ptyId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return
    }
    // Why: a viewer may leave while phone-fit still owns the PTY. Keep its
    // deferred host reclaim cache aligned with later trusted pane measurements.
    if (this.remoteDesktopHostReclaimTargets.has(ptyId)) {
      this.remoteDesktopHostReclaimTargets.set(ptyId, { cols, rows })
    }
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Why: test seam — exposes lastRendererSizes for assertions about
  // pty:reportGeometry / onExternalPtyResize side effects without making
  // the underlying Map writable from the outside.
  getLastRendererSize(ptyId: string): { cols: number; rows: number } | null {
    return this.lastRendererSizes.get(ptyId) ?? null
  }

  private refreshRendererGeometry(ptyId: string, cols: number, rows: number): void {
    this.lastRendererSizes.set(ptyId, { cols, rows })
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    // Refresh the renderer-current size as the next-restore target on every
    // subscriber that already has a non-null baseline. Subscribers with null
    // baselines (joined while a peer had already phone-fitted) stay null.
    for (const sub of inner.values()) {
      if (sub.previousCols != null && sub.previousRows != null) {
        sub.previousCols = cols
        sub.previousRows = rows
      }
    }
  }

  // Why: the pty:resize IPC handler calls this to check if the global
  // suppress window is active. During this window, all desktop renderer
  // pty:resize events are ignored to prevent collateral safeFit corruption.
  isResizeSuppressed(): boolean {
    return Date.now() < this.resizeSuppressedUntil
  }

  private suppressResizesForMs(ms: number): void {
    this.resizeSuppressedUntil = Date.now() + ms
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
    return this.terminalClusterFacade.subscribeToTerminalResize(ptyId, listener)
  }

  private notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void {
    return this.terminalClusterFacade.notifyTerminalResize(ptyId, event)
  }

  // Why: Section 7.2 — the runtime detects agent exit directly and updates
  // dispatch contexts immediately, rather than waiting for the coordinator's
  // next poll cycle. This catches agent crashes and unexpected exits within
  // milliseconds. The task is set back to 'pending' so it can be re-dispatched.
  private failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ): void {
    return this.terminalRecoveryCommands.failActiveDispatchOnExit(handle, paneKey, exitCode, cause)
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
    return this.terminalClusterFacade.listTerminals(worktreeSelector, limit, opts)
  }

  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'> {
    return this.terminalClusterFacade.inspectTerminalProcessIncarnationLiveness(
      processIncarnation,
      serializedHostScope
    )
  }

  private getTerminalTopologyRevision(worktreeId: string): number {
    return this.terminalClusterFacade.getTerminalTopologyRevision(worktreeId)
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    return this.terminalClusterFacade.adoptTerminalOrphans(request)
  }

  private async adoptTerminalOrphansFromInventory(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    return this.terminalClusterFacade.adoptTerminalOrphansFromInventory(
      request,
      workspace,
      inventory
    )
  }

  // Why: when --terminal is omitted, the CLI auto-resolves to the active
  // terminal in the current worktree — matching browser's implicit active tab.
  async resolveActiveTerminal(worktreeSelector?: string): Promise<string> {
    return this.terminalClusterFacade.resolveActiveTerminal(worktreeSelector)
  }

  // Why: orchestration records the pane key as the remint-stable assignee
  // identity at dispatch time; null (best-effort) rather than throwing so
  // dispatch still works for handles without a resolvable pane.
  getTerminalPaneKey(handle: string): string | null {
    return this.terminalClusterFacade.getTerminalPaneKey(handle)
  }

  getLiveTerminalPaneKey(handle: string): string | null {
    return this.terminalClusterFacade.getLiveTerminalPaneKey(handle)
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    return this.terminalClusterFacade.getTerminalWorktreeIdForPaneKey(paneKey)
  }

  /** Read-only context of the worktree the user is focused on, for plugin
   *  panels (workspace.readContext). Prefers the persisted session focus and
   *  falls back to the last-focused pane's worktree; null when neither
   *  resolves so panels degrade instead of erroring. */
  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    return this.managedWorktrees.resolveActiveWorktreeContext()
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    return this.terminalClusterFacade.getTerminalProcessIncarnation(handle)
  }

  /**
   * Records that we lost contact with a PTY's owning host. Callers must never
   * read this as an exit: a detached relay PTY is designed to outlive the
   * provider that addressed it.
   */
  markPtyLivenessUnverifiable(ptyId: string, reason: string): void {
    return this.ptyWorktrees.markPtyLivenessUnverifiable(ptyId, reason)
  }

  markPtyLivenessLive(ptyId: string): void {
    return this.ptyWorktrees.markPtyLivenessLive(ptyId)
  }

  /**
   * Records that Orca asked this PTY to stop — a close, a stop, a teardown.
   *
   * Why before the kill and not at the exit: a requested stop can still be
   * delivered by the provider's own exit event, which carries a process status
   * indistinguishable from a natural finish. The intent is the only thing that
   * separates "the operator closed it" from "the agent died", so it is recorded
   * where it is known rather than reconstructed afterwards (STA-4603).
   */
  markPtyStopRequested(ptyId: string): void {
    return this.ptyWorktrees.markPtyStopRequested(ptyId)
  }

  isPtyStopRequested(ptyId: string): boolean {
    return this.ptyWorktrees.isPtyStopRequested(ptyId)
  }

  /** Null when nothing has been observed either way, so callers keep their own default. */
  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null {
    return this.ptyWorktrees.getPtyLivenessVerdict(ptyId)
  }

  getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null {
    return this.terminalClusterFacade.getTerminalLivenessVerdict(handle)
  }

  private forgetPtyLivenessVerdict(ptyId: string, observedNoLaterThan?: number): void {
    return this.ptyWorktrees.forgetPtyLivenessVerdict(ptyId, observedNoLaterThan)
  }

  getExactWorkerProviderSession(
    handle: string,
    observedAfter: number
  ): ExactWorkerProviderSession | null {
    const paneKey = this.getTerminalPaneKey(handle)
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation) {
      return null
    }
    let connectionId: string | null | undefined
    let launchToken: string | null | undefined
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
      connectionId = undefined
      launchToken = undefined
    }
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      observedAfter,
      statuses: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    return this.agentClusterFacade.validateOrchestrationAgentLauncher(agent)
  }

  resolveTerminalPane(paneKey: string, expectedWorktreeId?: string): RuntimeTerminalResolvePane {
    return this.terminalClusterFacade.resolveTerminalPane(paneKey, expectedWorktreeId)
  }

  async recoverTerminalPane(
    paneKey: string,
    expectedWorktreeId: string,
    expectedHandle?: string
  ): Promise<RuntimeTerminalResolvePane> {
    return this.terminalClusterFacade.recoverTerminalPane(
      paneKey,
      expectedWorktreeId,
      expectedHandle
    )
  }

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    return this.terminalClusterFacade.showTerminal(handle)
  }

  async readTerminal(
    handle: string,
    opts: { cursor?: number; limit?: number; screen?: boolean } = {},
    providerSnapshot: ProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    return this.terminalClusterFacade.readTerminal(handle, opts, providerSnapshot)
  }

  private controllerKnowsPtyIsLive(ptyId: string): boolean {
    return this.ptyWorktrees.controllerKnowsPtyIsLive(ptyId)
  }

  /** True only on controller-proven absence; live, unknown, and probe errors all answer false. */
  private isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    return this.terminalClusterFacade.isLeafPtyProvenAbsent(ptyId)
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
    return this.terminalClusterFacade.sendTerminal(handle, action, options)
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
    return this.agentClusterFacade.sendTerminalAgentPrompt(handle, prompt, options)
  }

  async getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    return this.agentClusterFacade.getTerminalAgentStatus(handle)
  }

  private getFreshExplicitAgentStatusForHandle(
    handle: string,
    paneKeyOverride?: string | null
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    /** When this state was entered. Pinned across same-state pings, so it identifies the turn. */
    stateStartedAt: number
  } | null {
    return this.agentClusterFacade.getFreshExplicitAgentStatusForHandle(handle, paneKeyOverride)
  }

  /** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
   *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
   *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
   *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
   *  process.platform says nothing about it. */
  private getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    return this.ptyWorktrees.getPtyWriteHostPlatform(ptyId)
  }

  async waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<RuntimeTerminalWait> {
    return this.terminalClusterFacade.waitForTerminal(handle, options)
  }

  subscribeToPtyExit(ptyId: string, listener: () => void): () => void {
    return this.ptyWorktrees.subscribeToPtyExit(ptyId, listener)
  }

  async waitForSetupTerminalCompletion(handle: string): Promise<{ exitCode: number | null }> {
    return this.terminalClusterFacade.waitForSetupTerminalCompletion(handle)
  }

  async getWorktreePs(
    limit = DEFAULT_WORKTREE_PS_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
    return this.worktreePs.getWorktreePs(limit, sourceDefaultsSupported)
  }

  // Why: maps the retained per-pane agent snapshots into each worktree's inline
  // agent list, mirroring the desktop sidebar. Lineage parent is resolved from
  // the orchestration db (paneKey-keyed), not the OSC payload, since spawn
  // hierarchy is pane-level state tracked separately from terminal output.
  private attachAgentRowsToSummaries(
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
  ): void {
    return this.agentClusterFacade.attachAgentRowsToSummaries(
      summaries,
      runtimeWorktreeSummaryPathIndex,
      missingRuntimeWorktreeIds,
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      workingTerminalEvidenceByWorktreeId
    )
  }

  listRepos(): Repo[] {
    return this.projectWorktreeCommands.listRepos()
  }

  enrichMissingRepoGitRemoteIdentities(): void {
    this.projectWorktreeCommands.enrichMissingRepoGitRemoteIdentities()
  }

  listProjects(): Project[] {
    return this.projectWorktreeCommands.listProjects()
  }

  updateProject(projectId: string, updates: ProjectUpdateArgs['updates']): Project {
    return this.projectWorktreeCommands.updateProject(projectId, updates)
  }

  listProjectHostSetups(): ProjectHostSetup[] {
    return this.projectWorktreeCommands.listProjectHostSetups()
  }

  createProjectHostSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult {
    return this.projectWorktreeCommands.createProjectHostSetup(args)
  }

  async setupProjectExistingFolder(
    args: ProjectHostSetupExistingFolderArgs
  ): Promise<ProjectHostSetupResult> {
    return this.projectWorktreeCommands.setupProjectExistingFolder(args)
  }

  async setupProjectClone(args: ProjectHostSetupCloneArgs): Promise<ProjectHostSetupResult> {
    return this.projectWorktreeCommands.setupProjectClone(args)
  }

  updateProjectHostSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult {
    return this.projectWorktreeCommands.updateProjectHostSetup(args)
  }

  deleteProjectHostSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult {
    return this.projectWorktreeCommands.deleteProjectHostSetup(args)
  }

  listProjectGroups(): ProjectGroup[] {
    return this.projectWorktreeCommands.listProjectGroups()
  }

  listFolderWorkspaces(): FolderWorkspace[] {
    return this.projectWorktreeCommands.listFolderWorkspaces()
  }

  async createProjectGroup(input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom?: ProjectGroup['createdFrom']
  }): Promise<ProjectGroup> {
    return this.projectWorktreeCommands.createProjectGroup(input)
  }

  async updateProjectGroup(
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
  ): Promise<ProjectGroup | null> {
    return this.projectWorktreeCommands.updateProjectGroup(groupId, updates)
  }

  async deleteProjectGroup(groupId: string): Promise<{ deleted: boolean }> {
    return this.projectWorktreeCommands.deleteProjectGroup(groupId)
  }

  async moveProjectToGroup(
    repoSelector: string,
    groupId: string | null,
    order?: number
  ): Promise<Repo> {
    return this.projectWorktreeCommands.moveProjectToGroup(repoSelector, groupId, order)
  }

  async createFolderWorkspace(input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
    creatorProvenance?: FolderWorkspace['creatorProvenance']
    linkedTask?: FolderWorkspace['linkedTask']
    linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }): Promise<FolderWorkspace> {
    return this.projectWorktreeCommands.createFolderWorkspace(input)
  }

  async getFolderWorkspacePathStatus(
    request: FolderWorkspacePathStatusRequest
  ): Promise<FolderWorkspacePathStatus> {
    return this.projectWorktreeCommands.getFolderWorkspacePathStatus(request)
  }

  async updateFolderWorkspace(
    folderWorkspaceId: string,
    updates: Partial<
      Pick<
        FolderWorkspace,
        | 'name'
        | 'folderPath'
        | 'linkedTask'
        | 'linkedTaskSourceContext'
        | 'comment'
        | 'isArchived'
        | 'isUnread'
        | 'isPinned'
        | 'sortOrder'
        | 'manualOrder'
        | 'workspaceStatus'
        | 'createdWithAgent'
        | 'pendingFirstAgentMessageRename'
        | 'firstAgentMessageRenameError'
        | 'lastActivityAt'
        | 'diffComments'
      >
    >
  ): Promise<FolderWorkspace | null> {
    return this.projectWorktreeCommands.updateFolderWorkspace(folderWorkspaceId, updates)
  }

  async deleteFolderWorkspace(folderWorkspaceId: string): Promise<{ deleted: boolean }> {
    return this.projectWorktreeCommands.deleteFolderWorkspace(folderWorkspaceId)
  }

  async scanNestedRepos(path: string): Promise<NestedRepoScanResult> {
    return this.projectWorktreeCommands.scanNestedRepos(path)
  }

  async browseServerDir(pathValue: string): Promise<{
    resolvedPath: string
    entries: DirEntry[]
    pathFlavor: FilesystemPathFlavor
  }> {
    return this.projectWorktreeCommands.browseServerDir(pathValue)
  }

  async isGitAvailable(): Promise<boolean> {
    return this.projectWorktreeCommands.isGitAvailable()
  }

  async importNestedRepos(args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    mode: ProjectGroupImportMode
  }): Promise<ProjectGroupImportResult> {
    return this.projectWorktreeCommands.importNestedRepos(args)
  }

  async listSparsePresets(repoSelector: string) {
    return this.projectWorktreeCommands.listSparsePresets(repoSelector)
  }

  async saveSparsePreset(
    repoSelector: string,
    args: { id?: string; name: string; directories: string[] }
  ) {
    return this.projectWorktreeCommands.saveSparsePreset(repoSelector, args)
  }

  async addRepo(
    path: string,
    kind: 'git' | 'folder' = 'git',
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    return this.projectWorktreeCommands.addRepo(path, kind, executionHostId)
  }

  async createRepo(
    parentPath: string,
    name: string,
    kind: 'git' | 'folder' = 'git'
  ): Promise<{ repo: Repo } | { error: string }> {
    return this.projectWorktreeCommands.createRepo(parentPath, name, kind)
  }

  async cloneRepo(
    url: string,
    destination: string,
    executionHostId?: ExecutionHostId | null
  ): Promise<Repo> {
    return this.projectWorktreeCommands.cloneRepo(url, destination, executionHostId)
  }

  get showRepo() {
    return this.repoGitCommands.showRepo
  }
  get setRepoBaseRef() {
    return this.repoGitCommands.setRepoBaseRef
  }
  get updateRepo() {
    return this.repoGitCommands.updateRepo
  }
  get removeProject() {
    return this.repoGitCommands.removeProject
  }
  get inspectTerminalProcess() {
    return this.repoGitCommands.inspectTerminalProcess
  }
  get reorderRepos() {
    return this.repoGitCommands.reorderRepos
  }
  get searchRepoRefs() {
    return this.repoGitCommands.searchRepoRefs
  }
  get getRepoBaseRefDefault() {
    return this.repoGitCommands.getRepoBaseRefDefault
  }
  get getRepoSlug() {
    return this.repoGitCommands.getRepoSlug
  }
  get getRepoUpstream() {
    return this.repoGitCommands.getRepoUpstream
  }
  get listRepoWorkItems() {
    return this.repoGitCommands.listRepoWorkItems
  }
  get listRepoIssues() {
    return this.repoGitCommands.listRepoIssues
  }
  get getRepoWorkItem() {
    return this.repoGitCommands.getRepoWorkItem
  }
  get getRepoWorkItemDetails() {
    return this.repoGitCommands.getRepoWorkItemDetails
  }
  get countRepoWorkItems() {
    return this.repoGitCommands.countRepoWorkItems
  }
  get listRepoLabels() {
    return this.repoGitCommands.listRepoLabels
  }
  get listRepoAssignableUsers() {
    return this.repoGitCommands.listRepoAssignableUsers
  }
  get getGitHubRateLimit() {
    return this.repoGitCommands.getGitHubRateLimit
  }
  get getRepoPRForBranch() {
    return this.repoGitCommands.getRepoPRForBranch
  }
  get getHostedReviewForBranch() {
    return this.repoGitCommands.getHostedReviewForBranch
  }
  get createHostedReview() {
    return this.repoGitCommands.createHostedReview
  }
  get createStackedHostedReview() {
    return this.repoGitCommands.createStackedHostedReview
  }
  get listGitLabRepoWorkItems() {
    return this.repoGitCommands.listGitLabRepoWorkItems
  }
  get listGitLabRepoMRs() {
    return this.repoGitCommands.listGitLabRepoMRs
  }
  get listGitLabRepoIssues() {
    return this.repoGitCommands.listGitLabRepoIssues
  }
  get listGitLabRepoTodos() {
    return this.repoGitCommands.listGitLabRepoTodos
  }
  get diagnoseGitLabAuth() {
    return this.repoGitCommands.diagnoseGitLabAuth
  }
  get getGitLabRateLimit() {
    return this.repoGitCommands.getGitLabRateLimit
  }
  get listGitLabRepoLabels() {
    return this.repoGitCommands.listGitLabRepoLabels
  }
  get createGitLabRepoIssue() {
    return this.repoGitCommands.createGitLabRepoIssue
  }
  get updateGitLabRepoIssue() {
    return this.repoGitCommands.updateGitLabRepoIssue
  }
  get addGitLabRepoIssueComment() {
    return this.repoGitCommands.addGitLabRepoIssueComment
  }
  get addGitLabRepoMRComment() {
    return this.repoGitCommands.addGitLabRepoMRComment
  }
  get addGitLabRepoMRInlineComment() {
    return this.repoGitCommands.addGitLabRepoMRInlineComment
  }
  get getGitLabRepoJobTrace() {
    return this.repoGitCommands.getGitLabRepoJobTrace
  }
  get retryGitLabRepoJob() {
    return this.repoGitCommands.retryGitLabRepoJob
  }
  get mergeGitLabRepoMR() {
    return this.repoGitCommands.mergeGitLabRepoMR
  }
  get updateGitLabRepoMRState() {
    return this.repoGitCommands.updateGitLabRepoMRState
  }
  get updateGitLabRepoMR() {
    return this.repoGitCommands.updateGitLabRepoMR
  }
  get updateGitLabRepoMRReviewers() {
    return this.repoGitCommands.updateGitLabRepoMRReviewers
  }
  get getGitLabRepoWorkItemDetails() {
    return this.repoGitCommands.getGitLabRepoWorkItemDetails
  }
  get getGitLabRepoWorkItemByPath() {
    return this.repoGitCommands.getGitLabRepoWorkItemByPath
  }
  get getRepoIssue() {
    return this.repoGitCommands.getRepoIssue
  }
  get getRepoPRChecks() {
    return this.repoGitCommands.getRepoPRChecks
  }
  get rerunRepoPRChecks() {
    return this.repoGitCommands.rerunRepoPRChecks
  }
  get getRepoPRCheckDetails() {
    return this.repoGitCommands.getRepoPRCheckDetails
  }
  get getRepoPRComments() {
    return this.repoGitCommands.getRepoPRComments
  }
  get setRepoPRCommentReaction() {
    return this.repoGitCommands.setRepoPRCommentReaction
  }
  get getRepoPRFileContents() {
    return this.repoGitCommands.getRepoPRFileContents
  }
  get resolveRepoReviewThread() {
    return this.repoGitCommands.resolveRepoReviewThread
  }
  get setRepoPRFileViewed() {
    return this.repoGitCommands.setRepoPRFileViewed
  }
  get updateRepoPRTitle() {
    return this.repoGitCommands.updateRepoPRTitle
  }
  get updateRepoPRDetails() {
    return this.repoGitCommands.updateRepoPRDetails
  }
  get mergeRepoPR() {
    return this.repoGitCommands.mergeRepoPR
  }
  get setRepoPRAutoMerge() {
    return this.repoGitCommands.setRepoPRAutoMerge
  }
  get markRepoPRReadyForReview() {
    return this.repoGitCommands.markRepoPRReadyForReview
  }
  get updateRepoPRState() {
    return this.repoGitCommands.updateRepoPRState
  }
  get requestRepoPRReviewers() {
    return this.repoGitCommands.requestRepoPRReviewers
  }
  get removeRepoPRReviewers() {
    return this.repoGitCommands.removeRepoPRReviewers
  }
  get createRepoIssue() {
    return this.repoGitCommands.createRepoIssue
  }
  get updateRepoIssue() {
    return this.repoGitCommands.updateRepoIssue
  }
  get addRepoIssueComment() {
    return this.repoGitCommands.addRepoIssueComment
  }
  get addRepoPRReviewComment() {
    return this.repoGitCommands.addRepoPRReviewComment
  }
  get addRepoPRReviewCommentReply() {
    return this.repoGitCommands.addRepoPRReviewCommentReply
  }
  get listGitHubProjects() {
    return this.repoGitCommands.listGitHubProjects
  }
  get listGitHubLabelsBySlug() {
    return this.repoGitCommands.listGitHubLabelsBySlug
  }
  get listGitHubIssueTypesBySlug() {
    return this.repoGitCommands.listGitHubIssueTypesBySlug
  }
  get resolveGitHubProjectRef() {
    return this.repoGitCommands.resolveGitHubProjectRef
  }
  get listGitHubProjectViews() {
    return this.repoGitCommands.listGitHubProjectViews
  }
  get getGitHubProjectViewTable() {
    return this.repoGitCommands.getGitHubProjectViewTable
  }
  get updateGitHubProjectItemField() {
    return this.repoGitCommands.updateGitHubProjectItemField
  }
  get clearGitHubProjectItemField() {
    return this.repoGitCommands.clearGitHubProjectItemField
  }
  get updateGitHubIssueBySlug() {
    return this.repoGitCommands.updateGitHubIssueBySlug
  }
  get updateGitHubIssueTypeBySlug() {
    return this.repoGitCommands.updateGitHubIssueTypeBySlug
  }
  get addGitHubIssueCommentBySlug() {
    return this.repoGitCommands.addGitHubIssueCommentBySlug
  }
  get getRepoHooks() {
    return this.repoGitCommands.getRepoHooks
  }
  get checkRepoHooks() {
    return this.repoGitCommands.checkRepoHooks
  }
  get readRepoIssueCommand() {
    return this.repoGitCommands.readRepoIssueCommand
  }
  get writeRepoIssueCommand() {
    return this.repoGitCommands.writeRepoIssueCommand
  }
  get listManagedWorktrees() {
    return this.repoGitCommands.listManagedWorktrees
  }

  async showManagedWorktree(worktreeSelector: string) {
    return this.managedWorktrees.showManagedWorktree(worktreeSelector)
  }

  async showManagedTerminalWorkspace(worktreeSelector: string) {
    return this.terminalClusterFacade.showManagedTerminalWorkspace(worktreeSelector)
  }

  async scanWorkspacePorts(repoId?: string): Promise<WorkspacePortScanResult> {
    return scanWorkspacePortProbes(await this.getWorkspacePortProbes(repoId))
  }

  async killWorkspacePort(args: WorkspacePortKillRequest): Promise<WorkspacePortKillResult> {
    return killWorkspacePort(await this.getWorkspacePortProbes(args.repoId), args)
  }

  // Why: remote clients may invoke this over RPC, so the runtime derives
  // allowed worktree paths from its own store instead of trusting client paths.
  private async getWorkspacePortProbes(repoId?: string): Promise<WorkspacePortProbe[]> {
    const reposById = new Map(
      this.requireStore()
        .getRepos()
        .map((repo) => [repo.id, repo])
    )
    return filterWorkspacePortProbes(
      (await this.listResolvedWorktrees()).map((worktree) => ({
        id: worktree.id,
        repoId: worktree.repoId,
        displayName: worktree.displayName,
        path: worktree.git.path,
        connectionId: reposById.get(worktree.repoId)?.connectionId ?? null
      })),
      repoId
    )
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    return this.managedWorktrees.sleepManagedWorktree(worktreeSelector)
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
    return this.managedWorktrees.activateManagedWorktree(worktreeSelector, opts)
  }

  private buildStartupForDraft = (
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent
  ): ReturnType<RuntimeStartupDraftCommands['buildStartupForDraft']> =>
    this.startupDraftCommands.buildStartupForDraft(repo, draft, requestedAgent)

  private readonly startupDraftCommands: RuntimeStartupDraftCommands

  private buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences
  ): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
    return this.agentClusterFacade.buildStartupForAgent(repo, agent, prompt, launchPreferences)
  }

  private markWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string | null | undefined,
    workspacePath: string
  ): Promise<void> {
    return this.agentClusterFacade.markWorkspaceTrustedForAgent(agent, connectionId, workspacePath)
  }

  private async markLocalWorkspaceTrustedForAgent(
    agent: TuiAgent,
    workspacePath: string
  ): Promise<void> {
    return this.agentClusterFacade.markLocalWorkspaceTrustedForAgent(agent, workspacePath)
  }

  private async markRemoteWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string,
    workspacePath: string
  ): Promise<void> {
    return this.agentClusterFacade.markRemoteWorkspaceTrustedForAgent(
      agent,
      connectionId,
      workspacePath
    )
  }

  private pasteStartupDraftWhenReady(handle: string, draft: WorktreeStartupDraftPaste): void {
    void this.waitForStartupDraftReady(handle, draft.agent)
      .then((ptyId) => {
        if (!ptyId) {
          console.warn('[worktree-create] agent did not become ready for draft paste')
          return
        }
        this.ptyController?.write(
          ptyId,
          `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`
        )
      })
      .catch((error) => {
        console.warn('[worktree-create] failed to paste startup draft:', error)
      })
  }

  private sendStartupFollowupWhenReady(handle: string, followup: WorktreeStartupFollowup): void {
    void this.waitForStartupFollowupReady(handle, followup.expectedProcess)
      .then((ptyId) => {
        if (!ptyId) {
          console.warn('[worktree-create] agent did not become ready for follow-up prompt')
          return
        }
        this.ptyController?.write(ptyId, `${followup.prompt}\r`)
      })
      .catch((error) => {
        console.warn('[worktree-create] failed to send startup follow-up prompt:', error)
      })
  }

  private async createDefaultTabTerminals(
    worktreeSelector: string,
    worktreeId: string,
    defaultTabs: CreateWorktreeResult['defaultTabs'] | undefined,
    surfacing: { surfaceOwner?: false } = {}
  ): Promise<string[]> {
    return this.terminalClusterFacade.createDefaultTabTerminals(
      worktreeSelector,
      worktreeId,
      defaultTabs,
      surfacing
    )
  }

  private async waitForStartupFollowupReady(
    handle: string,
    expectedProcess: string
  ): Promise<string | null> {
    const livePty = this.getLivePtyForHandle(handle)
    const ptyId = livePty?.pty.ptyId
    if (!ptyId || !this.ptyController) {
      return null
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      try {
        const foregroundProcess = await this.ptyController.getForegroundProcess(ptyId)
        if (isExpectedAgentProcess(foregroundProcess, expectedProcess)) {
          return ptyId
        }
        if (attempt >= 4 && !isShellProcess(foregroundProcess ?? '')) {
          const hasChildProcesses =
            (await this.ptyController.hasChildProcesses?.(ptyId).catch(() => false)) ?? false
          if (hasChildProcesses) {
            return ptyId
          }
        }
      } catch {
        // Ignore transient PTY inspection failures and keep polling.
      }
    }
    return null
  }

  private waitForStartupDraftReady(handle: string, agent: TuiAgent): Promise<string | null> {
    const livePty = this.getLivePtyForHandle(handle)
    const ptyId = livePty?.pty.ptyId
    if (!ptyId) {
      return Promise.resolve(null)
    }
    const readySignal =
      TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
    return new Promise<string | null>((resolve) => {
      let settled = false
      const scanner = createDraftPasteReadyScanner(readySignal)
      let quietTimer: NodeJS.Timeout | null = null
      let hardTimer: NodeJS.Timeout | null = null
      let unsubscribe: (() => void) | null = null

      const finish = (value: string | null): void => {
        if (settled) {
          return
        }
        settled = true
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        if (hardTimer) {
          clearTimeout(hardTimer)
        }
        unsubscribe?.()
        resolve(value)
      }

      const armQuietTimer = (): void => {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(() => finish(ptyId), BRACKETED_PASTE_QUIET_MS)
      }

      const observeData = (data: string): void => {
        const { ready, armQuietTimer: shouldArm } = scanner.observe(data)
        if (ready) {
          finish(ptyId)
          return
        }
        if (shouldArm) {
          armQuietTimer()
        }
      }

      unsubscribe = this.subscribeToTerminalData(ptyId, observeData)
      const replay = this.recentPtyOutputById.get(ptyId)?.read()
      if (replay) {
        observeData(replay)
      }
      hardTimer = setTimeout(() => finish(null), resolveDraftPasteReadyTimeoutMs(agent))
    })
  }

  async createManagedWorktree(
    args: RuntimeManagedWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    return this.managedWorktrees.createManagedWorktree(args)
  }

  /**
   * Fetch `remote` in `repoPath`, sharing the 30s freshness window + in-flight
   * serialization with all other callers. Never rejects — callers
   * log-and-proceed on offline failures (§3.3 Lifecycle).
   *
   * Why a shared cache on the runtime instead of module-scoped: §7.1 relies on
   * one cache for BOTH the renderer create path and `probeWorktreeDrift`. A
   * dispatch tick that reuses a just-completed create-path fetch is the
   * primary telemetry target; splitting the cache by call-site would double
   * the fetch load on warm repos.
   */
  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<string> {
    const runtimeKey = gitOptions.wslDistro ? `wsl:${gitOptions.wslDistro}` : 'local'
    const cacheKey = `${runtimeKey}::${repoPath}::${remote}`
    const cached = this.canonicalFetchKeyCache.get(cacheKey)
    if (cached !== undefined) {
      setBoundedMapEntry(this.canonicalFetchKeyCache, cacheKey, cached, REMOTE_FETCH_CACHE_MAX)
      return cached
    }
    let resolved = cacheKey
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: repoPath, ...gitOptions }
      )
      const commonDir = stdout.trim()
      if (commonDir) {
        resolved = `${runtimeKey}::${commonDir}::${remote}`
      }
    } catch {
      // Fall through to the caller-provided path. The fetch still runs from
      // repoPath; this key only controls cache sharing.
    }
    setBoundedMapEntry(this.canonicalFetchKeyCache, cacheKey, resolved, REMOTE_FETCH_CACHE_MAX)
    return resolved
  }

  private getFreshFetchCompletedAt(key: string): number | null {
    const lastAt = this.fetchLastCompletedAt.get(key)
    if (lastAt === undefined) {
      return null
    }
    if (Date.now() - lastAt < FETCH_FRESHNESS_MS) {
      setBoundedMapEntry(this.fetchLastCompletedAt, key, lastAt, REMOTE_FETCH_CACHE_MAX)
      return lastAt
    }
    this.fetchLastCompletedAt.delete(key)
    return null
  }

  private rememberFreshFetchCompletedAt(key: string, completedAt = Date.now()): void {
    setBoundedMapEntry(this.fetchLastCompletedAt, key, completedAt, REMOTE_FETCH_CACHE_MAX)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    return this.managedBaseCommands.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    return this.managedBaseCommands.getOrStartRemoteTrackingBaseRefresh(repoPath, base, gitOptions)
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<void> {
    await this.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteTrackingBase | null> {
    return this.managedBaseCommands.resolveRemoteTrackingBase(repoPath, baseBranch, gitOptions)
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<boolean> {
    try {
      await gitExecFileAsync(['rev-parse', '--verify', `${base.ref}^{commit}`], {
        cwd: repoPath,
        ...gitOptions
      })
      return true
    } catch {
      return false
    }
  }

  recordOptimisticReconcileToken(worktreeId: string): string {
    const token = randomUUID()
    this.optimisticReconcileTokens.set(worktreeId, token)
    return token
  }

  clearOptimisticReconcileToken(worktreeId: string): void {
    this.optimisticReconcileTokens.delete(worktreeId)
  }

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    return this.managedWorktrees.emitWorktreeBaseStatus(event)
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
    return this.managedWorktrees.reconcileWorktreeBaseStatus(args)
  }

  /**
   * Probe how far the worktree's HEAD is behind its tracking remote. Returns
   * null when the probe cannot establish a signal (no default base ref, or
   * git failure). Dispatch treats null as "unknown — proceed" (§3.1); only
   * knowing-and-stale refuses.
   */
  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    return this.managedWorktrees.probeWorktreeDrift(worktreeSelector)
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
    return this.managedWorktrees.updateManagedWorktreeMeta(worktreeSelector, updates)
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    return this.managedWorktrees.persistManagedWorktreeSortOrder(orderedIds)
  }

  async resolveManagedPrBase(args: {
    repoSelector: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }): Promise<GitHubPrStartPoint | { error: string }> {
    return this.managedBaseCommands.resolveManagedPrBase(args)
  }

  async resolveManagedMrBase(args: {
    repoSelector: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }): Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  > {
    return this.managedBaseCommands.resolveManagedMrBase(args)
  }

  private rememberPreservedBranchCleanupTarget(
    worktreeId: string,
    hostId: ExecutionHostId | undefined,
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined,
    pushTarget: GitPushTarget | undefined
  ): void {
    return rememberPreservedBranchCleanupTargetImpl(
      this,
      worktreeId,
      hostId,
      result,
      fallbackHead,
      pushTarget
    )
  }

  private preserveBranchHeadFallback(
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined
  ): RemoveWorktreeResult {
    if (!result?.preservedBranch || result.preservedBranch.head || !fallbackHead) {
      return result ?? {}
    }
    return {
      ...result,
      preservedBranch: {
        ...result.preservedBranch,
        head: fallbackHead
      }
    }
  }

  async forceDeletePreservedBranch(
    worktreeSelector: string,
    branchName: string,
    expectedHead: string,
    hostId?: string
  ): Promise<ForceDeleteWorktreeBranchResult> {
    return forceDeletePreservedBranchImpl(this, worktreeSelector, branchName, expectedHead, hostId)
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
      if (!this.notifier?.renameTerminal && pty.pty.tabId) {
        this.terminalClusterFacade.persistHeadlessTerminalTitle(
          pty.pty.worktreeId,
          pty.pty.tabId,
          title
        )
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      return { handle, tabId: pty.pty.tabId ?? pty.record.tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  async ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    _caller: RuntimeAgentSessionRpcCaller = {},
    handoffAuthority?: { spawnToken: string; providerRoot: string; sessionId: string }
  ): Promise<RuntimeEnsureAgentSessionResult> {
    return this.agentClusterFacade.ensureAgentSession(request, _caller, handoffAuthority)
  }

  async createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeCreateAgentSessionResult> {
    return this.agentClusterFacade.createAgentSession(request, caller)
  }

  async createTerminal(
    worktreeSelector?: string,
    opts: TerminalCreateOptions = {}
  ): Promise<RuntimeTerminalCreate> {
    return this.terminalClusterFacade.createTerminal(worktreeSelector, opts)
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
    return this.terminalClusterFacade.dedupeTerminalCreate(
      clientIdentity,
      worktreeSelector,
      clientMutationId,
      reconcileExisting,
      run
    )
  }

  async launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<RuntimeTerminalCreate> {
    return this.agentClusterFacade.launchAgentTerminal(worktreeSelector, opts)
  }

  // Why: dedupes a worktree.create whose response was lost when a mobile
  // connection migration (relay/direct hand-off on shoddy cellular) rejected the
  // in-flight request. A retry with the same clientMutationId returns the
  // in-flight or just-finished create instead of a duplicate worktree; failures
  // drop immediately so a genuine retry starts fresh, and successes linger
  // briefly so a retry whose response was lost in the cutover still reconciles.
  dedupeWorktreeCreate<T>(
    repoSelector: string,
    clientMutationId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    return this.managedWorktrees.dedupeWorktreeCreate(repoSelector, clientMutationId, run)
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
    return this.terminalClusterFacade.createMobileSessionTerminal(worktreeSelector, opts)
  }

  // Why: publish an in-flight mobile create main-side from the live PTY so it can't stall on graph sync and destroy the session (#7587).
  private ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    return this.mobileSessionFacade.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, tabId)
  }

  private setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void {
    return this.ptyWorktrees.setPairedRendererSessionOwnership(ptyId, owned)
  }

  private findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null {
    return this.ptyWorktrees.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
  }

  // Why: looser rollback guard than findLiveRegisteredPtyForRendererTab — a shell without a registered pane key is still a real terminal the timeout must not kill (#7718).
  private hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean {
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktreeId && pty.tabId === tabId && pty.connected) {
        return true
      }
    }
    return false
  }

  // Why: a create can settle over a renderer PTY that spawned without its
  // startup command (the create's renderer stalled, #7587), silently binding
  // the client to a plain shell under an agent tab forever — once the surface
  // is ready, the activation-time materialize recovery (#7837) never runs
  // (STA-3214). Spawn commands are recorded per PTY at spawn time, so a
  // missing record on the locally registered live PTY proves the launch never
  // ran; type it into the shell like the create would have.
  private deliverPendingStartupCommandToBareRendererPty(worktreeId: string, tabId: string): void {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    const command = pending?.startupCommand
    if (!command) {
      return
    }
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (!pty || this.terminalSpawnCommandsByPtyId.has(pty.ptyId)) {
      return
    }
    if (this.ptyController?.write(pty.ptyId, command)) {
      // Why: Enter rides its own write so a long command cannot swallow it.
      this.ptyController.write(pty.ptyId, '\r')
      this.noteTerminalSpawnCommand(pty.ptyId, command)
    }
  }

  // Why: mobile may subscribe before the PTY spawns; wait for it so subscribe proceeds with phone-fit instead of a bare scrollback+end.
  waitForLeafPtyId(handle: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    return this.ptyWorktrees.waitForLeafPtyId(handle, timeoutMs, signal)
  }

  // Why: never-mounted tabs have no PTY or snapshot; synthetic handles need the ptyId to mount the exact owning tab.
  requestRendererTerminalTabMount(handle: string): boolean {
    return this.terminalClusterFacade.requestRendererTerminalTabMount(handle)
  }

  getRendererTerminalSerializerGeneration(ptyId: string): number {
    return this.terminalClusterFacade.getRendererTerminalSerializerGeneration(ptyId)
  }

  getRendererTerminalSerializerGenerationForHandle(handle: string): number {
    return this.terminalClusterFacade.getRendererTerminalSerializerGenerationForHandle(handle)
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
    return this.terminalClusterFacade.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      ptyId,
      snapshot,
      trailingOutput
    )
  }

  waitForRendererTerminalSerializer(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.terminalClusterFacade.waitForRendererTerminalSerializer(
      ptyId,
      afterGeneration,
      timeoutMs,
      signal
    )
  }

  async focusTerminal(
    handle: string,
    options: { navigateHost?: boolean } = {}
  ): Promise<RuntimeTerminalFocus> {
    return this.terminalClusterFacade.focusTerminal(handle, options)
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
    return this.terminalClusterFacade.closeTerminal(handle)
  }

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
    return this.terminalClusterFacade.closeTerminalTab(handle)
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
    return this.terminalClusterFacade.splitTerminal(handle, opts)
  }

  async handleAgentTeamsTmuxCompat(
    request: AgentTeamsTmuxCompatRequest
  ): Promise<AgentTeamsTmuxCompatResponse> {
    return this.agentClusterFacade.handleAgentTeamsTmuxCompat(request)
  }

  async prepareClaudeAgentTeamsLeader(args: {
    paneKey: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    return this.agentClusterFacade.prepareClaudeAgentTeamsLeader(args)
  }

  async prepareClaudeAgentTeamsLeaderForHandle(args: {
    handle: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    return this.agentClusterFacade.prepareClaudeAgentTeamsLeaderForHandle(args)
  }

  // Why: a leader handle that never binds to a PTY (lost pane race) has no exit
  // or close path to evict its team, so the abandoning caller must release it.
  releaseClaudeAgentTeamsLeaderForHandle(handle: string): void {
    return this.agentClusterFacade.releaseClaudeAgentTeamsLeaderForHandle(handle)
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
    return this.terminalClusterFacade.stopTerminalsForWorktree(worktreeSelector, options)
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    return this.terminalClusterFacade.sleepTerminalsForWorktree(worktreeSelector)
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    return this.terminalClusterFacade.acquireWorktreeTerminalSpawn(worktreeId)
  }

  private persistClientHostedBrowserPagesForWorktree(worktreeId: string): void {
    persistClientHostedBrowserPagesForWorktree(this, worktreeId)
  }

  private listWorkspaceSessionPartitions(): WorkspaceSessionState[] {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const repo of this.store?.getRepos?.() ?? []) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    return [...hostIds].flatMap((hostId) => {
      const session = this.store?.getWorkspaceSession?.(hostId)
      return session ? [session] : []
    })
  }
  async prefetchManagedWorktreeCreateBase(args: {
    repoSelector: string
    baseBranch?: string
  }): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    await prefetchWorktreeCreateBase({
      repo,
      baseBranch: args.baseBranch,
      runtime: this
    })
  }

  async removeManagedWorktree(
    worktreeSelector: string,
    force = false,
    runHooks = false,
    // Why (#11960): only an explicit Force Delete waives PTY-stop proof; `force`
    // alone is already set by the ordinary delete confirmation.
    allowUnverifiedPtyStop = false,
    hostId?: string
  ): Promise<RemoveWorktreeResult & { warning?: string }> {
    return removeManagedWorktreeImpl(
      this,
      worktreeSelector,
      force,
      runHooks,
      allowUnverifiedPtyStop,
      hostId
    )
  }

  private async stopPtysForDestructiveWorktreeRemoval(
    worktreeId: string,
    options: { connectionId?: string; allowUnverifiedStop?: boolean } = {}
  ): Promise<void> {
    const { connectionId, allowUnverifiedStop } = options
    const provider = connectionId ? this.getSshProviderFn?.(connectionId) : this.getLocalProvider()
    if (!provider) {
      throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
    }
    const teardownResult = await killAllProcessesForWorktree(worktreeId, {
      runtime: this,
      // Why: `repoId::path` ids repeat across hosts, so an unfenced sweep stops a same-id
      // workspace's terminals on another connection (mirrors the IPC removal path).
      resolvedWorktreeId: worktreeId,
      ...(connectionId ? { resolvedConnectionId: connectionId } : {}),
      localProvider: provider,
      onPtyStopped: this.onPtyStopped ?? undefined,
      requirePhysicalStop: true,
      // Why (#11960): set only by an explicit Force Delete, never by the ordinary
      // confirmation — otherwise the gate would be off on the primary delete path.
      ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {}),
      ...(connectionId ? { includeLocalRegistry: false } : {})
    })
    const total =
      teardownResult.runtimeStopped +
      teardownResult.providerStopped +
      teardownResult.registryStopped
    if (total > 0) {
      console.info(
        `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped}`
      )
    }
  }

  getLivePtyIdsForWorktree(worktreeId: string, freshPtyIds?: ReadonlySet<string>): Set<string> {
    return this.ptyWorktrees.getLivePtyIdsForWorktree(worktreeId, freshPtyIds)
  }
  private get clientSessionTabSelections() {
    return this.managedWorktrees.clientSessionTabSelections
  }
  private get worktreeLifecycleListeners() {
    return this.managedWorktrees.worktreeLifecycleListeners
  }
  private get optimisticReconcileTokens() {
    return this.managedWorktrees.optimisticReconcileTokens
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
    return this.terminalClusterFacade.stopExactTerminalsForWorktree(
      worktreeSelector,
      expectedPtyIds,
      opts
    )
  }

  private getTerminalHandlesForPtyId(ptyId: string): string[] {
    return this.terminalClusterFacade.getTerminalHandlesForPtyId(ptyId)
  }

  private getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[] {
    return this.terminalClusterFacade.getRecordedTerminalSleepHandles(
      ptyIds,
      terminalHandlesByPtyId
    )
  }

  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    return this.terminalClusterFacade.hasTerminalsForWorktree(worktreeSelector)
  }

  markRendererReloading(windowId: number): RuntimeRendererReloadFence | null {
    return this.orchestrationGraphReloadCommands.markRendererReloading(windowId)
  }

  private handleGraphReloadTimeout = (windowId: number): void => {
    this.orchestrationGraphReloadCommands.handleGraphReloadTimeout(windowId)
  }

  markRendererReloadCancelled(windowId: number, fence: RuntimeRendererReloadFence): boolean {
    return this.orchestrationGraphReloadCommands.markRendererReloadCancelled(windowId, fence)
  }

  markGraphReady(windowId: number): void {
    this.orchestrationGraphReloadCommands.markGraphReady(windowId)
  }

  markGraphReloadFailed(
    windowId: number,
    reason: 'renderer-frame-unavailable' | 'renderer-process-gone'
  ): void {
    this.orchestrationGraphReloadCommands.markGraphReloadFailed(windowId, reason)
  }

  markGraphUnavailable(windowId: number): void {
    this.orchestrationGraphReloadCommands.markGraphUnavailable(windowId)
  }

  private assertGraphReady(): void {
    return this.terminalClusterFacade.assertGraphReady()
  }

  private captureReadyGraphEpoch(): number {
    return this.terminalClusterFacade.captureReadyGraphEpoch()
  }

  private assertStableReadyGraph(expectedGraphEpoch: number): void {
    return this.terminalClusterFacade.assertStableReadyGraph(expectedGraphEpoch)
  }

  private resolveFolderWorkspaceConnectionId(workspace: FolderWorkspace): string | null {
    return this.terminalClusterFacade.resolveFolderWorkspaceConnectionId(workspace)
  }

  private async resolveFolderWorkspaceLaunchScope(
    selector: string
  ): Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null> {
    return this.terminalClusterFacade.resolveFolderWorkspaceLaunchScope(selector)
  }

  private resolveFolderWorkspaceSelector(selector: string): FolderWorkspace | null {
    return this.terminalClusterFacade.resolveFolderWorkspaceSelector(selector)
  }

  private async resolveEmulatorWorkspaceId(selector: string): Promise<string> {
    const folderWorkspace = this.resolveFolderWorkspaceSelector(selector)
    return folderWorkspace
      ? folderWorkspaceKey(folderWorkspace.id)
      : (await this.resolveWorktreeSelector(selector)).id
  }

  private async resolveBrowserWorkspace(selector: string): Promise<ResolvedWorktree> {
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(selector)
    return folderScope?.folderWorkspace
      ? this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace)
      : this.resolveWorktreeSelector(selector)
  }

  /**
   * Closes the window in which snapshots warn that this client's client-hosted pages are still
   * unaccounted for. Keyed by paired device because one client attaching says nothing about another.
   */
  markClientHostedPagesReconciled(pairedDeviceId: string): void {
    this.clientHostedPageReconciliation.markReconciled(pairedDeviceId)
  }

  /**
   * The execution-host key a client-hosted page in this workspace would be created under now.
   *
   * Adoption cannot reuse the key an inventory entry reports: native and WSL keys name the runtime
   * that minted them, and an SSH key carries a per-process provider epoch, so a restart always
   * invalidates them.
   *
   * The two failure modes are not the same answer. A workspace that no longer resolves is gone and
   * its pages have nothing left to be restored into; an execution host that is merely not up yet --
   * an SSH provider mid-reconnect, a project runtime still repairing -- is a "not now", and must
   * never be read as permission to retire the page.
   */
  async resolveBrowserExecutionHostKeyForWorkspace(
    workspaceId: string
  ): Promise<BrowserExecutionHostKeyResolution> {
    let worktree: ResolvedWorktree
    try {
      worktree = await this.resolveBrowserWorkspace(`id:${workspaceId}`)
    } catch {
      return { status: 'workspace-gone' }
    }
    try {
      return {
        status: 'resolved',
        executionHostKey: browserNetworkExecutionHostKey(
          await this.resolveBrowserNetworkExecutionHostForWorktree(worktree)
        )
      }
    } catch {
      return { status: 'unavailable' }
    }
  }

  private resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    return this.managedWorktrees.resolveBrowserNetworkExecutionHostForWorktree(worktree)
  }

  private async resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string> {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    return parsed?.type === 'folder'
      ? folderWorkspaceKey(parsed.folderWorkspaceId)
      : this.resolveEmulatorWorkspaceId(selector)
  }

  private folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    return this.managedWorktrees.folderWorkspaceToResolvedWorktree(folderWorkspace)
  }

  private resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined {
    return this.terminalClusterFacade.resolveWorkspaceTerminalStartupCwd(workspace, requestedCwd)
  }

  private async resolveTerminalWorkspaceLaunchScope(
    selector: string
  ): Promise<TerminalWorkspaceLaunchScope> {
    return this.terminalClusterFacade
      .resolveTerminalWorkspaceLaunchTarget(selector)
      .then((t) => t.scope)
  }

  private getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    return this.terminalClusterFacade.getValidatedExplicitWorktreeIdSelector(selector)
  }

  /** Resolves one workspace or throws `selector_not_found` / `selector_ambiguous` — never picks a winner. */
  private async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    return this.terminalClusterFacade.resolveWorktreeSelector(selector)
  }

  private async resolveWorkspaceParentSelector(selector: string): Promise<ResolvedWorkspaceParent> {
    const rawSelector = selector.startsWith('id:') ? selector.slice('id:'.length) : selector
    const parsed = parseWorkspaceKey(rawSelector)
    if (parsed?.type === 'folder') {
      const folderWorkspace = this.store
        ?.getFolderWorkspaces?.()
        .find((workspace) => workspace.id === parsed.folderWorkspaceId)
      if (!folderWorkspace) {
        throw new Error('selector_not_found')
      }
      return {
        type: 'folder',
        workspaceKey: folderWorkspaceKey(folderWorkspace.id),
        folderWorkspace,
        instanceId: null
      }
    }
    const worktreeSelector = parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    return {
      type: 'worktree',
      workspaceKey: worktreeWorkspaceKey(worktree.id),
      worktree,
      instanceId: worktree.instanceId ?? null
    }
  }

  private validateLineageParent(child: ResolvedWorktree, parent: ResolvedWorktree): void {
    validateLineageParent(
      { resolvedWorktreeCache: this.resolvedWorktreeCache, store: this.store },
      child,
      parent
    )
  }

  private async resolveLineageCandidateForTaskId(
    taskId: string
  ): Promise<WorktreeLineageCandidate | null> {
    const db = this.getOrchestrationDbIfAvailable()
    const dispatch = db?.getDispatchContext(taskId)
    // Why: agent-created tasks may never be dispatched, but the creating terminal still identifies the parent workspace.
    const parentHandle =
      dispatch?.assignee_handle ?? db?.getTask(taskId)?.created_by_terminal_handle
    if (!parentHandle) {
      return null
    }
    try {
      const terminal = await this.showTerminal(parentHandle)
      const parent = await this.resolveWorktreeSelector(`id:${terminal.worktreeId}`)
      return {
        source: 'orchestration-context',
        parent: {
          type: 'worktree',
          workspaceKey: worktreeWorkspaceKey(parent.id),
          worktree: parent,
          instanceId: parent.instanceId ?? null
        },
        taskId
      }
    } catch {
      return null
    }
  }

  private getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    return this.terminalClusterFacade.getOrchestrationDbIfAvailable()
  }

  async hydrateInferredWorktreeLineage(): Promise<void> {
    return this.managedWorktrees.hydrateInferredWorktreeLineage()
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.managedWorktrees.listWorktreeLineage()
  }

  async listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    await this.hydrateInferredWorktreeLineage()
    return this.store?.getAllWorkspaceLineage?.() ?? {}
  }

  // Why: one selector grammar, so connection-scoped resolution can narrow the same
  // candidate set instead of reimplementing (and diverging from) the matching rules.
  private selectReposBySelector(selector: string): Repo[] {
    const repos = this.store?.getRepos() ?? []
    if (selector.startsWith('id:')) {
      return repos.filter((repo) => repo.id === selector.slice(3))
    }
    if (selector.startsWith('path:')) {
      return repos.filter((repo) => runtimePathsEqual(repo.path, selector.slice(5)))
    }
    if (selector.startsWith('name:')) {
      return repos.filter((repo) => repo.displayName === selector.slice(5))
    }
    return repos.filter(
      (repo) =>
        repo.id === selector ||
        runtimePathsEqual(repo.path, selector) ||
        repo.displayName === selector
    )
  }

  private async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const candidates = this.selectReposBySelector(selector)

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('repo_not_found')
  }

  private requireStore(): Store {
    return this.terminalClusterFacade.requireStore()
  }

  private buildResolvedWorktreeFromId(worktreeId: string): ResolvedWorktree | null {
    return this.terminalClusterFacade.buildResolvedWorktreeFromId(worktreeId)
  }

  /** A warm fleet snapshot already answers any selector for free, so scoped scanning must yield to it. */
  private hasFreshResolvedWorktreeCache(): boolean {
    return this.resolvedWorktreeCache.hasFreshResolvedWorktreeCache()
  }

  private async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return this.resolvedWorktreeCache.listResolvedWorktrees()
  }

  private async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    return this.resolvedWorktreeCache.listResolvedWorktreeSnapshot()
  }

  private async resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null> {
    return this.resolvedWorktreeCache.resolveExplicitWorktreeIdScoped(worktreeId, requiredHostId)
  }

  private async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    return this.resolvedWorktreeCache.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
  }

  private async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return this.terminalClusterFacade.getResolvedWorktreeMap()
  }

  private invalidateResolvedWorktreeCache(): void {
    return this.resolvedWorktreeCache.invalidateResolvedWorktreeCache()
  }

  private invalidateWorktreeScanCacheForRepo(repoId: string): void {
    return this.resolvedWorktreeCache.invalidateWorktreeScanCacheForRepo(repoId)
  }

  private invalidateSshWorktreeScanCacheInternal(targetId: string): void {
    return this.resolvedWorktreeCache.invalidateSshWorktreeScanCacheInternal(targetId)
  }

  /** Invalidate the worktree cache and tell the renderer to re-list after an out-of-band branch change so the new name surfaces immediately. */
  notifyBranchRenamed(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifyWorktreesChanged(repoId)
  }

  /** Like {@link notifyBranchRenamed} but carries old->new worktree id so the renderer re-keys instead of treating the id change as a deletion. */
  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    return this.managedWorktrees.notifyWorktreeFolderRenamed(repoId, oldWorktreeId, newWorktreeId)
  }

  notifyFolderWorkspaceChanged(): void {
    this.invalidateResolvedWorktreeCache()
    this.notifyReposChanged()
  }

  private recordPtyWorktree(
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
    return this.ptyWorktrees.recordPtyWorktree(ptyId, worktreeId, state)
  }

  private makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string {
    return this.terminalClusterFacade.makeRuntimePaneKey(leaf)
  }

  private getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    return this.terminalClusterFacade.getOrCreatePtyWorktreeRecord(ptyId)
  }

  /** Synchronizes PTY tracking records with running daemon sessions, querying their foreground agent states. */
  private async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    return this.ptyWorktrees.refreshPtyWorktreeRecordsFromController(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
  }

  private async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    return this.terminalClusterFacade.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline,
      connectionId
    )
  }

  private refreshFloatingWorkspacePtyLiveness(): Set<string> | null {
    return this.ptyWorktrees.refreshFloatingWorkspacePtyLiveness()
  }

  private pruneDisconnectedPtyTranscript(pty: RuntimePtyWorktreeRecord): void {
    return this.ptyWorktrees.pruneDisconnectedPtyTranscript(pty)
  }

  private pruneDisconnectedPtyRecords(): void {
    return this.ptyWorktrees.pruneDisconnectedPtyRecords()
  }

  private leafExistsForPty(ptyId: string): boolean {
    return this.ptyWorktrees.leafExistsForPty(ptyId)
  }

  private rebuildLeafPtyIndex(): void {
    return this.ptyWorktrees.rebuildLeafPtyIndex()
  }

  private getLeavesForPty(ptyId: string): RuntimeLeafRecord[] {
    return this.terminalClusterFacade.getLeavesForPty(ptyId)
  }

  getPtyAgent(ptyId: string): TuiAgent | null {
    return this.agentClusterFacade.getPtyAgent(ptyId)
  }

  getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    return this.agentClusterFacade.getAgentPromptActivity(handle, ptyId, waitTextCache)
  }

  private getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    return this.managedWorktrees.getSummaryForRuntimeWorktreeId(
      summaries,
      runtimeWorktreeSummaryPathIndex,
      missingRuntimeWorktreeIds,
      runtimeWorktreeId
    )
  }

  /** Thin adapter so the summary builders stay declarative; the decision lives in `src/shared`. */
  private resolvePaneAgentIdentityField(
    launchAgent: TuiAgent | null | undefined,
    foregroundAgent: TuiAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ): { agentIdentity?: TuiAgent } {
    return this.agentClusterFacade.resolvePaneAgentIdentityField(
      launchAgent,
      foregroundAgent,
      title,
      paneKey
    )
  }

  // Why: the PTY id names its own host when it has one; only a host-less id may
  // fall back to the worktree's. A foreign id with no owner stays unset rather
  // than inheriting a local worktree's host and reading as local.
  private terminalExecutionHostField(
    ptyId: string | null,
    worktreeId: string
  ): { executionHostId?: ExecutionHostId } {
    const fromPtyId = getPtyExecutionHost(ptyId)
    if (fromPtyId === 'foreign') {
      return {}
    }
    const hostId = fromPtyId ?? this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    return hostId ? { executionHostId: hostId } : {}
  }

  // Returns the worktrees whose stored snapshot object changed during this
  // sync, so the caller can fan out only actually-changed worktrees.
  private syncMobileSessionTabs(
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds = new Set<string>()
  ): Set<string> {
    return this.mobileSessionFacade.syncMobileSessionTabs(
      snapshots,
      unchangedWorktreeIds,
      resyncWorktreeIds
    )
  }

  private readonly clientHostedBrowserRows = new ClientHostedBrowserRowPublisher({
    listClientPages: (worktreeId) => getRuntimeBrowserPageRegistry(this).listPages(worktreeId),
    hasLivePlacement: (browserPageId) =>
      getBrowserHostLeaseRegistry(this).getPlacement(browserPageId) !== undefined,
    resolveDeviceName: (pairedDeviceId) => this.getPairedDeviceNameFn(pairedDeviceId),
    getEmitter: () => {
      const notifier = this.notifier
      const send = notifier?.clientHostedBrowserRowsChanged
      return send ? (event) => send.call(notifier, event) : null
    }
  })

  /** Worktrees whose persisted client-hosted rows this runtime is responsible for rewriting. */
  private readonly persistedClientHostedBrowserWorktreeIds = new Set<string>()

  /** Serves a hydrating host renderer; the publisher counts this as a delivery, not a read. */
  listClientHostedBrowserRows(): ClientHostedBrowserRowsEvent[] {
    return this.clientHostedBrowserRows.deliverHydrationSnapshot()
  }

  notifyMobileSessionTabsChanged(worktreeId?: string): void {
    return this.mobileTabOperations.notifyMobileSessionTabsChanged(worktreeId)
  }

  private scheduleMobileSessionTabsChanged(worktreeId: string): void {
    return this.mobileSessionFacade.scheduleMobileSessionTabsChanged(worktreeId)
  }

  private notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    return this.mobileTabOperations.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  private getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.mobileTabOperations.getMobileSessionTabsForWorktree(worktreeId, clientNavigationId)
  }

  private getLiveBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo> {
    const liveTabs = this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []
    const byPageId = new Map(liveTabs.map((tab) => [tab.browserPageId, tab]))
    for (const [index, page] of getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .entries()) {
      byPageId.set(page.browserPageId, {
        browserPageId: page.browserPageId,
        index: liveTabs.length + index,
        url: page.url,
        title: page.title,
        active: page.active,
        worktreeId,
        profileId: page.browserProfileId
      })
    }
    return byPageId
  }

  private collectReturnedSessionTabIds(
    tabs: readonly RuntimeMobileSessionClientTab[]
  ): Set<string> {
    const ids = new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      } else if (tab.type === 'browser') {
        ids.add(tab.browserWorkspaceId)
      }
    }
    return ids
  }

  /** Transforms an internal mobile session tab snapshot into a sanitized client payload, resolving launch-agent ownership and normalizing titles. */
  private toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    return this.mobileSessionFacade.toMobileSessionTabsResult(snapshot)
  }

  private getHookAgentRowForPane(rows: readonly AgentStatusIpcPayload[]): {
    providerSession: AgentProviderSessionMetadata | null
    providerSessionAgentType: string | null
    providerSessionReceivedAt: number | null
    agentType: string | null
    agentIsLive: boolean
    live: HookLiveAgentRow | null
  } {
    return this.agentClusterFacade.getHookAgentRowForPane(rows)
  }

  private findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    return this.mobileTabOperations.findPtyForMobileTerminalTab(worktreeId, tab, options)
  }

  private getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    return this.terminalClusterFacade.getMobileTerminalPaneKey(tab)
  }

  // Why: group address resolution (Section 4.5) queries per-handle status and must not throw on stale handles; return null on any error.
  getAgentStatusForHandle(handle: string): string | null {
    return this.agentClusterFacade.getAgentStatusForHandle(handle)
  }

  getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined {
    return this.agentClusterFacade.getAgentStatusOrchestrationContextForPaneKey(paneKey)
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.agentClusterFacade.getAgentStatusTerminalHandleForPaneKey(paneKey)
  }

  getAgentStatusLaunchConfigForPaneKey(
    paneKey: string,
    args?: { launchToken?: string }
  ): SleepingAgentLaunchConfig | undefined {
    return this.agentClusterFacade.getAgentStatusLaunchConfigForPaneKey(paneKey, args)
  }

  private buildAgentOrchestrationByPaneKey():
    | Record<string, AgentStatusOrchestrationContext>
    | undefined {
    return this.agentClusterFacade.buildAgentOrchestrationByPaneKey()
  }

  private getRecentSettledDispatchForTerminal(
    handle: string,
    db = this.getOrchestrationDbIfAvailable()
  ): ReturnType<OrchestrationDb['getLatestDispatchForTerminal']> {
    return this.terminalClusterFacade.getRecentSettledDispatchForTerminal(handle, db)
  }

  // Why: public because automation completion watching runs in main but the
  // pane→handle mapping is runtime-owned state.
  getTerminalHandleForPaneKey(paneKey: string): string | null {
    return this.terminalClusterFacade.getTerminalHandleForPaneKey(paneKey)
  }

  private getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null {
    return this.terminalClusterFacade.getPtyRecordForPaneKey(paneKey)
  }

  private getPaneKeyForTerminalHandle(handle: string): string | null {
    return this.terminalClusterFacade.getPaneKeyForTerminalHandle(handle)
  }

  private getWorktreeIdForTerminalHandle(handle: string): string | null {
    return this.terminalClusterFacade.getWorktreeIdForTerminalHandle(handle)
  }

  private setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void {
    return this.terminalClusterFacade.setPtyManagementTitleFromObservedTitle(pty, title, observedAt)
  }

  private nextTitleObservationSequence(): number {
    return this.terminalClusterFacade.nextTitleObservationSequence()
  }

  // Why: title is the tightest agent-presence signal, but a Claude management title is negative evidence for task activity.
  async isTerminalRunningAgent(
    handle: string,
    options: { retryForegroundWrappers?: boolean } = {}
  ): Promise<boolean> {
    return this.agentClusterFacade.isTerminalRunningAgent(handle, options)
  }

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    return this.agentClusterFacade.isTerminalRunningSettledPromptAgent(handle)
  }

  private async isRecognizedForegroundAgentProcess(
    ptyId: string,
    foregroundProcess: string,
    options: { suppressClaude?: boolean; retryWrappers?: boolean } = {}
  ): Promise<boolean> {
    return this.agentClusterFacade.isRecognizedForegroundAgentProcess(
      ptyId,
      foregroundProcess,
      options
    )
  }

  private getPrimaryLeafForPty(ptyId: string): RuntimeLeafRecord | null {
    return this.ptyWorktrees.getPrimaryLeafForPty(ptyId)
  }

  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.orchestrationMailboxNotifications.deliverForHandle(handle, reservedTypes)
  }

  /** Admission snapshot taken when a mailbox pointer's text lands, asserted again
   *  before its Enter. The two writes straddle a 500ms pause, so a structured
   *  session that re-leases the pty in between must not receive the submit. */
  private readonly orchestrationPointerAdmissionByPtyId = new Map<
    string,
    AgentSessionPtyWriteAdmittance
  >()

  private writeOrchestrationPointerPty(ptyId: string, data: string): boolean | Promise<boolean> {
    return this.orchestrationCommands.writeOrchestrationPointerPty(ptyId, data)
  }

  private retireOrchestrationMailboxDeliveryForPty(ptyId: string): void {
    this.orchestrationMailboxNotifications.retirePty(ptyId)
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        this.mailPointerRepointScheduler.schedule(handle)
      }
      const run = this._orchestrationDb?.getCurrentRunForPane?.(`${leaf.tabId}:${leaf.leafId}`)
      if (run) {
        this.mailPointerRepointScheduler.schedule(`run:${run.id}`)
      }
    }
  }

  private scheduleRestoredMessageRepoints(): void {
    let handles: string[]
    try {
      handles = this._orchestrationDb?.getUndeliveredUnreadMailboxHandles?.() ?? []
    } catch (error) {
      console.warn('[orchestration] failed to scan restored mailboxes', error)
      return
    }
    for (const handle of handles) {
      try {
        if (handle.startsWith('dispatch:')) {
          continue
        }
        if (handle.startsWith('run:')) {
          this.mailPointerRepointScheduler.schedule(handle)
          continue
        }
        const routed = this.orchestrationMailboxOwner.routeDetachedDirectMessages(handle)
        for (const mailbox of routed.mailboxes) {
          this.mailPointerRepointScheduler.schedule(mailbox.mailboxHandle)
        }
        if (!routed.hasMore) {
          this.mailPointerRepointScheduler.schedule(handle)
        }
      } catch (error) {
        console.warn(`[orchestration] failed to restore mailbox ${handle}`, error)
        this.mailPointerRepointScheduler.schedule(handle)
      }
    }
  }

  private repointPendingMessagesForHandle(handle: string): void {
    try {
      this.deliverPendingMessagesForHandle(handle)
    } catch {
      // The unref'd repair can outlive a test/runtime-owned database during shutdown.
    }
  }

  private deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void {
    this.orchestrationMailboxNotifications.deliverForLeaf(leaf)
  }

  // Why: wake blocking orchestration.check --wait calls on this handle so they return the new message immediately instead of polling.
  notifyMessageArrived(handle: string, messageType?: string): void {
    if (!handle.startsWith('dispatch:')) {
      this.mailPointerRepointScheduler.schedule(handle)
    }
    this.orchestrationMailboxNotifications.notifyMessageArrived(handle, messageType)
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
    return this.terminalClusterFacade.waitForMessage(handle, options)
  }

  cancelMessageWaiters(handle: string): void {
    return this.terminalClusterFacade.cancelMessageWaiters(handle)
  }

  private resolveMessageWaiter(waiter: MessageWaiter, result: MessageWaitResult): void {
    return this.terminalClusterFacade.resolveMessageWaiter(waiter, result)
  }

  private getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    return this.terminalClusterFacade.getLiveLeafForHandle(handle)
  }

  private getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    return this.terminalClusterFacade.getLivePtyForHandle(handle)
  }

  private assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    return this.terminalClusterFacade.assertLiveTerminalHandleTargetsPty(handle, expectedPtyId)
  }

  private issueHandle(leaf: RuntimeLeafRecord): string {
    return this.terminalClusterFacade.issueHandle(leaf)
  }

  private invalidatePtyIncarnationHandle(ptyId: string): void {
    return this.ptyWorktrees.invalidatePtyIncarnationHandle(ptyId)
  }

  private clearPtyIncarnationHandles(): void {
    return this.ptyWorktrees.clearPtyIncarnationHandles()
  }

  private reconcilePtyIncarnationHandles(): void {
    return this.ptyWorktrees.reconcilePtyIncarnationHandles()
  }

  private adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    return this.ptyWorktrees.adoptPreAllocatedHandle(leaf)
  }

  private issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    return this.ptyWorktrees.issuePtyHandle(pty)
  }

  private findHandleForPtyRecord(ptyId: string): string | null {
    return this.ptyWorktrees.findHandleForPtyRecord(ptyId)
  }

  private refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  private invalidateLeafHandle(leafKey: string): void {
    return this.ptyWorktrees.invalidateLeafHandle(leafKey)
  }

  private adoptFirstPtyForLeafHandle(
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    return this.ptyWorktrees.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
  }

  private rememberDetachedPreAllocatedLeaves(): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId && this.handleByPtyId.has(leaf.ptyId)) {
        // Why: ORCA_TERMINAL_HANDLE is an agent identity, so CLI control survives renderer graph loss while the PTY is alive.
        this.detachedPreAllocatedLeaves.set(leaf.ptyId, leaf)
      }
    }
  }

  private resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    return this.terminalClusterFacade.resolveExitWaiters(leaf)
  }

  private resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    return this.terminalClusterFacade.resolveTuiIdleWaiters(leaf)
  }

  private resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    return this.terminalClusterFacade.resolvePtyExitWaiters(pty, ptyId)
  }

  private resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    return this.terminalClusterFacade.resolvePtyTuiIdleWaiters(pty, ptyId)
  }

  private rejectWaitersForHandle(handle: string, code: string): void {
    return this.terminalClusterFacade.rejectWaitersForHandle(handle, code)
  }

  private rejectAllWaiters(code: string): void {
    return this.terminalClusterFacade.rejectAllWaiters(code)
  }

  private getLeafKey(tabId: string, leafId: string): string {
    return this.terminalClusterFacade.getLeafKey(tabId, leafId)
  }

  // ── Browser automation ──

  routeClientHostedBrowserRpc(
    method: string,
    params: unknown
  ): Promise<ClientHostedBrowserRpcRoute> {
    return routeRuntimeBrowserClientAutomation({
      method,
      params,
      pages: getRuntimeBrowserPageRegistry(this),
      leases: getBrowserHostLeaseRegistry(this),
      resolveWorkspace: (selector) => this.resolveBrowserWorkspace(selector)
    })
  }

  private readonly browserCommands = createRuntimeBrowserCommands({
    getAgentBrowserBridge: () => this.agentBrowserBridge,
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveBrowserWorkspace: (selector) => this.resolveBrowserWorkspace(selector),
    getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this),
    getRuntimeBrowserPageRegistry: () => getRuntimeBrowserPageRegistry(this),
    resolveBrowserNetworkExecutionHost: (worktree) =>
      this.resolveBrowserNetworkExecutionHostForWorktree(worktree),
    getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
    getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
    getOffscreenBrowserBackend: () => this.offscreenBrowserBackend,
    // Why: bind directly, not a wrapper arrow — a hand-listed wrapper dropped targetGroupId, so a right-split browser landed in the left.
    markHeadlessBrowserSessionTabActive: this.markHeadlessBrowserSessionTabActive.bind(this),
    notifyHeadlessBrowserSessionTabsChanged: (worktreeId) =>
      this.notifyMobileSessionTabsChanged(worktreeId),
    retireRuntimeOwnedBrowserSessionTab: (worktreeId, browserPageId) =>
      this.retireRuntimeOwnedBrowserSessionTab(worktreeId, browserPageId)
  })

  private readonly browserScreencastCommands = new RuntimeBrowserScreencastCommands({
    browserCommands: this.browserCommands,
    activeBrowserScreencastsByConnection: this.activeBrowserScreencastsByConnection,
    activeBrowserScreencastsByPage: this.activeBrowserScreencastsByPage,
    browserRemoteViewerPages: this.browserRemoteViewerPages,
    currentBrowserDriver: this.currentBrowserDriver,
    getBrowserDriver: (browserPageId) => this.getBrowserDriver(browserPageId),
    setBrowserDriver: (browserPageId, next) => this.setBrowserDriver(browserPageId, next),
    publishBrowserRemoteViewers: (browserPageId) => this.publishBrowserRemoteViewers(browserPageId),
    registerSubscriptionCleanup: (subscriptionId, cleanup, connectionId) =>
      this.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId),
    cleanupSubscription: (subscriptionId) => this.cleanupSubscription(subscriptionId),
    notifier: this.notifier
  })

  private readonly emulatorCommands = new RuntimeEmulatorCommands({
    getEmulatorBridge: () => this.emulatorBridge,
    resolveEmulatorWorkspaceId: (selector) => this.resolveEmulatorWorkspaceId(selector),
    resolveEmulatorCleanupWorkspaceId: (selector) =>
      this.resolveEmulatorCleanupWorkspaceId(selector),
    getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
    getSettings: () => this.requireStore().getSettings()
  })

  private getAuthoritativeWindow(): BrowserWindow {
    return this.terminalClusterFacade.getAuthoritativeWindow()
  }

  private getAvailableAuthoritativeWindow(): BrowserWindow | null {
    if (this.authoritativeWindowId === null) {
      return null
    }
    const win = getRuntimeDesktopSurface().findWindowById(this.authoritativeWindowId)
    return win && !win.isDestroyed() ? win : null
  }

  private readonly snapshotValueComparison: RuntimeMobileSnapshotValueComparisonCommands
  private readonly mobileSnapshotMerge: RuntimeMobileSnapshotMergeCommands
  private readonly mobileTabSnapshots: RuntimeMobileSessionTabSnapshotCommands

  // eslint-disable @typescript-eslint/no-explicit-any -- Delegation methods use any to forward arbitrary arguments
  // Delegation methods for RuntimeMobileSnapshotValueComparisonCommands:

  collectBrowserGroupAssignment(persistedGroups: unknown, mergedBrowserOrder: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic forward
    return (this as any).collectBrowserGroupAssignment(persistedGroups, mergedBrowserOrder)
  }

  isServeOwnedPtyId(ptyId: string | null | undefined) {
    return this.ptyWorktrees.isServeOwnedPtyId(ptyId)
  }

  isSshOwnedPtyId(ptyId: string | null | undefined) {
    return this.ptyWorktrees.isSshOwnedPtyId(ptyId)
  }

  workspaceSessionHasRuntimeOwnedPtyCandidate(session: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic forward
    return (this as any).workspaceSessionHasRuntimeOwnedPtyCandidate(session)
  }

  workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    session: unknown,
    worktreeId: string,
    tabs: unknown
  ) {
    return this.managedWorktrees.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
      session,
      worktreeId,
      tabs
    )
  }

  getRecentExpiredSshLease(worktreeId: string, tabId: string, leafId: string, ptyId: string) {
    return this.terminalClusterFacade.getRecentExpiredSshLease(worktreeId, tabId, leafId, ptyId)
  }

  hasRecentExpiredSshLeasePane(worktreeId: string, tab: unknown) {
    return (this.snapshotValueComparison as any).hasRecentExpiredSshLeasePane(worktreeId, tab)
  }

  isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean {
    return this.mobileSnapshotMerge.isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch)
  }

  private isHeadlessMobileSessionPublication(publicationEpoch: string): boolean {
    return (
      publicationEpoch.startsWith('headless:') ||
      publicationEpoch.startsWith('headless-hydrated:') ||
      publicationEpoch.includes(':headless-merge:')
    )
  }

  isServeOrSshOwnedPtyId(ptyId: string | null | undefined) {
    return this.ptyWorktrees.isServeOrSshOwnedPtyId(ptyId)
  }

  hasServeOrSshOwnedBinding(tab: unknown) {
    return (this.snapshotValueComparison as any).hasServeOrSshOwnedBinding(tab)
  }

  hasLiveOrPersistedServeOrSshOwnedPtyBinding(worktreeId: string, tab: unknown) {
    return (this.snapshotValueComparison as any).hasLiveOrPersistedServeOrSshOwnedPtyBinding(
      worktreeId,
      tab
    )
  }

  hasLiveRuntimeSessionOwnedPtyBinding(worktreeId: string, tab: unknown) {
    return (this.snapshotValueComparison as any).hasLiveRuntimeSessionOwnedPtyBinding(
      worktreeId,
      tab
    )
  }

  clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: unknown,
    parentTabId: string
  ) {
    return this.mobileTabOperations.clearRuntimeSessionOwnershipForMobileTab(
      worktreeId,
      snapshot,
      parentTabId
    )
  }

  releaseRuntimeSessionOwnershipForRendererRetiredTabs(snapshot: unknown, existing: unknown) {
    return (
      this.snapshotValueComparison as any
    ).releaseRuntimeSessionOwnershipForRendererRetiredTabs(snapshot, existing)
  }

  // Delegation methods for RuntimeMobileSnapshotMergeCommands:

  // Delegation methods for RuntimeMobileSessionTabSnapshotCommands:

  retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): void {
    return this.mobileTabSnapshots.retireMobileSessionSurfacesForPty(
      ptyId,
      incarnationId,
      exactSurfaces
    )
  }

  touchMobileSessionSnapshotsForPty(ptyId: string, options?: { immediate?: boolean }): void {
    return this.terminalClusterFacade.touchMobileSessionSnapshotsForPty(ptyId, options)
  }

  touchMobileSessionTabsForWorktree(worktreeId: string, options?: { immediate?: boolean }) {
    return this.mobileSessionFacade.touchMobileSessionTabsForWorktree(worktreeId, options)
  }

  removePersistedHeadlessTerminalTab(
    worktreeId: string,
    parentTabId: string,
    options?: { allowMissing?: boolean }
  ) {
    return this.mobileTabSnapshots.removePersistedHeadlessTerminalTab(
      worktreeId,
      parentTabId,
      options
    )
  }

  persistHeadlessTerminalTabOrder(worktreeId: string, tabOrder: string[]) {
    return this.terminalClusterFacade.persistHeadlessTerminalTabOrder(worktreeId, tabOrder)
  }

  emitMobileSessionTabsSnapshot(snapshot: unknown) {
    return this.mobileTabOperations.emitMobileSessionTabsSnapshot(snapshot)
  }

  projectMobileSessionTabsForClient(result: unknown, clientNavigationId?: string) {
    return this.clientSessionTabSelections.project(
      this.withClientHostedPagesHold(result, clientNavigationId),
      clientNavigationId
    )
  }

  withClientHostedPagesHold(snapshot: unknown, clientNavigationId?: string) {
    return this.clientHostedPageReconciliation.holdFor(
      snapshot as never,
      clientNavigationId,
      Date.now()
    )
  }

  isMobileSessionSurfaceMembershipAllowed(
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null | undefined
  ): boolean {
    return (this.mobileTabSnapshots as any).isMobileSessionSurfaceMembershipAllowed(
      worktreeId,
      parentTabId,
      leafId,
      candidatePtyId
    )
  }

  private reconcileMobileSessionRetirementFences(
    leaves: readonly RuntimeSyncedLeaf[]
  ): RuntimeSyncedLeaf[] {
    return (this.mobileTabSnapshots as any).reconcileMobileSessionRetirementFences(leaves)
  }

  private applyMobileSessionRetirementFences(...args: any[]): any {
    return (this.mobileTabSnapshots as any).applyMobileSessionRetirementFences(...args)
  }

  private hasHostAuthoritativeTerminalMembership(
    session: WorkspaceSessionState | undefined,
    worktreeId: string
  ): boolean {
    return hasHostAuthoritativeTerminalMembership(session, worktreeId)
  }

  // eslint-enable @typescript-eslint/no-explicit-any
}

// Re-export shims for WP7 batch extraction (runtime-browser-screencast.ts)
export { buildPreview } from './runtime-tail-read'
export { reclaimBrowserForDesktop }
export { publishBrowserRemoteViewers }
export { getBrowserRemoteViewerPages }
export { setBrowserDriver }
export { getBrowserDriver }
export { getAllBrowserDrivers }
export { persistClientHostedBrowserPagesForWorktree }
export { rehydrateClientHostedBrowserPages }

import {
  DEFAULT_TERMINAL_LIST_LIMIT,
  DEFAULT_WORKTREE_PS_LIMIT,
  FETCH_FRESHNESS_MS,
  MAX_TAIL_CHARS,
  REMOTE_FETCH_CACHE_MAX,
  WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS,
  WAIT_BLOCKED_KEYWORD_CARRY_CHARS,
  WAIT_BLOCKED_KEYWORD_PATTERN,
  buildTerminalWaitText,
  classifyAgentTitle,
  computeTerminalTailWaitState,
  detectTerminalWaitBlockedReason,
  getLatestAgentCandidateTitle,
  getLatestPtyTitle,
  isKnownReadyPromptPreview,
  notifyRuntimeListeners,
  runtimePathsEqual,
  runtimeWorktreeIdsEqual,
  setBoundedMapEntry,
  tailGainedNewerBlockedReason,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-tail-projection'
import { RuntimeResolvedWorktreeCache } from './runtime-resolved-worktree-cache'
import {
  RuntimeManagedWorktrees,
  type RuntimeManagedWorktreeCreateArgs
} from './runtime-managed-worktrees'
import { RuntimePtyWorktrees } from './runtime-pty-worktrees'
import { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'
import { buildMobileSessionFacadeDepsImpl } from './runtime-mobile-session-facade-wiring'
import { buildPtyWorktreesDepsImpl } from './runtime-pty-worktrees-wiring'
import { buildTerminalClusterFacadeDepsImpl } from './runtime-terminal-cluster-facade-wiring'
import { buildManagedWorktreesDepsImpl } from './runtime-managed-worktrees-wiring'
import { buildAgentClusterFacadeDepsImpl } from './runtime-agent-cluster-facade-wiring'
import { RuntimeMobileSessionFacade } from './runtime-mobile-session-facade'
import { RuntimeAgentClusterFacade } from './runtime-agent-cluster-facade'
import { RuntimeManagedBaseCommands } from './runtime-managed-base-commands'
import { RuntimeRemoteDesktopCommands } from './runtime-remote-desktop-commands'
import { RuntimeClientConnectionCommands } from './runtime-client-connection-commands'
import { RuntimeMobileTabOperations } from './runtime-mobile-tab-operations'
import { RuntimeWorktreePs } from './runtime-worktree-ps'
import { RuntimeWindowGraphClientCommands } from './runtime-window-graph-client-commands'
import { RuntimeTerminalRecoveryCommands } from './runtime-terminal-recovery-commands'
import { RuntimeWorkspaceFileTargetCommands } from './runtime-workspace-file-target-commands'
import {
  buildMobileTabOperationsDepsImpl,
  buildTerminalRecoveryCommandsDepsImpl,
  buildWindowGraphClientCommandsDepsImpl,
  buildWorktreePsDepsImpl
} from './runtime-ctor-wiring'
import { buildOrchestrationGraphReloadDepsImpl } from './runtime-orchestration-graph-reload-wiring'
import { buildPtyTitleTrackingCommandsDepsImpl } from './runtime-pty-title-tracking-wiring'
import type {
  RuntimeWorktreeSummaryPathIndex,
  TerminalTailWaitState
} from './runtime-tail-projection'

export {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  resolveWorktreeScanCacheTtlMs,
  buildRestoredTerminalTailSeed,
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  appendNormalizedToTailBuffer,
  appendNormalizedToMultilineTailBufferUnwindowed,
  projectTerminalTailLines
} from './runtime-tail-projection'
export type { TerminalTailWaitState } from './runtime-tail-projection'

// WP5: Mobile Session State re-exports
export {
  runCreateMobileSessionTerminal,
  removeWorktreeMetadataAndHistory,
  buildTerminalVisualLayouts,
  onExternalPtyResize,
  updateMobileSubscriberViewport,
  setMobileDisplayMode,
  isMobileSubscriberActive,
  beginMobileInputFloor,
  markMobileActor,
  recordRendererGeometry,
  refreshRendererGeometry,
  refreshRemoteDesktopViewer,
  unregisterRemoteDesktopViewers,
  claimRemoteDesktopHost,
  claimRemoteDesktopViewer,
  updateRemoteDesktopViewer,
  bumpRemoteDesktopViewerRevision,
  hasRemoteDesktopLayoutState,
  recordRemoteDesktopHostReclaimTarget,
  ensureRemoteDesktopHostReclaimTarget,
  isRemoteDesktopViewerOwner,
  isRemoteDesktopResizeDriven,
  onClientDisconnected,
  applyRemoteDesktopLayout,
  resolveRemoteDesktopHostReclaimTarget,
  activeRemoteDesktopViewport,
  hasRemoteDesktopViewers,
  getAllTerminalFitOverrides,
  mobileTookFloor,
  applyMobileDisplayMode,
  resolveDesktopRestoreTarget,
  getMobileDisplayMode,
  isMobileTerminalQueryReplyAuthority,
  publishStructuredAgentSessionTab,
  findMobileTerminalSurfaceForPty,
  resolveMobileMarkdownWorktreeId,
  setMobileSessionTabProps,
  updateMobileSessionPaneLayout,
  moveMobileSessionTab,
  moveHeadlessMobileSessionTab,
  moveHeadlessMobileSessionTabToGroup,
  splitHeadlessMobileSessionTabGroup,
  markHeadlessBrowserSessionTabActive,
  closeMobileSessionTab,
  closeStructuredAgentSessionTab,
  retireRuntimeOwnedBrowserSessionTab,
  closeHeadlessMobileTerminalTab,
  republishMobileSessionTabsSnapshot,
  activateMobileSessionTab,
  activateHeadlessMobileSessionTerminalTab,
  createRuntimeOwnedMobileSessionTerminal,
  findMobileTerminalSurface,
  collectAllMobileSessionTabs,
  scheduleMobileSessionTabsChanged,
  syncMobileSessionTabs,
  publishPtyBackedMobileSessionTerminal,
  publishRecoveredSshMobileSessionTabs,
  notifyMobileSessionTabsChanged,
  notifyMobileSessionTabsChangedNow,
  cancelScheduledMobileSessionTabsChanged,
  getMobileSessionTabsForWorktree,
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession,
  hasRemoteTerminalViewSubscriber
} from './runtime-mobile-session-state'

// WP6: Layout Restore State re-exports
export {
  waitForMessage,
  cancelMessageWaiters,
  removeMessageWaiter,
  subscribeToTerminalResize,
  getLastRendererSize,
  handleMobileUnsubscribe,
  getLayout,
  cancelAllPendingFitRestoreTimers,
  reclaimTerminalForDesktop,
  updateMobileViewport,
  updateDesktopViewport,
  resizeForClient,
  handleMobileSubscribeInternal,
  enqueueLayout,
  runLayoutSlot,
  applyLayout,
  notifyTerminalResize,
  isFreshSubscribe,
  cancelPendingDriverMutations
} from './runtime-layout-restore-state'

// WP3: Liveness Verdict re-exports (9 methods, 270 LOC)
export {
  isLeafPtyProvenAbsent,
  isPtyStopRequested,
  cancelPendingPtyRegistration,
  beginPtyRegistration,
  onPtySpawned,
  markPtyStopRequested,
  registerPty,
  releaseRejectedPtyRegistrationFence,
  assertPtyDidNotExitBeforeRegistration
} from './runtime-liveness-verdict'

// WP2: Handle/Leaf Registry structure set up (52 methods, 1560 LOC)
// Extraction in progress - methods remain in OrcaRuntimeService pending full refactoring
