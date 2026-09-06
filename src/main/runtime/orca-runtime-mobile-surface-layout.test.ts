import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_WORKTREE_ID, resetRuntimeTestMocks, store } from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('keeps mobile terminal surfaces visible while their leaf handle is pending', async () => {
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
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('keeps mobile terminal surfaces pending while a live leaf has no PTY', async () => {
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
          ptyId: null,
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

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('selects a visible active pane when terminal visual layout prunes a stale leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const parentLayout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'pane:1' },
        second: { type: 'leaf', leafId: 'pane:2' }
      },
      activeLeafId: 'pane:1',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:2': 'pty-2' }
    }
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Split terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'Live pane'
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
          tabGroups: [
            {
              id: 'group-1',
              activeTabId: 'missing-tab',
              tabOrder: ['missing-tab', 'tab-1']
            }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Stale pane',
              parentLayout,
              isActive: true
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'Live pane',
              parentLayout,
              isActive: false
            }
          ]
        }
      ]
    })

    const result = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(result.visualLayouts).toMatchObject([
      {
        worktreeId: TEST_WORKTREE_ID,
        root: {
          type: 'group',
          activeTabId: 'tab-1',
          tabs: [
            {
              tabId: 'tab-1',
              activeLeafId: 'pane:2',
              panes: {
                type: 'terminal',
                leafId: 'pane:2',
                active: true
              }
            }
          ]
        }
      }
    ])
  })
})
