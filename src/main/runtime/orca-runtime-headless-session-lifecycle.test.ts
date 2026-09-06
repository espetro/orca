import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  electronMocks,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  waitForMobileSessionTabsEvents
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('reattaches hydrated SSH headless terminals with the persisted relay identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'ssh:ssh-1@@relay-pty',
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
          'host-tab': makeHeadlessTerminalLayout({
            [HEADLESS_LEAF_ID]: 'ssh:ssh-1@@relay-pty'
          })
        }
      }),
      'ssh:ssh-1'
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@relay-pty', isReattach: true })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'ssh:ssh-1@@relay-pty',
        persistHostSessionBinding: true
      })
    )
  })

  it('spawns fresh after an expired hydrated SSH headless reattach clears persistence', async () => {
    const stalePtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: stalePtyId,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: stalePtyId })
        }
      }),
      'ssh:ssh-1'
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi
      .fn()
      .mockImplementationOnce(async () => {
        const session = getSession()
        ;(runtimeStore.setWorkspaceSession as unknown as (next: WorkspaceSessionState) => void)({
          ...session,
          tabsByWorktree: {
            ...session.tabsByWorktree,
            [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID].map((tab) =>
              tab.id === 'host-tab' ? { ...tab, ptyId: null } : tab
            )
          },
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            'host-tab': {
              ...session.terminalLayoutsByTabId['host-tab'],
              ptyIdsByLeafId: {}
            }
          }
        })
        throw new Error('SSH session expired')
      })
      .mockResolvedValueOnce({ id: 'ssh:ssh-1@@fresh-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')
    ).rejects.toThrow('SSH session expired')
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionId: 'ssh-1',
        sessionId: stalePtyId
      })
    )
    expect(spawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('sessionId')
  })

  it('keeps the activated headless tab active across PTY republishes (serve focus-jump regression)', async () => {
    // Why: in `orca serve`, focusTerminal has no renderer to persist the remote client's tab choice before PTY republishes.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `headless-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const FIRST_LEAF = '22222222-2222-4222-8222-222222222222'
    const SECOND_LEAF = '33333333-3333-4333-8333-333333333333'
    // The first-created headless terminal is the one the snapshot marks active.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-first',
      leafId: FIRST_LEAF
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-other',
      leafId: SECOND_LEAF
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // The remote client switches to the other (non-active) tab.
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-other')

    const afterActivate = events.at(-1)
    expect(afterActivate?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterActivate?.activeTabType).toBe('terminal')
    expect(afterActivate?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
    expect(
      afterActivate?.tabs.find((tab) => tab.id === `tab-other::${SECOND_LEAF}`)?.isActive
    ).toBe(true)
    expect(afterActivate?.tabs.find((tab) => tab.id === `tab-first::${FIRST_LEAF}`)?.isActive).toBe(
      false
    )

    // PTY title updates republish snapshots, so the client's chosen tab must survive activation.
    events.length = 0
    runtime.onPtyData('headless-pty-2', '\x1b]0;tab-other running\x07', 200)

    await waitForMobileSessionTabsEvents(events, 1)
    const afterPtyData = events.at(-1)
    expect(afterPtyData?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterPtyData?.activeTabType).toBe('terminal')
    expect(afterPtyData?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
  })

  it('does not bump the snapshot version when re-activating the already-active headless tab', async () => {
    // Why: redundant activations of the current tab must not force a remote re-render.
    const spawn = vi.fn().mockResolvedValue({ id: 'headless-pty-solo' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF = '44444444-4444-4444-8444-444444444444'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-solo', leafId: LEAF })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-solo')

    expect(events).toHaveLength(0)
  })

  it('does not persist active server-side when an authoritative renderer is attached', async () => {
    // Why: an authoritative renderer re-syncs the snapshot itself, so the headless persist must not fire — the renderer stays source of truth.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `attached-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF_A = '55555555-5555-4555-8555-555555555555'
    const LEAF_B = '66666666-6666-4666-8666-666666666666'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF_A })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-b', leafId: LEAF_B })

    // Make an authoritative renderer window present.
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-b')

    // The headless persist is gated off by the authoritative window — nothing emitted.
    expect(events).toHaveLength(0)
  })

  it('does not persist active server-side for a `:headless-merge:` snapshot after renderer detach', async () => {
    // Why: after renderer detach, merged snapshots have no authoritative window but still carry renderer-owned group state.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `merge-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF_A = '77777777-7777-4777-8777-777777777777'
    const LEAF_B = '88888888-8888-4888-8888-888888888888'
    // tab-a (first-created) is the snapshot's active tab.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF_A })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-b', leafId: LEAF_B })

    // Simulate a post-detach merged snapshot with no authoritative window.
    const current = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
    runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, {
      ...current,
      publicationEpoch: `renderer:headless-merge:${current.publicationEpoch}`
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // The merge exclusion must suppress server-side active rewrites.
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-b')

    expect(events).toHaveLength(0)
  })

  it('spawns fresh SSH terminals when hydrated persistence has no relay identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      }),
      'ssh:ssh-1'
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@fresh-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  })

  it('materializes the requested hydrated split leaf instead of the first sibling', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a',
      [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'pty-a',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Split Terminal',
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
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-b' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_SECOND_LEAF_ID
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_SECOND_LEAF_ID,
        sessionId: 'pty-b'
      })
    )
    expect(activated.tabs).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'host-tab',
        leafId: HEADLESS_SECOND_LEAF_ID,
        status: 'ready'
      })
    )
  })

  it('rejects missing requested split leaves instead of activating a sibling', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a'
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: { 'host-tab': layout }
      })
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'unexpected-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.activateMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab',
        HEADLESS_SECOND_LEAF_ID
      )
    ).rejects.toThrow('tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('closes persisted headless terminal parents and kills every live leaf', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a',
      [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
    })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'pty-a',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted Terminal',
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
          ptyId: 'pty-a',
          paneTitle: 'A'
        },
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 2,
          ptyId: 'pty-b',
          paneTitle: 'B'
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith('pty-a')
    expect(kill).toHaveBeenCalledWith('pty-b')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('closes persisted headless terminal parents before any prior list call', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('tears down a serve-owned headless tab on close while a renderer is attached so it cannot resurrect', async () => {
    const servePtyId = 'serve-headless-1'
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
    // Why: an attached renderer (closeTerminal exists) sends the close down the renderer-attached path that historically leaked serve-owned tabs.
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

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith(servePtyId)
    // De-persist so syncMobileSessionTabs cannot re-hydrate and resurrect it.
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    // Best-effort renderer notify so no adopted pane is left dead.
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
  })

  it('delegates a renderer-owned daemon-session (worktreeId@@uuid) local terminal to the renderer', async () => {
    // Why: the daemon mints <worktreeId>@@<uuid> for ordinary renderer-owned terminals too, so id shape alone must not mark it runtime-owned (regression: killed normal locals).
    const daemonPtyId = `${TEST_WORKTREE_ID}@@d9213842`
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: daemonPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Daemon Session Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: daemonPtyId })
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
    // Renderer graph PUBLISHES this tab -> it is renderer-owned.
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Daemon Session Terminal',
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
          ptyId: daemonPtyId,
          paneTitle: 'A'
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(kill).not.toHaveBeenCalled()
    // Not torn down by the runtime — left for the renderer's own close to prune.
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
  })

  it('tears down a leaked daemon-session headless tab the renderer never published', async () => {
    // Why: same <worktreeId>@@<uuid> id but absent from the renderer graph — a real leak that must be de-persisted so syncMobileSessionTabs can't resurrect it.
    const daemonPtyId = `${TEST_WORKTREE_ID}@@77e25ca0`
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: daemonPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Leaked Daemon Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: daemonPtyId })
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
    // Empty renderer graph -> the host's tab was never published by the renderer.
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
  })

  it('defers a renderer-published pending tab to the renderer instead of tearing it down', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.setNotifier({ closeTerminal } as never)
    // Pending tab in the renderer graph (PTY not bound yet) is renderer-owned, so the runtime forwards the close but must not de-persist it.
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Pending Terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:pending',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              title: 'Pending Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(forgetTabs).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    // Not torn down by the runtime: the renderer-owned tab is left for the renderer's own close to prune.
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
  })

  it('returns a delegated close outcome with no selection tombstone when the renderer owns the outcome', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
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
          title: 'Pending Terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:pending',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              title: 'Pending Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.closeMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`
    )

    // Why: a delegated close is handed to the renderer over a fire-and-forget
    // notifier that may decline it, so tombstoning would hide a live tab from
    // paired clients forever. Only a host-committed close may tombstone.
    expect(result).toEqual({ closed: true })
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(forgetTabs).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
  })

  it('tears down a runtime pending shell the renderer never adopted on close', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
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
    // Empty graph → this persisted headless shell (no live PTY) is runtime-owned and must be torn down or it re-hydrates on next publish.
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
  })

  it('closes only the addressed serve-owned split leaf so siblings survive even with a renderer attached', async () => {
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

    await runtime.closeMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_SECOND_LEAF_ID}`
    )

    // Exact split leaf: kill only that leaf's PTY, keep the sibling, don't tear down the parent.
    expect(kill).toHaveBeenCalledWith('serve-right')
    expect(kill).not.toHaveBeenCalledWith('serve-left')
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
  })
})
