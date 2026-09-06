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
  deferred,
  electronMocks,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('keeps saved PTY bindings pending until the runtime knows the PTY is connected', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
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
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              parentLayout: {
                root: { type: 'leaf', leafId: 'pane:1' },
                activeLeafId: 'pane:1',
                expandedLeafId: null,
                ptyIdsByLeafId: { 'pane:1': 'daemon-pty-1' }
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        ptyId: 'daemon-pty-1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('refreshes daemon PTY liveness before publishing mobile session tabs', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'daemon-pty-1', cwd: TEST_WORKTREE_PATH, title: 'daemon shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
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
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              parentLayout: {
                root: { type: 'leaf', leafId: 'pane:1' },
                activeLeafId: 'pane:1',
                expandedLeafId: null,
                ptyIdsByLeafId: { 'pane:1': 'daemon-pty-1' }
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        ptyId: 'daemon-pty-1',
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
    ])
  })

  it('does not invalidate a newly spawned SSH pane from an overlapping stale process list', async () => {
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'ssh:ssh-1@@pty-new'
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [],
      hasPty: (candidate) => candidate === ptyId
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'tab-1',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'ssh-spawn-list-race',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${HEADLESS_LEAF_ID}`,
              parentTabId: 'tab-1',
              leafId: HEADLESS_LEAF_ID,
              title: 'SSH terminal',
              ptyId,
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({ ptyId, status: 'ready', terminal: expect.any(String) })
    ])
  })

  it('reattaches mobile terminal surfaces from saved PTY bindings when the PTY is connected', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'daemon-pty-1'
        }
      ]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
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
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
    ])
    expect(runtime.resolveLeafForHandle((result.tabs[0] as { terminal: string }).terminal)).toEqual(
      { ptyId: 'daemon-pty-1' }
    )
  })

  it('retires exited saved PTY bindings instead of publishing a pending ghost', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
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
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              isActive: true
            }
          ]
        }
      ]
    })
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.onPtyExit('daemon-pty-1', 0)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result).toMatchObject({
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
  })

  it('resolves mobile terminal surfaces by exact split leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:2',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'right'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:2',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toHaveLength(2)
    expect(result.tabs).toEqual([
      expect.objectContaining({ id: 'tab-1::pane:1', title: 'left', status: 'ready' }),
      expect.objectContaining({ id: 'tab-1::pane:2', title: 'right', status: 'ready' })
    ])
    const [left, right] = result.tabs
    expect(left?.type).toBe('terminal')
    expect(right?.type).toBe('terminal')
    if (left?.type === 'terminal' && right?.type === 'terminal') {
      expect(left.terminal).not.toBe(right.terminal)
    }
  })

  it('keeps published mobile terminal handles usable across renderer graph epochs', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
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
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type).toBe('terminal')
    if (tab?.type !== 'terminal' || tab.status !== 'ready') {
      throw new Error('expected ready terminal tab')
    }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-2',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('pty-1', 'after graph sync\n', 100)

    await expect(runtime.readTerminal(tab.terminal)).resolves.toMatchObject({
      handle: tab.terminal,
      tail: ['after graph sync']
    })
  })

  it('closes the matching mobile terminal UUID leaf without closing the whole tab', async () => {
    const closeTerminal = vi.fn()
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const leftLeafId = '11111111-1111-4111-8111-111111111111'
    const rightLeafId = '22222222-2222-4222-8222-222222222222'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: rightLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: leftLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-left',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: rightLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-right',
          paneTitle: 'right'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${rightLeafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${rightLeafId}`,
              parentTabId: 'tab-1',
              leafId: rightLeafId,
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, `tab-1::${rightLeafId}`)

    expect(kill).toHaveBeenCalledWith('pty-right')
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('closes the whole mobile terminal tab when addressed by parent tab id', async () => {
    const closeTerminal = vi.fn()
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
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
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-1')

    expect(closeTerminal).toHaveBeenCalledWith('tab-1')
    expect(kill).not.toHaveBeenCalled()
  })

  it('activates the active split leaf when addressed by parent tab id', async () => {
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
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
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:2',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'left',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-1')

    expect(focusTerminal).toHaveBeenCalledWith('tab-1', TEST_WORKTREE_ID, 'pane:2')
  })

  it('activates mobile session tabs without focusing desktop clients when requested', async () => {
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
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
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:2',
          activeTabType: 'terminal',
          tabGroups: [{ id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] }],
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              ptyId: 'pty-pane-1',
              title: 'left',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              ptyId: 'pty-pane-2',
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.registerPty('pty-pane-1', TEST_WORKTREE_ID)
    runtime.registerPty('pty-pane-2', TEST_WORKTREE_ID)

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'tab-1::pane:1',
      undefined,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated).toMatchObject({
      activeTabId: 'tab-1::pane:1',
      activeTabType: 'terminal',
      tabGroups: [expect.objectContaining({ id: 'group-1', activeTabId: 'tab-1' })]
    })
    expect(activated.tabs).toEqual([
      expect.objectContaining({ id: 'tab-1::pane:1', isActive: true }),
      expect.objectContaining({ id: 'tab-1::pane:2', isActive: false })
    ])
  })

  it('clears unread metadata on mobile worktree activation without focusing desktop clients', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: true })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    })
    const activateWorktree = vi.fn()
    const worktreesChanged = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)
    runtime.setNotifier({
      worktreesChanged,
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { isUnread: false })
    expect(metaById[TEST_WORKTREE_ID]?.isUnread).toBe(false)
    expect(worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    expect(activateWorktree).not.toHaveBeenCalled()
  })

  it('wakes slept agents on the host renderer when a phone activates a worktree', async () => {
    // Seed isUnread:false so the unread-clear branch stays quiet, isolating the mobile slept-agent wake.
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const activateWorktree = vi.fn()
    const resumeSleepingAgents = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => ({
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: {
          'tab-1:leaf-1': {
            paneKey: 'tab-1:leaf-1',
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' },
            prompt: 'test',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'worktree-sleep'
          }
        }
      })
    } as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
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
    // A renderer must be attached to receive the wake; headless serve reports 'unsupported-headless' instead.
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    // INV-2: mobile wake never navigates the desktop (no activateWorktree); it routes through the renderer's navigation-free wake.
    expect(resumeSleepingAgents).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(result.sleepingAgentWake).toBe('requested')
  })

  it('reports the wake as unsupported when a phone activates a worktree on headless serve', async () => {
    // Why: without a renderer nothing holds the sleeping records so nothing wakes; the result must say so or the phone shows slept agents as resumed (#7906).
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const resumeSleepingAgents = vi.fn()
    const getWorkspaceSession = vi.fn(() => ({
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'test',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'worktree-sleep'
        }
      }
    }))
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession
    } as never)
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
    // Headless: graph ready but no BrowserWindow backs the authoritative id, so getAvailableAuthoritativeWindow() is null.
    electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    expect(result.activated).toBe(true)
    expect(result.sleepingAgentWake).toBe('unsupported-headless')
    // Why: sleeping records are host-partitioned; the check must read the repo's execution host partition, not always the local one.
    expect(getWorkspaceSession).toHaveBeenCalledWith('local')
    expect(resumeSleepingAgents).not.toHaveBeenCalled()
  })

  it('does not report headless wake degradation without sleeping records', async () => {
    const runtime = new OrcaRuntimeService(store as never)
    electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    expect(result.sleepingAgentWake).toBe('not-applicable')
  })

  it('does not wake slept agents for non-mobile session-only activation', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const resumeSleepingAgents = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    } as never)
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
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    // INV-3: web/desktop runtime clients keep their existing wake-on-activation paths; the renderer notifier wake is mobile-scoped.
    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'runtime'
    })

    expect(resumeSleepingAgents).not.toHaveBeenCalled()
    expect(result.sleepingAgentWake).toBe('not-applicable')
  })

  it('does not rewrite unread metadata when a mobile activation finds the worktree already read', async () => {
    // Why: seed instanceId so worktree resolution doesn't emit its own metadata-stamp write, isolating the assertion to the unread clear.
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false, instanceId: 'wt-instance' })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    })
    const worktreesChanged = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)
    runtime.setNotifier({
      worktreesChanged,
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(worktreesChanged).not.toHaveBeenCalled()

    metaById[TEST_WORKTREE_ID] = makeWorktreeMeta({ isUnread: true, instanceId: 'wt-instance' })
    setWorktreeMeta.mockClear()
    worktreesChanged.mockClear()

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })
    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    expect(setWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { isUnread: false })
    expect(worktreesChanged).toHaveBeenCalledTimes(1)
    expect(worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
  })

  it('returns unread:false from worktree.ps after a mobile activation clears the flag', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: true })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)
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
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const beforeActivation = await runtime.getWorktreePs()
    expect(
      beforeActivation.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
        ?.unread
    ).toBe(true)

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    const afterActivation = await runtime.getWorktreePs()
    expect(
      afterActivation.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)?.unread
    ).toBe(false)
  })

  it('materializes pending mobile session terminals without focusing desktop clients', async () => {
    const persistedPtyId = `${TEST_WORKTREE_ID}@@mobile-only-pty`
    const spawn = vi.fn().mockResolvedValue({ id: persistedPtyId })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: persistedPtyId,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('isNewSession')
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        isActive: true,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('materializes phone-local pending terminal tabs without stored PTY bindings', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'fresh-mobile-pty' })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: expect.stringMatching(/^serve-/),
        isNewSession: true,
        persistHostSessionBinding: true
      })
    )
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('keeps the target group active when phone-local activation materializes a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'group-target-pty' })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'host-tab' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Left',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'host-tab-2',
              ptyId: null,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined }),
          'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: undefined })
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
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab-2',
      HEADLESS_SECOND_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated.activeGroupId).toBe('group-right')
    expect(activated.tabGroups).toEqual([
      expect.objectContaining({ id: 'group-left', activeTabId: 'host-tab' }),
      expect.objectContaining({ id: 'group-right', activeTabId: 'host-tab-2' })
    ])
    expect(activated.activeTabId).toBe(`host-tab-2::${HEADLESS_SECOND_LEAF_ID}`)
  })

  it('refreshes stale daemon liveness before phone-local terminal materialization', async () => {
    const stalePtyId = `${TEST_WORKTREE_ID}@@stale-mobile-pty`
    const spawn = vi.fn().mockResolvedValue({ id: stalePtyId })
    const listProcesses = vi.fn(async () => [])
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: stalePtyId,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: stalePtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.registerPty(stalePtyId, TEST_WORKTREE_ID)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(listProcesses).toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: stalePtyId,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
    )
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('closes browser mobile session tabs when addressed by browser workspace id', async () => {
    const closeSessionTab = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
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
      closeSessionTab,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'browser-unified-1',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://example.com/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')

    expect(closeSessionTab).toHaveBeenCalledWith('browser-unified-1', TEST_WORKTREE_ID)
    expect(forgetTabs).toHaveBeenCalledWith(TEST_WORKTREE_ID, ['browser-unified-1'])
  })

  it('keeps client selection when a renderer session-tab close cannot commit', async () => {
    const closeSessionTab = vi.fn().mockRejectedValue(new Error('session_tab_close_canceled'))
    const runtime = new OrcaRuntimeService(store)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
    runtime.setNotifier({ closeSessionTab } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'browser-unified-1',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://example.com/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            }
          ]
        }
      ]
    })

    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
    ).rejects.toThrow('session_tab_close_canceled')

    expect(forgetTabs).not.toHaveBeenCalled()

    runtime.setNotifier(null)
    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')
    ).rejects.toThrow('runtime_unavailable')
    expect(forgetTabs).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'retires client-hosted session tabs through their selected engine when offscreen=%s',
    async (withOffscreen) => {
      const runtime = new OrcaRuntimeService(store)
      const pages = getRuntimeBrowserPageRegistry(runtime)
      const placement = {
        kind: 'client' as const,
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      }
      pages.publishClientPage({
        browserPageId: 'client-page-1',
        workspaceId: TEST_WORKTREE_ID,
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:1',
        placement,
        url: 'https://remote.internal/',
        loading: false,
        active: true
      })
      const closeOffscreenTab = vi.fn()
      if (withOffscreen) {
        runtime.setOffscreenBrowserBackend({
          createTab: vi.fn(),
          closeTab: closeOffscreenTab
        })
      }
      runtime.syncWindowGraph(0, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'headless:test',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'client-page-1',
            activeTabType: 'browser',
            tabs: [
              {
                type: 'browser',
                id: 'client-page-1',
                title: 'Client page',
                browserWorkspaceId: 'client-page-1',
                browserPageId: 'client-page-1',
                browserProfileId: 'default',
                executionHostKey: 'native:runtime-a:1',
                placement,
                url: 'https://remote.internal/',
                loading: false,
                canGoBack: false,
                canGoForward: false,
                isActive: true
              }
            ]
          }
        ]
      })
      const closeClientPage = vi
        .spyOn(runtime, 'browserTabClose')
        .mockImplementation(async ({ page }) => {
          expect(pages.retirePage(page!, placement)).toBe(true)
          return { closed: true }
        })

      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ browserPageId: 'client-page-1', placement })
      ])
      await expect(
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'client-page-1')
      ).resolves.toEqual({ closed: true })

      expect(closeClientPage).toHaveBeenCalledWith({
        worktree: `id:${TEST_WORKTREE_ID}`,
        page: 'client-page-1'
      })
      expect(closeOffscreenTab).not.toHaveBeenCalled()
      expect(pages.getPage('client-page-1')).toBeUndefined()
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    }
  )

  it('closes an offscreen browser without overwriting a concurrent session update', async () => {
    const closeProof = deferred<void>()
    const closeOffscreenTab = vi.fn(() => closeProof.promise)
    const closeSessionTab = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOffscreenBrowserBackend({
      createTab: vi.fn(),
      closeTab: closeOffscreenTab
    })
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
      closeSessionTab,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const browserTab = {
      type: 'browser' as const,
      id: 'offscreen-page-1',
      title: 'Offscreen page',
      browserWorkspaceId: 'offscreen-page-1',
      browserPageId: 'offscreen-page-1',
      url: 'https://remote.internal/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true
    }
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:test',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: browserTab.id,
          activeTabType: 'browser',
          tabs: [browserTab]
        }
      ]
    })

    const closing = runtime.closeMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      browserTab.browserPageId
    )
    await vi.waitFor(() => expect(closeOffscreenTab).toHaveBeenCalledWith(browserTab.browserPageId))

    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:test',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: browserTab.id,
          activeTabType: 'browser',
          tabs: [
            browserTab,
            {
              type: 'markdown',
              id: 'notes',
              title: 'Notes',
              filePath: '/worktree/notes.md',
              relativePath: 'notes.md',
              language: 'markdown',
              mode: 'edit',
              isDirty: false,
              sourceFileId: 'notes.md',
              sourceFilePath: '/worktree/notes.md',
              sourceRelativePath: 'notes.md',
              documentVersion: '1',
              isActive: false
            }
          ]
        }
      ]
    })
    closeProof.resolve()
    await expect(closing).resolves.toEqual({ closed: true })

    expect(closeSessionTab).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'notes', type: 'markdown' })
    ])
  })
})
