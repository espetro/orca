import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIST_PROVIDER_DEADLINE,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRuntimeStoreWithWorkspaceSession,
  resetRuntimeTestMocks,
  setPlatform,
  store
} from './orca-runtime-test-fixture'
import { HEADLESS_LEAF_ID } from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { OrchestrationDb } from './orchestration/db'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('OrcaRuntimeService', () => {
  it('keeps live workers fenced without exact controller identity evidence', async () => {
    const incarnationId = '56565656-5656-4656-8656-565656565656'
    const cases = [
      {
        name: 'missing',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_missing'
      },
      {
        name: 'ambiguous',
        leafId: '22222222-2222-4222-8222-222222222222',
        terminalHandle: 'term_ambiguous'
      },
      {
        name: 'wrong-handle',
        leafId: '33333333-3333-4333-8333-333333333333',
        terminalHandle: 'term_wrong_handle'
      },
      {
        name: 'wrong-incarnation',
        leafId: '44444444-4444-4444-8444-444444444444',
        terminalHandle: 'term_wrong_incarnation'
      }
    ] as const
    const sleepingAgentSessionsByPaneKey = Object.fromEntries(
      cases.map(({ name, leafId }) => {
        const paneKey = `legacy-${name}:${leafId}`
        return [
          paneKey,
          {
            paneKey,
            tabId: `legacy-${name}`,
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: `session-${name}` },
            prompt: 'continue',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        ]
      })
    ) as WorkspaceSessionState['sleepingAgentSessionsByPaneKey']
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () =>
        cases.map(({ name, leafId, terminalHandle }) => ({
          dispatch_id: `dispatch-${name}`,
          task_id: `task-${name}`,
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: terminalHandle,
          assignee_pane_key: `legacy-${name}:${leafId}`,
          process_incarnation: `pty-${name}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: terminalHandle
        }))
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-missing',
        title: 'Missing identity',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-ambiguous',
        incarnationId,
        terminalHandle: 'term_ambiguous',
        title: 'Ambiguous identity',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-ambiguous-other',
        incarnationId,
        terminalHandle: 'term_ambiguous',
        title: 'Ambiguous identity duplicate',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-wrong-handle',
        incarnationId,
        terminalHandle: 'term_other',
        title: 'Wrong handle',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-wrong-incarnation',
        incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        terminalHandle: 'term_wrong_incarnation',
        title: 'Wrong incarnation',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-wrong-handle', 'dispatch-wrong-incarnation'],
      deferredDispatchIds: ['dispatch-missing', 'dispatch-ambiguous']
    })
    expect(listProcesses).toHaveBeenCalledOnce()
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    for (const { name, leafId } of cases.slice(0, 2)) {
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`legacy-${name}:${leafId}`]
          ?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
    }
    for (const { name, leafId } of cases.slice(2)) {
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`legacy-${name}:${leafId}`]
      ).toBeUndefined()
    }
  })

  it('adopts an exact live legacy worker in a folder workspace', async () => {
    const workerPaneKey = `legacy-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '66666666-6666-4666-8666-666666666666'
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-legacy-worker-folder-'))
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-folder',
          task_id: 'task-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-folder-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_FOLDER_WORKSPACE_KEY,
          agent_terminal_handle: 'term_folder'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-folder-legacy',
        incarnationId,
        terminalHandle: 'term_folder',
        title: 'Folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-folder-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-folder'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-folder-worker',
        ptyId: 'pty-folder-legacy',
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-legacy',
      title: 'Folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_folder',
        incarnationId
      }
    })
  })

  it('adopts an SSH legacy worker only after its matching relay is ready', async () => {
    const connectionId = 'ssh-legacy-worker'
    const ptyId = `ssh:${connectionId}@@pty-legacy-worker`
    const workerPaneKey = `legacy-ssh-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '77777777-7777-4777-8777-777777777777'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-ssh-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-ssh-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const localSession = getDefaultWorkspaceSession()
    let sshSession = session
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? sshSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      sshSession = next
    })
    const getSession = (): WorkspaceSessionState => sshSession
    const remoteRepo = {
      ...store.getRepos()[0],
      connectionId
    }
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_legacy',
        title: 'SSH legacy worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ])
    const serializeProviderBuffer = vi.fn().mockResolvedValue(null)
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: ' >_ OpenAI Codex (v0.131.0)\r\n model:       gpt-5.5 high\r\n directory:   /repo\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
        getWorkspaceSession,
        setWorkspaceSession,
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-ssh',
          task_id: 'task-ssh',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_ssh_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_ssh_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === ptyId,
      listProcesses,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => true
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-ssh-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn(async () => [
        {
          path: TEST_WORKTREE_PATH,
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ])
    } as never)

    try {
      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId: 'ssh-wrong-host',
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-ssh']
      })
      expect(listProcesses).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(getWorkspaceSession).toHaveBeenCalledWith(`ssh:${connectionId}`)

      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId,
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-ssh'],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
      expect(listProcesses).toHaveBeenLastCalledWith(connectionId, LIST_PROVIDER_DEADLINE)
    } finally {
      unregisterSshGitProvider(connectionId)
    }

    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId,
      title: 'SSH legacy worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-ssh-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_ssh_legacy',
        incarnationId
      }
    })
    await expect(
      runtime.waitForTerminal('term_ssh_legacy', { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(serializeBuffer).toHaveBeenCalledOnce()
  })

  it('refuses a cross-distro WSL worker and adopts it after exact host ownership matches', async () => {
    setPlatform('win32')
    const workerPaneKey = `legacy-wsl-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '88888888-8888-4888-8888-888888888888'
    let observedDistro = 'Debian'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-wsl-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-wsl-codex-session' },
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
      {
        ...runtimeStore,
        getProjects: () => [
          {
            id: 'project-wsl',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        }),
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-wsl',
          task_id: 'task-wsl',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_wsl_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-wsl-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_wsl_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    // Declares the scope parameter so mock.calls keeps it — the runtime passes a deadline
    // alongside it, and a bare `async () =>` would type the call tuple as empty.
    const listProcesses = vi.fn(async (_connectionId?: string | null) => [
      {
        id: 'pty-wsl-legacy',
        incarnationId,
        terminalHandle: 'term_wsl_legacy',
        title: 'WSL legacy worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: observedDistro
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-wsl-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-wsl-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-wsl-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-wsl']
    })
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(revealTerminalSession).not.toHaveBeenCalled()

    observedDistro = 'Ubuntu'
    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-wsl'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(listProcesses).toHaveBeenCalledTimes(5)
    expect(listProcesses.mock.calls.map((call) => call[0])).toEqual([null, null, null, null, null])
  })
})
