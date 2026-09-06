import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  MOCK_GIT_WORKTREES,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  createFolderWorkspaceRuntimeStore,
  createRuntime,
  deferred,
  electronMocks,
  expectStablePaneKeyEnv,
  makeDeferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store,
  syncSinglePty,
  waitForMobileSessionTabsEvents
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { listWorktrees } from '../git/worktree'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { ipcMain } from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('omits stale browser session tabs that no longer have live webContents', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'browser-page-live',
          index: 0,
          url: 'https://live.example/',
          title: 'Live Browser',
          active: true
        }
      ]
    }))
    runtime.setAgentBrowserBridge({ tabList } as never)
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
          activeTabId: 'browser-unified-stale',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-stale',
              title: 'Dead Browser',
              browserWorkspaceId: 'browser-workspace-stale',
              browserPageId: 'browser-page-stale',
              url: 'about:blank',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            },
            {
              type: 'browser',
              id: 'browser-unified-live',
              title: 'Stale Title',
              browserWorkspaceId: 'browser-workspace-live',
              browserPageId: 'browser-page-live',
              url: 'https://stale.example/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: false
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(tabList).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-live',
        browserPageId: 'browser-page-live',
        url: 'https://live.example/',
        title: 'Live Browser',
        isActive: true
      })
    ])
    expect(result.activeTabId).toBe('browser-unified-live')
    expect(result.activeTabType).toBe('browser')
  })

  it('does not let the active browser webContents steal session focus from terminals', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
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
    runtime.setAgentBrowserBridge({ tabList } as never)
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
          activeTabId: 'terminal-tab::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Stale Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://stale.example/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: false
            },
            {
              type: 'terminal',
              id: 'terminal-tab::pane:1',
              parentTabId: 'terminal-tab',
              leafId: 'pane:1',
              title: 'Terminal 2',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.activeTabId).toBe('terminal-tab::pane:1')
    expect(result.activeTabType).toBe('terminal')
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-1',
        isActive: false,
        title: 'Live Browser'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: 'terminal-tab::pane:1',
        isActive: true
      })
    ])
  })

  it('publishes terminal surface agent status for paired web clients', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
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
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'codex [working]',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'codex',
                paneKey: hostPaneKey,
                terminalTitle: 'codex [working]',
                stateHistory: []
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
        id: `tab-1::${leafId}`,
        status: 'pending-handle',
        terminal: null,
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix parity',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    ])
  })

  it.each([
    {
      behavior: 'fills a missing renderer session',
      hookAgentType: 'codex',
      hookOffset: 0,
      rendererSessionId: null,
      expectedSessionId: 'hook-session'
    },
    {
      behavior: 'replaces a stale renderer session at the same event timestamp',
      hookAgentType: 'codex',
      hookOffset: 0,
      rendererSessionId: 'stale-renderer-session',
      expectedSessionId: 'hook-session'
    },
    {
      behavior: 'preserves a renderer session newer than the hook row',
      hookAgentType: 'codex',
      hookOffset: -1,
      rendererSessionId: 'newer-renderer-session',
      expectedSessionId: 'newer-renderer-session'
    },
    {
      behavior: 'rejects a hook session owned by another agent',
      hookAgentType: 'claude',
      hookOffset: 1,
      rendererSessionId: null,
      expectedSessionId: null
    }
  ] as const)(
    '$behavior',
    async ({ hookAgentType, hookOffset, rendererSessionId, expectedSessionId }) => {
      const leafId = '11111111-1111-4111-8111-111111111111'
      const paneKey = `codex-tab:${leafId}`
      const providerSession = {
        key: 'session_id' as const,
        id: 'hook-session'
      }
      const now = Date.now()
      const runtime = new OrcaRuntimeService(store, undefined, {
        getAgentStatusSnapshot: () => [
          {
            paneKey,
            state: 'done',
            prompt: '',
            agentType: hookAgentType,
            connectionId: null,
            receivedAt: now + hookOffset,
            stateStartedAt: now + hookOffset,
            tabId: 'codex-tab',
            worktreeId: TEST_WORKTREE_ID,
            providerSession
          }
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
            activeGroupId: null,
            activeTabId: `codex-tab::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `codex-tab::${leafId}`,
                parentTabId: 'codex-tab',
                leafId,
                title: 'Codex',
                launchAgent: 'codex',
                agentStatus: {
                  state: 'working',
                  prompt: 'Reply with MOBILE QA OK and nothing else.',
                  updatedAt: now,
                  stateStartedAt: now,
                  agentType: 'codex',
                  paneKey,
                  stateHistory: [],
                  ...(rendererSessionId
                    ? {
                        providerSession: {
                          key: 'session_id' as const,
                          id: rendererSessionId
                        }
                      }
                    : {})
                },
                isActive: true
              }
            ]
          }
        ]
      })

      const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      expect(result.tabs[0]).toEqual(
        expect.objectContaining({
          type: 'terminal',
          agentStatus: expect.objectContaining({
            state: 'working',
            prompt: 'Reply with MOBILE QA OK and nothing else.',
            agentType: 'codex'
          })
        })
      )
      if (expectedSessionId) {
        expect(result.tabs[0]).toHaveProperty('agentStatus.providerSession', {
          key: 'session_id',
          id: expectedSessionId
        })
      } else {
        expect(result.tabs[0]).not.toHaveProperty('agentStatus.providerSession')
      }
    }
  )

  it('preserves authoritative OMP identity for Pi-compatible remote terminal snapshots', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
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
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: '\u280b Pi',
              launchAgent: 'omp',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'pi',
                paneKey: hostPaneKey,
                terminalTitle: '\u280b Pi',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '\u280b OMP',
        launchAgent: 'omp',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'omp',
          paneKey: hostPaneKey,
          terminalTitle: '\u280b OMP'
        })
      })
    )
  })

  it('normalizes a remote OMP title without republishing omitted launch identity', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-omp' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'omp',
      launchAgent: 'omp',
      title: 'OMP',
      activate: true
    })
    const spawnCall = spawn.mock.calls[0]?.[0]
    expect(spawnCall).toEqual(
      expect.objectContaining({
        tabId: expect.any(String),
        leafId: expect.any(String)
      })
    )
    const { tabId, leafId } = spawnCall as { tabId: string; leafId: string }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: '\u280b π - tmp',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-omp',
          paneTitle: '\u280b π - tmp'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `${tabId}::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${tabId}::${leafId}`,
              parentTabId: tabId,
              leafId,
              ptyId: 'pty-omp',
              title: '\u280b π - tmp',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '\u280b OMP - tmp'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('skips the foreground-process probe when the PTY launch agent is already known', async () => {
    // Why: foregroundAgent is only a fallback when launchAgent is unknown, so probing a launched agent burns a relay round-trip without changing the resolved owner.
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-omp' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'omp',
      launchAgent: 'omp',
      title: 'OMP',
      activate: true
    })

    runtime.onPtyData('pty-omp', '\x1b]0;⠋ OMP\x07working\n', 100)
    runtime.onPtyData('pty-omp', '\x1b]0;OMP ready\x07idle\n', 200)

    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('probes the foreground process only on a status transition for unknown launch agents', async () => {
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    syncSinglePty(runtime, 'pty-bg')
    // Why: each probe dedups while in-flight; settle it before the next frame to prove the gate, not the dedup, suppresses extra probes.
    const settleProbe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

    // Two working frames (spinner churn) collapse to a single status transition.
    runtime.onPtyData('pty-bg', '\x1b]0;⠋ OMP\x07alpha\n', 100)
    runtime.onPtyData('pty-bg', '\x1b]0;⠊ OMP\x07bravo\n', 200)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    // Transition to idle is a second distinct status, so it probes again.
    runtime.onPtyData('pty-bg', '\x1b]0;OMP ready\x07charlie\n', 300)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)

    // A repeated idle frame is not a transition, so it does not probe again.
    runtime.onPtyData('pty-bg', '\x1b]0;OMP ready\x07delta\n', 400)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('normalizes Pi-compatible mobile session status to OMP for an unknown-launch foreground omp PTY', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-omp')
    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'OMP ready',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'omp',
          terminalHandle: terminal.handle,
          terminalTitle: 'OMP ready'
        })
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('preserves host metadata when terminal.create adopts a stable pane owner', async () => {
    const adoptStablePane = vi.fn().mockResolvedValue(null)
    const spawn = vi.fn(async (opts: { adoptedStablePane?: { owner: { handle?: string } } }) =>
      opts.adoptedStablePane
        ? {
            id: 'pty-stable-owner',
            isReattach: true,
            stablePaneOwner: {
              handle: opts.adoptedStablePane.owner.handle!,
              tabId: 'stable-owner-tab',
              leafId: HEADLESS_LEAF_ID
            }
          }
        : { id: 'pty-stable-owner' }
    )
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      adoptStablePane,
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const first = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stable-owner-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Original owner',
      launchAgent: 'claude'
    })
    adoptStablePane.mockResolvedValueOnce({
      result: { id: 'pty-stable-owner', isReattach: true },
      owner: {
        handle: first.handle,
        tabId: 'stable-owner-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-stable-owner'
      }
    })

    const adopted = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stable-owner-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Replacement intent',
      command: "claude 'replacement'",
      launchAgent: 'claude'
    })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(adopted).toMatchObject({
      handle: first.handle,
      ptyId: 'pty-stable-owner',
      title: 'Original owner',
      isReattach: true
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'stable-owner-tab',
        title: 'Original owner',
        launchAgent: 'claude'
      })
    ])
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: "claude 'replacement'",
      adoptedStablePane: expect.anything()
    })
    expect(spawn.mock.calls[1]?.[0]).not.toMatchObject({
      command: expect.stringContaining('--teammate-mode')
    })
  })

  it('releases a stable-pane claim when creation aborts before provider spawn', async () => {
    const releaseClaim = vi.fn()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      claimStablePaneCreate: vi.fn(() => releaseClaim),
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const abort = new AbortController()
    abort.abort()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'aborted-stable-pane',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
    expect(releaseClaim).toHaveBeenCalledOnce()
  })

  it('publishes the hook provider session on a headless mobile tab so native chat can address the transcript', async () => {
    const paneKey = makePaneKey('claude-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: '7dd0c22c-0ff6-45bf-b88a-cea11c34d073',
      transcriptPath: '/transcripts/7dd0c22c.jsonl'
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      // Headless serve has no renderer, so the hook snapshot is the only carrier.
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'claude-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-claude' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'claude-tab',
      leafId: HEADLESS_LEAF_ID,
      launchAgent: 'claude',
      title: 'Terminal'
    })

    runtime.onPtyData('pty-claude', '\x1b]0;✳ Claude Code\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'claude', providerSession })
      })
    )
  })

  it('recovers the agent type from the hook row when the pane was launched without an agent hint', async () => {
    // A user who types `claude` in a plain terminal leaves no launchAgent, and headless
    // has no renderer to publish one; without the hook's agentType mobile treats the tab
    // as a non-agent terminal and hides native chat even though the session is addressable.
    const paneKey = makePaneKey('shell-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
      transcriptPath: '/transcripts/ac1f6b90.jsonl'
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'shell-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-shell' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'shell-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-shell', '\x1b]0;✳ Claude Code\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'claude', providerSession })
      })
    )
  })

  it('reads one agent-status snapshot per projection, not one per terminal tab', async () => {
    // The getter rebuilds every known pane's payload on each call, so reading it
    // inside the per-tab loop made a projection O(tabs x panes) of pure garbage —
    // worst in headless serve, where every terminal tab takes the hook fallback.
    let snapshotReads = 0
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentProviderSessionSnapshot: () => {
        snapshotReads += 1
        return []
      }
    })
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-${snapshotReads}-${Math.random()}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    for (const tabId of ['fan-a', 'fan-b', 'fan-c']) {
      await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId,
        leafId: HEADLESS_LEAF_ID,
        launchAgent: 'claude',
        title: 'Terminal'
      })
    }
    snapshotReads = 0

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    // Guards the assertion below from passing vacuously on a one-tab projection.
    expect(result.tabs.filter((tab) => tab.type === 'terminal').length).toBeGreaterThan(1)
    expect(snapshotReads).toBe(1)
  })

  it('publishes hook-only identity for a pane that never emitted an agent title', async () => {
    // The hook row is the whole evidence here: no launchAgent hint, no recognized OSC
    // title, so `pty.lastAgentStatus` stays unset. Gating the hook read behind that
    // made the headless carrier unreachable in exactly the case it exists for.
    const paneKey = makePaneKey('quiet-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: 'b91c7e40-5a2d-4f19-9c33-2a7b6e5d4c88',
      transcriptPath: '/transcripts/b91c7e40.jsonl'
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'quiet-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-quiet' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'quiet-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'claude', providerSession })
      })
    )
  })

  it('reads a resume-identity-only row the live-agent snapshot filters out', async () => {
    // Pi publishes its session separately from status, and the shared getter drops
    // those rows so they can't read as running agents — leaving native chat with no
    // transcript to address unless the unfiltered snapshot is consulted too.
    const paneKey = makePaneKey('pi-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: '/sessions/pi-1.json',
      transcriptPath: '/sessions/pi-1.json'
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentProviderSessionSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: '',
          agentType: 'pi',
          connectionId: null,
          receivedAt: now + 1,
          stateStartedAt: now + 1,
          tabId: 'pi-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession,
          providerSessionOnly: true
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'pi-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'pi', providerSession })
      })
    )
  })

  it('does not let stale Pi resume metadata claim a plain terminal', async () => {
    const paneKey = makePaneKey('stale-pi-tab', HEADLESS_LEAF_ID)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentProviderSessionSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: '',
          agentType: 'pi',
          connectionId: null,
          receivedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
          stateStartedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
          tabId: 'stale-pi-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession: {
            key: 'session_id',
            id: '/sessions/stale-pi.json',
            transcriptPath: '/sessions/stale-pi.json'
          },
          providerSessionOnly: true
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-stale-pi' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stale-pi-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.not.objectContaining({ agentType: 'pi' })
      })
    )
  })

  it('does not claim a stale hook agent owns a pane whose agent has since exited', async () => {
    // `pty.lastAgentStatus` outlives the agent, so an unbounded hook read would keep
    // offering mobile native chat for what is now a plain shell — and point it at a
    // dead transcript. The session id may stay; the ownership claim must not.
    const paneKey = makePaneKey('exited-tab', HEADLESS_LEAF_ID)
    const staleReceivedAt = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1_000
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: staleReceivedAt,
          stateStartedAt: staleReceivedAt,
          tabId: 'exited-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession: {
            key: 'session_id' as const,
            id: 'd4c3b2a1-0000-4000-8000-000000000001',
            transcriptPath: '/transcripts/d4c3b2a1.jsonl'
          }
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-exited' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'exited-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-exited', '\x1b]0;✳ Claude Code\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    const tab = result.tabs[0]
    expect(tab?.type).toBe('terminal')
    const agentStatus = tab && 'agentStatus' in tab ? tab.agentStatus : null
    expect(agentStatus?.agentType ?? null).toBeNull()
  })

  it('waits for unknown-launch foreground owner before publishing Pi-compatible mobile status', async () => {
    const foregroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(() => foregroundProcess.promise)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-omp')
    expect(events).toHaveLength(0)

    foregroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: 'OMP ready',
            agentStatus: expect.objectContaining({
              state: 'done',
              agentType: 'omp',
              terminalHandle: terminal.handle,
              terminalTitle: 'OMP ready'
            })
          })
        ]
      })
    ])

    unsubscribe()
  })

  it('keeps decorative Pi frames queued behind the foreground owner probe', async () => {
    const foregroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(() => foregroundProcess.promise)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;⠋ Pi\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.onPtyData('pty-typed-omp', '\x1b]0;⠙ Pi\x07', 124)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    foregroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: '⠋ OMP',
            agentStatus: expect.objectContaining({
              state: 'working',
              agentType: 'omp',
              terminalHandle: terminal.handle,
              terminalTitle: '⠋ OMP'
            })
          })
        ]
      })
    ])

    runtime.onPtyData('pty-typed-omp', '\x1b]0;⠹ Pi\x07', 125)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toHaveLength(1)

    unsubscribe()
  })

  it('coalesces same-status title frames behind one post-title foreground probe', async () => {
    const staleForegroundProcess = deferred<string | null>()
    const freshForegroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi
      .fn()
      .mockReturnValueOnce(staleForegroundProcess.promise)
      .mockReturnValueOnce(freshForegroundProcess.promise)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi idle\x07', 124)
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi done\x07', 125)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    staleForegroundProcess.resolve(null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(0)

    freshForegroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: 'OMP ready',
            agentStatus: expect.objectContaining({
              state: 'done',
              agentType: 'omp',
              terminalHandle: terminal.handle,
              terminalTitle: 'OMP ready'
            })
          })
        ]
      })
    ])

    unsubscribe()
  })

  it('starts a post-title foreground probe when an older pending probe finds no owner', async () => {
    const staleForegroundProcess = deferred<string | null>()
    const freshForegroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi
      .fn()
      .mockReturnValueOnce(staleForegroundProcess.promise)
      .mockReturnValueOnce(freshForegroundProcess.promise)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    ;(
      runtime as unknown as {
        refreshPtyForegroundAgentFromController: (ptyId: string) => Promise<boolean>
      }
    ).refreshPtyForegroundAgentFromController('pty-typed-omp')
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    staleForegroundProcess.resolve(null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(0)

    freshForegroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: 'OMP ready',
            agentStatus: expect.objectContaining({
              state: 'done',
              agentType: 'omp',
              terminalHandle: terminal.handle,
              terminalTitle: 'OMP ready'
            })
          })
        ]
      })
    ])

    unsubscribe()
  })

  it('keeps Pi-compatible mobile session status as Pi for an unknown-launch foreground pi PTY', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-pi' })
    const getForegroundProcess = vi.fn(async () => 'pi')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-pi-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-typed-pi', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-pi')
    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'Pi ready',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'pi',
          terminalHandle: terminal.handle,
          terminalTitle: 'Pi ready'
        })
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('keeps renderer-vetted mobile agent status for custom-titled terminals', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude agents',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'codex',
                paneKey: hostPaneKey,
                terminalTitle: 'codex [working]',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    )
  })

  it('suppresses saved mobile agent status when live evidence is the Claude agents screen', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'claude agents'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude agents',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `tab-1:${leafId}`,
                terminalTitle: 'claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    // Stale "working" status is suppressed (no spinner), but agent identity is retained so native chat can still address the idle agent's transcript.
    const suppressed = result.tabs[0]
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.state).toBe('done')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.agentType).toBe('claude')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.terminalTitle).toBeUndefined()
  })

  it('suppresses saved mobile agent status when the current terminal title is neutral', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'bash'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'bash',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `tab-1:${leafId}`,
                terminalTitle: 'claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'bash'
      })
    )
    // Stale "working" suppressed; agent identity retained for native chat.
    const suppressed = result.tabs[0]
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.state).toBe('done')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.agentType).toBe('claude')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.terminalTitle).toBeUndefined()
  })

  it('suppresses saved mobile agent status when fresh live OSC title is Claude agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'claude working'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `tab-1:${leafId}`,
                terminalTitle: 'claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
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
