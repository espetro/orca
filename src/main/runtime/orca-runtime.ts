/* eslint-disable max-lines -- Why: OrcaRuntimeService still owns the mutable live graph, PTY handles, waiters, mobile floor/layout state, and managed-worktree reconciliation. Stateless browser and file command adapters live beside it; the remaining split points need state-owner extraction before enforcing max-lines. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
import {
  detectAgentStatusFromTitle,
  extractLastOscTitle,
  isShellProcess
} from '../../shared/agent-detection'

import { isArtifactSharingEnabled } from '../../shared/artifact-sharing-gate'
import {
  assertAgentSkillSharingAllowed,
  isAgentSkillSharingEnabled
} from '../../shared/agent-skill-sharing-gate'
import { resolveNestedWorkerMaxDepth } from '../../shared/nested-worker-depth'
import { RuntimeLinearCommands } from './runtime-linear-commands'
import { RuntimeProjectWorktreeCommands } from './runtime-project-worktree-commands'
import { RuntimeRepoGitCommandsFacade } from './runtime-repo-git-commands'
import { RuntimeSkillArtifactCommands } from './runtime-skill-artifact-commands'
import { RuntimeSkillInstallCommands } from './runtime-skill-install-commands'
import { RuntimeAccountCommands } from './runtime-account-commands'
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
import type { RuntimeOrchestrationGraphReloadCommandsDeps } from './runtime-orchestration-graph-reload-commands-deps'
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
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
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
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload,
  type AgentStatusOrchestrationContext
} from '../../shared/agent-status-types'
import { terminalStatusPayloadMatchesHook } from '../../shared/agent-terminal-status-equivalence'
import type { AgentHookAuthorityAttestation } from '../agent-hooks/server'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding,
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../shared/agent-session-host-authority'
import {
  canonicalizeAgentSessionIdentity,
  createEphemeralAgentSessionClaimSigner,
  type AgentSessionClaimSigner
} from './agent-session-claim-identity'
import {
  ensureStructuredAgentSessionHost as installStructuredAgentSessionHost,
  hasPersistedStructuredAgentSessionStore as hasPersistedStructuredAgentSessionStoreOnDisk
} from './structured-agent-session-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import {
  StructuredTuiLaunchCleanupError,
  type StructuredAgentSessionHandoffTransport,
  type StructuredTuiOwner
} from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionProviderHandleRoot,
  agentSessionProviderHandlesEqual
} from '../../shared/agent-session-provider-handle'
import { SESSION_TAB_NOT_FOUND_ERROR } from '../../shared/session-tab-close'
import {
  agentSessionOwnerBindingsEqual,
  cloneAgentSessionOwnerBinding,
  scopedAgentSessionClaimsEqual
} from '../../shared/claimed-agent-pty-owner-snapshot'
import { codexProviderHandleLink } from '../codex/codex-structured-owner-identity'
import { claudeProviderHandleLink } from '../claude/claude-structured-owner-identity'
import { readCodexResumeProcessIdentity } from '../codex/codex-resume-process-proof'
import {
  proveCodexTuiRollout,
  resolvePinnedCodexRolloutProof
} from '../codex/codex-tui-rollout-proof'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'
import { waitForStructuredTuiExitProof } from './structured-tui-exit-proof'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'
import {
  readClaudeTranscriptLeafUuid,
  resolveSessionFilePath
} from '../native-chat/session-file-resolver'
import { ClaudeTranscriptTailIncompleteError } from '../claude/claude-transcript-branch-proof'
import { hasStructuredTuiIdleEvidence } from './structured-tui-idle-evidence'
import { evaluateStructuredTuiRecoveryClaim } from './structured-tui-recovery-claim-match'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import {
  agentSessionPtyWriteGate,
  type AgentSessionPtyWriteAdmittance
} from './agent-session-pty-write-gate'
import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner
} from '../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../shared/pane-agent-owner'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import {
  type AgentPromptActivity,
  type AgentPromptWaitTextCache,
  readAgentPromptWaitText
} from './agent-prompt-submission-verification'
import { gitExecFileAsync } from '../git/runner'
import { wakeFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade-wake'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'

import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import { OrchestrationDb } from './orchestration/db'
import type { DispatchStatus } from './orchestration/types'
import { reconcileRequestedWorkerTerminalReleases } from './orchestration/worker-terminal-release-reconciliation'
import type { WorkerTerminalHostScope } from './orchestration/worker-terminal-process-liveness'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import type { TerminalRevealIdentity } from '../../shared/terminal-reveal-identity'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import type {
  OrchestrationCompatibilityEvidence,
  OrchestrationCompatibilityHostStamp
} from '../../shared/orchestration-compatibility-evidence'
import {
  isOrchestrationMutation,
  orchestrationMigrationData
} from '../../shared/orchestration-rpc-contract'
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
import {
  OrchestrationMailboxPointerDelivery,
  type OrchestrationMessageWaiter
} from './orchestration/mailbox-pointer-delivery'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput,
  AutomationWorkspaceMode
} from '../../shared/automations-types'
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
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import { resolvePublishedPaneAgentIdentity } from '../../shared/published-pane-agent-identity'
import type { TuiAgent } from '../../shared/tui-agent'
import type { BranchPrefixStrategy } from '../../shared/ui-chrome-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../shared/workspace-source'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type {
  CreateWorktreeResult,
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitHubPrStartPoint,
  GitPushTarget,
  GitWorktreeInfo,
  WorkspaceLinkedItem,
  Worktree
} from '../../shared/worktree/types'
import type { TaskSourceContext } from '../../shared/task-source-context'
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
import { applyBrowserSessionTabSelection } from './browser-session-tab-selection-snapshot'
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
import {
  describeTerminalExitCause,
  isDeliberateTerminalExit,
  type TerminalExitCause
} from '../../shared/terminal-exit-cause'
import { runtimeTerminalDegradation } from './native-terminal-availability'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage,
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeDegradation,
  type RuntimeDesktopWindowStatus,
  type RuntimeGraphStatus,
  type RuntimeTerminalRead,
  type RuntimeTerminalRename,
  type RuntimeTerminalAgentStatus,
  type RuntimeTerminalSend,
  type RuntimeTerminalCreate,
  type RuntimeTerminalPresentation,
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
  type RuntimeWorktreeAgentRow,
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
  type RuntimeNativeChatLaunchDraftResolution,
  type RuntimeSessionTabCloseReason,
  type RuntimeBrowserDriverState,
  type RuntimeTerminalDriverState,
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
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree/id'

import { isFolderRepo } from '../../shared/repo-kind'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'
import { TASK_PROVIDERS } from '../../shared/task-providers'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { TerminalQuickCommandMutation } from '../../shared/terminal-quick-commands'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from '../../shared/tui-agent-startup'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import {
  haveSameDisabledTuiAgents,
  isTuiAgentEnabled,
  pickTuiAgent
} from '../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { resolveCodexStructuredAppServerArgs } from '../codex/codex-structured-app-server-args'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
  getTuiAgentLaunchCommand,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents
} from '../preflight/agent-detection'
import {
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from '../agent-trust-presets'
import { markRemoteAgentWorkspaceTrusted } from '../remote-agent-trust-presets'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { findRuntimeWorkspaceFileOwner } from '../../shared/runtime-workspace-file-owner'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import { sharesResolvedWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import {
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
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
import type { RuntimeBrowserCommands } from './orca-runtime-browser'
import {
  createRuntimeBrowserCommands,
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
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
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { getRuntimeFileTargetExecutionHostId, RuntimeFileCommands } from './orca-runtime-files'
import { RuntimeGitCommands } from './orca-runtime-git'
import {
  committedMobileSessionTabClose,
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose,
  type MobileSessionTabCloseOutcome
} from './mobile-session-tab-close-outcome'
import type {
  PtyProviderBufferSnapshot,
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnResult,
  PtyTransientFact
} from '../providers/types'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import type {
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from './claude-agent-teams-service'
import {
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from './claude-agent-teams-shim-env'
import type { ClaudeAgentTeamsMode } from '../../shared/claude-agent-teams-tmux-compat'
import { collectMemorySnapshot } from '../memory/collector'
import type { BrowserWindow } from 'electron'
import { getAppEnvironment } from '../../shared/app-environment'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { RuntimeBrowserScreencastCommands } from './runtime-browser-screencast-commands'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import {
  fetchGitHubPullRequestHeadRef,
  fetchPrHeadTrackingRef
} from '../github/pr-head-tracking-ref'
import {
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from '../../shared/review-head-tracking-ref'
import { fetchGitLabMergeRequestHeadRef } from '../gitlab/mr-head-tracking-ref'
import { isTransientReviewHeadFetchError } from '../git/fetch-error-classification'
import { resolveGitHubReviewHeadRemote } from '../github/review-head-remote'
import { fetchCompareBaseRefWithLocalFallback } from '../git/compare-base-ref-fetch'
import { pickPreferredGitRemote } from '../../shared/preferred-git-remote'
import { getGlabKnownHosts } from '../gitlab/gl-utils'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { getDefaultRemote } from '../git/repo'
import { hasCommitObjectViaGitExec } from '../git/commit-object-ref'
import { hasWorktreeBaseCommitRef } from '../git/worktree-base-ref-probe'

import { listWorktrees } from '../git/worktree'
import { isENOENT } from '../ipc/filesystem-path-containment'

import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { computeValidatedBranchName } from '../ipc/worktree-logic'

import { getWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  type WatcherRemovalDeadline
} from '../ipc/watcher-removal-drain'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'
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
import {
  getSelectedReviewBranch,
  getSelectedReviewLookupHints,
  type SelectedReviewBranchInput
} from './selected-review-branch'
import {
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import { inferFolderWorkspacePathConnection } from '../project-groups/folder-workspace-path-status'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type {
  CodexAccountService,
  CodexResetCreditRejectedBeforeProviderReason
} from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { RateLimitService } from '../rate-limits/service'
import { applyPRBotAuthorOverride } from '../../shared/pr-bot-author-overrides'
import type { CodexRateLimitResetOutcome, RateLimitState } from '../../shared/rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { VoiceSettings } from '../../shared/speech-types'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'

function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

export type RemoteFetchResult = { ok: true } | { ok: false; errorKind: 'git_error' }

export type RemoteTrackingBase = {
  remote: string
  branch: string
  ref: string
  base: string
}

export type AccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type CodexRateLimitResetRpcResult = {
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
} & (
  | { outcome: CodexRateLimitResetOutcome }
  | {
      status: 'rejectedBeforeProvider'
      retryDisposition: 'discardAttempt'
      reason: CodexResetCreditRejectedBeforeProviderReason
    }
)

export type RuntimeStore = {
  getRepos: Store['getRepos']
  getRepo: Store['getRepo']
  addRetiredWorktreeName: Store['addRetiredWorktreeName']
  getRetiredWorktreeNameRegistry: Store['getRetiredWorktreeNameRegistry']
  mergeRetiredWorktreeNames: Store['mergeRetiredWorktreeNames']
  addRepo: Store['addRepo']
  updateRepo: Store['updateRepo']
  getProjects?: Store['getProjects']
  updateProject?: Store['updateProject']
  getProjectHostSetups?: Store['getProjectHostSetups']
  createProjectHostSetup?: Store['createProjectHostSetup']
  updateProjectHostSetup?: Store['updateProjectHostSetup']
  deleteProjectHostSetup?: Store['deleteProjectHostSetup']
  getProjectGroups?: Store['getProjectGroups']
  createProjectGroup?: Store['createProjectGroup']
  updateProjectGroup?: Store['updateProjectGroup']
  deleteProjectGroup?: Store['deleteProjectGroup']
  moveProjectToGroup?: Store['moveProjectToGroup']
  getFolderWorkspaces?: Store['getFolderWorkspaces']
  createFolderWorkspace?: Store['createFolderWorkspace']
  updateFolderWorkspace?: Store['updateFolderWorkspace']
  removeFolderWorkspace?: Store['removeFolderWorkspace']
  removeProject?: Store['removeProject']
  removeProjectForHost?: Store['removeProjectForHost']
  reorderRepos?: Store['reorderRepos']
  getAllWorktreeMeta: Store['getAllWorktreeMeta']
  getWorktreeMeta: Store['getWorktreeMeta']
  setWorktreeMeta: Store['setWorktreeMeta']
  setWorktreeMetaForHost?: Store['setWorktreeMetaForHost']
  removeWorktreeMeta: Store['removeWorktreeMeta']
  getWorktreeLineage?: Store['getWorktreeLineage']
  getAllWorktreeLineage?: Store['getAllWorktreeLineage']
  setWorktreeLineage?: Store['setWorktreeLineage']
  removeWorktreeLineage?: Store['removeWorktreeLineage']
  getAllWorkspaceLineage?: Store['getAllWorkspaceLineage']
  setWorkspaceLineage?: Store['setWorkspaceLineage']
  removeWorkspaceLineage?: Store['removeWorkspaceLineage']
  getGitHubCache: Store['getGitHubCache']
  getWorkspaceSession?: Store['getWorkspaceSession']
  getWorkspaceSessionHostIds?: Store['getWorkspaceSessionHostIds']
  setWorkspaceSession?: Store['setWorkspaceSession']
  flushOrThrow?: Store['flushOrThrow']
  flushPendingOrThrowAsync?: Store['flushPendingOrThrowAsync']
  persistPtyBinding?: Store['persistPtyBinding']
  getSshRemotePtyLeases?: Store['getSshRemotePtyLeases']
  getUI?: Store['getUI']
  updateUI?: Store['updateUI']
  recordFeatureInteraction?: Store['recordFeatureInteraction']
  listAutomations?: Store['listAutomations']
  listAutomationsForScope?: Store['listAutomationsForScope']
  assertAutomationOwnerFence?: Store['assertAutomationOwnerFence']
  automationOwnerPrecondition?: Store['automationOwnerPrecondition']
  automationChangeSelector?: Store['automationChangeSelector']
  listAutomationRuns?: Store['listAutomationRuns']
  createAutomation?: Store['createAutomation']
  updateAutomation?: Store['updateAutomation']
  deleteAutomation?: Store['deleteAutomation']
  getSparsePresets?: Store['getSparsePresets']
  saveSparsePreset?: Store['saveSparsePreset']
  getMobileClientTabSelections?: Store['getMobileClientTabSelections']
  setMobileClientTabSelections?: Store['setMobileClientTabSelections']
  getSettings(): {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    localBaseRefSuggestionDismissed?: boolean
    branchPrefix: string
    branchPrefixCustom: string
    worktreeVisibilityDefaults?: GlobalSettings['worktreeVisibilityDefaults']
    defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
    disabledTuiAgents?: GlobalSettings['disabledTuiAgents']
    agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
    agentDefaultArgs?: GlobalSettings['agentDefaultArgs']
    agentDefaultEnv?: GlobalSettings['agentDefaultEnv']
    terminalWindowsShell?: GlobalSettings['terminalWindowsShell']
    floatingTerminalEnabled?: GlobalSettings['floatingTerminalEnabled']
    agentStatusHooksEnabled?: GlobalSettings['agentStatusHooksEnabled']
    defaultTaskSource?: GlobalSettings['defaultTaskSource']
    defaultTaskViewPreset?: GlobalSettings['defaultTaskViewPreset']
    visibleTaskProviders?: GlobalSettings['visibleTaskProviders']
    defaultRepoSelection?: GlobalSettings['defaultRepoSelection']
    defaultLinearTeamSelection?: GlobalSettings['defaultLinearTeamSelection']
    githubProjects?: GlobalSettings['githubProjects']
    experimentalNewWorktreeCardStyle?: GlobalSettings['experimentalNewWorktreeCardStyle']
    compactWorktreeCards?: GlobalSettings['compactWorktreeCards']
    minimaxGroupId?: GlobalSettings['minimaxGroupId']
    minimaxUsageModels?: GlobalSettings['minimaxUsageModels']
    prBotAuthorOverrides?: GlobalSettings['prBotAuthorOverrides']
    artifactSharingEnabled?: GlobalSettings['artifactSharingEnabled']
    agentSkillSharingEnabled?: GlobalSettings['agentSkillSharingEnabled']
    nestedWorkerMaxDepth?: GlobalSettings['nestedWorkerMaxDepth']
    terminalQuickCommands?: GlobalSettings['terminalQuickCommands']
    gitlabProjects?: GlobalSettings['gitlabProjects']
    mobileAutoRestoreFitMs?: number | null
    mobileEmulatorEnabled?: boolean
    mobileEmulatorDefaultDeviceUdid?: string | null
    voice?: VoiceSettings
    claudeAgentTeamsMode?: GlobalSettings['claudeAgentTeamsMode']
    // Why: Phase-5 query responder kill switches — read per chunk in
    // onPtyData to capture reply ownership at ingestion.
    terminalMainSideEffectAuthority?: GlobalSettings['terminalMainSideEffectAuthority']
    terminalHiddenDeliveryGate?: GlobalSettings['terminalHiddenDeliveryGate']
    terminalModelQueryAuthority?: GlobalSettings['terminalModelQueryAuthority']
  }
  // Why: narrow to `unknown` return so test mocks can return void without
  // a cast. The runtime never reads the return value — the persisted value
  // is read back via getSettings() on the next access.
  updateSettings?: (
    updates: Partial<GlobalSettings>,
    options?: { notifyListeners?: boolean; originWebContentsId?: number }
  ) => unknown
}

export type RuntimeAutomationCreateInput = Omit<
  AutomationCreateInput,
  'projectId' | 'workspaceId' | 'workspaceMode' | 'timezone'
> & {
  repo?: string
  workspace?: string
  workspaceMode?: AutomationWorkspaceMode
  timezone?: string
  destination?: AutomationDestination
}

export type RuntimeAutomationUpdateInput = Omit<
  AutomationUpdateInput,
  'projectId' | 'workspaceId'
> & {
  repo?: string
  workspace?: string
}

export type RuntimeLeafRecord = RuntimeSyncedLeaf & {
  ptyGeneration: number
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  tailBuffer: string[]
  tailTranscriptBuffer: string[]
  tailTranscriptChars: number
  tailPartialLine: string
  tailPendingAnsi: string
  tailRedrawCursor: RetainedTailRedrawCursor | null
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  waitBlockedAt: number | null
  // Why: memoized wait scan of the current retained tail so the next PTY chunk
  // reuses it as its "previous" state instead of rebuilding + rescanning the
  // full tail. See computeTerminalTailWaitState.
  tailWaitState?: TerminalTailWaitState
  lastAgentStatus: AgentStatus | null
  // Why: seeded status is a historical title replayed on restore, so it cannot
  // authorize a PTY write. Only a live OSC observation sets this true; push
  // delivery reads it so a cold-restored `idle` never types into a working agent.
  lastAgentStatusObservedLive: boolean
  // Why: the most recent OSC title observed on this leaf's PTY data. Used by
  // worktree.ps so daemon-hosted terminals (no renderer pushing pane titles)
  // still recompute working/idle from the live title each call instead of
  // serving a stale `lastAgentStatus` after the agent process exits and the
  // shell takes over the title — the bug behind issue #1437.
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  paneTitleUpdatedAt: number | null
}

export type RuntimePtyWorktreeRecord = {
  ptyId: string
  incarnationId: PtyIncarnationId | null
  worktreeId: string
  connectionId: string | null
  runtimeSessionOwned: boolean
  // Why: a Windows host can own both native and WSL panes; preamble command
  // selection must follow the pane that executes it, not process.platform.
  isWsl: boolean | null
  wslDistro: string | null
  // Why: background CLI PTYs can outlive a failed renderer reveal. Preserve the
  // spawn-time tab/pane identity so later reveals can adopt under the env key.
  tabId: string | null
  paneKey: string | null
  launchConfig: SleepingAgentLaunchConfig | null
  launchToken: string | null
  // Why: provider PTY IDs can be reused; launch identity belongs only to the process that received the token.
  launchIncarnationId: PtyIncarnationId | null
  launchAgent: TuiAgent | null
  agentSessionOwners: AgentSessionOwnerBinding[]
  foregroundAgent: TuiAgent | null
  connected: boolean
  disconnectedAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  lastAgentStatus: AgentStatus | null
  /** False until a live OSC frame sets the status; restore seeds never set it. */
  lastAgentStatusObservedLive: boolean
  lastAgentStatusStartedAtEpochMs: number | null
  // A later semantic title interval cannot inherit rich fields from an earlier task.
  lastAgentStatusRichInvalidatedAtEpochMs: number | null
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  // Why a second stamp: `lastOscTitleAt` is a title-observation sequence number,
  // comparable only to other title stamps. Anything that must date a live title
  // against an off-pane clock (hook `receivedAt`) needs wall-clock ms.
  lastOscTitleEpochMs: number | null
  managementTitle: string | null
  managementTitleAt: number | null
  controllerTitle: string | null
  title: string | null
  titleUpdatedAt: number | null
  lastOutputAt: number | null
  tailBuffer: string[]
  tailTranscriptBuffer: string[]
  tailTranscriptChars: number
  tailPartialLine: string
  tailPendingAnsi: string
  tailRedrawCursor: RetainedTailRedrawCursor | null
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  waitBlockedAt: number | null
  // Why: memoized wait scan of the current retained tail (see RuntimeLeafRecord).
  tailWaitState?: TerminalTailWaitState
}

export type TerminalAgentStatusSnapshot = {
  waitText: string
  waitBlockedAt: number | null
  title: string | null
  titleStatus: AgentStatus | null
  titleStatusIsLive: boolean
}

export type TerminalCreateOptions = {
  command?: string
  claudeAgentTeamsSourceCommand?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  // Why: agent ids are not shell commands (`cursor` is the Cursor desktop app; its
  // CLI is `cursor-agent`). Callers that know the agent name it here instead of
  // guessing a command, and the runtime builds the configured launch.
  startupAgent?: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  viewMode?: 'terminal' | 'chat'
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  telemetry?: WorktreeStartupLaunch['telemetry']
  title?: string
  focus?: boolean
  rendererBacked?: boolean
  activate?: boolean
  presentation?: RuntimeTerminalPresentation
  // Why: `false` adopts the terminal without pointing the user at it — no
  // sidebar reveal, no tab focus. Distinct from 'background' presentation,
  // which skips renderer adoption entirely.
  surfaceOwner?: false
  tabId?: string
  leafId?: string
  sessionId?: string
  isNewSession?: boolean
  preAllocatedHandle?: string
  // Why: only the host-derived structured resume path may attach provider
  // identity; opaque terminal.create commands remain ordinary shells.
  agentSessionClaim?: AgentSessionExecutionClaim
  structuredAgentSessionId?: string
  agentSessionCreateOperationId?: string
  signal?: AbortSignal
  // Why: idempotent create operations must retain their fence after the PTY
  // exists, even if later runtime publication fails.
  onPtySpawnCommitted?: () => void
  // Why: the headless mobile-session create publishes its own authoritative
  // snapshot (with the correct target group) right after spawn. Skip the
  // intermediate pty-backed publish so the new tab doesn't briefly flash in
  // the wrong (active) group before the corrected snapshot lands.
  deferMobileSessionPublish?: boolean
}

export function mergeTerminalEnvDeletionKeys(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): string[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])]
  return merged.length > 0 ? merged : undefined
}

type AgentSessionCreateOperation = {
  fingerprint: string
  promise: Promise<RuntimeCreateAgentSessionResult>
}

function isAgentSessionOperationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'agentSessionOperationOutcome' in error &&
    error.agentSessionOperationOutcome === 'unknown'
  )
}

// Orphaned verdicts are bounded; active PTYs retain theirs until new evidence resolves them.

export type TrackedPtyLivenessVerdict = {
  verdict: PtyLivenessVerdict
  observedAt: number
}

const AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT = 512
const AGENT_SESSION_OPERATION_GLOBAL_LIMIT = 4_096

function deterministicAgentSessionUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

type PtyForegroundAgentRefresh = {
  promise: Promise<boolean>
  startedAfterTitleObservation: number
  requestedAfterTitleObservation: number
}

type PtyForegroundProcessRead = {
  controller: RuntimePtyController
  process: string | null
  available: boolean
}

type PtyForegroundProcessReadEntry = {
  controller: RuntimePtyController
  startedAfterTitleObservation: number
  promise: Promise<PtyForegroundProcessRead>
}

export function copySleepingAgentLaunchConfig(
  config: SleepingAgentLaunchConfig
): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

function normalizeAgentLaunchCommandForMatch(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

export function resolveBareAgentLaunchCommand(args: {
  command: string | undefined
  settings: {
    agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
    disabledTuiAgents?: Iterable<unknown> | null
  }
  platform: NodeJS.Platform
  isRemote: boolean
}): TuiAgent | null {
  const command = args.command ? normalizeAgentLaunchCommandForMatch(args.command) : ''
  if (!command) {
    return null
  }

  const cmdOverrides = args.settings.agentCmdOverrides ?? {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]) {
    if (!isTuiAgentEnabled(agent, args.settings.disabledTuiAgents)) {
      continue
    }
    const override = cmdOverrides[agent]?.trim()
    const defaultLaunchCommand = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], args.platform, {
      isRemote: args.isRemote
    })
    const launchCommands = override ? [defaultLaunchCommand, override] : [defaultLaunchCommand]
    if (
      launchCommands.some((candidate) => command === normalizeAgentLaunchCommandForMatch(candidate))
    ) {
      return agent
    }
  }

  return null
}

export function inferCapturedClaudeAgentTeamsMode(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  command: string | undefined,
  currentMode: ClaudeAgentTeamsMode | undefined
): ClaudeAgentTeamsMode | undefined {
  const capturedCommand = launchConfig?.agentCommand?.trim() || command?.trim() || ''
  const capturedArgs = launchConfig?.agentArgs?.trim() ?? ''
  const capturedLaunch = `${capturedCommand} ${capturedArgs}`.trim()
  if (/(^|\s)--teammate-mode(?:=|\s+)auto(?:\s|$)/.test(capturedLaunch)) {
    return 'native-panes-shim'
  }
  if (/(^|\s)--teammate-mode(?:=|\s+)in-process(?:\s|$)/.test(capturedLaunch)) {
    return 'in-process'
  }
  if (launchConfig && /(^|\s)--resume(?:\s|=|$)/.test(command?.trim() ?? '')) {
    return 'off'
  }
  return currentMode
}

export type RuntimeTerminalAgentStatusEvent = {
  ptyId: string
  source: 'mounted-leaf' | 'pty-record'
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  payload: ParsedAgentStatusPayload
}

export type RuntimePtyTitleTrackerEntry = {
  tracker: TerminalTitleTracker
  // Why: onPtyData batches the mobile session-tab touch to once per chunk;
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
export type RuntimeAgentRowSnapshot = {
  paneKey: string
  ptyId: string
  worktreeId?: string
  tabId?: string
  // Transport of the pane's PTY at retain time; null for local. Without it,
  // OSC rows for SSH panes would lose the remote exemption in worktree.ps.
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  // When the current payload.state was first observed for this pane (ms).
  stateStartedAt: number
  updatedAt: number
}

export type RuntimeWorkingTerminalEvidence = {
  paneKey: string | null
  ptyId: string | null
  tabId: string | null
}

type RuntimeWorktreeAgentSource = {
  paneKey: string
  ptyId?: string
  tabId?: string
  worktreeId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  state: ParsedAgentStatusPayload['state']
  workingMode?: ParsedAgentStatusPayload['workingMode']
  agentType: string | null
  prompt: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  stateStartedAt: number
  updatedAt: number
  restoredUnconfirmed?: boolean
}

/** A hook row narrowed to what `session.tabs` publishes, shaped like the retained OSC
 *  snapshot so one projection branch can consume either carrier. */
export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  'payload' | 'updatedAt' | 'stateStartedAt' | 'worktreeId'
>

export type RuntimeHeadlessTerminal = {
  emulator: HeadlessEmulator
  // Why: serialize can race with newer writes appended to writeChain; return
  // the seq actually painted into this emulator, not the latest PTY seq.
  outputSequence: number
  writeChain: Promise<void>
  ownership: PtyShellOwnershipMirror
}

export type RuntimePtyDataAdmission = Readonly<{
  sequence: number
  completion: Promise<void>
}>

// Why: a subscription id is stable across reconnects, so holding the string is not
// proof of ownership. This handle is the only safe way to tear down a registration.
export type SubscriptionRegistration = Readonly<{
  /** Tears down only if this registration still owns the id; otherwise a no-op. */
  releaseIfCurrent: () => void
}>

export type RuntimeTerminalDataMeta = Readonly<{
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
  sourceRanges?: readonly TerminalOutputSourceRange[]
}>

export type RuntimeVisibleTerminalState = {
  lines: string[]
  draft?: string
  isAlternateScreen: boolean
  sequence: number
  generation: number
}

export type RuntimeTerminalProjection = {
  lines: string[]
  draft?: string
}

export type ProviderBufferAcquisition = {
  generation: number
  scrollbackRows: number
  promise: Promise<PtyProviderBufferSnapshot | null>
  timedOut: boolean
}

export type RuntimeTerminalBufferSnapshot = {
  data: string
  /** Live state that can be restored without an alternate-screen frame. */
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
  pendingEscapeTailAnsi?: string
  /** Effective kitty flags proven at this snapshot's own `seq`. Absent means
   *  the winning source could not prove them. */
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
}

export type HeadlessSeedMetadata = {
  cwd?: string | null
  oscLinks?: TerminalOscLinkRange[]
  /** Cold restore history must outrank a model that only saw new-generation bytes. */
  preferProviderIfExisting?: boolean
  /** Persisted kitty flags from the daemon snapshot, re-applied to the fresh
   *  emulator so hidden `CSI ? u` answers the real flags instead of ?0u
   *  (terminal-query-authority.md §kitty). */
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
}

export type RuntimePtyController = {
  claimStablePaneCreate?(args: {
    worktreeId: string
    connectionId: string | null
    tabId: string
    leafId: string
  }): () => void
  adoptStablePane?(opts: {
    cols: number
    rows: number
    cwd?: string
    connectionId: string | null
    worktreeId: string
    preAllocatedHandle: string
    tabId: string
    leafId: string
  }): Promise<{
    result: PtySpawnResult
    owner: {
      handle?: string
      tabId: string
      leafId: string
      ptyId: string
      incarnationId?: string
    }
    materialized?: true
  } | null>
  spawn?(opts: {
    cols: number
    rows: number
    cwd?: string
    command?: string
    launchAgent?: TuiAgent
    commandDelivery?: 'renderer' | 'provider'
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    env?: Record<string, string>
    envToDelete?: string[]
    resumeProviderSession?: AgentProviderSessionMetadata
    telemetry?: WorktreeStartupLaunch['telemetry']
    connectionId?: string | null
    worktreeId?: string
    preAllocatedHandle?: string
    tabId?: string
    leafId?: string
    sessionId?: string
    isNewSession?: boolean
    persistHostSessionBinding?: boolean
    expectedSourceBinding?: PtyBindingSourceExpectation
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
    agentSessionCreateOperationId?: string
    signal?: AbortSignal
    onPtySpawnCommitted?: () => void
    adoptedStablePane?: {
      result: PtySpawnResult
      owner: {
        handle?: string
        tabId: string
        leafId: string
        ptyId: string
        incarnationId?: string
      }
      materialized?: true
    }
  }): Promise<{
    id: string
    pid?: number
    incarnationId?: PtyIncarnationId
    wslDistro?: string
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
    agentSessionEnsure?: AgentSessionClaimedSpawnResult
  }>
  write(ptyId: string, data: string): boolean
  writeAgentSessionProof?(
    ptyId: string,
    data: string,
    authority: { sessionId: string; spawnToken: string }
  ): boolean
  writeWithSettlement?(ptyId: string, data: string): Promise<boolean>
  /** Attach-only adoption of a live local daemon session so its output streams
   *  to main without a renderer pane; never creates, resizes, or focuses.
   *  False on doubt (absent session, SSH-scoped id, non-daemon provider). */
  attach?(ptyId: string): Promise<boolean>
  kill(ptyId: string): boolean
  retireRejectedPty?(ptyId: string, stopConfirmed: boolean): void
  stopAndWait?(
    ptyId: string,
    opts?: { keepHistory?: boolean; deadlineMs?: number }
  ): Promise<boolean>
  markReversibleStops?(ptyIds: readonly string[]): () => void
  getCwd?(ptyId: string): Promise<string | null>
  getForegroundProcess(ptyId: string): Promise<string | null>
  inspectProcess?(
    ptyId: string
  ): Promise<{ foregroundProcess: string | null; hasChildProcesses: boolean; unavailable?: true }>
  confirmForegroundProcess?(ptyId: string): Promise<string | null>
  confirmShellForeground?(ptyId: string): Promise<boolean>
  hasChildProcesses?(ptyId: string): Promise<boolean>
  clearBuffer?(ptyId: string): Promise<void>
  resize?(ptyId: string, cols: number, rows: number): boolean
  // Why: exact-id mobile polls should not enumerate every local and SSH PTY.
  hasPty?(ptyId: string): boolean | null
  // Why: the caller's budget has to reach the relay. Without it an SSH list runs to
  // the mux's own 30s default and blows every inventory refresh (STA-517).
  listProcesses?(
    connectionId?: string | null,
    opts?: { deadlineMs?: number }
  ): Promise<PtyProcessInfo[]>
  listProcessesWithHostScope?(opts?: { deadlineMs?: number }): Promise<{
    processes: PtyProcessInfo[]
    hostIds: ExecutionHostId[]
  }>
  serializeBuffer?(
    ptyId: string,
    opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
  ): Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    lastTitle?: string
    kittyKeyboardFlags?: number
  } | null>
  /** Authoritative provider-owned snapshot for restored PTYs with no mounted renderer. */
  serializeProviderBuffer?(
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null>
  // Why: synchronous probe used by maybeHydrateHeadlessFromRenderer to skip
  // hydration when no renderer is authoritative for this PTY. See
  // docs/mobile-prefer-renderer-scrollback.md.
  hasRendererSerializer?(ptyId: string): boolean
  getRendererSerializerGeneration?(ptyId: string): number
  waitForRendererSerializer?(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean>
  getSize?(ptyId: string): { cols: number; rows: number } | null
  /** False only when the owning provider proved the PTY absent; null = unknown (never a denial). */
  probePtyLiveness?(ptyId: string): Promise<boolean | null>
}

export type PtyControllerTerminalIdentity = Readonly<{
  handle: string
  incarnationId: string
  wslDistro?: string | null
}>

export type PtyControllerInventory = Readonly<{
  livePtyIds: ReadonlySet<string>
  // Why: livePtyIds is worktree-scoped when a target is given; absence proofs
  // must consult the unscoped inventory or a misattributed live PTY reads as dead.
  allLivePtyIds: ReadonlySet<string>
  terminalIdentityByPtyId: ReadonlyMap<string, PtyControllerTerminalIdentity>
  queriedHostIds: ReadonlySet<ExecutionHostId>
}>

export type WorktreeStartupDraftPaste = {
  agent: TuiAgent
  content: string
}

export type WorktreeStartupFollowup = {
  expectedProcess: string
  prompt: string
}

// Why: long enough for a phone to reconnect and retry a create whose response
// was lost, short enough that an intentional later re-resume forks fresh.
export const MOBILE_TERMINAL_CREATE_RESULT_TTL_MS = 60_000
// Why: a phone whose create was interrupted retries with the same clientMutationId
// and reuses the just-created worktree instead of spawning a duplicate.
export const WORKTREE_CREATE_RESULT_TTL_MS = 60_000
const FOREGROUND_AGENT_WRAPPER_RETRY_INTERVAL_MS = 150
const FOREGROUND_AGENT_WRAPPER_RETRY_TIMEOUT_MS = 6_500
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const BRACKETED_PASTE_QUIET_MS = 1500
// Why: both are windows *after* the paste is ingested, so each is added to the
// payload's ingest bound rather than standing in for it (see getTerminalPasteIngestMs).
// The quiet window stays at 1500: nothing measured describes an agent's post-paste
// redraw cadence, and a shorter window submits mid-redraw.
const AGENT_PROMPT_RENDER_TIMEOUT_MS = 8000
const AGENT_PROMPT_RENDER_QUIET_MS = 1500
// Why: Claude and Codex emit show-cursor after accepting bracketed paste.
const AGENT_PROMPT_RENDER_MARKER = '\x1b[?25h'

export function assertAgentPromptRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
}

export async function waitForAgentPromptPromise<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return await promise
  }
  assertAgentPromptRequestActive(signal)
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (result: { value: T } | { error: unknown }): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      if ('error' in result) {
        reject(result.error)
      } else {
        resolve(result.value)
      }
    }
    const onAbort = (): void => finish({ error: new Error('request_aborted') })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error })
    )
  })
}

// Why not setTimeout(0): it costs a full ~15.19 ms Windows timer tick per chunk (~0.95 s/MB)
// and never bought backpressure -- 16 KiB per tick paces ~1.07 MB/s, 11x above ConPTY's
// ~96 KB/s drain, so the in-flight buffer grew regardless. setImmediate keeps the only thing
// the yield actually did (let abort/permission/data callbacks run between chunks) at ~0.01 ms,
// and TERMINAL_INPUT_MAX_BYTES still bounds what can be in flight either way.
// Why the global and not node:timers/promises: only the global is intercepted by fake timers,
// so a chunked paste stays observable on the test clock.
export function yieldBetweenTerminalInputChunks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

export async function waitForAgentPromptDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return
  }
  assertAgentPromptRequestActive(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}

export const MOBILE_TERMINAL_SURFACE_TIMEOUT_MS = 10_000
// Why: the split already failed; the caller waits on this teardown only to learn whether the
// fallback kill is needed, so keep it short — an unreachable host must not stall the rejection.
export const MAX_TRACKED_PTY_LIVENESS_VERDICTS = 256
export const REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS = 2_000
export const EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS = 2_000
export const MOBILE_TERMINAL_READY_FALLBACK_MS = 1000

export function isClientDisconnectedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'client_disconnected'
}

export function createTerminalRevealWarning(handle: string, error?: unknown): string {
  const reason =
    error instanceof Error && error.message.trim().length > 0
      ? ` Reason: ${error.message.trim()}.`
      : ''
  return [
    `Terminal ${handle} is running, but Orca could not make it discoverable.${reason}`,
    `Run \`orca terminal focus --terminal ${handle}\` to reveal and focus it.`
  ].join(' ')
}

// Why: an absent `surfaceOwner` means "default", so surfacing callers must omit
// the key rather than send `true`.
export function ownerSurfacing(shouldSurface: boolean): { surfaceOwner?: false } {
  return shouldSurface ? {} : { surfaceOwner: false }
}

export function resolveTerminalPresentation(opts: {
  presentation?: RuntimeTerminalPresentation
  focus?: boolean
  activate?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (opts.presentation) {
    return opts.presentation
  }
  if (opts.focus === true || opts.activate === true) {
    return 'focused'
  }
  return undefined
}

export type RuntimeNotifier = {
  worktreesChanged(repoId: string, renamed?: { oldWorktreeId: string; newWorktreeId: string }): void
  worktreeBaseStatus?(event: WorktreeBaseStatusEvent): void
  worktreeRemoteBranchConflict?(event: WorktreeRemoteBranchConflictEvent): void
  reposChanged(): void
  automationsChanged?(payload: AutomationsChangedPayload): void
  activateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void
  createTerminal(
    worktreeId: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      title?: string
      presentation?: RuntimeTerminalPresentation
    }
  ): void
  revealTerminalSession?(
    worktreeId: string,
    opts: {
      ptyId: string
      title?: string | null
      cwd?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      presentation?: RuntimeTerminalPresentation
      surfaceOwner?: false
      tabId?: string
      leafId?: string
      splitFromLeafId?: string
      splitDirection?: 'horizontal' | 'vertical'
      splitTelemetrySource?: TerminalPaneSplitSource
      focus?: boolean
      expectedProcessIdentity?: {
        terminalHandle: string
        incarnationId: string
      }
    }
  ):
    | Promise<{ tabId: string; title?: string | null; identity?: TerminalRevealIdentity }>
    | { tabId: string; title?: string | null; identity?: TerminalRevealIdentity }
    | void
  resolveLegacyWorkerTerminalRecovery?(
    paneKey: string,
    resolution: 'adopted' | 'exited' | 'rolled_back',
    ptyId?: string
  ): void
  splitTerminal(
    tabId: string,
    paneRuntimeId: number,
    opts: {
      direction: 'horizontal' | 'vertical'
      command?: string
      telemetrySource?: TerminalPaneSplitSource
    }
  ): void
  renameTerminal(tabId: string, title: string | null): void
  focusTerminal(tabId: string, worktreeId: string, leafId?: string | null): void
  focusEditorTab?(tabId: string, worktreeId: string): void
  closeSessionTab?(tabId: string, worktreeId: string): void | Promise<void>
  moveSessionTab?(worktreeId: string, move: RuntimeMobileSessionTabMove): void
  openFile?(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null
  ): void
  openDiff?(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null
  ): void
  readMobileMarkdownTab?(worktreeId: string, tabId: string): Promise<RuntimeMarkdownReadTabResult>
  saveMobileMarkdownTab?(
    worktreeId: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult>
  closeTerminal(tabId: string, paneRuntimeId?: number): void
  closeTerminalTab?(
    tabId: string,
    options?: { localPtyTeardownOwnedExternally?: boolean }
  ): Promise<void>
  sleepWorktree(worktreeId: string): void
  // Why: a phone opening a worktree wakes its slept agents by asking the host
  // renderer to run its own navigation-free wake (experimental agent sleep);
  // the runtime has no in-memory sleeping records or wake authority. Optional to
  // match the many renderer-backed notifier methods only the real bridge wires.
  resumeSleepingAgents?(worktreeId: string): void
  terminalFitOverrideChanged(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void
  // Why: presence-based lock signal — desktop renderer mounts the lock
  // banner when `driver.kind === 'mobile'` and unmounts otherwise. The
  // structured payload (vs a `locked: boolean`) carries the active mobile
  // actor's clientId so the renderer can disambiguate multi-phone scenarios
  // and so a future write coordinator can use the same signal as scheduling
  // input. See docs/mobile-presence-lock.md.
  terminalDriverChanged(ptyId: string, driver: DriverState): void
  nativeChatLaunchDraftResolved?(
    tabId: string,
    resolution: { text: string; createdAt: number }
  ): void
  browserDriverChanged?(browserPageId: string, driver: RuntimeBrowserDriverState): void
  // Why: separate from the driver above because watching and driving are independent — a page can
  // be watched by a desktop client with no driver at all, and that page must still paint.
  browserRemoteViewersChanged?(browserPageId: string, hasRemoteViewers: boolean): void
  // Why: pages placed on a paired client never reach the host renderer's tab model, so the host
  // has no row for them unless main pushes one. Ephemeral and host-local — see
  // src/shared/client-hosted-browser-rows.ts.
  clientHostedBrowserRowsChanged?(event: ClientHostedBrowserRowsEvent): void
}

export type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
}

export type PtyIncarnationHandleRecord = {
  handle: string
  incarnationId: string
  leafKey: string
}

export type OrchestrationCompatibilityTerminalAuthority = {
  runtimeId: string
  terminalHandle: string
  ptyId: string
  worktreeId: string
  processIncarnation: string | null
  paneKey: string | null
  launchTokenHash: string | null
  hostScope: WorkerTerminalHostScope
}

export type LegacyWorkerTerminalRecoveryResult = {
  blockedPaneCount: number
  adoptedDispatchIds: string[]
  exitedDispatchIds: string[]
  deferredDispatchIds: string[]
}

export type LegacyWorkerTerminalRecoveryResolution = {
  candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  resolution: 'adopted' | 'exited'
}

export type OrchestrationCompatibilityCallerAuthority = Readonly<{
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
  paneKey: string
  terminalHandle: string
  processIncarnation: string
  launchTokenHash: string
}>

type RestoredOrchestrationAuthorityReceipt = Readonly<{
  ptyId: string
  worktreeId: string
  terminalHandle: string
  paneKey: string
  processIncarnation: string
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
}>

type OrchestrationCompatibilitySshAttachmentAuthority = Extract<
  OrchestrationCompatibilityHostStamp,
  { kind: 'ssh' }
>

export type TerminalWaiter = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
  pollInterval: NodeJS.Timeout | null
  abortCleanup: (() => void) | null
}

export type MessageWaiter = OrchestrationMessageWaiter & {
  handle: string
  resolve: (result: MessageWaitResult) => void
  timeout: NodeJS.Timeout | null
  abortCleanup: (() => void) | null
}

export type MessageWaitResult = 'notified' | 'timed_out' | 'cancelled' | 'waiter_exists'

export function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

export type RuntimeWorktreeRemovalTarget = {
  id: string
  repoId: string
  path: string
  pushTarget?: GitPushTarget
}

// Null executionHostId means host-unaware: path-only callers match any repo, and the first runtime
// host can adopt a legacy (unstamped) repo. But an unstamped repo with a connectionId is an SSH repo
// (resolves to ssh:<id>), so it must not be adopted/matched by a runtime host at the same path.

// Why: this runtime only has local git and local fs, so an ssh: host here would clone and
// probe the wrong machine and then register the result as remote. SSH setup is owned by the
// desktop IPC path (addRemoteRepoFromPath / cloneRemoteRepo), which the renderer routes to;
// only `local` and `runtime:` legitimately reach these RPCs.

function getRuntimeFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getRuntimeFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

function listRuntimeFolderWorkspaces(
  store: Pick<RuntimeStore, 'getAllWorktreeMeta' | 'getRepos' | 'setWorktreeMeta'>,
  repo: Repo,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Worktree[] {
  const rootId = getRuntimeFolderWorkspaceRootId(repo)
  const allMeta = store.getAllWorktreeMeta()
  const expectedHostId = getRepoExecutionHostId(repo)
  const ids = Object.keys(allMeta).filter(
    (worktreeId) =>
      isRuntimeFolderWorkspaceIdForRepo(repo, worktreeId) &&
      (repoOwnerCount === 1 || allMeta[worktreeId]?.hostId === expectedHostId)
  )
  if (!ids.includes(rootId)) {
    ids.unshift(rootId)
  } else {
    ids.sort((left, right) => {
      if (left === rootId) {
        return -1
      }
      if (right === rootId) {
        return 1
      }
      return 0
    })
  }

  return ids.map((worktreeId) => {
    const existing = getRepoOwnedWorktreeMeta(repo, worktreeId, allMeta, repoOwnerCount)
    const meta: Partial<WorktreeMeta> = existing?.instanceId
      ? existing
      : existing || repoOwnerCount === 1
        ? store.setWorktreeMeta(worktreeId, {
            instanceId: getRuntimeFolderWorkspaceInstanceIdentity(repo, worktreeId),
            ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
          })
        : {}
    return {
      ...mergeRuntimeFolderWorkspace(repo, worktreeId, meta),
      hostId: repoOwnerCount === 1 ? (meta.hostId ?? expectedHostId) : expectedHostId
    }
  })
}

export function parseExactWorktreeIdSelector(
  selector: string
): RuntimeWorktreeRemovalTarget | null {
  const worktreeId = selector.startsWith('id:') ? selector.slice(3) : selector
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return null
  }
  return {
    id: worktreeId,
    repoId: parsed.repoId,
    path: parsed.worktreePath
  }
}

export async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  username: string | null,
  gitOptions: { wslDistro?: string } = {}
): Promise<string> {
  if (!branchNameOverride) {
    // The runtime store's getSettings() types branchPrefix loosely as string;
    // it is always one of the BranchPrefixStrategy literals at runtime.
    return computeValidatedBranchName(
      sanitizedName,
      { ...settings, branchPrefix: settings.branchPrefix as BranchPrefixStrategy },
      username
    )
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branchNameOverride], {
    cwd: repoPath,
    ...gitOptions
  })
  return branchNameOverride
}

function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

// Clamp terminal dimensions to the PTY's supported range (cols 20–240, rows 8–120).
export function clampTerminalViewport(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(240, Math.round(cols))),
    rows: Math.max(8, Math.min(120, Math.round(rows)))
  }
}

// Subscribe a listener to a per-key Set, pruning the key's entry once its last
// listener unsubscribes. Returns the unsubscribe callback.
export function addListenerToMap<T>(
  map: Map<string, Set<T>>,
  key: string,
  listener: T
): () => void {
  let listeners = map.get(key)
  if (!listeners) {
    listeners = new Set<T>()
    map.set(key, listeners)
  }
  const set = listeners
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      map.delete(key)
    }
  }
}

export async function canCheckoutExistingLocalBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  gitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      {
        cwd: repoPath,
        ...gitOptions
      }
    )
    localHead = stdout.trim()
  } catch {
    return false
  }
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        { cwd: repoPath, ...gitOptions }
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await listWorktrees(repoPath, gitOptions)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

export function hasLocalGitOptions(gitOptions: { wslDistro?: string }): boolean {
  return Object.keys(gitOptions).length > 0
}

export function getLocalGitHubPrForBranch(
  repoPath: string,
  branchName: string,
  gitOptions: { wslDistro?: string }
): ReturnType<typeof getPRForBranch> {
  return hasLocalGitOptions(gitOptions)
    ? getPRForBranch(repoPath, branchName, null, null, null, {
        localGitExecOptions: gitOptions
      })
    : getPRForBranch(repoPath, branchName)
}

export async function getSelectedHostedReviewForBranch(
  repo: Pick<Repo, 'path' | 'connectionId'>,
  branchName: string,
  args: SelectedReviewBranchInput,
  executionOptions: { localGitExecOptions?: { wslDistro?: string } } = {}
): Promise<{ matchesSelected: boolean; number: number } | null> {
  const selectedReview = getSelectedReviewBranch(args)
  if (!selectedReview) {
    return null
  }
  const review = await getHostedReviewForBranchFromRepo({
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    branch: branchName,
    ...executionOptions,
    ...getSelectedReviewLookupHints(args)
  })
  if (!review) {
    return null
  }
  return {
    matchesSelected:
      review.provider === selectedReview.provider && review.number === selectedReview.number,
    number: review.number
  }
}

export async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}

export type ResolvedWorktree = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

export type TerminalWorkspaceLaunchScope = {
  id: string
  path: string
  connectionId: string | null
  repo: Repo | null
  folderWorkspace: FolderWorkspace | null
}

export type ResolvedTerminalWorkspaceLaunchTarget = {
  scope: TerminalWorkspaceLaunchScope
  managedWorktree: ResolvedWorktree | null
}

export type WorktreeLineageInput = {
  parentWorkspace?: string
  /** Set by in-app parent pickers so the row is not recorded as a CLI flag. */
  parentWorkspaceOrigin?: 'manual'
  envParentWorkspace?: string
  parentWorktree?: string
  cwdParentWorktree?: string
  noParent?: boolean
  callerTerminalHandle?: string
  comment?: string
  orchestrationContext?: {
    parentWorktreeId?: string
    orchestrationRunId?: string
    taskId?: string
    coordinatorHandle?: string
  }
}

export type ResolvedWorkspaceParent =
  | {
      type: 'worktree'
      workspaceKey: WorkspaceKey
      worktree: ResolvedWorktree
      instanceId: string | null
    }
  | {
      type: 'folder'
      workspaceKey: WorkspaceKey
      folderWorkspace: FolderWorkspace
      instanceId: string | null
    }

export type WorktreeLineageResolution =
  | {
      kind: 'lineage'
      parent: ResolvedWorkspaceParent
      origin: WorktreeLineage['origin']
      capture: WorktreeLineage['capture']
      orchestrationRunId?: string
      taskId?: string
      coordinatorHandle?: string
      createdByTerminalHandle?: string
    }
  | {
      kind: 'none'
      warnings: WorktreeLineageWarning[]
    }

export type WorktreeLineageCandidate = {
  source: 'env-workspace' | 'cwd-context' | 'terminal-context' | 'orchestration-context'
  parent: ResolvedWorkspaceParent
  orchestrationRunId?: string
  taskId?: string
  coordinatorHandle?: string
}

export function extractOrchestrationTaskId(text?: string): string | undefined {
  return text?.match(/\btask_[A-Za-z0-9]+\b/)?.[0]
}

export class RuntimeLineageError extends Error {
  code: string
  data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export class WorktreeIdRequiresFullPathError extends Error {
  readonly code = 'worktree_id_requires_full_path'

  constructor() {
    super(
      'Worktree id selectors must use the full <repo-id>::<path> value. Use the id from `orca worktree list --json`, or target by path:<path>, branch:<branch>, or issue:<number>.'
    )
  }
}

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

// Why: notificationSeq is the desktop-assigned monotonic sequence used for
// mobile reconnect catch-up (#8129). It is added on dispatch (and replay) so a
// client can watermark the last event it delivered and request exactly the
// events after it — idempotent, no duplicate local pushes.
export type MobileNotificationDispatchEvent = {
  type: 'notification'
  source: 'agent-task-complete' | 'terminal-bell' | 'test' | 'plugin'
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
}

export type RuntimeWorktreeLifecycleEvent =
  | { kind: 'created'; worktreeId: string; path: string; branch: string }
  | { kind: 'removed'; worktreeId: string; path: string }

export type MobileNotificationDismissEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
}

export type MobileNotificationEvent =
  | MobileNotificationDispatchEvent
  | MobileNotificationDismissEvent

// Why: presence-based driver state for the mobile-presence lock. Exactly one
// driver per PTY at any moment. See docs/mobile-presence-lock.md.
//   - `idle`: no mobile subscribers; desktop input flows freely
//   - `desktop`: at least one mobile client subscribed but desktop reclaimed
//      (or all mobile clients are passive `desktop`-mode watchers); desktop
//      input flows freely
//   - `mobile{clientId}`: a mobile client is the active driver; desktop
//      input/resize are dropped server-side and the lock banner is mounted.
//      `clientId` is the most recent mobile actor for this PTY.
export type DriverState = RuntimeTerminalDriverState

// Why: per-PTY layout target — what the PTY *should* be at right now.
// `desktop` ⇒ runs at the desktop renderer's pane geometry; mobile passive
// watchers (mode='desktop') still receive scrollback. `phone` ⇒ runs at
// `ownerClientId`'s viewport; the desktop renderer's auto-fit is suppressed.
// See docs/mobile-terminal-layout-state-machine.md.
export type PtyLayoutTarget =
  | { kind: 'desktop'; cols: number; rows: number }
  | { kind: 'phone'; cols: number; rows: number; ownerClientId: string }
  | { kind: 'remote-desktop'; cols: number; rows: number; ownerSubscriptionKey: string }

// Why: authoritative layout state with monotonic seq. Bumped on every
// applyLayout success; emitted on mobile subscribe-stream events so clients
// drop stale events that arrive after a newer transition.
export type PtyLayoutState = PtyLayoutTarget & {
  seq: number
  appliedAt: number
}

// Why: applyLayout result discriminator. Callers (especially RPC handlers)
// need to distinguish "shipped a new state at seq N" from "no-op — caller
// should not claim a seq it didn't produce." `pty-exited` is terminal;
// `resize-failed` is transient and the caller may retry.
export type ApplyLayoutResult =
  | { ok: true; state: PtyLayoutState }
  | { ok: false; reason: 'pty-exited' | 'resize-failed' }

export type LayoutQueueEntry = {
  running: Promise<ApplyLayoutResult> | null
  pending: {
    target: PtyLayoutTarget
    waiters: ((r: ApplyLayoutResult) => void)[]
  }[]
}

export type NativeChatLaunchDraftResolutionTombstone = RuntimeNativeChatLaunchDraftResolution & {
  worktreeId: string
}

const MAX_NATIVE_CHAT_LAUNCH_DRAFT_RESOLUTION_TOMBSTONES = 200

export async function hasLocalWorktreeBaseRef(
  repoPath: string,
  baseRef: string,
  options: { wslDistro?: string } = {}
): Promise<boolean> {
  const refExists = (qualifiedRef: string) =>
    hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasCommitObjectViaGitExec(
    (gitArgs) => gitExecFileAsync(gitArgs, { cwd: repoPath, ...options }),
    baseRef
  )
}

export function getSetupRunnerCommandPlatformForLaunch(
  setup: CreateWorktreeResult['setup'],
  fallbackPlatform: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallbackPlatform)
}

export type RuntimeRendererReloadFence = Readonly<{
  revision: number
  recovery: 'renderer' | 'headless' | 'reloading'
}>

/** How a caller wants the provider-held screen fetched when the runtime has no
 *  bytes of its own. `visibleScreenOnly` narrows the result to the current grid:
 *  scrollback can still hold a ready banner a working agent printed minutes ago,
 *  which is history, not evidence of what the agent is doing now. */
export type ProviderSnapshotReadOptions = {
  timeoutMs?: number
  retireOnTimeout?: boolean
  visibleScreenOnly?: boolean
}

export class OrcaRuntimeService {
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
  private readonly terminalClusterFacade: RuntimeTerminalCluster
  // WP11 narrowed-access facades (write-only legacy snapshots kept for wire compat)
  terminalQueryFacade!: {
    getTerminalById: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
    listTerminals: () => RuntimePtyWorktreeRecord[]
    getTerminalStatus: (ptyId: string) => 'live' | 'disconnected' | 'exited'
    isTerminalAlive: (ptyId: string) => boolean
    getTerminalHandleForPtyId: (ptyId: string) => string | undefined
    listTerminalHandles: () => string[]
  }
  mobilePublishFacade!: {
    publishMobileSessionTabs: (worktreeId: string) => Promise<void>
    notifyMobileSubscriber: (worktreeId: string, clientNavigationId?: string) => Promise<unknown>
    publishMobileLayout: () => Promise<void>
    scheduleMobileSessionTabsChanged: (worktreeId: string) => void
    cancelScheduledMobileSessionTabsChanged: (worktreeId: string) => void
  }
  worktreeQueryFacade!: {
    getWorktreeById: (worktreeId: string) => unknown
    listWorktrees: () => string[]
    getWorktreeStatus: () => string
    resolveWorktreePath: (worktreeId: string) => string | undefined
    getRepositoryIdForWorktree: (worktreeId: string) => string | undefined
    getWorktreeBranch: (worktreeId: string) => string | undefined
  }
  agentStatusFacade!: {
    reportAgentStatus: () => Promise<void>
    publishAgentStatusUpdate: () => void
    notifyAgentStatusChanged: () => void
    getAgentStatus: (handle: string) => Promise<RuntimeTerminalAgentStatus>
    confirmAgentExit: (ptyId: string) => void
  }
  private readonly mobileSessionFacade: RuntimeMobileSessionFacade
  private readonly ptyWorktrees: RuntimePtyWorktrees
  private readonly managedWorktrees: RuntimeManagedWorktrees
  private readonly resolvedWorktreeCache: RuntimeResolvedWorktreeCache
  private readonly disposalTree: RuntimeDisposalTree
  private managedHookReconciliationGeneration = 0
  private managedHookReconciliationTail: Promise<void> = Promise.resolve()
  private readonly orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport | null
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
  private structuredAgentSessionTabRestorePromise: Promise<void> | null = null
  private structuredAgentSessionStartupRestorePromise: Promise<void> | null = null
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

  private agentStatusOscProcessorsByPtyId = new Map<
    string,
    (data: string) => ProcessedAgentStatusChunk
  >()
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
  private fetchInflight = new Map<string, Promise<RemoteFetchResult>>()
  // Why: `git fetch origin` and `git fetch origin <refspec>` contend for the
  // same repo remote/ref locks. This queue serializes all fetch shapes for one
  // canonical repo+remote while still letting same-shape callers share promises.
  private remoteFetchQueueTail = new Map<string, Promise<RemoteFetchResult>>()
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
    this.terminalClusterFacade = new RuntimeTerminalCluster({
      ptyWorktrees: () => this.ptyWorktrees,
      recentPtyOutputById: () => this.recentPtyOutputById,
      recentPtyPathCandidatesById: () => this.recentPtyPathCandidatesById,
      leaves: () => this.leaves,
      mobileSessionTabsByWorktree: () => this.mobileSessionTabsByWorktree,
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(...args),
      notifyMobileSessionTabsChanged: (...args) => this.notifyMobileSessionTabsChanged(...args),
      layouts: () => this.layouts,
      isFreshSubscribe: (...args) => this.isFreshSubscribe(...args),
      terminalFitOverrides: () => this.terminalFitOverrides,
      mobileSubscribers: () => this.mobileSubscribers,
      pickEarliestRestoreTarget: (...args) => this.pickEarliestRestoreTarget(...args),
      lastRendererSizes: () => this.lastRendererSizes,
      suppressResizesForMs: (...args) => this.suppressResizesForMs(...args),
      mobileSessionFacade: () => this.mobileSessionFacade,
      activeRemoteDesktopViewport: (...args) => this.activeRemoteDesktopViewport(...args),
      remoteDesktopViewerRevisions: () => this.remoteDesktopViewerRevisions,
      remoteDesktopOwners: () => this.remoteDesktopOwners,
      resolveRemoteDesktopHostReclaimTarget: (...args) =>
        this.resolveRemoteDesktopHostReclaimTarget(...args),
      freshSubscribeGuard: () => this.freshSubscribeGuard,
      remoteDesktopHostReclaimTargets: () => this.remoteDesktopHostReclaimTargets,
      graphStatus: () => this.graphStatus,
      rendererGraphEpoch: () => this.rendererGraphEpoch,
      mobileTabSnapshots: () => this.mobileTabSnapshots,
      resolvedWorktreeCache: () => this.resolvedWorktreeCache,
      listKnownExecutionHostIds: (...args) => this.listKnownExecutionHostIds(...args),
      tryGetWorkspaceSessionHostIdForWorktree: (...args) =>
        this.tryGetWorkspaceSessionHostIdForWorktree(...args),
      tabs: () => this.tabs,
      terminalExecutionHostField: (...args) => this.terminalExecutionHostField(...args),
      resolvePaneAgentIdentityField: (...args) => this.resolvePaneAgentIdentityField(...args),
      pendingRestoreTimers: () => this.pendingRestoreTimers,
      pendingSoftLeavers: () => this.pendingSoftLeavers,
      providerModeSnapshotScansByPtyId: () => this.providerModeSnapshotScansByPtyId,
      providerModeTrackersByPtyId: () => this.providerModeTrackersByPtyId,
      providerSequenceOffsetByPtyId: () => this.providerSequenceOffsetByPtyId,
      preferTrackedLastTitle: () => this.preferTrackedLastTitle,
      providerSnapshotsWithLiveModeTransition: () => this.providerSnapshotsWithLiveModeTransition,
      headlessTerminals: () => this.headlessTerminals,
      closeMobileSessionTab: (...args) => this.closeMobileSessionTab(...args),
      clientEventPublishingCommands: () => this.clientEventPublishingCommands,
      getAvailableAuthoritativeWindow: (...args) => this.getAvailableAuthoritativeWindow(...args),
      assertPtyDidNotExitBeforeRegistration: (...args) =>
        this.assertPtyDidNotExitBeforeRegistration(...args),
      releaseRejectedPtyRegistrationFence: (...args) =>
        this.releaseRejectedPtyRegistrationFence(...args),
      registerPreAllocatedHandleForPty: (...args) => this.registerPreAllocatedHandleForPty(...args),
      preparePtyExecutionContext: (...args) => this.preparePtyExecutionContext(...args),
      registerPty: (...args) => this.registerPty(...args),
      issuePtyHandle: (...args) => this.issuePtyHandle(...args),
      handles: () => this.handles,
      terminalCreateIdempotency: () => this.terminalCreateIdempotency,
      getPtyLivenessVerdict: (...args) => this.getPtyLivenessVerdict(...args),
      headlessHydrationState: () => this.headlessHydrationState,
      terminalSideEffectConsumerAvailable: () => this.terminalSideEffectConsumerAvailable,
      ptyOutputSequenceById: () => this.ptyOutputSequenceById,
      terminalSideEffectLocalConsumerAvailable: () => this.terminalSideEffectLocalConsumerAvailable,
      layoutQueues: () => this.layoutQueues,
      coalescesWith: (...args) => this.coalescesWith(...args),
      subscriberDrivenProviderAttachesByPtyId: () => this.subscriberDrivenProviderAttachesByPtyId,
      isKnownUnattachedLocalDaemonPty: (...args) => this.isKnownUnattachedLocalDaemonPty(...args),
      terminalFocusNavigationCoalescer: () => this.terminalFocusNavigationCoalescer,
      currentDriver: () => this.currentDriver,
      latestAgentStatusByPaneKey: () => this.latestAgentStatusByPaneKey,
      orchestrationCommands: () => this.orchestrationCommands,
      hookAgentRowResolutionCommands: () => this.hookAgentRowResolutionCommands,
      agentPromptLifecycleByPtyId: () => this.agentPromptLifecycleByPtyId,
      ptyTitleTrackersByPtyId: () => this.ptyTitleTrackersByPtyId,
      terminalTopologyRevisionByRepoId: () => this.terminalTopologyRevisionByRepoId,
      managedWorktrees: () => this.managedWorktrees,
      rawTerminalViewSubscriberCounts: () => this.rawTerminalViewSubscriberCounts,
      remoteTerminalViewSubscriberCounts: () => this.remoteTerminalViewSubscriberCounts,
      providerSnapshotPreferredPtys: () => this.providerSnapshotPreferredPtys,
      getPrimaryLeafForPty: (...args) => this.getPrimaryLeafForPty(...args),
      isPtyRunningAgent: (...args) => this.isPtyRunningAgent(...args),
      isRecognizedForegroundAgentProcess: (...args) =>
        this.isRecognizedForegroundAgentProcess(...args),
      markRemoteWorkspaceTrustedForAgent: (...args) =>
        this.markRemoteWorkspaceTrustedForAgent(...args),
      markLocalWorkspaceTrustedForAgent: (...args) =>
        this.markLocalWorkspaceTrustedForAgent(...args),
      terminalSpawnCommandsByPtyId: () => this.terminalSpawnCommandsByPtyId,
      fitOverrideListeners: () => this.fitOverrideListeners,
      resizeListeners: () => this.resizeListeners,
      waitBlockedCheckStateByPtyId: () => this.waitBlockedCheckStateByPtyId,
      agentStatusOscProcessorsByPtyId: () => this.agentStatusOscProcessorsByPtyId,
      providerVisibleStateByPtyId: () => this.providerVisibleStateByPtyId,
      providerVisibleRetryAtByPtyId: () => this.providerVisibleRetryAtByPtyId,
      reconcileLegacyWorkerTerminalsNow: (...args) =>
        this.reconcileLegacyWorkerTerminalsNow(...args),
      recordPtyWorktree: (...args) => this.recordPtyWorktree(...args),
      recordAgentPromptPermissionObservation: (...args) =>
        this.recordAgentPromptPermissionObservation(...args),
      terminalPaneRecoveryByIdentity: () => this.terminalPaneRecoveryByIdentity,
      terminalCwdByPtyId: () => this.terminalCwdByPtyId,
      waitersByHandle: () => this.waitersByHandle,
      folderWorkspaceToResolvedWorktree: (...args) =>
        this.folderWorkspaceToResolvedWorktree(...args),
      agentPromptSubmissionTailByPtyId: () => this.agentPromptSubmissionTailByPtyId,
      providerBufferAcquisitionsByPtyId: () => this.providerBufferAcquisitionsByPtyId,
      driverListeners: () => this.driverListeners,
      setPairedRendererSessionOwnership: (...args) =>
        this.setPairedRendererSessionOwnership(...args),
      pairedRendererSessionOwnedPtyIds: () => this.pairedRendererSessionOwnedPtyIds,
      dataListeners: () => this.dataListeners,
      messageWaitersByHandle: () => this.messageWaitersByHandle,
      graphSyncCallbacks: () => this.graphSyncCallbacks,
      setupCompletionTokenByPtyId: () => this.setupCompletionTokenByPtyId,
      getPtyWriteHostPlatform: (...args) => this.getPtyWriteHostPlatform(...args),
      getAgentPromptActivity: (...args) => this.getAgentPromptActivity(...args),
      assertAgentPromptPermissionSafe: (...args) => this.assertAgentPromptPermissionSafe(...args),
      createAgentPromptRenderGate: (...args) => this.createAgentPromptRenderGate(...args),
      getPtyAgent: (...args) => this.getPtyAgent(...args),
      store: () => this.store,
      ptyController: () => this.ptyController,
      notifier: () => this.notifier,
      ptysById: () => this.ptysById,
      handleByPtyId: () => this.handleByPtyId,
      claudeAgentTeams: () => this.claudeAgentTeams,
      terminalAgentStatusBinding: () => this.terminalAgentStatusBinding,
      onTerminalAgentStatus: () => this.onTerminalAgentStatus,
      onTerminalSideEffects: () => this.onTerminalSideEffects,
      getAgentStatusSnapshotFn: () => this.getAgentStatusSnapshotFn,
      buildAgentHookPtyEnv: () => this.buildAgentHookPtyEnv,
      onRemoteTerminalViewPresenceChanged: () => this.onRemoteTerminalViewPresenceChanged,
      snapshotValueComparison: () => this.snapshotValueComparison,
      getAgentLaunchPlatformForRepo: (...args) => this.getAgentLaunchPlatformForRepo(...args),
      getAgentLaunchPlatformForWorkspace: (...args) =>
        this.getAgentLaunchPlatformForWorkspace(...args),
      getOrCreatePtyTitleTrackerEntry: (...args) => this.getOrCreatePtyTitleTrackerEntry(...args),
      getTrackedRawTitleForPty: (...args) => this.getTrackedRawTitleForPty(...args),
      recordOsc7MetadataForPty: (...args) => this.recordOsc7MetadataForPty(...args),
      cloneTerminalLayoutSnapshot: (...args) => this.cloneTerminalLayoutSnapshot(...args),
      collectPersistedTerminalLeafIds: (layout) =>
        this.mobileTabSnapshots.collectPersistedTerminalLeafIds(layout),
      getTerminalAgentStatusPtyId: (...args) => this.getTerminalAgentStatusPtyId(...args),
      assertTerminalAgentStatusPtyBinding: (...args) =>
        this.assertTerminalAgentStatusPtyBinding(...args),
      getTerminalAgentStatusSnapshot: (...args) => this.getTerminalAgentStatusSnapshot(...args),
      hasAuthoritativeTerminalWaitPermission: (...args) =>
        this.hasAuthoritativeTerminalWaitPermission(...args)
    })
    this.mobileSessionFacade = new RuntimeMobileSessionFacade({
      acceptedRendererMobileSnapshotByWorktree: () => this.acceptedRendererMobileSnapshotByWorktree,
      accountCommands: () => this.accountCommands,
      agentPromptExplicitStatusFloorByPtyId: () => this.agentPromptExplicitStatusFloorByPtyId,
      agentStatusOscProcessorsByPtyId: () => this.agentStatusOscProcessorsByPtyId,
      applyHeadlessSessionTabPropsToSnapshot: () => this.applyHeadlessSessionTabPropsToSnapshot,
      applyHeadlessTerminalPaneLayoutToSnapshot: () =>
        this.applyHeadlessTerminalPaneLayoutToSnapshot,
      applyMobileSessionRetirementFences: (...args) =>
        this.applyMobileSessionRetirementFences(...args),
      applyNativeChatLaunchDraftResolutionFence: (...args) =>
        this.applyNativeChatLaunchDraftResolutionFence(...args),
      applyRemoteDesktopLayout: (...args) => this.applyRemoteDesktopLayout(...args),
      assertSessionTabsInventoryRequestActive: (...args) =>
        this.assertSessionTabsInventoryRequestActive(...args),
      assertStableReadyGraph: (...args) => this.assertStableReadyGraph(...args),
      authoritativeWindowId: () => this.authoritativeWindowId,
      buildMaterializedHeadlessParentLayout: (...args: unknown[]) =>
        (this.buildMaterializedHeadlessParentLayout as (...a: unknown[]) => unknown)(...args),
      cancelAllPendingFitRestoreTimers: (...args) => this.cancelAllPendingFitRestoreTimers(...args),
      captureReadyGraphEpoch: (...args) => this.captureReadyGraphEpoch(...args),
      claudeAgentTeams: () => this.claudeAgentTeams,
      clearWaitBlockedCheckState: (...args) => this.clearWaitBlockedCheckState(...args),
      clientEventPublishingCommands: () => this.clientEventPublishingCommands,
      clientSessionTabSelections: () => this.clientSessionTabSelections,
      collectReturnedSessionTabIds: (...args) => this.collectReturnedSessionTabIds(...args),
      createTerminal: (...args) => this.createTerminal(...args),
      currentDriver: () => this.currentDriver,
      delayPtyBackedMobileSnapshotForForegroundAgent: () =>
        this.delayPtyBackedMobileSnapshotForForegroundAgent,
      deliverPendingStartupCommandToBareRendererPty: (...args) =>
        this.deliverPendingStartupCommandToBareRendererPty(...args),
      detachedPreAllocatedLeaves: () => this.detachedPreAllocatedLeaves,
      disposeHeadlessTerminal: (...args) => this.disposeHeadlessTerminal(...args),
      disposePtyTitleTracker: () => this.disposePtyTitleTracker,
      earlyExitedPtyIncarnations: () => this.earlyExitedPtyIncarnations,
      enqueueLayout: (...args) => this.enqueueLayout(...args),
      findHandleForPtyRecord: (...args) => this.findHandleForPtyRecord(...args),
      findLiveRegisteredPtyForRendererTab: (...args) =>
        this.findLiveRegisteredPtyForRendererTab(...args),
      forgetPtyLivenessVerdict: (...args) => this.forgetPtyLivenessVerdict(...args),
      freshSubscribeGuard: () => this.freshSubscribeGuard,
      getAgentLaunchPlatformForWorkspace: (...args) =>
        this.getAgentLaunchPlatformForWorkspace(...args),
      getAgentProviderSessionRowsForPaneFn: () => this.getAgentProviderSessionRowsForPaneFn,
      getAgentProviderSessionSnapshotFn: () => this.getAgentProviderSessionSnapshotFn,
      getAgentStatusSnapshotFn: () => this.getAgentStatusSnapshotFn,
      getAuthoritativeSessionTabsInventoryEpoch: (...args) =>
        this.getAuthoritativeSessionTabsInventoryEpoch(...args),
      getAutoRestoreFitMs: (...args) => this.getAutoRestoreFitMs(...args),
      getAvailableAuthoritativeWindow: (...args) => this.getAvailableAuthoritativeWindow(...args),
      getDriver: (...args) => this.getDriver(...args),
      getHookAgentRowForPane: (...args) => this.getHookAgentRowForPane(...args),
      getKnownWorkspaceSessionWorktreeIds: (...args) =>
        this.getKnownWorkspaceSessionWorktreeIds(...args),
      getLeafKey: (...args) => this.getLeafKey(...args),
      getLeavesForPty: (...args) => this.getLeavesForPty(...args),
      getLiveBrowserTabsByPageId: (...args) => this.getLiveBrowserTabsByPageId(...args),
      getLivePtyForHandle: (...args) => this.getLivePtyForHandle(...args),
      getMobileSessionTopLevelTabId: () => this.getMobileSessionTopLevelTabId,
      getTerminalSize: (...args) => this.getTerminalSize(...args),
      getUnpersistedTrackedTitleForPty: () => this.getUnpersistedTrackedTitleForPty,
      getValidatedExplicitWorktreeIdSelector: (...args) =>
        this.getValidatedExplicitWorktreeIdSelector(...args),
      getWorkspaceSessionHydrationTargets: (...args) =>
        this.getWorkspaceSessionHydrationTargets(...args),
      graphStatus: () => this.graphStatus,
      graphSyncCallbacks: () => this.graphSyncCallbacks,
      handleByLeafKey: () => this.handleByLeafKey,
      handleByPtyId: () => this.handleByPtyId,
      hasLiveShellForRendererTab: (...args) => this.hasLiveShellForRendererTab(...args),
      hasRemoteDesktopLayoutState: (...args) => this.hasRemoteDesktopLayoutState(...args),
      hasRemoteDesktopViewers: (...args) => this.hasRemoteDesktopViewers(...args),
      hasServeOrSshOwnedBinding: (...args: unknown[]) =>
        (this.hasServeOrSshOwnedBinding as (...a: unknown[]) => unknown)(...args),
      headlessHydrationState: () => this.headlessHydrationState,
      headlessSessionTabPersistenceCommands: () => this.headlessSessionTabPersistenceCommands,
      headlessTerminals: () => this.headlessTerminals,
      hookAgentRowResolutionCommands: () => this.hookAgentRowResolutionCommands,
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(...args),
      isDeliberatelyParkedPane: (...args) => this.isDeliberatelyParkedPane(...args),
      isHeadlessBuiltMobileSessionPublicationBase: (...args) =>
        this.isHeadlessBuiltMobileSessionPublicationBase(...args),
      isHeadlessMobileSessionPublication: (...args) =>
        this.isHeadlessMobileSessionPublication(...args),
      isKnownUnattachedLocalDaemonPty: (...args) => this.isKnownUnattachedLocalDaemonPty(...args),
      isMobileSessionSurfaceMembershipAllowed: (...args) =>
        this.isMobileSessionSurfaceMembershipAllowed(...args),
      isTerminalAlternateScreen: (...args) => this.isTerminalAlternateScreen(...args),
      issuePtyHandle: (...args) => this.issuePtyHandle(...args),
      lastRendererSizes: () => this.lastRendererSizes,
      latestAgentStatusByPaneKey: () => this.latestAgentStatusByPaneKey,
      layouts: () => this.layouts,
      leaves: () => this.leaves,
      legacyWorkerRecoveredPtys: () => this.legacyWorkerRecoveredPtys,
      listMobileFiles: () => this.listMobileFiles,
      listResolvedWorktrees: (...args) => this.listResolvedWorktrees(...args),
      listRuntimeMarkdownDocuments: () => this.listRuntimeMarkdownDocuments,
      managedWorktrees: () => this.managedWorktrees,
      markWorkspaceTrustedForAgent: (...args) => this.markWorkspaceTrustedForAgent(...args),
      mobileNotificationReplay: () => this.mobileNotificationReplay,
      mobileSessionTabListeners: () => this.mobileSessionTabListeners,
      mobileSessionTabsAgentStatusHeartbeat: () => this.mobileSessionTabsAgentStatusHeartbeat,
      mobileSessionTabsByWorktree: () => this.mobileSessionTabsByWorktree,
      nextMobileSessionTabsChangeSequence: () => {
        const v = this.mobileSessionTabsChangeSequence + 1
        this.mobileSessionTabsChangeSequence = v
        return v
      },
      mobileSnapshotMerge: () => this.mobileSnapshotMerge,
      mobileSubscribers: () => this.mobileSubscribers,
      mobileTabSnapshots: () => this.mobileTabSnapshots,
      notificationListeners: () => this.notificationListeners,
      notifier: () => this.notifier,
      notifyFitOverrideListeners: (...args) => this.notifyFitOverrideListeners(...args),
      notifyMobileSessionTabsChanged: (...args) => this.notifyMobileSessionTabsChanged(...args),
      notifyRemoteTerminalViewPresenceChanged: (...args) =>
        this.notifyRemoteTerminalViewPresenceChanged(...args),
      notifyTerminalResize: (...args) => this.notifyTerminalResize(...args),
      offscreenBrowserBackend: () => this.offscreenBrowserBackend,
      openMobileDiff: () => this.openMobileDiff,
      openMobileFile: () => this.openMobileFile,
      osc7ScanTailByPtyId: () => this.osc7ScanTailByPtyId,
      oscTitleScanTailByPtyId: () => this.oscTitleScanTailByPtyId,
      pairedRendererSessionOwnedPtyIds: () => this.pairedRendererSessionOwnedPtyIds,
      pendingMobileTerminalCreatesByKey: () => this.pendingMobileTerminalCreatesByKey,
      pendingPtyRegistrationIncarnations: () => this.pendingPtyRegistrationIncarnations,
      pendingRestoreTimers: () => this.pendingRestoreTimers,
      pendingSoftLeavers: () => this.pendingSoftLeavers,
      persistHeadlessSessionTabProps: () => this.persistHeadlessSessionTabProps,
      persistHeadlessTabGroups: (...args) => this.persistHeadlessTabGroups(...args),
      persistHeadlessTerminalActiveLeaf: (...args) =>
        this.persistHeadlessTerminalActiveLeaf(...args),
      persistHeadlessTerminalPaneLayout: () => this.persistHeadlessTerminalPaneLayout,
      persistHeadlessTerminalTabOrder: (...args: unknown[]) =>
        (this.persistHeadlessTerminalTabOrder as (...a: unknown[]) => unknown)(...args),
      pickEarliestRestoreTarget: (...args) => this.pickEarliestRestoreTarget(...args),
      pickMostRecentActor: (...args) => this.pickMostRecentActor(...args),
      providerBufferAcquisitionsByPtyId: () => this.providerBufferAcquisitionsByPtyId,
      providerModeSnapshotScansByPtyId: () => this.providerModeSnapshotScansByPtyId,
      providerModeTrackersByPtyId: () => this.providerModeTrackersByPtyId,
      providerSequenceInitializedPtys: () => this.providerSequenceInitializedPtys,
      providerSequenceOffsetByPtyId: () => this.providerSequenceOffsetByPtyId,
      providerSnapshotPreferredPtys: () => this.providerSnapshotPreferredPtys,
      providerSnapshotsWithLiveModeTransition: () => this.providerSnapshotsWithLiveModeTransition,
      providerVisibleRetryAtByPtyId: () => this.providerVisibleRetryAtByPtyId,
      providerVisibleStateByPtyId: () => this.providerVisibleStateByPtyId,
      pruneDisconnectedPtyTranscript: (...args) => this.pruneDisconnectedPtyTranscript(...args),
      ptyController: () => this.ptyController,
      ptyDelayedForegroundSnapshotTitleObservations: () =>
        this.ptyDelayedForegroundSnapshotTitleObservations,
      ptyOutputSequenceById: () => this.ptyOutputSequenceById,
      ptysById: () => this.ptysById,
      rawTerminalViewSubscriberCounts: () => this.rawTerminalViewSubscriberCounts,
      readMobileFile: () => this.readMobileFile,
      readProviderTerminalTailLines: (...args) => this.readProviderTerminalTailLines(...args),
      readVisibleTerminalState: (...args) => this.readVisibleTerminalState(...args),
      recentPtyOutputById: () => this.recentPtyOutputById,
      recentPtyPathCandidatesById: () => this.recentPtyPathCandidatesById,
      reconcileNativeChatLaunchDraftResolutionTombstones: (...args) =>
        this.reconcileNativeChatLaunchDraftResolutionTombstones(...args),
      recordPtyWorktree: (...args) => this.recordPtyWorktree(...args),
      refreshPtyWorktreeRecordsWithControllerInventory: (...args) =>
        this.refreshPtyWorktreeRecordsWithControllerInventory(...args),
      releaseRuntimeSessionOwnershipForRendererRetiredTabs: (...args: unknown[]) =>
        (this.releaseRuntimeSessionOwnershipForRendererRetiredTabs as (...a: unknown[]) => unknown)(
          ...args
        ),
      remoteDesktopHostReclaimTargets: () => this.remoteDesktopHostReclaimTargets,
      remoteDesktopOwners: () => this.remoteDesktopOwners,
      remoteDesktopViewerRevisions: () => this.remoteDesktopViewerRevisions,
      remoteDesktopViewers: () => this.remoteDesktopViewers,
      remoteTerminalViewSubscriberCounts: () => this.remoteTerminalViewSubscriberCounts,
      removePersistedHeadlessTerminalTab: (...args: unknown[]) =>
        (this.removePersistedHeadlessTerminalTab as (...a: unknown[]) => unknown)(...args),
      rendererPublicationThrottle: () => this.rendererPublicationThrottle,
      resizeListeners: () => this.resizeListeners,
      resolveDesktopRestoreTarget: (...args) => this.resolveDesktopRestoreTarget(...args),
      resolveExitWaiters: (...args) => this.resolveExitWaiters(...args),
      resolvePtyExitWaiters: (...args) => this.resolvePtyExitWaiters(...args),
      resolveTerminalWorkspaceLaunchScope: (...args) =>
        this.resolveTerminalWorkspaceLaunchScope(...args),
      resolveWorkspaceTerminalStartupCwd: (...args) =>
        this.resolveWorkspaceTerminalStartupCwd(...args),
      resolveWorktreeSelector: (...args) => this.resolveWorktreeSelector(...args),
      retireMobileSessionSurfacesForPty: (...args) =>
        this.retireMobileSessionSurfacesForPty(...args),
      searchMobileFilePaths: () => this.searchMobileFilePaths,
      seedHeadlessTerminal: (...args) => this.seedHeadlessTerminal(...args),
      setDriver: (...args) => this.setDriver(...args),
      setPairedRendererSessionOwnership: (...args) =>
        this.setPairedRendererSessionOwnership(...args),
      settleSessionTabsInventory: (...args) => this.settleSessionTabsInventory(...args),
      setupCompletionTokenByPtyId: () => this.setupCompletionTokenByPtyId,
      shouldDelayPtyBackedMobileSnapshotForForegroundAgent: () =>
        this.shouldDelayPtyBackedMobileSnapshotForForegroundAgent,
      snapshotValueComparison: () => this.snapshotValueComparison,
      store: () => this.store,
      tabs: () => this.tabs,
      terminalCwdByPtyId: () => this.terminalCwdByPtyId,
      terminalFileUriHostnameByPtyId: () => this.terminalFileUriHostnameByPtyId,
      terminalFitOverrides: () => this.terminalFitOverrides,
      terminalSpawnCommandsByPtyId: () => this.terminalSpawnCommandsByPtyId,
      trackHeadlessTerminalData: (...args) => this.trackHeadlessTerminalData(...args),
      waitForSessionTabsInventoryPublication: (...args) =>
        this.waitForSessionTabsInventoryPublication(...args),
      withClientHostedPagesHold: (...args: unknown[]) =>
        (this.withClientHostedPagesHold as (...a: unknown[]) => unknown)(...args),
      wslDistroByPtyId: () => this.wslDistroByPtyId
    })

    this.ptyWorktrees = new RuntimePtyWorktrees({
      adoptTerminalOrphansFromInventory: (...args) =>
        this.adoptTerminalOrphansFromInventory(...args),
      agentPromptExplicitStatusFloorByPtyId: () => this.agentPromptExplicitStatusFloorByPtyId,
      agentPromptLifecycleByPtyId: () => this.agentPromptLifecycleByPtyId,
      agentPromptPermissionSequenceByPtyId: () => this.agentPromptPermissionSequenceByPtyId,
      agentStatusOscProcessorsByPtyId: () => this.agentStatusOscProcessorsByPtyId,
      assertGraphReady: (...args) => this.assertGraphReady(...args),
      cancelPendingDriverMutations: (...args) => this.cancelPendingDriverMutations(...args),
      claudeAgentTeams: () => this.claudeAgentTeams,
      clearAgentRowSnapshotsForPty: (...args) => this.clearAgentRowSnapshotsForPty(...args),
      clearWaitBlockedCheckState: (...args) => this.clearWaitBlockedCheckState(...args),
      dataListeners: () => this.dataListeners,
      disposeHeadlessTerminal: (...args) => this.disposeHeadlessTerminal(...args),
      disposePtyTitleTracker: () => this.disposePtyTitleTracker,
      earlyExitedPtyIncarnations: () => this.earlyExitedPtyIncarnations,
      emitTerminalAgentStatusEvents: (...args) => this.emitTerminalAgentStatusEvents(...args),
      ensurePtyBackedMobileSurfaceForRendererTab: (...args) =>
        this.ensurePtyBackedMobileSurfaceForRendererTab(...args),
      failActiveDispatchOnExit: (...args) => this.failActiveDispatchOnExit(...args),
      flushPendingTerminalSideEffectFacts: (...args) =>
        this.flushPendingTerminalSideEffectFacts(...args),
      flushWorkspaceSessionOrThrowAsync: (...args) =>
        this.flushWorkspaceSessionOrThrowAsync(...args),
      folderWorkspaceToResolvedWorktree: (...args) =>
        this.folderWorkspaceToResolvedWorktree(...args),
      freshSubscribeGuard: () => this.freshSubscribeGuard,
      getDriver: (...args) => this.getDriver(...args),
      getLeafKey: (...args) => this.getLeafKey(...args),
      getMobileSessionTabsForWorktree: (...args) => this.getMobileSessionTabsForWorktree(...args),
      getMobileTerminalPaneKey: (...args) => this.getMobileTerminalPaneKey(...args),
      getOrCreatePtyTitleTrackerEntry: () => this.getOrCreatePtyTitleTrackerEntry,
      getOrchestrationDb: (...args) => this.getOrchestrationDb(...args),
      getRendererTerminalSerializerGeneration: (...args) =>
        this.getRendererTerminalSerializerGeneration(...args),
      getWorkspaceSessionHostIdForWorktree: (...args) =>
        this.getWorkspaceSessionHostIdForWorktree(...args),
      graphStatus: () => this.graphStatus,
      graphSyncCallbacks: () => this.graphSyncCallbacks,
      handleByLeafKey: () => this.handleByLeafKey,
      handleByPtyId: () => this.handleByPtyId,
      handleByPtyIncarnation: () => this.handleByPtyIncarnation,
      handles: () => this.handles,
      headlessTerminals: () => this.headlessTerminals,
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(...args),
      intentionalHandlelessPtyStops: () => this.intentionalHandlelessPtyStops,
      isRecognizedForegroundAgentProcess: (...args) =>
        this.isRecognizedForegroundAgentProcess(...args),
      isRemoteDesktopResizeDriven: (...args) => this.isRemoteDesktopResizeDriven(...args),
      layoutQueues: () => this.layoutQueues,
      layouts: () => this.layouts,
      leaves: () => this.leaves,
      leavesByPtyId: () => this.leavesByPtyId,
      legacyWorkerRecoveredPtys: () => this.legacyWorkerRecoveredPtys,
      legacyWorkerTerminalRecoveryRetries: () => this.legacyWorkerTerminalRecoveryRetries,
      makeRuntimePaneKey: (...args) => this.makeRuntimePaneKey(...args),
      managedWorktrees: () => this.managedWorktrees,
      maybeHydrateHeadlessFromRenderer: (...args) => this.maybeHydrateHeadlessFromRenderer(...args),
      messageWaitersByHandle: () => this.messageWaitersByHandle,
      mobileSessionTabsByWorktree: () => this.mobileSessionTabsByWorktree,
      mobileTabSnapshots: () => this.mobileTabSnapshots,
      notifier: () => this.notifier,
      notifyMobileSessionTabsChanged: (...args) => this.notifyMobileSessionTabsChanged(...args),
      osc7ScanTailByPtyId: () => this.osc7ScanTailByPtyId,
      oscTitleScanTailByPtyId: () => this.oscTitleScanTailByPtyId,
      pairedRendererSessionOwnedPtyIds: () => this.pairedRendererSessionOwnedPtyIds,
      pathFlavorForPty: () => this.pathFlavorForPty,
      pendingMobileTerminalCreatesByKey: () => this.pendingMobileTerminalCreatesByKey,
      pendingPtyRegistrationIncarnations: () => this.pendingPtyRegistrationIncarnations,
      processAgentStatusOscForPty: (...args) => this.processAgentStatusOscForPty(...args),
      providerBufferAcquisitionsByPtyId: () => this.providerBufferAcquisitionsByPtyId,
      providerModeSnapshotScansByPtyId: () => this.providerModeSnapshotScansByPtyId,
      providerModeTrackersByPtyId: () => this.providerModeTrackersByPtyId,
      providerSequenceInitializedPtys: () => this.providerSequenceInitializedPtys,
      providerSequenceOffsetByPtyId: () => this.providerSequenceOffsetByPtyId,
      providerSnapshotPreferredPtys: () => this.providerSnapshotPreferredPtys,
      providerVisibleRetryAtByPtyId: () => this.providerVisibleRetryAtByPtyId,
      providerVisibleStateByPtyId: () => this.providerVisibleStateByPtyId,
      ptyExitListenersByPtyId: () => this.ptyExitListenersByPtyId,
      ptyExit_notifyTabAndMobile: (...args) => this.ptyExit_notifyTabAndMobile(...args),
      ptyLifecycleGenerationById: () => this.ptyLifecycleGenerationById,
      ptyLivenessObservationSequence: () => this.ptyLivenessObservationSequence,
      ptyLivenessVerdictByPtyId: () => this.ptyLivenessVerdictByPtyId,
      ptyOutputSequenceById: () => this.ptyOutputSequenceById,
      ptysById: () => this.ptysById,
      recentPtyOutputById: () => this.recentPtyOutputById,
      recentPtyPathCandidatesById: () => this.recentPtyPathCandidatesById,
      reconcileAgentStatusForEndedProcessFn: () => this.reconcileAgentStatusForEndedProcessFn,
      reconcileLegacyWorkerTerminalsNow: (...args) =>
        this.reconcileLegacyWorkerTerminalsNow(...args),
      recordOsc7MetadataForPty: () => this.recordOsc7MetadataForPty,
      recordRecentPtyOutputForPathProvenance: (...args) =>
        this.recordRecentPtyOutputForPathProvenance(...args),
      refreshPtyForegroundAgent: () => this.refreshPtyForegroundAgent,
      rendererGraphEpoch: () => this.rendererGraphEpoch,
      replaceHeadlessTerminalAfterExecutionContextChange: (...args) =>
        this.replaceHeadlessTerminalAfterExecutionContextChange(...args),
      resetTrackedTerminalStateForProviderGeneration: () =>
        this.resetTrackedTerminalStateForProviderGeneration,
      resolvePaneAgentIdentityField: (...args) => this.resolvePaneAgentIdentityField(...args),
      resolveTerminalWorkspaceLaunchScope: (...args) =>
        this.resolveTerminalWorkspaceLaunchScope(...args),
      resolveWorktreeSelector: (...args) => this.resolveWorktreeSelector(...args),
      restoreAgentPromptLifecycleByteOrder: (...args) =>
        this.restoreAgentPromptLifecycleByteOrder(...args),
      restoredOrchestrationAuthorityByPtyId: () => this.restoredOrchestrationAuthorityByPtyId,
      retireAgentHookCompatibilityAuthorityFn: () => this.retireAgentHookCompatibilityAuthorityFn,
      retireOrchestrationMailboxDeliveryForPty: (...args) =>
        this.retireOrchestrationMailboxDeliveryForPty(...args),
      runtimeId: () => this.runtimeId,
      scheduleWaitBlockedCheck: (...args) => this.scheduleWaitBlockedCheck(...args),
      setupCompletionTokenByPtyId: () => this.setupCompletionTokenByPtyId,
      shouldAnswerQueriesForLiveChunk: (...args) => this.shouldAnswerQueriesForLiveChunk(...args),
      snapshotValueComparison: () => this.snapshotValueComparison,
      spawnPublishedPtys: () => this.spawnPublishedPtys,
      stopRequestedPtyIds: () => this.stopRequestedPtyIds,
      store: () => this.store,
      subscriberDrivenProviderAttachInventoryWaiters: () =>
        this.subscriberDrivenProviderAttachInventoryWaiters,
      subscriberDrivenProviderAttachesByPtyId: () => this.subscriberDrivenProviderAttachesByPtyId,
      syntheticTerminalHandles: () => this.syntheticTerminalHandles,
      tabs: () => this.tabs,
      terminalCwdByPtyId: () => this.terminalCwdByPtyId,
      terminalExecutionHostField: (...args) => this.terminalExecutionHostField(...args),
      terminalFileUriHostnameByPtyId: () => this.terminalFileUriHostnameByPtyId,
      terminalSpawnCommandsByPtyId: () => this.terminalSpawnCommandsByPtyId,
      trackHeadlessTerminalData: (...args) => this.trackHeadlessTerminalData(...args),
      tryGetWorkspaceSessionHostIdForWorktree: (...args) =>
        this.tryGetWorkspaceSessionHostIdForWorktree(...args),
      waitersByHandle: () => this.waitersByHandle,
      wslDistroByPtyId: () => this.wslDistroByPtyId,
      reconcileLegacyWorkerTerminals: (...args) => this.reconcileLegacyWorkerTerminals(...args),
      nextPtyLifecycleGeneration: () => this.nextPtyLifecycleGeneration,
      setNextPtyLifecycleGeneration: (value) => {
        this.nextPtyLifecycleGeneration = value
      },
      setPtyLivenessObservationSequence: (value) => {
        this.ptyLivenessObservationSequence = value
      },
      ptyController: () => this.ptyController,
      livenessApi: () =>
        // Why: the verdict helpers need earlyExited/pending maps plus the
        // absence-probe caches, which now live on the facade itself.
        ({
          earlyExitedPtyIncarnations: this.earlyExitedPtyIncarnations,
          pendingPtyRegistrationIncarnations: this.pendingPtyRegistrationIncarnations,
          stopRequestedPtyIds: this.stopRequestedPtyIds,
          provenAbsentLeafPtyVerdicts: this.ptyWorktrees.provenAbsentLeafPtyVerdicts,
          leafPtyAbsenceProbes: this.ptyWorktrees.leafPtyAbsenceProbes,
          ptyController: this.ptyController
            ? {
                probePtyLiveness: async (ptyId) =>
                  Boolean(await this.ptyController?.probePtyLiveness?.(ptyId))
              }
            : undefined,
          controllerKnowsPtyIsLive: (ptyId) => this.controllerKnowsPtyIsLive(ptyId),
          forgetPtyLivenessVerdict: (ptyId, observedNoLaterThan) =>
            this.forgetPtyLivenessVerdict(ptyId, observedNoLaterThan),
          getOrCreatePtyWorktreeRecord: (ptyId) => this.getOrCreatePtyWorktreeRecord(ptyId),
          getLeavesForPty: (ptyId) => this.getLeavesForPty(ptyId),
          adoptPreAllocatedHandle: (leaf) =>
            this.adoptPreAllocatedHandle(leaf as RuntimeLeafRecord),
          recordPtyWorktree: (ptyId, worktreeId, opts) =>
            this.recordPtyWorktree(ptyId, worktreeId, opts),
          ensurePtyBackedMobileSurfaceForRendererTab: (worktreeId, tabId) =>
            this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, tabId),
          graphStatus: this.graphStatus,
          spawnPublishedPtys: this.spawnPublishedPtys,
          pendingMobileTerminalCreatesByKey: this.pendingMobileTerminalCreatesByKey,
          ptysById: this.ptysById,
          handleByPtyId: this.handleByPtyId,
          leafExistsForPty: (ptyId) => this.leafExistsForPty(ptyId)
        }),
      setPtyControllerRef: (controller) => {
        this.ptyController = controller
      }
    })
    this.managedWorktrees = new RuntimeManagedWorktrees({
      _orchestrationDb: this._orchestrationDb,
      acceptedRendererMobileSnapshotByWorktree: () => this.acceptedRendererMobileSnapshotByWorktree,
      adoptControllerTerminalHandle: (...args) => this.adoptControllerTerminalHandle(...args),
      agentBrowserBridge: this.agentBrowserBridge,
      assertGraphReady: (...args) => this.assertGraphReady(...args),
      assertStableReadyGraph: (...args) => this.assertStableReadyGraph(...args),
      attachAgentRowsToSummaries: (...args) => this.attachAgentRowsToSummaries(...args),
      authoritativeWindowId: () => this.authoritativeWindowId,
      buildResolvedWorktreeFromId: (...args) => this.buildResolvedWorktreeFromId(...args),
      buildStartupForAgent: (...args) => this.buildStartupForAgent(...args),
      buildStartupForDraft: (...args) => this.buildStartupForDraft(...args),
      captureReadyGraphEpoch: (...args) => this.captureReadyGraphEpoch(...args),
      clientEventPublishingCommands: this.clientEventPublishingCommands,
      createDefaultTabTerminals: (...args) => this.createDefaultTabTerminals(...args),
      createTerminal: (...args) => this.createTerminal(...args),
      emitClientEvent: (...args) => this.emitClientEvent(...args),
      fetchRemoteWithCache: (...args) => this.fetchRemoteWithCache(...args),
      forgetPtyLivenessVerdict: (...args) => this.forgetPtyLivenessVerdict(...args),
      getAvailableAuthoritativeWindow: (...args) => this.getAvailableAuthoritativeWindow(...args),
      getLeafKey: (...args) => this.getLeafKey(...args),
      getLivePtyForHandle: (...args) => this.getLivePtyForHandle(...args),
      getLocalProvider: (...args) => this.getLocalProvider(...args),
      getOrStartRemoteFetch: (...args) => this.getOrStartRemoteFetch(...args),
      getOrStartRemoteTrackingBaseRefresh: (...args) =>
        this.getOrStartRemoteTrackingBaseRefresh(...args),
      getPtyRecordForPaneKey: (...args) => this.getPtyRecordForPaneKey(...args),
      getRecordedTerminalSleepHandles: (...args) => this.getRecordedTerminalSleepHandles(...args),
      getResolvedWorktreeMap: (...args) => this.getResolvedWorktreeMap(...args),
      getRuntimeId: (...args) => this.getRuntimeId(...args),
      getSshProviderFn: () => this.getSshProviderFn,
      getStartedAt: (...args) => this.getStartedAt(...args),
      getTerminalHandlesForPtyId: (...args) => this.getTerminalHandlesForPtyId(...args),
      graphStatus: () => this.graphStatus,
      hasFreshResolvedWorktreeCache: (...args) => this.hasFreshResolvedWorktreeCache(...args),
      hasRemoteTrackingRef: (...args) => this.hasRemoteTrackingRef(...args),
      hookAgentRowResolutionCommands: this.hookAgentRowResolutionCommands,
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(...args),
      intentionalHandlelessPtyStops: () => this.intentionalHandlelessPtyStops,
      invalidatePtyIncarnationHandle: (...args) => this.invalidatePtyIncarnationHandle(...args),
      invalidateResolvedWorktreeCache: (...args) => this.invalidateResolvedWorktreeCache(...args),
      invalidateSshWorktreeScanCacheInternal: (...args) =>
        this.invalidateSshWorktreeScanCacheInternal(...args),
      invalidateWorktreeScanCacheForRepo: (...args) =>
        this.invalidateWorktreeScanCacheForRepo(...args),
      leafExistsForPty: (...args) => this.leafExistsForPty(...args),
      leaves: () => this.leaves,
      listResolvedWorktreeSnapshot: (...args) => this.listResolvedWorktreeSnapshot(...args),
      listResolvedWorktrees: (...args) => this.listResolvedWorktrees(...args),
      makeRuntimePaneKey: (...args) => this.makeRuntimePaneKey(...args),
      markLocalWorkspaceTrustedForAgent: (...args) =>
        this.markLocalWorkspaceTrustedForAgent(...args),
      markPtyLivenessUnverifiable: (...args) => this.markPtyLivenessUnverifiable(...args),
      markRemoteWorkspaceTrustedForAgent: (...args) =>
        this.markRemoteWorkspaceTrustedForAgent(...args),
      mobileSessionTabsAgentStatusHeartbeat: () => this.mobileSessionTabsAgentStatusHeartbeat,
      mobileSessionTabsByWorktree: () => this.mobileSessionTabsByWorktree,
      mobileTabSnapshots: () => this.mobileTabSnapshots,
      nextTitleObservationSequence: (...args) => this.nextTitleObservationSequence(...args),
      notifier: this.notifier,
      notifyMobileSessionTabsChanged: (...args) => this.notifyMobileSessionTabsChanged(...args),
      offscreenBrowserBackend: this.offscreenBrowserBackend,
      onPtyStopped: () => this.onPtyStopped,
      pasteStartupDraftWhenReady: (...args) => this.pasteStartupDraftWhenReady(...args),
      projectMobileSessionTabsForClient: (...args) =>
        this.projectMobileSessionTabsForClient(...args),
      pruneDisconnectedPtyRecords: (...args) => this.pruneDisconnectedPtyRecords(...args),
      ptyController: this.ptyController,
      ptyLivenessVerdictByPtyId: () => this.ptyLivenessVerdictByPtyId,
      ptyLivenessObservationSequence: () => this.ptyLivenessObservationSequence,
      ptysById: () => this.ptysById,
      reconcileSubscriberDrivenProviderAttach: (...args) =>
        this.reconcileSubscriberDrivenProviderAttach(...args),
      refreshFloatingWorkspacePtyLiveness: (...args) =>
        this.refreshFloatingWorkspacePtyLiveness(...args),
      refreshMobileSessionPtyRecords: (...args) => this.refreshMobileSessionPtyRecords(...args),
      refreshPtyForegroundAgent: () => this.refreshPtyForegroundAgent,
      rememberRestoredOrchestrationAuthority: (...args) =>
        this.rememberRestoredOrchestrationAuthority(...args),
      requireStore: (...args) => this.requireStore(...args),
      resolveExplicitWorktreeIdScoped: (...args) => this.resolveExplicitWorktreeIdScoped(...args),
      resolveFolderWorkspaceConnectionId: (...args) =>
        this.resolveFolderWorkspaceConnectionId(...args),
      resolveLineageCandidateForTaskId: (...args) => this.resolveLineageCandidateForTaskId(...args),
      resolveRemoteTrackingBase: (...args) => this.resolveRemoteTrackingBase(...args),
      resolveRepoSelector: (...args) => this.resolveRepoSelector(...args),
      resolveWorkspaceParentSelector: (...args) => this.resolveWorkspaceParentSelector(...args),
      restoredOrchestrationAuthorityByPtyId: () => this.restoredOrchestrationAuthorityByPtyId,
      sendStartupFollowupWhenReady: (...args) => this.sendStartupFollowupWhenReady(...args),
      setPtyManagementTitleFromObservedTitle: (...args) =>
        this.setPtyManagementTitleFromObservedTitle(...args),
      setupCompletionTokenByPtyId: () => this.setupCompletionTokenByPtyId,
      showTerminal: (...args) => this.showTerminal(...args),
      snapshotValueComparison: () => this.snapshotValueComparison,
      splitTerminal: (...args) => this.splitTerminal(...args),
      store: this.store,
      tabs: () => this.tabs,
      terminalMutationTailByWorktreeId: () => this.terminalMutationTailByWorktreeId,
      terminalSleepByWorktreeId: () => this.terminalSleepByWorktreeId,
      terminalSleepStateByWorktreeId: () => this.terminalSleepStateByWorktreeId,
      toMobileSessionTabsResult: (...args) => this.toMobileSessionTabsResult(...args),
      validateLineageParent: (...args) => this.validateLineageParent(...args),
      wslDistroByPtyId: () => this.wslDistroByPtyId,
      getHostedReviewExecutionOptions: (...args) => this.getHostedReviewExecutionOptions(...args),
      getLocalGitExecutionOptionArgs: (...args) => this.getLocalGitExecutionOptionArgs(...args)
    })
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
      store: this.store,
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
      store: this.store,
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
    const orchestrationGraphReloadDeps: RuntimeOrchestrationGraphReloadCommandsDeps = {
      store,
      graphReloadLifecycle: this.graphReloadLifecycle,
      getRendererGraphEpoch: () => this.rendererGraphEpoch,
      setRendererGraphEpoch: (value) => {
        this.rendererGraphEpoch = value
      },
      getGraphStatus: () => this.graphStatus,
      setGraphStatus: (value) => {
        this.graphStatus = value
      },
      getAuthoritativeWindowId: () => this.authoritativeWindowId,
      setAuthoritativeWindowId: (value) => {
        this.authoritativeWindowId = value
      },
      isHeadlessGraphFallbackAvailable: () => this.headlessGraphFallbackAvailable,
      setHeadlessGraphFallbackAvailable: (value) => {
        this.headlessGraphFallbackAvailable = value
      },
      getPendingHeadlessPromotionWindowId: () => this.pendingHeadlessPromotionWindowId,
      setPendingHeadlessPromotionWindowId: (value) => {
        this.pendingHeadlessPromotionWindowId = value
      },
      getRendererGeneration: () => this.rendererGeneration,
      setRendererGeneration: (value) => {
        this.rendererGeneration = value
      },
      getSessionTabsInventoryPublicationEpoch: () => this.sessionTabsInventoryPublicationEpoch,
      setSessionTabsInventoryPublicationEpoch: (value) => {
        this.sessionTabsInventoryPublicationEpoch = value
      },
      tabs: this.tabs,
      leaves: this.leaves,
      leavesByPtyId: this.leavesByPtyId,
      handles: this.handles,
      handleByLeafKey: this.handleByLeafKey,
      handleByPtyId: this.handleByPtyId,
      handleByPtyIncarnation: this.handleByPtyIncarnation,
      detachedPreAllocatedLeaves: this.detachedPreAllocatedLeaves,
      waitersByHandle: this.waitersByHandle,
      ptysById: this.ptysById,
      setTerminalSideEffectConsumerAvailable: (available) =>
        this.setTerminalSideEffectConsumerAvailable(available),
      rememberDetachedPreAllocatedLeaves: () => this.rememberDetachedPreAllocatedLeaves(),
      refreshWritableFlags: () => this.refreshWritableFlags(),
      adoptPreAllocatedHandle: (leaf) => this.adoptPreAllocatedHandle(leaf),
      rejectWaitersForHandle: (handle, reason) => this.rejectWaitersForHandle(handle, reason),
      rejectAllWaiters: (reason) => this.rejectAllWaiters(reason),
      reconcilePtyIncarnationHandles: () => this.reconcilePtyIncarnationHandles(),
      clearPtyIncarnationHandles: () => this.clearPtyIncarnationHandles(),
      markSessionTabsInventoryPublished: () => this.markSessionTabsInventoryPublished(),
      attachWindow: (windowId) => this.attachWindow(windowId)
    }
    this.orchestrationGraphReloadCommands = new RuntimeOrchestrationGraphReloadCommands(
      orchestrationGraphReloadDeps
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
      ptyTitleTrackersByPtyId: this.ptyTitleTrackersByPtyId,
      ptyForegroundProcessReads: this.ptyForegroundProcessReads,
      ptyForegroundAgentRefreshes: this.ptyForegroundAgentRefreshes,
      ptyDelayedForegroundSnapshotTitleObservations:
        this.ptyDelayedForegroundSnapshotTitleObservations,
      mobileSessionTabListeners: this.mobileSessionTabListeners,
      mobileSessionTabsAgentStatusHeartbeat: this.mobileSessionTabsAgentStatusHeartbeat,
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
    const ptyTitleTrackingCommandsDeps: RuntimePtyTitleTrackingCommandsDeps = {
      ptyTitleTrackersByPtyId: this.ptyTitleTrackersByPtyId,
      ptysById: this.ptysById,
      mobileSessionTabListeners: this.mobileSessionTabListeners,
      ptyDelayedForegroundSnapshotTitleObservations:
        this.ptyDelayedForegroundSnapshotTitleObservations,
      mobileSessionTabsAgentStatusHeartbeat: this.mobileSessionTabsAgentStatusHeartbeat,
      terminalSideEffectConsumerAvailable: this.terminalSideEffectConsumerAvailable,
      terminalSideEffectLocalConsumerAvailable: this.terminalSideEffectLocalConsumerAvailable,
      onTerminalSideEffects: this.onTerminalSideEffects,
      terminalSpawnCommandsByPtyId: this.terminalSpawnCommandsByPtyId,
      oscTitleScanTailByPtyId: this.oscTitleScanTailByPtyId,
      osc7ScanTailByPtyId: this.osc7ScanTailByPtyId,
      agentStatusOscProcessorsByPtyId: this.agentStatusOscProcessorsByPtyId,
      agentPromptLifecycleByPtyId: this.agentPromptLifecycleByPtyId,
      agentPromptPermissionSequenceByPtyId: this.agentPromptPermissionSequenceByPtyId,
      terminalSideEffectTitleGateKeysByClientEventListener:
        this.terminalSideEffectTitleGateKeysByClientEventListener,
      wslDistroByPtyId: this.wslDistroByPtyId,
      terminalCwdByPtyId: this.terminalCwdByPtyId,
      terminalFileUriHostnameByPtyId: this.terminalFileUriHostnameByPtyId,
      getLeavesForPty: (ptyId) => this.getLeavesForPty(ptyId),
      recordTerminalSideEffectFact: (ptyId, fact) => this.recordTerminalSideEffectFact(ptyId, fact),
      touchMobileSessionSnapshotsForPty: (ptyId) => this.touchMobileSessionSnapshotsForPty(ptyId),
      confirmPtyAgentExit: (ptyId) => this.terminalAgentStatusBinding.confirmPtyAgentExit(ptyId),
      retirePtyAgentLaunchAuthority: (ptyId) => this.retirePtyAgentLaunchAuthority(ptyId),
      recordAgentPromptLifecycleState: (ptyId, agentStatus) =>
        this.recordAgentPromptLifecycleState(ptyId, agentStatus),
      nextTitleObservationSequence: () => this.nextTitleObservationSequence(),
      setPtyManagementTitleFromObservedTitle: (pty, normalizedTitle, observedAt) =>
        this.setPtyManagementTitleFromObservedTitle(pty, normalizedTitle, observedAt),
      shouldDelayPtyBackedMobileSnapshotForForegroundAgent: (pty, normalizedTitle) =>
        this.terminalAgentStatusBinding.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
          pty,
          normalizedTitle
        ),
      refreshPtyForegroundAgentFromController: (ptyId, opts) =>
        this.terminalAgentStatusBinding.refreshPtyForegroundAgentFromController(ptyId, opts),
      getPendingForegroundAgentRefreshForTitle: (ptyId, observedAt) =>
        this.terminalAgentStatusBinding.getPendingForegroundAgentRefreshForTitle(ptyId, observedAt),
      delayPtyBackedMobileSnapshotForForegroundAgent: (ptyId, observedAt, foregroundRefresh) =>
        this.terminalAgentStatusBinding.delayPtyBackedMobileSnapshotForForegroundAgent(
          ptyId,
          observedAt,
          foregroundRefresh
        ),
      resolvePtyTuiIdleWaiters: (pty, ptyId) => this.resolvePtyTuiIdleWaiters(pty, ptyId),
      resolveTuiIdleWaiters: (leaf) => this.resolveTuiIdleWaiters(leaf),
      deliverPendingMessagesForLeaf: (leaf) => this.deliverPendingMessagesForLeaf(leaf),
      countTerminalSideEffectConsumingClientEventListeners: () =>
        this.countTerminalSideEffectConsumingClientEventListeners(),
      clearWaitBlockedCheckState: (ptyId) => this.clearWaitBlockedCheckState(ptyId),
      primeWaitBlockedBaselineFromSeededTail: (ptyId) =>
        this.primeWaitBlockedBaselineFromSeededTail(ptyId),
      clearAgentRowSnapshotsForPty: (ptyId) => this.clearAgentRowSnapshotsForPty(ptyId)
    }
    this.ptyTitleTrackingCommands = new RuntimePtyTitleTrackingCommands(
      ptyTitleTrackingCommandsDeps
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
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, options),
      getKnownWorkspaceSessionWorktreeIds: () => this.getKnownWorkspaceSessionWorktreeIds(),
      refreshMobileSessionPtyRecords: () => this.refreshMobileSessionPtyRecords(),
      runtimeWorktreeIdsEqual,
      parsePaneKey,
      splitWorktreeId,
      getPublicSshState,
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
      getLatestAgentCandidateTitle,
      getLatestPtyTitle,
      classifyAgentTitle,
      terminalTitleBlocksExplicitAgentStatus,
      resolvePaneAgentOwner,
      normalizeCompatibleAgentTitleForOwner,
      normalizeCompatibleAgentStatusEntryForOwner,
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
      ptysById: this.ptysById,
      tabs: this.tabs,
      store: this.store,
      startedAt: this.startedAt,
      pendingMobileTerminalCreatesByKey: this.pendingMobileTerminalCreatesByKey,
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
      mobileSessionTabsByWorktree: this.mobileSessionTabsByWorktree,
      mobileSessionTabListeners: this.mobileSessionTabListeners,
      mobileSessionTabsChangeSequence,
      offscreenBrowserBackend: this.offscreenBrowserBackend,
      mergeMobileSessionSnapshotTabs: (a, b) => this.mergeMobileSessionSnapshotTabs(a, b),
      mergeMobileSessionTabGroups: (worktreeId, groups, terminalTabs, activeTab) =>
        this.mergeMobileSessionTabGroups(worktreeId, groups, terminalTabs, activeTab),
      getMobileSessionSnapshotTabIdentityKeys: (tab) =>
        this.getMobileSessionSnapshotTabIdentityKeys(tab),
      getHeadlessMobileSessionGroupId: (worktreeId) =>
        this.getHeadlessMobileSessionGroupId(worktreeId),
      getRuntimeBrowserPageForTab: (tab, _worktreeId) => {
        if (typeof tab.browserPageId === 'string') {
          return getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        }
        return undefined
      },
      sameRuntimeBrowserPlacement: (a, b) => sameRuntimeBrowserPlacement(a, b),
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
      agentBrowserBridge: this.agentBrowserBridge,
      notifyMobileSessionTabsChanged: (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      scheduleMobileSessionTabsChanged: (worktreeId) =>
        this.scheduleMobileSessionTabsChanged(worktreeId),
      getTerminalWorktreeIdForPaneKey: (paneKey) => this.getTerminalWorktreeIdForPaneKey(paneKey),
      getWorkspaceSessionForWorktree: (worktreeId) =>
        this.getWorkspaceSessionForWorktree(worktreeId),
      getWorkspaceSessionForHostId: (hostId) => this.getWorkspaceSessionForHostId(hostId),
      tryGetWorkspaceSessionHostIdForWorktree: (worktreeId) =>
        this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId),
      setWorkspaceSession: (session, hostId) => this.setWorkspaceSession(session, hostId),
      setWorkspaceSessionForWorktree: (worktreeId, session) =>
        this.setWorkspaceSessionForWorktree(worktreeId, session),
      canSetWorkspaceSession: () => this.canSetWorkspaceSession(),
      flushOrThrow: this.flushOrThrow,
      hasHostAuthoritativeTerminalMembership: (session, worktreeId) =>
        this.hasHostAuthoritativeTerminalMembership(session, worktreeId),
      terminalTopologyRevisionByRepoId: this.terminalTopologyRevisionByRepoId,
      ptysById: this.ptysById,
      parsePaneKey: (key) => parsePaneKey(key),
      buildHeadlessTerminalSplitLayout: (layout, options) =>
        this.buildHeadlessTerminalSplitLayout(layout, options),
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

    // WP11: Initialize public facades for narrowed consumer access
    this.terminalQueryFacade = {
      getTerminalById: (ptyId) => this.ptysById.get(ptyId),
      listTerminals: () => Array.from(this.ptysById.values()),
      getTerminalStatus: (ptyId) => {
        const pty = this.ptysById.get(ptyId)
        if (!pty) {
          return 'exited'
        }
        return pty.connected ? 'live' : 'disconnected'
      },
      isTerminalAlive: (ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return pty?.connected ?? false
      },
      getTerminalHandleForPtyId: (ptyId) => this.handleByPtyId.get(ptyId),
      listTerminalHandles: () => Array.from(this.handles.keys())
    }

    this.mobilePublishFacade = {
      publishMobileSessionTabs: async (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      notifyMobileSubscriber: async (worktreeId, clientNavigationId) =>
        this.getMobileSessionTabsForWorktree(worktreeId, clientNavigationId),
      publishMobileLayout: async () => {
        // Layout updates are handled through notifyMobileSessionTabsChanged
      },
      scheduleMobileSessionTabsChanged: (worktreeId) =>
        this.scheduleMobileSessionTabsChanged(worktreeId),
      cancelScheduledMobileSessionTabsChanged: (worktreeId) =>
        this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    }

    this.worktreeQueryFacade = {
      getWorktreeById: (worktreeId) => {
        // Return worktree metadata from store if available
        return this.store?.getWorktreeMeta?.(worktreeId)
      },
      listWorktrees: () => {
        const repos = this.store?.getRepos?.() ?? []
        return repos.flatMap((repo) => {
          const worktrees = this.store?.getWorktreeMeta?.(repo.id)?.worktrees ?? []
          return worktrees.map((wt) => wt.id)
        })
      },
      getWorktreeStatus: () => 'ready',
      resolveWorktreePath: (worktreeId) => {
        const worktree = this.store?.getWorktreeMeta?.(worktreeId)
        return worktree?.path
      },
      getRepositoryIdForWorktree: (worktreeId) => {
        const worktree = this.store?.getWorktreeMeta?.(worktreeId)
        return worktree?.repoId
      },
      getWorktreeBranch: (worktreeId) => {
        const worktree = this.store?.getWorktreeMeta?.(worktreeId)
        return worktree?.branch
      }
    }

    this.agentStatusFacade = {
      reportAgentStatus: async () => {
        // Agent status is reported through terminal agent status binding
      },
      publishAgentStatusUpdate: () => {
        // Published through terminalAgentStatusBinding
      },
      notifyAgentStatusChanged: () => {
        // Notifications sent through event listeners
      },
      getAgentStatus: (handle) => this.getTerminalAgentStatus(handle),
      confirmAgentExit: (ptyId) => this.confirmPtyAgentExit(ptyId)
    }
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
    if (!this.store?.getSettings) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.store.getSettings()
    return {
      worktreeVisibilityDefaults: settings.worktreeVisibilityDefaults ?? { external: 'hide' },
      defaultTuiAgent: settings.defaultTuiAgent ?? null,
      disabledTuiAgents: settings.disabledTuiAgents ?? [],
      agentCmdOverrides: settings.agentCmdOverrides ?? {},
      agentDefaultArgs: settings.agentDefaultArgs ?? {},
      agentDefaultEnv: settings.agentDefaultEnv ?? {},
      agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false,
      defaultTaskSource: settings.defaultTaskSource ?? 'github',
      defaultTaskViewPreset: settings.defaultTaskViewPreset ?? 'issues',
      visibleTaskProviders: settings.visibleTaskProviders ?? [...TASK_PROVIDERS],
      defaultRepoSelection: settings.defaultRepoSelection ?? null,
      defaultLinearTeamSelection: settings.defaultLinearTeamSelection ?? null,
      githubProjects: settings.githubProjects,
      experimentalNewWorktreeCardStyle: settings.experimentalNewWorktreeCardStyle === true,
      compactWorktreeCards: settings.compactWorktreeCards === true,
      minimaxGroupId: settings.minimaxGroupId ?? '',
      minimaxUsageModels: settings.minimaxUsageModels ?? 'general',
      prBotAuthorOverrides: settings.prBotAuthorOverrides ?? [],
      artifactSharingEnabled: isArtifactSharingEnabled(settings),
      agentSkillSharingEnabled: isAgentSkillSharingEnabled(settings)
    }
  }

  private reconcileManagedAgentHooks(): Promise<void> {
    const generation = ++this.managedHookReconciliationGeneration
    const reconciliation = this.managedHookReconciliationTail.then(async () => {
      if (generation !== this.managedHookReconciliationGeneration) {
        return
      }
      const settings = this.store?.getSettings()
      if (!settings) {
        return
      }
      await applyAgentStatusHooksEnabled(settings.agentStatusHooksEnabled !== false, settings, {
        shouldHydrateShellPath: getAppEnvironment().isPackaged(),
        onInstallError: recordManagedHookInstallFailure,
        shouldContinue: (agent) => {
          const current = this.store?.getSettings()
          return (
            current !== undefined &&
            current.agentStatusHooksEnabled !== false &&
            !current.disabledTuiAgents?.includes(agent)
          )
        }
      })
    })
    this.managedHookReconciliationTail = reconciliation.catch(() => {})
    return reconciliation
  }

  async updateClientSettings(
    updates: Pick<
      Partial<GlobalSettings>,
      | 'worktreeVisibilityDefaults'
      | 'agentStatusHooksEnabled'
      | 'defaultTuiAgent'
      | 'disabledTuiAgents'
      | 'agentDefaultArgs'
      | 'agentDefaultEnv'
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
    >
  ): Promise<
    Pick<
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
    >
  > {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const beforeSettings = this.store.getSettings()
    const before = beforeSettings.agentStatusHooksEnabled !== false
    this.store.updateSettings(updates, { notifyListeners: true })
    const settings = this.store.getSettings()
    if (updates.worktreeVisibilityDefaults !== undefined) {
      this.notifyReposChanged()
    }
    if (
      (typeof updates.agentStatusHooksEnabled === 'boolean' &&
        before !== updates.agentStatusHooksEnabled) ||
      (updates.disabledTuiAgents !== undefined &&
        !haveSameDisabledTuiAgents(beforeSettings.disabledTuiAgents, settings.disabledTuiAgents))
    ) {
      await this.reconcileManagedAgentHooks()
    }
    return this.getClientSettings()
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
    const plan = this.prepareLegacyWorkerTerminalRecovery()
    const adoptedDispatchIds: string[] = []
    const exitedDispatchIds: string[] = []
    const deferredDispatchIds = new Set(plan.ambiguousDispatchIds)
    const pendingResolutions: LegacyWorkerTerminalRecoveryResolution[] = []
    const recoveryCandidatesByProvider = new Map<
      string,
      {
        connectionId: string | null
        entries: {
          candidate: (typeof plan.candidates)[number]
          workspace: TerminalWorkspaceLaunchScope
          resolvedWorkspace: ResolvedWorktree
        }[]
      }
    >()
    for (const candidate of plan.candidates) {
      try {
        const workspace = await this.resolveTerminalWorkspaceLaunchScope(
          `id:${candidate.worktreeId}`
        )
        const sshPty = parseAppSshPtyId(candidate.ptyId)
        if (workspace.connectionId) {
          if (
            options.connectionId !== workspace.connectionId ||
            sshPty?.connectionId !== workspace.connectionId
          ) {
            deferredDispatchIds.add(candidate.dispatchId)
            continue
          }
        } else if (
          options.connectionId !== undefined ||
          sshPty !== null ||
          !this.canRecoverPersistentLocalPtysFn()
        ) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        const resolvedWorkspace = workspace.folderWorkspace
          ? this.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
          : await this.resolveWorktreeSelector(`id:${workspace.id}`)
        const connectionId = workspace.connectionId ?? null
        const providerKey = connectionId === null ? 'local' : `ssh:${connectionId}`
        const provider = recoveryCandidatesByProvider.get(providerKey) ?? {
          connectionId,
          entries: []
        }
        provider.entries.push({ candidate, workspace, resolvedWorkspace })
        recoveryCandidatesByProvider.set(providerKey, provider)
      } catch {
        deferredDispatchIds.add(candidate.dispatchId)
      }
    }
    for (const provider of recoveryCandidatesByProvider.values()) {
      const resolvedWorktrees = [
        ...new Map(
          provider.entries.map(({ resolvedWorkspace }) => [resolvedWorkspace.id, resolvedWorkspace])
        ).values()
      ]
      const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
        resolvedWorktrees,
        null,
        undefined,
        provider.connectionId
      )
      if (!inventory) {
        provider.entries.forEach(({ candidate }) => deferredDispatchIds.add(candidate.dispatchId))
        continue
      }
      for (const { candidate, workspace } of provider.entries) {
        if (!inventory.livePtyIds.has(candidate.ptyId)) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const controllerIdentity = inventory.terminalIdentityByPtyId.get(candidate.ptyId)
        if (!controllerIdentity) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          controllerIdentity.handle !== candidate.terminalHandle ||
          controllerIdentity.incarnationId !== candidate.incarnationId
        ) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const preAdoptionInventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
          resolvedWorktrees,
          null,
          undefined,
          provider.connectionId
        )
        if (!preAdoptionInventory) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (!preAdoptionInventory.livePtyIds.has(candidate.ptyId)) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const preAdoptionIdentity = preAdoptionInventory.terminalIdentityByPtyId.get(
          candidate.ptyId
        )
        if (!preAdoptionIdentity) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          preAdoptionIdentity.handle !== candidate.terminalHandle ||
          preAdoptionIdentity.incarnationId !== candidate.incarnationId
        ) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const session = this.getWorkspaceSessionForWorktree(candidate.worktreeId)
        const sessionWorktreeId = session
          ? resolveTerminalSessionWorktreeId(session, candidate.worktreeId)
          : null
        const activeTabId = sessionWorktreeId
          ? session?.activeTabIdByWorktree?.[sessionWorktreeId]
          : undefined
        const activeGroupId = sessionWorktreeId
          ? session?.activeGroupIdByWorktree?.[sessionWorktreeId]
          : undefined
        const exactSurfaceAlreadyPublished =
          this.hasExactPersistedTerminalSurfaceIdentity(candidate) &&
          this.hasExactTerminalSurfaceIdentity(candidate)
        if (!exactSurfaceAlreadyPublished) {
          try {
            await this.adoptTerminalOrphansFromInventory(
              {
                worktree: `id:${candidate.worktreeId}`,
                expectedTopologyRevision: this.getTerminalTopologyRevision(candidate.worktreeId),
                ...(activeTabId ? { activeTabId } : {}),
                ...(activeGroupId ? { activeGroupId } : {}),
                claims: [
                  {
                    terminal: candidate.terminalHandle,
                    ptyId: candidate.ptyId,
                    incarnationId: candidate.incarnationId,
                    tabId: candidate.tabId,
                    leafId: candidate.leafId
                  }
                ]
              },
              workspace,
              preAdoptionInventory
            )
          } catch (error) {
            console.warn('[orchestration] legacy worker terminal adoption deferred', {
              dispatchId: candidate.dispatchId,
              error
            })
            deferredDispatchIds.add(candidate.dispatchId)
            continue
          }
        }
        let rendererMaterialized =
          options.materializeRenderer !== true ||
          this.legacyWorkerTerminalReceiptEpochByPane.get(candidate.paneKey) ===
            this.rendererGraphEpoch
        const pty = this.ptysById.get(candidate.ptyId)
        if (
          options.materializeRenderer &&
          !rendererMaterialized &&
          pty &&
          this.notifier?.revealTerminalSession
        ) {
          for (let attempt = 0; attempt < 2 && !rendererMaterialized; attempt += 1) {
            try {
              const reveal = await this.notifier.revealTerminalSession(candidate.worktreeId, {
                ptyId: candidate.ptyId,
                title: getLatestPtyTitle(pty) ?? pty.controllerTitle,
                activate: false,
                presentation: 'background',
                tabId: candidate.tabId,
                leafId: candidate.leafId,
                focus: false,
                expectedProcessIdentity: {
                  terminalHandle: candidate.terminalHandle,
                  incarnationId: candidate.incarnationId
                }
              })
              const identity = reveal?.identity
              if (
                !identity ||
                !runtimeWorktreeIdsEqual(identity.worktreeId, candidate.worktreeId) ||
                identity.tabId !== candidate.tabId ||
                identity.leafId !== candidate.leafId ||
                identity.ptyId !== candidate.ptyId
              ) {
                throw new Error('terminal_reveal_identity_mismatch')
              }
              rendererMaterialized = true
              this.legacyWorkerTerminalReceiptEpochByPane.set(
                candidate.paneKey,
                this.rendererGraphEpoch
              )
            } catch (error) {
              if (attempt === 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, 100))
                continue
              }
              console.warn('[orchestration] adopted legacy worker was not revealed', {
                dispatchId: candidate.dispatchId,
                error
              })
            }
          }
        }
        if (!rendererMaterialized) {
          this.legacyWorkerTerminalReceiptEpochByPane.delete(candidate.paneKey)
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          options.materializeRenderer === true &&
          !this.hasExactTerminalSurfaceIdentity({
            worktreeId: candidate.worktreeId,
            tabId: candidate.tabId,
            leafId: candidate.leafId,
            ptyId: candidate.ptyId,
            terminalHandle: candidate.terminalHandle,
            incarnationId: candidate.incarnationId
          })
        ) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        const finalInventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
          resolvedWorktrees,
          null,
          undefined,
          provider.connectionId
        )
        if (!finalInventory) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (!finalInventory.livePtyIds.has(candidate.ptyId)) {
          this.legacyWorkerTerminalReceiptEpochByPane.delete(candidate.paneKey)
          this.onPtyExit(candidate.ptyId, 0, candidate.incarnationId)
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const finalIdentity = finalInventory.terminalIdentityByPtyId.get(candidate.ptyId)
        if (!finalIdentity) {
          this.legacyWorkerTerminalReceiptEpochByPane.delete(candidate.paneKey)
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          finalIdentity.handle !== candidate.terminalHandle ||
          finalIdentity.incarnationId !== candidate.incarnationId
        ) {
          this.legacyWorkerTerminalReceiptEpochByPane.delete(candidate.paneKey)
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        pendingResolutions.push({ candidate, resolution: 'adopted' })
      }
    }
    const persistedDispatchIds =
      await this.persistLegacyWorkerTerminalRecoveryBatch(pendingResolutions)
    for (const { candidate, resolution } of pendingResolutions) {
      if (!persistedDispatchIds.has(candidate.dispatchId)) {
        deferredDispatchIds.add(candidate.dispatchId)
        continue
      }
      if (resolution === 'adopted') {
        this.legacyWorkerRecoveredPtys.add(candidate.ptyId)
        this.notifier?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, 'adopted')
        adoptedDispatchIds.push(candidate.dispatchId)
        continue
      }
      this.rollbackLegacyWorkerTerminalSurface(candidate)
      if (!this.reconcileMissingLegacyWorkerTerminal(candidate)) {
        deferredDispatchIds.add(candidate.dispatchId)
        continue
      }
      this.notifier?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, 'exited')
      exitedDispatchIds.push(candidate.dispatchId)
    }
    const result = {
      blockedPaneCount: plan.blockedPanes.length,
      adoptedDispatchIds,
      exitedDispatchIds,
      deferredDispatchIds: [...deferredDispatchIds]
    }
    this.updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
    // Why: previously requested releases may only finish after the owning provider's terminals
    // are rediscovered; this pass runs per scope (local and each reconnected provider).
    void reconcileRequestedWorkerTerminalReleases(this).catch((error) => {
      console.warn('[orchestration] worker terminal release reconciliation failed', { error })
    })
    return result
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
    assertAgentSkillSharingAllowed(() => isAgentSkillSharingEnabled(this.store?.getSettings()))
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
    return this.skillArtifactCommands.publishDiscoveredSkillsFromAgent(
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
    if (!this.orchestrationEnvironmentTransport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    if (isOrchestrationMutation(method, params) && !internal?.contractVerified) {
      const statusResponse = await this.orchestrationEnvironmentTransport.call(
        selector,
        'status.get',
        undefined,
        timeoutMs
      )
      if (statusResponse.ok === false) {
        throw new OrchestrationError(
          statusResponse.error.code,
          statusResponse.error.message,
          statusResponse.error.data
        )
      }
      const status = statusResponse.result as RuntimeStatus
      if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
        throw new OrchestrationError(
          'orchestration_migration_required',
          'The connected worker server does not support the current orchestration contract. No effects were applied.',
          orchestrationMigrationData('runtime_capability_missing')
        )
      }
    }
    const response = await this.orchestrationEnvironmentTransport.call(
      selector,
      method,
      params,
      timeoutMs,
      method.startsWith('orchestration.')
        ? { ...envelope, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
        : envelope
    )
    if (response.ok === false) {
      throw new OrchestrationError(response.error.code, response.error.message, response.error.data)
    }
    return response.result
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

  private getWorkspaceSessionHydrationTargets(
    includeAllPersistedWorktrees: boolean
  ): Map<string, WorkspaceSessionState> {
    const repos = this.store?.getRepos?.() ?? []
    const repoHostIdByRepoId = new Map(
      repos.map((repo) => [repo.id, getRepoExecutionHostId(repo)] as const)
    )
    const folderHostIdByWorkspaceId = new Map(
      (this.store?.getFolderWorkspaces?.() ?? []).map((workspace) => {
        const connectionId = this.resolveFolderWorkspaceConnectionId(workspace)
        return [
          workspace.id,
          connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
        ] as const
      })
    )
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    for (const hostId of this.store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }

    const targets = new Map<string, WorkspaceSessionState>()
    for (const hostId of hostIds) {
      const session = this.store?.getWorkspaceSession?.(hostId)
      if (!session) {
        continue
      }
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        const scope = parseWorkspaceKey(worktreeId)
        const ownerHostId =
          scope?.type === 'folder'
            ? (folderHostIdByWorkspaceId.get(scope.folderWorkspaceId) ?? null)
            : (repoHostIdByRepoId.get(
                getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : worktreeId)
              ) ?? LOCAL_EXECUTION_HOST_ID)
        if (
          ownerHostId === hostId &&
          (includeAllPersistedWorktrees ||
            this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs))
        ) {
          targets.set(worktreeId, session)
        }
      }
    }
    return targets
  }

  getStatus(): RuntimeStatus {
    // Why: browser panes need a backend that can create and stream a page. A
    // desktop renderer provides one via <webview>; a headless serve provides one
    // via the offscreen backend. Either way the same browser.screencast.v1 path
    // works, so advertise it when either is present. browser.headless.v1
    // additionally tells clients this host owns browser pages with no renderer,
    // so they must not fall back to a local desktop browser tab.
    const hasRenderer = Boolean(this.getAvailableAuthoritativeWindow())
    const hasOffscreen = !hasRenderer && Boolean(this.offscreenBrowserBackend)
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
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      desktopWindowStatus: hasRenderer ? 'available' : this.getDesktopWindowStatusFn(),
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      // Why: headless orca serve cannot create/stream BrowserViews, so clients
      // must not treat browser panes as supported just because runtime RPC is up.
      capabilities,
      ...(degradations.length > 0 ? { degradations } : {}),
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_RESULT_TTL_MS },
      hostPlatform: process.platform,
      terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell ?? null,
      floatingWorkspaceEnabled: this.store?.getSettings?.().floatingTerminalEnabled !== false,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
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
    return this.clientEventPublishingCommands.applyNativeChatLaunchDraftResolutionFence(snapshot)
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
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      if (windowId !== this.pendingHeadlessPromotionWindowId) {
        throw new Error('Runtime graph publisher does not match the pending desktop promotion')
      }
      // Why: a renderer may publish after a failed promotion was restored to
      // headless authority; accepting that late healthy graph is self-healing.
      this.attachWindow(windowId)
    }
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
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
      rendererGeneration === this.rendererGeneration &&
      this.graphStatus !== 'ready'
    ) {
      throw new Error('Runtime graph publisher belongs to a superseded renderer generation')
    }
    if (windowId === HEADLESS_RUNTIME_WINDOW_ID) {
      this.headlessGraphFallbackAvailable = true
      this.rendererGeneration = null
    }

    const graphWasReady = this.graphStatus === 'ready'
    const previousTabs = this.tabs
    const previousLeaves = this.leaves
    this.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    const lifecycleLeaves = this.reconcileMobileSessionRetirementFences(graph.leaves)
    const mobileSessionResyncWorktrees = new Set<string>()
    const changedMobileWorktrees = this.syncMobileSessionTabs(
      graph.mobileSessionTabs,
      graph.unchangedMobileSessionWorktrees,
      mobileSessionResyncWorktrees
    )
    const nextLeaves = new Map<string, RuntimeLeafRecord>()
    const graphSyncedAt = this.nextTitleObservationSequence()

    // Why: renderer reloads can briefly republish the same leaf with no ptyId;
    // keep live CLI handles usable while the UI graph rebuilds.
    const preserveLivePtysDuringReload = this.graphStatus === 'reloading'
    for (const leaf of lifecycleLeaves) {
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyId =
        preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)
      const existingPty = ptyId ? this.ptysById.get(ptyId) : undefined
      const tailSource = existing?.ptyId === ptyId ? existing : existingPty

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected: ptyId !== null,
        writable: this.graphStatus === 'ready' && ptyId !== null,
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
        this.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.makeRuntimePaneKey(leaf)
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        // Why: mobile can subscribe while the pane is waiting for its first PTY.
        // Keep that handle usable after the recovery mount binds it.
        const adoptedFirstPty =
          existing.ptyId === null && this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
        if (!adoptedFirstPty) {
          this.invalidateLeafHandle(leafKey)
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
    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.leaves.get(oldLeafKey)
        const retainedIncarnation = oldLeaf?.ptyId
          ? this.handleByPtyIncarnation.get(oldLeaf.ptyId)
          : undefined
        if (
          preserveLivePtysDuringReload &&
          oldLeaf?.ptyId &&
          (this.handleByPtyId.has(oldLeaf.ptyId) ||
            (retainedIncarnation &&
              retainedIncarnation.incarnationId ===
                this.ptysById.get(oldLeaf.ptyId)?.incarnationId)) &&
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
          const oldHandle = this.handleByLeafKey.get(oldLeafKey)
          const incarnationHandle = retainedIncarnation?.handle
          if (
            oldHandle !== undefined &&
            (oldHandle === this.handleByPtyId.get(oldLeaf.ptyId) || oldHandle === incarnationHandle)
          ) {
            this.handleByLeafKey.delete(oldLeafKey)
          } else {
            this.invalidateLeafHandle(oldLeafKey)
          }
        } else {
          this.invalidateLeafHandle(oldLeafKey)
        }
      }
    }

    for (const [ptyId, leaf] of this.detachedPreAllocatedLeaves) {
      if (nextPtyIds.has(ptyId) || !this.handleByPtyId.has(ptyId)) {
        this.detachedPreAllocatedLeaves.delete(ptyId)
        continue
      }
      nextLeaves.set(this.getLeafKey(leaf.tabId, leaf.leafId), leaf)
      nextPtyIds.add(ptyId)
    }

    this.leaves = nextLeaves
    this.rebuildLeafPtyIndex()
    this.reconcilePtyIncarnationHandles()
    // Why: the emitted client payload is a function of the stored snapshot AND
    // the tab/leaf graph (handles/titles/connected resolve from leaf state), so
    // a graph-only change — e.g. a restored leaf binding its ptyId while the
    // snapshot pair is unchanged — must also fan out, or a paired client stays
    // on pending-handle forever. Schedule the union on the same 50ms trailing
    // edge as the OSC-title path; the coalescer emit reads the latest state at
    // fire time so no final version is ever lost.
    for (const worktreeId of this.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )) {
      if (changedMobileWorktrees.has(worktreeId)) {
        continue
      }
      const stored = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!stored) {
        continue
      }
      // Why: web clients drop same-epoch frames whose version isn't strictly
      // newer, so a graph-only change must mint a fresh stored version (like
      // the PTY touch path does) or the re-emitted payload — e.g. the
      // pending-handle → ready flip — is discarded and the client stays stale.
      // The accepted-renderer tracking is untouched: this is a main-local bump.
      this.mobileSessionTabsByWorktree.set(worktreeId, {
        ...stored,
        snapshotVersion: stored.snapshotVersion + 1
      })
      changedMobileWorktrees.add(worktreeId)
    }
    for (const worktreeId of changedMobileWorktrees) {
      if (this.mobileSessionTabsByWorktree.has(worktreeId)) {
        this.scheduleMobileSessionTabsChanged(worktreeId)
      }
    }
    // Why: only the authoritative window grants inventory authority; headless qualifies because it becomes authoritative before its next sync.
    const isAuthoritativeGraphPublisher = windowId === this.authoritativeWindowId
    this.markGraphReady(windowId)
    if (
      isAuthoritativeGraphPublisher &&
      (windowId === HEADLESS_RUNTIME_WINDOW_ID || graph.mobileSessionTabs !== undefined)
    ) {
      if (mobileSessionResyncWorktrees.size === 0) {
        this.markSessionTabsInventoryPublished()
      } else {
        this.sessionTabsInventoryPublicationEpoch = null
      }
    }
    if (rendererGeneration !== undefined) {
      this.rendererGeneration = rendererGeneration
    }
    for (const leaf of this.leaves.values()) {
      this.adoptPreAllocatedHandle(leaf)
      const previousLeaf = previousLeaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (
        this._orchestrationDb &&
        leaf.lastAgentStatus === 'idle' &&
        leaf.lastAgentStatusObservedLive &&
        leaf.writable &&
        (!graphWasReady ||
          previousLeaf?.ptyId !== leaf.ptyId ||
          !previousLeaf.writable ||
          previousLeaf.lastAgentStatus !== 'idle' ||
          !previousLeaf.lastAgentStatusObservedLive)
      ) {
        this.deliverPendingMessagesForLeaf(leaf)
      }
    }

    // Why: createTerminal waits for the renderer's graph sync to populate the
    // new leaf so it can return a handle. Drain callbacks after leaves update.
    for (const cb of [...this.graphSyncCallbacks]) {
      cb()
    }

    const agentOrchestrationByPaneKey = this.buildAgentOrchestrationByPaneKey()
    const nativeChatLaunchDraftResolutions =
      this.getNativeChatLaunchDraftResolutionClientEventSnapshot().map(
        ({ tabId, text, createdAt }) => ({ tabId, text, createdAt })
      )
    return {
      ...this.getStatus(),
      ...(agentOrchestrationByPaneKey ? { agentOrchestrationByPaneKey } : {}),
      ...(nativeChatLaunchDraftResolutions.length > 0 ? { nativeChatLaunchDraftResolutions } : {}),
      ...(mobileSessionResyncWorktrees.size > 0
        ? { mobileSessionResyncWorktrees: [...mobileSessionResyncWorktrees] }
        : {})
    }
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
    // Why: report which worktrees were reconciled in place so callers don't
    // reconcile them a second time (see notifyMobileSessionTabsChanged).
    const reconciledWorktreeIds = new Set<string>()
    if (this.getAvailableAuthoritativeWindow() && options.allowAttachedWindow !== true) {
      return reconciledWorktreeIds
    }
    const session =
      options.workspaceSession ??
      (worktreeId
        ? this.getWorkspaceSessionForWorktree(worktreeId)
        : this.store?.getWorkspaceSession?.())
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
      !this.offscreenBrowserBackend &&
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId ?? '').length === 0 &&
      options.runtimeOwnedTerminalCandidateKnown !== true &&
      !(worktreeId
        ? this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
            session,
            worktreeId,
            session.tabsByWorktree[worktreeId] ?? []
          )
        : this.workspaceSessionHasRuntimeOwnedPtyCandidate(session))
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
          const knownRepos = this.store?.getRepos?.()
          liveRepoIds = knownRepos ? new Set(knownRepos.map((repo) => repo.id)) : null
        }
        if (liveRepoIds && !liveRepoIds.has(ownerRepoId)) {
          continue
        }
      }
      const existing = this.mobileSessionTabsByWorktree.get(entryWorktreeId)
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
        this.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, existing)
        reconciledWorktreeIds.add(entryWorktreeId)
        continue
      }
      const terminalTabs = this.buildHeadlessMobileSessionTerminalTabs(
        entryWorktreeId,
        persistedTabs,
        session
      ).filter(
        (tab) =>
          options.onlyRuntimeOwnedTerminals !== true ||
          this.hasServeOrSshOwnedBinding(tab) ||
          this.hasRecentExpiredSshLeasePane(entryWorktreeId, tab)
      )
      // Why: offscreen browser panes are live-only (no persisted session entry),
      // so include them on every hydrate regardless of the onlyRuntimeOwnedTerminals
      // filter, which is about terminal PTY ownership and never applies to browsers.
      const browserTabs = this.buildHeadlessMobileSessionBrowserTabs(entryWorktreeId)
      const tabs: RuntimeMobileSessionSnapshotTab[] = [...terminalTabs, ...browserTabs]
      if (tabs.length === 0) {
        continue
      }
      const activeTab = this.pickHeadlessActiveTerminalTab(terminalTabs)
      const tabOrder = [
        ...this.collectHeadlessParentTabOrder(terminalTabs),
        ...browserTabs.map((tab) => tab.id)
      ]
      const groupId = this.getHeadlessMobileSessionGroupId(entryWorktreeId)
      const mergedTabs =
        options.onlyRuntimeOwnedTerminals === true && existing
          ? this.mergeMobileSessionSnapshotTabs(existing.tabs, tabs)
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
        ? this.snapshotValueComparison.appendBrowserTabOrder(
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
            this.collectBrowserGroupAssignment(persistedGroups, mergedBrowserOrder)
          )
        : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroups
          ? this.snapshotValueComparison.appendBrowserTabOrder(
              this.mergeMobileSessionTabGroups(
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
        !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
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
      if (existing && this.headlessMobileSnapshotContentUnchanged(existing, nextSnapshot)) {
        continue
      }
      this.mobileSessionTabsByWorktree.set(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
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
    return this.mobileSessionFacade.refreshMobileSessionPtyRecords(targetWorktreeId)
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

  private applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.mobileSessionFacade.applyMobileSessionTabNavigation(
      snapshot,
      activeTabId,
      navigation,
      clientNavigationId
    )
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
    const graphEpoch = options.clientNavigationId ? this.captureReadyGraphEpoch() : null
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const observedPtyIds = await this.refreshMobileSessionPtyRecords()
    if (graphEpoch !== null) {
      this.assertStableReadyGraph(graphEpoch)
    }
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (options.reason !== undefined && options.reason !== 'user' && observedPtyIds === null) {
      // Why: keep-on-unknown must also restore the mirror the caller already pruned.
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('unknown-liveness', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    if (
      options.expectedPublicationEpoch !== undefined &&
      snapshot?.publicationEpoch !== options.expectedPublicationEpoch
    ) {
      this.republishMobileSessionTabsSnapshot(worktreeId)
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
        this.republishMobileSessionTabsSnapshot(worktreeId)
        return refusedMobileSessionTabClose('stale-terminal', {
          snapshotRepublished: true
        })
      }
    }
    let closedSelectionTabIds = [tab.id]
    const finishCommittedClose = (): MobileSessionTabCloseOutcome =>
      committedMobileSessionTabClose(
        this.clientSessionTabSelections,
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
            this.republishMobileSessionTabsSnapshot(worktreeId)
          }
          // Why: both markers are skew-safe; clients must restore a mirror only
          // when the host actually republished it, not for a dead leaf.
          return refusedMobileSessionTabClose('live-host-pty', {
            snapshotRepublished: !addressedDeadLeaf
          })
        }
        if (!closingWholeParent || this.tabs.has(tab.parentTabId)) {
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
      if (closingWholeParent && !this.tabs.has(tab.parentTabId)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          killPtys: options.reason === undefined || options.reason === 'user'
        })
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        this.store?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (closingWholeParent && this.notifier?.closeTerminalTab) {
        // Why: whole-tab close is a lifecycle transaction. The renderer reply
        // arrives only after canonical retirement and a forced session flush.
        const win = this.getAvailableAuthoritativeWindow()
        if (win?.webContents.isDestroyed?.()) {
          throw new Error('runtime_unavailable')
        }
        const releasePublicationThrottle =
          options.clientNavigationId && win
            ? this.rendererPublicationThrottle.acquire(win.webContents)
            : () => {}
        try {
          await (options.localPtyTeardownOwnedExternally
            ? this.notifier.closeTerminalTab(tab.parentTabId, {
                localPtyTeardownOwnedExternally: true
              })
            : this.notifier.closeTerminalTab(tab.parentTabId))
        } finally {
          releasePublicationThrottle()
        }
        const remainingSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
        const remainingTab = remainingSnapshot?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
        )
        if (
          remainingSnapshot &&
          remainingTab &&
          this.isRuntimeOwnedHeadlessMobileTab(worktreeId, remainingTab)
        ) {
          // Why: after relay recovery the renderer can acknowledge a tab it no longer mirrors; the HUB must still retire its SSH-owned surface.
          this.closeHeadlessMobileTerminalTab(worktreeId, remainingSnapshot, remainingTab, {
            // Why: the renderer may already have durably removed the tab before acknowledging.
            allowMissingPersistedTab: true
          })
          this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
          this.store?.flushOrThrow?.()
        }
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
        return finishCommittedClose()
      }
      // Why: notifier implementations without the acknowledged relay may expose
      // only raw pane close. Runtime-owned parents still need de-persist + kill.
      if (closingWholeParent && this.isRuntimeOwnedHeadlessMobileTab(worktreeId, tab)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab)
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        this.store?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (!this.notifier?.closeTerminal) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab)
        this.store?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (tab.id === tabId) {
        const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
        if (pty) {
          if (this.ptyController?.kill(pty.ptyId) !== true) {
            throw new Error('terminal_close_failed')
          }
          return finishCommittedClose()
        }
        this.notifier.closeTerminal(tab.parentTabId)
        return delegatedMobileSessionTabClose()
      }
      // Why: paired web tab bars represent a split terminal with one local
      // parent tab id. Closing that parent should close the desktop tab, not
      // just whichever leaf happened to be first in the session snapshot.
      this.notifier.closeTerminal(tab.parentTabId)
      this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
      return delegatedMobileSessionTabClose()
    } else if (tab.type === 'browser') {
      // Why: a browser tab can be hosted by a client, by the offscreen backend,
      // or by the renderer; each surface owns a different retirement path.
      const clientPage = tab.browserPageId
        ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        : undefined
      if (clientPage) {
        await this.browserTabClose({
          worktree: `id:${worktreeId}`,
          page: clientPage.browserPageId
        })
      } else if (this.isOffscreenMobileSessionBrowserTab(snapshot, tab)) {
        await this.offscreenBrowserBackend!.closeTab(tab.browserPageId!).catch(() => {})
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, tab.browserPageId!)
      } else {
        if (!this.notifier?.closeSessionTab) {
          throw new Error('runtime_unavailable')
        }
        await this.notifier.closeSessionTab(tab.id, worktreeId)
      }
    } else if (tab.type === 'agent-session') {
      if (this.notifier?.closeSessionTab) {
        try {
          await this.notifier.closeSessionTab(
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
      this.closeStructuredAgentSessionTab(worktreeId, snapshot, tab)
    } else {
      if (!this.notifier?.closeSessionTab) {
        throw new Error('runtime_unavailable')
      }
      await this.notifier.closeSessionTab(tab.id, worktreeId)
    }
    return finishCommittedClose()
  }

  // Why: a refused echoed close means the echoing client already pruned its
  // local mirror. Bump the version and emit the unchanged snapshot so clients
  // that dedupe by snapshotVersion re-add and re-attach the still-live tab.
  private republishMobileSessionTabsSnapshot(worktreeId: string): void {
    return this.mobileSessionFacade.republishMobileSessionTabsSnapshot(worktreeId)
  }

  private getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    return this.terminalClusterFacade.getMobileSessionTerminalHandle(worktreeId, tab)
  }

  private notifyRendererOfHeadlessTerminalClose(parentTabId: string): void {
    return this.terminalClusterFacade.notifyRendererOfHeadlessTerminalClose(parentTabId)
  }

  private isOffscreenMobileSessionBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    return this.mobileSessionFacade.isOffscreenMobileSessionBrowserTab(snapshot, tab)
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
    const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== tab.id)
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => id !== tab.id),
        activeTabId: group.activeTabId === tab.id ? null : group.activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => id !== tab.id)
      })),
      tabs: nextTabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  private markHeadlessBrowserSessionTabActive(
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
      !this.offscreenBrowserBackend &&
      !getRuntimeBrowserPageRegistry(this).getPage(browserPageId)
    ) {
      return
    }
    // Hydrate first so the freshly created browser tab is present in the snapshot.
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
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
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
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

  private closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowMissingPersistedTab?: boolean; killPtys?: boolean } = {}
  ): void {
    return this.terminalClusterFacade.closeHeadlessMobileTerminalTab(
      worktreeId,
      snapshot,
      tab,
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
    return this.terminalClusterFacade.setMobileSessionTabProps(worktreeSelector, args)
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
      args
    )

  // Persist the headless tab-GROUP layout so snapshot rebuilds keep the split.
  private persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ): void {
    return this.terminalClusterFacade.persistHeadlessTabGroups(worktreeId, groups, layout)
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
    return this.mobileSessionFacade.saveMobileMarkdownTab(
      worktreeSelector,
      tabId,
      baseVersion,
      content
    )
  }

  private readonly fileCommands = new RuntimeFileCommands({
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
    resolveKnownWorkspaceFileTarget: (absolutePath, connectionId) =>
      this.resolveKnownWorkspaceFileTarget(absolutePath, connectionId),
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

  listMobileFiles: RuntimeFileCommands['listMobileFiles'] = this.fileCommands.listMobileFiles.bind(
    this.fileCommands
  )
  searchMobileFilePaths: RuntimeFileCommands['searchMobileFilePaths'] =
    this.fileCommands.searchMobileFilePaths.bind(this.fileCommands)
  searchQuickOpenFilePaths: RuntimeFileCommands['searchQuickOpenFilePaths'] =
    this.fileCommands.searchQuickOpenFilePaths.bind(this.fileCommands)
  openMobileFile: RuntimeFileCommands['openMobileFile'] = this.fileCommands.openMobileFile.bind(
    this.fileCommands
  )
  openMobileDiff: RuntimeFileCommands['openMobileDiff'] = this.fileCommands.openMobileDiff.bind(
    this.fileCommands
  )
  readMobileFile: RuntimeFileCommands['readMobileFile'] = this.fileCommands.readMobileFile.bind(
    this.fileCommands
  )
  resolveTerminalPath: RuntimeFileCommands['resolveTerminalPath'] =
    this.fileCommands.resolveTerminalPath.bind(this.fileCommands)
  readTerminalArtifactFile: RuntimeFileCommands['readTerminalArtifactFile'] =
    this.fileCommands.readTerminalArtifactFile.bind(this.fileCommands)
  readTerminalArtifactPreview: RuntimeFileCommands['readTerminalArtifactPreview'] =
    this.fileCommands.readTerminalArtifactPreview.bind(this.fileCommands)
  writeTerminalArtifactFile: RuntimeFileCommands['writeTerminalArtifactFile'] =
    this.fileCommands.writeTerminalArtifactFile.bind(this.fileCommands)
  revokeTerminalFileGrantsForClient: RuntimeFileCommands['revokeTerminalFileGrantsForClient'] =
    this.fileCommands.revokeTerminalFileGrantsForClient.bind(this.fileCommands)
  readFileExplorerDir: RuntimeFileCommands['readFileExplorerDir'] =
    this.fileCommands.readFileExplorerDir.bind(this.fileCommands)
  watchFileExplorer: RuntimeFileCommands['watchFileExplorer'] =
    this.fileCommands.watchFileExplorer.bind(this.fileCommands)
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
  readFileExplorerPreview: RuntimeFileCommands['readFileExplorerPreview'] =
    this.fileCommands.readFileExplorerPreview.bind(this.fileCommands)
  readDocPreviewFile: RuntimeFileCommands['readDocPreviewFile'] =
    this.fileCommands.readDocPreviewFile.bind(this.fileCommands)
  readFileExplorerChunk: RuntimeFileCommands['readFileExplorerChunk'] =
    this.fileCommands.readFileExplorerChunk.bind(this.fileCommands)
  writeFileExplorerFile: RuntimeFileCommands['writeFileExplorerFile'] =
    this.fileCommands.writeFileExplorerFile.bind(this.fileCommands)
  writeFileExplorerFileBase64: RuntimeFileCommands['writeFileExplorerFileBase64'] =
    this.fileCommands.writeFileExplorerFileBase64.bind(this.fileCommands)
  writeFileExplorerFileBase64Chunk: RuntimeFileCommands['writeFileExplorerFileBase64Chunk'] =
    this.fileCommands.writeFileExplorerFileBase64Chunk.bind(this.fileCommands)
  createFileExplorerFile: RuntimeFileCommands['createFileExplorerFile'] =
    this.fileCommands.createFileExplorerFile.bind(this.fileCommands)
  createFileExplorerDir: RuntimeFileCommands['createFileExplorerDir'] =
    this.fileCommands.createFileExplorerDir.bind(this.fileCommands)
  createFileExplorerDirNoClobber: RuntimeFileCommands['createFileExplorerDirNoClobber'] =
    this.fileCommands.createFileExplorerDirNoClobber.bind(this.fileCommands)
  commitFileExplorerUpload: RuntimeFileCommands['commitFileExplorerUpload'] =
    this.fileCommands.commitFileExplorerUpload.bind(this.fileCommands)
  renameFileExplorerPath: RuntimeFileCommands['renameFileExplorerPath'] =
    this.fileCommands.renameFileExplorerPath.bind(this.fileCommands)
  copyFileExplorerPath: RuntimeFileCommands['copyFileExplorerPath'] =
    this.fileCommands.copyFileExplorerPath.bind(this.fileCommands)
  deleteFileExplorerPath: RuntimeFileCommands['deleteFileExplorerPath'] =
    this.fileCommands.deleteFileExplorerPath.bind(this.fileCommands)
  searchRuntimeFiles: RuntimeFileCommands['searchRuntimeFiles'] =
    this.fileCommands.searchRuntimeFiles.bind(this.fileCommands)
  listRuntimeFiles: RuntimeFileCommands['listRuntimeFiles'] =
    this.fileCommands.listRuntimeFiles.bind(this.fileCommands)
  listRuntimeMarkdownDocuments: RuntimeFileCommands['listRuntimeMarkdownDocuments'] =
    this.fileCommands.listRuntimeMarkdownDocuments.bind(this.fileCommands)
  statRuntimeFile: RuntimeFileCommands['statRuntimeFile'] = this.fileCommands.statRuntimeFile.bind(
    this.fileCommands
  )

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

  getRuntimeGitStatus: RuntimeGitCommands['getRuntimeGitStatus'] =
    this.gitCommands.getRuntimeGitStatus.bind(this.gitCommands)
  getRuntimeGitSubmoduleStatus: RuntimeGitCommands['getRuntimeGitSubmoduleStatus'] =
    this.gitCommands.getRuntimeGitSubmoduleStatus.bind(this.gitCommands)
  checkRuntimeGitIgnoredPaths: RuntimeGitCommands['checkRuntimeGitIgnoredPaths'] =
    this.gitCommands.checkRuntimeGitIgnoredPaths.bind(this.gitCommands)
  getRuntimeGitHistory: RuntimeGitCommands['getRuntimeGitHistory'] =
    this.gitCommands.getRuntimeGitHistory.bind(this.gitCommands)
  getRuntimeGitConflictOperation: RuntimeGitCommands['getRuntimeGitConflictOperation'] =
    this.gitCommands.getRuntimeGitConflictOperation.bind(this.gitCommands)
  abortRuntimeGitMerge: RuntimeGitCommands['abortRuntimeGitMerge'] =
    this.gitCommands.abortRuntimeGitMerge.bind(this.gitCommands)
  abortRuntimeGitRebase: RuntimeGitCommands['abortRuntimeGitRebase'] =
    this.gitCommands.abortRuntimeGitRebase.bind(this.gitCommands)
  checkoutRuntimeGitBranch: RuntimeGitCommands['checkoutRuntimeGitBranch'] =
    this.gitCommands.checkoutRuntimeGitBranch.bind(this.gitCommands)
  listRuntimeGitLocalBranches: RuntimeGitCommands['listRuntimeGitLocalBranches'] =
    this.gitCommands.listRuntimeGitLocalBranches.bind(this.gitCommands)
  getRuntimeGitDiff: RuntimeGitCommands['getRuntimeGitDiff'] =
    this.gitCommands.getRuntimeGitDiff.bind(this.gitCommands)
  getRuntimeGitBranchCompare: RuntimeGitCommands['getRuntimeGitBranchCompare'] =
    this.gitCommands.getRuntimeGitBranchCompare.bind(this.gitCommands)
  getRuntimeGitCommitCompare: RuntimeGitCommands['getRuntimeGitCommitCompare'] =
    this.gitCommands.getRuntimeGitCommitCompare.bind(this.gitCommands)
  getRuntimeGitUpstreamStatus: RuntimeGitCommands['getRuntimeGitUpstreamStatus'] =
    this.gitCommands.getRuntimeGitUpstreamStatus.bind(this.gitCommands)
  fetchRuntimeGit: RuntimeGitCommands['fetchRuntimeGit'] = this.gitCommands.fetchRuntimeGit.bind(
    this.gitCommands
  )
  syncRuntimeGitForkDefaultBranch: RuntimeGitCommands['syncRuntimeGitForkDefaultBranch'] =
    this.gitCommands.syncRuntimeGitForkDefaultBranch.bind(this.gitCommands)
  pullRuntimeGit: RuntimeGitCommands['pullRuntimeGit'] = this.gitCommands.pullRuntimeGit.bind(
    this.gitCommands
  )
  fastForwardRuntimeGit: RuntimeGitCommands['fastForwardRuntimeGit'] =
    this.gitCommands.fastForwardRuntimeGit.bind(this.gitCommands)
  rebaseRuntimeGitFromBase: RuntimeGitCommands['rebaseRuntimeGitFromBase'] =
    this.gitCommands.rebaseRuntimeGitFromBase.bind(this.gitCommands)
  pushRuntimeGit: RuntimeGitCommands['pushRuntimeGit'] = this.gitCommands.pushRuntimeGit.bind(
    this.gitCommands
  )
  getRuntimeGitBranchDiff: RuntimeGitCommands['getRuntimeGitBranchDiff'] =
    this.gitCommands.getRuntimeGitBranchDiff.bind(this.gitCommands)
  getRuntimeGitCommitDiff: RuntimeGitCommands['getRuntimeGitCommitDiff'] =
    this.gitCommands.getRuntimeGitCommitDiff.bind(this.gitCommands)
  commitRuntimeGit: RuntimeGitCommands['commitRuntimeGit'] = this.gitCommands.commitRuntimeGit.bind(
    this.gitCommands
  )
  generateRuntimeCommitMessage: RuntimeGitCommands['generateRuntimeCommitMessage'] =
    this.gitCommands.generateRuntimeCommitMessage.bind(this.gitCommands)
  discoverRuntimeCommitMessageModels: RuntimeGitCommands['discoverRuntimeCommitMessageModels'] =
    this.gitCommands.discoverRuntimeCommitMessageModels.bind(this.gitCommands)
  cancelRuntimeGenerateCommitMessage: RuntimeGitCommands['cancelRuntimeGenerateCommitMessage'] =
    this.gitCommands.cancelRuntimeGenerateCommitMessage.bind(this.gitCommands)
  generateRuntimePullRequestFields: RuntimeGitCommands['generateRuntimePullRequestFields'] =
    this.gitCommands.generateRuntimePullRequestFields.bind(this.gitCommands)
  cancelRuntimeGeneratePullRequestFields: RuntimeGitCommands['cancelRuntimeGeneratePullRequestFields'] =
    this.gitCommands.cancelRuntimeGeneratePullRequestFields.bind(this.gitCommands)
  stageRuntimeGitPath: RuntimeGitCommands['stageRuntimeGitPath'] =
    this.gitCommands.stageRuntimeGitPath.bind(this.gitCommands)
  unstageRuntimeGitPath: RuntimeGitCommands['unstageRuntimeGitPath'] =
    this.gitCommands.unstageRuntimeGitPath.bind(this.gitCommands)
  bulkStageRuntimeGitPaths: RuntimeGitCommands['bulkStageRuntimeGitPaths'] =
    this.gitCommands.bulkStageRuntimeGitPaths.bind(this.gitCommands)
  bulkUnstageRuntimeGitPaths: RuntimeGitCommands['bulkUnstageRuntimeGitPaths'] =
    this.gitCommands.bulkUnstageRuntimeGitPaths.bind(this.gitCommands)
  bulkDiscardRuntimeGitPaths: RuntimeGitCommands['bulkDiscardRuntimeGitPaths'] =
    this.gitCommands.bulkDiscardRuntimeGitPaths.bind(this.gitCommands)
  discardRuntimeGitPath: RuntimeGitCommands['discardRuntimeGitPath'] =
    this.gitCommands.discardRuntimeGitPath.bind(this.gitCommands)
  getRuntimeGitRemoteFileUrl: RuntimeGitCommands['getRuntimeGitRemoteFileUrl'] =
    this.gitCommands.getRuntimeGitRemoteFileUrl.bind(this.gitCommands)
  getRuntimeGitRemoteCommitUrl: RuntimeGitCommands['getRuntimeGitRemoteCommitUrl'] =
    this.gitCommands.getRuntimeGitRemoteCommitUrl.bind(this.gitCommands)

  /**
   * Installs the structured agent-session host on first use. Lazy for the same
   * reason the orchestration DB is: the profile's user-data path is not final
   * until the app is ready, and a runtime nobody drives a chat session on
   * should never open the record store.
   */
  async ensureStructuredAgentSessionHost(): Promise<void> {
    await installStructuredAgentSessionHost({
      stateDirectory: getProfileUserDataPath(),
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: this.agentSessionClaimSigner.keyId,
      // Resolves folder workspaces as well as git worktrees, so a chat session
      // in a plain folder lands in the folder rather than failing to resolve.
      resolveWorkspacePath: async (workspaceId) =>
        (await this.resolveRuntimeFileTarget(`id:${workspaceId}`)).worktree.path,
      resolveLaunchArgs: () => this.resolveConfiguredCodexStructuredArgs(),
      resolveLaunchEnvOverlay: () =>
        resolveTuiAgentLaunchEnv('codex', this.requireStore().getSettings().agentDefaultEnv),
      handoffTransport: this.createStructuredAgentSessionHandoffTransport()
    })
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

  private createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport {
    return {
      hostLabel: hostname(),
      launchTui: async ({ record, fence, spawnToken, onSpawned }) => {
        const head = record.providerHandleChain.at(-1)
        if (!head || (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')) {
          throw new Error('agent_session_identity_required')
        }
        const provider = head.handle.provider
        const providerSessionId =
          provider === 'claude' ? head.handle.sessionId : head.handle.threadId
        const launchStartedAt = Date.now()
        const launched = await this.ensureAgentSession(
          {
            kind: 'explicit',
            worktree: `id:${record.location.workspaceId}`,
            agent: provider,
            providerSession: { key: 'session_id', id: providerSessionId },
            ...(record.options ? { launchPreferences: record.options } : {}),
            presentation: 'background'
          },
          {},
          { spawnToken, providerRoot: record.accountHome.path, sessionId: record.sessionId }
        )
        const terminal = launched.terminal
        let spawnedOwner: StructuredTuiOwner | null = null
        let ptyId: string | undefined
        try {
          if (!terminal.processId || !terminal.paneKey || !terminal.tabId || !terminal.ptyId) {
            throw new Error('The resumed terminal did not publish a process identity.')
          }
          ptyId = terminal.ptyId
          spawnedOwner = this.refreshStructuredTuiOwnerBinding({
            terminal: {
              handle: terminal.handle,
              tabId: terminal.tabId,
              paneKey: terminal.paneKey,
              ptyId: terminal.ptyId
            },
            process:
              provider === 'codex'
                ? await readCodexResumeProcessIdentity({
                    hostId: record.location.executionHostId,
                    rootPid: terminal.processId,
                    spawnToken,
                    threadId: head.handle.threadId
                  })
                : await readStructuredTuiProcessIdentity({
                    hostId: record.location.executionHostId,
                    rootPid: terminal.processId,
                    spawnToken,
                    agent: provider
                  }),
            link:
              provider === 'codex'
                ? codexProviderHandleLink({
                    threadId: head.handle.threadId,
                    resumed: true,
                    fence,
                    observedAt: Date.now()
                  })
                : claudeProviderHandleLink({
                    sessionId: head.handle.sessionId,
                    leafUuid: head.handle.leafUuid,
                    resumed: true,
                    fence,
                    observedAt: Date.now()
                  })
          })
          await onSpawned?.(spawnedOwner)
          await this.waitForTerminal(terminal.handle, {
            condition: 'tui-idle',
            timeoutMs: 30_000
          })
          const proof =
            provider === 'codex'
              ? await this.waitForAdoptedStructuredTuiProof({
                  owner: spawnedOwner,
                  threadId: head.handle.threadId,
                  codexHome: record.accountHome.path
                })
              : await this.waitForStructuredClaudeTuiProof({
                  handle: terminal.handle,
                  paneKey: terminal.paneKey,
                  sessionId: head.handle.sessionId,
                  previousLeafUuid: head.handle.leafUuid,
                  projectsDir: join(record.accountHome.path, 'projects'),
                  spawnToken,
                  minimumProviderSessionReceivedAt: launchStartedAt
                })
          const revealed = await this.focusTerminal(terminal.handle)
          return this.refreshStructuredTuiOwnerBinding({
            ...spawnedOwner,
            link:
              provider === 'claude'
                ? claudeProviderHandleLink({
                    sessionId: head.handle.sessionId,
                    leafUuid: proof.leafUuid ?? head.handle.leafUuid,
                    resumed: true,
                    fence,
                    observedAt: Date.now()
                  })
                : spawnedOwner.link,
            terminal: {
              handle: terminal.handle,
              tabId: revealed.tabId,
              paneKey: terminal.paneKey,
              ptyId: terminal.ptyId
            },
            process: spawnedOwner.process,
            ...(proof.transcriptPath ? { transcriptPath: proof.transcriptPath } : {}),
            historySource: 'provider-resume'
          })
        } catch (error) {
          let closeError: unknown = null
          try {
            await this.closeTerminal(terminal.handle)
          } catch (cleanupFailure) {
            closeError = cleanupFailure
          }
          try {
            // closeTerminal may retire the renderer handle before the PTY exit is
            // observed. Prove the provider child (or, before identity publication,
            // the PTY) through the same exit path used by handoff recovery.
            if (spawnedOwner) {
              await this.waitForStructuredTuiOwnerExit(spawnedOwner)
            } else if (ptyId) {
              await this.waitForStructuredTuiPtyExit(ptyId)
            } else {
              throw new Error('The failed terminal did not publish a PTY identity.')
            }
          } catch (exitFailure) {
            throw new StructuredTuiLaunchCleanupError(
              error,
              closeError === null
                ? exitFailure
                : new AggregateError(
                    [closeError, exitFailure],
                    'Structured TUI cleanup could not prove process exit.'
                  )
            )
          }
          throw error
        }
      },
      waitForTuiExit: async (owner) => {
        await this.waitForStructuredTuiOwnerExit(owner)
        return owner.transcriptPath ? { transcriptPath: owner.transcriptPath } : {}
      },
      waitForTuiIdleOrExit: async (owner, signal) => {
        return this.waitForStructuredTuiIdleOrExit(owner, signal)
      },
      reproveTuiOwner: async ({ record, owner }) => {
        const current = this.refreshStructuredTuiOwnerBinding(owner)
        const persisted = record.lease.ownerProcess
        if (
          !persisted ||
          persisted.hostId !== current.process.hostId ||
          persisted.pid !== current.process.pid ||
          persisted.processStartTimeMs !== current.process.processStartTimeMs ||
          persisted.spawnToken !== current.process.spawnToken
        ) {
          throw new Error('The owning terminal does not match the persisted launch identity.')
        }
        const proof = await probeAgentSessionProcessIdentity({ identity: current.process })
        if (proof.outcome !== 'identity-matched' || proof.matchedOn.length === 0) {
          throw new Error(
            `The owning ${current.link.handle.provider} child process could not be re-proved.`
          )
        }
        const head = record.providerHandleChain.at(-1)
        const sameProviderIdentity =
          head &&
          (current.link.handle.provider === 'claude'
            ? agentSessionProviderHandleRoot(current.link.handle) ===
              agentSessionProviderHandleRoot(head.handle)
            : (record.lease.provenHandleLinkId === null ||
                current.link.linkId === record.lease.provenHandleLinkId) &&
              agentSessionProviderHandlesEqual(current.link.handle, head.handle))
        if (!sameProviderIdentity) {
          throw new Error('agent_session_identity_required')
        }
        if (current.link.handle.provider === 'claude' && head.handle.provider === 'claude') {
          const proof = await this.waitForStructuredClaudeTuiProof({
            handle: current.terminal.handle,
            paneKey: current.terminal.paneKey,
            sessionId: head.handle.sessionId,
            previousLeafUuid: head.handle.leafUuid,
            projectsDir: join(record.accountHome.path, 'projects')
          })
          return {
            ...current,
            link: claudeProviderHandleLink({
              sessionId: head.handle.sessionId,
              leafUuid: proof.leafUuid,
              resumed: true,
              fence: record.lease.runtimeFence,
              observedAt: Date.now()
            }),
            transcriptPath: proof.transcriptPath
          }
        }
        if (current.transcriptPath || current.link.handle.provider !== 'codex') {
          return current
        }
        if (head.handle.provider !== 'codex') {
          return current
        }
        const threadId = head.handle.threadId
        const transcriptPath = await resolvePinnedCodexRolloutProof(
          record.accountHome.path,
          threadId
        )
        return transcriptPath ? { ...current, transcriptPath } : current
      },
      recoverTuiOwner: async (record) => {
        const identity = record.lease.ownerProcess
        const head = record.providerHandleChain.at(-1)
        if (
          !identity ||
          !head ||
          (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')
        ) {
          throw new Error('agent_session_identity_required')
        }
        const provider = head.handle.provider
        const providerSessionId =
          provider === 'claude' ? head.handle.sessionId : head.handle.threadId
        let candidate = [...this.ptysById.values()].find(
          (pty) =>
            pty.connected &&
            pty.launchToken === identity.spawnToken &&
            pty.launchAgent === provider &&
            pty.tabId &&
            pty.paneKey
        )
        let handle = candidate ? this.issueStructuredTuiPtyHandle(candidate) : null
        let durableOwner: { binding: AgentSessionOwnerBinding; incarnationId: string } | undefined
        if (!candidate) {
          const workspace = await this.resolveTerminalWorkspaceLaunchScope(
            `id:${record.location.workspaceId}`
          )
          const baseNamespace = this.getAgentSessionExecutionNamespace(workspace, provider)
          if (
            !baseNamespace ||
            !runtimeWorktreeIdsEqual(workspace.id, record.location.workspaceId)
          ) {
            throw new Error('agent_session_identity_required')
          }
          const claim = this.agentSessionClaimSigner.createClaim({
            namespace: { ...baseNamespace, providerRoot: record.accountHome.path },
            identity: canonicalizeAgentSessionIdentity(provider, {
              key: 'session_id',
              id: providerSessionId
            }),
            canonicalWorktreeId: workspace.id
          })
          const candidateEvaluations = [...this.ptysById.values()].flatMap((pty) =>
            pty.agentSessionOwners.map((owner) => {
              const session = this.getWorkspaceSessionForWorktree(owner.surface.worktreeId)
              const sessionWorktreeId = session
                ? resolveTerminalSessionWorktreeId(session, owner.surface.worktreeId)
                : null
              const persistedTab = sessionWorktreeId
                ? session?.tabsByWorktree[sessionWorktreeId]?.find(
                    (candidate) => candidate.id === owner.surface.tabId
                  )
                : null
              const paneKey = makePaneKey(owner.surface.tabId, owner.surface.leafId)
              const persisted = {
                sessionResolved: Boolean(session && sessionWorktreeId),
                tabPresent: Boolean(persistedTab),
                ptyId:
                  session?.terminalLayoutsByTabId[owner.surface.tabId]?.ptyIdsByLeafId?.[
                    owner.surface.leafId
                  ] ?? null,
                incarnationId: session?.terminalPtyIncarnationsByPaneKey?.[paneKey] ?? null
              }
              const evaluation = evaluateStructuredTuiRecoveryClaim(
                {
                  expectedWorkspaceId: workspace.id,
                  claimMatches: scopedAgentSessionClaimsEqual(owner.claim, claim),
                  pty: {
                    connected: pty.connected,
                    ptyId: pty.ptyId,
                    incarnationId: pty.incarnationId,
                    worktreeId: pty.worktreeId
                  },
                  owner: {
                    phase: owner.phase,
                    ptyId: owner.ptyId,
                    surface: owner.surface
                  },
                  persisted
                },
                runtimeWorktreeIdsEqual
              )
              return { pty, owner, persisted, evaluation }
            })
          )
          const recoveredCandidates = candidateEvaluations
            .filter(({ evaluation }) => evaluation.matches)
            .map(({ pty, owner }) => ({ pty, owner }))
          const recovered = recoveredCandidates.length === 1 ? recoveredCandidates[0] : null
          if (!recovered) {
            console.warn('[structured-tui-recovery] claim mismatch', {
              sessionId: record.sessionId,
              expectedWorkspaceId: workspace.id,
              persistedOwnerProcess: {
                hostId: identity.hostId,
                pid: identity.pid,
                processStartTimeMs: identity.processStartTimeMs,
                spawnTokenPresent: identity.spawnToken.length > 0
              },
              candidates: candidateEvaluations.map(({ pty, owner, persisted, evaluation }) => ({
                ptyId: pty.ptyId,
                incarnationId: pty.incarnationId,
                worktreeId: pty.worktreeId,
                ownerSurface: owner.surface,
                persisted,
                mismatchedFields: evaluation.mismatchedFields
              }))
            })
          }
          if (
            !recovered ||
            !(await this.proveRecoveredStructuredTuiPtyProcess(recovered.pty, identity, provider))
          ) {
            throw new Error('The owning agent terminal could not be recovered.')
          }
          candidate = recovered.pty
          candidate.tabId = recovered.owner.surface.tabId
          candidate.paneKey = makePaneKey(
            recovered.owner.surface.tabId,
            recovered.owner.surface.leafId
          )
          // Runtime handles rotate on packaged relaunch; claim, incarnation, and process proof are durable.
          handle = this.issuePtyHandle(candidate)
          const recoveredIncarnationId = candidate.incarnationId
          if (handle && recoveredIncarnationId) {
            durableOwner = {
              binding: cloneAgentSessionOwnerBinding(recovered.owner),
              incarnationId: recoveredIncarnationId
            }
          }
        }
        if (!candidate?.tabId || !candidate.paneKey || !handle) {
          throw new Error('The owning agent terminal could not be recovered.')
        }
        agentSessionPtyWriteGate.bindPty(candidate.ptyId, record.sessionId)
        const proof =
          provider === 'codex'
            ? durableOwner
              ? await this.resolveRecoveredStructuredTuiTranscript({
                  handle,
                  paneKey: candidate.paneKey,
                  threadId: head.handle.threadId,
                  codexHome: record.accountHome.path,
                  durableOwner
                })
              : await this.waitForStructuredTuiProof({
                  handle,
                  paneKey: candidate.paneKey,
                  threadId: head.handle.threadId,
                  spawnToken: identity.spawnToken,
                  codexHome: record.accountHome.path,
                  sessionId: record.sessionId
                })
            : await this.waitForStructuredClaudeTuiProof({
                handle,
                paneKey: candidate.paneKey,
                sessionId: head.handle.sessionId,
                previousLeafUuid: head.handle.leafUuid,
                projectsDir: join(record.accountHome.path, 'projects')
              })
        return {
          terminal: {
            handle,
            tabId: candidate.tabId,
            paneKey: candidate.paneKey,
            ptyId: candidate.ptyId
          },
          process: identity,
          link:
            provider === 'codex'
              ? codexProviderHandleLink({
                  threadId: head.handle.threadId,
                  resumed: true,
                  fence: record.lease.runtimeFence,
                  observedAt: Date.now()
                })
              : claudeProviderHandleLink({
                  sessionId: head.handle.sessionId,
                  leafUuid: proof.leafUuid ?? head.handle.leafUuid,
                  resumed: true,
                  fence: record.lease.runtimeFence,
                  observedAt: Date.now()
                }),
          transcriptPath: proof.transcriptPath
        }
      },
      probeRecoveredOwner: async (record) => {
        const identity = record.lease.ownerProcess
        if (!identity) {
          return 'dead'
        }
        const proof = await probeAgentSessionProcessIdentity({ identity })
        if (proof.outcome === 'identity-matched' && proof.matchedOn.length > 0) {
          return 'live'
        }
        if (proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch') {
          return 'dead'
        }
        return 'unknown'
      },
      stopRecoveredOwner: (record) => this.stopStructuredSessionProcess(record),
      tuiStatus: (owner) => this.structuredTuiStatus(owner),
      closeTuiOwner: (owner) => this.closeStructuredTuiOwner(owner),
      revealNativeSession: ({ workspaceId, sessionId, agent = 'codex', adoptedTerminal }) => {
        if (adoptedTerminal || agent !== 'codex') {
          return
        }
        this.publishStructuredAgentSessionTab({
          workspaceId,
          sessionId,
          agent,
          activate: false
        })
        this.notifier?.focusEditorTab?.(structuredAgentSessionTabId(sessionId), workspaceId)
      },
      stopFailedTuiLaunch: async (owner) => void (await this.closeStructuredTuiOwner(owner))
    }
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
  private async waitForAdoptedStructuredTuiProof(input: {
    owner: StructuredTuiOwner
    threadId: string
    codexHome: string
  }): Promise<{ transcriptPath: string; leafUuid?: never }> {
    return this.ptyWorktrees.waitForAdoptedStructuredTuiProof(input)
  }

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

  private async stopStructuredSessionProcess(record: AgentSessionRecord): Promise<void> {
    const identity = record.lease.ownerProcess
    if (!identity) {
      return
    }
    const proof = await probeAgentSessionProcessIdentity({ identity })
    if (proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch') {
      return
    }
    if (proof.outcome !== 'identity-matched' || proof.matchedOn.length === 0) {
      throw new Error('The recovered owner process could not be stopped safely.')
    }
    try {
      process.kill(identity.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
      return
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const current = await probeAgentSessionProcessIdentity({ identity })
      if (current.outcome === 'pid-absent' || current.outcome === 'identity-mismatch') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // SIGTERM is only a request. Escalate once, then require an independent
    // absence probe before allowing the lease transition to proceed.
    try {
      process.kill(identity.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
      return
    }
    const forcedDeadline = Date.now() + 5_000
    while (Date.now() < forcedDeadline) {
      const current = await probeAgentSessionProcessIdentity({ identity })
      if (current.outcome === 'pid-absent' || current.outcome === 'identity-mismatch') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('The recovered owner process did not exit after forced termination.')
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

  private async waitForStructuredTuiProof(input: {
    handle: string
    paneKey: string
    threadId: string
    spawnToken: string
    codexHome: string
    sessionId: string
  }): Promise<{ transcriptPath?: string; leafUuid?: never }> {
    const readBoundPty = (): RuntimePtyWorktreeRecord => {
      const pty = this.getLivePtyForHandle(input.handle)?.pty
      if (
        !pty?.connected ||
        pty.paneKey !== input.paneKey ||
        pty.launchAgent !== 'codex' ||
        pty.launchToken !== input.spawnToken
      ) {
        throw new Error('The resumed terminal lost its launch identity.')
      }
      return pty
    }
    const initialPty = readBoundPty()
    const kittyKeyboardFlags = this.providerModeTrackersByPtyId.get(initialPty.ptyId)?.flags ?? 0
    return proveCodexTuiRollout({
      codexHome: input.codexHome,
      threadId: input.threadId,
      kittyKeyboardFlags,
      readOutput: () => {
        const pty = readBoundPty()
        return {
          text: buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview),
          lastOutputAt: pty.lastOutputAt
        }
      },
      write: (data) => {
        const pty = readBoundPty()
        return (
          this.ptyController?.writeAgentSessionProof?.(pty.ptyId, data, {
            sessionId: input.sessionId,
            spawnToken: input.spawnToken
          }) ?? false
        )
      }
    })
  }

  private async waitForStructuredClaudeTuiProof(input: {
    handle: string
    paneKey: string
    sessionId: string
    previousLeafUuid: string | null
    projectsDir: string
    /** Set when this call launched a new Claude process; a cached transcript marker is not enough. */
    spawnToken?: string
    minimumProviderSessionReceivedAt?: number
  }): Promise<{ transcriptPath: string; leafUuid: string }> {
    const deadline = Date.now() + 15_000
    let incompleteTail: ClaudeTranscriptTailIncompleteError | null = null
    while (Date.now() < deadline) {
      const pty = this.getLivePtyForHandle(input.handle)?.pty
      if (!pty?.connected || pty.paneKey !== input.paneKey || pty.launchAgent !== 'claude') {
        throw new Error('The resumed Claude terminal lost its launch identity.')
      }
      if (input.spawnToken) {
        if (!this.hasProviderSessionObservationSource()) {
          throw new Error('The Claude terminal could not prove its fresh provider session.')
        }
        const observedProviderRow = this.findAdoptedProviderSession(
          input.paneKey,
          'claude',
          input.sessionId
        )
        if (
          !observedProviderRow ||
          observedProviderRow.launchToken !== input.spawnToken ||
          (input.minimumProviderSessionReceivedAt !== undefined &&
            observedProviderRow.receivedAt < input.minimumProviderSessionReceivedAt)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
      }
      const transcriptPath = await resolveSessionFilePath('claude', input.sessionId, {
        claudeProjectsDir: input.projectsDir
      })
      if (transcriptPath) {
        if (!isPathWithinDirectory(input.projectsDir, transcriptPath)) {
          throw new Error('The Claude terminal reported a transcript outside its account root.')
        }
        try {
          const leafUuid = await readClaudeTranscriptLeafUuid(
            transcriptPath,
            input.sessionId,
            input.previousLeafUuid
          )
          return { transcriptPath, leafUuid }
        } catch (error) {
          if (!(error instanceof ClaudeTranscriptTailIncompleteError)) {
            throw error
          }
          incompleteTail = error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (incompleteTail) {
      throw incompleteTail
    }
    throw new Error('The agent terminal did not prove the expected Claude session.')
  }

  private async resolveRecoveredStructuredTuiTranscript(input: {
    handle: string
    paneKey: string
    threadId: string
    codexHome: string
    durableOwner: { binding: AgentSessionOwnerBinding; incarnationId: string }
  }): Promise<{ transcriptPath: string; leafUuid?: never }> {
    const assertDurableOwner = (): void => {
      const pty = this.getLivePtyForHandle(input.handle)?.pty
      if (
        !pty?.connected ||
        pty.paneKey !== input.paneKey ||
        pty.incarnationId !== input.durableOwner.incarnationId ||
        !pty.agentSessionOwners.some((owner) =>
          agentSessionOwnerBindingsEqual(owner, input.durableOwner.binding)
        )
      ) {
        throw new Error('The resumed terminal lost its durable owner identity.')
      }
    }
    assertDurableOwner()
    const transcriptPath = await resolvePinnedCodexRolloutProof(input.codexHome, input.threadId)
    assertDurableOwner()
    if (!transcriptPath) {
      throw new Error('The agent terminal did not prove the expected Codex rollout.')
    }
    return { transcriptPath }
  }

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: 'codex'
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    await this.ensureStructuredAgentSessionHost()
    if (getStructuredAgentSessionHost()?.supportsCreate(location, agent)) {
      return { supported: true }
    }
    return {
      supported: false,
      reason:
        location.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? 'remote'
          : location.wslDistro
            ? 'wsl'
            : 'agent'
    }
  }

  private hasProviderSessionObservationSource(): boolean {
    return (
      this.getAgentProviderSessionRowsForPaneFn !== null ||
      this.getAgentProviderSessionSnapshotFn !== null
    )
  }

  private findAdoptedProviderSession(
    paneKey: string,
    provider: 'claude' | 'codex',
    providerSessionId: string
  ): AgentStatusIpcPayload | undefined {
    const rows =
      this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ??
      (this.getAgentProviderSessionSnapshotFn?.() ?? []).filter((row) => row.paneKey === paneKey)
    return rows
      .filter((row) => row.agentType === provider && row.providerSession?.id === providerSessionId)
      .reduce<AgentStatusIpcPayload | undefined>(
        (latest, row) => (!latest || row.receivedAt > latest.receivedAt ? row : latest),
        undefined
      )
  }

  private async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    const repo = this.store?.getRepo(target.worktree.repoId)
    const wslDistro =
      repo && !target.connectionId
        ? (getLocalProjectWorktreeGitOptions(this.requireStore(), repo).wslDistro ?? null)
        : null
    const folderWorkspace = this.store
      ?.getFolderWorkspaces?.()
      .some((workspace) => workspace.id === target.worktree.id)
    return {
      executionHostId: getRuntimeFileTargetExecutionHostId({
        worktree: target.worktree,
        connectionId: target.connectionId
      }),
      wslDistro,
      workspaceId: target.worktree.id,
      workspaceKind: folderWorkspace ? ('folder' as const) : ('git-worktree' as const)
    }
  }

  async resolveStructuredAgentSessionCreateIntent(input: {
    envelope: { sessionId: string; clientOperationId: string }
    worktree: string
    agent: 'codex'
  }): Promise<AgentSessionAttachParams> {
    return this.resolveStructuredAgentSessionIntent(input, async ({ workspacePath, launchEnv }) => {
      // A create has no process yet, so the current selection is what it must follow.
      const preparedHome = await this.prepareCodexStructuredLaunchFn?.({ workspacePath, launchEnv })
      const configuredHome = launchEnv.CODEX_HOME
      return (
        preparedHome?.trim() ||
        (this.prepareCodexStructuredLaunchFn ? getSystemCodexHomePath() : configuredHome?.trim()) ||
        getSystemCodexHomePath()
      )
    })
  }

  private async resolveStructuredAgentSessionIntent(
    input: {
      envelope: { sessionId: string; clientOperationId: string }
      worktree: string
      agent: 'codex'
    },
    resolveAccountHomePath: (context: {
      workspacePath: string
      launchEnv: NodeJS.ProcessEnv
    }) => string | Promise<string>
  ): Promise<AgentSessionAttachParams> {
    const support = await this.getStructuredAgentSessionCreateSupport(input.worktree, input.agent)
    if (!support.supported) {
      throw new Error('structured_agent_session_unsupported')
    }
    const settings = this.requireStore().getSettings()
    const launchEnv = resolveTuiAgentLaunchEnv(input.agent, settings.agentDefaultEnv)
    const location = await this.resolveStructuredAgentSessionLocation(input.worktree)
    const workspacePath = (await this.resolveRuntimeFileTarget(input.worktree)).worktree.path
    return {
      envelope: {
        sessionId: input.envelope.sessionId,
        clientOperationId: input.envelope.clientOperationId,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      location,
      provider: input.agent,
      agent: input.agent,
      accountHome: {
        variable: 'CODEX_HOME',
        path: await resolveAccountHomePath({ workspacePath, launchEnv })
      },
      runtimeKind: 'native'
    }
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    this.structuredAgentSessionTabRestorePromise ??=
      this.restoreStructuredAgentSessionTabsOnce().catch((error) => {
        this.structuredAgentSessionTabRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionTabRestorePromise
  }

  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    this.structuredAgentSessionStartupRestorePromise ??=
      this.prepareStructuredAgentSessionStartupRestorationOnce().catch((error) => {
        this.structuredAgentSessionStartupRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionStartupRestorePromise
  }

  private async prepareStructuredAgentSessionStartupRestorationOnce(): Promise<void> {
    if (!this.hasPersistedStructuredAgentSessionStore()) {
      return
    }
    // Durable agent records must exist before daemon inventory can be reconciled against them.
    await this.ensureStructuredAgentSessionHost()
    await this.refreshMobileSessionPtyRecords()
    await getStructuredAgentSessionHost()?.reconcileRestartLeases()
  }

  private hasPersistedStructuredAgentSessionStore(): boolean {
    return hasPersistedStructuredAgentSessionStoreOnDisk(getProfileUserDataPath())
  }

  private async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    await host?.restoreReadableSessions(
      collectSavedStructuredAgentSessionIds(
        this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
      )
    )
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    for (const session of host?.listSessionTabs() ?? []) {
      if (session.agent !== 'codex') {
        continue
      }
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      this.publishStructuredAgentSessionTab({
        ...session,
        agent: 'codex',
        sessionId,
        activate: false,
        notify: false
      })
    }
  }

  publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'codex'
    activate: boolean
    notify?: boolean
  }): void {
    const existing = this.mobileSessionTabsByWorktree.get(input.workspaceId)
    const id = `agent-session:${input.sessionId}`
    if (existing?.tabs.some((tab) => tab.id === id)) {
      return
    }
    const tab: RuntimeMobileSessionAgentTab = {
      type: 'agent-session',
      id,
      title: 'Codex Chat',
      sessionId: input.sessionId,
      agent: input.agent,
      isActive: input.activate
    }
    const tabs = [...(existing?.tabs ?? [])].map((candidate) => ({
      ...candidate,
      isActive: input.activate ? false : candidate.isActive
    }))
    tabs.push(tab)
    const priorGroups = existing?.tabGroups ?? [
      {
        id: this.getHeadlessMobileSessionGroupId(input.workspaceId),
        activeTabId: existing?.activeTabId ?? null,
        tabOrder: []
      }
    ]
    const groupId = priorGroups.some((group) => group.id === existing?.activeGroupId)
      ? existing!.activeGroupId!
      : priorGroups[0]!.id
    const tabGroups = priorGroups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            activeTabId: input.activate ? id : group.activeTabId,
            tabOrder: [...group.tabOrder, id]
          }
        : group
    )
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: input.workspaceId,
      publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: input.activate ? groupId : (existing?.activeGroupId ?? groupId),
      activeTabId: input.activate ? id : (existing?.activeTabId ?? null),
      activeTabType: input.activate ? 'agent-session' : (existing?.activeTabType ?? null),
      tabGroups,
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.mobileSessionTabsByWorktree.set(input.workspaceId, snapshot)
    if (input.notify !== false) {
      this.emitMobileSessionTabsSnapshot(snapshot)
    }
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

  private async resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
    relativePath: string
  } | null> {
    const targets = new Map<
      string,
      {
        worktree: ResolvedWorktree
        connectionId?: string
        executionHostId: ExecutionHostId
      }
    >()
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const settings = this.store?.getSettings()
    const visibilitySourceMatchersByRepoId = this.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolvedWorktrees,
      settings?.worktreeVisibilityDefaults
    )
    for (const worktree of resolvedWorktrees) {
      if (
        !this.isRuntimeWorktreeVisible(
          worktree,
          visibilitySourceMatchersByRepoId.get(worktree.repoId),
          settings
        )
      ) {
        continue
      }
      const candidateConnectionId = this.store?.getRepo(worktree.repoId)?.connectionId ?? undefined
      const target = {
        worktree,
        executionHostId: getRuntimeFileTargetExecutionHostId({
          worktree,
          connectionId: candidateConnectionId
        }),
        ...(candidateConnectionId ? { connectionId: candidateConnectionId } : {})
      }
      targets.set(`${target.executionHostId}\0${worktree.id}`, target)
    }
    for (const folderWorkspace of this.store?.getFolderWorkspaces?.() ?? []) {
      try {
        const candidateConnectionId =
          this.resolveFolderWorkspaceConnectionId(folderWorkspace) ?? undefined
        const worktree = this.folderWorkspaceToResolvedWorktree(folderWorkspace)
        const target = {
          worktree,
          executionHostId: getRuntimeFileTargetExecutionHostId({
            worktree,
            connectionId: candidateConnectionId
          }),
          ...(candidateConnectionId ? { connectionId: candidateConnectionId } : {})
        }
        targets.set(`${target.executionHostId}\0${worktree.id}`, target)
      } catch {
        // An ambiguous folder workspace has no single filesystem authority.
      }
    }

    const owner = findRuntimeWorkspaceFileOwner(
      [...targets.values()].map((target) => ({
        workspaceId: target.worktree.id,
        rootPath: target.worktree.path,
        executionHostId: target.executionHostId
      })),
      absolutePath,
      executionHostId
    )
    if (!owner) {
      return null
    }
    const target = targets.get(`${owner.executionHostId}\0${owner.workspaceId}`)
    return target ? { ...target, relativePath: owner.relativePath } : null
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
    return this.terminalClusterFacade.processAgentStatusOscForPty(ptyId, data)
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

  private confirmPtyAgentExit = (ptyId: string): void =>
    this.terminalAgentStatusBinding.confirmPtyAgentExit(ptyId)

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

  private async loadPtyForegroundAgentFromController(
    ptyId: string,
    afterTitleObservation?: number
  ): Promise<boolean> {
    return this.terminalAgentStatusBinding.loadPtyForegroundAgentFromController(
      ptyId,
      afterTitleObservation
    )
  }

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
    return this.terminalClusterFacade.emitTerminalAgentStatusEvents(ptyId, chunk)
  }

  private clearAgentRowSnapshotsForPty(ptyId: string): void {
    return this.mobileSessionFacade.clearAgentRowSnapshotsForPty(ptyId)
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.terminalClusterFacade.getPtyOutputSequence(ptyId)
  }

  private recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void {
    return this.terminalClusterFacade.recordAgentPromptLifecycleState(ptyId, status)
  }

  private recordAgentPromptPermissionObservation(ptyId: string): void {
    this.agentPromptPermissionSequenceByPtyId.set(
      ptyId,
      (this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0) + 1
    )
  }

  private restoreAgentPromptLifecycleByteOrder(
    ptyId: string,
    titleInput: string,
    lastPayloadTitleOffset: number | null
  ): void {
    if (lastPayloadTitleOffset === null) {
      return
    }
    const titleRange = findLastCompleteOscTitleRange(titleInput)
    if (!titleRange || titleRange.end <= lastPayloadTitleOffset) {
      return
    }
    const title = extractLastOscTitle(titleInput)
    if (title === null) {
      return
    }
    const status = detectAgentStatusFromTitle(title)
    const current = this.agentPromptLifecycleByPtyId.get(ptyId)
    if (!current || current.status === status) {
      return
    }
    this.agentPromptLifecycleByPtyId.set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && current.status !== 'working' ? 1 : 0),
      updatedAt: Date.now()
    })
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
    return this.terminalClusterFacade.maybeHydrateHeadlessFromRenderer(ptyId)
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
    return this.terminalClusterFacade.disposeHeadlessTerminal(ptyId)
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
    return this.ptyWorktrees.retirePtyAgentLaunchAuthority(ptyId)
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
    if (mode === 'mobile-fit') {
      if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
        throw new Error('invalid_dimensions')
      }
      const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(cols, rows)

      const currentSize = this.getTerminalSize(ptyId)
      const existing = this.terminalFitOverrides.get(ptyId)
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
        this.lastRendererSizes.set(ptyId, {
          cols: currentSize.cols,
          rows: currentSize.rows
        })
      }

      this.freshSubscribeGuard.add(ptyId)
      let result: ApplyLayoutResult
      try {
        result = await this.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        this.freshSubscribeGuard.delete(ptyId)
      }
      if (!result.ok) {
        throw new Error('resize_failed')
      }

      // Why: mobile-fit via resizeForClient is a deliberate mobile action;
      // the actor takes the floor (updates lastActedAt; mode-flip case is
      // already handled by enqueueLayout above).
      await this.mobileTookFloor(ptyId, clientId)

      return {
        cols: clampedCols,
        rows: clampedRows,
        previousCols,
        previousRows,
        mode: 'mobile-fit'
      }
    }

    // restore mode
    const override = this.terminalFitOverrides.get(ptyId)
    if (!override) {
      throw new Error('no_active_override')
    }
    // Only the owning client can restore — prevents one phone from undoing
    // another phone's active fit.
    if (override.clientId !== clientId) {
      throw new Error('not_override_owner')
    }

    const restore = this.resolveDesktopRestoreTarget(ptyId)
    const result = await this.enqueueLayout(ptyId, {
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
    this.notifyFitOverrideListeners(ptyId, 'desktop-fit', restore.cols, restore.rows)

    return {
      cols: restore.cols,
      rows: restore.rows,
      previousCols: null,
      previousRows: null,
      mode: 'desktop-fit'
    }
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
    this.revokeTerminalFileGrantsForClient(clientId)
    this.cancelMobileDictationForClient(clientId)

    // (1) Cancel pending restore-debounce timers owned by this client.
    for (const [ptyId, entry] of this.pendingRestoreTimers) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer)
        this.pendingRestoreTimers.delete(ptyId)
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
    for (const [ptyId, soft] of this.pendingSoftLeavers) {
      if (soft.clientId !== clientId) {
        continue
      }
      clearTimeout(soft.timer)
      this.pendingSoftLeavers.delete(ptyId)

      // Cancel any in-flight 300ms restore timer too — we'll handle it inline.
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }

      const cur = this.layouts.get(ptyId)
      // Why: Indefinite hold (mobileAutoRestoreFitMs == null) keeps the PTY
      // at phone dims after the phone disconnects; the desktop banner's
      // Restore button is the explicit return path. See
      // docs/mobile-fit-hold.md.
      if (this.hasRemoteDesktopViewers(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
        void this.applyRemoteDesktopLayout(ptyId)
        continue
      } else if (cur?.kind === 'phone' && this.getAutoRestoreFitMs() != null) {
        if (this.remoteDesktopHostReclaimTargets.has(ptyId)) {
          this.setDriver(ptyId, { kind: 'idle' })
          void this.applyRemoteDesktopLayout(ptyId)
          continue
        }
        // Use the soft-leaver's snapshot baseline as a hint, falling
        // through to resolveDesktopRestoreTarget for missing values.
        const fallback = this.resolveDesktopRestoreTarget(ptyId)
        const cols = soft.record.previousCols ?? fallback.cols
        const rows = soft.record.previousRows ?? fallback.rows
        void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // (3) Immediate restore for PTYs where this client was the last
    // mobile subscriber. With multi-mobile, peer subscribers keep the
    // floor; only when the inner map empties do we transition to desktop.
    const ptysWithSurvivingPeers: string[] = []
    const ptysToRestore: { ptyId: string; baseline: { cols: number; rows: number } | null }[] = []
    for (const [ptyId, inner] of this.mobileSubscribers) {
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
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
      if (inner.size > 0) {
        ptysWithSurvivingPeers.push(ptyId)
      } else {
        this.mobileSubscribers.delete(ptyId)
        ptysToRestore.push({ ptyId, baseline })
      }
    }
    for (const { ptyId, baseline } of ptysToRestore) {
      const cur = this.layouts.get(ptyId)
      // Why: Indefinite hold gate — see soft-leaver branch above.
      if (this.hasRemoteDesktopViewers(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
        void this.applyRemoteDesktopLayout(ptyId)
        continue
      } else if (cur?.kind === 'phone' && this.getAutoRestoreFitMs() != null) {
        if (this.remoteDesktopHostReclaimTargets.has(ptyId)) {
          this.setDriver(ptyId, { kind: 'idle' })
          void this.applyRemoteDesktopLayout(ptyId)
          continue
        }
        const fallback = this.resolveDesktopRestoreTarget(ptyId)
        const cols = baseline?.cols ?? fallback.cols
        const rows = baseline?.rows ?? fallback.rows
        void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // (4) Driver re-election where peers survived. If the disconnecting
    // client was the active driver, the most-recent surviving actor takes
    // the floor.
    for (const ptyId of ptysWithSurvivingPeers) {
      const driver = this.getDriver(ptyId)
      if (driver.kind !== 'mobile' || driver.clientId !== clientId) {
        continue
      }
      const inner = this.mobileSubscribers.get(ptyId)
      const next = inner ? this.pickMostRecentActor(inner) : null
      if (!next) {
        continue
      }
      this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })

      const mode = this.getMobileDisplayMode(ptyId)
      if (mode === 'desktop') {
        continue
      }
      const nextSub = inner!.get(next.clientId)
      const nextViewport = nextSub?.viewport
      if (!nextViewport) {
        continue
      }
      void this.enqueueLayout(ptyId, {
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
    for (const [ptyId, override] of this.terminalFitOverrides) {
      if (override.clientId !== clientId) {
        continue
      }
      if (this.mobileSubscribers.has(ptyId)) {
        continue
      }
      const cur = this.layouts.get(ptyId)
      if (cur?.kind !== 'phone') {
        continue
      }
      // Why: Indefinite hold gate — see soft-leaver branch above. Legacy
      // mobile clients (resizeForClient path) honor the same setting.
      if (this.getAutoRestoreFitMs() == null) {
        continue
      }
      const fallback = this.resolveDesktopRestoreTarget(ptyId)
      const cols = override.previousCols ?? fallback.cols
      const rows = override.previousRows ?? fallback.rows
      void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    }
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
    return this.remoteDesktopOwners.has(ptyId)
  }

  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.terminalClusterFacade.isRemoteDesktopViewerOwner(ptyId, subscriptionKey)
  }

  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    return this.terminalClusterFacade.getRemoteDesktopFitHold(ptyId, subscriptionKey)
  }

  private hasRemoteDesktopViewers(ptyId: string): boolean {
    const viewers = this.remoteDesktopViewers.get(ptyId)
    return viewers !== undefined && viewers.size > 0
  }

  private activeRemoteDesktopViewport(ptyId: string): { cols: number; rows: number } | null {
    const owner = this.remoteDesktopOwners.get(ptyId)
    return owner ? (this.remoteDesktopViewers.get(ptyId)?.get(owner) ?? null) : null
  }

  private resolveRemoteDesktopHostReclaimTarget(ptyId: string): { cols: number; rows: number } {
    const target = this.remoteDesktopHostReclaimTargets.get(ptyId)
    if (target) {
      return target
    }
    // Why: a viewer can join while a phone owns the actual PTY size. The
    // mobile restore chain retains the pre-phone desktop geometry; current
    // PTY size alone would incorrectly capture the phone grid as host truth.
    return this.resolveDesktopRestoreTarget(ptyId)
  }

  private ensureRemoteDesktopHostReclaimTarget(ptyId: string): void {
    if (!this.remoteDesktopHostReclaimTargets.has(ptyId)) {
      this.remoteDesktopHostReclaimTargets.set(
        ptyId,
        this.resolveRemoteDesktopHostReclaimTarget(ptyId)
      )
    }
  }

  recordRemoteDesktopHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    // Why: phone presence also suppresses host resize, but must not seed the
    // separate remote-viewer cache when no desktop stream owns a width floor.
    if (!this.remoteDesktopOwners.has(ptyId) || cols <= 0 || rows <= 0) {
      return
    }
    this.remoteDesktopHostReclaimTargets.set(ptyId, { cols, rows })
  }

  private hasRemoteDesktopLayoutState(ptyId: string): boolean {
    return this.terminalClusterFacade.hasRemoteDesktopLayoutState(ptyId)
  }

  private bumpRemoteDesktopViewerRevision(ptyId: string): number {
    const revision = (this.remoteDesktopViewerRevisions.get(ptyId) ?? 0) + 1
    this.remoteDesktopViewerRevisions.set(ptyId, revision)
    return revision
  }

  async applyRemoteDesktopLayout(ptyId: string): Promise<boolean> {
    return this.terminalClusterFacade.applyRemoteDesktopLayout(ptyId)
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
    const viewport = clampTerminalViewport(cols, rows)
    if (claim) {
      this.ensureRemoteDesktopHostReclaimTarget(ptyId)
    }
    let viewers = this.remoteDesktopViewers.get(ptyId)
    if (!viewers) {
      viewers = new Map<
        string,
        { clientId: string; cols: number; rows: number; activity: number }
      >()
      this.remoteDesktopViewers.set(ptyId, viewers)
    }
    const prior = viewers.get(subscriptionKey)
    if (
      prior &&
      prior.cols === viewport.cols &&
      prior.rows === viewport.rows &&
      (!claim || this.remoteDesktopOwners.get(ptyId) === subscriptionKey)
    ) {
      if (claim && this.remoteDesktopOwners.get(ptyId) === subscriptionKey) {
        const size = this.getTerminalSize(ptyId)
        if (size?.cols !== viewport.cols || size.rows !== viewport.rows) {
          return this.applyRemoteDesktopLayout(ptyId)
        }
      }
      return true
    }
    const activity = claim ? ++this.remoteDesktopActivity : (prior?.activity ?? 0)
    viewers.set(subscriptionKey, { clientId, cols: viewport.cols, rows: viewport.rows, activity })
    this.bumpRemoteDesktopViewerRevision(ptyId)
    if (claim) {
      this.remoteDesktopOwners.set(ptyId, subscriptionKey)
      return this.applyRemoteDesktopLayout(ptyId)
    }
    return true
  }

  claimRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    const viewer = this.remoteDesktopViewers.get(ptyId)?.get(subscriptionKey)
    if (!viewer) {
      return Promise.resolve(false)
    }
    if (this.remoteDesktopOwners.get(ptyId) === subscriptionKey) {
      const size = this.getTerminalSize(ptyId)
      return size?.cols === viewer.cols && size.rows === viewer.rows
        ? Promise.resolve(true)
        : this.applyRemoteDesktopLayout(ptyId)
    }
    this.ensureRemoteDesktopHostReclaimTarget(ptyId)
    viewer.activity = ++this.remoteDesktopActivity
    this.remoteDesktopOwners.set(ptyId, subscriptionKey)
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return this.applyRemoteDesktopLayout(ptyId)
  }

  claimRemoteDesktopHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    if (!this.remoteDesktopOwners.has(ptyId)) {
      // Why: disconnect can remove the owner before its queued host resize
      // lands. A host input in that window must join the reclaim, not pass it.
      return this.remoteDesktopHostReclaimTargets.has(ptyId)
        ? this.applyRemoteDesktopLayout(ptyId)
        : Promise.resolve(true)
    }
    const viewport = clampTerminalViewport(cols, rows)
    this.remoteDesktopHostReclaimTargets.set(ptyId, viewport)
    this.remoteDesktopOwners.delete(ptyId)
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return this.applyRemoteDesktopLayout(ptyId)
  }

  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.unregisterRemoteDesktopViewers(ptyId, [subscriptionKey])
  }

  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean> {
    const viewers = this.remoteDesktopViewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    let changed = false
    let removedOwner = false
    for (const subscriptionKey of subscriptionKeys) {
      removedOwner = this.remoteDesktopOwners.get(ptyId) === subscriptionKey || removedOwner
      changed = viewers.delete(subscriptionKey) || changed
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    if (viewers.size === 0) {
      this.remoteDesktopViewers.delete(ptyId)
    }
    if (removedOwner) {
      let fallback: { key: string; activity: number } | null = null
      for (const [key, viewer] of viewers) {
        if (viewer.activity > 0 && (!fallback || viewer.activity > fallback.activity)) {
          fallback = { key, activity: viewer.activity }
        }
      }
      if (fallback) {
        this.remoteDesktopOwners.set(ptyId, fallback.key)
      } else {
        this.remoteDesktopOwners.delete(ptyId)
      }
    }
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return removedOwner ? this.applyRemoteDesktopLayout(ptyId) : Promise.resolve(true)
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
    const viewers = this.remoteDesktopViewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    const viewport = clampTerminalViewport(cols, rows)
    if (claim) {
      // Why: terminal.send may be the first activity while the stream is only
      // passively registered. Snapshot host truth before this refresh owns it.
      this.ensureRemoteDesktopHostReclaimTarget(ptyId)
    }
    let changed = false
    for (const [subscriptionKey, viewer] of viewers) {
      if (viewer.clientId === clientId) {
        const activity = claim ? ++this.remoteDesktopActivity : viewer.activity
        viewers.set(subscriptionKey, {
          ...viewer,
          cols: viewport.cols,
          rows: viewport.rows,
          activity
        })
        if (claim) {
          this.remoteDesktopOwners.set(ptyId, subscriptionKey)
        }
        changed = true
      }
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    this.bumpRemoteDesktopViewerRevision(ptyId)
    return this.remoteDesktopOwners.has(ptyId)
      ? this.applyRemoteDesktopLayout(ptyId)
      : Promise.resolve(true)
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
    if (!this._orchestrationDb) {
      return
    }

    // Why the pane key too: a reminted handle no longer matches the row, but the
    // pane identity behind it outlives the remint.
    const dispatch = this._orchestrationDb.getActiveDispatchForTerminal(
      handle,
      paneKey ?? undefined
    )
    if (!dispatch) {
      return
    }

    const errorContext = describeTerminalExitCause(cause)
    const settled = this._orchestrationDb.failDispatch(dispatch.id, errorContext, {
      workerProcessExited: true,
      terminationReason: cause.kind
    })

    // Why: a deliberate close is not an incident. Escalating it trains
    // coordinators to ignore the channel that should wake them for a real one.
    if (isDeliberateTerminalExit(cause)) {
      return
    }

    // Why: failDispatch above is the authoritative state transition and has already
    // committed. Everything below is best-effort mail on top of it — resolving the
    // recipient reads the database too — and onPtyExit runs this synchronously per leaf,
    // so letting any of it escape would abandon the remaining leaves and the pty record
    // pruning that close out this exit.
    try {
      // Why: create an escalation message so the coordinator is notified about
      // the unexpected exit, even if the circuit breaker hasn't tripped yet.
      const recipient = this.resolveExitEscalationRecipient(dispatch.run_id)
      if (!recipient) {
        return
      }
      const escalation = this._orchestrationDb.insertMessage({
        from: handle,
        to: recipient.to,
        subject: `Agent exited unexpectedly (${errorContext})`,
        body: this.describeWorkerExit(dispatch, cause, handle, settled?.status),
        type: 'escalation',
        priority: 'high',
        // Why: applyEscalationToDispatch rejects an escalation without an exact Dispatch
        // binding, and a coordinator reading this needs to know which Dispatch died.
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          // Why both: `exitCode` stays for readers that already parse it, but it
          // is the raw number the host handed over, not a verdict — `exitCause`
          // is what says whether the agent was killed, finished, or was closed.
          exitCode,
          exitCause: cause,
          handle
        }),
        ...(recipient.runId ? { runId: recipient.runId } : {})
      })
      // Why: worker death is the one escalation nobody will poll for — the dead pane
      // can't nudge the coordinator, so wake its check --wait the way every other
      // message producer does.
      this.notifyMessageArrived(escalation.to_handle, escalation.type)
    } catch (error) {
      // Why: log the Run rather than the recipient — resolution itself can be what failed.
      console.warn('[orchestration] failed to escalate worker exit', {
        dispatchId: dispatch.id,
        runId: dispatch.run_id,
        error
      })
    }
  }

  // Why: the banner shows the subject and a raw payload, so without prose the coordinator
  // has to resolve ids by hand to learn what died and whether the task is still retryable.
  private describeWorkerExit(
    dispatch: { id: string; task_id: string; run_id: string },
    cause: TerminalExitCause,
    handle: string,
    settledStatus: DispatchStatus | undefined
  ): string {
    const task = this._orchestrationDb?.getTask?.(dispatch.task_id, dispatch.run_id)
    const title =
      typeof task?.spec === 'string'
        ? buildOrchestrationTaskDisplayMetadata({
            spec: task.spec,
            taskTitle: task.task_title,
            displayName: task.display_name
          }).taskTitle
        : ''
    const named = title ? `"${title}" (${dispatch.task_id})` : dispatch.task_id
    const outcome =
      settledStatus === 'circuit_broken'
        ? ' This task has now failed too many times, so it will not be retried automatically.'
        : settledStatus === 'failed'
          ? ' The task is ready to be dispatched again.'
          : ''
    // Why the cause and not a code: `code 0` reads as success even when the
    // worker was killed, which is what sent operators chasing phantom OOMs.
    return `Worker ${handle} stopped while running task ${named}. ${describeTerminalExitCause(
      cause
    )}.${outcome}`
  }

  // Why: a lightweight Run keeps its coordinator in runs/run_coordinator_handles and
  // never writes the legacy coordinator_runs table, so gating solely on that table
  // dropped every worker-death escalation (STA-4604). Address the Run mailbox the
  // coordinator's `orchestration check` actually reads, and leave legacy Runs on the
  // legacy gate.
  private resolveExitEscalationRecipient(
    runId: string
  ): { to: string; runId?: string } | undefined {
    const owningRun = this._orchestrationDb?.getRun?.(runId)
    if (owningRun && owningRun.legacy !== 1) {
      return { to: `run:${owningRun.id}`, runId: owningRun.id }
    }
    const legacyRun = this._orchestrationDb?.getActiveCoordinatorRun?.()
    return legacyRun ? { to: legacyRun.coordinator_handle } : undefined
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
    const settings = this.store?.getSettings()
    if (!settings) {
      throw new Error('runtime_unavailable')
    }
    if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Agent launcher ${agent} is disabled or unavailable.`
      )
    }
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
    return this.terminalClusterFacade.sendTerminalAgentPrompt(handle, prompt, options)
  }

  async getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    return this.terminalClusterFacade.getTerminalAgentStatus(handle)
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
    return this.terminalClusterFacade.getFreshExplicitAgentStatusForHandle(handle, paneKeyOverride)
  }

  /** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
   *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
   *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
   *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
   *  process.platform says nothing about it. */
  private getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    return this.ptyWorktrees.getPtyWriteHostPlatform(ptyId)
  }

  private getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const explicitCandidate = this.getFreshExplicitAgentStatusForHandle(handle)
    const explicitFloor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    const explicit =
      explicitCandidate &&
      (explicitFloor === undefined || explicitCandidate.updatedAt > explicitFloor)
        ? explicitCandidate
        : null
    const lifecycle = this.agentPromptLifecycleByPtyId.get(ptyId)
    const ptyStatus =
      lifecycle || explicitFloor === undefined
        ? (this.ptysById.get(ptyId)?.lastAgentStatus ?? null)
        : null
    const lifecycleIsNewer =
      lifecycle &&
      (!explicit ||
        lifecycle.updatedAt > explicit.updatedAt ||
        (lifecycle.updatedAt === explicit.updatedAt && lifecycle.status === 'permission'))
    const waitText = waitTextCache
      ? readAgentPromptWaitText(
          waitTextCache,
          outputSequence,
          () => this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText
        )
      : undefined
    const terminal = this.getTerminalAgentStatusSnapshot(handle, ptyId, waitText)
    const status = this.hasAuthoritativeTerminalWaitPermission(terminal, explicit, lifecycle)
      ? 'permission'
      : lifecycleIsNewer
        ? lifecycle.status
        : (explicit?.status ?? ptyStatus ?? null)
    return {
      generation: this.getPtyLifecycleGeneration(ptyId),
      permissionSequence: this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0,
      workingSequence: lifecycle?.workingSequence ?? 0,
      // Why: hook status is the only turn-start signal agents without title coverage have, and it
      // reaches here without the window-gated synthetic title frame (#16095). Anchored on
      // stateStartedAt, not updatedAt — same-state tool/prompt pings refresh updatedAt and would
      // otherwise pass off an in-progress turn as a new one.
      explicitWorkingStartedAt: explicit?.status === 'working' ? explicit.stateStartedAt : null,
      outputSequence,
      status
    }
  }

  private getPtyAgent(ptyId: string): TuiAgent | null {
    return this.ptyWorktrees.getPtyAgent(ptyId)
  }

  private assertAgentPromptPermissionSafe(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (
      current.status === 'permission' ||
      current.permissionSequence > baseline.permissionSequence
    ) {
      throw new Error('agent_prompt_blocked')
    }
  }

  /** `pasteIngestMs` is the payload's ingest bound on the executing host. Nothing here may
   *  settle before it elapses: the agent can repaint mid-ingest, so marker-then-quiet alone
   *  would fire Enter into a paste ConPTY is still feeding. */
  private createAgentPromptRenderGate(
    ptyId: string,
    pasteIngestMs: number
  ): {
    arm: () => void
    wait: () => Promise<void>
    dispose: () => void
  } | null {
    if (!isTerminalSendSettlementAgent(this.getPtyAgent(ptyId))) {
      return null
    }
    let armed = false
    let canSettle = false
    let settled = false
    let ingested = pasteIngestMs <= 0
    // Why absolute: the ingest clock starts once, here, but the cap is armed twice (at arm()
    // and again on the marker). Re-adding the whole window would charge ingest twice.
    const ingestDeadlineAt = Date.now() + pasteIngestMs
    let markerCarry = ''
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let ingestTimer: NodeJS.Timeout | null = null
    let resolveRender!: () => void
    const rendered = new Promise<void>((resolve) => {
      resolveRender = resolve
    })

    const clearGateTimers = (): void => {
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
      if (hardTimer) {
        clearTimeout(hardTimer)
        hardTimer = null
      }
      if (ingestTimer) {
        clearTimeout(ingestTimer)
        ingestTimer = null
      }
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearGateTimers()
      resolveRender()
    }
    const armQuietTimer = (): void => {
      // Why: the quiet window measures the agent going still after a *complete* paste.
      // Silence during ingest is not settlement, so it cannot start the clock.
      if (!ingested) {
        return
      }
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      quietTimer = setTimeout(finish, AGENT_PROMPT_RENDER_QUIET_MS)
    }
    const armHardTimer = (): void => {
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      // Why: the cap bounds the wait *after* the bytes land; a flat 8000 ms would expire
      // mid-paste past ~770 KB on Windows and write Enter into it.
      hardTimer = setTimeout(
        finish,
        AGENT_PROMPT_RENDER_TIMEOUT_MS + Math.max(0, ingestDeadlineAt - Date.now())
      )
    }
    if (!ingested) {
      ingestTimer = setTimeout(() => {
        ingestTimer = null
        ingested = true
        if (canSettle) {
          armQuietTimer()
        }
      }, pasteIngestMs)
    }
    const unsubscribe = this.subscribeToTerminalData(ptyId, (data) => {
      if (!armed || settled) {
        return
      }
      if (!canSettle) {
        const combined = markerCarry + data
        markerCarry = combined.slice(-(AGENT_PROMPT_RENDER_MARKER.length - 1))
        if (!combined.includes(AGENT_PROMPT_RENDER_MARKER)) {
          return
        }
        canSettle = true
        // Why: a slow initial redraw must still receive the full settlement window.
        armHardTimer()
      }
      armQuietTimer()
    })
    return {
      arm: () => {
        armed = true
        markerCarry = ''
        armHardTimer()
      },
      wait: async () => {
        if (settled) {
          return
        }
        await rendered
      },
      dispose: () => {
        unsubscribe()
        clearGateTimers()
      }
    }
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
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktreeSnapshot = await this.listResolvedWorktreeSnapshot()
    const settings = this.store?.getSettings()
    const visibilityDefaults = sourceDefaultsSupported
      ? settings?.worktreeVisibilityDefaults
      : settings?.worktreeVisibilityDefaults
        ? { external: settings.worktreeVisibilityDefaults.external }
        : undefined
    const visibilitySettings = settings
      ? { ...settings, worktreeVisibilityDefaults: visibilityDefaults }
      : undefined
    const visibilitySourceMatchersByRepoId = this.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolvedWorktreeSnapshot.worktrees,
      visibilityDefaults
    )
    const resolvedWorktrees = resolvedWorktreeSnapshot.worktrees.filter((worktree) =>
      this.isRuntimeWorktreeVisible(
        worktree,
        visibilitySourceMatchersByRepoId.get(worktree.repoId),
        visibilitySettings
      )
    )
    // Why: worktree.ps backs the mobile sidebar, so it must use the same
    // host-owned imported-worktree visibility gate as worktree.list/desktop.
    const freshPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const platformByRepoId = resolvedWorktreeSnapshot.platformByRepoId
    const summaries = new Map<string, RuntimeWorktreePsSummary>()
    const workingTerminalEvidenceByWorktreeId = new Map<string, RuntimeWorkingTerminalEvidence[]>()

    // Why: the GitHub cache is keyed by `repoPath::branch` (no refs/heads/ prefix),
    // matching how the renderer's fetchPRForBranch stores entries. We look up cached
    // PR info so mobile clients can group worktrees by PR state without making
    // expensive `gh` CLI calls. Falls back to meta.linkedPR if no cache entry exists.
    const ghCache = this.store?.getGitHubCache?.()
    for (const worktree of resolvedWorktrees) {
      const meta =
        this.store?.getWorktreeMeta?.(worktree.id) ?? this.store?.getAllWorktreeMeta()[worktree.id]
      const repo = repoById.get(worktree.repoId)
      let linkedPR: { number: number; state: string } | null = null
      const branch = worktree.branch.replace(/^refs\/heads\//, '')
      if (branch && ghCache) {
        // Why: the renderer keys the PR cache by `repoId::branch` (getGitHubPRCacheKey
        // prefers repo.id over repo.path), so read by id first and fall back to path
        // for legacy/path-keyed entries. Reading only by path missed every cached
        // entry, leaving mobile's linked-PR badge stuck on the 'unknown' fallback.
        const cached =
          (repo?.id ? ghCache.pr[`${repo.id}::${branch}`] : undefined) ??
          (repo?.path ? ghCache.pr[`${repo.path}::${branch}`] : undefined)
        if (cached?.data) {
          linkedPR = { number: cached.data.number, state: cached.data.state }
        }
      }
      if (!linkedPR && meta?.linkedPR != null) {
        linkedPR = { number: meta.linkedPR, state: 'unknown' }
      }
      const terminalPlatform = platformByRepoId.get(worktree.repoId) ?? process.platform
      // Why: use the instance-validated lineage from attachLineageToResolvedWorktrees,
      // not the raw store entry — shipped mobile clients trust parentWorktreeId as-is,
      // so a stale same-path entry would nest replacement checkouts under old parents.
      const lineage = worktree.lineage
      summaries.set(worktree.id, {
        // Why: mobile mirrors desktop workspace grouping/order from persisted
        // metadata, while older runtimes may not have hydrated every field yet.
        workspaceKind: 'git',
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        ...((meta?.hostId ?? worktree.hostId) ? { hostId: meta?.hostId ?? worktree.hostId } : {}),
        terminalPlatform,
        repo: repo?.displayName ?? worktree.repoId,
        path: worktree.path,
        branch: worktree.branch,
        isArchived: worktree.isArchived,
        isMainWorktree: worktree.isMainWorktree,
        hasHostSidebarActivity: false,
        ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
        ...(lineage?.worktreeInstanceId !== undefined
          ? { lineageWorktreeInstanceId: lineage.worktreeInstanceId }
          : {}),
        ...(lineage?.parentWorktreeInstanceId !== undefined
          ? { parentWorktreeInstanceId: lineage.parentWorktreeInstanceId }
          : {}),
        parentWorktreeId: worktree.parentWorktreeId,
        childWorktreeIds: worktree.childWorktreeIds,
        displayName: worktree.displayName,
        workspaceStatus: meta?.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
        sortOrder: meta?.sortOrder ?? 0,
        ...(meta?.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
        lastActivityAt: worktree.lastActivityAt,
        ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
        ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
        linkedIssue: worktree.linkedIssue,
        linkedPR,
        linkedLinearIssue: meta?.linkedLinearIssue ?? null,
        linkedGitLabMR: meta?.linkedGitLabMR ?? null,
        linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
        comment: meta?.comment ?? '',
        isPinned: meta?.isPinned ?? false,
        isActive: false,
        unread: meta?.isUnread ?? false,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: '',
        status: 'inactive',
        agents: []
      })
    }

    const projectGroupById = new Map(
      (this.store?.getProjectGroups?.() ?? []).map((group) => [group.id, group])
    )
    for (const folderWorkspace of this.store?.getFolderWorkspaces?.() ?? []) {
      const projectGroup = projectGroupById.get(folderWorkspace.projectGroupId)
      if (!projectGroup?.parentPath) {
        continue
      }
      const worktree = folderWorkspaceToWorktree(folderWorkspace)
      summaries.set(worktree.id, {
        // Why: folder workspaces use the same mobile grouping/order contract as
        // git worktrees, but legacy records may be missing order metadata.
        workspaceKind: 'folder-workspace',
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        repo: projectGroup.name,
        path: worktree.path,
        branch: worktree.branch,
        isArchived: worktree.isArchived,
        isMainWorktree: worktree.isMainWorktree,
        hasHostSidebarActivity: false,
        ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
        parentWorktreeId: null,
        childWorktreeIds: [],
        displayName: worktree.displayName,
        workspaceStatus: worktree.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
        sortOrder: worktree.sortOrder ?? 0,
        ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
        lastActivityAt: worktree.lastActivityAt,
        ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
        ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
        linkedIssue: worktree.linkedIssue ?? null,
        linkedPR: null,
        linkedLinearIssue: worktree.linkedLinearIssue ?? null,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null,
        linkedGitLabIssue: worktree.linkedGitLabIssue ?? null,
        comment: worktree.comment,
        isPinned: worktree.isPinned,
        isActive: false,
        unread: worktree.isUnread,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: '',
        status: 'inactive',
        agents: []
      })
    }

    const runtimeWorktreeSummaryPathIndex = buildRuntimeWorktreeSummaryPathIndex(
      summaries,
      resolvedWorktrees,
      platformByRepoId
    )
    const missingRuntimeWorktreeIds = new Set<string>()
    const countedPtyIds = new Set<string>()
    const session = this.store?.getWorkspaceSession?.()
    const savedTabOwnerById = new Map<string, { worktreeId: string; title: string }>()
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        savedTabOwnerById.set(tab.id, { worktreeId, title: tab.title })
      }
    }
    const savedLayoutTabIdByPtyId = new Map<string, string>()
    for (const [tabId, layout] of Object.entries(session?.terminalLayoutsByTabId ?? {})) {
      for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
        if (ptyId) {
          savedLayoutTabIdByPtyId.set(ptyId, tabId)
        }
      }
    }
    for (const leaf of this.leaves.values()) {
      if (
        !leaf.ptyId ||
        !leaf.connected ||
        (freshPtyLiveness !== null && !freshPtyLiveness.has(leaf.ptyId))
      ) {
        continue
      }
      const freshPtyOwner = this.ptysById.get(leaf.ptyId)
      if (
        freshPtyLiveness !== null &&
        freshPtyOwner?.connected &&
        !runtimeWorktreeIdsEqual(freshPtyOwner.worktreeId, leaf.worktreeId)
      ) {
        // Why: provider/persisted ownership is fresher than a renderer leaf left behind by graph migration or another client.
        continue
      }
      const summary = this.getSummaryForRuntimeWorktreeId(
        summaries,
        runtimeWorktreeSummaryPathIndex,
        missingRuntimeWorktreeIds,
        leaf.worktreeId
      )
      if (!summary) {
        continue
      }
      countedPtyIds.add(leaf.ptyId)
      summary.hasHostSidebarActivity = true
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = true
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
      const leafStatus = getLeafWorktreeStatus(leaf, this.tabs.get(leaf.tabId)?.title ?? null)
      if (leafStatus === 'working') {
        addRuntimeWorkingTerminalEvidence(workingTerminalEvidenceByWorktreeId, summary.worktreeId, {
          paneKey: this.makeRuntimePaneKey(leaf),
          ptyId: leaf.ptyId,
          tabId: leaf.tabId
        })
      }
      mergeWorktreeSummaryStatus(summary, leafStatus)
      if (
        leaf.preview &&
        (summary.preview.length === 0 || (leaf.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = leaf.preview
      }
    }

    for (const pty of this.ptysById.values()) {
      if (
        !pty.connected ||
        countedPtyIds.has(pty.ptyId) ||
        (freshPtyLiveness !== null && !freshPtyLiveness.has(pty.ptyId))
      ) {
        continue
      }
      const persistedTabId = savedLayoutTabIdByPtyId.get(pty.ptyId)
      let owner = persistedTabId ? savedTabOwnerById.get(persistedTabId) : undefined
      if (freshPtyLiveness !== null) {
        // Why: refresh resolved provider/migration ownership; stale persisted tabs may supply a title but cannot reassign a live PTY.
        owner = {
          worktreeId: pty.worktreeId,
          title: owner?.title ?? getLatestPtyTitle(pty) ?? ''
        }
      }
      if (!owner && persistedTabId && pty.tabId === persistedTabId) {
        owner = {
          worktreeId: pty.worktreeId,
          title: getLatestPtyTitle(pty) ?? ''
        }
      }
      const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
      const hasExplicitRuntimeOwner =
        pty.tabId !== null && parsedPaneKey?.tabId === pty.tabId && parsedPaneKey.leafId.length > 0
      const savedTabOwner = pty.tabId ? savedTabOwnerById.get(pty.tabId) : undefined
      const hasSavedLayout =
        pty.tabId !== null && Object.hasOwn(session?.terminalLayoutsByTabId ?? {}, pty.tabId)
      if (!owner && hasExplicitRuntimeOwner && !hasSavedLayout) {
        owner = {
          worktreeId: savedTabOwner?.worktreeId ?? pty.worktreeId,
          title: savedTabOwner?.title ?? getLatestPtyTitle(pty) ?? ''
        }
      }
      if (!owner) {
        // Why: provider existence alone cannot attribute a reused or unbound PTY to a workspace.
        continue
      }
      const summary = this.getSummaryForRuntimeWorktreeId(
        summaries,
        runtimeWorktreeSummaryPathIndex,
        missingRuntimeWorktreeIds,
        owner.worktreeId
      )
      if (!summary) {
        continue
      }
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = true
      summary.hasHostSidebarActivity = true
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, pty.lastOutputAt)
      const ptyStatus = getSavedTabWorktreeStatus(owner.title, true)
      if (ptyStatus === 'working') {
        addRuntimeWorkingTerminalEvidence(workingTerminalEvidenceByWorktreeId, summary.worktreeId, {
          paneKey: pty.paneKey,
          ptyId: pty.ptyId,
          tabId: pty.tabId ?? persistedTabId ?? null
        })
      }
      mergeWorktreeSummaryStatus(summary, ptyStatus)
      if (
        pty.preview &&
        (summary.preview.length === 0 || (pty.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = pty.preview
      }
    }

    const mirroredWorktreeIdByTabId = new Map<string, string>()
    const sessionsByHostId = new Map<ExecutionHostId, WorkspaceSessionState>()
    for (const summary of summaries.values()) {
      const repo = repoById.get(summary.repoId)
      const hostId = repo ? getRepoExecutionHostId(repo) : 'local'
      const session = this.store?.getWorkspaceSession?.(hostId)
      if (session) {
        sessionsByHostId.set(hostId, session)
      }
    }
    for (const session of sessionsByHostId.values()) {
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        for (const tab of tabs) {
          mirroredWorktreeIdByTabId.set(tab.id, worktreeId)
        }
        if (tabs.length === 0) {
          continue
        }
        const summary = this.getSummaryForRuntimeWorktreeId(
          summaries,
          runtimeWorktreeSummaryPathIndex,
          missingRuntimeWorktreeIds,
          worktreeId
        )
        if (!summary) {
          continue
        }
        if (tabs.some((tab) => tab.ptyId !== null && this.ptysById.get(tab.ptyId)?.connected)) {
          summary.hasHostSidebarActivity = true
        }
      }
      for (const [worktreeId, tabs] of Object.entries(session.browserTabsByWorktree ?? {})) {
        if (tabs.length === 0) {
          continue
        }
        const summary = this.getSummaryForRuntimeWorktreeId(
          summaries,
          runtimeWorktreeSummaryPathIndex,
          missingRuntimeWorktreeIds,
          worktreeId
        )
        if (summary) {
          summary.hasHostSidebarActivity = true
        }
      }
      if (session.activeWorktreeId) {
        const activeSummary = this.getSummaryForRuntimeWorktreeId(
          summaries,
          runtimeWorktreeSummaryPathIndex,
          missingRuntimeWorktreeIds,
          session.activeWorktreeId
        )
        if (activeSummary) {
          activeSummary.isActive = true
        }
      }
    }
    // Why: a live renderer graph may precede persistence, but persisted tab
    // ownership wins when an automatic workspace rename has already rekeyed it.
    for (const [tabId, tab] of this.tabs) {
      if (!mirroredWorktreeIdByTabId.has(tabId)) {
        mirroredWorktreeIdByTabId.set(tabId, tab.worktreeId)
      }
    }

    // Why: a connected PTY proves a pane is still live even when its tab has
    // already left every session record (daemon-held terminals, graph gaps).
    // Deliberately trusts the optimistic connected flag (no freshPtyLiveness
    // gate, unlike the count loops above): evidence only KEEPS rows.
    const connectedPtyEvidence = {
      tabIds: new Set<string>(),
      paneKeys: new Set<string>(),
      ptyIds: new Set<string>()
    }
    for (const pty of this.ptysById.values()) {
      if (!pty.connected) {
        continue
      }
      connectedPtyEvidence.ptyIds.add(pty.ptyId)
      if (pty.tabId) {
        connectedPtyEvidence.tabIds.add(pty.tabId)
      }
      if (pty.paneKey) {
        connectedPtyEvidence.paneKeys.add(pty.paneKey)
      }
    }

    this.attachAgentRowsToSummaries(
      summaries,
      runtimeWorktreeSummaryPathIndex,
      missingRuntimeWorktreeIds,
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      workingTerminalEvidenceByWorktreeId
    )

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
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
    // Why: most agents report via hooks (agent-hooks/server), not OSC, so the
    // hook snapshot is the primary source — same one the desktop sidebar reads.
    // OSC-only entries (no hook) are merged in as a fallback, keyed by paneKey.
    const rowSources = new Map<string, RuntimeWorktreeAgentSource>()
    const now = Date.now()
    for (const snapshot of this.latestAgentStatusByPaneKey.values()) {
      const { payload } = snapshot
      rowSources.set(snapshot.paneKey, {
        paneKey: snapshot.paneKey,
        ptyId: snapshot.ptyId,
        tabId: snapshot.tabId,
        worktreeId: snapshot.worktreeId,
        connectionId: snapshot.connectionId,
        payload,
        state: payload.state,
        ...(payload.workingMode ? { workingMode: payload.workingMode } : {}),
        agentType: payload.agentType ?? null,
        prompt: payload.prompt,
        lastAssistantMessage: payload.lastAssistantMessage ?? null,
        toolName: payload.toolName ?? null,
        toolInput: payload.toolInput ?? null,
        interrupted: payload.interrupted ?? false,
        stateStartedAt: snapshot.stateStartedAt,
        updatedAt: snapshot.updatedAt
      })
    }
    for (const entry of this.getAgentStatusSnapshotFn?.() ?? []) {
      // Why: old mobile clients ignore this provenance bit, so publishing the row would turn an explicitly unconfirmed restore into fresh activity under version skew.
      if (entry.restoredUnconfirmed === true) {
        continue
      }
      const existing = rowSources.get(entry.paneKey)
      const hookPayload = pickParsedAgentStatusPayload(entry)
      // Why: hook rows win ties, but an older cached hook must not replace a
      // fresh OSC status and make a running mobile workspace look inactive.
      if (existing && existing.updatedAt > entry.receivedAt) {
        if (
          entry.workingMode === 'monitoring' &&
          // restoredUnconfirmed rows already `continue` above.
          now - entry.receivedAt <= AGENT_STATUS_STALE_AFTER_MS &&
          terminalStatusPayloadMatchesHook(hookPayload, existing.payload)
        ) {
          // Why: older OSC reporters cannot express hook-authoritative monitoring mode.
          existing.workingMode = 'monitoring'
          if (existing.payload.workingMode === undefined) {
            existing.payload = { ...existing.payload, workingMode: 'monitoring' }
          }
        }
        continue
      }
      rowSources.set(entry.paneKey, {
        paneKey: entry.paneKey,
        // Hook payloads carry no ptyId; keep the OSC-observed one so the
        // connected-PTY rescue survives a hook row winning the freshness race.
        ptyId: existing?.ptyId,
        tabId: entry.tabId,
        worktreeId: entry.worktreeId,
        connectionId: entry.connectionId,
        payload: hookPayload,
        state: entry.state,
        ...(entry.workingMode ? { workingMode: entry.workingMode } : {}),
        agentType: entry.agentType ?? null,
        prompt: entry.prompt,
        lastAssistantMessage: entry.lastAssistantMessage ?? null,
        toolName: entry.toolName ?? null,
        toolInput: entry.toolInput ?? null,
        interrupted: entry.interrupted ?? false,
        stateStartedAt: entry.stateStartedAt,
        updatedAt: entry.receivedAt
      })
    }
    if (rowSources.size === 0) {
      return
    }
    const orchestrationByPaneKey = this.buildAgentOrchestrationByPaneKey()
    const rowsByWorktree = new Map<string, RuntimeWorktreeAgentRow[]>()
    for (const src of rowSources.values()) {
      // Why: hooks retain launch-time attribution across automatic workspace
      // renames; the tab's current mirrored owner is authoritative when present.
      // Legacy numeric pane keys (non-UUID leaves) still name a real tab, so
      // parse them too — otherwise their rows would bypass the stale filter.
      const tabId =
        src.tabId ??
        parsePaneKey(src.paneKey)?.tabId ??
        parseLegacyNumericPaneKey(src.paneKey)?.tabId
      const mirroredWorktreeId = tabId ? mirroredWorktreeIdByTabId.get(tabId) : undefined
      if (
        tabId !== undefined &&
        mirroredWorktreeId === undefined &&
        (src.connectionId === null || isWslHookRelayConnectionId(src.connectionId)) &&
        !connectedPtyEvidence.tabIds.has(tabId) &&
        !connectedPtyEvidence.paneKeys.has(src.paneKey) &&
        (src.ptyId === undefined || !connectedPtyEvidence.ptyIds.has(src.ptyId))
      ) {
        // Why: hook snapshots hydrate from last-status.json for days, so a row
        // from a local or WSL-relayed pane whose tab left every session and the
        // live graph, with no connected PTY, is retained history — surfacing it
        // resurrects closed agents on mobile (#6072). SSH rows are exempt (their
        // tabs may exist only remotely), as are rows with no resolvable tabId
        // (staleness unprovable). Session tabs count as existence: headless
        // serve has no renderer graph, and session.tabs.list serves them.
        continue
      }
      const worktreeId = mirroredWorktreeId ?? src.worktreeId
      if (!worktreeId) {
        continue
      }
      const summary = this.getSummaryForRuntimeWorktreeId(
        summaries,
        runtimeWorktreeSummaryPathIndex,
        missingRuntimeWorktreeIds,
        worktreeId
      )
      if (!summary) {
        continue
      }
      const taskTitle = orchestrationByPaneKey?.[src.paneKey]?.taskTitle ?? null
      const displayName = orchestrationByPaneKey?.[src.paneKey]?.displayName ?? null
      const row: RuntimeWorktreeAgentRow = {
        paneKey: src.paneKey,
        parentPaneKey: orchestrationByPaneKey?.[src.paneKey]?.parentPaneKey ?? null,
        state: src.state,
        ...(src.workingMode ? { workingMode: src.workingMode } : {}),
        agentType: src.agentType,
        prompt: src.prompt,
        taskTitle,
        displayName,
        lastAssistantMessage: src.lastAssistantMessage,
        toolName: src.toolName,
        toolInput: src.toolInput,
        interrupted: src.interrupted,
        stateStartedAt: src.stateStartedAt,
        updatedAt: src.updatedAt
      }
      // Why: SSH/runtime projections can spell an equivalent path differently;
      // bucket by the canonical summary id so mobile keeps the agent activity.
      const rows = rowsByWorktree.get(summary.worktreeId)
      if (rows) {
        rows.push(row)
      } else {
        rowsByWorktree.set(summary.worktreeId, [row])
      }
    }
    for (const [worktreeId, rows] of rowsByWorktree) {
      // Oldest-started first, matching the desktop dashboard's start-order sort.
      rows.sort((a, b) => a.stateStartedAt - b.stateStartedAt)
      const summary = summaries.get(worktreeId)
      if (summary) {
        summary.agents = rows
        let hasForegroundWorkingAgent = false
        const monitoringSources: RuntimeWorktreeAgentSource[] = []
        for (const row of rows) {
          if (!isFreshNonDoneAgentStatus(row, now)) {
            continue
          }
          // Why: worktree.ps is mobile's host-sidebar parity source, so a live
          // agent must survive the same temporary PTY gaps as desktop.
          summary.hasHostSidebarActivity = true
          if (row.state === 'working') {
            if (row.workingMode === 'monitoring') {
              const source = rowSources.get(row.paneKey)
              if (source) {
                monitoringSources.push(source)
              }
            } else {
              hasForegroundWorkingAgent = true
            }
          } else {
            mergeWorktreeSummaryStatus(summary, 'permission')
          }
        }
        if (hasForegroundWorkingAgent || monitoringSources.length > 0) {
          const hasIndependentWorkingTerminal = (
            workingTerminalEvidenceByWorktreeId.get(worktreeId) ?? []
          ).some((evidence) =>
            monitoringSources.every(
              (source) => !runtimeWorkingTerminalEvidenceMatchesSource(evidence, source)
            )
          )
          mergeWorktreeSummaryStatus(
            summary,
            'working',
            hasForegroundWorkingAgent || hasIndependentWorkingTerminal ? undefined : 'monitoring'
          )
        }
      }
    }
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

  private async buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent
  ): Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    draftPaste?: WorktreeStartupDraftPaste
  } | null> {
    if (!this.store) {
      return null
    }
    const content = draft.trim()
    if (!content) {
      return null
    }
    const settings = this.store.getSettings()
    const preferredAgent = requestedAgent ?? settings.defaultTuiAgent
    if (preferredAgent === 'blank') {
      // Why: `blank` is an explicit user preference to create a shell-only
      // workspace, so linked task drafts must not auto-pick a detected agent.
      return null
    }
    let agent =
      isTuiAgent(preferredAgent) && isTuiAgentEnabled(preferredAgent, settings.disabledTuiAgents)
        ? preferredAgent
        : null
    if (!agent) {
      let detected: string[] = []
      try {
        // Why: startup-draft fallback can run from sparse runtime launch envs too.
        detected = repo.connectionId
          ? await detectRemoteAgents({ connectionId: repo.connectionId })
          : await detectInstalledAgentsWithShellPathHydration()
      } catch {
        detected = []
      }
      const typedDetected = detected.filter(isTuiAgent)
      agent = pickTuiAgent(null, typedDetected, settings.disabledTuiAgents)
    }
    if (!agent) {
      return null
    }

    // Why: a mobile client can run on Windows while the workspace shell is
    // Linux over SSH. Startup command quoting must target the shell that runs it.
    const agentLaunchPlatform = this.getAgentLaunchPlatformForRepo(repo)
    const isRemote = repoIsRemote(repo)
    const queuedShell = resolveLocalWindowsAgentStartupShell({
      platform: agentLaunchPlatform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      agent,
      draft: content,
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
      platform: agentLaunchPlatform,
      shell: queuedShell,
      isRemote
    })
    if (draftLaunchPlan) {
      return {
        agent,
        startup: {
          command: draftLaunchPlan.launchCommand,
          launchConfig: draftLaunchPlan.launchConfig,
          ...(draftLaunchPlan.startupCommandDelivery
            ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
            : {}),
          ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
        }
      }
    }

    const startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
      platform: agentLaunchPlatform,
      shell: queuedShell,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      return null
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
      draftPaste: { agent, content }
    }
  }

  private buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences
  ): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
    return this.terminalClusterFacade.buildStartupForAgent(repo, agent, prompt, launchPreferences)
  }

  private markWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string | null | undefined,
    workspacePath: string
  ): Promise<void> {
    return this.terminalClusterFacade.markWorkspaceTrustedForAgent(
      agent,
      connectionId,
      workspacePath
    )
  }

  private async markLocalWorkspaceTrustedForAgent(
    agent: TuiAgent,
    workspacePath: string
  ): Promise<void> {
    const preset = TUI_AGENT_CONFIG[agent].preflightTrust
    if (!preset) {
      return
    }
    try {
      if (preset === 'cursor') {
        markCursorWorkspaceTrusted(workspacePath)
      } else if (preset === 'copilot') {
        markCopilotFolderTrusted(workspacePath)
      } else if (preset === 'codex') {
        // Why: the Codex write queues behind any in-flight hook grant, so the
        // agent must not launch until it has actually landed.
        await markCodexProjectTrusted(workspacePath)
      }
    } catch {
      // Best-effort: the user can still accept the agent trust prompt manually.
    }
  }

  private async markRemoteWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string,
    workspacePath: string
  ): Promise<void> {
    const preset = TUI_AGENT_CONFIG[agent].preflightTrust
    if (!preset) {
      return
    }
    try {
      await markRemoteAgentWorkspaceTrusted({ preset, connectionId, workspacePath })
    } catch {
      // Best-effort: the user can still accept the remote agent trust prompt manually.
    }
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

  private enqueueRemoteFetch(
    remoteKey: string,
    runFetch: () => Promise<RemoteFetchResult>
  ): Promise<RemoteFetchResult> {
    const previous = this.remoteFetchQueueTail.get(remoteKey)
    const promise = previous ? previous.then(runFetch, runFetch) : runFetch()
    this.remoteFetchQueueTail.set(remoteKey, promise)
    promise.finally(() => {
      if (this.remoteFetchQueueTail.get(remoteKey) === promise) {
        this.remoteFetchQueueTail.delete(remoteKey)
      }
    })
    return promise
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
    const key = await this.getCanonicalFetchKey(repoPath, remote, gitOptions)
    if (this.getFreshFetchCompletedAt(key) !== null) {
      // Why: freshness window hit — skip the fetch entirely. Do NOT reuse any
      // in-flight promise here; the timestamp is only written on success, so
      // hitting this branch means a previous fetch did succeed recently.
      return { ok: true }
    }

    const existing = this.fetchInflight.get(key)
    if (existing) {
      // Why: genuine serialization (not check-then-set). Two callers racing
      // on the same repo+remote share the single underlying `git fetch`.
      return existing
    }

    const promise = this.enqueueRemoteFetch(key, () =>
      gitExecFileAsync(['fetch', remote], {
        cwd: repoPath,
        ...gitOptions,
        // Why: cap the create-path base-ref fetch so a stuck first-auth on
        // Windows (GCM prompt) fails fast instead of hanging creation (STA-1292).
        timeout: REMOTE_FETCH_TIMEOUT_MS
      })
        .then((): RemoteFetchResult => {
          // Why (§3.3 Lifecycle): timestamp on success ONLY. Writing on rejection
          // would make the freshness cache lie about the last known remote state.
          this.rememberFreshFetchCompletedAt(key)
          return { ok: true }
        })
        .catch((err): RemoteFetchResult => {
          // Why: swallow here so awaiters don't throw at the await site. Outer
          // create/dispatch paths are already tolerant of offline fetch failure;
          // this is the behavioral contract of this helper.
          console.warn(`[fetchRemoteWithCache] ${remote} fetch failed for ${repoPath}:`, err)
          return { ok: false, errorKind: 'git_error' }
        })
    ).finally(() => {
      // Why (§3.3 Lifecycle): evict on BOTH success and rejection. A
      // rejected entry that survived in the Map would wedge every future
      // create on this repo until Orca restarted (the F2 bug §3.3 pins).
      this.fetchInflight.delete(key)
    })

    this.fetchInflight.set(key, promise)
    return promise
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    const remoteKey = await this.getCanonicalFetchKey(repoPath, base.remote, gitOptions)
    const key = await this.getCanonicalFetchKey(
      repoPath,
      `base:${base.remote}:${base.branch}`,
      gitOptions
    )
    if (this.getFreshFetchCompletedAt(key) !== null) {
      // Why: exact-base freshness is the safety boundary. A full remote fetch
      // can be narrowed by repo refspecs, so it must not prove this branch.
      return { ok: true }
    }

    const existing = this.fetchInflight.get(key)
    if (existing) {
      return existing
    }

    const promise = this.enqueueRemoteFetch(remoteKey, async () => {
      if (this.getFreshFetchCompletedAt(key) !== null) {
        return { ok: true }
      }
      // Why: this exact refresh gates worktree create; ordinary fetches still own maintenance.
      return gitExecFileAsync(
        [
          ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
          'fetch',
          '--no-tags',
          base.remote,
          `+refs/heads/${base.branch}:${base.ref}`
        ],
        {
          cwd: repoPath,
          ...gitOptions,
          // Why: exact remote-base refresh is the network gate for worktree
          // creation, so honor repo SSH routing and bound custom wrappers.
          useConfiguredSshCommandForNetwork: true,
          timeout: REMOTE_FETCH_TIMEOUT_MS
        }
      )
        .then((): RemoteFetchResult => {
          this.rememberFreshFetchCompletedAt(key)
          return { ok: true }
        })
        .catch((err): RemoteFetchResult => {
          console.warn(
            `[refreshRemoteTrackingBase] ${base.base} refresh failed for ${repoPath}:`,
            err
          )
          return { ok: false, errorKind: 'git_error' }
        })
    }).finally(() => {
      this.fetchInflight.delete(key)
    })

    this.fetchInflight.set(key, promise)
    return promise
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
    let remotes: string[]
    try {
      const { stdout } = await gitExecFileAsync(['remote'], { cwd: repoPath, ...gitOptions })
      remotes = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return null
    }

    const remoteRefPrefix = 'refs/remotes/'
    const shortBaseBranch = baseBranch.startsWith(remoteRefPrefix)
      ? baseBranch.slice(remoteRefPrefix.length)
      : baseBranch
    const remote = remotes
      .filter((candidate) => shortBaseBranch.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (!remote) {
      return null
    }
    const branch = shortBaseBranch.slice(remote.length + 1)
    if (!branch) {
      return null
    }
    return {
      remote,
      branch,
      ref: `refs/remotes/${remote}/${branch}`,
      base: `${remote}/${branch}`
    }
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
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    let repo: Repo
    try {
      repo = await this.resolveRepoSelector(args.repoSelector)
    } catch {
      return { error: 'Repo not found' }
    }
    if (isFolderRepo(repo)) {
      return { error: 'Folder mode does not support creating worktrees.' }
    }
    const sshGitProvider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
    const localGitExecOptions = sshGitProvider
      ? undefined
      : getLocalProjectGitExecOptions(this.requireStore(), repo)
    const localWorktreeGitOptions = sshGitProvider
      ? {}
      : getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
    const gitExec = sshGitProvider
      ? (gitArgs: string[]) => sshGitProvider.exec(gitArgs, repo.path)
      : (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions ?? { cwd: repo.path })
    // Why: one resolver keeps source preference and hosting identity aligned
    // across local, WSL, and SSH worktree creation.
    const resolveRemote = (): Promise<string> =>
      resolveGitHubReviewHeadRemote({
        repoPath: repo.path,
        issueSourcePreference: repo.issueSourcePreference,
        connectionId: repo.connectionId ?? null,
        localGitOptions: localWorktreeGitOptions,
        gitExec
      })

    // Why: SSH review-head fetches require narrow write-capable RPCs.
    const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
      fetchPrHeadTrackingRef(
        repo,
        sshGitProvider,
        remote,
        branch,
        localGitExecOptions ? { localGitExecOptions } : {}
      )
    const fetchPullRequestHeadRef = (remote: string, prNumber: number): Promise<string> =>
      fetchGitHubPullRequestHeadRef(
        repo,
        sshGitProvider,
        remote,
        prNumber,
        localGitExecOptions ? { localGitExecOptions } : {}
      )

    return resolveGitHubPrStartPoint({
      repoPath: repo.path,
      prNumber: args.prNumber,
      headRefName: args.headRefName,
      baseRefName: args.baseRefName,
      isCrossRepository: args.isCrossRepository,
      issueSourcePreference: repo.issueSourcePreference,
      connectionId: repo.connectionId ?? null,
      localGitOptions: localWorktreeGitOptions,
      gitExec,
      fetchRemoteTrackingRef,
      fetchPullRequestHeadRef,
      resolveRemote
    })
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
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    let repo: Repo
    try {
      repo = await this.resolveRepoSelector(args.repoSelector)
    } catch {
      return { error: 'Repo not found' }
    }
    if (isFolderRepo(repo)) {
      return { error: 'Folder mode does not support creating worktrees.' }
    }
    const sshGitProvider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
    const localGitExecOptions = sshGitProvider
      ? undefined
      : getLocalProjectGitExecOptions(this.requireStore(), repo)
    const localWorktreeGitOptions = sshGitProvider
      ? {}
      : getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
    const gitExec = sshGitProvider
      ? (gitArgs: string[]) => sshGitProvider.exec(gitArgs, repo.path)
      : (gitArgs: string[]) => gitExecFileAsync(gitArgs, localGitExecOptions ?? { cwd: repo.path })

    let sourceBranch = args.sourceBranch?.trim() ?? ''
    let targetBranch = args.targetBranch?.trim() ?? ''
    let isCrossRepository = args.isCrossRepository === true

    if (!sourceBranch) {
      let remote: string
      try {
        remote = await this.resolveGitLabIssueSourceRemote(
          repo.path,
          repo.issueSourcePreference,
          repo.connectionId ?? null,
          localWorktreeGitOptions
        )
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
      }
      const knownHosts = await getGlabKnownHosts(repo.connectionId ?? null, localWorktreeGitOptions)
      const projectRef = await getGitLabProjectRefForRemote(
        repo.path,
        remote,
        knownHosts,
        repo.connectionId ?? null,
        localWorktreeGitOptions
      )
      if (!projectRef) {
        return { error: 'No GitLab project found for this repository.' }
      }
      const item = await getGitLabWorkItemByProjectRef(
        repo.path,
        projectRef,
        args.mrIid,
        'mr',
        repo.connectionId ?? null,
        localWorktreeGitOptions
      )
      if (!item || item.type !== 'mr') {
        return { error: `MR !${args.mrIid} not found.` }
      }
      sourceBranch = (item.branchName ?? '').trim()
      targetBranch = (item.baseRefName ?? '').trim()
      if (!sourceBranch) {
        return { error: `MR !${args.mrIid} has no source branch.` }
      }
      if (item.isCrossRepository === true) {
        isCrossRepository = true
      }
    }

    let remote: string
    try {
      remote = await this.resolveGitLabIssueSourceRemote(
        repo.path,
        repo.issueSourcePreference,
        repo.connectionId ?? null,
        localWorktreeGitOptions
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
    }
    const compareBaseRef = targetBranch ? `refs/remotes/${remote}/${targetBranch}` : undefined
    const fetchRemoteTrackingRef = async (branch: string, ref: string): Promise<void> => {
      await (sshGitProvider
        ? sshGitProvider.fetchRemoteTrackingRef(repo.path, remote, branch, ref)
        : gitExec(['fetch', remote, `+refs/heads/${branch}:${ref}`]))
    }
    // Why: the target/compare branch is optional (it only powers the diff
    // base). A merged MR may have had its target ref deleted, so a fetch
    // failure must NOT abort the whole resolution — that would discard the
    // already-verified source-branch base and silently fall back to the repo
    // default branch. Degrade gracefully by dropping compareBaseRef instead.
    const fetchCompareBaseRef = (): Promise<boolean> =>
      fetchCompareBaseRefWithLocalFallback({
        compareBaseRef,
        fetchCompareBaseRef: (ref) => fetchRemoteTrackingRef(targetBranch, ref),
        gitExec,
        logLabel: '[runtime:resolveManagedMrBase]',
        logContext: { remote, targetBranch, mrIid: args.mrIid }
      })

    if (isCrossRepository) {
      const mrRef = `refs/merge-requests/${args.mrIid}/head`
      // Why: soft-keep needs identity when the fetch throws before returning a path.
      // Success uses the path returned by the fetch itself (writer-authoritative).
      let softKeepLocalRefPromise: Promise<string | null> | undefined
      const resolveSoftKeepLocalRef = (): Promise<string | null> => {
        softKeepLocalRefPromise ??= (async () => {
          try {
            const { stdout } = await gitExec(['remote', 'get-url', remote])
            const remoteUrl = stdout.trim()
            if (!remoteUrl) {
              return null
            }
            return gitlabMergeRequestHeadLocalRef(
              reviewHeadRemoteRefComponent(remote, remoteUrl),
              args.mrIid
            )
          } catch {
            return null
          }
        })()
        return softKeepLocalRefPromise
      }
      const resolveDurableHeadSha = async (localRef: string | null): Promise<string | null> => {
        if (!localRef) {
          return null
        }
        try {
          const { stdout } = await gitExec(['rev-parse', '--verify', `${localRef}^{commit}`])
          return stdout.trim() || null
        } catch {
          return null
        }
      }
      try {
        const localRef = await fetchGitLabMergeRequestHeadRef(
          repo,
          sshGitProvider,
          remote,
          args.mrIid,
          localGitExecOptions ? { localGitExecOptions } : {}
        )
        const sha = await resolveDurableHeadSha(localRef)
        if (!sha) {
          return { error: `Could not resolve fork MR !${args.mrIid} head after fetch.` }
        }
        const compareBaseFetched = await fetchCompareBaseRef()
        return { baseBranch: sha, ...(compareBaseFetched ? { compareBaseRef } : {}) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Why: mirror compare-base — a transient transport failure must not fail
        // the resolve when a prior fetch already pinned the durable head ref. A
        // missing remote ref (deleted MR/fork), auth failure, or stale-relay
        // error must fail hard: serving the durable ref there would check out a
        // dead or unauthorized tip and mask the actionable error.
        if (isTransientReviewHeadFetchError(error)) {
          const localSha = await resolveDurableHeadSha(await resolveSoftKeepLocalRef())
          if (localSha) {
            console.warn(
              '[runtime:resolveManagedMrBase] MR head fetch failed; using durable local ref',
              {
                remote,
                mrIid: args.mrIid,
                error: message.split('\n')[0]
              }
            )
            const compareBaseFetched = await fetchCompareBaseRef()
            return { baseBranch: localSha, ...(compareBaseFetched ? { compareBaseRef } : {}) }
          }
        }
        return { error: `Failed to fetch ${mrRef}: ${message.split('\n')[0]}` }
      }
    }

    try {
      await fetchRemoteTrackingRef(sourceBranch, `refs/remotes/${remote}/${sourceBranch}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Failed to fetch ${remote}/${sourceBranch}: ${message.split('\n')[0]}` }
    }

    const remoteRef = `${remote}/${sourceBranch}`
    try {
      await gitExec(['rev-parse', '--verify', remoteRef])
    } catch {
      return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
    }
    const compareBaseFetched = await fetchCompareBaseRef()
    return {
      baseBranch: remoteRef,
      ...(compareBaseFetched ? { compareBaseRef } : {}),
      pushTarget: { remoteName: remote, branchName: sourceBranch }
    }
  }

  private async resolveGitLabIssueSourceRemote(
    repoPath: string,
    preference?: Repo['issueSourcePreference'],
    connectionId?: string | null,
    localGitOptions: { wslDistro?: string } = {}
  ): Promise<string> {
    const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
    const localGitOptionArgs =
      Object.keys(localGitOptions).length > 0 ? ([localGitOptions] as const) : []
    if (preference === 'origin') {
      const origin = await getGitLabProjectRefForRemote(
        repoPath,
        'origin',
        knownHosts,
        connectionId,
        ...localGitOptionArgs
      )
      if (origin) {
        return 'origin'
      }
      throw new Error('No GitLab project found for origin.')
    }
    if (preference === 'upstream') {
      const upstream = await getGitLabProjectRefForRemote(
        repoPath,
        'upstream',
        knownHosts,
        connectionId,
        ...localGitOptionArgs
      )
      if (upstream) {
        return 'upstream'
      }
      const origin = await getGitLabProjectRefForRemote(
        repoPath,
        'origin',
        knownHosts,
        connectionId,
        ...localGitOptionArgs
      )
      if (origin) {
        return 'origin'
      }
      throw new Error('No GitLab project found for upstream or origin.')
    }
    const upstream = await getGitLabProjectRefForRemote(
      repoPath,
      'upstream',
      knownHosts,
      connectionId,
      ...localGitOptionArgs
    )
    if (upstream) {
      return 'upstream'
    }
    const origin = await getGitLabProjectRefForRemote(
      repoPath,
      'origin',
      knownHosts,
      connectionId,
      ...localGitOptionArgs
    )
    if (origin) {
      return 'origin'
    }
    if (connectionId) {
      const provider = requireSshGitProvider(connectionId)
      const { stdout } = await provider.exec(['remote'], repoPath)
      return pickPreferredGitRemote(stdout.split('\n'))
    }
    return getDefaultRemote(repoPath, localGitOptions)
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
    return this.terminalClusterFacade.renameTerminal(handle, title)
  }

  private getAgentSessionExecutionNamespace(
    workspace: TerminalWorkspaceLaunchScope,
    agent: TuiAgent
  ): { machine: string; principal: string; container: string; providerRoot: string } | null {
    if (workspace.connectionId) {
      // Why: SSH target ids are not execution-namespace proof. Preserve the
      // legacy launch until an attested route can safely participate in claims.
      return null
    }
    const wsl = parseWslUncPath(workspace.path)
    const principal =
      typeof process.getuid === 'function'
        ? `uid:${process.getuid()}`
        : `user:${process.env.USERNAME ?? ''}`
    return {
      machine: wsl ? 'wsl-host' : `native:${process.platform}`,
      principal,
      container: wsl ? `wsl:${wsl.distro.toLocaleLowerCase('en-US')}` : 'native',
      // Why: merging account roots is conservative (it may conflict) and can
      // never permit two TUIs to own one provider session.
      providerRoot: `profile-default:${agent}`
    }
  }

  private async executionOwnerSupportsAgentSessionOperation(
    workspace: TerminalWorkspaceLaunchScope,
    operation: 'resume' | 'create',
    signal?: AbortSignal
  ): Promise<boolean> {
    const provider = workspace.connectionId
      ? this.getSshProviderFn?.(workspace.connectionId)
      : this.getLocalProvider()
    if (!provider) {
      // An unavailable route is not proof of an old owner; preserve the structured failure.
      return true
    }
    const probe =
      operation === 'resume'
        ? provider.supportsAgentSessionClaims
        : provider.supportsAgentSessionCreateOperations
    if (!probe) {
      // Local in-process PTYs need no wire negotiation; unknown SSH providers are legacy.
      return workspace.connectionId === null
    }
    try {
      return (await probe.call(provider, { signal })) === true
    } catch {
      // Why: this read-only check has not launched anything, so the old route remains safe.
      return false
    }
  }

  private toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined {
    return this.terminalClusterFacade.toAgentSessionOptions(preferences)
  }

  async ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    _caller: RuntimeAgentSessionRpcCaller = {},
    handoffAuthority?: { spawnToken: string; providerRoot: string; sessionId: string }
  ): Promise<RuntimeEnsureAgentSessionResult> {
    if (request.kind === 'automatic') {
      // Legacy renderer sleep records are migration evidence, not host authority.
      throw new Error('agent_session_resume_not_authorized')
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    const resolvedNamespace = this.getAgentSessionExecutionNamespace(workspace, request.agent)
    const namespace =
      resolvedNamespace && handoffAuthority
        ? { ...resolvedNamespace, providerRoot: handoffAuthority.providerRoot }
        : resolvedNamespace
    if (
      !namespace ||
      !(await this.executionOwnerSupportsAgentSessionOperation(workspace, 'resume', _caller.signal))
    ) {
      // Why: the renderer still holds the exact old request and may retry it before any side effect.
      throw new Error('agent_session_legacy_required')
    }
    // Why: nested SSH paths belong to the execution owner, so compatibility selection must happen before local filesystem canonicalization.
    const identity = canonicalizeAgentSessionIdentity(request.agent, request.providerSession)
    const claim = this.agentSessionClaimSigner.createClaim({
      namespace,
      identity,
      canonicalWorktreeId: workspace.id
    })
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before resuming.')
    }
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : Boolean(workspace.connectionId)
    const shell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const startup = buildAgentResumeStartupPlan({
      agent: request.agent,
      providerSession: identity.providerSession,
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs:
        request.agentArgs !== undefined
          ? request.agentArgs
          : resolveTuiAgentLaunchArgs(request.agent, settings.agentDefaultArgs),
      agentEnv: {
        ...resolveTuiAgentLaunchEnv(request.agent, settings.agentDefaultEnv),
        ...(handoffAuthority && request.agent === 'codex'
          ? { CODEX_HOME: handoffAuthority.providerRoot }
          : handoffAuthority && request.agent === 'claude'
            ? { CLAUDE_CONFIG_DIR: handoffAuthority.providerRoot }
            : {})
      },
      ompResumeFilePath: request.ompResumeFilePath,
      sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
      sessionOptionsOverrideAgentArgs: Boolean(request.launchPreferences),
      platform,
      shell,
      isRemote
    })
    if (!startup) {
      throw new Error('agent_session_identity_required')
    }
    await this.markWorkspaceTrustedForAgent(request.agent, workspace.connectionId, workspace.path)
    if (_caller.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const terminal = await this.createTerminal(`id:${workspace.id}`, {
      command: startup.launchCommand,
      env: startup.env,
      launchConfig: startup.launchConfig,
      launchAgent: request.agent,
      startupCommandDelivery: startup.startupCommandDelivery,
      presentation: request.presentation ?? 'background',
      tabId: request.placement?.tabId,
      leafId: request.placement?.leafId,
      agentSessionClaim: claim,
      ...(handoffAuthority
        ? {
            launchToken: handoffAuthority.spawnToken,
            structuredAgentSessionId: handoffAuthority.sessionId
          }
        : {}),
      signal: _caller.signal
    })
    return {
      terminal,
      disposition: terminal.agentSessionDisposition ?? 'created'
    }
  }

  async createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeCreateAgentSessionResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const now = Date.now()
    const operationTimestamp = parseAgentSessionOperationTimestamp(request.clientOperationId)
    if (
      operationTimestamp === null ||
      operationTimestamp > now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const callerKey = caller.clientId?.trim() || `trusted-local:${caller.clientKind ?? 'runtime'}`
    const operationKey = `${callerKey}\0${request.clientOperationId}`
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.worktree,
          request.agent,
          request.prompt ?? null,
          request.promptDelivery ?? null,
          request.agentArgs ?? null,
          request.agentArgs === undefined ? 'host-default' : 'client-override',
          request.launchPreferences?.model ?? null,
          request.launchPreferences?.effort ?? null,
          request.launchPreferences?.mode ?? null,
          request.startupCwd ?? null,
          request.presentation ?? null,
          request.placement?.tabId ?? null,
          request.placement?.leafId ?? null,
          request.viewMode ?? null
        ])
      )
      .digest('base64url')
    const existing = this.agentSessionCreateOperations.get(operationKey)
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new Error('agent_session_operation_conflict')
      }
      const replayed = await existing.promise
      return { ...replayed, disposition: 'replayed' }
    }
    if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      // Why: once a tombstone could have expired, an unseen replay must never
      // be reinterpreted as permission to start another fresh agent.
      throw new Error('agent_session_operation_expired')
    }
    let callerOperationCount = 0
    const callerPrefix = `${callerKey}\0`
    for (const key of this.agentSessionCreateOperations.keys()) {
      if (key.startsWith(callerPrefix)) {
        callerOperationCount += 1
      }
    }
    if (
      callerOperationCount >= AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT ||
      this.agentSessionCreateOperations.size >= AGENT_SESSION_OPERATION_GLOBAL_LIMIT
    ) {
      // Why: tombstones cannot be evicted early without making an old replay
      // capable of spawning again; reject new IDs until retained entries age out.
      throw new Error('agent_session_operation_capacity')
    }
    let retainReplayFence = false
    const operation = (async (): Promise<RuntimeCreateAgentSessionResult> => {
      // Why: reserve the client operation before any async preflight so concurrent retries cannot
      // both observe an empty ledger and reach the execution owner independently.
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
      if (
        !(await this.executionOwnerSupportsAgentSessionOperation(
          workspace,
          'create',
          caller.signal
        ))
      ) {
        // Why: the exact legacy launch remains client-owned until this pre-spawn check succeeds.
        throw new Error('agent_session_legacy_required')
      }
      const startupCwd = this.resolveWorkspaceTerminalStartupCwd(workspace, request.startupCwd)
      // Why: aliases and object property order are client syntax, not authority;
      // fingerprint the host-resolved fields in one fixed order.
      const resolvedFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            workspace.id,
            request.agent,
            request.prompt ?? null,
            request.promptDelivery ?? null,
            request.agentArgs ?? null,
            request.agentArgs === undefined ? 'host-default' : 'client-override',
            request.launchPreferences?.model ?? null,
            request.launchPreferences?.effort ?? null,
            request.launchPreferences?.mode ?? null,
            startupCwd ?? null,
            request.presentation ?? null,
            request.placement?.tabId ?? null,
            request.placement?.leafId ?? null,
            request.viewMode ?? null
          ])
        )
        .digest('base64url')
      const settings = this.store!.getSettings()
      if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
        throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
      }
      const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
      const isRemote = workspace.repo
        ? repoIsRemote(workspace.repo)
        : Boolean(workspace.connectionId)
      const shell = resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote,
        terminalWindowsShell: settings.terminalWindowsShell
      })
      const startupArgs = {
        agent: request.agent,
        cmdOverrides: settings.agentCmdOverrides ?? {},
        agentArgs:
          request.agentArgs !== undefined
            ? request.agentArgs
            : resolveTuiAgentLaunchArgs(request.agent, settings.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(request.agent, settings.agentDefaultEnv),
        sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
        platform,
        shell,
        isRemote
      }
      const startup =
        request.promptDelivery === 'draft'
          ? buildAgentDraftLaunchPlan({ ...startupArgs, draft: request.prompt ?? '' })
          : buildAgentStartupPlan({
              ...startupArgs,
              prompt: request.prompt ?? '',
              allowEmptyPromptLaunch: true
            })
      if (!startup) {
        throw new Error('agent_session_identity_required')
      }
      await this.markWorkspaceTrustedForAgent(request.agent, workspace.connectionId, workspace.path)
      if (caller.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      let terminal: RuntimeTerminalCreate
      const executionOperationId = createHash('sha256')
        .update(this.runtimeId)
        .update('\0')
        .update(operationKey)
        .update('\0')
        .update(resolvedFingerprint)
        .digest('base64url')
      const operationTabId =
        request.placement?.tabId ?? deterministicAgentSessionUuid(`${executionOperationId}:tab`)
      const operationLeafId =
        request.placement?.leafId ?? deterministicAgentSessionUuid(`${executionOperationId}:leaf`)
      const operationHandle = `term_${deterministicAgentSessionUuid(`${executionOperationId}:handle`)}`
      try {
        terminal = await this.createTerminal(`id:${workspace.id}`, {
          command: startup.launchCommand,
          env: startup.env,
          launchConfig: startup.launchConfig,
          launchAgent: request.agent,
          startupCommandDelivery: startup.startupCommandDelivery,
          cwd: startupCwd,
          presentation: request.presentation ?? 'background',
          tabId: operationTabId,
          leafId: operationLeafId,
          preAllocatedHandle: operationHandle,
          viewMode: request.viewMode,
          agentSessionCreateOperationId: executionOperationId,
          signal: caller.signal,
          onPtySpawnCommitted: () => {
            retainReplayFence = true
          }
        })
      } catch (error) {
        if (isAgentSessionOperationOutcomeUnknown(error)) {
          retainReplayFence = true
        }
        throw error
      }
      return { terminal, disposition: 'created' }
    })()
    this.agentSessionCreateOperations.set(operationKey, {
      fingerprint: requestFingerprint,
      promise: operation
    })
    const expireOperation = (): void => {
      const expiresAt = Math.max(now, operationTimestamp) + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
      const timer = setTimeout(
        () => {
          if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
            this.agentSessionCreateOperations.delete(operationKey)
          }
        },
        Math.max(1, expiresAt - Date.now())
      )
      timer.unref?.()
    }
    try {
      const result = await operation
      expireOperation()
      return result
    } catch (error) {
      if (retainReplayFence) {
        // Why: the first PTY may still be alive; replay the same failure until
        // expiry instead of interpreting a lost outcome as a fresh spawn grant.
        expireOperation()
      } else if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
        this.agentSessionCreateOperations.delete(operationKey)
      }
      throw error
    }
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
    return this.terminalClusterFacade.launchAgentTerminal(worktreeSelector, opts)
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

  private restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    return this.terminalClusterFacade.restoreLivePairedRendererSessionOwnedMobileTerminals(
      worktreeId,
      options
    )
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
    return await this.claudeAgentTeams.handleTmuxCompat(request, {
      splitTerminal: (handle, opts) => this.splitTerminal(handle, opts),
      readTerminal: (handle, opts) => this.readTerminal(handle, opts),
      sendTerminal: (handle, action) => this.sendTerminal(handle, action),
      focusTerminal: (handle) => this.focusTerminal(handle),
      closeTerminal: (handle) => this.closeTerminal(handle),
      showTerminal: (handle) => this.showTerminal(handle)
    })
  }

  async prepareClaudeAgentTeamsLeader(args: {
    paneKey: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    const handle = this.getTerminalHandleForPaneKey(args.paneKey)
    if (!handle) {
      throw new Error('claude_agent_teams_requires_orca_terminal')
    }
    return await this.prepareClaudeAgentTeamsLeaderForHandle({
      handle,
      baseEnv: args.baseEnv
    })
  }

  async prepareClaudeAgentTeamsLeaderForHandle(args: {
    handle: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    const baseEnv = {
      ...process.env,
      ...args.baseEnv
    }
    const shimDir = await ensureClaudeAgentTeamsShimDir()
    const shimBin = resolveClaudeAgentTeamsShimBin(baseEnv)
    return this.claudeAgentTeams.createLaunchEnv({
      leaderHandle: args.handle,
      baseEnv,
      shimDir,
      shimBin
    })
  }

  // Why: a leader handle that never binds to a PTY (lost pane race) has no exit
  // or close path to evict its team, so the abandoning caller must release it.
  releaseClaudeAgentTeamsLeaderForHandle(handle: string): void {
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
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
  buildMaterializedHeadlessParentLayout(...args: unknown[]) {
    return this.terminalClusterFacade.buildMaterializedHeadlessParentLayout(args)
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
    return this.terminalClusterFacade.resolveTerminalWorkspaceLaunchScope(selector)
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
    const childWorktreeId = child.id
    const parentWorktreeId = parent.id
    if (childWorktreeId === parentWorktreeId) {
      throw new RuntimeLineageError('LINEAGE_PARENT_CYCLE', 'A worktree cannot parent itself.')
    }
    if (!sharesResolvedWorktreeLineageBoundary(child, parent)) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Parent worktree must belong to the same repository, execution host, and project.'
      )
    }
    const instanceByWorktreeId = new Map(
      this.resolvedWorktreeCache
        .peekSnapshot()
        ?.worktrees.map((worktree) => [worktree.id, worktree.instanceId]) ?? [
        [child.id, child.instanceId],
        [parent.id, parent.instanceId]
      ]
    )
    let cursor: string | undefined = parentWorktreeId
    const visited = new Set<string>([childWorktreeId])
    while (cursor) {
      if (visited.has(cursor)) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CYCLE',
          'Parent selector would create a lineage cycle.'
        )
      }
      visited.add(cursor)
      const lineage = this.store?.getWorktreeLineage?.(cursor)
      if (!lineage) {
        break
      }
      const cursorInstanceId = instanceByWorktreeId.get(cursor)
      const parentInstanceId = instanceByWorktreeId.get(lineage.parentWorktreeId)
      if (
        cursorInstanceId !== lineage.worktreeInstanceId ||
        parentInstanceId !== lineage.parentWorktreeInstanceId
      ) {
        break
      }
      cursor = lineage.parentWorktreeId
    }
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
    // Why hooks here: an agent the USER started from a shell has no launch record, and on WSL the
    // Windows host reads its foreground process as `wsl.exe` rather than the agent inside the
    // distro. The hook is the only signal that survives both, because the agent reports itself.
    const hookRow = paneKey
      ? this.getHookAgentRowForPane(this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? [])
      : null
    const hookAgent = isTuiAgent(hookRow?.agentType) ? hookRow.agentType : null
    const agentIdentity = resolvePublishedPaneAgentIdentity({
      hookAgent,
      hookIsLive: hookRow?.agentIsLive,
      launchAgent,
      foregroundAgent,
      title
    })
    return agentIdentity ? { agentIdentity } : {}
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
    if (!worktreeId) {
      this.clientHostedBrowserRows.publishAll()
      for (const id of new Set([
        ...this.persistedClientHostedBrowserWorktreeIds,
        ...getRuntimeBrowserPageRegistry(this)
          .listPages()
          .map((page) => page.workspaceId)
      ])) {
        this.persistClientHostedBrowserPagesForWorktree(id)
      }
      this.notifyMobileSessionTabSnapshots()
      return
    }
    // Why: every client-page mutation — create, navigate, metadata, host quit, recovery — reaches
    // this announcement, so the host's own rows derive from it rather than from a second seam.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const hasClientBrowserPages =
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId).length > 0
    if (this.offscreenBrowserBackend || hasClientBrowserPages) {
      const reconciled = this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId,
        hasClientBrowserPages
          ? { allowAttachedWindow: true, onlyRuntimeOwnedTerminals: true }
          : undefined
      )
      // Why: hydrate already reconciles an existing snapshot in place; only reconcile here when it didn't (fresh build or early-returned hydrate).
      if (!reconciled.has(worktreeId)) {
        const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
        if (existing) {
          this.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
        }
      }
    }
    // Why: structural changes must propagate promptly; cancel any pending coalesced notify since this immediate emit supersedes it.
    this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.mobileSessionTabsChangeSequence)
  }

  private scheduleMobileSessionTabsChanged(worktreeId: string): void {
    return this.mobileSessionFacade.scheduleMobileSessionTabsChanged(worktreeId)
  }

  private cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    return this.mobileSessionFacade.cancelScheduledMobileSessionTabsChanged(worktreeId)
  }

  private notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    return this.mobileSessionFacade.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  private getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.terminalClusterFacade.getMobileSessionTabsForWorktree(
      worktreeId,
      clientNavigationId
    )
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

  private resolveHookLiveAgentRow(
    live: HookLiveAgentRow | null,
    pty: RuntimePtyWorktreeRecord | null,
    nonAgentTitle: boolean
  ): HookLiveAgentRow | null {
    return this.hookAgentRowResolutionCommands.resolveHookLiveAgentRow(live, pty, nonAgentTitle)
  }

  private getHookAgentRowForPane(rows: readonly AgentStatusIpcPayload[]): {
    providerSession: AgentProviderSessionMetadata | null
    providerSessionAgentType: string | null
    providerSessionReceivedAt: number | null
    agentType: string | null
    agentIsLive: boolean
    live: HookLiveAgentRow | null
  } {
    return this.hookAgentRowResolutionCommands.getHookAgentRowForPane(rows)
  }

  private findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    return this.terminalClusterFacade.findPtyForMobileTerminalTab(worktreeId, tab, options)
  }

  private getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    return this.terminalClusterFacade.getMobileTerminalPaneKey(tab)
  }

  // Why: group address resolution (Section 4.5) queries per-handle status and must not throw on stale handles; return null on any error.
  getAgentStatusForHandle(handle: string): string | null {
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      return this.getTerminalAgentStatusSnapshot(handle, ptyId).titleStatus
    } catch {
      return null
    }
  }

  getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return undefined
    }
    return this.getAgentStatusOrchestrationContextForHandle(handle)
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.terminalClusterFacade.getAgentStatusTerminalHandleForPaneKey(paneKey)
  }

  getAgentStatusLaunchConfigForPaneKey(
    paneKey: string,
    args?: { launchToken?: string }
  ): SleepingAgentLaunchConfig | undefined {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (!pty?.launchConfig) {
      return undefined
    }
    if (pty.launchToken === null || pty.launchToken !== args?.launchToken) {
      return undefined
    }
    return copySleepingAgentLaunchConfig(pty.launchConfig)
  }

  private buildAgentOrchestrationByPaneKey():
    | Record<string, AgentStatusOrchestrationContext>
    | undefined {
    return this.hookAgentRowResolutionCommands.buildAgentOrchestrationByPaneKey()
  }

  private getAgentStatusOrchestrationContextForHandle(
    handle: string,
    db = this.getOrchestrationDbIfAvailable()
  ): AgentStatusOrchestrationContext | undefined {
    return this.hookAgentRowResolutionCommands.getAgentStatusOrchestrationContextForHandle(
      handle,
      db
    )
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
    return this.terminalClusterFacade.isTerminalRunningAgent(handle, options)
  }

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    return this.terminalClusterFacade.isTerminalRunningSettledPromptAgent(handle)
  }

  private async isPtyRunningAgent(
    pty: RuntimePtyWorktreeRecord,
    leaf: RuntimeLeafRecord | null = null,
    options: { retryForegroundWrappers?: boolean } = {}
  ): Promise<boolean> {
    return this.ptyWorktrees.isPtyRunningAgent(pty, leaf, options)
  }

  private async isRecognizedForegroundAgentProcess(
    ptyId: string,
    foregroundProcess: string,
    options: { suppressClaude?: boolean; retryWrappers?: boolean } = {}
  ): Promise<boolean> {
    const initialRecognition = recognizeAgentProcess(foregroundProcess)
    if (initialRecognition !== null) {
      return !(
        options.suppressClaude === true &&
        isExpectedAgentProcess(initialRecognition.processName, 'claude')
      )
    }
    if (
      options.retryWrappers === false ||
      !this.isAgentWrapperForegroundProcess(foregroundProcess) ||
      !this.ptyController
    ) {
      return false
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < FOREGROUND_AGENT_WRAPPER_RETRY_TIMEOUT_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, FOREGROUND_AGENT_WRAPPER_RETRY_INTERVAL_MS)
      )
      const refreshedProcess = await this.ptyController.getForegroundProcess(ptyId)
      const refreshedRecognition = recognizeAgentProcess(refreshedProcess)
      if (refreshedRecognition !== null) {
        return !(
          options.suppressClaude === true &&
          isExpectedAgentProcess(refreshedRecognition.processName, 'claude')
        )
      }
      if (!refreshedProcess || !this.isAgentWrapperForegroundProcess(refreshedProcess)) {
        return false
      }
    }
    return false
  }

  private isAgentWrapperForegroundProcess(processName: string): boolean {
    // Why: daemon/SSH PTYs can report the interpreter before the async cmdline cache resolves; retry only known wrappers.
    return isAgentForegroundWrapperProcess(processName)
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

  // ── Linear integration ──
  linearConnect: RuntimeLinearCommands['linearConnect'] = this.linearCommands.linearConnect.bind(
    this.linearCommands
  )
  linearDisconnect: RuntimeLinearCommands['linearDisconnect'] =
    this.linearCommands.linearDisconnect.bind(this.linearCommands)
  linearSelectWorkspace: RuntimeLinearCommands['linearSelectWorkspace'] =
    this.linearCommands.linearSelectWorkspace.bind(this.linearCommands)
  linearStatus: RuntimeLinearCommands['linearStatus'] = this.linearCommands.linearStatus.bind(
    this.linearCommands
  )
  linearTestConnection: RuntimeLinearCommands['linearTestConnection'] =
    this.linearCommands.linearTestConnection.bind(this.linearCommands)
  linearSearchIssues: RuntimeLinearCommands['linearSearchIssues'] =
    this.linearCommands.linearSearchIssues.bind(this.linearCommands)
  linearSearchForAgents: RuntimeLinearCommands['linearSearchForAgents'] =
    this.linearCommands.linearSearchForAgents.bind(this.linearCommands)
  linearIssueContext: RuntimeLinearCommands['linearIssueContext'] =
    this.linearCommands.linearIssueContext.bind(this.linearCommands)
  linearTeamListForAgents: RuntimeLinearCommands['linearTeamListForAgents'] =
    this.linearCommands.linearTeamListForAgents.bind(this.linearCommands)
  linearTeamMembersForAgents: RuntimeLinearCommands['linearTeamMembersForAgents'] =
    this.linearCommands.linearTeamMembersForAgents.bind(this.linearCommands)
  linearTeamStatesForAgents: RuntimeLinearCommands['linearTeamStatesForAgents'] =
    this.linearCommands.linearTeamStatesForAgents.bind(this.linearCommands)
  linearTeamLabelsForAgents: RuntimeLinearCommands['linearTeamLabelsForAgents'] =
    this.linearCommands.linearTeamLabelsForAgents.bind(this.linearCommands)
  linearProjectListForAgents: RuntimeLinearCommands['linearProjectListForAgents'] =
    this.linearCommands.linearProjectListForAgents.bind(this.linearCommands)
  linearIssueListForAgents: RuntimeLinearCommands['linearIssueListForAgents'] =
    this.linearCommands.linearIssueListForAgents.bind(this.linearCommands)
  linearMcpIssueList: RuntimeLinearCommands['linearMcpIssueList'] =
    this.linearCommands.linearMcpIssueList.bind(this.linearCommands)
  linearResolveCurrentIssue: RuntimeLinearCommands['linearResolveCurrentIssue'] =
    this.linearCommands.linearResolveCurrentIssue.bind(this.linearCommands)
  linearListIssues: RuntimeLinearCommands['linearListIssues'] =
    this.linearCommands.linearListIssues.bind(this.linearCommands)
  linearCreateIssue: RuntimeLinearCommands['linearCreateIssue'] =
    this.linearCommands.linearCreateIssue.bind(this.linearCommands)
  linearGetIssue: RuntimeLinearCommands['linearGetIssue'] = this.linearCommands.linearGetIssue.bind(
    this.linearCommands
  )
  linearUpdateIssue: RuntimeLinearCommands['linearUpdateIssue'] =
    this.linearCommands.linearUpdateIssue.bind(this.linearCommands)
  linearAddIssueComment: RuntimeLinearCommands['linearAddIssueComment'] =
    this.linearCommands.linearAddIssueComment.bind(this.linearCommands)
  linearIssueSetState: RuntimeLinearCommands['linearIssueSetState'] =
    this.linearCommands.linearIssueSetState.bind(this.linearCommands)
  linearIssueRelationWrite: RuntimeLinearCommands['linearIssueRelationWrite'] =
    this.linearCommands.linearIssueRelationWrite.bind(this.linearCommands)
  linearSaveIssue: RuntimeLinearCommands['linearSaveIssue'] =
    this.linearCommands.linearSaveIssue.bind(this.linearCommands)
  linearIssueUpdateTask: RuntimeLinearCommands['linearIssueUpdateTask'] =
    this.linearCommands.linearIssueUpdateTask.bind(this.linearCommands)
  linearIssueAddComment: RuntimeLinearCommands['linearIssueAddComment'] =
    this.linearCommands.linearIssueAddComment.bind(this.linearCommands)
  linearIssueAttachLink: RuntimeLinearCommands['linearIssueAttachLink'] =
    this.linearCommands.linearIssueAttachLink.bind(this.linearCommands)
  linearIssueCreate: RuntimeLinearCommands['linearIssueCreate'] =
    this.linearCommands.linearIssueCreate.bind(this.linearCommands)
  linearIssueComments: RuntimeLinearCommands['linearIssueComments'] =
    this.linearCommands.linearIssueComments.bind(this.linearCommands)
  linearListTeams: RuntimeLinearCommands['linearListTeams'] =
    this.linearCommands.linearListTeams.bind(this.linearCommands)
  linearListProjects: RuntimeLinearCommands['linearListProjects'] =
    this.linearCommands.linearListProjects.bind(this.linearCommands)
  linearCreateProject: RuntimeLinearCommands['linearCreateProject'] =
    this.linearCommands.linearCreateProject.bind(this.linearCommands)
  linearGetProject: RuntimeLinearCommands['linearGetProject'] =
    this.linearCommands.linearGetProject.bind(this.linearCommands)
  linearListProjectIssues: RuntimeLinearCommands['linearListProjectIssues'] =
    this.linearCommands.linearListProjectIssues.bind(this.linearCommands)
  linearListCustomViews: RuntimeLinearCommands['linearListCustomViews'] =
    this.linearCommands.linearListCustomViews.bind(this.linearCommands)
  linearGetCustomView: RuntimeLinearCommands['linearGetCustomView'] =
    this.linearCommands.linearGetCustomView.bind(this.linearCommands)
  linearListCustomViewIssues: RuntimeLinearCommands['linearListCustomViewIssues'] =
    this.linearCommands.linearListCustomViewIssues.bind(this.linearCommands)
  linearListCustomViewProjects: RuntimeLinearCommands['linearListCustomViewProjects'] =
    this.linearCommands.linearListCustomViewProjects.bind(this.linearCommands)
  linearTeamStates: RuntimeLinearCommands['linearTeamStates'] =
    this.linearCommands.linearTeamStates.bind(this.linearCommands)
  linearTeamLabels: RuntimeLinearCommands['linearTeamLabels'] =
    this.linearCommands.linearTeamLabels.bind(this.linearCommands)
  linearTeamMembers: RuntimeLinearCommands['linearTeamMembers'] =
    this.linearCommands.linearTeamMembers.bind(this.linearCommands)
  jiraConnect: RuntimeLinearCommands['jiraConnect'] = this.linearCommands.jiraConnect.bind(
    this.linearCommands
  )
  jiraDisconnect: RuntimeLinearCommands['jiraDisconnect'] = this.linearCommands.jiraDisconnect.bind(
    this.linearCommands
  )
  jiraSelectSite: RuntimeLinearCommands['jiraSelectSite'] = this.linearCommands.jiraSelectSite.bind(
    this.linearCommands
  )
  jiraStatus: RuntimeLinearCommands['jiraStatus'] = this.linearCommands.jiraStatus.bind(
    this.linearCommands
  )
  jiraReadStatus: RuntimeLinearCommands['jiraReadStatus'] = this.linearCommands.jiraReadStatus.bind(
    this.linearCommands
  )
  jiraTestConnection: RuntimeLinearCommands['jiraTestConnection'] =
    this.linearCommands.jiraTestConnection.bind(this.linearCommands)
  jiraSearchIssues: RuntimeLinearCommands['jiraSearchIssues'] =
    this.linearCommands.jiraSearchIssues.bind(this.linearCommands)
  jiraListIssues: RuntimeLinearCommands['jiraListIssues'] = this.linearCommands.jiraListIssues.bind(
    this.linearCommands
  )
  jiraCreateIssue: RuntimeLinearCommands['jiraCreateIssue'] =
    this.linearCommands.jiraCreateIssue.bind(this.linearCommands)
  jiraGetIssue: RuntimeLinearCommands['jiraGetIssue'] = this.linearCommands.jiraGetIssue.bind(
    this.linearCommands
  )
  jiraLookupIssueSummary: RuntimeLinearCommands['jiraLookupIssueSummary'] =
    this.linearCommands.jiraLookupIssueSummary.bind(this.linearCommands)
  jiraUpdateIssue: RuntimeLinearCommands['jiraUpdateIssue'] =
    this.linearCommands.jiraUpdateIssue.bind(this.linearCommands)
  jiraAddIssueComment: RuntimeLinearCommands['jiraAddIssueComment'] =
    this.linearCommands.jiraAddIssueComment.bind(this.linearCommands)
  jiraIssueComments: RuntimeLinearCommands['jiraIssueComments'] =
    this.linearCommands.jiraIssueComments.bind(this.linearCommands)
  jiraListProjects: RuntimeLinearCommands['jiraListProjects'] =
    this.linearCommands.jiraListProjects.bind(this.linearCommands)
  jiraListIssueTypes: RuntimeLinearCommands['jiraListIssueTypes'] =
    this.linearCommands.jiraListIssueTypes.bind(this.linearCommands)
  jiraListCreateFields: RuntimeLinearCommands['jiraListCreateFields'] =
    this.linearCommands.jiraListCreateFields.bind(this.linearCommands)
  jiraListPriorities: RuntimeLinearCommands['jiraListPriorities'] =
    this.linearCommands.jiraListPriorities.bind(this.linearCommands)
  jiraListAssignableUsers: RuntimeLinearCommands['jiraListAssignableUsers'] =
    this.linearCommands.jiraListAssignableUsers.bind(this.linearCommands)
  jiraListTransitions: RuntimeLinearCommands['jiraListTransitions'] =
    this.linearCommands.jiraListTransitions.bind(this.linearCommands)
  jiraGetProjectStatusOrder: RuntimeLinearCommands['jiraGetProjectStatusOrder'] =
    this.linearCommands.jiraGetProjectStatusOrder.bind(this.linearCommands)

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

  browserSnapshot: RuntimeBrowserCommands['browserSnapshot'] =
    this.browserScreencastCommands.browserSnapshot.bind(this.browserScreencastCommands)

  browserClick: RuntimeBrowserCommands['browserClick'] =
    this.browserScreencastCommands.browserClick.bind(this.browserScreencastCommands)

  browserGoto: RuntimeBrowserCommands['browserGoto'] =
    this.browserScreencastCommands.browserGoto.bind(this.browserScreencastCommands)

  browserFill: RuntimeBrowserCommands['browserFill'] =
    this.browserScreencastCommands.browserFill.bind(this.browserScreencastCommands)

  browserType: RuntimeBrowserCommands['browserType'] =
    this.browserScreencastCommands.browserType.bind(this.browserScreencastCommands)

  browserSelect: RuntimeBrowserCommands['browserSelect'] =
    this.browserScreencastCommands.browserSelect.bind(this.browserScreencastCommands)

  browserScroll: RuntimeBrowserCommands['browserScroll'] =
    this.browserScreencastCommands.browserScroll.bind(this.browserScreencastCommands)

  browserBack: RuntimeBrowserCommands['browserBack'] =
    this.browserScreencastCommands.browserBack.bind(this.browserScreencastCommands)

  browserReload: RuntimeBrowserCommands['browserReload'] =
    this.browserScreencastCommands.browserReload.bind(this.browserScreencastCommands)

  browserScreenshot: RuntimeBrowserCommands['browserScreenshot'] =
    this.browserScreencastCommands.browserScreenshot.bind(this.browserScreencastCommands)

  browserScreencast: RuntimeBrowserCommands['browserScreencast'] =
    this.browserScreencastCommands.browserScreencast.bind(this.browserScreencastCommands)

  browserEval: RuntimeBrowserCommands['browserEval'] =
    this.browserScreencastCommands.browserEval.bind(this.browserCommands)

  browserTabList: RuntimeBrowserCommands['browserTabList'] =
    this.browserScreencastCommands.browserTabList.bind(this.browserCommands)
  browserProceedCertificate: RuntimeBrowserCommands['browserProceedCertificate'] =
    this.browserScreencastCommands.browserProceedCertificate.bind(this.browserCommands)

  browserTabShow: RuntimeBrowserCommands['browserTabShow'] =
    this.browserScreencastCommands.browserTabShow.bind(this.browserCommands)

  browserTabCurrent: RuntimeBrowserCommands['browserTabCurrent'] =
    this.browserScreencastCommands.browserTabCurrent.bind(this.browserCommands)

  browserTabSwitch: RuntimeBrowserCommands['browserTabSwitch'] =
    this.browserScreencastCommands.browserTabSwitch.bind(this.browserCommands)

  browserHover: RuntimeBrowserCommands['browserHover'] =
    this.browserScreencastCommands.browserHover.bind(this.browserCommands)

  browserDrag: RuntimeBrowserCommands['browserDrag'] =
    this.browserScreencastCommands.browserDrag.bind(this.browserCommands)

  browserUpload: RuntimeBrowserCommands['browserUpload'] =
    this.browserScreencastCommands.browserUpload.bind(this.browserCommands)

  browserWait: RuntimeBrowserCommands['browserWait'] =
    this.browserScreencastCommands.browserWait.bind(this.browserCommands)

  browserCheck: RuntimeBrowserCommands['browserCheck'] =
    this.browserScreencastCommands.browserCheck.bind(this.browserCommands)

  browserFocus: RuntimeBrowserCommands['browserFocus'] =
    this.browserScreencastCommands.browserFocus.bind(this.browserCommands)

  browserClear: RuntimeBrowserCommands['browserClear'] =
    this.browserScreencastCommands.browserClear.bind(this.browserCommands)

  browserSelectAll: RuntimeBrowserCommands['browserSelectAll'] =
    this.browserScreencastCommands.browserSelectAll.bind(this.browserCommands)

  browserKeypress: RuntimeBrowserCommands['browserKeypress'] =
    this.browserScreencastCommands.browserKeypress.bind(this.browserCommands)

  browserPdf: RuntimeBrowserCommands['browserPdf'] = this.browserScreencastCommands.browserPdf.bind(
    this.browserCommands
  )

  browserFullScreenshot: RuntimeBrowserCommands['browserFullScreenshot'] =
    this.browserScreencastCommands.browserFullScreenshot.bind(this.browserCommands)

  browserCookieGet: RuntimeBrowserCommands['browserCookieGet'] =
    this.browserScreencastCommands.browserCookieGet.bind(this.browserCommands)

  browserCookieSet: RuntimeBrowserCommands['browserCookieSet'] =
    this.browserScreencastCommands.browserCookieSet.bind(this.browserCommands)

  browserCookieDelete: RuntimeBrowserCommands['browserCookieDelete'] =
    this.browserScreencastCommands.browserCookieDelete.bind(this.browserCommands)

  browserSetViewport: RuntimeBrowserCommands['browserSetViewport'] =
    this.browserScreencastCommands.browserSetViewport.bind(this.browserCommands)

  browserSetGeolocation: RuntimeBrowserCommands['browserSetGeolocation'] =
    this.browserScreencastCommands.browserSetGeolocation.bind(this.browserCommands)

  browserInterceptEnable: RuntimeBrowserCommands['browserInterceptEnable'] =
    this.browserScreencastCommands.browserInterceptEnable.bind(this.browserCommands)

  browserInterceptDisable: RuntimeBrowserCommands['browserInterceptDisable'] =
    this.browserScreencastCommands.browserInterceptDisable.bind(this.browserCommands)

  browserInterceptList: RuntimeBrowserCommands['browserInterceptList'] =
    this.browserScreencastCommands.browserInterceptList.bind(this.browserCommands)

  browserCaptureStart: RuntimeBrowserCommands['browserCaptureStart'] =
    this.browserScreencastCommands.browserCaptureStart.bind(this.browserCommands)

  browserCaptureStop: RuntimeBrowserCommands['browserCaptureStop'] =
    this.browserScreencastCommands.browserCaptureStop.bind(this.browserCommands)

  browserConsoleLog: RuntimeBrowserCommands['browserConsoleLog'] =
    this.browserScreencastCommands.browserConsoleLog.bind(this.browserCommands)

  browserNetworkLog: RuntimeBrowserCommands['browserNetworkLog'] =
    this.browserScreencastCommands.browserNetworkLog.bind(this.browserCommands)

  browserDblclick: RuntimeBrowserCommands['browserDblclick'] =
    this.browserScreencastCommands.browserDblclick.bind(this.browserCommands)

  browserForward: RuntimeBrowserCommands['browserForward'] =
    this.browserScreencastCommands.browserForward.bind(this.browserCommands)

  browserScrollIntoView: RuntimeBrowserCommands['browserScrollIntoView'] =
    this.browserScreencastCommands.browserScrollIntoView.bind(this.browserCommands)

  browserGet: RuntimeBrowserCommands['browserGet'] = this.browserScreencastCommands.browserGet.bind(
    this.browserCommands
  )

  browserIs: RuntimeBrowserCommands['browserIs'] = this.browserScreencastCommands.browserIs.bind(
    this.browserCommands
  )

  browserKeyboardInsertText: RuntimeBrowserCommands['browserKeyboardInsertText'] =
    this.browserScreencastCommands.browserKeyboardInsertText.bind(this.browserCommands)

  browserMouseMove: RuntimeBrowserCommands['browserMouseMove'] =
    this.browserScreencastCommands.browserMouseMove.bind(this.browserCommands)

  browserMouseDown: RuntimeBrowserCommands['browserMouseDown'] =
    this.browserScreencastCommands.browserMouseDown.bind(this.browserCommands)

  browserMouseClick: RuntimeBrowserCommands['browserMouseClick'] =
    this.browserScreencastCommands.browserMouseClick.bind(this.browserCommands)

  browserMouseUp: RuntimeBrowserCommands['browserMouseUp'] =
    this.browserScreencastCommands.browserMouseUp.bind(this.browserCommands)

  browserMouseWheel: RuntimeBrowserCommands['browserMouseWheel'] =
    this.browserScreencastCommands.browserMouseWheel.bind(this.browserCommands)

  browserFind: RuntimeBrowserCommands['browserFind'] =
    this.browserScreencastCommands.browserFind.bind(this.browserCommands)

  browserSetDevice: RuntimeBrowserCommands['browserSetDevice'] =
    this.browserScreencastCommands.browserSetDevice.bind(this.browserCommands)

  browserSetOffline: RuntimeBrowserCommands['browserSetOffline'] =
    this.browserScreencastCommands.browserSetOffline.bind(this.browserCommands)

  browserSetHeaders: RuntimeBrowserCommands['browserSetHeaders'] =
    this.browserScreencastCommands.browserSetHeaders.bind(this.browserCommands)

  browserSetCredentials: RuntimeBrowserCommands['browserSetCredentials'] =
    this.browserScreencastCommands.browserSetCredentials.bind(this.browserCommands)

  browserSetMedia: RuntimeBrowserCommands['browserSetMedia'] =
    this.browserScreencastCommands.browserSetMedia.bind(this.browserCommands)

  browserClipboardRead: RuntimeBrowserCommands['browserClipboardRead'] =
    this.browserScreencastCommands.browserClipboardRead.bind(this.browserCommands)

  browserClipboardWrite: RuntimeBrowserCommands['browserClipboardWrite'] =
    this.browserScreencastCommands.browserClipboardWrite.bind(this.browserCommands)

  browserDialogAccept: RuntimeBrowserCommands['browserDialogAccept'] =
    this.browserScreencastCommands.browserDialogAccept.bind(this.browserCommands)

  browserDialogDismiss: RuntimeBrowserCommands['browserDialogDismiss'] =
    this.browserScreencastCommands.browserDialogDismiss.bind(this.browserCommands)

  browserStorageLocalGet: RuntimeBrowserCommands['browserStorageLocalGet'] =
    this.browserScreencastCommands.browserStorageLocalGet.bind(this.browserCommands)

  browserStorageLocalSet: RuntimeBrowserCommands['browserStorageLocalSet'] =
    this.browserScreencastCommands.browserStorageLocalSet.bind(this.browserCommands)

  browserStorageLocalClear: RuntimeBrowserCommands['browserStorageLocalClear'] =
    this.browserScreencastCommands.browserStorageLocalClear.bind(this.browserCommands)

  browserStorageSessionGet: RuntimeBrowserCommands['browserStorageSessionGet'] =
    this.browserScreencastCommands.browserStorageSessionGet.bind(this.browserCommands)

  browserStorageSessionSet: RuntimeBrowserCommands['browserStorageSessionSet'] =
    this.browserScreencastCommands.browserStorageSessionSet.bind(this.browserCommands)

  browserStorageSessionClear: RuntimeBrowserCommands['browserStorageSessionClear'] =
    this.browserScreencastCommands.browserStorageSessionClear.bind(this.browserCommands)

  browserDownload: RuntimeBrowserCommands['browserDownload'] =
    this.browserScreencastCommands.browserDownload.bind(this.browserCommands)

  browserHighlight: RuntimeBrowserCommands['browserHighlight'] =
    this.browserScreencastCommands.browserHighlight.bind(this.browserCommands)

  browserExec: RuntimeBrowserCommands['browserExec'] =
    this.browserScreencastCommands.browserExec.bind(this.browserCommands)

  browserTabCreate: RuntimeBrowserCommands['browserTabCreate'] =
    this.browserScreencastCommands.browserTabCreate.bind(this.browserCommands)

  browserTabSetProfile: RuntimeBrowserCommands['browserTabSetProfile'] =
    this.browserScreencastCommands.browserTabSetProfile.bind(this.browserCommands)

  browserTabProfileShow: RuntimeBrowserCommands['browserTabProfileShow'] =
    this.browserScreencastCommands.browserTabProfileShow.bind(this.browserCommands)

  browserTabProfileClone: RuntimeBrowserCommands['browserTabProfileClone'] =
    this.browserScreencastCommands.browserTabProfileClone.bind(this.browserCommands)

  browserProfileList: RuntimeBrowserCommands['browserProfileList'] =
    this.browserScreencastCommands.browserProfileList.bind(this.browserCommands)

  browserProfileCreate: RuntimeBrowserCommands['browserProfileCreate'] =
    this.browserScreencastCommands.browserProfileCreate.bind(this.browserCommands)

  browserProfileDelete: RuntimeBrowserCommands['browserProfileDelete'] =
    this.browserScreencastCommands.browserProfileDelete.bind(this.browserCommands)

  browserProfileDetectBrowsers: RuntimeBrowserCommands['browserProfileDetectBrowsers'] =
    this.browserScreencastCommands.browserProfileDetectBrowsers.bind(this.browserCommands)

  browserProfileImportFromBrowser: RuntimeBrowserCommands['browserProfileImportFromBrowser'] =
    this.browserScreencastCommands.browserProfileImportFromBrowser.bind(this.browserCommands)

  browserProfileClearDefaultCookies: RuntimeBrowserCommands['browserProfileClearDefaultCookies'] =
    this.browserScreencastCommands.browserProfileClearDefaultCookies.bind(this.browserCommands)

  browserTabClose: RuntimeBrowserCommands['browserTabClose'] =
    this.browserScreencastCommands.browserTabClose.bind(this.browserCommands)

  // Emulator bindings (delegated to dedicated commands for surface separation).
  emulatorTap: RuntimeEmulatorCommands['emulatorTap'] = this.emulatorCommands.emulatorTap.bind(
    this.emulatorCommands
  )
  emulatorGesture: RuntimeEmulatorCommands['emulatorGesture'] =
    this.emulatorCommands.emulatorGesture.bind(this.emulatorCommands)
  emulatorType: RuntimeEmulatorCommands['emulatorType'] = this.emulatorCommands.emulatorType.bind(
    this.emulatorCommands
  )
  emulatorButton: RuntimeEmulatorCommands['emulatorButton'] =
    this.emulatorCommands.emulatorButton.bind(this.emulatorCommands)
  emulatorRotate: RuntimeEmulatorCommands['emulatorRotate'] =
    this.emulatorCommands.emulatorRotate.bind(this.emulatorCommands)
  emulatorExec: RuntimeEmulatorCommands['emulatorExec'] = this.emulatorCommands.emulatorExec.bind(
    this.emulatorCommands
  )
  emulatorAttach: RuntimeEmulatorCommands['emulatorAttach'] =
    this.emulatorCommands.emulatorAttach.bind(this.emulatorCommands)
  emulatorList: RuntimeEmulatorCommands['emulatorList'] = this.emulatorCommands.emulatorList.bind(
    this.emulatorCommands
  )
  emulatorKill: RuntimeEmulatorCommands['emulatorKill'] = this.emulatorCommands.emulatorKill.bind(
    this.emulatorCommands
  )
  emulatorShutdown: RuntimeEmulatorCommands['emulatorShutdown'] =
    this.emulatorCommands.emulatorShutdown.bind(this.emulatorCommands)
  emulatorListSimulators: RuntimeEmulatorCommands['emulatorListSimulators'] =
    this.emulatorCommands.emulatorListSimulators.bind(this.emulatorCommands)
  emulatorAvailability: RuntimeEmulatorCommands['emulatorAvailability'] =
    this.emulatorCommands.emulatorAvailability.bind(this.emulatorCommands)
  emulatorListDevices: RuntimeEmulatorCommands['emulatorListDevices'] =
    this.emulatorCommands.emulatorListDevices.bind(this.emulatorCommands)
  emulatorInstall: RuntimeEmulatorCommands['emulatorInstall'] =
    this.emulatorCommands.emulatorInstall.bind(this.emulatorCommands)
  emulatorLaunch: RuntimeEmulatorCommands['emulatorLaunch'] =
    this.emulatorCommands.emulatorLaunch.bind(this.emulatorCommands)
  emulatorPermissions: RuntimeEmulatorCommands['emulatorPermissions'] =
    this.emulatorCommands.emulatorPermissions.bind(this.emulatorCommands)
  emulatorAx: RuntimeEmulatorCommands['emulatorAx'] = this.emulatorCommands.emulatorAx.bind(
    this.emulatorCommands
  )
  emulatorLogcat: RuntimeEmulatorCommands['emulatorLogcat'] =
    this.emulatorCommands.emulatorLogcat.bind(this.emulatorCommands)
  emulatorUnregisterActive: RuntimeEmulatorCommands['emulatorUnregisterActive'] =
    this.emulatorCommands.emulatorUnregisterActive.bind(this.emulatorCommands)

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

  headlessMobileSnapshotContentUnchanged() {
    return this.terminalClusterFacade.headlessMobileSnapshotContentUnchanged()
  }

  mobileSnapshotValueEqual() {
    return this.mobileSessionFacade.mobileSnapshotValueEqual()
  }

  reconcileHeadlessMobileSessionBrowserTabs() {
    return this.terminalClusterFacade.reconcileHeadlessMobileSessionBrowserTabs()
  }

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

  isServeOrSshOwnedPtyId(ptyId: string | null | undefined) {
    return this.ptyWorktrees.isServeOrSshOwnedPtyId(ptyId)
  }

  hasServeOrSshOwnedBinding(tab: unknown) {
    return (this.snapshotValueComparison as any).hasServeOrSshOwnedBinding(tab)
  }

  hasLiveOrPersistedServeOrSshOwnedPtyBinding(worktreeId: string, tab: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic forward
    return (this as any).hasLiveOrPersistedServeOrSshOwnedPtyBinding(worktreeId, tab)
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
    return this.mobileSessionFacade.clearRuntimeSessionOwnershipForMobileTab(
      worktreeId,
      snapshot,
      parentTabId
    )
  }

  getMobileTerminalLeafPtyIds() {
    return this.terminalClusterFacade.getMobileTerminalLeafPtyIds()
  }

  clearRuntimeSessionOwnershipForMobileTerminalLeaf() {
    return this.terminalClusterFacade.clearRuntimeSessionOwnershipForMobileTerminalLeaf()
  }

  persistedParentStillBindsMobileTerminalLeaf() {
    return this.terminalClusterFacade.persistedParentStillBindsMobileTerminalLeaf()
  }

  releaseRuntimeSessionOwnershipForRendererRetiredTabs(snapshot: unknown, existing: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic forward
    return (this as any).releaseRuntimeSessionOwnershipForRendererRetiredTabs(snapshot, existing)
  }

  isRuntimeOwnedHeadlessMobileTab() {
    return this.terminalClusterFacade.isRuntimeOwnedHeadlessMobileTab()
  }

  mergeMobileSessionSnapshotTabs() {
    return this.mobileSessionFacade.mergeMobileSessionSnapshotTabs()
  }

  mergeMobileSessionTabGroups() {
    return this.mobileSessionFacade.mergeMobileSessionTabGroups()
  }

  // Delegation methods for RuntimeMobileSnapshotMergeCommands:

  mergePreservedHeadlessMobileSessionTabs() {
    return this.terminalClusterFacade.mergePreservedHeadlessMobileSessionTabs()
  }

  buildPreservedHeadlessMobileSessionSnapshot() {
    return this.terminalClusterFacade.buildPreservedHeadlessMobileSessionSnapshot()
  }

  storedMobileSnapshotHasStalePreservedTab() {
    return this.mobileSessionFacade.storedMobileSnapshotHasStalePreservedTab()
  }

  notifyMobileSessionTabSnapshots() {
    return this.mobileSessionFacade.notifyMobileSessionTabSnapshots()
  }

  emitMobileSessionTabsSnapshotToClient() {
    return this.mobileSessionFacade.emitMobileSessionTabsSnapshotToClient()
  }

  // Delegation methods for RuntimeMobileSessionTabSnapshotCommands:

  touchMobileSessionSnapshotsForPty(ptyId: string, options?: { immediate?: boolean }): void {
    return this.terminalClusterFacade.touchMobileSessionSnapshotsForPty(ptyId, options)
  }

  getMobileSessionWorktreeIdsForPty() {
    return this.mobileSessionFacade.getMobileSessionWorktreeIdsForPty()
  }

  touchMobileSessionTabsForWorktree(worktreeId: string, options?: { immediate?: boolean }) {
    return this.mobileSessionFacade.touchMobileSessionTabsForWorktree(worktreeId, options)
  }

  touchMobileSessionTabsForPane() {
    return this.mobileSessionFacade.touchMobileSessionTabsForPane()
  }

  buildHeadlessMobileSessionTerminalTabs() {
    return this.terminalClusterFacade.buildHeadlessMobileSessionTerminalTabs()
  }

  buildHeadlessMobileSessionBrowserTabs() {
    return this.terminalClusterFacade.buildHeadlessMobileSessionBrowserTabs()
  }

  buildHeadlessMobileSessionTabGroups() {
    return this.terminalClusterFacade.buildHeadlessMobileSessionTabGroups()
  }

  removePersistedHeadlessTerminalTab(
    worktreeId: string,
    parentTabId: string,
    options?: { allowMissing?: boolean }
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variadic forward
    return (this as any).removePersistedHeadlessTerminalTab(worktreeId, parentTabId, options)
  }

  persistHeadlessTerminalTabOrder(worktreeId: string, tabOrder: string[]) {
    return this.terminalClusterFacade.persistHeadlessTerminalTabOrder(worktreeId, tabOrder)
  }

  emitMobileSessionTabsSnapshot(snapshot: unknown) {
    return (this.mobileTabSnapshots as any).emitMobileSessionTabsSnapshot(snapshot)
  }

  projectMobileSessionTabsForClient(result: unknown, clientNavigationId?: string) {
    return (this.mobileTabSnapshots as any).projectMobileSessionTabsForClient(
      result,
      clientNavigationId
    )
  }

  withClientHostedPagesHold(snapshot: unknown, clientNavigationId?: string) {
    return (this.mobileTabSnapshots as any).withClientHostedPagesHold(snapshot, clientNavigationId)
  }

  private getHeadlessMobileSessionGroupId() {
    return this.terminalClusterFacade.getHeadlessMobileSessionGroupId()
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
  REMOTE_FETCH_TIMEOUT_MS,
  WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS,
  WAIT_BLOCKED_KEYWORD_CARRY_CHARS,
  WAIT_BLOCKED_KEYWORD_PATTERN,
  addRuntimeWorkingTerminalEvidence,
  buildRuntimeWorktreeSummaryPathIndex,
  buildTerminalWaitText,
  classifyAgentTitle,
  compareWorktreePs,
  computeTerminalTailWaitState,
  detectTerminalWaitBlockedReason,
  findLastCompleteOscTitleRange,
  getLatestAgentCandidateTitle,
  getLatestPtyTitle,
  getLeafWorktreeStatus,
  getSavedTabWorktreeStatus,
  isKnownReadyPromptPreview,
  isTerminalSendSettlementAgent,
  maxTimestamp,
  mergeWorktreeSummaryStatus,
  notifyRuntimeListeners,
  resolveTerminalSessionWorktreeId,
  runtimePathsEqual,
  runtimeWorkingTerminalEvidenceMatchesSource,
  runtimeWorktreeIdsEqual,
  setBoundedMapEntry,
  tailGainedNewerBlockedReason,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-tail-projection'
import { RuntimeResolvedWorktreeCache } from './runtime-resolved-worktree-cache'
import { RuntimeManagedWorktrees } from './runtime-managed-worktrees'
import { RuntimePtyWorktrees } from './runtime-pty-worktrees'
import { RuntimeMobileSessionFacade } from './runtime-mobile-session-facade'
import { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'
import type {
  RetainedTailRedrawCursor,
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
