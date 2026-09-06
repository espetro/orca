/* eslint-disable max-lines -- Why: extracted agent cluster facade (bulk agent-cluster move) */
import { RuntimeAgentSessionLaunchCommands } from './runtime-agent-session-launch-commands'
import { RuntimeStructuredAgentSessionCommands } from './runtime-structured-agent-session-commands'
import type { AgentStatus } from '../../shared/agent-detection'
import {
  detectAgentStatusFromTitle,
  extractLastOscTitle,
  isOpenCodeNativeTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  normalizeTerminalTitle
} from '../../shared/agent-detection'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import {
  isAgentForegroundWrapperProcess,
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
import type {
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type {
  AgentSkillShareOperation,
  AgentSkillShareRequest
} from '../../shared/agent-skill-sharing-contract'
import {
  assertAgentSkillSharingAllowed,
  isAgentSkillSharingEnabled
} from '../../shared/agent-skill-sharing-gate'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { createAgentStatusOscProcessor } from '../../shared/agent-status-osc'
import type {
  AgentStatusEntry,
  AgentStatusIpcPayload,
  AgentStatusOrchestrationContext,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  pickParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { terminalStatusPayloadMatchesHook } from '../../shared/agent-terminal-status-equivalence'
import { getAppEnvironment } from '../../shared/app-environment'
import { resolvePublishedPaneAgentIdentity } from '../../shared/published-pane-agent-identity'
import type { Repo } from '../../shared/repo-types'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedTab,
  RuntimeTerminalAgentStatus,
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalRead,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../shared/runtime-types'
import type { DiscoveredSkill } from '../../shared/skills'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/tui-agent-config'
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
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { recordManagedHookInstallFailure } from '../agent-hooks/install-telemetry'
import { applyAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import {
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from '../agent-trust-presets'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { markRemoteAgentWorkspaceTrusted } from '../remote-agent-trust-presets'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import {
  readAgentPromptWaitText,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import type { AgentSessionClaimSigner } from './agent-session-claim-identity'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type {
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from './claude-agent-teams-service'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import {
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from './claude-agent-teams-shim-env'
import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeMobileSessionFacade } from './runtime-mobile-session-facade'
import type { RuntimePtyWorktrees } from './runtime-pty-worktrees'
import type { RuntimeSkillArtifactCommands } from './runtime-skill-artifact-commands'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-tail-projection'
import {
  agentTitleProvesAgentPresence,
  assertTerminalInputWithinLimitWithYield,
  buildTerminalWaitText,
  classifyAgentTitle,
  findLastCompleteOscTitleRange,
  getLatestLeafTitle,
  isKnownReadyPromptPreview,
  isTerminalSendSettlementAgent,
  mapExplicitAgentStateToRuntimeTerminalStatus,
  mergeWorktreeSummaryStatus,
  ptyTitleProvesAgentPresence,
  runtimeWorkingTerminalEvidenceMatchesSource,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-tail-projection'
import type {
  HookLiveAgentRow,
  ProviderSnapshotReadOptions,
  ResolvedWorktree,
  RuntimeAgentRowSnapshot,
  RuntimeLeafRecord,
  RuntimeNotifier,
  RuntimePtyController,
  RuntimePtyWorktreeRecord,
  RuntimeStore,
  RuntimeTerminalAgentStatusEvent,
  RuntimeTerminalDataMeta,
  RuntimeWorkingTerminalEvidence,
  RuntimeWorktreeAgentSource,
  TerminalAgentStatusSnapshot,
  TerminalCreateOptions,
  TerminalHandleRecord,
  TerminalWorkspaceLaunchScope,
  WorktreeStartupFollowup
} from './orca-runtime'
import {
  FOREGROUND_AGENT_WRAPPER_RETRY_INTERVAL_MS,
  FOREGROUND_AGENT_WRAPPER_RETRY_TIMEOUT_MS
} from './orca-runtime'
import type { RuntimeHookAgentRowResolutionCommands } from './runtime-hook-agent-row-resolution-commands'
import type { RuntimeTerminalAgentStatusBindingCommands } from './runtime-terminal-agent-status-binding-commands'
import {
  AGENT_PROMPT_RENDER_MARKER,
  AGENT_PROMPT_RENDER_QUIET_MS,
  AGENT_PROMPT_RENDER_TIMEOUT_MS,
  assertAgentPromptRequestActive,
  copySleepingAgentLaunchConfig,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise,
  yieldBetweenTerminalInputChunks,
  type AgentSessionCreateOperation
} from './agent-session-terminal-operations'

// eslint-disable @typescript-eslint/no-explicit-any -- Deps mirror god-class members, several are any-typed delegation shims
export type RuntimeAgentClusterFacadeDeps = {
  assertLiveTerminalHandleTargetsPty: (handle: string, expectedPtyId: string) => void
  closeStructuredTuiOwner: (owner: StructuredTuiOwner) => Promise<{ transcriptPath?: string }>
  closeTerminal: (handle: string) => Promise<RuntimeTerminalClose>
  createTerminal: (
    worktreeSelector: string | undefined,
    opts: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  emitMobileSessionTabsSnapshot: (...args: any[]) => any
  focusTerminal: (
    handle: string,
    options: { navigateHost?: boolean }
  ) => Promise<RuntimeTerminalFocus>
  getAgentLaunchPlatformForRepo: (...args: any[]) => any
  getAgentLaunchPlatformForWorkspace: (...args: any[]) => any
  getHeadlessMobileSessionGroupId: (...args: any[]) => any
  getKnownWorkspaceSessionWorktreeIds: () => Set<string>
  getLeavesForPty: (ptyId: string) => RuntimeLeafRecord[]
  getLiveLeafForHandle: (handle: string) => {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  getLivePtyForHandle: (handle: string) => {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  getLocalProvider: () => IPtyProvider | null
  getOrchestrationDbIfAvailable: () => OrchestrationDb | null
  getPaneKeyForTerminalHandle: (handle: string) => string | null
  getPrimaryLeafForPty: (ptyId: string) => RuntimeLeafRecord | null
  getPtyLifecycleGeneration: (ptyId: string) => number
  getPtyOutputSequence: (ptyId: string) => number
  getPtyRecordForPaneKey: (paneKey: string) => RuntimePtyWorktreeRecord | null
  getPtyWriteHostPlatform: (ptyId: string) => NodeJS.Platform
  getSummaryForRuntimeWorktreeId: (...args: any[]) => any
  getTerminalHandleForPaneKey: (paneKey: string) => string | null
  getWorkspaceSessionForWorktree: (worktreeId: string) => WorkspaceSessionState | null
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args: any[]) => any
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  issuePtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  issueStructuredTuiPtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  makeRuntimePaneKey: (...args: any[]) => any
  nextTitleObservationSequence: () => number
  proveRecoveredStructuredTuiPtyProcess: (
    pty: RuntimePtyWorktreeRecord,
    identity: NonNullable<AgentSessionRecord['lease']['ownerProcess']>,
    provider: 'codex' | 'claude'
  ) => Promise<boolean>
  readTerminal: (
    handle: string,
    opts?: { cursor?: number; limit?: number; screen?: boolean },
    providerSnapshot?: ProviderSnapshotReadOptions
  ) => Promise<RuntimeTerminalRead>
  refreshMobileSessionPtyRecords: (targetWorktreeId: string | null) => Promise<Set<string> | null>
  refreshStructuredTuiOwnerBinding: (owner: StructuredTuiOwner) => StructuredTuiOwner
  requireStore: () => Store
  resolveConfiguredCodexStructuredArgs: () => string[]
  resolveRecoveredStructuredTuiTranscript: (...args: any[]) => any
  resolveRuntimeFileTarget: (worktreeSelector: string) => Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
  }>
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
  resolveWorkspaceTerminalStartupCwd: (...args: any[]) => any
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  sendTerminal: (...args: any[]) => any
  setPtyManagementTitleFromObservedTitle: (
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ) => void
  showTerminal: (handle: string) => Promise<RuntimeTerminalShow>
  splitTerminal: (...args: any[]) => any
  stopStructuredSessionProcess: (record: AgentSessionRecord) => Promise<void>
  structuredTuiStatus: (owner: StructuredTuiOwner) => 'idle' | 'busy'
  subscribeToTerminalData: (
    ptyId: string,
    listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
  ) => () => void
  terminalHasShellForegroundProcess: (handle: string, ptyId: string) => Promise<boolean>
  waitForAdoptedStructuredTuiProof: (...args: any[]) => any
  waitForStructuredClaudeTuiProof: (...args: any[]) => any
  waitForStructuredTuiIdleOrExit: (
    owner: StructuredTuiOwner,
    signal: AbortSignal
  ) => Promise<'idle' | 'exited' | null>
  waitForStructuredTuiOwnerExit: (owner: StructuredTuiOwner) => Promise<void>
  waitForStructuredTuiProof: (...args: any[]) => any
  waitForStructuredTuiPtyExit: (ptyId: string) => Promise<void>
  waitForTerminal: (...args: any[]) => any
  agentSessionClaimSigner: () => AgentSessionClaimSigner
  agentSessionCreateOperations: () => Map<string, AgentSessionCreateOperation>
  claudeAgentTeams: () => ClaudeAgentTeamsService
  onTerminalAgentStatus: () => ((event: RuntimeTerminalAgentStatusEvent) => void) | null
  getSshProviderFn: () => ((connectionId: string) => IPtyProvider | undefined) | null
  prepareCodexStructuredLaunchFn: () =>
    | ((input: {
        workspacePath: string
        launchEnv: NodeJS.ProcessEnv
      }) => string | null | Promise<string | null>)
    | null
  getAgentProviderSessionRowsForPaneFn: () => ((paneKey: string) => AgentStatusIpcPayload[]) | null
  getAgentStatusSnapshotFn: () => (() => AgentStatusIpcPayload[]) | null
  runtimeId: () => `${string}-${string}-${string}-${string}-${string}`
  store: () => RuntimeStore | null
  ptysById: () => Map<string, RuntimePtyWorktreeRecord>
  ptyController: () => RuntimePtyController | null
  tabs: () => Map<string, RuntimeSyncedTab>
  notifier: () => RuntimeNotifier | null
  mobileSessionTabsByWorktree: () => Map<string, RuntimeMobileSessionTabsSnapshot>
  ptyWorktrees: () => RuntimePtyWorktrees
  skillArtifactCommands: () => RuntimeSkillArtifactCommands
  mobileSessionFacade: () => RuntimeMobileSessionFacade
  hookAgentRowResolutionCommands: () => RuntimeHookAgentRowResolutionCommands
  terminalAgentStatusBinding: () => RuntimeTerminalAgentStatusBindingCommands
  getTerminalAgentStatusPtyId: () => (handle: string) => string
  assertTerminalAgentStatusPtyBinding: () => (handle: string, expectedPtyId: string) => void
  getTerminalAgentStatusSnapshot: () => (
    handle: string,
    expectedPtyId: string,
    waitTextOverride?: string
  ) => any
  hasAuthoritativeTerminalWaitPermission: () => (
    terminal: TerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ) => boolean
  getOrCreatePtyTitleTrackerEntry: () => (ptyId: string) => any
  agentPromptLifecycleByPtyId: () => Map<
    string,
    { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  >
  agentPromptPermissionSequenceByPtyId: () => Map<string, number>
  agentPromptExplicitStatusFloorByPtyId: () => Map<string, number>
  agentPromptSubmissionTailByPtyId: () => Map<string, Promise<void>>
  agentStatusOscProcessorsByPtyId: () => Map<string, (data: string) => ProcessedAgentStatusChunk>
  latestAgentStatusByPaneKey: () => Map<string, RuntimeAgentRowSnapshot>
}
// eslint-enable @typescript-eslint/no-explicit-any

export class RuntimeAgentClusterFacade {
  private readonly deps: RuntimeAgentClusterFacadeDeps
  private readonly structuredSessionCommands: RuntimeStructuredAgentSessionCommands
  private readonly launchCommands: RuntimeAgentSessionLaunchCommands
  private managedHookReconciliationGeneration = 0
  private managedHookReconciliationTail: Promise<void> = Promise.resolve()

  constructor(deps: RuntimeAgentClusterFacadeDeps) {
    this.deps = deps
    this.structuredSessionCommands = new RuntimeStructuredAgentSessionCommands(this, deps)
    this.launchCommands = new RuntimeAgentSessionLaunchCommands(this, deps)
  }

  applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    // Why: a relaunched main starts its per-PTY title tracker cold — without
    // this seed it misses the parked working→idle completion and never arms
    // the stale-title timer for a persisted 'working' title. Seeding no-ops
    // once a live title was observed, so live state always wins.
    this.deps.getOrCreatePtyTitleTrackerEntry()(ptyId).tracker.seedInitialTitle(title)
    const status = detectAgentStatusFromTitle(title)
    // Why: live observations store normalized titles, so seeds must match —
    // otherwise the first live frame after hydration compares unequal and
    // touches session tabs once for no visible change.
    const seededTitle = normalizeTerminalTitle(title)
    const pty = this.deps.ptysById().get(ptyId)
    if (pty) {
      const observedAt = this.deps.nextTitleObservationSequence()
      pty.lastOscTitle = seededTitle
      pty.lastOscTitleAt = observedAt
      this.deps.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
    }
    for (const leaf of this.deps.getLeavesForPty(ptyId)) {
      // Why: seed lastOscTitle even when the seeded title doesn't classify
      // as an agent state, so worktree.ps recomputes status from the live
      // title rather than treating the leaf as agentless.
      leaf.lastOscTitle = seededTitle
      leaf.lastOscTitleAt = this.deps.nextTitleObservationSequence()
      if (status !== null) {
        leaf.lastAgentStatus = status
      }
    }
  }

  assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.deps.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }

  assertAgentPromptPermissionSafe(
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

  assertAgentSkillSharingAllowed(): void {
    assertAgentSkillSharingAllowed(() =>
      isAgentSkillSharingEnabled(this.deps.store()?.getSettings())
    )
  }

  attachAgentRowsToSummaries(
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
    for (const snapshot of this.deps.latestAgentStatusByPaneKey().values()) {
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
    for (const entry of this.deps.getAgentStatusSnapshotFn()?.() ?? []) {
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
      const summary = this.deps.getSummaryForRuntimeWorktreeId(
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

  buildAgentOrchestrationByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    return this.deps.hookAgentRowResolutionCommands().buildAgentOrchestrationByPaneKey()
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
    const settings = this.deps.requireStore().getSettings()
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

  clearAgentRowSnapshotsForPty(ptyId: string): void {
    return this.deps.mobileSessionFacade().clearAgentRowSnapshotsForPty(ptyId)
  }

  closeStructuredAgentSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionAgentTab
  ): void {
    return this.structuredSessionCommands.closeStructuredAgentSessionTab(worktreeId, snapshot, tab)
  }

  async createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeCreateAgentSessionResult> {
    return this.launchCommands.createAgentSession(request, caller)
  }

  createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport {
    return this.structuredSessionCommands.createStructuredAgentSessionHandoffTransport()
  }

  async ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    _caller: RuntimeAgentSessionRpcCaller = {},
    handoffAuthority?: { spawnToken: string; providerRoot: string; sessionId: string }
  ): Promise<RuntimeEnsureAgentSessionResult> {
    return this.launchCommands.ensureAgentSession(request, _caller, handoffAuthority)
  }

  async ensureStructuredAgentSessionHost(): Promise<void> {
    return this.structuredSessionCommands.ensureStructuredAgentSessionHost()
  }

  async executionOwnerSupportsAgentSessionOperation(
    workspace: TerminalWorkspaceLaunchScope,
    operation: 'resume' | 'create',
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.launchCommands.executionOwnerSupportsAgentSessionOperation(
      workspace,
      operation,
      signal
    )
  }

  getAgentSessionExecutionNamespace(
    workspace: TerminalWorkspaceLaunchScope,
    agent: TuiAgent
  ): { machine: string; principal: string; container: string; providerRoot: string } | null {
    return this.launchCommands.getAgentSessionExecutionNamespace(workspace, agent)
  }

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: 'codex'
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    return this.structuredSessionCommands.getStructuredAgentSessionCreateSupport(
      worktreeSelector,
      agent
    )
  }

  hasPersistedStructuredAgentSessionStore(): boolean {
    return this.structuredSessionCommands.hasPersistedStructuredAgentSessionStore()
  }

  async launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<RuntimeTerminalCreate> {
    return this.launchCommands.launchAgentTerminal(worktreeSelector, opts)
  }

  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    return this.structuredSessionCommands.prepareStructuredAgentSessionStartupRestoration()
  }

  async prepareStructuredAgentSessionStartupRestorationOnce(): Promise<void> {
    return this.structuredSessionCommands.prepareStructuredAgentSessionStartupRestorationOnce()
  }

  publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'codex'
    activate: boolean
    notify?: boolean
  }): void {
    return this.structuredSessionCommands.publishStructuredAgentSessionTab(input)
  }

  async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    return this.launchCommands.resolveAgentTerminalCreateOptions(workspace, opts)
  }

  async resolveStructuredAgentSessionCreateIntent(input: {
    envelope: { sessionId: string; clientOperationId: string }
    worktree: string
    agent: 'codex'
  }): Promise<AgentSessionAttachParams> {
    return this.structuredSessionCommands.resolveStructuredAgentSessionCreateIntent(input)
  }

  async resolveStructuredAgentSessionIntent(
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
    return this.structuredSessionCommands.resolveStructuredAgentSessionIntent(
      input,
      resolveAccountHomePath
    )
  }

  async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    return this.structuredSessionCommands.resolveStructuredAgentSessionLocation(worktreeSelector)
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    return this.structuredSessionCommands.restoreStructuredAgentSessionTabs()
  }

  async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    return this.structuredSessionCommands.restoreStructuredAgentSessionTabsOnce()
  }

  toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined {
    return this.launchCommands.toAgentSessionOptions(preferences)
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    return this.structuredSessionCommands.validateOrchestrationAgentLauncher(agent)
  }

  createAgentPromptRenderGate(
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
    const unsubscribe = this.deps.subscribeToTerminalData(ptyId, (data) => {
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

  emitTerminalAgentStatusEvents(ptyId: string, chunk: ProcessedAgentStatusChunk): boolean {
    // Why: snapshot retention (for mobile worktree.ps) must run even when no
    // renderer listener is attached, so we don't early-return on a missing
    // onTerminalAgentStatus — only the per-target emit below is gated on it.
    if (chunk.payloads.length === 0) {
      return false
    }
    const targets = new Map<
      string,
      {
        source: 'mounted-leaf' | 'pty-record'
        paneKey: string
        tabId?: string
        worktreeId?: string
        connectionId?: string | null
      }
    >()
    const pty = this.deps.ptysById().get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.deps.getLeavesForPty(ptyId)) {
      const paneKey = this.deps.makeRuntimePaneKey(leaf)
      targets.set(paneKey, {
        source: 'mounted-leaf',
        paneKey,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        connectionId
      })
    }
    if (targets.size === 0 && pty?.paneKey) {
      targets.set(pty.paneKey, {
        source: 'pty-record',
        paneKey: pty.paneKey,
        tabId: pty.tabId ?? undefined,
        worktreeId: pty.worktreeId,
        connectionId
      })
    }
    let retainedChanged = false
    for (const payload of chunk.payloads) {
      this.recordAgentPromptLifecycleState(
        ptyId,
        mapExplicitAgentStateToRuntimeTerminalStatus(payload.state)
      )
      for (const target of targets.values()) {
        retainedChanged =
          this.retainAgentRowSnapshot(
            ptyId,
            target.paneKey,
            target.worktreeId,
            target.tabId,
            target.connectionId ?? null,
            payload
          ) || retainedChanged
        if (!this.deps.onTerminalAgentStatus()) {
          continue
        }
        try {
          this.deps.onTerminalAgentStatus()?.({
            ptyId,
            ...target,
            payload
          })
        } catch (err) {
          console.error('[runtime] terminal agent status listener threw', {
            ptyId,
            paneKey: target.paneKey,
            state: payload.state,
            agentType: payload.agentType,
            err
          })
        }
      }
    }
    return retainedChanged
  }

  getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    this.deps.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    const outputSequence = this.deps.getPtyOutputSequence(ptyId)
    const explicitCandidate = this.getFreshExplicitAgentStatusForHandle(handle)
    const explicitFloor = this.deps.agentPromptExplicitStatusFloorByPtyId().get(ptyId)
    const explicit =
      explicitCandidate &&
      (explicitFloor === undefined || explicitCandidate.updatedAt > explicitFloor)
        ? explicitCandidate
        : null
    const lifecycle = this.deps.agentPromptLifecycleByPtyId().get(ptyId)
    const ptyStatus =
      lifecycle || explicitFloor === undefined
        ? (this.deps.ptysById().get(ptyId)?.lastAgentStatus ?? null)
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
          () => this.deps.getTerminalAgentStatusSnapshot()(handle, ptyId).waitText
        )
      : undefined
    const terminal = this.deps.getTerminalAgentStatusSnapshot()(handle, ptyId, waitText)
    const status = this.deps.hasAuthoritativeTerminalWaitPermission()(terminal, explicit, lifecycle)
      ? 'permission'
      : lifecycleIsNewer
        ? lifecycle.status
        : (explicit?.status ?? ptyStatus ?? null)
    return {
      generation: this.deps.getPtyLifecycleGeneration(ptyId),
      permissionSequence: this.deps.agentPromptPermissionSequenceByPtyId().get(ptyId) ?? 0,
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

  getAgentStatusForHandle(handle: string): string | null {
    try {
      const ptyId = this.deps.getTerminalAgentStatusPtyId()(handle)
      return this.deps.getTerminalAgentStatusSnapshot()(handle, ptyId).titleStatus
    } catch {
      return null
    }
  }

  getAgentStatusLaunchConfigForPaneKey(
    paneKey: string,
    args?: { launchToken?: string }
  ): SleepingAgentLaunchConfig | undefined {
    const pty = this.deps.getPtyRecordForPaneKey(paneKey)
    if (!pty?.launchConfig) {
      return undefined
    }
    if (pty.launchToken === null || pty.launchToken !== args?.launchToken) {
      return undefined
    }
    return copySleepingAgentLaunchConfig(pty.launchConfig)
  }

  getAgentStatusOrchestrationContextForHandle(
    handle: string,
    db = this.deps.getOrchestrationDbIfAvailable()
  ): AgentStatusOrchestrationContext | undefined {
    return this.deps
      .hookAgentRowResolutionCommands()
      .getAgentStatusOrchestrationContextForHandle(handle, db)
  }

  getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined {
    const handle = this.deps.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return undefined
    }
    return this.getAgentStatusOrchestrationContextForHandle(handle)
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.deps.getTerminalHandleForPaneKey(paneKey) ?? undefined
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
    const paneKey = paneKeyOverride ?? this.deps.getPaneKeyForTerminalHandle(handle)
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

  getHookAgentRowForPane(rows: readonly AgentStatusIpcPayload[]): {
    providerSession: AgentProviderSessionMetadata | null
    providerSessionAgentType: string | null
    providerSessionReceivedAt: number | null
    agentType: string | null
    agentIsLive: boolean
    live: HookLiveAgentRow | null
  } {
    return this.deps.hookAgentRowResolutionCommands().getHookAgentRowForPane(rows)
  }

  getPtyAgent(ptyId: string): TuiAgent | null {
    return this.deps.ptyWorktrees().getPtyAgent(ptyId)
  }

  async getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.deps.getTerminalAgentStatusPtyId()(handle)
    const terminal = this.deps.getTerminalAgentStatusSnapshot()(handle, ptyId)
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle)
    const lifecycle = this.deps.agentPromptLifecycleByPtyId().get(ptyId)
    if (
      (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) ||
      this.deps.hasAuthoritativeTerminalWaitPermission()(terminal, explicitStatus, lifecycle)
    ) {
      return { handle, isRunningAgent: true, status: 'permission' }
    }
    if (explicitStatus) {
      // Why: permission titles can linger after hooks report the agent resumed.
      // Fresh hook state is tighter, but current shell/management evidence wins.
      const isRunningAgent =
        !terminalTitleBlocksExplicitAgentStatus(terminal.title) &&
        !(await this.deps.terminalHasShellForegroundProcess(handle, ptyId))
      this.deps.assertTerminalAgentStatusPtyBinding()(handle, ptyId)
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
        this.deps.assertTerminalAgentStatusPtyBinding()(handle, ptyId)
        return {
          handle,
          isRunningAgent,
          status: isRunningAgent ? terminal.titleStatus : null
        }
      }
      return { handle, isRunningAgent: true, status: terminal.titleStatus }
    }

    const isRunningAgent = await this.isTerminalRunningAgent(handle)
    this.deps.assertTerminalAgentStatusPtyBinding()(handle, ptyId)
    return { handle, isRunningAgent, status: null }
  }

  async handleAgentTeamsTmuxCompat(
    request: AgentTeamsTmuxCompatRequest
  ): Promise<AgentTeamsTmuxCompatResponse> {
    return await this.deps.claudeAgentTeams().handleTmuxCompat(request, {
      splitTerminal: (handle, opts) => this.deps.splitTerminal(handle, opts),
      readTerminal: (handle, opts) => this.deps.readTerminal(handle, opts ?? {}),
      sendTerminal: (handle, action) => this.deps.sendTerminal(handle, action),
      focusTerminal: (handle) => this.deps.focusTerminal(handle, {}),
      closeTerminal: (handle) => this.deps.closeTerminal(handle),
      showTerminal: (handle) => this.deps.showTerminal(handle)
    })
  }

  isAgentWrapperForegroundProcess(processName: string): boolean {
    // Why: daemon/SSH PTYs can report the interpreter before the async cmdline cache resolves; retry only known wrappers.
    return isAgentForegroundWrapperProcess(processName)
  }

  async isPtyRunningAgent(
    pty: RuntimePtyWorktreeRecord,
    leaf: RuntimeLeafRecord | null = null,
    options: { retryForegroundWrappers?: boolean } = {}
  ): Promise<boolean> {
    return this.deps.ptyWorktrees().isPtyRunningAgent(pty, leaf, options)
  }

  async isRecognizedForegroundAgentProcess(
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
      !this.deps.ptyController()
    ) {
      return false
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < FOREGROUND_AGENT_WRAPPER_RETRY_TIMEOUT_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, FOREGROUND_AGENT_WRAPPER_RETRY_INTERVAL_MS)
      )
      const refreshedProcess = await this.deps.ptyController()?.getForegroundProcess(ptyId)
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

  async isTerminalRunningAgent(
    handle: string,
    options: { retryForegroundWrappers?: boolean } = {}
  ): Promise<boolean> {
    try {
      const pty = this.deps.getLivePtyForHandle(handle)
      if (pty) {
        const leaf = this.deps.getPrimaryLeafForPty(pty.pty.ptyId)
        return await this.isPtyRunningAgent(pty.pty, leaf, options)
      }
      const { leaf } = this.deps.getLiveLeafForHandle(handle)
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
      const fg = await this.deps.ptyController()?.getForegroundProcess(leaf.ptyId)
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
      return await this.isRecognizedForegroundAgentProcess(leaf.ptyId, fg, {
        suppressClaude: shouldSuppressClaudeForeground,
        retryWrappers: options.retryForegroundWrappers !== false
      })
    } catch {
      return false
    }
  }

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    try {
      const livePty = this.deps.getLivePtyForHandle(handle)
      const leaf = livePty ? null : this.deps.getLiveLeafForHandle(handle).leaf
      const ptyId = livePty?.pty.ptyId ?? leaf?.ptyId ?? null
      const trackedPty = livePty?.pty ?? (ptyId ? this.deps.ptysById().get(ptyId) : null)
      if (!ptyId || !trackedPty || !this.deps.ptyController()) {
        return false
      }
      const recognized = recognizeAgentProcess(
        await this.deps.ptyController()?.getForegroundProcess(ptyId)
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

  async loadPtyForegroundAgentFromController(
    ptyId: string,
    afterTitleObservation?: number
  ): Promise<boolean> {
    return this.deps
      .terminalAgentStatusBinding()
      .loadPtyForegroundAgentFromController(ptyId, afterTitleObservation)
  }

  async markLocalWorkspaceTrustedForAgent(agent: TuiAgent, workspacePath: string): Promise<void> {
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

  async markRemoteWorkspaceTrustedForAgent(
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

  markWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string | null | undefined,
    workspacePath: string
  ): Promise<void> {
    return connectionId
      ? this.markRemoteWorkspaceTrustedForAgent(agent, connectionId, workspacePath)
      : this.markLocalWorkspaceTrustedForAgent(agent, workspacePath)
  }

  async prepareClaudeAgentTeamsLeader(args: {
    paneKey: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    const handle = this.deps.getTerminalHandleForPaneKey(args.paneKey)
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
    return this.deps.claudeAgentTeams().createLaunchEnv({
      leaderHandle: args.handle,
      baseEnv,
      shimDir,
      shimBin
    })
  }

  processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    let processor = this.deps.agentStatusOscProcessorsByPtyId().get(ptyId)
    if (!processor) {
      processor = createAgentStatusOscProcessor()
      this.deps.agentStatusOscProcessorsByPtyId().set(ptyId, processor)
    }
    return processor(data)
  }

  publishDiscoveredSkillsFromAgent(
    request: AgentSkillShareRequest,
    discoveredSkills: readonly DiscoveredSkill[],
    signal?: AbortSignal
  ): Promise<AgentSkillShareOperation> {
    return this.deps
      .skillArtifactCommands()
      .publishDiscoveredSkillsFromAgent(request, discoveredSkills, signal)
  }

  reconcileManagedAgentHooks(): Promise<void> {
    const generation = ++this.managedHookReconciliationGeneration
    const reconciliation = this.managedHookReconciliationTail.then(async () => {
      if (generation !== this.managedHookReconciliationGeneration) {
        return
      }
      const settings = this.deps.store()?.getSettings()
      if (!settings) {
        return
      }
      await applyAgentStatusHooksEnabled(settings.agentStatusHooksEnabled !== false, settings, {
        shouldHydrateShellPath: getAppEnvironment().isPackaged(),
        onInstallError: recordManagedHookInstallFailure,
        shouldContinue: (agent) => {
          const current = this.deps.store()?.getSettings()
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

  recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void {
    if (status === 'permission') {
      this.recordAgentPromptPermissionObservation(ptyId)
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

  recordAgentPromptPermissionObservation(ptyId: string): void {
    this.deps
      .agentPromptPermissionSequenceByPtyId()
      .set(ptyId, (this.deps.agentPromptPermissionSequenceByPtyId().get(ptyId) ?? 0) + 1)
  }

  releaseClaudeAgentTeamsLeaderForHandle(handle: string): void {
    this.deps.claudeAgentTeams().removeTeamForLeaderHandle(handle)
  }

  resolveHookLiveAgentRow(
    live: HookLiveAgentRow | null,
    pty: RuntimePtyWorktreeRecord | null,
    nonAgentTitle: boolean
  ): HookLiveAgentRow | null {
    return this.deps
      .hookAgentRowResolutionCommands()
      .resolveHookLiveAgentRow(
        live as
          | Parameters<RuntimeHookAgentRowResolutionCommands['resolveHookLiveAgentRow']>[0]
          | null,
        pty,
        nonAgentTitle
      )
  }

  resolvePaneAgentIdentityField(
    launchAgent: TuiAgent | null | undefined,
    foregroundAgent: TuiAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ): { agentIdentity?: TuiAgent } {
    // Why hooks here: an agent the USER started from a shell has no launch record, and on WSL the
    // Windows host reads its foreground process as `wsl.exe` rather than the agent inside the
    // distro. The hook is the only signal that survives both, because the agent reports itself.
    const hookRow = paneKey
      ? this.getHookAgentRowForPane(
          this.deps.getAgentProviderSessionRowsForPaneFn()?.(paneKey) ?? []
        )
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

  restoreAgentPromptLifecycleByteOrder(
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
    const current = this.deps.agentPromptLifecycleByPtyId().get(ptyId)
    if (!current || current.status === status) {
      return
    }
    this.deps.agentPromptLifecycleByPtyId().set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && current.status !== 'working' ? 1 : 0),
      updatedAt: Date.now()
    })
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

  retirePtyAgentLaunchAuthority(ptyId: string): void {
    return this.deps.ptyWorktrees().retirePtyAgentLaunchAuthority(ptyId)
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
    const pty = this.deps.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      await assertTerminalInputWithinLimitWithYield(payload)
      const generation = this.deps.getPtyLifecycleGeneration(pty.pty.ptyId)
      const submits = await this.serializeAgentPromptSubmission(
        pty.pty.ptyId,
        generation,
        async () => {
          this.deps.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
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

    const { leaf } = this.deps.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    await assertTerminalInputWithinLimitWithYield(payload)
    // Why: same absence gate as sendTerminal — a stale graph mirror must not
    // accept a prompt into a void; unknown liveness still proceeds.
    if (await this.deps.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.deps.getPtyLifecycleGeneration(leaf.ptyId)
    const submits = await this.serializeAgentPromptSubmission(leaf.ptyId, generation, async () => {
      this.deps.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId!)
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
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    // Why: the floor for every wait below. Enter must never overtake bytes the execution
    // host is still feeding the child, and that cost is proportional to the payload.
    const writeHostPlatform = this.deps.getPtyWriteHostPlatform(ptyId)
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    const renderGate = this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
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
        this.assertAgentPromptPermissionSafe(
          permissionBaseline,
          this.getAgentPromptActivity(handle, ptyId)
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
        this.deps.getPtyLifecycleGeneration(ptyId) === generation
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
    const baseline = this.getAgentPromptActivity(handle, ptyId, waitTextCache)
    this.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    const suffixWrote = this.deps.ptyController()?.write(ptyId, AGENT_PROMPT_SUBMIT) ?? false
    if (!suffixWrote) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
    await verifyAgentPromptSubmission({
      baseline,
      readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
      timeoutMs: resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId)),
      signal: options.signal
    })
    return 1
  }
}
