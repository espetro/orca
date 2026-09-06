/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  MOCK_GIT_WORKTREES,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_FOLDER_WORKSPACE_PATH,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  addGitHubIssueCommentMock,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  addWorktreeMock,
  applyAgentStatusHooksEnabledMock,
  closeRemoteWatcherForWorktreePathMock,
  computeWorktreePathMock,
  countGitHubWorkItemsMock,
  createFolderWorkspaceRuntimeStore,
  createGitHubIssueMock,
  createHostedReviewMock,
  createRuntime,
  createRuntimeWithSshLease,
  createStackedHostedReviewMock,
  deferred,
  deleteWorktreeHistoryDirMock,
  electronMocks,
  ensurePathWithinWorkspaceMock,
  getActiveMultiplexerMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRChecksMock,
  getGitHubPRCommentsMock,
  getGitHubPRFileContentsMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubWorkItemMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getIssueMock,
  getPRForBranchMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  getSshGitProviderMock,
  invalidateAuthorizedRootsCacheMock,
  isOriginMainBaseRefProbe,
  listGitHubAssignableUsersMock,
  listGitHubIssuesMock,
  listGitHubLabelsMock,
  listGitHubWorkItemsMock,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRpcRequest,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  mergeGitHubPRMock,
  muxRequestMock,
  prepareLocalWorktreeRootForRepoMock,
  removeGitHubPRReviewersMock,
  requestGitHubPRReviewersMock,
  rerunGitHubPRChecksMock,
  resolveGitHubReviewThreadMock,
  resolveLocalGitUsernameMock,
  setGitHubPRAutoMergeMock,
  setGitHubPRFileViewedMock,
  setPlatform,
  store,
  syncSinglePty,
  updateGitHubIssueMock,
  updateGitHubPRDetailsMock,
  updateGitHubPRStateMock,
  updateGitHubPRTitleMock
} from './orca-runtime-test-fixture'
import { RuntimeBrowserCommands } from './orca-runtime-browser'
import {
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
import { setRuntimeTerminalUnavailableCause } from './native-terminal-availability'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import * as gitRunner from '../git/runner'
import { addSparseWorktree, addWorktree, listWorktrees, removeWorktree } from '../git/worktree'
import { clearSubmodulePathsCacheForTests, listSubmodulePaths } from '../git/status'
import { getEffectiveHooks, hasHooksFile, loadHooks, parseOrcaYaml } from '../hooks'
import { getEffectiveHooksFromConfig, shouldRunSetupForCreate } from '../effective-hook-config'
import { getBaseRefDefault, getBranchConflictKind } from '../git/repo'
import { OrcaRuntimeService } from './orca-runtime'
import { RUNTIME_GRAPH_RELOAD_TIMEOUT_MS } from './runtime-graph-reload-lifecycle'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { MAX_QUICK_COMMANDS } from '../../shared/terminal-quick-commands'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { DEFAULT_REPO_BADGE_COLOR, FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV } from '../../shared/setup-agent-sequencing'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { resolveWorktreeScanCacheTtlMs } from './runtime-tail-shared'
import { RpcDispatcher } from './rpc/dispatcher'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeSyncWindowGraph,
  RuntimeTerminalCreate
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService.dedupeWorktreeCreate', () => {
  it('coalesces concurrent creates that share a clientMutationId', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ worktree: { id: string } }> => {
      calls += 1
      return Promise.resolve({ worktree: { id: 'wt' } })
    }
    const [a, b] = await Promise.all([
      runtime.dedupeWorktreeCreate('id:r', 'key-1', factory),
      runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it('reuses a settled success for a retry whose response was lost in a cutover', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ worktree: { id: string } }> => {
      calls += 1
      return Promise.resolve({ worktree: { id: `wt-${calls}` } })
    }
    const first = await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    const retried = await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
    expect(calls).toBe(1)
    expect(retried).toEqual(first)
  })

  it('expires settled successes after the reconnect window', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      let calls = 0
      const factory = (): Promise<{ n: number }> => Promise.resolve({ n: (calls += 1) })
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      await vi.advanceTimersByTimeAsync(59_999)
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      await runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a failed create so a genuine retry starts fresh', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<never> => {
      calls += 1
      return Promise.reject(new Error(`boom-${calls}`))
    }
    await expect(runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)).rejects.toThrow('boom-1')
    await expect(runtime.dedupeWorktreeCreate('id:r', 'key-1', factory)).rejects.toThrow('boom-2')
    expect(calls).toBe(2)
  })

  it('never dedupes across repos or when no clientMutationId is supplied', async () => {
    const runtime = new OrcaRuntimeService(store)
    let calls = 0
    const factory = (): Promise<{ n: number }> => {
      calls += 1
      return Promise.resolve({ n: calls })
    }
    await runtime.dedupeWorktreeCreate('id:a', 'key-1', factory)
    await runtime.dedupeWorktreeCreate('id:b', 'key-1', factory)
    await runtime.dedupeWorktreeCreate('id:a', undefined, factory)
    await runtime.dedupeWorktreeCreate('id:a', undefined, factory)
    expect(calls).toBe(4)
  })
})

describe('OrcaRuntimeService', () => {
  it('projects runtime-backed settings to paired clients', () => {
    const terminalQuickCommands = [
      {
        id: 'review',
        label: 'Review',
        action: 'agent-prompt' as const,
        agent: 'codex' as const,
        prompt: 'Review this diff',
        scope: { type: 'global' as const }
      }
    ]
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5',
        terminalQuickCommands
      })
    } as never)

    expect(runtime.getClientSettings()).toMatchObject({
      worktreeVisibilityDefaults: { external: 'hide' },
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })
    expect(runtime.getClientSettings()).not.toHaveProperty('terminalQuickCommands')
    expect(runtime.getClientTerminalQuickCommands()).toEqual(terminalQuickCommands)
  })

  it('updates quick commands without widening general paired settings payloads', () => {
    const existing = {
      id: 'review',
      label: 'Review',
      action: 'terminal-command' as const,
      command: 'pnpm review',
      appendEnter: true,
      scope: { type: 'global' as const }
    }
    let settings = { ...store.getSettings(), terminalQuickCommands: [existing] }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)
    const command = {
      id: 'status',
      label: 'Status',
      action: 'terminal-command' as const,
      command: 'git status',
      appendEnter: true,
      scope: { type: 'global' as const }
    }
    const commands = [existing, command]

    expect(runtime.updateClientTerminalQuickCommands({ type: 'upsert', command })).toEqual(commands)
    expect(updateSettings).toHaveBeenCalledWith(
      { terminalQuickCommands: commands },
      { notifyListeners: true }
    )
    expect(runtime.getClientSettings()).not.toHaveProperty('terminalQuickCommands')
  })

  it('rejects a concurrent add after the quick command limit is reached', () => {
    const terminalQuickCommands = Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) => ({
      id: `command-${index}`,
      label: `Command ${index}`,
      action: 'terminal-command' as const,
      command: 'true',
      appendEnter: true,
      scope: { type: 'global' as const }
    }))
    const updateSettings = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({ ...store.getSettings(), terminalQuickCommands }),
      updateSettings
    } as never)

    expect(() =>
      runtime.updateClientTerminalQuickCommands({
        type: 'upsert',
        command: {
          id: 'one-too-many',
          label: 'One too many',
          action: 'terminal-command',
          command: 'true',
          appendEnter: true,
          scope: { type: 'global' }
        }
      })
    ).toThrow('Quick command limit reached')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('accepts runtime-backed setting updates from paired clients', async () => {
    let settings = {
      ...store.getSettings(),
      experimentalNewWorktreeCardStyle: false,
      compactWorktreeCards: false,
      minimaxGroupId: '',
      minimaxUsageModels: 'general'
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    expect(
      await runtime.updateClientSettings({
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5'
      })
    ).toMatchObject({
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })
    expect(updateSettings).toHaveBeenCalledWith(
      {
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5'
      },
      { notifyListeners: true }
    )
    expect(runtime.getClientSettings()).toMatchObject({
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })
  })

  it('broadcasts visibility default changes to paired clients', async () => {
    let settings = { ...store.getSettings(), worktreeVisibilityDefaults: { external: 'hide' } }
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings: (updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
      }
    } as never)
    const events: unknown[] = []
    runtime.onClientEvent((event) => events.push(event))

    await runtime.updateClientSettings({ worktreeVisibilityDefaults: { external: 'show' } })

    expect(events).toContainEqual({ type: 'reposChanged' })
  })

  it('reconciles hooks only when paired-client hook settings change', async () => {
    electronMocks.app.isPackaged = true
    let settings = {
      ...store.getSettings(),
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    await runtime.updateClientSettings({ disabledTuiAgents: ['claude', 'codex'] })
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()

    await runtime.updateClientSettings({ disabledTuiAgents: ['claude'] })
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ disabledTuiAgents: ['claude'] }),
      expect.objectContaining({
        shouldContinue: expect.any(Function),
        shouldHydrateShellPath: true
      })
    )
  })

  it('serializes paired-client hook reconciliation and reads current settings', async () => {
    let settings = {
      ...store.getSettings(),
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const firstReconciliation = deferred<[]>()
    applyAgentStatusHooksEnabledMock
      .mockImplementationOnce(() => firstReconciliation.promise)
      .mockResolvedValueOnce([])
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    const first = runtime.updateClientSettings({ disabledTuiAgents: ['claude'] })
    await vi.waitFor(() => expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce())
    const second = runtime.updateClientSettings({ disabledTuiAgents: [] })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    const firstOptions = applyAgentStatusHooksEnabledMock.mock.calls[0]?.[2]
    expect(firstOptions?.shouldContinue?.('claude')).toBe(true)

    firstReconciliation.resolve([])
    await Promise.all([first, second])

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledTimes(2)
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ disabledTuiAgents: [] }),
      expect.objectContaining({ shouldContinue: expect.any(Function) })
    )
  })

  it('rejects relative paths for runtime nested repo scan/import', async () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      createProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn()
    } as never)

    await expect(runtime.scanNestedRepos('relative/project')).rejects.toThrow(
      'Project path must be an absolute path'
    )
    await expect(
      runtime.importNestedRepos({
        parentPath: 'relative/project',
        groupName: 'Project',
        projectPaths: ['relative/project/api'],
        mode: 'group'
      })
    ).rejects.toThrow('Project path must be an absolute path')
  })

  it('starts unavailable with no authoritative window', () => {
    const runtime = createRuntime()

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      desktopWindowStatus: 'openable',
      rendererGraphEpoch: 0
    })
    expect(runtime.getRuntimeId()).toBeTruthy()
  })

  it('reports runtime protocol, capabilities, and mobile aliases on status', () => {
    const runtime = createRuntime()

    const status = runtime.getStatus()
    expect(typeof status.runtimeProtocolVersion).toBe('number')
    expect(typeof status.minCompatibleRuntimeClientVersion).toBe('number')
    expect(status.runtimeProtocolVersion).toBe(status.protocolVersion)
    expect(status.minCompatibleRuntimeClientVersion).toBe(status.minCompatibleMobileVersion)
    expect(status.capabilities).toContain('terminal.binary-stream.v1')
    expect(status.capabilities).toContain('workspace-ports.v1')
    expect(status.capabilities).toContain('mobile.tasks.v1')
    expect(status.capabilities).toContain('terminal.quick-commands.v1')
    expect(status.capabilities).toContain('worktree.create-idempotency.v1')
    expect(status.worktreeCreateIdempotency).toEqual({ dedupeTtlMs: 60_000 })
    expect(status.capabilities).toContain('files.mutation-ownership.v1')
    expect(status.capabilities).toContain('project-host-setup.v1')
    expect(status.capabilities).toContain('linear.issue-attribute-filter.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(typeof status.protocolVersion).toBe('number')
    expect(typeof status.minCompatibleMobileVersion).toBe('number')
    expect(status.protocolVersion).toBeGreaterThanOrEqual(1)
    expect(status.minCompatibleMobileVersion).toBeGreaterThanOrEqual(0)
  })

  it('reports the configured Windows terminal shell on status', () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        terminalWindowsShell: 'wsl.exe'
      })
    } as never)

    expect(runtime.getStatus().terminalWindowsShell).toBe('wsl.exe')
  })

  it('reports floating workspace availability from settings on status', () => {
    expect(createRuntime().getStatus().floatingWorkspaceEnabled).toBe(true)

    const disabledRuntime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        floatingTerminalEnabled: false
      })
    } as never)
    expect(disabledRuntime.getStatus().floatingWorkspaceEnabled).toBe(false)
  })

  it('polls floating tabs with targeted PTY liveness and no repo/provider inventory', async () => {
    const getRepos = vi.fn(store.getRepos)
    const listProcesses = vi.fn().mockResolvedValue([])
    const floatingPtyId = `${FLOATING_TERMINAL_WORKTREE_ID}@@pty-1`
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeRepoId: null,
        activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-tab' },
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-tab',
              ptyId: floatingPtyId,
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              title: 'Floating Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'floating-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: floatingPtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService({ ...runtimeStore, getRepos } as never)
    const ptyController = {
      livePtyIds: new Set([floatingPtyId]),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasPty(this: { livePtyIds: Set<string> }, ptyId: string) {
        return this.livePtyIds.has(ptyId)
      },
      listProcesses
    }
    const hasPty = vi.spyOn(ptyController, 'hasPty')
    runtime.setPtyController(ptyController)

    const tabs = await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    const terminals = await runtime.listTerminals(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    await runtime.listTerminals(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)

    expect(tabs.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'floating-tab',
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
    expect(terminals.terminals).toEqual([
      expect.objectContaining({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        connected: true
      })
    ])
    expect(hasPty).toHaveBeenCalledTimes(4)
    expect(hasPty).toHaveBeenCalledWith(floatingPtyId)
    expect(listProcesses).not.toHaveBeenCalled()
    // Why: a floating tab's worktree id carries no repoId, so the hydrate repo gate
    // must never resolve the inventory for it — #9343 made that read eager and
    // regressed this poll path. Keep both halves of the contract asserted.
    expect(getRepos).not.toHaveBeenCalled()
  })

  it('hydrates persisted tabs when the store cannot report repos', async () => {
    // Why: #9343 read the repo gate as `getRepos?.() ?? []`, so a store that cannot
    // report its inventory looked like "every repo is gone" and hydrated nothing —
    // every tab vanished. An unavailable list must fail open; only a list the store
    // actually returned may prune a dead repo's session key.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getRepos: () => undefined
    } as never)

    const tabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(tabs.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'host-tab' })
    ])
  })

  it('advertises browser screencast only when a renderer window is available', () => {
    const runtime = createRuntime()
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)

    runtime.attachWindow(TEST_WINDOW_ID)

    expect(runtime.getStatus().capabilities).toContain('browser.screencast.v1')
  })

  it('advertises safe Codex reset-credit RPC support as a static capability', () => {
    const runtime = createRuntime()

    expect(runtime.getStatus().capabilities).toContain('accounts.codex-reset-credit.v1')
  })

  it('routes mobile Codex reset consumption through the account mutation coordinator', async () => {
    const runtime = createRuntime()
    const expectedScope = {
      target: { runtime: 'host' as const, wslDistro: null },
      accountId: 'codex-account',
      accountRevision: 42,
      offerRevision: 'v1:offer'
    }
    const capturedCodex = {
      accounts: [],
      activeAccountId: expectedScope.accountId,
      activeAccountIdsByRuntime: { host: expectedScope.accountId, wsl: {} }
    }
    const capturedRateLimits = {
      codexTarget: expectedScope.target,
      marker: 'captured-before-queue-advanced'
    }
    const codexAccounts = {
      consumeRateLimitResetCredit: vi.fn().mockResolvedValue({
        outcome: 'reset',
        scope: expectedScope,
        codex: capturedCodex,
        rateLimits: capturedRateLimits
      }),
      listAccounts: vi.fn(() => ({
        accounts: [],
        activeAccountId: 'queued-next-account',
        activeAccountIdsByRuntime: { host: 'queued-next-account', wsl: {} }
      }))
    }
    const rateLimits = {
      consumeCodexRateLimitResetCredit: vi.fn(),
      getState: vi.fn(() => ({
        codexTarget: expectedScope.target,
        marker: 'after-queue-advanced'
      }))
    }
    runtime.setAccountServices({
      claudeAccounts: {
        listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null }))
      },
      codexAccounts,
      rateLimits
    } as never)

    const result = await runtime.consumeCodexRateLimitResetCredit(
      '11111111-1111-4111-8111-111111111111',
      expectedScope
    )

    expect(result).toMatchObject({
      outcome: 'reset',
      scope: expectedScope,
      snapshot: { codex: capturedCodex, rateLimits: capturedRateLimits }
    })
    expect(codexAccounts.listAccounts).not.toHaveBeenCalled()
    expect(rateLimits.getState).not.toHaveBeenCalled()
    expect(codexAccounts.consumeRateLimitResetCredit).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expectedScope
    )
    expect(rateLimits.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('maps a definite pre-provider rejection into an authoritative current snapshot', async () => {
    const runtime = createRuntime()
    const expectedScope = {
      target: { runtime: 'host' as const, wslDistro: null },
      accountId: 'codex-account',
      accountRevision: 42,
      offerRevision: 'v1:stale'
    }
    const codex = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }
    const rateLimitState = {
      codexTarget: expectedScope.target,
      marker: 'current-after-rejection'
    }
    runtime.setAccountServices({
      claudeAccounts: {
        listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null }))
      },
      codexAccounts: {
        consumeRateLimitResetCredit: vi.fn().mockResolvedValue({
          status: 'rejectedBeforeProvider',
          retryDisposition: 'discardAttempt',
          reason: 'offerChanged',
          scope: expectedScope,
          codex,
          rateLimits: rateLimitState
        })
      },
      rateLimits: {}
    } as never)

    await expect(
      runtime.consumeCodexRateLimitResetCredit(
        '11111111-1111-4111-8111-111111111111',
        expectedScope
      )
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: expectedScope,
      snapshot: { codex, rateLimits: rateLimitState }
    })
  })

  it('advertises headless browser capability when an offscreen backend backs a windowless host', () => {
    const runtime = createRuntime()
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })

    const capabilities = runtime.getStatus().capabilities
    // Headless serve can still create/stream pages, so screencast is supported...
    expect(capabilities).toContain('browser.screencast.v1')
    // ...and the headless marker tells clients not to fall back to a local tab.
    expect(capabilities).toContain('browser.headless.v1')
    expect(capabilities).toContain('browser.certificate-trust.v1')
  })

  it('advertises only while headless browser commands remain live', () => {
    let available = true
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
      headless: true,
      isAvailable: () => available
    })
    const status = createRuntime().getStatus()

    expect(status.capabilities).toContain('browser.headless.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(status.capabilities).not.toContain('browser.certificate-trust.v1')
    expect(status.degradations).toBeUndefined()

    available = false
    const degraded = createRuntime().getStatus()
    expect(degraded.capabilities).not.toContain('browser.headless.v1')
    // A provider that resolved and then died is a health failure, never a config mistake.
    expect(degraded.degradations).toEqual([
      {
        code: 'browser_unavailable',
        capability: 'browser.headless.v1',
        reason: 'provider_unhealthy',
        message: 'The browser provider started but is no longer answering health checks.'
      }
    ])
  })
  it('surfaces live offscreen load failures in headless browser snapshots', () => {
    const runtime = createRuntime()
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-certificate-error',
            index: 0,
            url: 'https://localhost:3443/',
            title: 'Local HTTPS',
            active: true,
            loadError: {
              code: -202,
              description: 'ERR_CERT_AUTHORITY_INVALID',
              validatedUrl: 'https://localhost:3443/'
            },
            certificateFailure: {
              challengeId: 'challenge-1',
              browserPageId: 'page-certificate-error',
              errorCode: -202,
              error: 'ERR_CERT_AUTHORITY_INVALID',
              origin: 'https://localhost:3443',
              displayHost: 'localhost:3443',
              canProceed: true,
              observedAt: 123
            }
          }
        ]
      }))
    } as never)
    const browserTabs = runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)
    expect(browserTabs).toContainEqual(
      expect.objectContaining({
        type: 'browser',
        browserPageId: 'page-certificate-error',
        loadError: {
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/'
        },
        certificateFailure: {
          challengeId: 'challenge-1',
          browserPageId: 'page-certificate-error',
          errorCode: -202,
          error: 'ERR_CERT_AUTHORITY_INVALID',
          origin: 'https://localhost:3443',
          displayHost: 'localhost:3443',
          canProceed: true,
          observedAt: 123
        }
      })
    )
  })

  it('synthesizes runtime-owned client pages without a server browser backend', () => {
    const runtime = createRuntime()
    getRuntimeBrowserPageRegistry(runtime).publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      },
      url: 'https://remote.internal/',
      title: 'Remote app',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      active: true
    })

    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([
      {
        type: 'browser',
        id: 'page-client',
        title: 'Remote app',
        browserWorkspaceId: 'page-client',
        browserPageId: 'page-client',
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-a',
        placement: {
          kind: 'client',
          browserHostClientId: 'host-a',
          browserHostGeneration: 3,
          pageHostGeneration: 9
        },
        url: 'https://remote.internal/',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        isActive: true
      }
    ])
  })

  it('publishes a runtime-owned client page through the session-tab listener', () => {
    const runtime = createRuntime()
    runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: null,
      activeTabType: null,
      tabGroups: [{ id: 'group-1', activeTabId: null, tabOrder: [] }],
      tabs: []
    })
    const snapshots: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => snapshots.push(snapshot))
    getRuntimeBrowserPageRegistry(runtime).publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      },
      url: 'about:blank',
      loading: true,
      active: true
    })

    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

    expect(snapshots.at(-1)?.tabs).toContainEqual(
      expect.objectContaining({
        type: 'browser',
        browserPageId: 'page-client',
        loading: true,
        placement: expect.objectContaining({
          kind: 'client',
          browserHostClientId: 'host-a',
          pageHostGeneration: 9
        })
      })
    )
    unsubscribe()
  })

  it('preserves a live client page across headed renderer graph updates and prunes it after retirement', async () => {
    const runtime = createRuntime()
    const pages = getRuntimeBrowserPageRegistry(runtime)
    const placement = {
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    }
    runtime.attachWindow(1)
    const rendererSnapshot = (snapshotVersion: number) => ({
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:client-page-preservation',
      snapshotVersion,
      activeGroupId: 'group-1',
      activeTabId: null,
      activeTabType: null,
      tabGroups: [{ id: 'group-1', activeTabId: null, tabOrder: [] }],
      tabs: []
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(1)]
    })
    pages.publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement,
      url: 'https://remote.internal/',
      loading: false,
      active: true
    })
    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(2)]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ browserPageId: 'page-client', placement })
    ])

    expect(pages.retirePage('page-client', placement)).toBe(true)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(4)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('detects headless browser-tab changes by field, treating absent and null loadError alike', () => {
    const runtime = createRuntime()
    const base = {
      type: 'browser' as const,
      id: 'page-1',
      title: 'Local',
      browserWorkspaceId: 'page-1',
      browserPageId: 'page-1',
      url: 'https://localhost:3443/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true
    }
    const err = {
      code: -202,
      description: 'ERR_CERT_AUTHORITY_INVALID',
      validatedUrl: 'https://localhost:3443/'
    }
    const certificateFailure = {
      challengeId: 'challenge-1',
      browserPageId: 'page-1',
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    }
    const unchanged = (a: unknown[], b: unknown[]): boolean =>
      runtime['headlessBrowserTabsUnchanged'](a as never, b as never)

    // Absent vs explicit null loadError are equivalent (the JSON.stringify trap).
    expect(unchanged([{ ...base }], [{ ...base, loadError: null }])).toBe(true)
    expect(unchanged([{ ...base, loadError: err }], [{ ...base, loadError: { ...err } }])).toBe(
      true
    )
    // A load-error-only change (identical ids/order) must not be missed.
    expect(unchanged([{ ...base }], [{ ...base, loadError: err }])).toBe(false)
    expect(
      unchanged([{ ...base, loadError: err }], [{ ...base, loadError: { ...err, code: -200 } }])
    ).toBe(false)
    expect(
      unchanged(
        [{ ...base, certificateFailure }],
        [{ ...base, certificateFailure: { ...certificateFailure } }]
      )
    ).toBe(true)
    expect(unchanged([{ ...base }], [{ ...base, certificateFailure }])).toBe(false)
    expect(
      unchanged(
        [{ ...base, certificateFailure }],
        [{ ...base, certificateFailure: { ...certificateFailure, challengeId: 'challenge-2' } }]
      )
    ).toBe(false)
    // Scalar and length changes are detected.
    expect(unchanged([{ ...base }], [{ ...base, title: 'Changed' }])).toBe(false)
    expect(unchanged([{ ...base }], [{ ...base, isActive: false }])).toBe(false)
    expect(unchanged([{ ...base }], [{ ...base }, { ...base, id: 'page-2' }])).toBe(false)
  })

  it('does not advertise headless browser capability when a renderer window exists', () => {
    const runtime = createRuntime()
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })

    expect(runtime.getStatus().capabilities).not.toContain('browser.headless.v1')
    // Desktop webviews still host certificate trust, so the proceed capability stays advertised for remote clients controlling those pages.
    expect(runtime.getStatus().capabilities).toContain('browser.certificate-trust.v1')
  })

  it('declares browser unavailability when no browser provider resolves', async () => {
    setRuntimeBrowserCommandsFactory(null)
    const runtime = createRuntime()
    const status = runtime.getStatus()

    expect(status.capabilities).not.toContain('browser.headless.v1')
    expect(status.capabilities).not.toContain('browser.certificate-trust.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(status.degradations).toEqual([
      {
        code: 'browser_unavailable',
        capability: 'browser.headless.v1',
        reason: 'unknown',
        message:
          'Browser automation is unavailable on this host, and the cause could not be determined.'
      }
    ])
    const browserCalls = Object.entries(runtime).filter(
      ([name, value]) => /^browser[A-Z]/.test(name) && typeof value === 'function'
    )
    expect(browserCalls.length).toBeGreaterThan(50)
    for (const [name, call] of browserCalls) {
      const invoke =
        name === 'browserScreencast'
          ? () =>
              (call as CallableFunction)(
                { format: 'jpeg' },
                { sendBinary: () => true, emit: () => undefined }
              )
          : () => (call as CallableFunction)({})
      await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({
        code: 'browser_unavailable'
      })
    }
  })

  it('reports the driver as missing instead of telling a configured operator to configure it', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'driver_missing' })

    const [degradation] = createRuntime().getStatus().degradations ?? []

    expect(degradation).toEqual({
      code: 'browser_unavailable',
      capability: 'browser.headless.v1',
      reason: 'driver_missing',
      message:
        'ORCA_BROWSER_EXECUTABLE is set, but the bundled agent-browser driver is missing or not executable on this host, so Chromium cannot be driven.'
    })
    // The whole point: never send someone to set a variable they already set.
    expect(degradation?.message).not.toMatch(/set ORCA_BROWSER_EXECUTABLE/)
  })

  it('carries the underlying error to the client when a provider failed to start', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({
      reason: 'electron_start_failed',
      detail: 'sidecar exited with code 1'
    })

    const [degradation] = createRuntime().getStatus().degradations ?? []

    expect(degradation).toEqual({
      code: 'browser_unavailable',
      capability: 'browser.headless.v1',
      reason: 'electron_start_failed',
      detail: 'sidecar exited with code 1',
      message:
        'The installed Electron browser provider failed to start. (sidecar exited with code 1)'
    })
  })

  it('blames the missing desktop window when a renderer-backed factory is installed', () => {
    const [degradation] = createRuntime().getStatus().degradations ?? []

    expect(degradation).toMatchObject({
      reason: 'desktop_window_unavailable',
      message: 'Browser automation on this host needs a desktop window, and none is available.'
    })
  })

  it('keeps the degradation wire-safe for peers that predate structured causes', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'executable_not_found', detail: '/nope/chromium' })

    const [degradation] = createRuntime().getStatus().degradations ?? []

    // Old clients read only these three: the closed code must not move and the human
    // sentence must stand alone without the optional fields.
    expect(degradation?.code).toBe('browser_unavailable')
    expect(degradation?.capability).toBe('browser.headless.v1')
    expect(degradation?.message).toBe(
      'ORCA_BROWSER_EXECUTABLE points at a path that does not exist. (/nope/chromium)'
    )
  })

  it('reports a host that cannot load node-pty, instead of that host never answering', () => {
    // The alternative to reporting it is the process dying inside the dynamic loader,
    // which reaches a client as a dropped connection with no cause attached.
    setRuntimeTerminalUnavailableCause({
      reason: 'libc_floor',
      detail: 'the binary requires GLIBC_2.34'
    })

    const degradations = createRuntime().getStatus().degradations ?? []

    expect(degradations).toContainEqual({
      code: 'terminal_unavailable',
      capability: 'terminal.pty.v1',
      reason: 'libc_floor',
      detail: 'the binary requires GLIBC_2.34',
      message:
        "This host's node-pty binary was built against a newer C library than the host provides, so the dynamic loader refuses it. Rebuild node-pty on this host, or deploy a build whose prebuilt binary matches this platform's libc. (the binary requires GLIBC_2.34)"
    })
  })

  it('reports browser and terminal loss together, because they fail independently', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'unconfigured' })
    setRuntimeTerminalUnavailableCause({ reason: 'dependency_missing' })

    const codes = (createRuntime().getStatus().degradations ?? []).map((entry) => entry.code)

    expect(codes).toEqual(['browser_unavailable', 'terminal_unavailable'])
  })

  it('says nothing about terminals when no precondition proved them broken', () => {
    // Silence must mean "nothing proved it broken", never "proved working" — a host that
    // never ran the precondition has no verdict to publish.
    const degradations = createRuntime().getStatus().degradations ?? []
    expect(degradations.map((entry) => entry.code)).not.toContain('terminal_unavailable')
  })

  it('closes a worktree’s offscreen browser pages when its metadata is removed (leak fix)', () => {
    const runtime = createRuntime()
    const closeTab = vi.fn().mockResolvedValue(undefined)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn((worktreeId: string) =>
        worktreeId === TEST_WORKTREE_ID
          ? { tabs: [{ browserPageId: 'page-a' }, { browserPageId: 'page-b' }] }
          : { tabs: [] }
      )
    } as never)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(closeTab).toHaveBeenCalledWith('page-a')
    expect(closeTab).toHaveBeenCalledWith('page-b')
    expect(closeTab).toHaveBeenCalledTimes(2)
  })

  it('closes a worktree’s client-hosted browser pages when its metadata is removed (leak fix)', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    const removed = await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    const survivor = await publishClientHostedPage(
      runtime,
      host,
      'page-other',
      `${TEST_REPO_ID}::/tmp/other`
    )

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(host.takeCommands()).toEqual([
      expect.objectContaining({
        browserPageId: 'page-removed',
        pageHostGeneration: removed.pageHostGeneration,
        command: {
          type: 'closePage',
          targetAuthority: {
            authorityRuntimeId: runtime.getRuntimeId(),
            authorityEpoch: getBrowserHostLeaseRegistry(runtime).authorityEpoch,
            browserHostClientId: removed.browserHostClientId,
            browserHostGeneration: removed.browserHostGeneration,
            pageHostGeneration: removed.pageHostGeneration
          }
        }
      })
    ])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-other')?.placement).toEqual(
      survivor
    )
  })

  it('does not republish a removed worktree’s client tabs to a same-id recreate', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    // The store's surviving metadata stands in for a recreate at the same path: the ID resolves again.
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('drops a client page record even when its close command cannot be issued', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    // The client's command transport is gone but its lease has not fenced yet.
    host.detachDelivery()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    // The close really did fail, and its rejection was reported rather than left unhandled.
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not close its client page'),
        expect.objectContaining({
          browserPageId: 'page-removed',
          error: expect.objectContaining({ message: 'browser_host_command_delivery_required' })
        })
      )
    )
    warn.mockRestore()
  })

  it('leaves client-hosted pages alone when another host still owns the same worktree id', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const host = attachClientBrowserHost(runtime)
    const placement = await publishClientHostedPage(runtime, host, 'page-kept', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](
      runtimeStore as never,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(host.takeCommands()).toEqual([])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-kept')?.placement).toEqual(
      placement
    )
  })

  function attachClientBrowserHost(runtime: OrcaRuntimeService) {
    const leases = getBrowserHostLeaseRegistry(runtime)
    let commands: BrowserClientHostCommandEvent[] = []
    const { lease } = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      pageReconciliationProtocolVersion: 1
    })
    const identity = {
      authorityEpoch: lease.authorityEpoch,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      pairedDeviceId: lease.pairedDeviceId
    }
    const detachDelivery = leases.attachCommandDelivery(identity, (event) => commands.push(event))
    return {
      detachDelivery,
      takeCommands(): BrowserClientHostCommandEvent[] {
        const taken = commands
        commands = []
        return taken
      },
      settleLatest(): void {
        const command = commands.at(-1)
        if (!command) {
          throw new Error('no command was delivered to the client host')
        }
        leases.settleClientPageCommand(
          { ...identity, connectionId: lease.connectionId },
          {
            authorityRuntimeId: command.authorityRuntimeId,
            authorityEpoch: command.authorityEpoch,
            browserHostClientId: command.browserHostClientId,
            browserHostGeneration: command.browserHostGeneration,
            pageCommandProtocolVersion: command.pageCommandProtocolVersion,
            ...(command.pageReconciliationProtocolVersion
              ? { pageReconciliationProtocolVersion: command.pageReconciliationProtocolVersion }
              : {}),
            browserPageId: command.browserPageId,
            pageHostGeneration: command.pageHostGeneration,
            commandSequence: command.commandSequence,
            commandId: command.commandId,
            result: { status: 'completed' }
          }
        )
      }
    }
  }

  async function publishClientHostedPage(
    runtime: OrcaRuntimeService,
    host: ReturnType<typeof attachClientBrowserHost>,
    browserPageId: string,
    workspaceId: string
  ): Promise<RuntimeBrowserClientPlacement> {
    const creation = getBrowserHostLeaseRegistry(runtime).createClientPage({
      browserPageId,
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:7'
    })
    host.settleLatest()
    const placement = await creation
    getRuntimeBrowserPageRegistry(runtime).publishClientPage({
      browserPageId,
      workspaceId,
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:7',
      placement,
      url: 'https://remote.internal/',
      loading: false,
      active: true
    })
    host.takeCommands()
    return placement
  }

  it('preserves bare-id runtime state when removing a different qualified owner', () => {
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const localSession = { tabs: [{ id: 'local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, localSession)

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'runtime:env-b')
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(localSession)
  })

  it('preserves bare-id runtime state when removed-host metadata masks another owner', () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, connectionId: 'ssh-1' }
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'ssh:ssh-1' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const survivingSession = { tabs: [{ id: 'same-id-local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, survivingSession)
    deleteWorktreeHistoryDirMock.mockClear()

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'ssh:ssh-1'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'ssh:ssh-1')
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(survivingSession)
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('rejects a qualified removal when only another host has persisted ownership', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      listResolvedWorktrees: () => Promise<unknown[]>
      resolveWorktreeRemovalTarget: (
        worktreeSelector: string,
        requiredHostId?: string
      ) => Promise<unknown>
    }
    internals.listResolvedWorktrees = vi.fn().mockResolvedValue([
      {
        id: TEST_WORKTREE_ID,
        repoId: TEST_REPO_ID,
        path: TEST_WORKTREE_PATH,
        hostId: 'local'
      }
    ])

    await expect(
      internals.resolveWorktreeRemovalTarget(TEST_WORKTREE_ID, 'runtime:env-b')
    ).rejects.toThrow('selector_not_found')
    expect(internals.listResolvedWorktrees).not.toHaveBeenCalled()
  })

  it('claims the first window as authoritative and ignores later windows', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.attachWindow(2)

    expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
  })

  it('transfers authority from the headless sentinel to the first real window', () => {
    const runtime = createRuntime()
    electronMocks.BrowserWindow.fromId.mockImplementation((windowId: number) =>
      windowId === TEST_WINDOW_ID ? ({ isDestroyed: () => false } as never) : null
    )
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.attachWindow(2)

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      desktopWindowStatus: 'available',
      graphStatus: 'reloading',
      rendererGraphEpoch: 1
    })
  })

  it('marks live headless PTYs for renderer reattach before desktop promotion', () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeWorktreeIdsOnShutdown: []
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })

    runtime.attachWindow(TEST_WINDOW_ID)

    expect(getSession().activeWorktreeIdsOnShutdown).toEqual([TEST_WORKTREE_ID])
  })

  it('marks live bindings again when reopening after a promoted window closes', () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeWorktreeIdsOnShutdown: []
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.attachWindow(TEST_WINDOW_ID)
    ;(runtimeStore.setWorkspaceSession as unknown as (next: WorkspaceSessionState) => void)({
      ...getSession(),
      activeWorktreeIdsOnShutdown: []
    })
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    runtime.attachWindow(2)

    expect(getSession().activeWorktreeIdsOnShutdown).toEqual([TEST_WORKTREE_ID])
  })

  it('preserves live SSH session identities when promoting a headless runtime', () => {
    const remotePtyId = 'ssh:ssh-1@@persisted-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeWorktreeIdsOnShutdown: [],
        activeConnectionIdsAtShutdown: [],
        remoteSessionIdsByTabId: {},
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: remotePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: remotePtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty(remotePtyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })

    runtime.attachWindow(TEST_WINDOW_ID)

    expect(getSession()).toMatchObject({
      activeWorktreeIdsOnShutdown: [TEST_WORKTREE_ID],
      activeConnectionIdsAtShutdown: ['ssh-1'],
      remoteSessionIdsByTabId: { 'host-tab': remotePtyId }
    })
  })

  it('reports the activation gate state while no desktop window is available', () => {
    const runtime = new OrcaRuntimeService(store, undefined, {
      getDesktopWindowStatus: () => 'blocked'
    })

    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    expect(runtime.getStatus().desktopWindowStatus).toBe('blocked')
  })

  it('bumps the epoch and enters reloading when the authoritative window reloads', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'reloading',
      rendererGraphEpoch: 1
    })
  })

  it('can mark the graph ready for the authoritative window', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('restores a surviving renderer when its reload is cancelled', () => {
    const runtime = createRuntime()
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    const fence = runtime.markRendererReloading(TEST_WINDOW_ID)
    if (fence === null) {
      throw new Error('expected active renderer reload fence')
    }

    expect(fence.recovery).toBe('renderer')
    expect(runtime.getStatus().graphStatus).toBe('reloading')
    expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, fence)).toBe(true)
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('keeps an earlier committed reload fenced when a later reload is cancelled', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      const committedFence = runtime.markRendererReloading(TEST_WINDOW_ID)
      const cancelledFence = runtime.markRendererReloading(TEST_WINDOW_ID)
      if (committedFence === null || cancelledFence === null) {
        throw new Error('expected active renderer reload fences')
      }

      expect(cancelledFence.recovery).toBe('reloading')
      expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, committedFence)).toBe(false)
      expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, cancelledFence)).toBe(false)
      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS - 1)
      expect(runtime.getStatus().graphStatus).toBe('reloading')
      await vi.advanceTimersByTimeAsync(1)
      expect(runtime.getStatus().graphStatus).toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores headless authority when desktop promotion navigation is cancelled', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    const fence = runtime.markRendererReloading(TEST_WINDOW_ID)
    if (fence === null) {
      throw new Error('expected active promotion reload fence')
    }

    expect(fence.recovery).toBe('headless')
    expect(runtime.markRendererReloadCancelled(TEST_WINDOW_ID, fence)).toBe(false)
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('drops back to unavailable and clears authority when the window disappears', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      rendererGraphEpoch: 2
    })
  })

  it('restores headless graph authority after a promoted renderer reload times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      runtime.attachWindow(TEST_WINDOW_ID)

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
        graphStatus: 'ready'
      })
      expect((await runtime.listTerminals()).terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ptyId: 'persisted-pty', connected: true, writable: true })
        ])
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves a desktop graph to unavailable when its reload times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      runtime.markRendererReloading(TEST_WINDOW_ID)

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: TEST_WINDOW_ID,
        graphStatus: 'unavailable',
        rendererGraphEpoch: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers a failed headless promotion and accepts a later renderer generation', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)

    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })

    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('retires the headless fallback after renderer promotion succeeds', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'unavailable'
    })

    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('does not let a superseded reload timeout overwrite a newer renderer graph', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createRuntime()
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      runtime.markRendererReloading(TEST_WINDOW_ID)
      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS / 2)
      runtime.markRendererReloading(TEST_WINDOW_ID)

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS / 2)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: TEST_WINDOW_ID,
        graphStatus: 'reloading'
      })

      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS / 2)

      expect(runtime.getStatus()).toMatchObject({
        authoritativeWindowId: TEST_WINDOW_ID,
        graphStatus: 'unavailable'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a same-frame graph publication from the superseded renderer generation', () => {
    const runtime = createRuntime()
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer-a'
    })
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(() =>
      runtime.syncWindowGraph(TEST_WINDOW_ID, {
        tabs: [],
        leaves: [],
        rendererGeneration: 'renderer-a'
      })
    ).toThrow('Runtime graph publisher belongs to a superseded renderer generation')
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: TEST_WINDOW_ID,
      graphStatus: 'reloading'
    })
  })

  it('keeps a restored headless graph pinned to the failed promotion window', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    expect(() =>
      runtime.syncWindowGraph(2, {
        tabs: [],
        leaves: [],
        rendererGeneration: 'renderer-b'
      })
    ).toThrow('Runtime graph publisher does not match the pending desktop promotion')
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })
  })

  it('stays unavailable during initial loads before a graph is published', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      rendererGraphEpoch: 0
    })
  })

  it('lists live terminals and issues stable handles for synced leaves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'epoch-terminal-handle',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello from terminal\n', 123)

    const terminals = await runtime.listTerminals('branch:feature/foo')
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: 'repo-1::/tmp/worktree-a',
      branch: 'feature/foo',
      ptyId: 'pty-1',
      title: 'Claude',
      preview: 'hello from terminal'
    })

    const shown = await runtime.showTerminal(terminals.terminals[0].handle)
    expect(shown.handle).toBe(terminals.terminals[0].handle)
    expect(shown.ptyId).toBe('pty-1')
    const mobileTabs = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileHandle = mobileTabs.tabs.find((tab) => tab.type === 'terminal')?.terminal
    if (!mobileHandle) {
      throw new Error('expected mobile terminal handle')
    }

    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await runtime.sleepTerminalsForWorktree('branch:feature/foo')
    expect(
      events.find(
        (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'started'
      )
    ).toMatchObject({
      terminalHandles: [terminals.terminals[0].handle, mobileHandle].sort()
    })
  })

  it('routes a launch-draft resolution to the handle-owning local and remote renderers', async () => {
    const runtime = new OrcaRuntimeService(store)
    const nativeChatLaunchDraftResolved = vi.fn()
    const events: RuntimeClientEvent[] = []
    runtime.setNotifier({ nativeChatLaunchDraftResolved } as never)
    runtime.onClientEvent((event) => events.push(event))
    runtime.attachWindow(1)
    const graph: RuntimeSyncWindowGraph = {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'launch-draft-epoch',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude',
              launchDraft: 'seed',
              launchDraftCreatedAt: 7,
              isActive: true
            }
          ]
        }
      ]
    }
    runtime.syncWindowGraph(1, graph)
    const listed = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileTab = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!mobileTab?.terminal) {
      throw new Error('expected mobile terminal handle')
    }
    expect(mobileTab).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 7 })

    runtime.notifyNativeChatLaunchDraftResolved(mobileTab.terminal, {
      text: 'seed',
      createdAt: 7
    })

    expect(nativeChatLaunchDraftResolved).toHaveBeenCalledWith('tab-1', {
      text: 'seed',
      createdAt: 7
    })
    expect(events).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    expect(runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot()).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    const retired = (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
      (tab) => tab.type === 'terminal'
    )
    expect(retired).not.toHaveProperty('launchDraft')
    expect(retired).not.toHaveProperty('launchDraftCreatedAt')

    runtime.markRendererReloading(1)
    const replay = runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 2
      }))
    })
    expect(replay.nativeChatLaunchDraftResolutions).toEqual([
      { tabId: 'tab-1', text: 'seed', createdAt: 7 }
    ])
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).not.toHaveProperty('launchDraft')

    const reconciled = runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 3,
        tabs: snapshot.tabs.map((tab) => {
          if (tab.type !== 'terminal') {
            return tab
          }
          return { ...tab, launchDraftCreatedAt: 8 }
        })
      }))
    })
    expect(reconciled.nativeChatLaunchDraftResolutions).toBeUndefined()
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 8 })
  })

  it('surfaces stale terminal handles for stranded panes and recovers after same-pane wake', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-before-sleep'
        }
      ]
    })

    const beforeSleep = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const staleHandle = beforeSleep.terminals[0]?.handle ?? ''
    expect(staleHandle).toBeTruthy()

    // Why: `terminal.show` is read-only; only a later renderer wake/rebind graph publish can repair this pane's CLI handle surface.
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })

    await expect(runtime.showTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-after-wake'
        }
      ]
    })
    runtime.onPtyData('pty-after-wake', 'resumed in place\n', 123)

    const resolved = runtime.resolveTerminalPane(paneKey)
    expect(resolved).toMatchObject({
      tabId,
      leafId,
      ptyId: 'pty-after-wake'
    })
    await expect(runtime.showTerminal(resolved.handle)).resolves.toMatchObject({
      handle: resolved.handle,
      tabId,
      leafId,
      ptyId: 'pty-after-wake',
      preview: 'resumed in place'
    })
  })

  it('rejects pane resolution when leaf and PTY ownership disagree', () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-mismatched-owner'
        }
      ]
    })
    runtime.registerPty('pty-mismatched-owner', `${TEST_REPO_ID}::/tmp/other-worktree`)

    expect(() => runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID)).toThrow(
      'terminal_not_found'
    )
  })

  it('recovers a disconnected pane through one HUB-owned replacement', async () => {
    const tabId = 'tab-recover'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).resolves.toMatchObject({
      handle: 'term-replacement',
      tabId,
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID
    })
    // persistHostSessionBinding is no longer a per-call opt-in: createTerminal
    // is host-initiated by construction and always persists its binding.
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('rejects missing host panes without authoritative expired binding evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-missing'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-created',
      tabId,
      paneKey,
      ptyId: 'pty-created',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID)).rejects.toThrow(
      'terminal_not_found'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('rejects recovery for live panes and mismatched worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-live'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-live', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const liveHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, liveHandle)
    ).rejects.toThrow('terminal_not_recoverable')
    await expect(
      runtime.recoverTerminalPane(paneKey, `${TEST_REPO_ID}::/other`, liveHandle)
    ).rejects.toThrow('terminal_not_found')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('returns an already-connected replacement instead of spawning another pane', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-cas'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-old', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const oldHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-old', 0)
    runtime.registerPty('pty-new', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const recovered = await runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, oldHandle)

    expect(recovered.handle).not.toBe(oldHandle)
    expect(recovered.ptyId).toBe('pty-new')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent pane recovery across stale viewer handles', async () => {
    const tabId = 'tab-concurrent'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    let finishCreate!: (result: RuntimeTerminalCreate) => void
    const pendingCreate = new Promise<RuntimeTerminalCreate>((resolve) => {
      finishCreate = resolve
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockReturnValue(pendingCreate)

    const first = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    const second = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, 'term-other-viewer')
    finishCreate({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(first).resolves.toEqual(expect.objectContaining({ handle: 'term-replacement' }))
    await expect(second).rejects.toThrow('terminal_not_found')
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('clears a failed pane recovery so a later reconnect can retry', async () => {
    const tabId = 'tab-retry'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValueOnce(new Error('relay_reconnecting'))
      .mockResolvedValueOnce({
        handle: 'term-retry',
        tabId,
        paneKey,
        ptyId: 'pty-retry',
        worktreeId: TEST_WORKTREE_ID,
        title: null,
        surface: 'background'
      })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).rejects.toThrow('relay_reconnecting')
    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).resolves.toMatchObject({ handle: 'term-retry' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('does not recover a pane whose authoritative SSH lease was terminated', async () => {
    const tabId = 'tab-terminated'
    const runtime = createRuntimeWithSshLease('pty-terminated', tabId, 'terminated')
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-terminated', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-terminated', 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('drops a stale leaf when a woken agent PTY is re-keyed to a new leaf on renderer reload', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Why: the agent's pre-allocated ORCA_TERMINAL_HANDLE gives its PTY a handleByPtyId entry — the condition the reload preservation loop keys on.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)

    // Simulate agent sleep + mobile wake: the renderer cold-restores the pane under a NEW leafId while the SAME agent PTY stays live.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    // Before the fix two leaves shared one PTY, so both adopted the same ptyId-keyed handle and paired clients crashed on a duplicate React key.
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
    // The shared handle must NOT have been invalidated — it belongs to leaf-new now.
    await expect(runtime.showTerminal(after.terminals[0].handle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })
  })

  it('still preserves a CLI agent leaf when the reloaded renderer has not rebound its PTY', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    expect((await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals).toHaveLength(1)

    // Renderer reloads but hasn't rebound the pane (empty graph); the live CLI agent PTY + exported handle must survive.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
  })

  it('invalidates a re-keyed leaf-unique handle so in-flight waiters fail fast', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // No preAllocateHandleForPty: a plain terminal's handle is leaf-unique, so a re-key leaves it with no next owner and it goes stale immediately.
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-plain'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)
    const staleHandle = before.terminals[0].handle
    const waiting = runtime.waitForTerminal(staleHandle, { condition: 'exit', timeoutMs: 30_000 })

    // Re-key WITHOUT a renderer reload (e.g. a pane moved across tabs) while the same PTY stays live under a new leaf.
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-plain'
        }
      ]
    })

    // The waiter must fail fast, not hang until timeout on a dead leaf.
    await expect(waiting).rejects.toThrow('terminal_handle_stale')
    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].handle).not.toBe(staleHandle)
  })

  it('keeps a live CLI waiter pending when a re-keyed shared handle transfers to the live leaf', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Unlike the leaf-unique case, a shared ptyId-keyed handle re-keyed to a live leaf must transfer WITHOUT rejecting the in-flight CLI waiter.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const sharedHandle = before.terminals[0].handle
    const abort = new AbortController()
    let settled: 'resolved' | 'rejected' | null = null
    const waiting = runtime
      .waitForTerminal(sharedHandle, {
        condition: 'exit',
        timeoutMs: 30_000,
        signal: abort.signal
      })
      .then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      )

    // Re-key WITHOUT a renderer reload while the same agent PTY stays live under a new leaf.
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    // Let any synchronous stale-handle rejection propagate.
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The shared handle belongs to leaf-new now, so the CLI's live waiter must stay pending (a blanket invalidateLeafHandle would reject it as stale).
    expect(settled).toBeNull()
    // The same handle still resolves to the live PTY under the new leaf.
    await expect(runtime.showTerminal(sharedHandle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })

    // Abort only for teardown; the assertion above already proved it was pending.
    abort.abort()
    await waiting
    expect(settled).toBe('rejected')
  })

  it('emits one mobile session terminal tab per live PTY even if two tabs resolve to it', () => {
    const runtime = createRuntime()
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state?: Record<string, unknown>
      ) => void
      mobileSessionTabsByWorktree: Map<string, unknown>
      getMobileSessionTabsForWorktree: (worktreeId: string) => {
        tabs: { type: string; terminal?: string | null }[]
      }
    }
    // Two unclaimed live PTYs on the worktree; the worktree-only fallback binds either to a leafless tab that references it.
    internals.recordPtyWorktree('pty-shared', TEST_WORKTREE_ID, { connected: true })
    internals.recordPtyWorktree('pty-other', TEST_WORKTREE_ID, { connected: true })

    const terminalTab = (leafId: string, ptyId: string) => ({
      type: 'terminal' as const,
      id: `term_dup::${leafId}`,
      parentTabId: 'term_dup',
      leafId,
      ptyId,
      title: 'Agent',
      isActive: leafId === 'leaf-new'
    })

    // Two records (stale headless leaf + live leaf) both resolve to the SAME live PTY — the renderer-graph origin the leaf fix can't reach.
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:test:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'term_dup::leaf-new',
      activeTabType: 'terminal',
      tabs: [terminalTab('leaf-new', 'pty-shared'), terminalTab('leaf-old', 'pty-shared')]
    })
    const deduped = internals.getMobileSessionTabsForWorktree(TEST_WORKTREE_ID)
    const dedupedTerminals = deduped.tabs.filter((tab) => tab.type === 'terminal')
    expect(dedupedTerminals).toHaveLength(1)
    expect(dedupedTerminals[0].terminal).toBeTruthy()

    // Split siblings own DISTINCT PTYs, so they must never be collapsed.
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:test:2',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: 'term_dup::leaf-new',
      activeTabType: 'terminal',
      tabs: [terminalTab('leaf-new', 'pty-shared'), terminalTab('leaf-old', 'pty-other')]
    })
    const split = internals.getMobileSessionTabsForWorktree(TEST_WORKTREE_ID)
    expect(split.tabs.filter((tab) => tab.type === 'terminal')).toHaveLength(2)
  })

  it('resolves projected split authority from the parent layout PTY binding', () => {
    const runtime = createRuntime()
    const tabId = 'projected-parent-tab'
    const leafId = 'projected-leaf'
    const ptyId = 'projected-pty'
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      resolveTerminalSplitSourceAuthority: (
        worktreeId: string,
        tabId: string,
        leafId: string,
        ptyId: string
      ) => { persisted: boolean; rendererMounted: boolean } | null
    }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      tabs: [
        {
          type: 'terminal',
          parentTabId: tabId,
          leafId,
          ptyId: null,
          parentLayout: { ptyIdsByLeafId: { [leafId]: ptyId } }
        }
      ]
    })

    expect(
      internals.resolveTerminalSplitSourceAuthority(TEST_WORKTREE_ID, tabId, leafId, ptyId)
    ).toMatchObject({ persisted: false, rendererMounted: false })
  })

  it('keeps targeted terminal lists from adopting controller PTYs for other worktrees', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: '/tmp/worktree-b',
        head: 'def',
        branch: 'feature/bar',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/tmp/worktree-a/nested',
        head: 'ghi',
        branch: 'feature/nested',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'target-controller-pty', cwd: '/tmp/worktree-a/src', title: 'target' },
        { id: 'other-controller-pty', cwd: '/tmp/worktree-b/src', title: 'other' },
        {
          id: 'repo-1::/tmp/worktree-b@@other-controller-pty',
          cwd: '/tmp/worktree-a/src',
          title: 'prefixed other'
        },
        { id: 'nested-controller-pty', cwd: '/tmp/worktree-a/nested/src', title: 'nested' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals(`path:${TEST_WORKTREE_PATH}`)

    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      worktreePath: TEST_WORKTREE_PATH
    })
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('target-controller-pty')).toBe(true)
    expect(internals.ptysById.has('other-controller-pty')).toBe(false)
    expect(internals.ptysById.has('repo-1::/tmp/worktree-b@@other-controller-pty')).toBe(false)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id terminal lists from resolving all worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('all-worktree resolution should be skipped')
    )
    const runtime = createRuntime()
    const ptyId = `${TEST_WORKTREE_ID}@@daemon-controller-pty`
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: ptyId, cwd: '/unresolved/cwd', title: 'daemon shell' },
        { id: 'cwd-only-pty', cwd: TEST_WORKTREE_PATH, title: 'cwd shell' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([
      TEST_WORKTREE_ID,
      TEST_WORKTREE_ID
    ])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has(ptyId)).toBe(true)
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
  })

  it('matches explicit-id cwd PTYs when the resolved worktree cache is incomplete', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/worktree-a/nested',
        head: 'ghi',
        branch: 'feature/nested',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    await runtime.listTerminals()
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' },
        { id: 'nested-controller-pty', cwd: `${TEST_WORKTREE_PATH}/nested/src`, title: 'nested' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id cold-cache terminal lists from adopting nested worktree PTYs', async () => {
    const nestedWorktreeId = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}/nested`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [nestedWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        ({
          [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
          [nestedWorktreeId]: makeWorktreeMeta()
        })[worktreeId]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' },
        { id: 'nested-controller-pty', cwd: `${TEST_WORKTREE_PATH}/nested/src`, title: 'nested' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id cold-cache terminal lists from classifying unrelated same-repo worktrees', async () => {
    const siblingWorktreePath = '/tmp/worktree-sibling'
    const siblingWorktreeId = `${TEST_REPO_ID}::${siblingWorktreePath}`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [siblingWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        ({
          [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
          [siblingWorktreeId]: makeWorktreeMeta()
        })[worktreeId]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'target-cwd-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'target' },
        { id: 'sibling-cwd-pty', cwd: `${siblingWorktreePath}/src`, title: 'sibling' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('target-cwd-pty')).toBe(true)
    expect(internals.ptysById.has('sibling-cwd-pty')).toBe(false)
  })

  it('ignores cwd-only controller PTYs for malformed explicit worktree IDs', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('malformed explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_REPO_ID}::`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals).toEqual([])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(false)
  })

  it('keeps unknown bare terminal-list ids on the no-scan exact-id path', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('unknown explicit ids should not rescan worktrees')
    )
    const runtime = createRuntime()

    await expect(runtime.listTerminals('id:not-a-repo')).resolves.toMatchObject({
      terminals: [],
      totalCount: 0
    })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('matches explicit-id cwd PTYs for folder workspace instance IDs', async () => {
    const folderWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('folder explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'folder-cwd-pty', cwd: `${TEST_FOLDER_WORKSPACE_PATH}/src`, title: 'folder shell' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${folderWorktreeId}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([folderWorktreeId])
    expect(terminals.terminals[0]?.worktreePath).toBe(TEST_FOLDER_WORKSPACE_PATH)
  })

  it('keeps same-path folder workspace instance PTYs scoped to their exact ids', async () => {
    const firstWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    const secondWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}22222222-2222-4222-8222-222222222222`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('folder explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'first-folder-pty',
          cwd: TEST_FOLDER_WORKSPACE_PATH,
          title: 'first',
          worktreeId: firstWorktreeId
        },
        {
          id: 'second-folder-pty',
          cwd: TEST_FOLDER_WORKSPACE_PATH,
          title: 'second',
          worktreeId: secondWorktreeId
        }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${secondWorktreeId}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      ptyId: 'second-folder-pty',
      worktreeId: secondWorktreeId,
      worktreePath: TEST_FOLDER_WORKSPACE_PATH
    })
    const internals = runtime as unknown as {
      ptysById: Map<string, { worktreeId: string }>
    }
    expect(internals.ptysById.get('first-folder-pty')).toBeUndefined()
    expect(internals.ptysById.get('second-folder-pty')?.worktreeId).toBe(secondWorktreeId)
  })

  it('routes PTY output through the PTY leaf index in large terminal graphs', () => {
    const runtime = new OrcaRuntimeService(store)
    const liveLeafCount = 2773
    const targetIndex = liveLeafCount - 17
    const tabs = Array.from({ length: liveLeafCount }, (_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: `repo-1::/tmp/worktree-${index}`,
      title: `Terminal ${index}`,
      activeLeafId: 'pane:1',
      layout: null
    }))
    const leaves = Array.from({ length: liveLeafCount }, (_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: `repo-1::/tmp/worktree-${index}`,
      leafId: 'pane:1',
      paneRuntimeId: 1,
      ptyId: `pty-${index}`
    }))

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs, leaves })

    const runtimePrivate = runtime as unknown as {
      leaves: Map<string, unknown>
      leavesByPtyId: Map<string, { preview?: string; lastOutputAt?: number | null }[]>
    }
    const originalLeaves = runtimePrivate.leaves
    runtimePrivate.leaves = new Proxy(originalLeaves, {
      get(target, prop) {
        if (
          prop === 'values' ||
          prop === 'entries' ||
          prop === 'keys' ||
          prop === Symbol.iterator
        ) {
          return () => {
            throw new Error('onPtyData should use the PTY leaf index')
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as Map<string, unknown>

    runtime.onPtyData(`pty-${targetIndex}`, 'hello indexed\n', 123)

    const [targetLeaf] = runtimePrivate.leavesByPtyId.get(`pty-${targetIndex}`) ?? []
    expect(targetLeaf).toMatchObject({
      preview: 'hello indexed',
      lastOutputAt: 123
    })
    expect(runtime.getStatus().liveLeafCount).toBe(liveLeafCount)
  })

  it('resolves branch selectors when worktrees store refs/heads-prefixed branches', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'refs/heads/Jinwoo-H/test-3a',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const runtime = new OrcaRuntimeService(store)

    const worktree = await runtime.showManagedWorktree('branch:Jinwoo-H/test-3a')
    expect(worktree).toMatchObject({
      branch: 'refs/heads/Jinwoo-H/test-3a',
      path: '/tmp/worktree-a'
    })
  })

  it('resolves name selectors against worktree display names', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: TEST_WORKTREE_PATH,
        head: 'abc',
        branch: 'refs/heads/wolfiesch/orca-skill-smoke',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const runtime = new OrcaRuntimeService(store)

    const worktree = await runtime.showManagedWorktree('name:foo')
    expect(worktree).toMatchObject({
      displayName: 'foo',
      path: TEST_WORKTREE_PATH
    })
  })

  it('routes SSH-backed forward-slash UNC file and git paths without collapsing the root', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(new Error('local git should not run for SSH repos'))
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '//Server/Share/Repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const fsProvider = { readDir: vi.fn().mockResolvedValue([]) }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '//Server/Share/Repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      getStatus: vi.fn().mockResolvedValue({
        branch: 'feature/foo',
        files: [],
        ahead: 0,
        behind: 0,
        hasConflicts: false
      })
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.readFileExplorerDir('path://server/share/repo', 'src')
      await runtime.getRuntimeGitStatus('path://server/share/repo')
      await expect(runtime.showRepo('path://server/share/repo')).resolves.toMatchObject({
        path: '//Server/Share/Repo'
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('//Server/Share/Repo')
    expect(fsProvider.readDir).toHaveBeenCalledWith('\\\\Server\\Share\\Repo\\src')
    expect(gitProvider.getStatus).toHaveBeenCalledWith('//Server/Share/Repo')
  })

  it.each([
    { label: 'canonical folder workspace selector', selector: TEST_FOLDER_WORKSPACE_KEY },
    { label: 'id-prefixed folder workspace selector', selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
  ])('reads file explorer paths for a $label', async ({ selector }) => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-files-'))
    await mkdir(join(folderPath, 'src'))
    await writeFile(join(folderPath, 'src', 'app.ts'), 'export {}\n')
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )

    await expect(runtime.readFileExplorerDir(selector, 'src')).resolves.toContainEqual({
      name: 'app.ts',
      isDirectory: false,
      isSymlink: false
    })
    await expect(runtime.readFileExplorerPreview(selector, 'src/app.ts')).resolves.toMatchObject({
      content: 'export {}\n',
      isBinary: false
    })
  })

  it('routes SSH folder workspace file explorer paths through the filesystem provider', async () => {
    const folderPath = '/srv/platform'
    const fsProvider = {
      stat: vi.fn(async (pathValue: string) => ({
        size: pathValue.endsWith('/app.ts') ? 8 : 0,
        type: pathValue.endsWith('/app.ts') ? 'file' : 'directory',
        mtime: 1
      })),
      readDir: vi.fn().mockResolvedValue([
        {
          name: 'app.ts',
          isDirectory: false,
          isSymlink: false
        }
      ]),
      readFile: vi.fn().mockResolvedValue({ content: 'remote\n', isBinary: false })
    }
    const folderWorkspace = makeFolderWorkspace({ folderPath, connectionId: 'ssh-folder' })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    registerSshFilesystemProvider('ssh-folder', fsProvider as never)

    try {
      await expect(
        runtime.readFileExplorerDir(`id:${TEST_FOLDER_WORKSPACE_KEY}`, 'src')
      ).resolves.toHaveLength(1)
      await expect(
        runtime.readFileExplorerPreview(`id:${TEST_FOLDER_WORKSPACE_KEY}`, 'src/app.ts')
      ).resolves.toMatchObject({
        content: 'remote\n',
        isBinary: false
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-folder')
    }

    expect(fsProvider.stat).toHaveBeenCalledWith(folderPath)
    expect(fsProvider.readDir).toHaveBeenCalledWith('/srv/platform/src')
    expect(fsProvider.stat).toHaveBeenCalledWith('/srv/platform/src/app.ts')
    expect(fsProvider.readFile).toHaveBeenCalledWith('/srv/platform/src/app.ts', {
      maxBinaryBytes: 10 * 1024 * 1024,
      maxTextBytes: 512 * 1024
    })
  })

  it('lists persisted SSH worktrees while the git provider is unavailable', async () => {
    vi.mocked(listWorktrees).mockClear()
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-missing'
    }
    const mainId = `${remoteRepo.id}::/home/user/repo`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [mainId]: makeWorktreeMeta({ displayName: 'Remote main' }),
      [childId]: makeWorktreeMeta({ displayName: 'Remote child', linkedPR: 42 })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listManagedWorktrees('id:remote-repo')

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-missing')
    expect(listed).toMatchObject({
      totalCount: 2,
      truncated: false,
      worktrees: [
        {
          id: mainId,
          hostId: 'ssh:ssh-missing',
          path: '/home/user/repo',
          branch: '',
          isMainWorktree: true,
          displayName: 'Remote main'
        },
        {
          id: childId,
          hostId: 'ssh:ssh-missing',
          path: '/home/user/repo-child',
          branch: '',
          isMainWorktree: false,
          displayName: 'Remote child',
          linkedPR: 42
        }
      ]
    })
  })

  it('does not interpret active as a runtime-global worktree selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('active')).rejects.toThrow('selector_not_found')
  })

  it('does not resolve the floating-terminal sentinel as a managed worktree', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree(FLOATING_TERMINAL_WORKTREE_ID)).rejects.toThrow(
      'selector_not_found'
    )
    await expect(
      runtime.showManagedWorktree(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    ).rejects.toThrow('selector_not_found')
  })

  it('guides bare repo-id worktree selectors to the full id shape', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(new Error('bare repo ids should not scan worktrees'))
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree(`id:${TEST_REPO_ID}`)).rejects.toThrow(
      'Worktree id selectors must use the full <repo-id>::<path> value.'
    )
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('guides registered SSH repo ids without probing the provider', async () => {
    const remoteRepo = { ...store.getRepos()[0], connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    vi.mocked(listWorktrees).mockClear()
    getSshGitProviderMock.mockClear()
    const runtime = new OrcaRuntimeService(remoteStore)

    await expect(runtime.showManagedWorktree(`id:${TEST_REPO_ID}`)).rejects.toMatchObject({
      code: 'worktree_id_requires_full_path'
    })
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('rejects bare repo ids through terminal list RPC with the structured code', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = new OrcaRuntimeService(store)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRpcRequest('terminal.list', { worktree: `id:${TEST_REPO_ID}` })
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'worktree_id_requires_full_path',
        message: expect.stringContaining('full <repo-id>::<path> value')
      }
    })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('rejects bare repo ids through the mobile session exact-id fast path', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.listMobileSessionTabs(`id:${TEST_REPO_ID}`)).rejects.toMatchObject({
      code: 'worktree_id_requires_full_path'
    })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('still resolves the full worktree id selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      id: TEST_WORKTREE_ID
    })
  })

  it('still throws selector_not_found for an unknown id selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('id:does-not-exist')).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('still throws selector_not_found for unknown bare ids', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('id:not-a-repo')).rejects.toThrow('selector_not_found')
  })

  it('does not treat partial repo ids as full worktree ids', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('id:repo')).rejects.toThrow('selector_not_found')
  })

  it('preserves full-id guidance for explicit parent-worktree lineage selectors', async () => {
    const runtime = new OrcaRuntimeService(store)
    const resolveLineage = runtime['resolveLineageForWorktreeCreate'].bind(runtime)

    await expect(resolveLineage({ parentWorktree: `id:${TEST_REPO_ID}` })).rejects.toThrow(
      'Worktree id selectors must use the full <repo-id>::<path> value.'
    )
  })

  it('does not reuse stale in-flight worktree scans after creating a worktree', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({
        exhaustedTiers: 0,
        names: Array.from({ length: 100 }, (_unused, index) =>
          index === 0 ? 'nautilus' : `nautilus-${index + 1}`
        )
      })
    })
    const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
    const createdWorktree = {
      path: '/tmp/workspaces/repo-nautilus-101',
      head: 'def',
      branch: 'nautilus-101',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees)
      .mockImplementationOnce(() => staleScan.promise)
      .mockResolvedValueOnce([createdWorktree])
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])

    const staleLookup = runtime.showManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })
    const freshLookup = runtime.showManagedWorktree(result.worktree.id)

    staleScan.resolve(MOCK_GIT_WORKTREES)

    await expect(staleLookup).resolves.toMatchObject({ id: TEST_WORKTREE_ID })
    await expect(freshLookup).resolves.toMatchObject({
      id: result.worktree.id,
      path: createdWorktree.path
    })
    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toMatchObject(
      {
        worktrees: expect.arrayContaining([expect.objectContaining({ path: createdWorktree.path })])
      }
    )
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus-101')
  })

  it('retires a generated name before a post-create listing failure', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/nautilus')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/nautilus')
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('listing unavailable'))

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'nautilus',
        nameWasGenerated: true
      })
    ).rejects.toThrow('listing unavailable')

    expect(addWorktree).toHaveBeenCalled()
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus')
  })

  it('retires a generated sparse name when creation rollback also fails', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/nautilus')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/nautilus')
    vi.mocked(addSparseWorktree).mockRejectedValueOnce(
      Object.assign(new Error('sparse setup failed'), { cleanupFailed: true })
    )

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'nautilus',
        nameWasGenerated: true,
        sparseCheckout: { directories: ['packages/web'] }
      })
    ).rejects.toThrow('sparse setup failed')

    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus')
  })

  it('neither skips nor retires a name the user typed', async () => {
    // Why: the pool contains ordinary words. Retirement only ever applies to generated names.
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: ['nautilus'] })
    })
    const createdWorktree = {
      path: '/tmp/workspaces/nautilus',
      head: 'def',
      branch: 'nautilus',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    // Not `...Once`: the shared beforeEach re-stubs the resolved value but cannot drain a queue,
    // so leftover one-shots would poison later tests in this file.
    vi.mocked(listWorktrees).mockResolvedValue([...MOCK_GIT_WORKTREES, createdWorktree])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus'
    })

    expect(result.worktree.path).toBe(createdWorktree.path)
    expect(addRetiredWorktreeName).not.toHaveBeenCalled()
  })

  it('creates additional workspace metadata for folder-mode repos through runtime create', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'Folder',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const,
      // removeManagedWorktree executes inside this selected runtime, where PTYs are local ids.
      executionHostId: 'runtime:env-1' as const
    }
    const rootWorktreeId = 'folder-repo::/workspace/folder'
    const rootPriorWorktreeIds = ['folder-repo::/workspace/old-folder']
    const metaById: Record<string, WorktreeMeta> = {
      [rootWorktreeId]: makeWorktreeMeta({
        instanceId: 'root-instance',
        priorWorktreeIds: rootPriorWorktreeIds
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string) => {
        delete metaById[worktreeId]
      }
    }
    let deletedWorktreeId = ''
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${deletedWorktreeId}@@pty-1` }]),
      shutdown: vi.fn(async () => undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_folder_startup',
      tabId: 'tab-folder-startup',
      worktreeId: '',
      title: null,
      surface: 'background'
    })
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:folder-repo',
      name: 'folder-session',
      createdWithAgent: 'codex',
      startup: { command: 'codex', viewMode: 'chat' }
    })

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ command: 'codex', viewMode: 'chat' })
    )
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^folder-repo::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'folder-session',
        isMainWorktree: false,
        createdWithAgent: 'codex'
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({
      instanceId: result.worktree.instanceId,
      displayName: 'folder-session',
      orcaCreationSource: 'runtime',
      createdWithAgent: 'codex'
    })
    await expect(runtime.showManagedWorktree(`id:${result.worktree.id}`)).resolves.toMatchObject({
      id: result.worktree.id,
      repoId: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder-session'
    })
    await expect(runtime.listManagedWorktrees('id:folder-repo')).resolves.toMatchObject({
      totalCount: 2,
      worktrees: [
        expect.objectContaining({
          id: rootWorktreeId,
          isMainWorktree: true,
          priorWorktreeIds: rootPriorWorktreeIds
        }),
        expect.objectContaining({
          id: result.worktree.id,
          isMainWorktree: false
        })
      ]
    })
    await expect(
      runtime.updateManagedWorktreeMeta(`id:${result.worktree.id}`, { comment: 'note' })
    ).resolves.toMatchObject({
      id: result.worktree.id,
      comment: 'note'
    })
    await expect(
      runtime.removeManagedWorktree('id:folder-repo::/workspace/folder')
    ).rejects.toThrow('Cannot delete the project root workspace')
    deletedWorktreeId = result.worktree.id
    await expect(runtime.removeManagedWorktree(`id:${result.worktree.id}`)).resolves.toEqual({})
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${result.worktree.id}@@pty-1`,
      expect.objectContaining({ immediate: true })
    )
    expect(metaById[result.worktree.id]).toBeUndefined()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(result.worktree.id)
    expect(notifier.worktreesChanged).toHaveBeenCalledWith('folder-repo')
  })

  it('refreshes runtime remote-tracking bases before creating local worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const refresh = deferred<{ stdout: string; stderr: string }>()
    const createdWorktree = {
      path: '/tmp/workspaces/cli-fresh-base',
      head: 'def',
      branch: 'cli-fresh-base',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cli-fresh-base^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        return refresh.promise
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const createPromise = runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'cli-fresh-base'
      })

      await vi.waitFor(() => {
        expect(gitSpy).toHaveBeenCalledWith(
          [
            '-c',
            'maintenance.auto=false',
            '-c',
            'maintenance.commit-graph.auto=0',
            '-c',
            'gc.auto=0',
            'fetch',
            '--no-tags',
            'origin',
            '+refs/heads/main:refs/remotes/origin/main'
          ],
          {
            cwd: TEST_REPO_PATH,
            useConfiguredSshCommandForNetwork: true,
            timeout: 60_000
          }
        )
      })
      expect(addWorktree).not.toHaveBeenCalled()

      refresh.resolve({ stdout: '', stderr: '' })
      const result = await createPromise

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'cli-fresh-base',
        'origin/main',
        false,
        false,
        {
          suggestLocalBaseRefUpdate: true,
          remoteTrackingBase: {
            remote: 'origin',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            base: 'origin/main'
          }
        }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        baseRef: 'refs/remotes/origin/main'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('returns runtime local base update suggestions from addWorktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/cli-stale-main',
      head: 'def',
      branch: 'cli-stale-main',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({
      localBaseRefUpdateSuggestion: {
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 5
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cli-stale-main^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'cli-stale-main'
      })

      expect(result.localBaseRefUpdateSuggestion).toEqual({
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 5
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a runtime local worktree from the detected default when the persisted base is stale', async () => {
    // Regression: a stale persisted repo base must fall back to the detected default.
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/cli-refresh-fails',
      head: 'base-sha',
      branch: 'cli-refresh-fails',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0], worktreeBaseRef: 'origin/master' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo] as never)
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/master^{commit}')) {
        throw new Error('missing ref')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'cli-refresh-fails'
        })
      ).resolves.toBeDefined()

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'cli-refresh-fails',
        'origin/main',
        false,
        false,
        {
          remoteTrackingBase: {
            remote: 'origin',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            base: 'origin/main'
          },
          suggestLocalBaseRefUpdate: true
        }
      )
      expect(getBaseRefDefault).toHaveBeenCalled()
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('creates a runtime local worktree from a usable persisted local branch base', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/local-branch-base',
      head: 'develop-sha',
      branch: 'local-branch-base',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0], worktreeBaseRef: 'develop' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo] as never)
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/develop^{commit}')) {
        return { stdout: 'develop-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'local-branch-base'
        })
      ).resolves.toBeDefined()

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'local-branch-base',
        'develop',
        false
      )
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('creates a runtime local worktree from a slash-named local branch matching a remote prefix', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/slash-local-base',
      head: 'team-feature-sha',
      branch: 'slash-local-base',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0], worktreeBaseRef: 'team/feature' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo] as never)
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'team\norigin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/team/feature^{commit}')) {
        throw new Error('missing remote-tracking ref')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/team/feature^{commit}')) {
        return { stdout: 'team-feature-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'slash-local-base'
        })
      ).resolves.toBeDefined()

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'slash-local-base',
        'team/feature',
        false
      )
      expect(gitSpy).not.toHaveBeenCalledWith(
        [
          '-c',
          'maintenance.auto=false',
          '-c',
          'maintenance.commit-graph.auto=0',
          '-c',
          'gc.auto=0',
          'fetch',
          '--no-tags',
          'team',
          '+refs/heads/feature:refs/remotes/team/feature'
        ],
        expect.any(Object)
      )
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('does not create a runtime local worktree when the refresh fails and no local base ref exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/cli-refresh-no-local')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/cli-refresh-no-local')
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      // No local remote-tracking base ref -> nothing to fall back on.
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        throw new Error('missing ref')
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'cli-refresh-no-local'
        })
      ).rejects.toThrow(
        'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
      )

      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a branchNameOverride worktree from the selected matching remote base ref', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({ stdout: '', stderr: '' })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/feature-something')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/feature-something')
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/feature-something',
        head: 'def',
        branch: 'feature/something',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'feature/something',
      baseBranch: 'origin/feature/something',
      branchNameOverride: 'feature/something'
    })

    expect(getBranchConflictKind).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/something',
      'origin/feature/something'
    )
    expect(addWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      '/tmp/workspaces/feature-something',
      'feature/something',
      'origin/feature/something',
      false
    )
    expect(resolveLocalGitUsernameMock).not.toHaveBeenCalled()
    expect(result.worktree).toMatchObject({
      path: '/tmp/workspaces/feature-something',
      branch: 'feature/something'
    })
  })

  it('checks out a selected existing local branch even when that branch already has a PR', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-bug-0',
      head: 'def',
      branch: 'refs/heads/fix/bug-0',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockClear()
    getPRForBranchMock.mockResolvedValue({
      number: 42,
      title: 'Existing PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'branch-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix/bug-0',
        baseBranch: 'fix/bug-0',
        branchNameOverride: 'fix/bug-0'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'fix/bug-0',
        'fix/bug-0',
        false,
        false,
        { checkoutExistingBranch: true }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/fix/bug-0'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a same-repo PR branch override from a resolved head SHA and matching push target', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getBranchConflictKind).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix', 'abc123')
      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['branch', '--set-upstream-to', 'origin/feature/fix', 'feature/fix'],
        { cwd: createdWorktree.path }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/fix'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('skips broad remote fetch for an existing full-SHA PR base', async () => {
    const runtime = new OrcaRuntimeService(store)
    const sha = 'c'.repeat(40)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: sha,
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'rev-parse' && args.includes(`${sha}^{commit}`)) {
        return { stdout: `${sha}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: sha,
        branchNameOverride: 'feature/fix'
      })

      expect(gitSpy).not.toHaveBeenCalledWith(['fetch', 'origin'], expect.anything())
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        sha,
        false
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/fix'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a selected Bitbucket PR branch override from a matching remote branch', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/bitbucket-title',
      head: 'abc123',
      branch: 'refs/heads/feature/bitbucket',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'bitbucket',
      number: 11,
      title: 'Bitbucket PR',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/11',
      status: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'bitbucket-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/bitbucket',
        linkedBitbucketPR: 11,
        pushTarget: { remoteName: 'origin', branchName: 'feature/bitbucket' }
      })

      expect(getBranchConflictKind).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'feature/bitbucket',
        'abc123'
      )
      expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: TEST_REPO_PATH,
          branch: 'feature/bitbucket',
          linkedBitbucketPR: 11
        })
      )
      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/bitbucket',
        'abc123',
        false
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/bitbucket',
        linkedBitbucketPR: 11
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes an existing PR when a matching push target lacks selected PR metadata', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Existing PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes a matching push target branch when selected PR metadata has no PR number', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: null,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes a matching push target branch when the existing PR is different', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 43,
      title: 'Different PR',
      state: 'open',
      url: 'https://example.com/pr/43',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes a selected PR remote conflict when the PR lookup fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix-2',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation(
      (sanitizedName: string) => `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockRejectedValueOnce(new Error('gh unavailable'))
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix-2^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix-2',
        'abc123',
        false
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('checks out an unused runtime PR branch only when it is at the resolved head SHA', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockClear()
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false,
        false,
        { checkoutExistingBranch: true }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes only the runtime worktree path when an exact PR branch checkout path exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation((sanitizedName: string) =>
      sanitizedName === 'fix-title' ? process.cwd() : `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockClear()
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false,
        false,
        { checkoutExistingBranch: true }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('rejects when every exact PR branch checkout path suffix is occupied', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue(process.cwd())
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix'
        })
      ).rejects.toThrow(
        'Could not find an available worktree path for "fix-title". Pick a different worktree name.'
      )

      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates SSH-backed worktrees through the SSH provider for mobile/runtime callers', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/repo-mobile-feature',
      head: 'def',
      branch: 'refs/heads/mobile-feature',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'mobile-feature',
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654,
      startup: { command: 'claude' }
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'mobile-feature',
      '/remote/repo-mobile-feature',
      { base: 'origin/main' }
    )
    expect(result.worktree).toMatchObject({
      id: `${TEST_REPO_ID}::${created.path}`,
      path: created.path,
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654
    })
    expect(metaById[result.worktree.id]).toMatchObject({
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654
    })
    expect(addWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('records lineage for SSH-backed CLI-created worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const parent = {
      path: '/remote/repo-parent',
      head: 'abc',
      branch: 'refs/heads/repo-parent',
      isBare: false,
      isMainWorktree: false
    }
    const created = {
      path: '/remote/child-feature',
      head: 'def',
      branch: 'refs/heads/child-feature',
      isBare: false,
      isMainWorktree: false
    }
    const parentId = `${TEST_REPO_ID}::${parent.path}`
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      setWorktreeLineage: vi.fn((worktreeId: string, lineage: WorktreeLineage) => {
        lineageById[worktreeId] = lineage
        return lineage
      })
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValueOnce([parent]).mockResolvedValue([parent, created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'child-feature',
        lineage: { parentWorktree: `id:${parentId}` }
      })

      expect(result.worktree).toMatchObject({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({
          worktreeId: childId,
          parentWorktreeId: parentId,
          worktreeInstanceId: metaById[childId].instanceId,
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli'
        })
      })
      expect(result.lineage).toBe(result.worktree.lineage)
      expect(result.warnings).toEqual([])
      expect(remoteStore.setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  // Why: the desktop composer sends `parentWorkspace` too, and a bare selector defaults to CLI
  // provenance — the same user action must not carry different cleanup semantics per host.
  it('records an app-selected parent workspace as a manual action', async () => {
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/tmp/workspaces/manual-child',
      head: 'def',
      branch: 'refs/heads/manual-child',
      isBare: false,
      isMainWorktree: false
    }
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      setWorkspaceLineage: vi.fn((lineage: WorkspaceLineage) => lineage)
    }
    computeWorktreePathMock.mockReturnValue(created.path)
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(listWorktrees).mockResolvedValueOnce([created])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'manual-child',
      baseBranch: 'origin/main',
      lineage: {
        parentWorkspace: TEST_FOLDER_WORKSPACE_KEY,
        parentWorkspaceOrigin: 'manual'
      }
    })

    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: `worktree:${childId}`,
      parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY,
      origin: 'manual',
      capture: { source: 'active-workspace', confidence: 'explicit' }
    })
  })

  it('records folder workspace lineage inferred from environment context', async () => {
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/tmp/workspaces/folder-child',
      head: 'def',
      branch: 'refs/heads/folder-child',
      isBare: false,
      isMainWorktree: false
    }
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {}
    const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      setWorkspaceLineage: vi.fn((lineage: WorkspaceLineage) => {
        workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
        return lineage
      })
    }
    computeWorktreePathMock.mockReturnValue(created.path)
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(listWorktrees).mockResolvedValueOnce([created])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'folder-child',
      baseBranch: 'origin/main',
      lineage: { envParentWorkspace: TEST_FOLDER_WORKSPACE_KEY }
    })

    expect(addWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      created.path,
      'folder-child',
      'origin/main',
      false
    )
    expect(result.lineage).toBeNull()
    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: `worktree:${childId}`,
      childInstanceId: metaById[childId].instanceId,
      parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY,
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'inferred' }
    })
    expect(result.worktree.workspaceLineage).toBe(result.workspaceLineage)
    expect(runtimeStore.setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY
      })
    )
  })

  it('activates SSH worktrees created with startup agents', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/agent-feature',
      head: 'def',
      branch: 'refs/heads/agent-feature',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        terminalWindowsShell: 'cmd.exe',
        agentCmdOverrides: {}
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-agent-startup' })
    const activateWorktree = vi.fn()
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-remote-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'agent-feature',
        startupAgent: 'codex',
        startupPrompt: 'hi',
        activate: true
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/agent-feature',
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
          worktreeId: result.worktree.id
        })
      )
      expect(activateWorktree).toHaveBeenCalledWith(
        TEST_REPO_ID,
        result.worktree.id,
        undefined,
        undefined,
        undefined
      )
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('quotes startup prompts for Windows SSH worktrees using PowerShell syntax', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: 'C:/remote/agent-feature',
      head: 'def',
      branch: 'refs/heads/agent-feature',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: 'C:/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-windows-agent' })
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-remote-windows-agent' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'agent-feature',
        startupAgent: 'codex',
        startupPrompt: "fix Bob's branch"
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:/remote/agent-feature',
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob''s branch'"
        })
      )
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('launches SSH setup terminals for runtime task-created worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-setup',
      head: 'def',
      branch: 'refs/heads/mobile-setup',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path') {
          return {
            stdout: '/remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing local branch')
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-remote-agent' })
      .mockResolvedValueOnce({ id: 'pty-remote-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-remote' })
    registerSshGitProvider('ssh-1', provider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-setup',
        setupDecision: 'run',
        startup: { command: 'claude', viewMode: 'chat' }
      })

      // Why: runtime provisions setup itself (fire-and-forget) and omits it from the RPC result so the caller doesn't double-spawn.
      expect(result.setup).toBeUndefined()
      expect(createTerminal).toHaveBeenCalledWith(
        `path:${result.worktree.path}`,
        expect.objectContaining({ viewMode: 'chat' })
      )
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          cwd: '/remote/mobile-setup',
          env: expect.objectContaining({
            [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: expect.stringContaining('exec claude')
          }),
          worktreeId: result.worktree.id
        })
      )
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cwd: '/remote/mobile-setup',
          command: expect.stringContaining(
            'bash /remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh'
          ),
          worktreeId: result.worktree.id
        })
      )
      const startup = spawn.mock.calls[0]![0] as {
        command: string
        env: Record<string, string>
      }
      const startupCommand = startup.command
      const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
      const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
      const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
      expect(nonceMatch?.[1]).toBeTruthy()
      const markerPath = `/remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh.${nonceMatch![1]}.done`
      expect(startupCommand.length).toBeLessThan(256)
      expect(setupCommand).toContain('printf')
      expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
      expect(startupScript).toContain(markerPath)
      expect(setupCommand).toContain(markerPath)
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-remote-setup',
          title: 'Setup',
          activate: false
        })
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
      unregisterSshFilesystemProvider('ssh-1')
    }
  })

  it('honors split setup placement for SSH worktrees without startup agents', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-setup-split',
      head: 'def',
      branch: 'refs/heads/mobile-setup-split',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path') {
          return {
            stdout: '/remote/repo/.git/worktrees/mobile-setup-split/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing local branch')
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-remote-initial' })
      .mockResolvedValueOnce({ id: 'pty-remote-setup-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-remote-split' })
    registerSshGitProvider('ssh-1', provider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-setup-split',
        setupDecision: 'run'
      })

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      const initialEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
      const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
      expect(setupEnv.ORCA_TAB_ID).toBe(initialEnv.ORCA_TAB_ID)
      const initialLeafId = initialEnv.ORCA_PANE_KEY!.slice(`${initialEnv.ORCA_TAB_ID!}:`.length)
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-remote-setup-split',
          tabId: initialEnv.ORCA_TAB_ID,
          activate: false,
          splitFromLeafId: initialLeafId,
          splitDirection: 'horizontal'
        })
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
      unregisterSshFilesystemProvider('ssh-1')
    }
  })

  it('removes SSH-backed runtime worktrees through the SSH git provider', async () => {
    vi.mocked(listWorktrees).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const ptyProvider = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'pty-remote',
          cwd: '/remote/feature',
          title: 'shell',
          worktreeId: `${TEST_REPO_ID}::/remote/feature`
        }
      ]),
      shutdown: vi.fn().mockResolvedValue(undefined),
      deleteWorktreeHistory: vi.fn().mockResolvedValue(undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never, undefined, {
      getSshProvider: () => ptyProvider as never
    })

    try {
      await runtime.removeManagedWorktree('path:/remote/feature', true, false)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).toHaveBeenCalledWith('/remote/feature', true)
    expect(ptyProvider.shutdown).toHaveBeenCalledWith(
      'pty-remote',
      expect.objectContaining({ immediate: true })
    )
    expect(ptyProvider.deleteWorktreeHistory).toHaveBeenCalledWith(
      `${TEST_REPO_ID}::/remote/feature`
    )
    expect(ptyProvider.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      gitProvider.removeWorktree.mock.invocationCallOrder[0]
    )
    expect(closeRemoteWatcherForWorktreePathMock).toHaveBeenCalledWith('ssh-1', '/remote/feature')
    expect(closeRemoteWatcherForWorktreePathMock.mock.invocationCallOrder[0]).toBeLessThan(
      gitProvider.removeWorktree.mock.invocationCallOrder[0]
    )
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/remote/feature`)
  })

  // Regression: `repoId::path` ids repeat across hosts, so the SSH delete's runtime sweep used to
  // stop the same-id local workspace's terminals too.
  it('leaves a same-id local terminal running when the SSH copy is removed', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = { ...store, getRepos: () => [remoteRepo], getRepo: () => remoteRepo }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const ptyProvider = {
      listProcesses: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never, undefined, {
      getSshProvider: () => ptyProvider as never
    })
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, null)
    runtime.registerPty('pty-remote', `${TEST_REPO_ID}::/remote/feature`, 'ssh-1')
    runtime.registerPty('pty-local-same-id', `${TEST_REPO_ID}::/remote/feature`, null)

    try {
      await runtime.removeManagedWorktree('path:/remote/feature', true, false)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(stopAndWait).toHaveBeenCalledWith('pty-remote', expect.anything())
    expect(stopAndWait).not.toHaveBeenCalledWith('pty-local-same-id', expect.anything())
  })

  it('rejects SSH-backed runtime removal of the main worktree before provider deletion', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.removeManagedWorktree('path:/remote/repo', true)).rejects.toThrow(
        'Refusing to delete protected worktree path: /remote/repo'
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('reads SSH repo hooks through the SSH filesystem provider', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      })
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooksFile: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        source: 'orca.yaml',
        setupTrust: {
          contentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90',
          scriptContent: 'pnpm install'
        }
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(hasHooksFile).not.toHaveBeenCalled()
    expect(getEffectiveHooks).not.toHaveBeenCalled()
  })

  it('hashes only the shared orca.yaml setup script for local run-both hooks', async () => {
    vi.mocked(hasHooksFile).mockReturnValue(true)
    vi.mocked(loadHooks).mockReturnValue({ scripts: { setup: 'echo yaml setup' } })
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'echo yaml setup\necho local setup' }
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: TEST_REPO_PATH,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          hookSettings: {
            commandSourcePolicy: 'run-both' as const,
            scripts: { setup: 'echo local setup' }
          }
        }
      ]
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
      hooks: { scripts: { setup: 'echo yaml setup\necho local setup' } },
      setupTrust: {
        contentHash: '9bc9f57699fe0390d263cca1aec01235cccc8fa5fc87cd87fd51ba1c8483ec84',
        scriptContent: 'echo yaml setup'
      }
    })
  })

  it('uses remote path joins for SSH hook checks and issue-command files', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => ({
        content: filePath.endsWith('orca.yaml')
          ? 'scripts:\n  setup: pnpm install\n'
          : filePath.endsWith('.gitignore')
            ? 'node_modules\n'
            : 'Fix it',
        isBinary: false
      })),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooks: true,
        mayNeedUpdate: false
      })
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: 'Fix it',
        effectiveContent: 'Fix it',
        localFilePath: 'C:\\remote\\repo\\.orca\\issue-command'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', 'Ship it')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\.orca\\issue-command')
    expect(fsProvider.createDir).toHaveBeenCalledWith('C:\\remote\\repo\\.orca')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.orca\\issue-command',
      'Ship it\n'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.gitignore',
      'node_modules\n.orca\n'
    )
  })

  describe('checkRepoHooks status', () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }

    it('reports an error when the SSH filesystem provider is unavailable', async () => {
      const runtime = new OrcaRuntimeService(remoteStore as never)

      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toEqual({
        status: 'error',
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false
      })
    })

    it('reports ok for a missing remote orca.yaml and error for any other read failure', async () => {
      const readFile = vi.fn()
      registerSshFilesystemProvider('ssh-1', { readFile } as never)
      const runtime = new OrcaRuntimeService(remoteStore as never)

      try {
        readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
          status: 'ok',
          hasHooks: false
        })

        readFile.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'ECONNRESET' }))
        await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
          status: 'error',
          hasHooks: false
        })
      } finally {
        unregisterSshFilesystemProvider('ssh-1')
      }
    })

    it('reports ok for a local repo hook check', async () => {
      const runtime = new OrcaRuntimeService(store as never)

      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({ status: 'ok' })
    })
  })

  it('resolves SSH issue commands from shared orca.yaml and deletes empty overrides', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({
      scripts: {},
      issueCommand: 'claude -p "Fix #{{issue}}"'
    })
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.orca/issue-command')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        if (filePath.endsWith('orca.yaml')) {
          return { content: 'issueCommand: claude -p "Fix #{{issue}}"', isBinary: false }
        }
        return { content: '', isBinary: false }
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: null,
        sharedContent: 'claude -p "Fix #{{issue}}"',
        effectiveContent: 'claude -p "Fix #{{issue}}"',
        localFilePath: '/remote/repo/.orca/issue-command',
        source: 'shared'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', '   ')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(fsProvider.deletePath).toHaveBeenCalledWith('/remote/repo/.orca/issue-command', false)
    expect(fsProvider.writeFile).not.toHaveBeenCalledWith(
      '/remote/repo/.orca/issue-command',
      expect.anything()
    )
  })

  it('allows host integration slug helpers for SSH repos through provider-aware GitHub clients', async () => {
    const prRepo = { owner: 'acme', repo: 'orca', host: 'github.acme.test' }
    getIssueMock.mockResolvedValueOnce({ number: 12, title: 'Remote issue' })
    listGitHubIssuesMock.mockResolvedValueOnce({
      items: [{ number: 7, title: 'Remote issue list item' }]
    })
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(runtime.getRepoSlug('id:repo-1')).resolves.toBeNull()
    await expect(runtime.getRepoIssue('id:repo-1', 12)).resolves.toEqual({
      number: 12,
      title: 'Remote issue'
    })
    await expect(runtime.listRepoIssues('id:repo-1', 10)).resolves.toEqual([
      { number: 7, title: 'Remote issue list item' }
    ])
    await expect(runtime.requestRepoPRReviewers('id:repo-1', 7, ['alex'], prRepo)).resolves.toEqual(
      {
        ok: true
      }
    )
    await expect(runtime.removeRepoPRReviewers('id:repo-1', 7, ['alex'], prRepo)).resolves.toEqual({
      ok: true
    })
    expect(getIssueMock).toHaveBeenCalledWith('/remote/repo', 12, 'ssh-1')
    expect(listGitHubIssuesMock).toHaveBeenCalledWith('/remote/repo', 10, undefined, 'ssh-1')
    expect(requestGitHubPRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      ['alex'],
      'ssh-1',
      prRepo
    )
    expect(removeGitHubPRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      ['alex'],
      'ssh-1',
      prRepo
    )
  })

  it('routes runtime GitHub repo identity helpers through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    getRepoSlugMock.mockResolvedValueOnce({ owner: 'acme', repo: 'orca' })
    getRepoUpstreamMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })

    await expect(runtime.getRepoSlug('id:repo-1')).resolves.toEqual({
      owner: 'acme',
      repo: 'orca'
    })
    await expect(runtime.getRepoUpstream('id:repo-1')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })

    const runtimeOptions = { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    expect(getRepoSlugMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, runtimeOptions)
    expect(getRepoUpstreamMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, runtimeOptions)
  })

  it('routes runtime GitHub issue and work-item actions through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const issueFields = { labels: ['bug'], assignees: ['octo'] }
    const issueUpdates = { body: 'Updated body' }
    listGitHubWorkItemsMock.mockResolvedValueOnce({ items: [] })
    countGitHubWorkItemsMock.mockResolvedValueOnce(0)
    listGitHubIssuesMock.mockResolvedValueOnce({ items: [] })
    getIssueMock.mockResolvedValueOnce(null)
    createGitHubIssueMock.mockResolvedValueOnce({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/issues/12'
    })
    updateGitHubIssueMock.mockResolvedValueOnce({ ok: true })
    addGitHubIssueCommentMock.mockResolvedValueOnce({ ok: true })
    listGitHubLabelsMock.mockResolvedValueOnce([])
    listGitHubAssignableUsersMock.mockResolvedValueOnce([])

    await runtime.listRepoWorkItems('id:repo-1', 7, 'is:open', 1, true)
    await runtime.countRepoWorkItems('id:repo-1', 'is:issue')
    await runtime.listRepoIssues('id:repo-1', 5)
    await runtime.getRepoIssue('id:repo-1', 12)
    await runtime.createRepoIssue('id:repo-1', 'Title', 'Body', issueFields)
    await runtime.updateRepoIssue('id:repo-1', 12, issueUpdates)
    await runtime.addRepoIssueComment('id:repo-1', 12, 'Comment')
    await runtime.listRepoLabels('id:repo-1')
    await runtime.listRepoAssignableUsers('id:repo-1')

    expect(listGitHubWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      'is:open',
      1,
      undefined,
      null,
      true,
      localGitOptions
    )
    expect(countGitHubWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'is:issue',
      undefined,
      null,
      localGitOptions
    )
    expect(listGitHubIssuesMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      5,
      undefined,
      null,
      localGitOptions
    )
    expect(getIssueMock).toHaveBeenCalledWith(TEST_REPO_PATH, 12, null, localGitOptions)
    expect(createGitHubIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'Title',
      'Body',
      undefined,
      null,
      issueFields,
      localGitOptions
    )
    expect(updateGitHubIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      12,
      issueUpdates,
      null,
      localGitOptions
    )
    expect(addGitHubIssueCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      12,
      'Comment',
      null,
      null,
      localGitOptions
    )
    expect(listGitHubLabelsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitHubAssignableUsersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
  })

  it('pins explicit origin preference on runtime open-by-number work item lookups', async () => {
    const originRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [originRepo],
      getRepo: (id: string) => (id === originRepo.id ? originRepo : undefined)
    } as never)
    const prRepo = { owner: 'acme', repo: 'orca' }

    await runtime.getRepoWorkItem('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemDetails('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemByOwnerRepo('id:repo-1', prRepo, 42, 'pr')

    expect(getGitHubWorkItemMock).toHaveBeenCalledWith(TEST_REPO_PATH, 42, 'pr', null, {}, 'origin')
    expect(getGitHubWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      {},
      'origin'
    )
    // Why: explicit owner/repo already pins identity, so it stays preference-free.
    expect(getGitHubWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      prRepo,
      42,
      'pr',
      null
    )
  })

  it('forwards check-details cancellation without local Git overrides', async () => {
    const runtime = new OrcaRuntimeService(store)
    const signal = new AbortController().signal

    await runtime.getRepoPRCheckDetails('id:repo-1', { checkRunId: 9 }, signal)

    expect(getGitHubPRCheckDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      {
        checkRunId: 9,
        prRepo: null
      },
      null,
      {},
      signal
    )
  })

  it('routes runtime GitHub PR details and actions through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const prRepo = { owner: 'acme', repo: 'orca', host: 'github.acme.test' }
    const checkDetailsSignal = new AbortController().signal

    await runtime.getRepoPRForBranch('id:repo-1', 'feature/wsl', 42, 43)
    await runtime.getRepoWorkItem('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemByOwnerRepo('id:repo-1', prRepo, 42, 'pr')
    await runtime.getRepoWorkItemDetails('id:repo-1', 42, 'pr')
    await runtime.getRepoPRChecks('id:repo-1', 42, 'head-sha', prRepo, { noCache: true })
    await runtime.rerunRepoPRChecks('id:repo-1', 42, {
      headSha: 'head-sha',
      failedOnly: true,
      prRepo
    })
    await runtime.getRepoPRCheckDetails(
      'id:repo-1',
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      checkDetailsSignal
    )
    await runtime.getRepoPRComments('id:repo-1', 42, prRepo, { noCache: true })
    await runtime.getRepoPRFileContents('id:repo-1', {
      prNumber: 42,
      prRepo,
      path: 'src/app.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })
    await runtime.resolveRepoReviewThread('id:repo-1', 'thread-1', true, prRepo)
    await runtime.setRepoPRFileViewed('id:repo-1', {
      prRepo,
      pullRequestId: 'PR_kw',
      path: 'src/app.ts',
      viewed: true
    })
    await runtime.updateRepoPRTitle('id:repo-1', 42, 'New title', prRepo)
    await runtime.updateRepoPRDetails('id:repo-1', 42, { body: 'New body' }, prRepo)
    await runtime.mergeRepoPR('id:repo-1', 42, 'squash', prRepo)
    await runtime.setRepoPRAutoMerge('id:repo-1', 42, true, 'squash', prRepo)
    await runtime.updateRepoPRState('id:repo-1', 42, { state: 'closed' }, prRepo)
    await runtime.requestRepoPRReviewers('id:repo-1', 42, ['octo'], prRepo)
    await runtime.removeRepoPRReviewers('id:repo-1', 42, ['octo'], prRepo)
    await runtime.addRepoPRReviewComment('id:repo-1', {
      prNumber: 42,
      prRepo,
      body: 'Inline',
      commitId: 'head-sha',
      path: 'src/app.ts',
      line: 10
    })
    await runtime.addRepoPRReviewCommentReply('id:repo-1', {
      prNumber: 42,
      commentId: 11,
      body: 'Reply',
      threadId: 'thread-1',
      path: 'src/app.ts',
      line: 10,
      prRepo
    })

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/wsl',
      42,
      null,
      null,
      {
        localGitExecOptions: localGitOptions
      }
    )
    expect(getGitHubWorkItemMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getGitHubWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      prRepo,
      42,
      'pr',
      null,
      localGitOptions
    )
    expect(getGitHubWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getGitHubPRChecksMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'head-sha',
      prRepo,
      { noCache: true },
      null,
      localGitOptions
    )
    expect(rerunGitHubPRChecksMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { headSha: 'head-sha', failedOnly: true, prRepo },
      null,
      localGitOptions
    )
    expect(getGitHubPRCheckDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      null,
      localGitOptions,
      checkDetailsSignal
    )
    expect(getGitHubPRCommentsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { noCache: true, prRepo },
      null,
      localGitOptions
    )
    expect(getGitHubPRFileContentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: TEST_REPO_PATH, localGitOptions, prRepo })
    )
    expect(resolveGitHubReviewThreadMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'thread-1',
      true,
      null,
      prRepo,
      localGitOptions
    )
    expect(setGitHubPRFileViewedMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: TEST_REPO_PATH, localGitOptions, prRepo })
    )
    expect(updateGitHubPRTitleMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'New title',
      null,
      prRepo,
      localGitOptions
    )
    expect(updateGitHubPRDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { body: 'New body' },
      null,
      prRepo,
      localGitOptions
    )
    expect(mergeGitHubPRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(setGitHubPRAutoMergeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      true,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(updateGitHubPRStateMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { state: 'closed' },
      null,
      prRepo,
      localGitOptions
    )
    expect(requestGitHubPRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(removeGitHubPRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(addGitHubPRReviewCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        localGitOptions,
        prRepo,
        body: 'Inline'
      })
    )
    expect(addGitHubPRReviewCommentReplyMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      11,
      'Reply',
      'thread-1',
      'src/app.ts',
      10,
      null,
      prRepo,
      localGitOptions
    )
  })

  it('rejects hosted review worktree selectors outside the selected repo', async () => {
    vi.mocked(listWorktrees).mockImplementation(async (repoPath: string) => {
      if (repoPath === '/tmp/repo-b') {
        return [
          {
            path: '/tmp/worktree-b',
            head: 'def',
            branch: 'feature/bar',
            isBare: false,
            isMainWorktree: false
          }
        ]
      }
      return MOCK_GIT_WORKTREES
    })
    const repos = [
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-2',
        path: '/tmp/repo-b',
        displayName: 'repo-b',
        badgeColor: 'green',
        addedAt: 2
      }
    ]
    const multiRepoStore = {
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    }
    const runtime = new OrcaRuntimeService(multiRepoStore as never)

    await expect(
      runtime.getHostedReviewCreationEligibility({
        repoSelector: 'id:repo-1',
        worktreeSelector: 'id:repo-2::/tmp/worktree-b',
        branch: 'feature/bar',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 1,
        behind: 0
      })
    ).rejects.toThrow('Access denied: worktree does not belong to repository')
    await expect(
      runtime.createHostedReview({
        repoSelector: 'id:repo-1',
        worktreeSelector: 'id:repo-2::/tmp/worktree-b',
        provider: 'github',
        base: 'main',
        head: 'feature/bar',
        title: 'Create PR',
        body: '',
        draft: false
      })
    ).rejects.toThrow('Access denied: worktree does not belong to repository')

    expect(getHostedReviewCreationEligibilityMock).not.toHaveBeenCalled()
    expect(createHostedReviewMock).not.toHaveBeenCalled()
  })

  it('passes SSH connection context through hosted review creation flows', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await runtime.getHostedReviewCreationEligibility({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/ssh',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await runtime.createHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/ssh',
      title: 'Feature SSH',
      body: '',
      draft: false
    })
    await runtime.createStackedHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'stack/parent',
      head: 'feature/ssh',
      title: 'Feature SSH',
      body: '',
      draft: false
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/remote/repo',
        connectionId: 'ssh-1',
        branch: 'feature/ssh'
      })
    )
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      '/remote/repo',
      expect.objectContaining({
        provider: 'github',
        head: 'feature/ssh',
        title: 'Feature SSH'
      }),
      'ssh-1'
    )
    expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
      '/remote/repo',
      expect.objectContaining({
        provider: 'github',
        base: 'stack/parent',
        head: 'feature/ssh'
      }),
      'ssh-1',
      {}
    )
  })

  it('routes local WSL project hosted review flows through runtime git options', async () => {
    setPlatform('win32')
    const wslStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(wslStore as never)
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'github',
      number: 76,
      title: 'Feature WSL',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/76',
      status: 'success',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    })
    createHostedReviewMock.mockResolvedValueOnce({
      ok: true,
      number: 77,
      url: 'https://github.com/acme/orca/pull/77'
    })

    await runtime.getHostedReviewForBranch({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/wsl',
      linkedGitHubPR: 76
    })
    await runtime.getHostedReviewCreationEligibility({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/wsl',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await runtime.createHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/wsl',
      title: 'Feature WSL',
      body: '',
      draft: false
    })
    await runtime.createStackedHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'stack/parent',
      head: 'feature/wsl',
      title: 'Feature WSL',
      body: '',
      draft: false
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        connectionId: null,
        branch: 'feature/wsl',
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    )
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        connectionId: null,
        branch: 'feature/wsl',
        linkedGitHubPR: 76,
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    )
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      expect.objectContaining({
        provider: 'github',
        head: 'feature/wsl',
        title: 'Feature WSL'
      }),
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
    expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      expect.objectContaining({
        provider: 'github',
        base: 'stack/parent',
        head: 'feature/wsl'
      }),
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
  })

  it('treats SSH worktree drift as unknown without local git probes', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(getBaseRefDefault).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getWorktreeMeta: () => null
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.probeWorktreeDrift('path:/remote/repo')).resolves.toBeNull()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(getBaseRefDefault).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('routes local WSL project worktree drift probes through runtime git options', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const wslGitOptions = { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
    let driftCounts = '1\t2\n'
    const asyncGitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: `${TEST_REPO_PATH}/.git\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: driftCounts, stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: 'base commit 2\nbase commit 1\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    try {
      const result = await runtime.probeWorktreeDrift(`id:${TEST_WORKTREE_ID}`)

      expect(result).toEqual({
        base: 'origin/main',
        behind: 2,
        recentSubjects: ['base commit 2', 'base commit 1']
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        { ...wslGitOptions, timeout: 15_000 }
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(['remote'], wslGitOptions)
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        wslGitOptions
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(['fetch', 'origin'], {
        ...wslGitOptions,
        timeout: 60_000
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['log', '--format=%s', '-n', '5', 'HEAD..origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )

      driftCounts = '3\t0\n'
      asyncGitSpy.mockClear()

      await expect(runtime.probeWorktreeDrift(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
        base: 'origin/main',
        behind: 0,
        recentSubjects: []
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )
      expect(asyncGitSpy.mock.calls.some(([args]) => args[0] === 'log')).toBe(false)
    } finally {
      asyncGitSpy.mockRestore()
    }
  })

  it('deduplicates runtime repo paths with Windows/UNC comparison semantics', async () => {
    const added: Record<string, unknown>[] = []
    const uncStore = {
      ...store,
      getRepos: () => [
        {
          id: 'repo-unc',
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        },
        ...added
      ],
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => [...uncStore.getRepos()].find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(uncStore as never)

    const repo = await runtime.addRepo('//server/share/repo', 'folder')

    expect(repo).toMatchObject({ id: 'repo-unc', path: '//Server/Share/Repo' })
    expect(added).toHaveLength(0)
  })

  it('browses runtime server directories before projects are added', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-browse-'))
    try {
      await mkdir(join(tempRoot, 'zeta'))
      await mkdir(join(tempRoot, 'alpha'))
      await writeFile(join(tempRoot, 'readme.md'), '# Readme\n')
      const runtime = new OrcaRuntimeService(store)

      const result = await runtime.browseServerDir(tempRoot)

      expect(result.resolvedPath).toBe(tempRoot)
      expect(result.pathFlavor).toBe(process.platform === 'win32' ? 'win32' : 'posix')
      expect(result.entries).toEqual([
        { name: 'alpha', isDirectory: true, isSymlink: false },
        { name: 'zeta', isDirectory: true, isSymlink: false },
        { name: 'readme.md', isDirectory: false, isSymlink: false }
      ])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('lists drive roots for a server-root browse', async () => {
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.browseServerDir('/')

    expect(result.resolvedPath).toBe('/')
    expect(result.pathFlavor).toBe('win32')
    expect(result.entries).toContainEqual({
      name: win32.parse(tmpdir()).root.toUpperCase(),
      isDirectory: true,
      isSymlink: false
    })
  })

  it('defaults runtime addRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    const repo = await runtime.addRepo('/tmp/runtime-add-default', 'folder')

    expect(repo.badgeColor).toBe(DEFAULT_REPO_BADGE_COLOR)
    expect(added).toEqual([expect.objectContaining({ badgeColor: DEFAULT_REPO_BADGE_COLOR })])
  })

  it('prepares the runtime worktree root when adding a repo', async () => {
    const added: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/tmp/runtime-add-root-prep', 'folder')

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, repo)
  })

  it('sets up an existing folder on a fresh runtime after importing the repo project', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-project-setup-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () =>
        repos
          .map((repo) => {
            const upstream = repo.upstream as { owner: string; repo: string } | undefined
            if (!upstream) {
              return null
            }
            return {
              id: `github:${upstream.owner}/${upstream.repo}`,
              displayName: repo.displayName,
              badgeColor: repo.badgeColor,
              providerIdentity: { provider: 'github', owner: upstream.owner, repo: upstream.repo },
              sourceRepoIds: [repo.id],
              createdAt: repo.addedAt,
              updatedAt: repo.addedAt
            }
          })
          .filter(Boolean) as never,
      getProjectHostSetups: () =>
        repos.map((repo) => {
          const upstream = repo.upstream as { owner: string; repo: string } | undefined
          return {
            id: repo.id,
            projectId: upstream ? `github:${upstream.owner}/${upstream.repo}` : repo.id,
            hostId: 'local',
            repoId: repo.id,
            path: repo.path,
            displayName: repo.displayName,
            kind: repo.kind,
            setupState: 'ready',
            setupMethod: repo.projectHostSetupMethod ?? 'legacy-repo',
            createdAt: repo.addedAt,
            updatedAt: repo.addedAt
          }
        }) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: tempRoot,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })

      expect(result.project.id).toBe('github:stablyai/orca')
      expect(result.repo.path).toBe(tempRoot)
      expect(result.setup).toMatchObject({
        projectId: 'github:stablyai/orca',
        path: tempRoot,
        setupMethod: 'imported-existing-folder'
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('sets up a project whose identity exists only on the requesting host', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-cross-host-project-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => repos.push(repo),
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const repo = repos.find((entry) => entry.id === id)
        if (!repo) {
          return null
        }
        Object.assign(repo, updates)
        return { ...repo } as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:github.acme.test/acme/orca',
        projectProviderIdentity: {
          provider: 'github',
          owner: 'acme',
          repo: 'orca',
          host: 'github.acme.test'
        },
        hostId: 'runtime:env-1',
        path: tempRoot,
        kind: 'git'
      })

      expect(result.project).toMatchObject({
        id: 'github:github.acme.test/acme/orca',
        providerIdentity: {
          provider: 'github',
          owner: 'acme',
          repo: 'orca',
          host: 'github.acme.test'
        }
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rolls back a new runtime repo when project alignment fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-project-rollback-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => repos.push(repo),
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const repo = repos.find((entry) => entry.id === id)
        if (!repo) {
          return null
        }
        Object.assign(repo, updates)
        return { ...repo } as never
      },
      removeProject: (id: string) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index !== -1) {
          repos.splice(index, 1)
        }
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      await expect(
        runtime.setupProjectExistingFolder({
          projectId: 'git:git.example.test/acme/orca',
          hostId: 'runtime:env-1',
          path: tempRoot,
          kind: 'git'
        })
      ).rejects.toThrow('Imported folder does not match the selected project identity.')

      expect(repos).toHaveLength(0)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rolls back a newly cloned repo when project alignment fails', async () => {
    const repos: Record<string, unknown>[] = []
    const clonedRepo = {
      id: 'cloned-repo',
      path: '/tmp/cloned-repo',
      displayName: 'cloned-repo',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      removeProject: (id: string) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index !== -1) {
          repos.splice(index, 1)
        }
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    vi.spyOn(runtime, 'cloneRepo').mockImplementation(async () => {
      repos.push(clonedRepo)
      return clonedRepo as never
    })

    await expect(
      runtime.setupProjectClone({
        projectId: 'git:git.example.test/acme/orca',
        hostId: 'runtime:env-1',
        url: 'https://git.example.test/acme/orca.git',
        destination: '/tmp'
      })
    ).rejects.toThrow('Imported folder does not match the selected project identity.')

    expect(repos).toHaveLength(0)
  })

  it('keeps existing-folder imports split by runtime host on the same normalized path', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-project-host-'))
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
      const first = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: tempRoot,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })
      const second = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-2',
        path: tempRoot,
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      })

      expect(repos).toHaveLength(2)
      expect(repos).toEqual([
        expect.objectContaining({
          path: tempRoot,
          executionHostId: 'runtime:env-1'
        }),
        expect.objectContaining({
          path: tempRoot,
          executionHostId: 'runtime:env-2'
        })
      ])
      expect(first.repo).toMatchObject({
        path: tempRoot,
        executionHostId: 'runtime:env-1'
      })
      expect(first.setup).toMatchObject({
        repoId: first.repo.id,
        hostId: 'runtime:env-1'
      })
      expect(second.repo).toMatchObject({
        path: tempRoot,
        executionHostId: 'runtime:env-2'
      })
      expect(second.setup).toMatchObject({
        repoId: second.repo.id,
        hostId: 'runtime:env-2'
      })
      expect(first.repo.id).not.toBe(second.repo.id)
      expect(first.setup.repoId).not.toBe(second.setup.repoId)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps path-only runtime addRepo reuse working when a host-qualified repo already exists', async () => {
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-runtime-1',
        path: '/tmp/runtime-shared',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder',
        executionHostId: 'runtime:env-1'
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/tmp/runtime-shared', 'folder')

    expect(repo).toMatchObject({
      id: 'repo-runtime-1',
      path: '/tmp/runtime-shared',
      executionHostId: 'runtime:env-1'
    })
    expect(repos).toHaveLength(1)
  })

  it('does not hijack a legacy SSH repo at the same path into a runtime host', async () => {
    // A legacy SSH repo resolves to `ssh:<connectionId>` even with null executionHostId, so a same-path runtime import creates a new repo instead of adopting it.
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-ssh-1',
        path: '/workspace',
        displayName: 'workspace',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder',
        connectionId: 'ssh-target-1'
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/workspace', 'folder', 'runtime:env-1')

    expect(repos).toHaveLength(2)
    expect(repo.id).not.toBe('repo-ssh-1')
    expect(repo).toMatchObject({ path: '/workspace', executionHostId: 'runtime:env-1' })
    // The legacy SSH repo must be untouched (no executionHostId stamped onto it).
    expect(repos[0]).toMatchObject({ id: 'repo-ssh-1', connectionId: 'ssh-target-1' })
    expect(repos[0]).not.toHaveProperty('executionHostId')
  })

  it('only a runtime host adopts an unstamped repo; local/ssh imports never stamp it', async () => {
    // Local and legacy runtime repos both have null executionHostId/connectionId, so only a runtime host may backfill; local/ssh imports leave it untouched.
    for (const importHostId of ['local', 'ssh:ssh-target-9'] as const) {
      const repos: Record<string, unknown>[] = [
        {
          id: 'repo-local-1',
          path: '/workspace',
          displayName: 'workspace',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        }
      ]
      const runtimeStore = {
        ...store,
        getRepos: () => [...repos] as never,
        addRepo: (repo: Record<string, unknown>) => {
          repos.push(repo)
        },
        getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
        updateRepo: (id: string, updates: Record<string, unknown>) => {
          const index = repos.findIndex((repo) => repo.id === id)
          if (index === -1) {
            return null
          }
          repos[index] = { ...repos[index], ...updates }
          return repos[index] as never
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)

      const repo = await runtime.addRepo('/workspace', 'folder', importHostId)

      // The matched repo is returned unchanged — no new repo, no executionHostId stamped.
      expect(repos).toHaveLength(1)
      expect(repo.id).toBe('repo-local-1')
      expect(repos[0]).not.toHaveProperty('executionHostId')
    }
  })

  it('keeps project clone setup on the cloned host-qualified repo', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.setupProjectClone({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(1)
      expect(result.repo).toMatchObject({
        path: clonePath,
        executionHostId: 'runtime:env-1',
        projectHostSetupMethod: 'cloned'
      })
      expect(result.setup).toMatchObject({
        repoId: result.repo.id,
        hostId: 'runtime:env-1',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('refuses SSH hosts instead of setting the project up on the local machine', async () => {
    // Why: both inputs must be paths the pre-guard code would have accepted. An unwritable
    // destination fails at mkdir and a non-repo path fails at isGitRepo, which would leave the
    // side-effect assertions below unable to observe the local clone/probe they exist to catch.
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-ssh-guard-'))
    const existingFolder = join(destination, 'orca')
    mkdirSync(existingFolder, { recursive: true })
    execFileSync('git', ['init'], { cwd: existingFolder, stdio: 'ignore' })
    const spawnSpy = vi
      .spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
      .mockImplementation(() => {
        // Why: unreachable while the guard holds; stubbed so a regression records the call
        // instead of shelling out to a real network clone.
        const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
        proc.stderr = new EventEmitter()
        setImmediate(() => proc.emit('close', 1, null))
        return proc as never
      })
    const repos: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const cloneError = await runtime
        .setupProjectClone({
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:openclaw',
          url: 'https://example.com/orca.git',
          destination
        })
        .catch((error: unknown) => error)
      const existingFolderError = await runtime
        .setupProjectExistingFolder({
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:openclaw',
          path: existingFolder,
          kind: 'git'
        })
        .catch((error: unknown) => error)

      // Why: the defect was a silent local clone/probe recorded as remote, not a bad message,
      // so the absent side effects are asserted before the wording. Both calls are awaited
      // first so a regression reports the corruption rather than stopping at the first throw.
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(repos).toHaveLength(0)
      expect(cloneError).toMatchObject({
        message: expect.stringMatching(/SSH hosts are not supported/)
      })
      expect(existingFolderError).toMatchObject({
        message: expect.stringMatching(/SSH hosts are not supported/)
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('adopts public clone repos into host-qualified project setup', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const cloned = await runtime.cloneRepo('https://example.com/orca.git', destination)
      expect(cloned).toMatchObject({
        path: clonePath
      })
      expect(cloned).not.toHaveProperty('executionHostId')

      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: clonePath,
        kind: 'git',
        setupMethod: 'cloned'
      })

      expect(repos).toHaveLength(1)
      expect(result.repo).toMatchObject({
        id: cloned.id,
        path: clonePath,
        executionHostId: 'runtime:env-1',
        projectHostSetupMethod: 'cloned'
      })
      expect(result.setup).toMatchObject({
        repoId: cloned.id,
        hostId: 'runtime:env-1',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('keeps project clone repos split by runtime host on the same clone path', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-host-a',
        path: clonePath,
        displayName: 'orca',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ]
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.setupProjectClone({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-2',
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(2)
      expect(repos[0]).toMatchObject({
        id: 'repo-host-a',
        executionHostId: 'runtime:env-1'
      })
      expect(result.repo).toMatchObject({
        path: clonePath,
        executionHostId: 'runtime:env-2'
      })
      expect(result.repo.id).not.toBe('repo-host-a')
      expect(result.setup).toMatchObject({
        repoId: result.repo.id,
        hostId: 'runtime:env-2',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('defaults runtime createRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const parentDir = await mkdtemp('/tmp/orca-runtime-create-')
    try {
      const result = await runtime.createRepo(parentDir, 'runtime-create-default', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect(result).toHaveProperty('repo.badgeColor', DEFAULT_REPO_BADGE_COLOR)
      expect(added).toEqual([expect.objectContaining({ badgeColor: DEFAULT_REPO_BADGE_COLOR })])
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('creates a missing runtime parent before creating the project directory', async () => {
    const added: Record<string, unknown>[] = []
    const createStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(createStore as never)
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-create-parent-'))
    const parentDir = join(tempRoot, 'orca', 'projects')
    try {
      const result = await runtime.createRepo(parentDir, 'first-project', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect((await lstat(parentDir)).isDirectory()).toBe(true)
      expect((await lstat(join(parentDir, 'first-project'))).isDirectory()).toBe(true)
      expect(result).toHaveProperty('repo.path', join(parentDir, 'first-project'))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('prepares the runtime worktree root when creating a repo', async () => {
    const added: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-create-root-prep-'))
    try {
      const result = await runtime.createRepo(parentDir, 'runtime-create-root-prep', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, result.repo)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('preserves existing badgeColor on runtime createRepo dedupe', async () => {
    const repoName = 'runtime-existing-create'
    const existing = {
      id: repoName,
      path: join(tmpdir(), repoName),
      displayName: repoName,
      badgeColor: '#14b8a6',
      addedAt: 1,
      kind: 'folder' as const
    }
    const colorStore = {
      ...store,
      getRepos: () => [existing]
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    const result = await runtime.createRepo(tmpdir(), repoName, 'folder')

    expect(result).toEqual({ repo: existing })
    expect(result).toHaveProperty('repo.badgeColor', '#14b8a6')
  })

  it('defaults runtime cloneRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => proc.emit('close', 0, null))
      return proc as never
    })
    const runtime = new OrcaRuntimeService(colorStore as never)

    try {
      const repo = await runtime.cloneRepo('https://example.com/repo-badge-color.git', '/tmp')
      expect(repo.badgeColor).toBe(DEFAULT_REPO_BADGE_COLOR)
      expect(added).toEqual([
        expect.objectContaining({
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          externalWorktreeVisibilityLegacy: false
        })
      ])
      expect(repo.externalWorktreeVisibility).toBeUndefined()
      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(colorStore, repo)
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('drops a same-path negative submodule cache before runtime cloneRepo', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-reclone-'))
    const clonePath = join(destination, 'reclone')
    const added: Record<string, unknown>[] = []
    const cloneStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => added.push(repo),
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        void mkdir(clonePath, { recursive: true })
          .then(() =>
            writeFile(join(clonePath, '.gitmodules'), '[submodule "lib"]\n\tpath = vendor/lib\n')
          )
          .then(() => proc.emit('close', 0, null))
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(cloneStore as never)

    try {
      clearSubmodulePathsCacheForTests()
      await expect(listSubmodulePaths(clonePath)).resolves.toEqual([])
      await runtime.cloneRepo('https://example.com/reclone.git', destination)
      await expect(listSubmodulePaths(clonePath)).resolves.toEqual(['vendor/lib'])
    } finally {
      clearSubmodulePathsCacheForTests()
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves existing badgeColor on runtime cloneRepo folder->git dedupe upgrade', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => proc.emit('close', 0, null))
      return proc as never
    })
    const existing = {
      id: 'runtime-folder-upgrade',
      path: '/tmp/repo-badge-color',
      displayName: 'repo-badge-color',
      badgeColor: '#ec4899',
      addedAt: 1,
      kind: 'folder' as const
    }
    const updates: { id: string; updates: Record<string, unknown> }[] = []
    const upgraded = { ...existing, kind: 'git' as const }
    const colorStore = {
      ...store,
      getRepos: () => [existing],
      updateRepo: (id: string, repoUpdates: Record<string, unknown>) => {
        updates.push({ id, updates: repoUpdates })
        return upgraded as never
      }
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    try {
      const repo = await runtime.cloneRepo('https://example.com/repo-badge-color.git', '/tmp')
      expect(updates).toEqual([{ id: existing.id, updates: { kind: 'git' } }])
      expect(repo).toEqual(upgraded)
      expect(repo.badgeColor).toBe('#ec4899')
      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(colorStore, upgraded)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('prepares the runtime worktree root when worktree base path changes', async () => {
    const repo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git' as const
    }
    const updated = { ...repo, worktreeBasePath: '../worktrees' }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined) as never,
      updateRepo: vi.fn(() => updated as never)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.updateRepo(repo.id, { worktreeBasePath: '../worktrees' })).resolves.toBe(
      updated
    )

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, updated)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('prepares the runtime worktree root when repo-backed project host setup base path changes', () => {
    const repo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git' as const,
      worktreeBasePath: '../worktrees'
    }
    const result = {
      project: { id: 'project-1', displayName: 'Repo' },
      setup: { id: 'setup-1', projectId: 'project-1', repoId: repo.id, hostId: 'local' },
      repo
    }
    const runtimeStore = {
      ...store,
      updateProjectHostSetup: vi.fn(() => result as never)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    expect(
      runtime.updateProjectHostSetup({
        setupId: 'setup-1',
        updates: { worktreeBasePath: '../worktrees' }
      })
    ).toBe(result)

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, repo)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('rejects runtime cloneRepo dot-segment URLs before spawning git', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const runtime = createRuntime()
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const destination = join(tempRoot, 'destination')

    try {
      await expect(runtime.cloneRepo('file:///tmp/source/.', destination)).rejects.toThrow(
        'Invalid repository name derived from URL'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects runtime cloneRepo parent-segment URLs before spawning git', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const runtime = createRuntime()
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const destination = join(tempRoot, 'destination')

    try {
      await expect(runtime.cloneRepo('file:///tmp/source/..', destination)).rejects.toThrow(
        'Invalid repository name derived from URL'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('removes an owned runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await writeFile(join(clonePath, 'partial.txt'), 'git wrote this before failing')
      proc.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed: fatal: repository not found')
      await expect(lstat(clonePath)).rejects.toThrow()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves an existing runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      await mkdir(clonePath)
      await writeFile(join(clonePath, 'user-file.txt'), 'keep me')
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(join(clonePath, 'user-file.txt'))).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('skips runtime clone failure cleanup when the owned target is replaced', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')
    const replacementFile = join(clonePath, 'replacement.txt')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await rm(clonePath, { recursive: true, force: true })
      await mkdir(clonePath)
      await writeFile(replacementFile, 'new owner')
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(replacementFile)).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('serializes concurrent runtime clones for the same target', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const firstProc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    firstProc.stderr = new EventEmitter()
    spawnSpy.mockResolvedValueOnce(firstProc as never)
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))

    try {
      const firstClonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      const secondClonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setImmediate(resolve))
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      firstProc.emit('close', 0, null)
      await expect(firstClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      await expect(secondClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('associates controller PTYs with mixed-case Windows and UNC cwd paths', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:\\Repo',
        head: 'abc',
        branch: 'feature/windows',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '//Server/Share/Repo',
        head: 'def',
        branch: 'feature/unc',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-windows', cwd: 'c:\\repo\\src', title: 'Windows shell' },
        { id: 'pty-unc', cwd: '//server/share/repo/src', title: 'UNC shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals()

    expect(terminals.terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}::C:\\Repo`,
          worktreePath: 'C:\\Repo'
        }),
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}:://Server/Share/Repo`,
          worktreePath: '//Server/Share/Repo'
        })
      ])
    )
  })

  it('uses OSC titles rather than controller process names for rendererless PTYs', async () => {
    const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: null
    })

    runtime.onPtyData(ptyId, '\x1b]0;Codex\x07', 123)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: 'Codex'
    })

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: 'Codex'
    })
  })

  it('resolves tui-idle when a completion title is coalesced with the next working title', async () => {
    // Why: batching can coalesce "task done" + next working title into one chunk; a last-title reader misses the idle and hangs (#1083 class).
    const runtime = createRuntime()
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals
    const wait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07\x1b]0;Codex working\x07', 101)

    await expect(wait).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('ignores the bare cursor-agent native title so synthesized spinner state survives', async () => {
    const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
    // cursor-agent re-emits its bare native title on internal redraws while still working; it must not stomp the synthesized working title.
    runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', 101)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: '⠋ Cursor Agent'
    })
  })

  // Why: this pins the mechanism the refusals below exist for. cursor-agent emits only the
  // bare native title, and the tracker drops it on sight — so a pane can never hold it
  // because Cursor said so *now*. The one route into main's records is the stale-working
  // clear stripping the spinner off Orca's synthesized title after 3s of quiet output, and
  // that fires whether Cursor parked idle or exited and the shell took the pane back. That
  // is exactly why the title cannot tell a live pane from a dead one.
  it('only records the bare Cursor native title via the stale-working clear', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      // Live from cursor-agent: dropped, never recorded.
      runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', 100)
      expect((await runtime.listTerminals()).terminals[0].title).not.toBe('Cursor Agent')

      // Orca's synthesized spinner, then quiet output: the clear strips it to the bare title.
      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 101)
      runtime.onPtyData(ptyId, 'agent finished; shell prompt returns\r\n', 102)
      await vi.advanceTimersByTimeAsync(3_000)

      expect((await runtime.listTerminals()).terminals[0].title).toBe('Cursor Agent')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: this pane reads no foreground and the next reads a live shell, yet both hold the
  // same bare title the stale-working clear left behind. Neither read makes that title
  // liveness, so both must refuse.
  it('refuses a bare Cursor title while the foreground read is unavailable', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'streaming output with no title\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      const terminal = (await runtime.listTerminals()).terminals[0]
      expect(terminal.title).toBe('Cursor Agent')
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
      await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
        handle: terminal.handle,
        isRunningAgent: false,
        status: null
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat a bare Cursor title as an agent once the shell owns the foreground', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      let foreground: string | null = null
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => foreground,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'agent exited; back at the shell\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      // cursor-agent is gone and the user's shell owns the pane, but the title still reads
      // "Cursor Agent". A guarded send here would auto-submit Enter into that shell.
      foreground = 'zsh'
      const terminal = (await runtime.listTerminals()).terminals[0]
      expect(terminal.title).toBe('Cursor Agent')
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
      await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
        handle: terminal.handle,
        isRunningAgent: false,
        status: null
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the refusals here must stay scoped to missing evidence. A working foreground read
  // is what unlocks a live Cursor pane — and is the layer to fix if one is ever refused.
  it('accepts a bare Cursor title when the foreground read confirms cursor-agent', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      let foreground: string | null = null
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => foreground,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'streaming output with no title\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      foreground = 'cursor-agent'
      const terminal = (await runtime.listTerminals()).terminals[0]
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: pins the type-narrowing branch, not a reachable state — no caller detaches the
  // controller. It is the runtime-owned pty path, which the window-graph leaf tests below
  // never reach, so nothing else would notice it being widened.
  it('refuses a bare Cursor title on a runtime pty with no controller attached', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'cursor-agent',
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'streaming output with no title\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      const terminal = (await runtime.listTerminals()).terminals[0]
      runtime.setPtyController(null)
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a stale working title after 3s of title-less output', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, 'output without a title\r\n', 101)
      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
        title: 'Codex working'
      })

      await vi.advanceTimersByTimeAsync(3_000)

      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
        title: 'Codex'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the stale-title timer when the PTY exits', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, 'output without a title\r\n', 101)
      runtime.onPtyExit(ptyId, 0)

      await vi.advanceTimersByTimeAsync(4_000)

      // The dead session keeps its factual last title; the disposed tracker's stale-title rewrite must not fire into the retained record.
      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
        title: 'Codex working'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stale-title timers isolated per PTY', async () => {
    vi.useFakeTimers()
    try {
      const ptyA = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-a`
      const ptyB = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-b`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [
          { id: ptyA, cwd: '/tmp/worktree-a', title: 'shell' },
          { id: ptyB, cwd: '/tmp/worktree-a', title: 'shell' }
        ]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyA, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyB, '\x1b]0;Aider working\x07', 100)
      // Only A receives title-less output, so only A's stale timer arms.
      runtime.onPtyData(ptyA, 'output without a title\r\n', 101)

      await vi.advanceTimersByTimeAsync(3_000)

      const { terminals } = await runtime.listTerminals()
      expect(terminals.find((t) => t.tabId === `pty:${ptyA}`)).toMatchObject({ title: 'Codex' })
      expect(terminals.find((t) => t.tabId === `pty:${ptyB}`)).toMatchObject({
        title: 'Aider working'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // ─── pty:sideEffect channel (terminal-side-effect-authority.md, slice 2) ──
})

describe('resolveWorktreeScanCacheTtlMs', () => {
  const BASE_TTL_MS = 30_000
  const SCRATCH_TTL_MS = 5 * 60_000

  it('keeps the base TTL for ordinary local repos', () => {
    expect(
      resolveWorktreeScanCacheTtlMs({ path: '/Users/dev/projects/app', connectionId: '' })
    ).toBe(BASE_TTL_MS)
  })

  it('extends the TTL for agent-scratch repo roots', () => {
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/Users/dev/.codex-tmp/foragent-capsule-b1-repo-zP9Az6',
        connectionId: ''
      })
    ).toBe(SCRATCH_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/Users/dev/.claude/skills/obsidian-second-brain',
        connectionId: ''
      })
    ).toBe(SCRATCH_TTL_MS)
  })

  it('never extends the TTL for SSH repos', () => {
    // Why: scratch classification reads local path conventions; a remote path
    // that merely looks similar must keep normal freshness.
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/home/dev/.codex-tmp/capsule',
        connectionId: 'ssh-1'
      })
    ).toBe(BASE_TTL_MS)
  })

  it('keeps a scratch repo scan cached past the base TTL while normal repos rescan', async () => {
    // Why: the whole fix lives in the cache-stamp call site; pin the wiring so
    // a revert to the flat TTL fails CI, not just the pure-function tests.
    vi.useFakeTimers()
    // Why: the shared listWorktrees stub keeps call history across this file's
    // tests; absolute counts need a clean baseline.
    vi.mocked(listWorktrees).mockClear()
    try {
      const scratchPath = '/tmp/.codex-tmp/capsule-a'
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => [
          { id: 'repo-1', path: '/tmp/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
          {
            id: 'repo-scratch',
            path: scratchPath,
            displayName: 'capsule',
            badgeColor: 'blue',
            addedAt: 1
          }
        ]
      } as never)
      const internals = runtime as unknown as { listResolvedWorktrees: () => Promise<unknown> }
      const scanCallsFor = (path: string): number =>
        vi.mocked(listWorktrees).mock.calls.filter((call) => call[0] === path).length

      await internals.listResolvedWorktrees()
      expect(scanCallsFor('/tmp/repo')).toBe(1)
      expect(scanCallsFor(scratchPath)).toBe(1)

      vi.advanceTimersByTime(BASE_TTL_MS + 1_000)
      await internals.listResolvedWorktrees()
      expect(scanCallsFor('/tmp/repo')).toBe(2)
      expect(scanCallsFor(scratchPath)).toBe(1)

      vi.advanceTimersByTime(SCRATCH_TTL_MS)
      await internals.listResolvedWorktrees()
      expect(scanCallsFor(scratchPath)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
