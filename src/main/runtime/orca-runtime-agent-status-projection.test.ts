import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  deferred,
  store,
  syncSinglePty,
  waitForMobileSessionTabsEvents
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

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
})
