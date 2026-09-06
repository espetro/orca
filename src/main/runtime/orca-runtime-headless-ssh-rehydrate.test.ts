import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  electronMocks,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../shared/constants'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('briefly preserves abnormal SSH exits for paired pane recovery', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const runtime = new OrcaRuntimeService(store)
      const ptyId = 'ssh:ssh-1@@pty-recover'
      const tabId = 'host-tab'
      runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
        tabId,
        leafId: HEADLESS_LEAF_ID
      })
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-with-ssh-pane',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: `${tabId}::${HEADLESS_LEAF_ID}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${tabId}::${HEADLESS_LEAF_ID}`,
                parentTabId: tabId,
                leafId: HEADLESS_LEAF_ID,
                ptyId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      runtime.onPtyExit(ptyId, -1)

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-with-ssh-pane',
            snapshotVersion: 2,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ parentTabId: tabId, status: 'pending-handle' })
      ])

      vi.advanceTimersByTime(30_001)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-with-ssh-pane',
            snapshotVersion: 3,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('briefly preserves an unregistered SSH pane while a restarted HUB rebuilds PTY state', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const runtime = new OrcaRuntimeService(store)
      const ptyId = 'ssh:ssh-1@@pty-restart'
      const tabId = 'host-tab'
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-restarted-hub',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: `${tabId}::${HEADLESS_LEAF_ID}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${tabId}::${HEADLESS_LEAF_ID}`,
                parentTabId: tabId,
                leafId: HEADLESS_LEAF_ID,
                ptyId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-restarted-hub',
            snapshotVersion: 2,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ parentTabId: tabId, status: 'pending-handle' })
      ])

      vi.advanceTimersByTime(30_001)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-restarted-hub',
            snapshotVersion: 3,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hydrates a persisted SSH-owned pane before an attached renderer publishes its graph', async () => {
    const ptyId = 'ssh:ssh-1@@pty-persisted'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted SSH Terminal',
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-after-restart',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId,
        status: 'pending-handle'
      })
    ])
  })

  it('hydrates a persisted SSH-owned pane when the restarted renderer has not published sessions', async () => {
    const ptyId = 'ssh:ssh-1@@pty-persisted'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Persisted SSH Terminal',
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
    const localSession = getDefaultWorkspaceSession()
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === 'ssh:ssh-1' ? sshSession : localSession
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession
    } as never)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    expect(getWorkspaceSession).toHaveBeenCalledTimes(2)

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId,
        status: 'pending-handle'
      })
    ])
    expect(getWorkspaceSession).toHaveBeenCalledWith('ssh:ssh-1')
  })

  it('publishes a recovered SSH pane when its relay becomes ready after an empty restart replay', async () => {
    const ptyId = 'ssh:ssh-1@@pty-recovered'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Recovered SSH Terminal',
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
    const localSession = getDefaultWorkspaceSession()
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession: (hostId?: string | null) =>
        hostId === 'ssh:ssh-1' ? sshSession : localSession
    } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Recovered SSH Terminal' }
      ]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty-restart',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const reconcile = vi
      .spyOn(runtime, 'reconcileLegacyWorkerTerminals')
      .mockReturnValue(new Promise(() => undefined))

    runtime.notifySshRelayReady('ssh-1')
    await vi.waitFor(() =>
      expect(
        events.some((snapshot) =>
          snapshot.tabs.some(
            (tab) => tab.type === 'terminal' && tab.ptyId === ptyId && tab.status === 'ready'
          )
        )
      ).toBe(true)
    )

    expect(events.at(-1)?.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        ptyId,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
    expect(reconcile).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      materializeRenderer: false
    })
  })

  it('uses only a recent expired SSH lease as a bounded pane-recovery tombstone', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: null,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Expired SSH Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
          }
        })
      )
      let leaseState: 'expired' | 'terminated' = 'expired'
      let leaseUpdatedAt = Date.now()
      const getSshRemotePtyLeases = vi.fn(() => [
        {
          targetId: 'ssh-1',
          ptyId: 'pty-expired',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID,
          state: leaseState,
          createdAt: Date.now() - 1_000,
          updatedAt: leaseUpdatedAt
        }
      ])
      const runtime = new OrcaRuntimeService({
        ...runtimeStore,
        getSshRemotePtyLeases
      } as never)
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      })
      const publishEmpty = (snapshotVersion: number): void => {
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [
            {
              worktree: TEST_WORKTREE_ID,
              publicationEpoch: 'renderer-expired-lease',
              snapshotVersion,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            }
          ]
        })
      }

      publishEmpty(1)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ parentTabId: 'host-tab', status: 'pending-handle' })
      ])

      vi.advanceTimersByTime(30_001)
      publishEmpty(2)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])

      leaseState = 'terminated'
      leaseUpdatedAt = Date.now()
      publishEmpty(3)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not preserve a normally exited SSH shell for pane recovery', async () => {
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'ssh:ssh-1@@pty-normal-exit'
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-normal-exit',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId,
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyExit(ptyId, 0)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-normal-exit',
          snapshotVersion: 2,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('hydrates persisted serve-owned mobile session terminals while a renderer is attached', async () => {
    const focusTerminal = vi.fn()
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-persisted-pty', isReattach: true })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-persisted-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Mobile Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-persisted-pty' })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'serve-persisted-pty',
        status: 'pending-handle'
      })
    ])
    expect(listed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'host-tab',
      tabOrder: ['host-tab']
    })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'serve-persisted-pty',
        persistHostSessionBinding: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready'
    })
  })

  function makePendingAgentTabActivationRuntime(opts: { disabledTuiAgents?: string[] } = {}): {
    runtime: OrcaRuntimeService
    spawn: ReturnType<typeof vi.fn>
  } {
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-materialized-pty' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-dead-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              launchAgent: 'claude'
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
        }
      })
    )
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: opts.disabledTuiAgents ?? []
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    return { runtime, spawn }
  }

  it('launches the pending agent when mobile activation materializes an agent tab', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs[0]).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude',
      status: 'pending-handle'
    })

    // Why notifyClients false: mirrors the phone tapping the tab, the path that materializes pending tabs headlessly (#7587).
    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('claude'),
        sessionId: 'serve-dead-pty',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude',
      status: 'ready'
    })
  })

  it('materializes a plain shell when the pending tab has no launch agent', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-materialized-pty' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-dead-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: TEST_WORKTREE_ID })
    )
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
  })

  it('falls back to a plain shell when the pending tab agent is disabled', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime({
      disabledTuiAgents: ['claude']
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: TEST_WORKTREE_ID })
    )
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    // Why: the disabled-agent fallback keeps the tab's agent identity; only the startup command is skipped.
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      status: 'ready',
      launchAgent: 'claude'
    })
  })

  it('collapses duplicate mobile terminal entries when renderer and headless leaf ids diverge for the same pty', async () => {
    const rendererLeafId = HEADLESS_SECOND_LEAF_ID
    const ptyId = 'serve-persisted-pty'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Mobile Terminal',
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    const rendererSnapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer-graph',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: `host-tab::${rendererLeafId}`,
      activeTabType: 'terminal' as const,
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'host-tab',
          tabOrder: ['host-tab']
        }
      ],
      tabs: [
        {
          type: 'terminal' as const,
          id: `host-tab::${rendererLeafId}`,
          parentTabId: 'host-tab',
          leafId: rendererLeafId,
          ptyId,
          title: 'Persisted Mobile Terminal',
          isActive: true
        }
      ]
    }

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminalTabs = listed.tabs.filter((tab) => tab.type === 'terminal')

    expect(listed.tabs).toHaveLength(1)
    expect(terminalTabs).toHaveLength(1)
    expect(terminalTabs[0]).toMatchObject({
      type: 'terminal',
      id: `host-tab::${rendererLeafId}`,
      parentTabId: 'host-tab',
      leafId: rendererLeafId,
      ptyId
    })
  })

  it('keeps distinct split mobile terminal ptys under the same parent tab', async () => {
    const rendererLeftLeafId = '33333333-3333-4333-8333-333333333333'
    const rendererRightLeafId = '44444444-4444-4444-8444-444444444444'
    const leftPtyId = 'serve-left'
    const rightPtyId = 'serve-right'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: leftPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Split Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({
            [HEADLESS_LEAF_ID]: leftPtyId,
            [HEADLESS_SECOND_LEAF_ID]: rightPtyId
          })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    const rendererSnapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer-split-graph',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: `host-tab::${rendererLeftLeafId}`,
      activeTabType: 'terminal' as const,
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'host-tab',
          tabOrder: ['host-tab']
        }
      ],
      tabs: [
        {
          type: 'terminal' as const,
          id: `host-tab::${rendererLeftLeafId}`,
          parentTabId: 'host-tab',
          leafId: rendererLeftLeafId,
          ptyId: leftPtyId,
          title: 'Left',
          isActive: true
        },
        {
          type: 'terminal' as const,
          id: `host-tab::${rendererRightLeafId}`,
          parentTabId: 'host-tab',
          leafId: rendererRightLeafId,
          ptyId: rightPtyId,
          title: 'Right',
          isActive: false
        }
      ]
    }

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminalTabs = listed.tabs.filter((tab) => tab.type === 'terminal')

    expect(listed.tabs).toHaveLength(2)
    expect(terminalTabs).toHaveLength(2)
    expect(terminalTabs.map((tab) => tab.ptyId).sort()).toEqual([leftPtyId, rightPtyId])
    expect(terminalTabs.map((tab) => tab.leafId).sort()).toEqual(
      [rendererLeftLeafId, rendererRightLeafId].sort()
    )
  })

  it('hydrates legacy persisted terminal tabs without layout entries', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: {}
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs[0]

    expect(terminal).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      ptyId: 'persisted-pty',
      status: 'pending-handle'
    })
    expect(terminal?.id).toMatch(/^host-tab::[0-9a-f-]{36}$/)
  })

  it('does not mark persisted PTY id collisions ready without matching pane identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Unrelated PTY' }
      ]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'pending-handle',
      terminal: null
    })
  })

  it('kills persisted SSH PTYs when closing hydrated headless tabs before pane metadata is restored', async () => {
    const persistedPtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: persistedPtyId, cwd: TEST_WORKTREE_PATH, title: 'Remote' }]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith(persistedPtyId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('durably tears down a runtime-owned SSH headless tab when renderer cleanup fails', async () => {
    // #8958: the renderer relay can't see headless tabs, so its advisory fallback must not block authoritative teardown/flush.
    const persistedPtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const flushOrThrow = vi.fn()
    const rendererError = new Error('renderer unavailable')
    const closeTerminal = vi.fn(() => {
      throw rendererError
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: persistedPtyId, cwd: TEST_WORKTREE_PATH, title: 'Remote' }]
    })
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(persistedPtyId)
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(flushOrThrow).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[runtime] failed to notify renderer after headless terminal close',
      { parentTabId: 'host-tab', error: rendererError }
    )
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('retires an SSH-owned surface when a stale renderer acknowledges close after relay recovery', async () => {
    const ptyId = 'ssh:ssh-1@@relay-recovered-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Recovered SSH Terminal',
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
    const closeTerminal = vi.fn()
    const closeTerminalTab = vi.fn(async () => {})
    let runtime!: OrcaRuntimeService
    const kill = vi.fn((closedPtyId: string) => {
      runtime.onPtyExit(closedPtyId, 0)
      return true
    })
    runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Recovered SSH Terminal',
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
          ptyId
        },
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 2,
          ptyId: 'stale-renderer-pty'
        }
      ]
    })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!terminal || terminal.type !== 'terminal' || !terminal.terminal) {
      throw new Error('Expected a ready SSH terminal')
    }

    await expect(runtime.closeTerminal(terminal.terminal)).resolves.toEqual({
      handle: terminal.terminal,
      tabId: 'host-tab',
      ptyKilled: true
    })

    expect(closeTerminalTab).toHaveBeenCalledWith('host-tab', {
      localPtyTeardownOwnedExternally: true
    })
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('keeps the renderer close transaction for an adopted runtime-owned tab', async () => {
    // The renderer pin state can be newer than the debounced session, so once adopted its live close guard must win over stale persisted metadata.
    const servePtyId = 'serve-adopted-1'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: servePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Adopted Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              isPinned: false
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
    const closeTerminalTab = vi.fn(async () => {
      throw new Error('terminal_tab_pinned')
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: servePtyId, cwd: TEST_WORKTREE_PATH, title: 'Adopted' }]
    })
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Adopted Terminal',
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

    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')
    ).rejects.toThrow('terminal_tab_pinned')

    expect(closeTerminalTab).toHaveBeenCalledWith('host-tab')
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
  })

  it('materializes hydrated pending headless terminals with the persisted session identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'persisted-pty',
        persistHostSessionBinding: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
  })

  describe('deliberately parked pane activation (STA-3465)', () => {
    function makeParkedSessionStore(
      origin: SleepingAgentSessionRecord['origin'] | undefined,
      overrides: Partial<SleepingAgentSessionRecord> = {},
      ownerHostId = 'local'
    ) {
      return makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          sleepingAgentSessionsByPaneKey: {
            [`host-tab:${HEADLESS_LEAF_ID}`]: {
              paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
              tabId: 'host-tab',
              worktreeId: TEST_WORKTREE_ID,
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'provider-session-1' },
              prompt: 'do the thing',
              state: 'done',
              capturedAt: 1,
              updatedAt: 1,
              ...(origin ? { origin } : {}),
              ...overrides
            } as SleepingAgentSessionRecord
          }
        }),
        ownerHostId
      )
    }

    function makeParkedRuntime(runtimeStore: unknown): {
      runtime: OrcaRuntimeService
      spawn: ReturnType<typeof vi.fn>
    } {
      const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      return { runtime, spawn }
    }

    function setParkedRuntimeNotifier(
      runtime: OrcaRuntimeService,
      resumeSleepingAgents: (worktreeId: string) => void
    ): void {
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        resumeSleepingAgents,
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
    }

    const userActivate = (
      runtime: OrcaRuntimeService,
      leafId?: string
    ): Promise<RuntimeMobileSessionTabsResult> =>
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', leafId, {
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      })

    const automaticActivate = (
      runtime: OrcaRuntimeService,
      leafId?: string
    ): Promise<RuntimeMobileSessionTabsResult> =>
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', leafId, {
        notifyClients: false,
        navigation: 'caller',
        intent: 'automatic'
      })

    it('refuses an automatic reconnect probe for a deliberately slept pane', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).not.toHaveBeenCalled()
      expect(activated.tabs[0]).toMatchObject({
        type: 'terminal',
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        status: 'pending-handle',
        terminal: null
      })
      // Negative safety: refusing to wake must not retire the surface either.
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]).toMatchObject(
        { parentTabId: 'host-tab', status: 'pending-handle' }
      )
    })

    it('refuses an automatic probe that carries the leafId the probe sends', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime, HEADLESS_LEAF_ID)

      expect(spawn).not.toHaveBeenCalled()
      expect(activated.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    })

    // Why: opening the tab is the documented wake gesture for a slept pane
    // (#11598). These four cover every topology, because three of them never
    // clear the record — the pane's own activation is the only thing that wakes it.
    it('materializes a slept pane for a user tap under headless serve, which never wakes', async () => {
      const { runtimeStore, getSession } = makeParkedSessionStore('worktree-sleep')
      const resumeSleepingAgents = vi.fn()
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)
      setParkedRuntimeNotifier(runtime, resumeSleepingAgents)
      electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)

      const worktreeActivation = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'mobile'
      })

      expect(worktreeActivation.sleepingAgentWake).toBe('unsupported-headless')
      expect(resumeSleepingAgents).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`host-tab:${HEADLESS_LEAF_ID}`]?.origin
      ).toBe('worktree-sleep')

      const activated = await userActivate(runtime, HEADLESS_LEAF_ID)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('materializes a slept pane for a paired desktop client tab click, which asks for no wake', async () => {
      const { runtimeStore, getSession } = makeParkedSessionStore('worktree-sleep')
      const resumeSleepingAgents = vi.fn()
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)
      setParkedRuntimeNotifier(runtime, resumeSleepingAgents)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)

      await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'runtime'
      })

      expect(resumeSleepingAgents).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`host-tab:${HEADLESS_LEAF_ID}`]
      ).toBeDefined()

      const activated = await userActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: manual sleep of a finished agent stamps restoreOnTabOpenOnly, which the
    // background wake skips and resume classifies pane-owned, so the record survives.
    it('materializes a slept pane whose completed-agent record is restore-on-tab-open-only', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep', {
        state: 'done',
        restoreOnTabOpenOnly: true
      })
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await userActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: manual sleep of a running agent is the one topology whose wake relaunches
    // and clears the record, so the pane must materialize with the record gone too.
    it('materializes a slept running-agent pane after its wake cleared the record', async () => {
      const { runtimeStore, getSession, setSession } = makeParkedSessionStore('worktree-sleep', {
        state: 'working'
      })
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)
      const woken = structuredClone(getSession())
      delete woken.sleepingAgentSessionsByPaneKey?.[`host-tab:${HEADLESS_LEAF_ID}`]
      setSession(woken)

      const activated = await userActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: the field is additive, so a client that predates it sends nothing and
    // must keep its wake gesture rather than silently losing it.
    it('treats an absent intent as a user activation', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await runtime.activateMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab',
        undefined,
        { notifyClients: false, navigation: 'caller' }
      )

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: #11542's reconnect fix depends on an automatic activate materializing a
    // genuinely awaiting pane. These four prove the park guard did not break it.
    it('still materializes a pane awaiting reconnect with no sleeping record', async () => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID,
          sessionId: 'persisted-pty'
        })
      )
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('still materializes a pane whose record was captured while it was live', async () => {
      const { runtimeStore } = makeParkedSessionStore('live')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('still materializes a pane whose record was captured at app quit', async () => {
      const { runtimeStore } = makeParkedSessionStore('quit')
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    it('ignores a park record that belongs to a different worktree', async () => {
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep', {
        worktreeId: 'other-repo::/other'
      })
      const { runtime, spawn } = makeParkedRuntime(runtimeStore)

      const activated = await automaticActivate(runtime)

      expect(spawn).toHaveBeenCalledOnce()
      expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    })

    // Why: sleeping records live in the owning execution host's session partition,
    // so reading a fixed partition would miss the record on an SSH-host worktree.
    it('reads the park record from the worktree own execution-host partition', async () => {
      const sshRepo = { ...store.getRepos()[0]!, executionHostId: 'ssh:ssh-1' as const }
      const { runtimeStore } = makeParkedSessionStore('worktree-sleep', {}, 'ssh:ssh-1')
      const { runtime, spawn } = makeParkedRuntime({
        ...runtimeStore,
        getRepos: () => [sshRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? sshRepo : undefined)
      })

      const activated = await automaticActivate(runtime)

      expect(spawn).not.toHaveBeenCalled()
      expect(activated.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    })
  })
})
