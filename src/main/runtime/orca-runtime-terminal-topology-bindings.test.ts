import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  resetRuntimeTestMocks,
  store,
  withPlatform
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('restores orphan pane and group topology without replacing a newer host-owned tab', async () => {
    const session: WorkspaceSessionState = {
      ...makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'terminal-3' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'terminal-3',
              ptyId: 'pty-new',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 3',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 3
            }
          ]
        },
        terminalLayoutsByTabId: {
          'terminal-3': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'pty-new' })
        }
      }),
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-live',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'terminal-3',
            tabOrder: ['terminal-3']
          }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: { type: 'leaf', groupId: 'group-live' }
      },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-live' },
      terminalPtyIncarnationsByPaneKey: {
        [`terminal-3:${HEADLESS_LEAF_ID}`]: 'inc-new'
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-new',
          incarnationId: 'inc-new',
          terminalHandle: 'term_new',
          title: 'Terminal 3',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-agent',
          incarnationId: 'inc-agent',
          terminalHandle: 'term_agent',
          title: 'Claude',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-setup',
          incarnationId: 'inc-setup',
          terminalHandle: 'term_setup',
          title: 'Setup',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-shell',
          incarnationId: 'inc-shell',
          terminalHandle: 'term_shell',
          title: 'Shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-shell',
      activeGroupId: 'group-old-right',
      claims: [
        {
          terminal: 'term_agent',
          ptyId: 'pty-agent',
          incarnationId: 'inc-agent',
          tabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID
        },
        {
          terminal: 'term_setup',
          ptyId: 'pty-setup',
          incarnationId: 'inc-setup',
          tabId: 'tab-agent',
          leafId: HEADLESS_SECOND_LEAF_ID
        },
        {
          terminal: 'term_shell',
          ptyId: 'pty-shell',
          incarnationId: 'inc-shell',
          tabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID
        }
      ],
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.7,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: null
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: HEADLESS_THIRD_LEAF_ID
          }
        ],
        groups: [
          {
            id: 'group-old-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          {
            id: 'group-old-right',
            activeTabId: 'tab-shell',
            tabOrder: ['tab-shell']
          }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-old-left' },
          second: { type: 'leaf', groupId: 'group-old-right' }
        }
      }
    })

    expect(adopted.snapshot.activeGroupId).toBe('group-old-right')
    expect(adopted.snapshot.activeTabId).toBe(`tab-shell::${HEADLESS_THIRD_LEAF_ID}`)
    expect(adopted.snapshot.tabGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'group-live', tabOrder: ['terminal-3'] }),
        expect.objectContaining({ id: 'group-old-left', tabOrder: ['tab-agent'] }),
        expect.objectContaining({ id: 'group-old-right', tabOrder: ['tab-shell'] })
      ])
    )
    expect(adopted.snapshot.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: 'group-live' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.6,
        first: { type: 'leaf', groupId: 'group-old-left' },
        second: { type: 'leaf', groupId: 'group-old-right' }
      }
    })
    expect(getSession().terminalLayoutsByTabId['tab-agent']).toMatchObject({
      root: { type: 'split', direction: 'horizontal', ratio: 0.7 },
      activeLeafId: HEADLESS_SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [HEADLESS_LEAF_ID]: 'pty-agent',
        [HEADLESS_SECOND_LEAF_ID]: 'pty-setup'
      }
    })
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'terminal-3',
      'tab-agent',
      'tab-shell'
    ])
  })

  it('canonicalizes an equivalent persisted worktree key without duplicating terminal topology', async () => {
    const aliasWorktreeId = `${TEST_REPO_ID}::/tmp//worktree-a/`
    const base = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: {
        [`host-tab:${HEADLESS_LEAF_ID}`]: 'inc-alias'
      }
    })
    const session: WorkspaceSessionState = {
      ...base,
      activeTabIdByWorktree: { [aliasWorktreeId]: 'host-tab' },
      tabsByWorktree: {
        [aliasWorktreeId]: base.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          worktreeId: aliasWorktreeId
        }))
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'persisted-pty',
          incarnationId: 'inc-alias',
          terminalHandle: 'term_alias',
          title: 'Alias shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: [
        {
          terminal: 'term_alias',
          ptyId: 'persisted-pty',
          incarnationId: 'inc-alias',
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })

    expect(adopted).toMatchObject({ adopted: true, topologyRevision: 1 })
    expect(adopted.snapshot.worktree).toBe(TEST_WORKTREE_ID)
    expect(Object.keys(getSession().tabsByWorktree)).toContain(TEST_WORKTREE_ID)
    expect(Object.keys(getSession().tabsByWorktree)).not.toContain(aliasWorktreeId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.worktreeId).toBe(TEST_WORKTREE_ID)
    expect(getSession().activeTabIdByWorktree).toEqual({ [TEST_WORKTREE_ID]: 'host-tab' })
  })

  it('keeps current-generation tab and leaf identity across a host restart', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: {
        [`host-tab:${HEADLESS_LEAF_ID}`]: 'inc-current'
      },
      terminalTopologyRevisionByRepoId: { [TEST_REPO_ID]: 4 }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    let connected = true
    const writes: [string, string][] = []
    const resize = vi.fn(() => true)
    const makeRuntime = (): OrcaRuntimeService => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: (ptyId, data) => {
          writes.push([ptyId, data])
          return true
        },
        resize,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () =>
          connected
            ? [
                {
                  id: 'persisted-pty',
                  incarnationId: 'inc-current',
                  terminalHandle: 'term_current',
                  title: 'Current shell',
                  cwd: TEST_WORKTREE_PATH,
                  worktreeId: TEST_WORKTREE_ID,
                  wslDistro: null
                }
              ]
            : []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      return runtime
    }

    const originalRuntime = makeRuntime()
    const beforeRestart = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    connected = false
    const disconnected = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    connected = true
    const reconnected = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const restarted = makeRuntime()
    const afterRestart = await restarted.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const listed = await restarted.listTerminals(`id:${TEST_WORKTREE_ID}`)
    restarted.onPtyData('persisted-pty', 'after restart\n', 1)
    await restarted.sendTerminal('term_current', { text: 'input' })
    await restarted.updateRemoteDesktopViewer('persisted-pty', 'viewer', 'client', 132, 41)

    expect(beforeRestart.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current',
      title: 'Persisted Terminal'
    })
    expect(afterRestart.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current'
    })
    expect(disconnected.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(reconnected.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current'
    })
    expect(listed.terminals[0]).toMatchObject({
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-current',
      orphaned: false
    })
    expect(listed.topologyRevisions?.[TEST_WORKTREE_ID]).toBe(4)
    await expect(restarted.readTerminal('term_current')).resolves.toMatchObject({
      tail: ['after restart']
    })
    expect(writes).toEqual([['persisted-pty', 'input']])
    expect(resize).toHaveBeenCalledWith('persisted-pty', 132, 41)
  })

  it('uses topology CAS before a client can claim a still-orphaned PTY', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      terminalTopologyRevisionByRepoId: { [TEST_REPO_ID]: 7 }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-cas',
          incarnationId: 'inc-cas',
          terminalHandle: 'term_cas',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 6,
        claims: [
          {
            terminal: 'term_cas',
            ptyId: 'pty-cas',
            incarnationId: 'inc-cas',
            tabId: 'tab-cas',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_topology_conflict')
  })

  it('keeps orphaned list and show writability aligned with the send gate', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const writes: [string, string][] = []
    runtime.setPtyController({
      write: (ptyId: string, data: string) => {
        writes.push([ptyId, data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-orphan',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    } as never)
    runtime.registerPty('pty-orphan', TEST_WORKTREE_ID)
    runtime.onPtySpawned('pty-orphan', 'inc-orphan', { awaitsRegistration: false })

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const entry = listed.terminals.find((terminal) => terminal.ptyId === 'pty-orphan')
    expect(entry).toMatchObject({ orphaned: true, connected: true, writable: true })

    const shown = await runtime.showTerminal(entry!.handle)
    expect(shown.writable).toBe(true)
    await expect(runtime.sendTerminal(entry!.handle, { text: 'hi' })).resolves.toMatchObject({
      accepted: true
    })
    expect(writes).toEqual([['pty-orphan', 'hi']])
  })

  it('rejects connection mismatch and reused handles while allowing a WSL-owned orphan', async () => {
    const makeRuntime = (): OrcaRuntimeService => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
      })
      return new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    }
    const ownerMismatch = makeRuntime()
    ownerMismatch.registerPty('pty-wrong-owner', TEST_WORKTREE_ID, 'ssh-other-host')
    ownerMismatch.onPtySpawned('pty-wrong-owner', 'inc-owner', { awaitsRegistration: false })
    ownerMismatch.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-wrong-owner',
          incarnationId: 'inc-owner',
          terminalHandle: 'term_wrong_owner',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    await expect(
      ownerMismatch.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_wrong_owner',
            ptyId: 'pty-wrong-owner',
            incarnationId: 'inc-owner',
            tabId: 'tab-owner',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_owner_mismatch')

    const reusedHandle = makeRuntime()
    for (const [ptyId, incarnationId] of [
      ['pty-first', 'inc-first'],
      ['pty-second', 'inc-second']
    ] as const) {
      reusedHandle.registerPty(ptyId, TEST_WORKTREE_ID)
      reusedHandle.onPtySpawned(ptyId, incarnationId, { awaitsRegistration: false })
    }
    reusedHandle.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-first',
          incarnationId: 'inc-first',
          terminalHandle: 'term_reused',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-second',
          incarnationId: 'inc-second',
          terminalHandle: 'term_reused',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    await expect(
      reusedHandle.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_reused',
            ptyId: 'pty-second',
            incarnationId: 'inc-second',
            tabId: 'tab-second',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')

    await withPlatform('win32', async () => {
      const makeWslRuntime = (reportedWslDistro?: string | null): OrcaRuntimeService => {
        const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
        })
        const wsl = new OrcaRuntimeService({
          ...runtimeStore,
          flushOrThrow: vi.fn(),
          getProjects: () => [
            {
              id: 'project-wsl',
              displayName: 'WSL',
              badgeColor: 'blue',
              sourceRepoIds: [TEST_REPO_ID],
              localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
              createdAt: 1,
              updatedAt: 1
            }
          ],
          getSettings: () => ({
            ...store.getSettings(),
            localWindowsRuntimeDefault: { kind: 'windows-host' }
          })
        } as never)
        wsl.registerPty('pty-wsl', TEST_WORKTREE_ID, null, undefined, true)
        wsl.onPtySpawned('pty-wsl', 'inc-wsl', { awaitsRegistration: false })
        wsl.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          listProcesses: async () => [
            {
              id: 'pty-wsl',
              incarnationId: 'inc-wsl',
              terminalHandle: 'term_wsl',
              title: 'shell',
              cwd: TEST_WORKTREE_PATH,
              worktreeId: TEST_WORKTREE_ID,
              ...(reportedWslDistro !== undefined ? { wslDistro: reportedWslDistro } : {})
            }
          ]
        })
        return wsl
      }
      const request = {
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_wsl',
            ptyId: 'pty-wsl',
            incarnationId: 'inc-wsl',
            tabId: 'tab-wsl',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      }

      await expect(makeWslRuntime('Ubuntu').adoptTerminalOrphans(request)).resolves.toMatchObject({
        adopted: true,
        topologyRevision: 1
      })
      await expect(makeWslRuntime('Debian').adoptTerminalOrphans(request)).rejects.toThrow(
        'terminal_orphan_owner_mismatch'
      )
      await expect(makeWslRuntime().adoptTerminalOrphans(request)).rejects.toThrow(
        'terminal_orphan_owner_mismatch'
      )
    })
  })
})
