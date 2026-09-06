import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  resetRuntimeTestMocks
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { OrchestrationDb } from './orchestration/db'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  function publishLegacyWorkerReveal(
    runtime: OrcaRuntimeService,
    identity: { worktreeId: string; tabId: string; leafId: string; ptyId: string },
    title = 'Recovered legacy worker'
  ): { tabId: string; identity: typeof identity } {
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId: identity.tabId,
          worktreeId: identity.worktreeId,
          title,
          activeLeafId: identity.leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: identity.tabId,
          worktreeId: identity.worktreeId,
          leafId: identity.leafId,
          paneRuntimeId: 1,
          ptyId: identity.ptyId
        }
      ]
    })
    return { tabId: identity.tabId, identity }
  }

  it('fences provider resume and reveals one exact live legacy worker without stealing focus', async () => {
    const workerLeafId = HEADLESS_LEAF_ID
    const coordinatorLeafId = HEADLESS_SECOND_LEAF_ID
    const workerPaneKey = `legacy-worker:${workerLeafId}`
    const incarnationId = '22222222-2222-4222-8222-222222222222'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_WORKTREE_ID,
      activeTabId: 'coordinator',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'coordinator' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'coordinator-group' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'coordinator',
            ptyId: 'pty-coordinator',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Coordinator',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        coordinator: makeHeadlessTerminalLayout({
          [coordinatorLeafId]: 'pty-coordinator'
        })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'coordinator-group',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'coordinator',
            tabOrder: ['coordinator']
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const flushOrThrow = vi.fn()
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow } as never, undefined, {
      canRecoverPersistentLocalPtys: () => true,
      attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash }) =>
        paneKey === workerPaneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey, source: 'hydrated_commitment' }
          : null
    })
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-legacy',
          task_id: 'task-legacy',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    const write = vi.fn(() => true)
    const kill = vi.fn(() => true)
    const READY_SCREEN =
      ' >_ OpenAI Codex (v0.131.0)\r\n model:       gpt-5.5 high\r\n directory:   /repo\r\n'
    // Why scrollbackRows-aware: a visible-only request gets the grid in `data`;
    // a scrollback request gets history. Collapsing the two would let a test
    // pass on evidence the caller never asked for.
    const serializeProviderBuffer = vi
      .fn()
      .mockImplementation(async (_ptyId: string, opts?: { scrollbackRows?: number }) => ({
        data: opts?.scrollbackRows === 0 ? READY_SCREEN : '',
        scrollbackAnsi: opts?.scrollbackRows === 0 ? '' : READY_SCREEN,
        cols: 80,
        rows: 24,
        seq: 100,
        source: 'headless' as const,
        alternateScreen: false
      }))
    runtime.setPtyController({
      write,
      kill,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => false,
      serializeProviderBuffer,
      hasPty: (ptyId) => ptyId === 'pty-legacy',
      listProcesses: async () => [
        {
          id: 'pty-legacy',
          incarnationId,
          terminalHandle: 'term_legacy',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(
        runtime,
        {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: workerLeafId,
          ptyId: 'pty-legacy'
        },
        'Legacy worker'
      )
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    runtime.prepareLegacyWorkerTerminalRecovery()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    const recovered = await runtime.reconcileLegacyWorkerTerminals({
      materializeRenderer: true
    })

    expect(recovered).toMatchObject({
      adoptedDispatchIds: ['dispatch-legacy'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().activeTabIdByWorktree?.[TEST_WORKTREE_ID]).toBe('coordinator')
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]?.[0]).toMatchObject({
      activeTabId: 'coordinator',
      tabOrder: ['coordinator', 'legacy-worker']
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-legacy',
      title: 'Legacy worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-worker',
      leafId: workerLeafId,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_legacy',
        incarnationId
      }
    })
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
    expect(write).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    const [terminal] = (await runtime.listTerminals()).terminals
    await expect(runtime.readTerminal(terminal.handle)).resolves.toMatchObject({
      tail: [' >_ OpenAI Codex (v0.131.0)', ' model:       gpt-5.5 high', ' directory:   /repo']
    })
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-legacy', {
      scrollbackRows: 120
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
    // Why: the ready banner stays in scrollback for the whole session, so a
    // working grid must not inherit idleness from its own history (#15569 review).
    serializeProviderBuffer.mockResolvedValueOnce({
      data: '  working on it (12s)\r\n  Esc to interrupt\r\n',
      scrollbackAnsi: READY_SCREEN,
      cols: 80,
      rows: 24,
      seq: 101,
      source: 'headless' as const,
      alternateScreen: false
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
    const lateReadySnapshot = deferred<{
      data: string
      scrollbackAnsi: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }>()
    const snapshotSequence = runtime.getPtyOutputSequence('pty-legacy')
    serializeProviderBuffer.mockImplementationOnce(() => lateReadySnapshot.promise)
    const staleReadyWait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 50
    })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledTimes(4))
    runtime.onPtyData('pty-legacy', '\x1b[H', Date.now())
    lateReadySnapshot.resolve({
      data: READY_SCREEN,
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: snapshotSequence,
      source: 'headless',
      alternateScreen: false
    })
    await expect(staleReadyWait).rejects.toThrow('timeout')
    serializeProviderBuffer.mockResolvedValueOnce({
      data: 'Do you trust this workspace directory?\r\n1. Yes\r\n2. No\r\n',
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: 101,
      source: 'headless' as const,
      alternateScreen: false
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'codex-trust-workspace'
    })
    serializeProviderBuffer.mockImplementationOnce(() => new Promise(() => {}))
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(6)
    // Why args, not counts: the one-shot responses above ignore their options,
    // so only this asserts every idle probe asked for the visible grid alone.
    expect(serializeProviderBuffer.mock.calls.slice(1)).toEqual([
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }]
    ])
    await expect(runtime.readTerminal(terminal.handle)).resolves.toBeDefined()
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(6)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term_legacy',
        paneKey: workerPaneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN
      })
    ).toMatchObject({
      terminalHandle: 'term_legacy',
      paneKey: workerPaneKey,
      processIncarnation: `pty-legacy:${incarnationId}`
    })

    await runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)
    expect(flushOrThrow).toHaveBeenCalled()

    serializeProviderBuffer.mockClear()
    runtime.onPtyExit('pty-legacy', 0, incarnationId)
    runtime.onPtySpawned('pty-legacy', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      awaitsRegistration: false
    })
    const replacementHandle = runtime.createPreAllocatedTerminalHandle()
    runtime.registerPreAllocatedHandleForPty('pty-legacy', replacementHandle)
    await expect(runtime.readTerminal(replacementHandle)).resolves.toMatchObject({ tail: [] })
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('retries renderer reveal before clearing an adopted legacy worker resume fence', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '44444444-4444-4444-8444-444444444444'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-reveal-retry',
          task_id: 'task-reveal-retry',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_reveal_retry',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-reveal-retry:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_reveal_retry'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-reveal-retry',
      listProcesses: async () => [
        {
          id: 'pty-reveal-retry',
          incarnationId,
          terminalHandle: 'term_reveal_retry',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer unavailable'))
      .mockImplementationOnce(() =>
        publishLegacyWorkerReveal(runtime, {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: HEADLESS_LEAF_ID,
          ptyId: 'pty-reveal-retry'
        })
      )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-reveal-retry'],
      deferredDispatchIds: []
    })
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
  })

  function makePostRevealWorkerRecoveryHarness(
    hasPty: (ptyId: string) => boolean | null,
    listProcesses?: () => Promise<
      {
        id: string
        incarnationId: string
        terminalHandle: string
        title: string
        cwd: string
        worktreeId: string
        wslDistro: null
      }[]
    >
  ): {
    runtime: OrcaRuntimeService
    getSession: () => WorkspaceSessionState
    workerPaneKey: string
    ptyId: string
    incarnationId: string
    terminalHandle: string
    kill: ReturnType<typeof vi.fn>
    revealTerminalSession: ReturnType<typeof vi.fn>
    resolveLegacyWorkerTerminalRecovery: ReturnType<typeof vi.fn>
  } {
    const workerPaneKey = `legacy-post-reveal:${HEADLESS_LEAF_ID}`
    const ptyId = 'pty-post-reveal'
    const incarnationId = '45454545-4545-4545-8545-454545454545'
    const terminalHandle = 'term_post_reveal'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-post-reveal',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-post-reveal-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-post-reveal',
          task_id: 'task-post-reveal',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_post_reveal',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_post_reveal'
        }
      ]
    } as unknown as OrchestrationDb)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill,
      getForegroundProcess: async () => null,
      hasPty,
      listProcesses:
        listProcesses ??
        (async () => [
          {
            id: ptyId,
            incarnationId,
            terminalHandle: 'term_post_reveal',
            title: 'Post-reveal worker',
            cwd: TEST_WORKTREE_PATH,
            worktreeId: TEST_WORKTREE_ID,
            wslDistro: null
          }
        ])
    })
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'legacy-post-reveal',
      identity: {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      }
    })
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)
    return {
      runtime,
      getSession,
      workerPaneKey,
      ptyId,
      incarnationId,
      terminalHandle,
      kill,
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    }
  }

  it('keeps a revealed worker fenced until its exact renderer graph is published', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => true)
      const identity = {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      }
      harness.revealTerminalSession.mockResolvedValue({
        tabId: identity.tabId,
        identity
      })

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeDefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()

      harness.runtime.attachWindow(1)
      harness.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            title: 'Post-reveal worker',
            activeLeafId: identity.leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            leafId: identity.leafId,
            paneRuntimeId: 1,
            ptyId: identity.ptyId
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
      expect(
        (await harness.runtime.listTerminals()).terminals.filter(
          (terminal) => terminal.ptyId === identity.ptyId
        )
      ).toEqual([
        expect.objectContaining({
          handle: harness.terminalHandle,
          incarnationId: harness.incarnationId,
          orphaned: false,
          worktreeId: identity.worktreeId,
          tabId: identity.tabId,
          leafId: identity.leafId
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires the exact worker when it exits after renderer reveal', async () => {
    const liveProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)
    harness.revealTerminalSession.mockImplementation(() =>
      publishLegacyWorkerReveal(harness.runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      })
    )

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(
      (
        harness.runtime as unknown as {
          ptysById: Map<string, { connected: boolean; incarnationId?: string }>
        }
      ).ptysById.get(harness.ptyId)
    ).toMatchObject({ connected: false, incarnationId: '45454545-4545-4545-8545-454545454545' })
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('re-reveals a recovered worker after the renderer graph epoch changes', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => false)
      harness.runtime.attachWindow(TEST_WINDOW_ID)
      harness.revealTerminalSession
        .mockResolvedValueOnce({
          tabId: 'legacy-post-reveal',
          identity: {
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'legacy-post-reveal',
            leafId: HEADLESS_LEAF_ID,
            ptyId: harness.ptyId
          }
        })
        .mockImplementationOnce(() =>
          publishLegacyWorkerReveal(harness.runtime, {
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'legacy-post-reveal',
            leafId: HEADLESS_LEAF_ID,
            ptyId: harness.ptyId
          })
        )

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      harness.runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })
      harness.runtime.markRendererReloading(TEST_WINDOW_ID)
      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-post-reveal'],
        deferredDispatchIds: []
      })

      expect(harness.revealTerminalSession).toHaveBeenCalledTimes(2)
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps recovery fenced when the renderer omits the exact reveal identity', async () => {
    const harness = makePostRevealWorkerRecoveryHarness(() => false)
    harness.revealTerminalSession.mockResolvedValue({ tabId: 'legacy-post-reveal' })

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-post-reveal']
    })

    expect(harness.revealTerminalSession).toHaveBeenCalledTimes(2)
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeDefined()
    expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
  })
})
