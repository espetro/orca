import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIST_PROVIDER_DEADLINE,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_WINDOW_ID,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRuntimeStoreWithWorkspaceSession,
  resetRuntimeTestMocks,
  store
} from './orca-runtime-test-fixture'
import { HEADLESS_LEAF_ID } from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import type { OrchestrationDb } from './orchestration/db'

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
  it('adopts an SSH folder legacy worker through its SSH workspace-session partition', async () => {
    const connectionId = 'ssh-folder'
    const ptyId = `ssh:${connectionId}@@pty-folder-legacy`
    const workerPaneKey = `legacy-ssh-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '67676767-6767-4767-8767-676767676767'
    const folderPath = '/srv/platform'
    const sshInitialSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-ssh-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-ssh-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(sshInitialSession)
    const localSession = getDefaultWorkspaceSession()
    let sshSession = sshInitialSession
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? sshSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      sshSession = next
    })
    const folderWorkspace = makeFolderWorkspace({ folderPath, connectionId })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
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
          dispatch_id: 'dispatch-ssh-folder',
          task_id: 'task-ssh-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_ssh_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_FOLDER_WORKSPACE_KEY,
          agent_terminal_handle: 'term_ssh_folder'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_folder',
        title: 'SSH folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === ptyId,
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-ssh-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)
    registerSshFilesystemProvider(connectionId, {
      stat: vi.fn(async () => ({ size: 0, type: 'directory', mtime: 1 }))
    } as never)

    try {
      expect(runtime.prepareLegacyWorkerTerminalRecovery()).toMatchObject({
        blockedPanes: [expect.objectContaining({ paneKey: workerPaneKey })]
      })
      expect(
        sshSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId,
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-ssh-folder'],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
    } finally {
      unregisterSshFilesystemProvider(connectionId)
    }

    expect(sshSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(getWorkspaceSession).toHaveBeenCalledWith(`ssh:${connectionId}`)
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(connectionId, LIST_PROVIDER_DEADLINE)
    expect(sshSession.tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-ssh-folder-worker',
        ptyId,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId,
      title: 'SSH folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-ssh-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_ssh_folder',
        incarnationId
      }
    })
  })

  it('fences an unresolved folder legacy worker in its exact retained session partition', () => {
    const connectionId = 'ssh-unresolved-folder'
    const worktreeId = 'folder:missing-folder'
    const workerPaneKey = `legacy-unresolved-folder-worker:${HEADLESS_LEAF_ID}`
    const remoteInitialSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-unresolved-folder-worker',
          worktreeId,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-unresolved-folder-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const localSession = getDefaultWorkspaceSession()
    let remoteSession = remoteInitialSession
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? remoteSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      remoteSession = next
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getFolderWorkspaces: () => [],
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local', `ssh:${connectionId}`],
      setWorkspaceSession,
      flushOrThrow: vi.fn()
    } as never)
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-unresolved-folder',
          task_id: 'task-unresolved-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_unresolved_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: 'pty-unresolved-folder:68686868-6868-4868-8868-686868686868',
          worker_state: 'ready',
          worktree_id: worktreeId,
          agent_terminal_handle: 'term_unresolved_folder'
        }
      ]
    } as unknown as OrchestrationDb)

    expect(runtime.prepareLegacyWorkerTerminalRecovery()).toMatchObject({
      blockedPanes: [expect.objectContaining({ paneKey: workerPaneKey, worktreeId })]
    })
    expect(
      remoteSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(setWorkspaceSession).toHaveBeenCalledOnce()
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
  })
})
