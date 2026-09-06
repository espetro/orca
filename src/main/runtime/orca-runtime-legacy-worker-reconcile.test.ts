import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_SECOND_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  resetRuntimeTestMocks
} from './orca-runtime-test-fixture'
import { HEADLESS_LEAF_ID } from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { OrchestrationDb } from './orchestration/db'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

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

describe('OrcaRuntimeService', () => {
  it('reconciles a same-id process replacement before headless adoption', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '56565656-5656-4656-8656-565656565656',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)

    await expect(harness.runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'rolled_back',
      harness.ptyId
    )
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('reconciles a same-id process replacement after renderer materialization', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '67676767-6767-4767-8767-676767676767',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
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

    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(harness.getSession().terminalLayoutsByTabId['legacy-post-reveal']).toBeUndefined()
    const runtimeState = harness.runtime as unknown as {
      tabs: Map<string, unknown>
      leaves: Map<string, unknown>
      ptysById: Map<string, { connected: boolean; incarnationId: string | null }>
    }
    expect(runtimeState.tabs.has('legacy-post-reveal')).toBe(false)
    expect([...runtimeState.leaves.keys()].some((key) => key.includes('legacy-post-reveal'))).toBe(
      false
    )
    expect(runtimeState.ptysById.get(harness.ptyId)).toMatchObject({
      connected: true,
      incarnationId: replacement.incarnationId
    })
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'rolled_back',
      harness.ptyId
    )
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('keeps the legacy worker resume fence in memory when persistence fails', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '99999999-9999-4999-8999-999999999999'
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
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    let flushCount = 0
    const flushPendingOrThrowAsync = vi.fn(() => {
      flushCount += 1
      if (flushCount === 1) {
        return Promise.resolve()
      }
      durableWriteStarted.resolve()
      return durableWrite.promise
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-persistence-failure',
          task_id: 'task-persistence-failure',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_persistence_failure',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-persistence-failure:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_persistence_failure'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-persistence-failure',
      listProcesses: async () => [
        {
          id: 'pty-persistence-failure',
          incarnationId,
          terminalHandle: 'term_persistence_failure',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-persistence-failure'
      })
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const recovery = runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    await durableWriteStarted.promise
    const concurrentPaneKey = `concurrent:${HEADLESS_SECOND_LEAF_ID}`
    setSession({
      ...getSession(),
      sleepingAgentSessionsByPaneKey: {
        ...getSession().sleepingAgentSessionsByPaneKey,
        [concurrentPaneKey]: {
          ...session.sleepingAgentSessionsByPaneKey![workerPaneKey]!,
          paneKey: concurrentPaneKey,
          tabId: 'concurrent-tab'
        }
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(recovery).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-persistence-failure']
    })
    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(getSession().sleepingAgentSessionsByPaneKey?.[concurrentPaneKey]?.tabId).toBe(
      'concurrent-tab'
    )
    expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('requeues an active Task before clearing recovery for an authoritatively missing worker', async () => {
    const workerPaneKey = `legacy-missing:${HEADLESS_LEAF_ID}`
    const incarnationId = '32323232-3232-4232-8232-323232323232'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-missing',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-missing-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const flushPendingOrThrowAsync = vi.fn(() => {
      durableWriteStarted.resolve()
      return durableWrite.promise
    })
    const flushOrThrow = vi.fn(() => {
      throw new Error('synchronous persistence must not run')
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'continue after missing worker recovery' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_missing_worker',
        paneKey: workerPaneKey,
        processIncarnation: `pty-missing-worker:${incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        listProcesses: async () => []
      })
      const resolveLegacyWorkerTerminalRecovery = vi.fn()
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)

      const recovery = runtime.reconcileLegacyWorkerTerminals()
      await durableWriteStarted.promise

      expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      durableWrite.resolve()

      await expect(recovery).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [started.dispatch.id],
        deferredDispatchIds: []
      })

      expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()
      expect(flushPendingOrThrowAsync).toHaveBeenCalledWith({
        drainToStableGeneration: false
      })
      expect(flushOrThrow).not.toHaveBeenCalled()
      expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
        status: 'failed',
        failure_count: 1
      })
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('abandoned')
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        workerPaneKey,
        'rolled_back',
        'pty-missing-worker'
      )
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
    } finally {
      db.close()
    }
  })
})
