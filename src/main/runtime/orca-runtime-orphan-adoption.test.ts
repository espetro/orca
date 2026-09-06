import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  LIST_PROVIDER_DEADLINE,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  resetRuntimeTestMocks,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('adopts preallocated ORCA_TERMINAL_HANDLE as a valid runtime handle', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'ready\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.handle).toBe(handle)
    expect(read.tail).toEqual(['ready'])
  })

  it('recovers exported ORCA_TERMINAL_HANDLE from discovered live PTY sessions', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-1',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_exported'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    expect(listed.terminals[0]?.handle).toBe('term_exported')

    runtime.onPtyData('pty-1', 'after restart\n', 100)
    await expect(runtime.readTerminal('term_exported')).resolves.toMatchObject({
      handle: 'term_exported',
      tail: ['after restart']
    })
    await expect(
      runtime.sendTerminal('term_exported', { text: 'still writable' })
    ).resolves.toMatchObject({
      handle: 'term_exported',
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('adopts a v1.4.150-shaped agent, setup, and shell orphan as one topology transaction', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const writes: [string, string][] = []
    const resize = vi.fn(() => true)
    const processes = [
      ['pty-agent', 'inc-agent', 'term_agent', 'Agent'],
      ['pty-setup', 'inc-setup', 'term_setup', 'Setup'],
      ['pty-shell', 'inc-shell', 'term_shell', 'Shell']
    ] as const
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const listProcesses = vi.fn(async () =>
      processes.map(([id, incarnationId, terminalHandle, title]) => ({
        id,
        incarnationId,
        terminalHandle,
        title,
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }))
    )
    runtime.setPtyController({
      write: (ptyId, data) => {
        writes.push([ptyId, data])
        return true
      },
      resize,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals.map((terminal) => terminal.tabId)).toEqual(
      processes.map(([id]) => `pty:${id}`)
    )
    const targeted = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`, 100, {
      handles: ['term_setup'],
      requireFreshPtyLiveness: true
    })
    expect(targeted).toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_setup', ptyId: 'pty-setup' })],
      totalCount: 1,
      truncated: false
    })
    runtime.onPtyData('pty-agent', 'legacy output\n', 1)

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_agent',
            ptyId: 'pty-agent',
            incarnationId: 'stale-incarnation',
            tabId: 'tab-agent',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      activeTabId: 'tab-agent',
      activeGroupId: 'legacy-group',
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: ['tab-agent', 'tab-setup', 'tab-shell'][index]!,
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      }))
    })

    expect(adopted.adopted).toBe(true)
    expect(adopted.topologyRevision).toBe(1)
    expect(adopted.snapshot.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID,
          title: 'Agent',
          terminal: 'term_agent'
        }),
        expect.objectContaining({
          parentTabId: 'tab-setup',
          leafId: HEADLESS_SECOND_LEAF_ID,
          title: 'Setup',
          terminal: 'term_setup'
        }),
        expect.objectContaining({
          parentTabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID,
          title: 'Shell',
          terminal: 'term_shell'
        })
      ])
    )
    expect(adopted.snapshot.tabGroups).toEqual([
      expect.objectContaining({
        activeTabId: 'tab-agent',
        tabOrder: ['tab-agent', 'tab-setup', 'tab-shell']
      })
    ])
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)

    await runtime.sendTerminal('term_agent', { text: 'input' })
    await runtime.updateRemoteDesktopViewer('pty-agent', 'viewer', 'client', 132, 41)
    expect(writes).toEqual([['pty-agent', 'input']])
    expect(resize).toHaveBeenCalledWith('pty-agent', 132, 41)
    await expect(runtime.readTerminal('term_agent')).resolves.toMatchObject({
      tail: ['legacy output']
    })

    const inventoryCount = listProcesses.mock.calls.length
    const agentPty = (
      runtime as unknown as {
        ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
      }
    ).ptysById.get('pty-agent')!
    agentPty.tabId = null
    agentPty.paneKey = null
    const secondClient = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: ['tab-agent', 'tab-setup', 'tab-shell'][index]!,
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      }))
    })
    expect(secondClient).toMatchObject({ adopted: false, topologyRevision: 1 })
    expect(agentPty).toMatchObject({
      tabId: 'tab-agent',
      paneKey: makePaneKey('tab-agent', HEADLESS_LEAF_ID)
    })
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCount + 1)
    expect(listProcesses).toHaveBeenLastCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(
      (await runtime.listTerminals()).terminals.find((terminal) => terminal.ptyId === 'pty-agent')
    ).toMatchObject({
      handle: 'term_agent',
      orphaned: false,
      tabId: 'tab-agent',
      leafId: HEADLESS_LEAF_ID
    })
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCount + 2)
    expect(listProcesses).toHaveBeenLastCalledWith(undefined, LIST_PROVIDER_DEADLINE)
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_agent',
            ptyId: 'pty-agent',
            incarnationId: 'inc-agent',
            tabId: 'competing-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('preserves concurrent workspace-session changes when async orphan persistence fails', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      flushPendingOrThrowAsync: vi.fn(() => {
        durableWriteStarted.resolve()
        return durableWrite.promise
      })
    } as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          terminalHandle: 'term_async_rollback',
          title: 'Async rollback',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    const adoption = runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      claims: [
        {
          terminal: 'term_async_rollback',
          ptyId: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          tabId: 'tab-async-rollback',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })
    await durableWriteStarted.promise
    setSession({
      ...getSession(),
      activeTabIdByWorktree: {
        ...getSession().activeTabIdByWorktree,
        'concurrent-worktree': 'concurrent-tab'
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(adoption).rejects.toThrow('disk unavailable')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['tab-async-rollback']).toBeUndefined()
    expect(getSession().activeTabIdByWorktree?.['concurrent-worktree']).toBe('concurrent-tab')
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID] ?? 0).toBe(0)
  })
})
