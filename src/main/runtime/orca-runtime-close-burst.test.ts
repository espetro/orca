/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  MOCK_GIT_WORKTREES,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  deferred,
  electronMocks,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  resetRuntimeTestMocks,
  store,
  withPlatform
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { listWorktrees } from '../git/worktree'
import { ipcMain } from 'electron'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  describe('close intent adjudication', () => {
    // Shared setup: a renderer-adopted tab whose PTY the host sees alive.
    function makeAdoptedLiveTabRuntime(): {
      runtime: OrcaRuntimeService
      getSession: () => WorkspaceSessionState
      kill: ReturnType<typeof vi.fn>
      closeTerminal: ReturnType<typeof vi.fn>
      closeTerminalTab: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      processes: { id: string; cwd: string; title: string }[]
    } {
      const servePtyId = 'serve-live-1'
      const processes = [{ id: servePtyId, cwd: TEST_WORKTREE_PATH, title: 'Live' }]
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: servePtyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Live Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const closeTerminalTab = vi.fn(async () => {})
      const listProcesses = vi.fn(async () => processes)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses
      })
      runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Live Terminal',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: servePtyId
          }
        ]
      })
      return {
        runtime,
        getSession,
        kill,
        closeTerminal,
        closeTerminalTab,
        listProcesses,
        processes
      }
    }

    it.each(['pty-exit', 'cleanup'] as const)(
      'refuses a %s echoed close while the PTY is live and republishes the snapshot',
      async (reason) => {
        const { runtime, getSession, kill, closeTerminal, closeTerminalTab } =
          makeAdoptedLiveTabRuntime()
        const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
        const events: { worktree: string; snapshotVersion: number; tabs: unknown[] }[] = []
        const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

        const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason
        })

        unsubscribe()
        // No destructive branch may run: no PTY kill, no renderer close relay.
        expect(result).toEqual({
          closed: true,
          refused: true,
          refusalReason: 'live-host-pty',
          snapshotRepublished: true
        })
        expect(kill).not.toHaveBeenCalled()
        expect(closeTerminalTab).not.toHaveBeenCalled()
        expect(closeTerminal).not.toHaveBeenCalled()
        expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
        // The snapshot is republished (version bumped) so the echoing client
        // re-adds and re-attaches the still-live tab.
        const republished = events.filter((event) => event.worktree === TEST_WORKTREE_ID)
        expect(republished.length).toBeGreaterThan(0)
        const last = republished.at(-1)!
        expect(last.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
        expect(
          last.tabs.some((tab) => (tab as { parentTabId?: string }).parentTabId === 'host-tab')
        ).toBe(true)
      }
    )

    it('coalesces a reconnect close burst onto one authoritative PTY inventory', async () => {
      const { runtime, listProcesses, processes } = makeAdoptedLiveTabRuntime()
      const inventory = deferred<typeof processes>()
      listProcesses.mockImplementation(() => inventory.promise)

      const closes = Promise.all([
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'pty-exit'
        }),
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'cleanup'
        })
      ])
      await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1))
      inventory.resolve(processes)

      await expect(closes).resolves.toEqual([
        expect.objectContaining({ refused: true, refusalReason: 'live-host-pty' }),
        expect.objectContaining({ refused: true, refusalReason: 'live-host-pty' })
      ])
      expect(listProcesses).toHaveBeenCalledTimes(1)
    })

    it('keeps a live persisted PTY whose pane binding has not reconnected yet', async () => {
      const ptyId = 'persisted-pty'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Persisted Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Live' }]
      })

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'cleanup'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('keeps an explicit user close destructive while the PTY is live', async () => {
      const { runtime, closeTerminalTab } = makeAdoptedLiveTabRuntime()

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'user'
      })

      // Legacy whole-parent relay: the renderer close transaction still runs.
      expect(closeTerminalTab).toHaveBeenCalledWith('host-tab')
    })

    it('keeps a reasonless legacy close and republishes its live mirror', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.refuseUnattributedMobileSessionTabClose(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab'
      )
      const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'missing-intent',
        snapshotRepublished: true
      })
      expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('refuses a lifecycle close from a stale host publication', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const terminal = current.tabs.find((tab) => tab.type === 'terminal')
      if (!terminal || terminal.status !== 'ready') {
        throw new Error('expected a ready terminal fixture')
      }

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: 'stale-epoch',
        expectedTerminalHandle: terminal.terminal
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'stale-publication',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('refuses a reused tab id that names a different terminal incarnation', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: current.publicationEpoch,
        expectedTerminalHandle: 'term-from-retired-incarnation'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'stale-terminal',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('leaves dead renderer-owned retirement to the renderer without relaying a close', async () => {
      const { runtime, processes, kill, closeTerminal, closeTerminalTab } =
        makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const terminal = current.tabs.find((tab) => tab.type === 'terminal')
      if (!terminal || terminal.status !== 'ready') {
        throw new Error('expected a ready terminal fixture')
      }
      runtime.onPtyExit('serve-live-1', 0)
      processes.length = 0

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: current.publicationEpoch,
        expectedTerminalHandle: terminal.terminal
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'retirement-owner'
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    function makeSplitLeafRuntime(): {
      runtime: OrcaRuntimeService
      getSession: () => WorkspaceSessionState
      kill: ReturnType<typeof vi.fn>
      closeTerminal: ReturnType<typeof vi.fn>
    } {
      const layout = makeHeadlessTerminalLayout({
        [HEADLESS_LEAF_ID]: 'serve-left',
        [HEADLESS_SECOND_LEAF_ID]: 'serve-right'
      })
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: 'serve-left',
                worktreeId: TEST_WORKTREE_ID,
                title: 'Split Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: { 'host-tab': layout }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.setNotifier({ closeTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Split Terminal',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'serve-left',
            paneTitle: 'L'
          },
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_SECOND_LEAF_ID,
            paneRuntimeId: 2,
            ptyId: 'serve-right',
            paneTitle: 'R'
          }
        ]
      })
      return { runtime, getSession, kill, closeTerminal }
    }

    it('refuses a pty-exit echoed close of a live split leaf (direct-kill branch)', async () => {
      const { runtime, getSession, kill, closeTerminal } = makeSplitLeafRuntime()

      await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'pty-exit' }
      )

      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('still kills a live split leaf for an explicit user close', async () => {
      const { runtime, kill } = makeSplitLeafRuntime()

      await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'user' }
      )

      expect(kill).toHaveBeenCalledWith('serve-right')
      expect(kill).not.toHaveBeenCalledWith('serve-left')
    })

    it('refuses without republishing when the echoed leaf is dead but a sibling is live', async () => {
      // Why: the only reachable close path for a single leaf destroys the whole
      // parent (live sibling included), so the close must be refused — but a
      // republish would re-add the dead leaf on the echoing client and feed a
      // refuse→republish→re-echo loop.
      const { runtime, getSession, kill, closeTerminal } = makeSplitLeafRuntime()
      runtime.onPtyExit('serve-right', 0)
      const events: { worktree: string }[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

      const result = await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'pty-exit' }
      )

      unsubscribe()
      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty'
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(events.filter((event) => event.worktree === TEST_WORKTREE_ID)).toEqual([])
    })

    it('refuses a pty-exit echoed close of a runtime-owned headless tab with a live PTY', async () => {
      // Why: the headless close path kills every leaf PTY and de-persists the
      // parent; an echo must not reach it while the host sees the PTY alive.
      const servePtyId = 'serve-headless-live'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: servePtyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Serve Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.setNotifier({ closeTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Serve Terminal',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: servePtyId,
            paneTitle: 'A'
          }
        ]
      })

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('retires a dead headless tab on a pty-exit echoed close', async () => {
      // Why: headless hosts have no renderer pty-exit handling of their own;
      // they rely on the client echo to retire genuinely dead tab records.
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    })

    it('retires a dead headless tab whose exited PTY still has a retained record', async () => {
      // Why: onPtyExit keeps the disconnected record in ptysById for status and
      // exit reads — the production state after a real exit. The gate must not
      // read record presence as liveness or the dead tab never retires and the
      // client echo loops.
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const processes: { id: string; cwd: string; title: string }[] = [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ]
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => processes
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      // Seed the connected PTY record from the controller listing, then let the
      // process die: the record flips to disconnected but stays retained.
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      runtime.onPtyExit('persisted-pty', 0)
      processes.length = 0

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      expect(kill).not.toHaveBeenCalled()
    })

    it('keeps a headless tab when the provider inventory is unavailable', async () => {
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => {
          throw new Error('access denied')
        }
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'unknown-liveness',
        snapshotRepublished: true
      })
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
      expect(kill).not.toHaveBeenCalled()
    })
  })

  it('builds mobile session agent launch commands on the runtime host', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
        agentDefaultEnv: { 'command-code': { COMMAND_CODE_PROFILE: 'mobile-env' } }
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'command-code'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "command-code --profile mobile '--yolo'",
        cwd: TEST_WORKTREE_PATH,
        env: expect.objectContaining({
          COMMAND_CODE_PROFILE: 'mobile-env'
        }),
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('injects mobile quick-command prompts into the host-built agent startup command', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-prompt' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { codex: 'codex' },
        agentDefaultArgs: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'codex',
      agentPrompt: 'Review this diff'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/^codex .*'Review this diff'$/),
        launchAgent: 'codex',
        cwd: TEST_WORKTREE_PATH
      })
    )
  })

  it('rejects startup prompts for agents that require post-ready stdin', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-prompt' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'aider',
        agentPrompt: 'Review this diff'
      })
    ).rejects.toThrow('does not support startup prompt quick commands')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses portable Unix quoting for mobile agent launch commands in WSL project runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
      const runtime = new OrcaRuntimeService({
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
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `command-code --profile mobile '--note' 'can'"'"'t'`,
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('keeps PowerShell quoting for mobile agent launch commands in Windows host runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "command-code --profile mobile '--note' 'can''t'",
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('uses cmd.exe quoting for mobile agent launch commands in local Windows host runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-cmd' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
          terminalWindowsShell: 'cmd.exe'
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'command-code --profile mobile "--note" "can\'t"',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('publishes headless mobile session agent identity with synthesized PTY status', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'claude'
    })
    runtime.onPtyData('pty-agent', '\x1b]0;✳ Claude Code\x07', Date.now())

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(created.tab).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude'
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'claude'
        })
      })
    ])
  })

  it('rejects disabled mobile session agent launches before spawning', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('validates mobile terminal insertion anchors before resolving agent launch commands', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        afterTabId: 'stale-tab',
        agent: 'codex'
      })
    ).rejects.toThrow('after_tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forwards inactive mobile terminal creation to the renderer without focusing it', async () => {
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal,
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string; activate?: boolean }) => {
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: { send: vi.fn() } },
        { requestId: payload.requestId, error: 'spoofed renderer reply' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: `tab-renderer::${HEADLESS_LEAF_ID}`,
                parentTabId: 'tab-renderer',
                leafId: HEADLESS_LEAF_ID,
                ptyId: 'pty-renderer',
                title: 'Terminal',
                viewMode: 'chat',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        {
          requestId: payload.requestId,
          tabId: 'tab-renderer',
          title: 'Terminal'
        }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      viewMode: 'chat'
    })

    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        activate: false,
        source: 'runtime-session',
        viewMode: 'chat'
      })
    )
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(result.tab).toMatchObject({ parentTabId: 'tab-renderer', isActive: false })

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-renderer',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ parentTabId: 'tab-renderer', ptyId: 'pty-renderer' })
    ])

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-renderer',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 3,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-renderer',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 4,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('dedupes concurrent mobile terminal creates that share a clientMutationId', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: 'tab-renderer::pane:1',
                parentTabId: 'tab-renderer',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const [first, second] = await Promise.all([
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        clientMutationId: 'mutation-1'
      }),
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        clientMutationId: 'mutation-1'
      })
    ])

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(1)
    expect(second).toBe(first)
    expect(first.tab).toMatchObject({ parentTabId: 'tab-renderer' })
  })

  it('returns the settled success for a retried clientMutationId whose response was lost', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: 'tab-renderer::pane:1',
                parentTabId: 'tab-renderer',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const first = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-lost-response'
    })
    // Why: the phone retries the same key when the create response was lost; within the retention window it must reuse the terminal.
    const retried = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-lost-response'
    })

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(1)
    expect(retried).toBe(first)
  })

  it('does not dedupe mobile terminal creates across worktrees with the same clientMutationId', async () => {
    const otherWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-b`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: '/tmp/worktree-b',
        head: 'def',
        branch: 'feature/bar',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [otherWorktreeId]: makeWorktreeMeta({ displayName: 'other' })
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string; worktreeId: string }) => {
      const parentTabId =
        payload.worktreeId === TEST_WORKTREE_ID ? 'tab-renderer-a' : 'tab-renderer-b'
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: parentTabId, title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const firstCreate = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-1'
    })
    const secondCreate = runtime.createMobileSessionTerminal(`id:${otherWorktreeId}`, {
      activate: false,
      clientMutationId: 'mutation-1'
    })
    await vi.waitFor(() => {
      const createRequests = send.mock.calls.filter(
        ([channel]) => channel === 'terminal:requestTabCreate'
      )
      expect(createRequests).toHaveLength(2)
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer-a',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-renderer-a',
          paneTitle: null
        },
        {
          tabId: 'tab-renderer-b',
          worktreeId: otherWorktreeId,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-renderer-b',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-a',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: 'tab-renderer-a::pane:1',
              parentTabId: 'tab-renderer-a',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: false
            }
          ]
        },
        {
          worktree: otherWorktreeId,
          publicationEpoch: 'epoch-b',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: 'tab-renderer-b::pane:1',
              parentTabId: 'tab-renderer-b',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: false
            }
          ]
        }
      ]
    })
    const [first, second] = await Promise.all([firstCreate, secondCreate])

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(2)
    expect(first.tab).toMatchObject({ parentTabId: 'tab-renderer-a' })
    expect(second.tab).toMatchObject({ parentTabId: 'tab-renderer-b' })
  })

  it('materializes a renderer-created mobile terminal whose surface stays pending', async () => {
    vi.useFakeTimers()
    try {
      const pendingLeafId = '33333333-3333-4333-8333-333333333333'
      const closeTerminal = vi.fn()
      const revealTerminalSession = vi.fn()
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-materialized' })
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession,
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal,
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true,
        viewMode: 'terminal'
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-pending',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-pending::${pendingLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-pending::${pendingLeafId}`,
                parentTabId: 'tab-pending',
                leafId: pendingLeafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(999)

      expect(settled).toBe(false)
      expect(spawn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      const result = await settledCreate

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-pending',
        leafId: pendingLeafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/),
        viewMode: 'terminal',
        isActive: true
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-pending',
          leafId: pendingLeafId,
          persistHostSessionBinding: true,
          preAllocatedHandle: expect.stringMatching(/^term_/)
        })
      )
      expect(revealTerminalSession).toHaveBeenCalledWith(
        TEST_WORKTREE_ID,
        expect.objectContaining({
          ptyId: 'pty-materialized',
          tabId: 'tab-pending',
          leafId: pendingLeafId,
          viewMode: 'terminal'
        })
      )
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls back a half-created terminal whose surface never publishes', async () => {
    vi.useFakeTimers()
    try {
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal,
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      // Why: reply with a tabId but never sync a surface graph, so waitForMobileTerminalSurface times out and rollback runs.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-ghost', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const pending = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false
      })
      const settled = pending.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.advanceTimersByTimeAsync(11_000)
      const outcome = await settled

      expect(outcome.ok).toBe(false)
      expect(closeTerminal).toHaveBeenCalledWith('tab-ghost')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the five #7587 mobile-create tests share one notifier factory so interface changes live in one place.
  function createMobileCreateTestNotifier(
    closeTerminal: (tabId: string, paneRuntimeId?: number) => void
  ) {
    return {
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal,
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    }
  }

  it('rolls back a mobile create when the materialize spawn fails and no live PTY backs the tab', async () => {
    vi.useFakeTimers()
    try {
      const pendingLeafId = '99999999-9999-4999-8999-999999999999'
      const closeTerminal = vi.fn()
      // Why: #7587 rescue is gated on a live PTY, not on a mere surface — else this handle-less failed-spawn dead shell would resolve as success.
      const spawn = vi.fn().mockRejectedValue(new Error('spawn failed'))
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      const settled = create.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Only the tab shell publishes (no ptyId → never ready); no PTY ever binds.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-pending',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-pending::${pendingLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-pending::${pendingLeafId}`,
                parentTabId: 'tab-pending',
                leafId: pendingLeafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      // Ready-fallback (1s) expires → materialize runs → spawn rejects → catch.
      await vi.advanceTimersByTimeAsync(2_000)
      const outcome = await settled

      expect(outcome.ok).toBe(false)
      expect(closeTerminal).toHaveBeenCalledWith('tab-pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer never publishes the surface', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '44444444-4444-4444-8444-444444444444'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why: reply with a tabId but never sync a matching graph, reproducing a renderer that spawns the PTY but stalls graph-sync past the surface timeout (#7587).
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-alive', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true,
        viewMode: 'chat'
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // A shell-only snapshot can win the first race but omit launch props; the later PTY rescue must fill the explicit mode.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-shell',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-alive::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-alive::${leafId}`,
                parentTabId: 'tab-alive',
                leafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      // The renderer's PTY spawn registers with the tab binding (as the pty IPC layer now does) after the shell-only snapshot.
      runtime.registerPty('pty-alive', TEST_WORKTREE_ID, null, {
        tabId: 'tab-alive',
        leafId
      })

      // Resolves promptly, well under MOBILE_TERMINAL_SURFACE_TIMEOUT_MS (10s).
      await vi.advanceTimersByTimeAsync(50)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-alive',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/),
        viewMode: 'chat'
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer PTY spawn races ahead of the reply', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '55555555-5555-4555-8555-555555555555'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why: spawn and tabCreate reply are independent IPC channels; here the PTY registers before the reply, so the pre-wait check resolves it.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        runtime.registerPty('pty-early', TEST_WORKTREE_ID, null, {
          tabId: 'tab-early',
          leafId
        })
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-early', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Resolves via the immediate pre-wait rescue, well under the 10s timeout (not the catch path).
      await vi.advanceTimersByTimeAsync(50)
      expect(settled).toBe(true)
      const result = await settledCreate

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-early',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers the agent launch command when a create settles over a bare renderer PTY', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const write = vi.fn((_ptyId: string, _data: string) => true)
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: {}
        })
      } as never)
      runtime.setPtyController({
        spawn: vi.fn(),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        // Why: the pane spawned before its startup queue landed (the #7587
        // renderer-stall class), so no spawn command is recorded for the PTY.
        runtime.registerPty('pty-bare', TEST_WORKTREE_ID, null, { tabId: 'tab-bare', leafId })
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-bare', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        activate: true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      const result = await create

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-bare',
        leafId,
        status: 'ready'
      })
      // Why: the adopted PTY never launched codex, so the settle must type the
      // launch command (Enter as its own write) instead of succeeding silently.
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[0][0]).toBe('pty-bare')
      expect(String(write.mock.calls[0][1])).toMatch(/codex/)
      expect(write.mock.calls[1]).toEqual(['pty-bare', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-deliver the agent launch command when the adopted renderer PTY spawned with one', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '88888888-8888-4888-8888-888888888888'
      const write = vi.fn((_ptyId: string, _data: string) => true)
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: {}
        })
      } as never)
      runtime.setPtyController({
        spawn: vi.fn(),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        // Why: mirrors the spawn IPC handler — a command-carrying spawn records
        // its launch command right after registering the PTY.
        runtime.registerPty('pty-carried', TEST_WORKTREE_ID, null, { tabId: 'tab-carried', leafId })
        runtime.noteTerminalSpawnCommand('pty-carried', 'codex')
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-carried', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        activate: true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      const result = await create

      expect(result.tab).toMatchObject({ type: 'terminal', parentTabId: 'tab-carried' })
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer snapshot is rejected by the version guard', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '66666666-6666-4666-8666-666666666666'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-guard', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })
      // Why: seed an inflated stored version under a stable epoch (the state prior renderer publications leave behind).
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-guard',
            snapshotVersion: 50,
            activeGroupId: 'group-guard',
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Renderer republishes with a stale (lower) version under the same epoch, so syncMobileSessionTabs rejects it — the reporter's stall variant (#7587).
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-guard',
            snapshotVersion: 1,
            activeGroupId: 'group-guard',
            activeTabId: `tab-guard::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-guard::${leafId}`,
                parentTabId: 'tab-guard',
                leafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(50)
      // The rejected renderer sync must not have resolved the create.
      expect(settled).toBe(false)
      // Prove the rejection: the stored snapshot still lacks the tab.
      const beforeRescue = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(
        beforeRescue.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'tab-guard')
      ).toBe(false)

      // The renderer's own PTY spawn registers with the binding and rescues it.
      runtime.registerPty('pty-guard', TEST_WORKTREE_ID, null, {
        tabId: 'tab-guard',
        leafId
      })
      await vi.advanceTimersByTimeAsync(50)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-guard',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive at the surface timeout when only a leaf-synced PTY backs the tab', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why (#7587): leaf graph-sync lands identity without registerPty, so only the catch-path rescue saves the stalled live session.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-catch', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Let the create clear its pre-wait check and park in waitForMobileTerminalSurface before any identity arrives.
      await vi.advanceTimersByTimeAsync(50)

      // Identity arrives via leaf graph-sync, NOT registerPty, so no rescue fires and the surface is never published.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-catch',
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId: 'pty-catch'
          }
        ]
      })

      // Surface still unpublished, so the create is still pending.
      expect(settled).toBe(false)

      // Cross the 10s surface timeout: the catch path must rescue from the live PTY, not roll the session back destructively.
      await vi.advanceTimersByTimeAsync(11_000)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-catch',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports browser tab creation as unsupported for a windowless host with no offscreen backend', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('does not support browser panes')
    })
  })

  it('creates a browser tab via the offscreen backend for a headless runtime server', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const createTab = vi.fn(async () => ({ browserPageId: 'page-headless' }))
    runtime.setOffscreenBrowserBackend({ createTab, closeTab: vi.fn() })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).resolves.toEqual({ browserPageId: 'page-headless' })
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com' }))
  })

  it('cancels an in-flight same-connection browser screencast before replacing it', async () => {
    const runtime = createRuntime()
    const firstStart = deferred<{
      subscriptionId: string
      ready: never
      flushPendingFrame: () => void
      session: { stop: () => void; done: Promise<void> }
    }>()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const thirdDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const thirdStop = vi.fn(() => thirdDone.resolve())
    const browserScreencast = vi
      .fn()
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:second',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        flushPendingFrame: () => {},
        session: { stop: secondStop, done: secondDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:third',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:third',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        flushPendingFrame: () => {},
        session: { stop: thirdStop, done: thirdDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const secondEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await Promise.resolve()

    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: secondEmit }
    )
    const thirdEmit = vi.fn()
    const third = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: thirdEmit }
    )
    await Promise.resolve()

    expect(browserScreencast).toHaveBeenCalledTimes(1)

    firstStart.resolve({
      subscriptionId: 'browser-screencast:page-1:first',
      ready: {} as never,
      flushPendingFrame: () => {},
      session: { stop: firstStop, done: firstDone.promise }
    })
    await first
    await Promise.resolve()

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(firstEmit).not.toHaveBeenCalled()
    expect(browserScreencast).toHaveBeenCalledTimes(2)

    await second
    await Promise.resolve()

    expect(secondStop).toHaveBeenCalledTimes(1)
    expect(browserScreencast).toHaveBeenCalledTimes(3)
    expect(thirdEmit).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:third' })
    )

    runtime.cleanupSubscription('browser-screencast:page-1:third')
    await third

    expect(thirdStop).toHaveBeenCalledTimes(1)
  })

  it('keeps same-page screencasts alive for independent connections', async () => {
    const runtime = createRuntime()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const ready = (subscriptionId: string) => ({
      type: 'ready' as const,
      subscriptionId,
      browserPageId: 'page-1',
      format: 'jpeg' as const,
      tab: {
        browserPageId: 'page-1',
        index: 0,
        url: 'about:blank',
        title: 'Browser',
        active: true
      }
    })
    const browserScreencast = vi
      .fn()
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:first',
        ready: ready('browser-screencast:page-1:first'),
        flushPendingFrame: () => {},
        session: { stop: firstStop, done: firstDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: ready('browser-screencast:page-1:second'),
        flushPendingFrame: () => {},
        session: { stop: secondStop, done: secondDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await vi.waitFor(() =>
      expect(firstEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:first' })
      )
    )

    const secondEmit = vi.fn()
    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-2', sendBinary: vi.fn(), emit: secondEmit }
    )

    await vi.waitFor(() =>
      expect(secondEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:second' })
      )
    )
    expect(browserScreencast).toHaveBeenCalledTimes(2)
    expect(firstStop).not.toHaveBeenCalled()

    runtime.cleanupSubscription('browser-screencast:page-1:second')
    await second
    expect(firstStop).not.toHaveBeenCalled()
    expect(secondStop).toHaveBeenCalledTimes(1)
    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await first
    expect(firstStop).toHaveBeenCalledTimes(1)
  })

  it('dedupes async subscription cleanup and retains a failed cleanup for retry', async () => {
    const runtime = createRuntime()
    const cleanupError = new Error('physical teardown incomplete')
    const firstCleanup = deferred<void>()
    const cleanup = vi
      .fn()
      .mockReturnValueOnce(firstCleanup.promise)
      .mockRejectedValue(cleanupError)
    runtime.registerSubscriptionCleanup('files-watch-1', cleanup, 'conn-1')

    const first = runtime.cleanupSubscriptionAndWait('files-watch-1')
    const duplicate = runtime.cleanupSubscriptionAndWait('files-watch-1')
    expect(cleanup).toHaveBeenCalledTimes(1)
    firstCleanup.reject(cleanupError)
    await expect(first).rejects.toBe(cleanupError)
    await expect(duplicate).rejects.toBe(cleanupError)

    await expect(runtime.cleanupSubscriptionAndWait('files-watch-1')).rejects.toBe(cleanupError)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('does not let an old connection cleanup tear down its replacement subscription', async () => {
    const runtime = createRuntime()
    const oldDone = deferred<void>()
    const oldCleanup = vi.fn(() => oldDone.promise)
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:stable', oldCleanup, 'conn-old')
    runtime.registerSubscriptionCleanup('terminal:stable', replacementCleanup, 'conn-new')
    expect(oldCleanup).toHaveBeenCalledTimes(1)

    runtime.cleanupSubscriptionsForConnection('conn-old')
    expect(replacementCleanup).not.toHaveBeenCalled()

    runtime.cleanupSubscriptionsForConnection('conn-new')
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
    oldDone.resolve()
    await Promise.resolve()
  })

  it('does not let a delayed cleanup retry tear down its replacement subscription', async () => {
    const runtime = createRuntime()
    const physicalExit = deferred<void>()
    const oldDone = deferred<void>()
    const cleanupError = new Error('physical teardown incomplete')
    const oldCleanup = vi.fn(() => oldDone.promise)
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('files-watch:stable', oldCleanup, 'conn-old')
    const oldAttempt = runtime.cleanupSubscriptionAndWait('files-watch:stable')
    runtime.retrySubscriptionCleanupAfter('files-watch:stable', oldCleanup, physicalExit.promise)
    runtime.registerSubscriptionCleanup('files-watch:stable', replacementCleanup, 'conn-new')

    oldDone.reject(cleanupError)
    await expect(oldAttempt).rejects.toBe(cleanupError)
    physicalExit.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(oldCleanup).toHaveBeenCalledTimes(1)
    expect(replacementCleanup).not.toHaveBeenCalled()
    await runtime.cleanupSubscriptionAndWait('files-watch:stable')
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
  })

  it('releases an owned subscription only while its registration still owns the id', async () => {
    const runtime = createRuntime()
    const oldCleanup = vi.fn()
    const replacementCleanup = vi.fn()

    const oldRegistration = runtime.registerOwnedSubscriptionCleanup(
      'terminal:owned',
      oldCleanup,
      'conn-old'
    )

    runtime.registerOwnedSubscriptionCleanup('terminal:owned', replacementCleanup, 'conn-new')
    expect(oldCleanup).toHaveBeenCalledTimes(1)

    // The stale registration must not reach the replacement that now owns the id.
    oldRegistration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).not.toHaveBeenCalled()
  })

  it('releases an owned subscription when the registration is still current', async () => {
    const runtime = createRuntime()
    const cleanup = vi.fn()

    const registration = runtime.registerOwnedSubscriptionCleanup('terminal:live', cleanup, 'conn')
    registration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanup).toHaveBeenCalledTimes(1)
    // A second release is a no-op: the registration no longer owns the id.
    registration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses an unsubscribe from a connection that no longer owns the subscription', async () => {
    const runtime = createRuntime()
    const oldCleanup = vi.fn()
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:unsub', oldCleanup, 'conn-old')
    runtime.registerSubscriptionCleanup('terminal:unsub', replacementCleanup, 'conn-new')

    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:unsub', 'conn-old')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).not.toHaveBeenCalled()

    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:unsub', 'conn-new')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
  })

  it('reports an unregistered subscription as gone rather than refused', async () => {
    const runtime = createRuntime()

    // Why it matters: a client retrying on `false` would otherwise chase a dead id.
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:missing', 'conn-a')).toBe(true)
  })

  it('reports a refusal even when a sibling id was merely absent', async () => {
    const runtime = createRuntime()
    const bareCleanup = vi.fn()
    const compositeCleanup = vi.fn()

    // A clientless stream registers under the bare id; a client-scoped one under the composite.
    runtime.registerSubscriptionCleanup('terminal-1', bareCleanup, 'conn-a')
    runtime.registerSubscriptionCleanup('terminal-1:phone-1', compositeCleanup, 'conn-b')

    // conn-a owns the bare id but not the composite: one genuine teardown, one refusal.
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal-1', 'conn-a')).toBe(true)
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal-1:phone-1', 'conn-a')).toBe(
      false
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bareCleanup).toHaveBeenCalledTimes(1)
    expect(compositeCleanup).not.toHaveBeenCalled()
  })

  // Why: the lease-only branch's unguarded compensating handleMobileUnsubscribe is only
  // safe while a viewport-less subscribe cannot yield to the macrotask queue. Pin it so
  // adding an await to that path fails here instead of silently killing a live lease.
  it('settles a viewport-less mobile subscribe without leaving the microtask queue', async () => {
    const runtime = createRuntime()
    let settled = false

    void runtime.handleMobileSubscribe('pty-lease', 'phone-1', undefined).then(() => {
      settled = true
    })
    // Drain microtasks only: any real await on this path leaves this unsettled.
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve()
    }

    expect(settled).toBe(true)
  })

  it('tears down unconditionally for in-process callers that have no connection', async () => {
    const runtime = createRuntime()
    const cleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:inproc', cleanup, 'conn-owner')
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:inproc', undefined)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses browser screencast frames before ready and replays them once it is emitted', async () => {
    const runtime = createRuntime()
    const done = deferred<void>()
    const stop = vi.fn(() => done.resolve())
    const startupFrame = new Uint8Array([1, 2, 3])
    const sendBinary = vi.fn()
    const emit = vi.fn()
    let pendingFrame: Uint8Array | null = null
    let gatedSend!: (bytes: Uint8Array) => boolean | void
    const browserScreencast = vi.fn(
      async (_params: unknown, stream: { sendBinary: typeof sendBinary }) => {
        gatedSend = stream.sendBinary
        // Why: a joining subscriber's viewport snapshot is captured here, before the caller
        // has emitted ready, so the fan-out retains what the gate refuses.
        if (gatedSend(startupFrame) === false) {
          pendingFrame = startupFrame
        }
        expect(sendBinary).not.toHaveBeenCalled()
        return {
          subscriptionId: 'browser-screencast:page-1:first',
          ready: {
            type: 'ready',
            subscriptionId: 'browser-screencast:page-1:first',
            browserPageId: 'page-1',
            format: 'jpeg',
            tab: {
              browserPageId: 'page-1',
              index: 0,
              url: 'about:blank',
              title: 'Browser',
              active: true
            }
          },
          flushPendingFrame: () => {
            const bytes = pendingFrame
            pendingFrame = null
            if (bytes) {
              gatedSend(bytes)
            }
          },
          session: { stop, done: done.promise }
        }
      }
    )

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const task = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary, emit }
    )

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
    )
    // The gate still refuses the frame on arrival; it reaches the client only via the
    // post-ready replay, so a static page does not leave the subscriber frameless.
    expect(sendBinary).toHaveBeenCalledExactlyOnceWith(startupFrame)

    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await task
  })
})
