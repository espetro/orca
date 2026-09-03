import { randomUUID } from 'node:crypto'
import {
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'

// Shared type/function rows extracted verbatim from orca-runtime.ts for the repo/git
// command collaborators. Kept in one leaf module so every collaborator imports identical
// shapes without a cycle through the facade.

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

export type ResolvedWorktree = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

export function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

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
