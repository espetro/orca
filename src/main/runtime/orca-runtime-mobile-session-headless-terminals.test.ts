import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  MOCK_GIT_WORKTREES,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  createFolderWorkspaceRuntimeStore,
  electronMocks,
  expectStablePaneKeyEnv,
  makeDeferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  waitForMobileSessionTabsEvents
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { listWorktrees } from '../git/worktree'
import { ipcMain } from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('creates mobile session terminals in a headless runtime server', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-headless' })
    const runtime = new OrcaRuntimeService(store)
    const persistViewMode = vi.spyOn(
      runtime as unknown as {
        persistHeadlessSessionTabProps: (
          worktreeId: string,
          tabId: string,
          props: { viewMode: 'terminal' | 'chat' }
        ) => void
      },
      'persistHeadlessSessionTabProps'
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      viewMode: 'chat'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        tabId: expect.stringMatching(UUID_RE),
        leafId: expect.stringMatching(UUID_RE),
        persistHostSessionBinding: true,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      terminal: expect.stringMatching(/^term_/),
      viewMode: 'chat',
      isActive: true
    })
    expect(persistViewMode).toHaveBeenCalledWith(TEST_WORKTREE_ID, result.tab.parentTabId, {
      viewMode: 'chat'
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        id: result.tab.id,
        status: 'ready',
        terminal: result.tab.terminal
      })
    ])
  })

  it('leases renderer publication for a paired create and preserves host-owned inventory', async () => {
    const leafId = '91919191-9191-4919-8919-919191919191'
    const spawn = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const webContents: {
      isDestroyed: () => boolean
      setBackgroundThrottling: typeof setBackgroundThrottling
      send: ReturnType<typeof vi.fn>
    } = {
      isDestroyed: () => false,
      setBackgroundThrottling,
      send: vi.fn()
    }
    webContents.send.mockImplementation((_channel: string, payload: { requestId: string }) => {
      expect(setBackgroundThrottling).toHaveBeenCalledWith(false)
      runtime.registerPty('pty-paired-headed', TEST_WORKTREE_ID, null, {
        tabId: 'tab-paired-headed',
        leafId
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-paired-headed', title: 'Terminal' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-paired-headed',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-paired-headed',
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId: 'pty-paired-headed'
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer:paired-headed',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: `tab-paired-headed::${leafId}`,
                parentTabId: 'tab-paired-headed',
                leafId,
                ptyId: 'pty-paired-headed',
                title: 'Terminal',
                viewMode: 'chat',
                isActive: false
              }
            ]
          }
        ]
      })
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller',
      activate: false,
      select: false,
      viewMode: 'chat'
    })

    expect(webContents.send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({ source: 'runtime-session', viewMode: 'chat' })
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      ptyId: 'pty-paired-headed',
      terminal: expect.stringMatching(/^term_/),
      viewMode: 'chat'
    })
    const host = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const clientA = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-a')
    const clientB = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-b')
    const inventory = (snapshot: RuntimeMobileSessionTabsResult) =>
      snapshot.tabs.map((tab) =>
        tab.type === 'terminal'
          ? {
              id: tab.id,
              type: tab.type,
              leafId: tab.leafId,
              parentTabId: tab.parentTabId,
              ptyId: tab.ptyId
            }
          : { id: tab.id, type: tab.type }
      )
    expect(inventory(clientA)).toEqual(inventory(host))
    expect(inventory(clientB)).toEqual(inventory(host))

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    expect(runtime['syncMobileSessionTabs']([])).toEqual(new Set([TEST_WORKTREE_ID]))
    expect(runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)?.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'tab-paired-headed',
        leafId,
        ptyId: 'pty-paired-headed'
      })
    ])
    const restoredHost = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const restoredClientA = await runtime.listMobileSessionTabs(
      `id:${TEST_WORKTREE_ID}`,
      'device-a'
    )
    const restoredClientB = await runtime.listMobileSessionTabs(
      `id:${TEST_WORKTREE_ID}`,
      'device-b'
    )
    expect(inventory(restoredHost)).toEqual(inventory(host))
    expect(inventory(restoredClientA)).toEqual(inventory(host))
    expect(inventory(restoredClientB)).toEqual(inventory(host))
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['paired', 'reloading'],
    ['paired', 'unavailable'],
    ['unpaired', 'reloading'],
    ['unpaired', 'unavailable']
  ] as const)(
    'does not spawn a %s terminal while the headed renderer graph is %s',
    async (caller, graphStatus) => {
      const spawn = vi.fn()
      const send = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send, setBackgroundThrottling: vi.fn() }
      })
      if (graphStatus === 'reloading') {
        runtime.markRendererReloading(1)
      } else {
        runtime.markGraphUnavailable(1)
      }

      await expect(
        runtime.createMobileSessionTerminal(
          `id:${TEST_WORKTREE_ID}`,
          caller === 'paired'
            ? { clientNavigationId: 'device-a', navigation: 'caller' as const }
            : {}
        )
      ).rejects.toThrow('runtime_unavailable')
      expect(spawn).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('rejects a paired create if renderer authority changes across async resolution', async () => {
    const spawn = vi.fn()
    const send = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send, setBackgroundThrottling }
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    let resolutionStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      resolutionStarted = resolve
    })
    let releaseResolution = (): void => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseResolution = () => resolve(MOCK_GIT_WORKTREES)
          resolutionStarted()
        })
    )

    const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })
    await started
    expect(spawn).not.toHaveBeenCalled()
    runtime.markRendererReloading(1)
    releaseResolution()
    await expect(create).rejects.toThrow('runtime_unavailable')
    expect(send).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('cancels a paired renderer-owned create before publication when its client disconnects', async () => {
    const spawn = vi.fn()
    const send = vi.fn()
    const setBackgroundThrottling = vi.fn()
    const abort = new AbortController()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send, setBackgroundThrottling }
    })
    abort.abort()

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')
    expect(spawn).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('selects a created terminal only for the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-headless-${++spawnIndex}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const hostTerminal = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    const callerTerminal = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).activeTabId).toBe(
      hostTerminal.tab.id
    )
    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-a')).activeTabId
    ).toBe(callerTerminal.tab.id)
    expect(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`, 'device-b')).activeTabId
    ).toBe(hostTerminal.tab.id)
  })

  it('scopes terminal-create idempotency to the paired caller', async () => {
    let spawnIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-headless-${++spawnIndex}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const [createdA, createdB] = await Promise.all([
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-a',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      }),
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        clientNavigationId: 'device-b',
        navigation: 'caller',
        clientMutationId: 'same-mutation'
      })
    ])

    expect(createdA.tab.id).not.toBe(createdB.tab.id)
    expect(spawnIndex).toBe(2)
  })

  it('creates mobile session terminals for folder workspaces in a headless runtime server', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-mobile-folder-workspace-'))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-mobile-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_FOLDER_WORKSPACE_KEY}`)

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expect(spawnCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY,
      persistHostSessionBinding: true
    })
    expectStablePaneKeyEnv(spawnedEnv)
    expect(spawnedEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(spawnedEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(spawnedEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      terminal: expect.stringMatching(/^term_/),
      isActive: true
    })
  })

  it('spawns fresh headless SSH mobile session terminals instead of reattaching synthetic local ids', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@remote-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  })

  it('hydrates headless mobile session terminals from the host workspace session', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
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

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'persisted-pty',
        status: 'pending-handle',
        terminal: null,
        isActive: true
      })
    ])
    expect(listed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'host-tab',
      tabOrder: ['host-tab']
    })
  })

  it('hydrates an SSH worktree only from its SSH workspace-session partition', async () => {
    const localSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'local-decoy-tab',
            ptyId: 'local-decoy-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Local decoy',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'local-decoy-tab': makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: 'local-decoy-pty'
        })
      }
    })
    const sshPtyId = 'ssh:ssh-1@@remote-pty'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'ssh-host-tab',
            ptyId: sshPtyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'SSH host terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'ssh-host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: sshPtyId })
      }
    })
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
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({ parentTabId: 'ssh-host-tab', ptyId: sshPtyId })
    ])
    expect(listed.tabs).not.toEqual([expect.objectContaining({ parentTabId: 'local-decoy-tab' })])
    expect(getWorkspaceSession).toHaveBeenCalledWith('ssh:ssh-1')
  })

  it('closes a headless SSH tab only in its SSH workspace-session partition', async () => {
    const sshPtyId = 'ssh:ssh-1@@remote-pty'
    const localSession = makeWorkspaceSessionWithHeadlessTerminal()
    let sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'ssh-host-tab',
            ptyId: sshPtyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'SSH host terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'ssh-host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: sshPtyId })
      }
    })
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const setWorkspaceSession = vi.fn((session: WorkspaceSessionState, hostId?: string | null) => {
      expect(hostId).toBe('ssh:ssh-1')
      sshSession = session
    })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession: (hostId?: string | null) =>
        hostId === 'ssh:ssh-1' ? sshSession : localSession,
      setWorkspaceSession
    } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'ssh-host-tab')

    expect(sshSession.tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(localSession.tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(setWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(sshPtyId)
  })

  it('keeps live headless mobile session terminals when a desktop renderer publishes without them', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-mobile-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.syncWindowGraph(0, {
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
        id: created.tab.id,
        parentTabId: created.tab.parentTabId,
        leafId: created.tab.leafId,
        ptyId: 'serve-mobile-pty',
        status: 'ready'
      })
    ])
  })

  it('keeps a live headed runtime-owned tab until its explicit close', async () => {
    const ptyId = 'local-runtime-owned-pty'
    const splitPtyId = 'local-runtime-owned-split-pty'
    const tabId = 'runtime-session-tab'
    const leafId = HEADLESS_LEAF_ID
    const kill = vi.fn(() => true)
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: tabId,
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'codex'
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: makeHeadlessTerminalLayout({ [leafId]: undefined })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValueOnce({ id: ptyId }).mockResolvedValueOnce({ id: splitPtyId }),
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: ptyId,
          cwd: TEST_WORKTREE_PATH,
          title: 'Codex',
          worktreeId: TEST_WORKTREE_ID
        },
        {
          id: splitPtyId,
          cwd: TEST_WORKTREE_PATH,
          title: 'Codex',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    const publishRendererOmission = (snapshotVersion: number): void => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'headed-runtime',
            snapshotVersion,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
    }
    runtime.attachWindow(1)
    publishRendererOmission(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })

    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      presentation: 'background',
      tabId,
      leafId,
      launchAgent: 'codex'
    })
    const split = await runtime.splitTerminal(created.handle, { direction: 'vertical' })
    publishRendererOmission(2)

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${tabId}::${leafId}`,
          parentTabId: tabId,
          ptyId,
          status: 'ready',
          terminal: created.handle
        }),
        expect.objectContaining({
          parentTabId: tabId,
          ptyId: splitPtyId,
          status: 'ready',
          terminal: split.handle
        })
      ])
    )
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toHaveLength(2)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, tabId, { reason: 'user' })
    publishRendererOmission(3)

    expect(kill).toHaveBeenCalledWith(ptyId)
    expect(kill).toHaveBeenCalledWith(splitPtyId)
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('publishes laptop-created remote runtime terminals to phone session tabs', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
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

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      command: "claude 'work on the issue'",
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Codex working\x07', Date.now())
    runtime.onPtyData('laptop-created-pty', 'Claude is working...\r\n', Date.now())

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(laptopTerminal.surface).toBe('background')
    expect(phoneTabs.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'laptop-tab',
        leafId: HEADLESS_LEAF_ID,
        status: 'ready',
        terminal: laptopTerminal.handle,
        agentStatus: expect.objectContaining({
          state: 'working',
          paneKey: `laptop-tab:${HEADLESS_LEAF_ID}`,
          terminalHandle: laptopTerminal.handle
        })
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      tail: ['Claude is working...']
    })
  })

  it('keeps background-presentation PTY-backed mobile session tabs inactive', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: true,
      presentation: 'background',
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(phoneTabs.activeTabId).toBeNull()
    expect(phoneTabs.tabs[0]).toMatchObject({
      type: 'terminal',
      id: `laptop-tab::${HEADLESS_LEAF_ID}`,
      isActive: false
    })
  })

  it('replaces pending phone session tabs when a laptop-created remote PTY becomes live', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-pending',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `laptop-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [{ id: 'group-1', activeTabId: 'laptop-tab', tabOrder: ['laptop-tab'] }],
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'laptop-tab',
              leafId: HEADLESS_LEAF_ID,
              title: 'Starting Claude',
              isActive: true
            }
          ]
        }
      ]
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(phoneTabs.tabs).toHaveLength(1)
    expect(phoneTabs.tabs[0]).toMatchObject({
      type: 'terminal',
      id: `laptop-tab::${HEADLESS_LEAF_ID}`,
      status: 'ready',
      terminal: laptopTerminal.handle
    })
  })

  it('publishes laptop-created remote runtime split terminals to phone session tabs', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'laptop-created-pty' })
      .mockResolvedValueOnce({ id: 'laptop-split-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    const split = await runtime.splitTerminal(laptopTerminal.handle, {
      direction: 'vertical'
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminalTabs = phoneTabs.tabs.filter((tab) => tab.type === 'terminal')

    expect(split.tabId).toBe('laptop-tab')
    expect(terminalTabs).toHaveLength(2)
    expect(terminalTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: 'laptop-tab',
          leafId: HEADLESS_LEAF_ID,
          status: 'ready',
          terminal: laptopTerminal.handle
        }),
        expect.objectContaining({
          parentTabId: 'laptop-tab',
          status: 'ready',
          terminal: split.handle
        })
      ])
    )
  })

  it('pushes PTY-backed mobile session tab title and agent status changes to subscribers', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude waiting for permission\x07', 124)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            agentStatus: expect.objectContaining({
              state: 'blocked',
              terminalHandle: laptopTerminal.handle
            })
          })
        ]
      })
    ])

    unsubscribe()
  })

  it('does not publish stale PTY-backed mobile agent status for Claude agents screens', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    expect(events[0]?.tabs[0]).not.toHaveProperty('agentStatus')

    unsubscribe()
  })

  it('uses fresh PTY management titles over stale mobile snapshot and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-stale',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `laptop-tab::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              title: 'Claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `laptop-tab:${leafId}`,
                terminalTitle: 'Claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    // Stale "working" suppressed; agent identity retained for native chat.
    const suppressed = result.tabs[0]
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.state).toBe('done')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.agentType).toBe('claude')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.terminalTitle).toBeUndefined()
  })

  it('uses fresh neutral PTY titles over stale mobile snapshot and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-stale',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `laptop-tab::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              title: 'Claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `laptop-tab:${leafId}`,
                terminalTitle: 'Claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;zsh\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'zsh'
      })
    )
    // Stale "working" suppressed; agent identity retained for native chat.
    const suppressed = result.tabs[0]
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.state).toBe('done')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.agentType).toBe('claude')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.terminalTitle).toBeUndefined()
  })

  it('pushes PTY-backed mobile session retirement when a server PTY exits', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyExit('laptop-created-pty', 0)

    expect(events).toEqual([
      expect.objectContaining({
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('operates PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ closeTerminal } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    await expect(runtime.renameTerminal(laptopTerminal.handle, 'Shared Claude')).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      title: 'Shared Claude'
    })
    await expect(runtime.focusTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      worktreeId: TEST_WORKTREE_ID,
      navigated: false
    })
    await expect(runtime.closeTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('laptop-created-pty')
    expect(closeTerminal).toHaveBeenCalledWith('laptop-tab')
  })

  it('waits for renderer acknowledgement before returning a whole-tab close receipt', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const acknowledged = makeDeferred()
    const closeTerminalTab = vi.fn(() => acknowledged.promise)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Durable',
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
          ptyId: 'persisted-pty'
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const pending = runtime.closeTerminalTab(terminal.handle)
    let settled = false
    void pending.finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    expect(settled).toBe(false)

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({
      handle: terminal.handle,
      tabId: 'host-tab',
      closeMode: 'tab',
      ptyKilled: false
    })
  })

  it('leases renderer publication until a paired whole-tab close is acknowledged', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const acknowledged = makeDeferred()
    const closeTerminalTab = vi.fn(() => acknowledged.promise)
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Durable',
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
          ptyId: 'persisted-pty'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:paired-close',
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
              ptyId: 'persisted-pty',
              title: 'Durable',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling
      }
    })

    const pending = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      reason: 'user',
      clientNavigationId: 'device-a'
    })
    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    expect(setBackgroundThrottling.mock.calls).toEqual([[false]])

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })

  it('accepts a paired close after the renderer already persisted its removal', async () => {
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const acknowledged = makeDeferred()
    const closeTerminalTab = vi.fn(() => acknowledged.promise)
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
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
          title: 'Durable',
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
          ptyId: 'persisted-pty'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:paired-close',
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
              ptyId: 'persisted-pty',
              title: 'Durable',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: vi.fn()
      }
    })

    const pending = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      reason: 'user',
      clientNavigationId: 'device-a'
    })
    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    const session = getSession()
    setSession({
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [TEST_WORKTREE_ID]: [] },
      terminalLayoutsByTabId: {}
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    expect(kill).toHaveBeenCalledWith('persisted-pty')
  })

  it('reuses pane close for live PTYs that do not own a renderer tab', async () => {
    const kill = vi.fn(() => true)
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'floating-created-pty',
          cwd: TEST_WORKTREE_PATH,
          title: 'Claude'
        }
      ]
    })
    runtime.registerPty('floating-created-pty', TEST_WORKTREE_ID)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      tabId: terminal.tabId,
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('floating-created-pty')
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('durably closes every split leaf without a renderer', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'durable-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Durable',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'durable-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      })
    )
    const flushOrThrow = vi.fn()
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'headless-left' })
      .mockResolvedValueOnce({ id: 'headless-right' })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'durable-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await runtime.splitTerminal(terminal.handle, { direction: 'vertical' })

    await runtime.closeTerminalTab(terminal.handle)

    expect(kill).toHaveBeenCalledWith('headless-left')
    expect(kill).toHaveBeenCalledWith('headless-right')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['durable-tab']).toBeUndefined()
    expect(flushOrThrow).toHaveBeenCalledTimes(1)
  })

  it('lists PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [
        expect.objectContaining({
          handle: laptopTerminal.handle,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          connected: true,
          preview: 'hello'
        })
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('shows and resolves active PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.resolveActiveTerminal(`id:${TEST_WORKTREE_ID}`)).resolves.toBe(
      laptopTerminal.handle
    )
    await expect(runtime.showTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Claude working',
      connected: true,
      ptyId: 'laptop-created-pty'
    })
  })

  it('keeps split sibling headless mobile terminal leaves when a desktop renderer omits them', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:split-siblings',
          snapshotVersion: 1,
          activeGroupId: 'headless-group',
          activeTabId: 'host-tab::pane:2',
          activeTabType: 'terminal',
          tabGroups: [
            {
              id: 'headless-group',
              activeTabId: 'host-tab',
              tabOrder: ['host-tab']
            }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'left',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'host-tab::pane:2',
              parentTabId: 'host-tab',
              leafId: 'pane:2',
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 2,
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
        id: 'host-tab::pane:1',
        parentTabId: 'host-tab',
        leafId: 'pane:1'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: 'host-tab::pane:2',
        parentTabId: 'host-tab',
        leafId: 'pane:2'
      })
    ])
    expect(listed.activeTabId).toBe('host-tab::pane:2')
  })

  it('keeps a headless tab-group split alive when a new tab is created', async () => {
    // Regression: drag-to-split-group was client-only and the headless host rejected it, coalescing groups on new-tab; the host must model + persist the split.
    let ptyCounter = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `split-group-pty-${++ptyCounter}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const first = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const second = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })

    const beforeSplit = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(beforeSplit.tabGroups).toHaveLength(1)
    const sourceGroupId = beforeSplit.tabGroups![0]!.id
    const secondHostTabId = second.tabId!

    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: secondHostTabId,
      targetGroupId: sourceGroupId,
      splitDirection: 'right'
    })

    const afterSplit = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterSplit.tabGroups).toHaveLength(2)
    expect(afterSplit.tabGroupLayout).toMatchObject({ type: 'split', direction: 'horizontal' })

    // The actual bug: creating a new tab must NOT collapse the split.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })

    const afterNewTab = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterNewTab.tabGroups).toHaveLength(2)
    expect(afterNewTab.tabGroupLayout).toMatchObject({ type: 'split' })
    // The split-off group keeps exactly its one tab; the new tab joins the other.
    const splitOffGroup = afterNewTab.tabGroups!.find((group) => group.id !== sourceGroupId)!
    expect(splitOffGroup.tabOrder).toEqual([secondHostTabId])
    expect(first.tabId).toBeTruthy()

    // Regression (#2): reordering one group must not delete the other group.
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'reorder',
      tabId: secondHostTabId,
      targetGroupId: splitOffGroup.id,
      tabOrder: [secondHostTabId]
    })
    const afterReorder = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterReorder.tabGroups).toHaveLength(2)
  })

  it('restores a persisted multi-group split on a cold headless rehydrate', async () => {
    // Regression: hydrate must read back session.tabGroups/tabGroupLayouts, or a server restart coalesces the split into one group.
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'persisted-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Left',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'host-tab-2',
            ptyId: 'persisted-pty-2',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Right',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' }),
        'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty-2' })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-left',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab',
            tabOrder: ['host-tab']
          },
          {
            id: 'group-right',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab-2',
            tabOrder: ['host-tab-2']
          }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(rehydrated.tabGroups).toHaveLength(2)
    expect(rehydrated.tabGroupLayout).toMatchObject({ type: 'split', direction: 'horizontal' })
    // Each persisted group keeps its own tab — no coalescing.
    const left = rehydrated.tabGroups!.find((g) => g.id === 'group-left')!
    const right = rehydrated.tabGroups!.find((g) => g.id === 'group-right')!
    expect(left.tabOrder).toEqual(['host-tab'])
    expect(right.tabOrder).toEqual(['host-tab-2'])
  })

  it('persists a headless terminal rename so it survives a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'rename-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Bind a live pty to the persisted 'host-tab' so rename resolves by handle.
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })

    await expect(runtime.renameTerminal(created.handle, 'My Title')).resolves.toMatchObject({
      title: 'My Title'
    })

    // customTitle must be persisted to the workspace session (not just live pty).
    const persistedTab = getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find(
      (tab) => tab.id === 'host-tab'
    )!
    expect(persistedTab.customTitle).toBe('My Title')

    // A cold rehydrate keeps the renamed title.
    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const renamed = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(renamed?.title).toBe('My Title')
  })

  it('persists a headless pane layout (ratio/expand) so it survives a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
        second: { type: 'leaf', leafId: 'leaf-2' },
        ratio: 0.7
      },
      expandedLeafId: null,
      titlesByLeafId: { [HEADLESS_LEAF_ID]: 'Pane A' }
    })

    const persisted = getSession().terminalLayoutsByTabId['host-tab']!
    expect(persisted.root).toMatchObject({ type: 'split', direction: 'vertical', ratio: 0.7 })
    expect(persisted.titlesByLeafId).toMatchObject({ [HEADLESS_LEAF_ID]: 'Pane A' })
    // Host-owned pty bindings must be preserved through the structural update.
    expect(persisted.ptyIdsByLeafId).toMatchObject({ [HEADLESS_LEAF_ID]: 'persisted-pty' })

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.parentLayout?.root).toMatchObject({
      type: 'split',
      ratio: 0.7
    })
  })

  it('persists headless tab color + pin and surfaces them through a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      color: '#ff8800',
      isPinned: true
    })

    const persisted = getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find(
      (tab) => tab.id === 'host-tab'
    )!
    expect(persisted.color).toBe('#ff8800')
    expect(persisted.isPinned).toBe(true)

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.color).toBe('#ff8800')
    expect(surface?.type === 'terminal' && surface.isPinned).toBe(true)
  })

  it('persists headless browser tab color + pin and surfaces them through a cold rehydrate', async () => {
    const browserTab: Tab = {
      id: 'browser-page-1',
      entityId: 'browser-page-1',
      groupId: 'group-1',
      worktreeId: TEST_WORKTREE_ID,
      contentType: 'browser',
      label: 'Live Browser',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 2,
      isPreview: false,
      isPinned: false
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      unifiedTabs: { [TEST_WORKTREE_ID]: [browserTab] },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'browser-page-1',
            tabOrder: ['browser-page-1']
          }
        ]
      }
    })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'browser-page-1',
            index: 0,
            url: 'https://example.com/',
            title: 'Live Browser',
            active: true
          }
        ]
      }))
    } as never)

    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'browser-page-1',
      color: '#3b82f6',
      isPinned: true
    })

    const persisted = getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.find(
      (tab) => tab.id === 'browser-page-1'
    )
    expect(persisted?.color).toBe('#3b82f6')
    expect(persisted?.isPinned).toBe(true)

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'browser' && tab.id === 'browser-page-1'
    )
    expect(surface?.type === 'browser' && surface.color).toBe('#3b82f6')
    expect(surface?.type === 'browser' && surface.isPinned).toBe(true)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'browser-page-1',
      color: null,
      isPinned: false
    })

    const cleared = getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.find(
      (tab) => tab.id === 'browser-page-1'
    )
    expect(cleared?.color).toBeNull()
    expect(cleared?.isPinned).toBe(false)

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydratedCleared = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const clearedSurface = rehydratedCleared.tabs.find(
      (tab) => tab.type === 'browser' && tab.id === 'browser-page-1'
    )
    expect(clearedSurface?.type === 'browser' && clearedSurface.color).toBeNull()
    expect(clearedSurface?.type === 'browser' && clearedSurface.isPinned).toBe(false)
  })

  it('persists headless tab viewMode and surfaces it through a cold rehydrate', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    const persisted = getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find(
      (tab) => tab.id === 'host-tab'
    )!
    expect(persisted.viewMode).toBe('chat')

    const live = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const liveSurface = live.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(liveSurface?.type === 'terminal' && liveSurface.viewMode).toBe('chat')

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.viewMode).toBe('chat')
  })

  it('still persists tab props in serve mode after syncWindowGraph(0) (gate does not fire)', async () => {
    // Why: serve's syncWindowGraph(0,...) sets authoritativeWindowId=0, but BrowserWindow.fromId(0) is null, so the renderer-authoritative gate must not fire.
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      isPinned: true
    })

    expect(
      getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find((tab) => tab.id === 'host-tab')!.isPinned
    ).toBe(true)
  })

  it('moves a headless tab into an existing group without renderer_unavailable', async () => {
    let ptyCounter = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `move-group-pty-${++ptyCounter}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const second = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const sourceGroupId = before.tabGroups![0]!.id
    const secondHostTabId = second.tabId!

    // Split into 2 groups, then move the tab back into the source group.
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: secondHostTabId,
      targetGroupId: sourceGroupId,
      splitDirection: 'right'
    })
    const split = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(split.tabGroups).toHaveLength(2)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: secondHostTabId,
        targetGroupId: sourceGroupId
      })
    ).resolves.toEqual({ moved: true })

    const merged = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    // Moving the only tab back collapses the split to a single group.
    expect(merged.tabGroups).toHaveLength(1)
    expect(merged.tabGroups![0]!.tabOrder).toContain(secondHostTabId)
  })

  it('creates a new headless terminal in the targeted split group, not the active one', async () => {
    // Regression: a per-group "+" passes targetGroupId, but the headless create ignored it and funneled every new tab into the active group.
    let ptyCounter = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `target-group-pty-${++ptyCounter}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Why: createMobileSessionTerminal asserts the graph is ready; serve marks it ready via syncWindowGraph(0,...) (windowId 0 ≠ a real renderer).
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const second = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { activate: true })
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const leftGroupId = before.tabGroups![0]!.id

    // Split the 2nd tab into a new right group; the new group becomes active.
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: second.tabId!,
      targetGroupId: leftGroupId,
      splitDirection: 'right'
    })
    const split = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(split.tabGroups).toHaveLength(2)
    const rightGroupId = split.tabGroups!.find((g) => g.id !== leftGroupId)!.id

    // Create a terminal targeting the LEFT (now non-active) group.
    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      targetGroupId: leftGroupId,
      activate: true
    })

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const left = after.tabGroups!.find((g) => g.id === leftGroupId)!
    const right = after.tabGroups!.find((g) => g.id === rightGroupId)!
    expect(left.tabOrder).toHaveLength(2) // original + the targeted create
    expect(right.tabOrder).toHaveLength(1) // unchanged
  })

  it('appendBrowserTabOrder keeps a browser in its group across rebuilds (durability)', () => {
    const runtime = new OrcaRuntimeService(store)
    const groups = [
      { id: 'left', activeTabId: 'web-terminal-a', tabOrder: ['web-terminal-a'] },
      { id: 'right', activeTabId: 'web-terminal-b', tabOrder: ['web-terminal-b'] }
    ]

    // First create: a new browser targeted at the RIGHT group lands there.
    const afterCreate = runtime['appendBrowserTabOrder'](groups, ['browser-1'], {
      tabId: 'browser-1',
      groupId: 'right'
    })
    expect(afterCreate.find((g) => g.id === 'right')!.tabOrder).toContain('browser-1')
    expect(afterCreate.find((g) => g.id === 'left')!.tabOrder).not.toContain('browser-1')

    // Rebuild: the terminal distributor drops the browser id, so appendBrowserTabOrder must restore it to its prior group, not group[0].
    const rebuiltGroups = [
      { id: 'left', activeTabId: 'web-terminal-a', tabOrder: ['web-terminal-a'] },
      { id: 'right', activeTabId: 'web-terminal-b', tabOrder: ['web-terminal-b'] }
    ]
    const priorAssignment = runtime['collectBrowserGroupAssignment'](afterCreate, ['browser-1'])
    const afterRebuild = runtime['appendBrowserTabOrder'](
      rebuiltGroups,
      ['browser-1'],
      undefined,
      priorAssignment
    )
    expect(afterRebuild.find((g) => g.id === 'right')!.tabOrder).toContain('browser-1')
    expect(afterRebuild.find((g) => g.id === 'left')!.tabOrder).not.toContain('browser-1')
  })

  it('keeps preserved headless mobile session publication epochs idempotent', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:stable-epoch',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'host-tab::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const firstMerge = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const secondMerge = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(secondMerge.publicationEpoch).toBe(firstMerge.publicationEpoch)
    expect(secondMerge.publicationEpoch.match(/:headless-merge:/g) ?? []).toHaveLength(1)
  })

  it('keeps the graph ready when a mobile snapshot references a removed folder workspace', () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      getFolderWorkspaces: () => []
    } as never)

    expect(() =>
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: 'folder:removed-folder',
            publicationEpoch: 'stale-folder-publication',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
    ).not.toThrow()
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('scans ordinary persisted sessions once instead of once per graph workspace', () => {
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `${TEST_REPO_ID}::/tmp/worktree-${index}`,
        [{ id: `tab-${index}`, ptyId: `${TEST_REPO_ID}::/tmp/worktree-${index}@@pty` }]
      ])
    )
    const session = { tabsByWorktree, terminalLayoutsByTabId: {} }
    const getWorkspaceSession = vi.fn(() => session)
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: Object.keys(tabsByWorktree).map((worktree) => ({
        worktree,
        publicationEpoch: 'large-profile',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }))
    })

    expect(getWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('hydrates runtime-owned candidates from one host-session read', () => {
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `${TEST_REPO_ID}::/tmp/runtime-worktree-${index}`,
        [{ id: `runtime-tab-${index}`, ptyId: `serve-runtime-${index}` }]
      ])
    )
    const session = { tabsByWorktree, terminalLayoutsByTabId: {} }
    const getWorkspaceSession = vi.fn(() => session)
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    expect(getWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(runtime.getStatus().graphStatus).toBe('ready')
  })
})
