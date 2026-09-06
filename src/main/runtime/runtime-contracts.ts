/* eslint-disable max-lines -- Why: contracts module consolidates shared runtime types; state-owner extraction needed before enforcing max-lines. */
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { AgentStatus } from '../../shared/agent-detection'
import type { AutomationWorkspaceMode } from '../../shared/automations-types'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { OrchestrationCompatibilityHostStamp } from '../../shared/orchestration-compatibility-evidence'
import type { PtyBindingSourceExpectation } from '../persistence/loading-store/store'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { PtyProcessInfo, PtyProviderBufferSnapshot, PtySpawnResult } from '../providers/types'
import type { RetainedTailRedrawCursor, TerminalTailWaitState } from './runtime-tail-projection'
import type { RuntimeBrowserCommands } from './orca-runtime-browser'
import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'
import type { RuntimeFileCommands } from './orca-runtime-files'
import type { RuntimeGitCommands } from './orca-runtime-git'
import type { RuntimeLinearCommands } from './runtime-linear-commands'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionFacade } from './runtime-mobile-session-facade'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeSyncedLeaf
} from '../../shared/runtime-session-contracts'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-terminal-contracts'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { TerminalRevealIdentity } from '../../shared/terminal-reveal-identity'
import type { WorkerTerminalHostScope } from './orchestration/worker-terminal-process-liveness'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import type { WorktreeRemoteBranchConflictEvent } from '../../shared/worktree/base-ref-drift-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { hasCommitObjectViaGitExec } from '../git/commit-object-ref'
import { hasWorktreeBaseCommitRef } from '../git/worktree-base-ref-probe'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'
import { gitExecFileAsync } from '../git/runner'
import { randomUUID } from 'node:crypto'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AutomationCreateInput, AutomationUpdateInput } from '../../shared/automations-types'
import type { AutomationDestination } from '../../shared/automation-owner-precondition'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeLineage, WorktreeLineageWarning } from '../../shared/worktree/lineage-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { OrchestrationMessageWaiter } from './orchestration/mailbox-pointer-delivery'
import type {
  RuntimeTerminalDriverState,
  RuntimeNativeChatLaunchDraftResolution
} from '../../shared/runtime-session-contracts'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-terminal-contracts'
import type { VoiceSettings } from '../../shared/speech-types'
import type { RuntimeEmulatorCommands } from './orca-runtime-emulator'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { getRepoExecutionHostId } from '../../shared/execution-host'

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

export type RuntimeWorktreeAgentSource = {
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

/** A hook row narrowed to what `session.tabs` publishes, shaped like the retained OSC
 *  snapshot so one projection branch can consume either carrier. */
export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  'payload' | 'updatedAt' | 'stateStartedAt' | 'worktreeId'
>

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

// Orphaned verdicts are bounded; active PTYs retain theirs until new evidence resolves them.

export type TrackedPtyLivenessVerdict = {
  verdict: PtyLivenessVerdict
  observedAt: number
}

export type PtyForegroundAgentRefresh = {
  promise: Promise<boolean>
  startedAfterTitleObservation: number
  requestedAfterTitleObservation: number
}

export type PtyForegroundProcessRead = {
  controller: RuntimePtyController
  process: string | null
  available: boolean
}

export type PtyForegroundProcessReadEntry = {
  controller: RuntimePtyController
  startedAfterTitleObservation: number
  promise: Promise<PtyForegroundProcessRead>
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
export const FOREGROUND_AGENT_WRAPPER_RETRY_INTERVAL_MS = 150
export const FOREGROUND_AGENT_WRAPPER_RETRY_TIMEOUT_MS = 6_500
export const BRACKETED_PASTE_BEGIN = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'
export const BRACKETED_PASTE_QUIET_MS = 1500
// Why: both are windows *after* the paste is ingested, so each is added to the
// payload's ingest bound rather than standing in for it (see getTerminalPasteIngestMs).
// The quiet window stays at 1500: nothing measured describes an agent's post-paste
// redraw cadence, and a shorter window submits mid-redraw.
// Why: Claude and Codex emit show-cursor after accepting bracketed paste.

// Why not setTimeout(0): it costs a full ~15.19 ms Windows timer tick per chunk (~0.95 s/MB)
// and never bought backpressure -- 16 KiB per tick paces ~1.07 MB/s, 11x above ConPTY's
// ~96 KB/s drain, so the in-flight buffer grew regardless. setImmediate keeps the only thing
// the yield actually did (let abort/permission/data callbacks run between chunks) at ~0.01 ms,
// and TERMINAL_INPUT_MAX_BYTES still bounds what can be in flight either way.
// Why the global and not node:timers/promises: only the global is intercepted by fake timers,
// so a chunked paste stays observable on the test clock.

// Why: the split already failed; the caller waits on this teardown only to learn whether the
// fallback kill is needed, so keep it short — an unreachable host must not stall the rejection.

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

export type RestoredOrchestrationAuthorityReceipt = Readonly<{
  ptyId: string
  worktreeId: string
  terminalHandle: string
  paneKey: string
  processIncarnation: string
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
}>

export type OrchestrationCompatibilitySshAttachmentAuthority = Extract<
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

export function getRuntimeFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getRuntimeFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

export function listRuntimeFolderWorkspaces(
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

export const MAX_NATIVE_CHAT_LAUNCH_DRAFT_RESOLUTION_TOMBSTONES = 200

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

// Why: declaration merge gives RPC handlers typed browser*/emulator* methods installed on the prototype at module load.
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
/* oxlint-enable typescript/consistent-type-definitions, typescript/no-unsafe-declaration-merging */
