import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  resetRuntimeTestMocks,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('preserves legacy pane and group topology without changing host focus', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'other-worktree',
      activeTabId: 'other-tab',
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const processes = [
      ['pty-left', 'inc-left', 'term_left'],
      ['pty-right', 'inc-right', 'term_right'],
      ['pty-shell', 'inc-shell', 'term_shell']
    ] as const
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        processes.map(([id, incarnationId, terminalHandle]) => ({
          id,
          incarnationId,
          terminalHandle,
          title: id,
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }))
    })

    await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-agent',
      activeGroupId: 'group-left',
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: index < 2 ? 'tab-agent' : 'tab-shell',
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      })),
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.35,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: HEADLESS_SECOND_LEAF_ID
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: null
          }
        ],
        groups: [
          {
            id: 'group-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          { id: 'group-right', activeTabId: 'tab-shell', tabOrder: ['tab-shell'] }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      }
    })

    expect(getSession()).toMatchObject({
      activeWorktreeId: 'other-worktree',
      activeTabId: 'other-tab',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-agent' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          { id: 'group-left', activeTabId: 'tab-agent', tabOrder: ['tab-agent'] },
          { id: 'group-right', activeTabId: 'tab-shell', tabOrder: ['tab-shell'] }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: expect.objectContaining({
          type: 'split',
          direction: 'vertical',
          ratio: 0.6
        })
      },
      terminalLayoutsByTabId: {
        'tab-agent': expect.objectContaining({
          root: expect.objectContaining({
            type: 'split',
            direction: 'horizontal',
            ratio: 0.35
          }),
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: HEADLESS_SECOND_LEAF_ID
        })
      }
    })
  })

  it('never lets an old handle adopt a replacement PTY incarnation', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    let process = {
      id: 'reused-pty-id',
      incarnationId: 'inc-old',
      terminalHandle: 'term_old',
      title: 'old',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    }
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [process]
    })
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_old', incarnationId: 'inc-old' })]
    })

    process = { ...process, incarnationId: 'inc-new', terminalHandle: 'term_new', title: 'new' }
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_old',
            ptyId: process.id,
            incarnationId: 'inc-new',
            tabId: 'stale-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_new', incarnationId: 'inc-new' })]
    })
  })

  it('rejects a proposed visual surface occupied by a different PTY', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'occupied-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'occupied',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'occupied-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'visual-pty'
        }
      ]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'orphan-pty',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'orphan',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_orphan',
            ptyId: 'orphan-pty',
            incarnationId: 'inc-orphan',
            tabId: 'occupied-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_surface_occupied')
  })

  it('rejects ambiguous duplicate persisted bindings before idempotence', async () => {
    const duplicateTab = (id: string) => ({
      id,
      ptyId: 'duplicate-pty',
      worktreeId: TEST_WORKTREE_ID,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [duplicateTab('duplicate-a'), duplicateTab('duplicate-b')]
      },
      terminalLayoutsByTabId: {
        'duplicate-a': {
          root: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
          activeLeafId: HEADLESS_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: 'duplicate-pty' }
        },
        'duplicate-b': {
          root: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID },
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_SECOND_LEAF_ID]: 'duplicate-pty' }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`duplicate-a:${HEADLESS_LEAF_ID}`]: 'inc-duplicate',
        [`duplicate-b:${HEADLESS_SECOND_LEAF_ID}`]: 'inc-duplicate'
      }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'duplicate-pty',
          incarnationId: 'inc-duplicate',
          terminalHandle: 'term_duplicate',
          title: 'duplicate',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_duplicate',
            ptyId: 'duplicate-pty',
            incarnationId: 'inc-duplicate',
            tabId: 'duplicate-a',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('does not adopt a discovered terminal handle already bound to another live PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writesByPty = new Map<string, string[]>()
    runtime.setPtyController({
      write: (ptyId, data) => {
        writesByPty.set(ptyId, [...(writesByPty.get(ptyId) ?? []), data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-victim',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        },
        {
          id: 'pty-imposter',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    const handles = listed.terminals.map((terminal) => terminal.handle)
    expect(handles).toContain('term_victim')
    expect(new Set(handles).size).toBe(handles.length)

    await expect(
      runtime.sendTerminal('term_victim', { text: 'for victim' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writesByPty.get('pty-victim')).toEqual(['for victim'])
    expect(writesByPty.has('pty-imposter')).toBe(false)
  })

  it('keeps an already-bound terminal handle when discovery reports a different exported one', async () => {
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
          terminalHandle: 'term_from_env'
        }
      ]
    })
    runtime.registerPreAllocatedHandleForPty('pty-1', 'term_already_bound')

    const listed = await runtime.listTerminals()
    expect(listed.terminals[0]?.handle).toBe('term_already_bound')
    await expect(
      runtime.sendTerminal('term_already_bound', { text: 'still routed' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writes).toEqual(['still routed'])
    // the reported-but-not-adopted handle must not resolve to the live pty
    await expect(runtime.readTerminal('term_from_env')).rejects.toThrow()
  })
})
