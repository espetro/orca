/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  applyAgentStatusHooksEnabledMock,
  createRuntime,
  deferred,
  electronMocks,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixture'

import { OrcaRuntimeService } from './orca-runtime'

import { MAX_QUICK_COMMANDS } from '../../shared/terminal-quick-commands'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

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
})
