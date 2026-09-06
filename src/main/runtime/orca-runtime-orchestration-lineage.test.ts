/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  makeWorktreeMeta,
  resetRuntimeTestMocks,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { listWorktrees } from '../git/worktree'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('worktree scan cache: keeps lineage shaping outside the raw scan cache', async () => {
    vi.mocked(listWorktrees).mockClear()
    const paths = ['orchestration', 'cli', 'manual']
    const metaById: Record<string, WorktreeMeta> = {}
    const lineageById: Record<string, WorktreeLineage> = {}
    const worktrees = paths.flatMap((origin, index) => {
      const parentPath = `/tmp/${origin}-parent`
      const childPath = `/tmp/${origin}-child`
      const parentId = `${TEST_REPO_ID}::${parentPath}`
      const childId = `${TEST_REPO_ID}::${childPath}`
      metaById[parentId] = makeWorktreeMeta({ instanceId: `parent-${index}` })
      metaById[childId] = makeWorktreeMeta({ instanceId: `child-${index}` })
      lineageById[childId] = {
        worktreeId: childId,
        worktreeInstanceId: `child-${index}`,
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: `parent-${index}`,
        origin: origin === 'orchestration' ? 'orchestration' : origin === 'cli' ? 'cli' : 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
      return [
        { path: parentPath, head: 'parent', branch: origin, isBare: false, isMainWorktree: false },
        {
          path: childPath,
          head: 'child',
          branch: `${origin}-child`,
          isBare: false,
          isMainWorktree: false
        }
      ]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    }
    vi.mocked(listWorktrees).mockResolvedValue(worktrees)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const listed = await runtime.listManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(
      listed.worktrees
        .filter((worktree) => worktree.lineage)
        .map((worktree) => worktree.lineage?.origin)
    ).toEqual(paths)
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('does not prune lineage when an SSH runtime provider is unavailable', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).resolves.toMatchObject({
      id: childId,
      parentWorktreeId: parentId,
      lineage: lineageById[childId]
    })

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('exposes valid parent and child lineage in CLI worktree records', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'parent'
      }),
      [childId]: makeWorktreeMeta({
        instanceId: 'child-instance',
        displayName: 'child'
      })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listManagedWorktrees('id:repo-1')
    const parent = listed.worktrees.find((worktree) => worktree.id === parentId)
    const child = listed.worktrees.find((worktree) => worktree.id === childId)

    expect(parent).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [childId],
      lineage: null
    })
    expect(child).toMatchObject({
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: lineageById[childId]
    })
    await expect(runtime.showManagedWorktree(`id:${childId}`)).resolves.toMatchObject({
      id: childId,
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: lineageById[childId]
    })
  })

  it('keeps valid orchestration lineage when caller terminal context is stale', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/worker-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'coordinator'
      })
    }
    const setWorktreeLineage = vi.fn((worktreeId: string, lineage) => {
      metaById[worktreeId] = metaById[worktreeId] ?? makeWorktreeMeta()
      return lineage
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta({ instanceId: 'child-instance' })
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/coordinator',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      lineage: {
        callerTerminalHandle: 'term_stale',
        orchestrationContext: {
          parentWorktreeId: parentId,
          orchestrationRunId: 'run-1',
          taskId: 'task-1',
          coordinatorHandle: 'term_coord'
        }
      }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      orchestrationRunId: 'run-1',
      taskId: 'task-1',
      coordinatorHandle: 'term_coord'
    })
    expect(result.lineage).not.toHaveProperty('createdByTerminalHandle')
    expect(result.warnings).toEqual([])
    expect(setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
  })

  it('enriches caller-terminal lineage with active orchestration dispatch context', async () => {
    const workerPath = '/tmp/worktree-worker'
    const childPath = '/tmp/workspaces/worker-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const workerId = `${TEST_REPO_ID}::${workerPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'coordinator'
      }),
      [workerId]: makeWorktreeMeta({
        instanceId: 'worker-instance',
        displayName: 'worker'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => ({
        task_id: 'task-1'
      })),
      getActiveCoordinatorRun: vi.fn(() => ({
        id: 'run-1',
        coordinator_handle: coordinatorHandle
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          title: 'Worker',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Coordinator',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        ...MOCK_GIT_WORKTREES,
        {
          path: workerPath,
          head: 'fed',
          branch: 'feature/worker',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      lineage: { callerTerminalHandle: workerHandle }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: workerId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      orchestrationRunId: 'run-1',
      taskId: 'task-1',
      coordinatorHandle,
      createdByTerminalHandle: workerHandle
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: expect.not.stringMatching(/^old-/),
        parentWorktreeInstanceId: 'worker-instance'
      })
    )
  })

  it('returns active orchestration context for renderer-synced terminal leaves', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '11111111-1111-4111-8111-111111111111'
    const coordinatorLeafId = '22222222-2222-4222-8222-222222222222'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const coordinatorPaneKey = makePaneKey('tab-coordinator', coordinatorLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-1',
              run_id: 'run-1',
              task_id: 'task-1',
              assignee_handle: workerHandle,
              status: 'dispatched'
            }
          : undefined
      ),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-done',
              run_id: 'run-1',
              task_id: 'task-done',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now()).toISOString()
            }
          : undefined
      ),
      getTask: vi.fn(() => ({
        id: 'task-1',
        run_id: 'run-1',
        task_title: 'Dispatch prompt work',
        display_name: 'Review dispatch prompts and make worker labels distinct',
        spec: 'Review dispatch prompts\n\nand make worker labels distinct',
        created_by_terminal_handle: coordinatorHandle
      })),
      getRun: vi.fn(() => ({
        id: 'run-1',
        coordinator_handle: coordinatorHandle,
        legacy: 0
      }))
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: coordinatorLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: coordinatorLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      dispatchStatus: 'dispatched',
      taskTitle: 'Dispatch prompt work',
      displayName: 'Review dispatch prompts and make worker labels distinct',
      parentPaneKey: coordinatorPaneKey,
      parentTerminalHandle: coordinatorHandle,
      coordinatorHandle,
      orchestrationRunId: 'run-1'
    })
  })

  it.each([
    ['fails closed when a modern dispatch owning Run is missing', 'run-missing', 'run-missing'],
    ['fails closed when Task and Dispatch Runs disagree', 'run-dispatch', 'run-task']
  ])('%s', (_name, dispatchRunId, taskRunId) => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '77777777-7777-4777-8777-777777777777'
    const coordinatorLeafId = '88888888-8888-4888-8888-888888888888'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    const getActiveCoordinatorRun = vi.fn(() => ({
      id: 'run-legacy-unrelated',
      coordinator_handle: coordinatorHandle
    }))
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-missing-run',
              run_id: dispatchRunId,
              task_id: 'task-missing-run',
              assignee_handle: workerHandle,
              status: 'dispatched'
            }
          : undefined
      ),
      getLatestDispatchForTerminal: vi.fn(() => undefined),
      getTask: vi.fn(() => ({
        id: 'task-missing-run',
        run_id: taskRunId,
        spec: 'modern task without proven Run',
        created_by_terminal_handle: coordinatorHandle
      })),
      getRun: vi.fn(() => undefined),
      getActiveCoordinatorRun
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Worker',
          activeLeafId: workerLeafId,
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Coordinator',
          activeLeafId: coordinatorLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: coordinatorLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toEqual({
      taskId: 'task-missing-run',
      dispatchId: 'ctx-missing-run',
      dispatchStatus: 'dispatched',
      taskTitle: 'modern task without proven Run',
      displayName: 'modern task without proven Run'
    })
    expect(getActiveCoordinatorRun).not.toHaveBeenCalled()
  })

  it('uses durable Run ownership before worktree-scoped legacy attribution', () => {
    const childWorktreeId = `${TEST_REPO_ID}::${join(tmpdir(), 'workspaces', 'run-a-worker')}`
    const folderWorktreeId = `${TEST_REPO_ID}::${join(tmpdir(), 'folder')}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    const meta = store.getAllWorktreeMeta()[TEST_WORKTREE_ID]
    const metaById = {
      ...store.getAllWorktreeMeta(),
      [childWorktreeId]: meta,
      [folderWorktreeId]: meta
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    } as never)
    const terminals = [
      {
        name: 'coordinator-a',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '11111111-1111-4111-8111-111111111111'
      },
      {
        name: 'coordinator-b',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '22222222-2222-4222-8222-222222222222'
      },
      {
        name: 'worker-cross-worktree',
        worktreeId: childWorktreeId,
        leafId: '33333333-3333-4333-8333-333333333333'
      },
      {
        name: 'worker-same-worktree',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '44444444-4444-4444-8444-444444444444'
      },
      {
        name: 'worker-folder',
        worktreeId: folderWorktreeId,
        leafId: '55555555-5555-4555-8555-555555555555'
      },
      {
        name: 'legacy-worker',
        worktreeId: childWorktreeId,
        leafId: '66666666-6666-4666-8666-666666666666'
      }
    ].map((terminal, index) => ({
      ...terminal,
      tabId: `tab-${terminal.name}`,
      ptyId: `pty-${terminal.name}`,
      paneRuntimeId: index + 1
    }))
    const terminalByName = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, terminal])
    )
    const handles = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, runtime.preAllocateHandleForPty(terminal.ptyId)])
    )
    const paneKey = (name: string): string => {
      const terminal = terminalByName[name]
      return makePaneKey(terminal.tabId, terminal.leafId)
    }
    const db = new OrchestrationDb(':memory:')
    try {
      const runA = db.createRun({
        objective: 'coordinate run A',
        coordinatorHandle: handles['coordinator-a'],
        coordinatorPaneKey: paneKey('coordinator-a')
      })
      const runB = db.createRun({
        objective: 'coordinate run B',
        coordinatorHandle: handles['coordinator-b'],
        coordinatorPaneKey: paneKey('coordinator-b')
      })
      const dispatches = Object.fromEntries(
        [
          ['worker-cross-worktree', runA.id],
          ['worker-same-worktree', runA.id],
          ['worker-folder', runB.id]
        ].map(([name, runId]) => {
          const task = db.createTask({ spec: name, runId })
          return [name, createRootDispatch(db, task.id, handles[name], paneKey(name))]
        })
      )
      const legacyTask = db.createTask({ spec: 'legacy worker' })
      const legacyDispatch = createRootDispatch(
        db,
        legacyTask.id,
        handles['legacy-worker'],
        paneKey('legacy-worker')
      )
      db.createCoordinatorRun({
        spec: 'unrelated legacy coordinator',
        coordinatorHandle: handles['coordinator-b']
      })
      const getActiveCoordinatorRun = vi.spyOn(db, 'getActiveCoordinatorRun')
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)

      const result = runtime.syncWindowGraph(1, {
        tabs: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: terminal.worktreeId,
          title: terminal.name,
          activeLeafId: terminal.leafId,
          layout: null
        })),
        leaves: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: terminal.worktreeId,
          leafId: terminal.leafId,
          paneRuntimeId: terminal.paneRuntimeId,
          ptyId: terminal.ptyId,
          paneTitle: null
        }))
      })

      for (const [name, run, coordinator] of [
        ['worker-cross-worktree', runA, 'coordinator-a'],
        ['worker-same-worktree', runA, 'coordinator-a'],
        ['worker-folder', runB, 'coordinator-b']
      ] as const) {
        expect(result.agentOrchestrationByPaneKey?.[paneKey(name)]).toMatchObject({
          taskId: dispatches[name].task_id,
          dispatchId: dispatches[name].id,
          dispatchStatus: 'dispatched',
          parentTerminalHandle: handles[coordinator],
          parentPaneKey: paneKey(coordinator),
          coordinatorHandle: handles[coordinator],
          orchestrationRunId: run.id
        })
      }
      const legacyContext = result.agentOrchestrationByPaneKey?.[paneKey('legacy-worker')]
      expect(legacyContext).toMatchObject({
        taskId: legacyTask.id,
        dispatchId: legacyDispatch.id,
        dispatchStatus: 'dispatched'
      })
      expect(legacyContext).not.toHaveProperty('parentTerminalHandle')
      expect(legacyContext).not.toHaveProperty('coordinatorHandle')
      expect(legacyContext).not.toHaveProperty('orchestrationRunId')
      expect(getActiveCoordinatorRun).toHaveBeenCalledOnce()
    } finally {
      db.close()
    }
  })

  it('uses the still-bound owning Run coordinator after a creator pane rebinds', () => {
    const runtime = new OrcaRuntimeService(store)
    const terminals = [
      {
        name: 'coordinator',
        leafId: '11111111-1111-4111-8111-111111111111'
      },
      {
        name: 'creator',
        leafId: '22222222-2222-4222-8222-222222222222'
      },
      {
        name: 'worker',
        leafId: '33333333-3333-4333-8333-333333333333'
      },
      {
        name: 'coordinator-created-worker',
        leafId: '44444444-4444-4444-8444-444444444444'
      }
    ].map((terminal, index) => ({
      ...terminal,
      tabId: `tab-${terminal.name}`,
      ptyId: `pty-${terminal.name}`,
      paneRuntimeId: index + 1
    }))
    const terminalByName = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, terminal])
    )
    const handles = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, runtime.preAllocateHandleForPty(terminal.ptyId)])
    )
    const paneKey = (name: string): string => {
      const terminal = terminalByName[name]
      return makePaneKey(terminal.tabId, terminal.leafId)
    }
    const graph = () => ({
      tabs: terminals.map((terminal) => ({
        tabId: terminal.tabId,
        worktreeId: TEST_WORKTREE_ID,
        title: terminal.name,
        activeLeafId: terminal.leafId,
        layout: null
      })),
      leaves: terminals.map((terminal) => ({
        tabId: terminal.tabId,
        worktreeId: TEST_WORKTREE_ID,
        leafId: terminal.leafId,
        paneRuntimeId: terminal.paneRuntimeId,
        ptyId: terminal.ptyId,
        paneTitle: null
      }))
    })
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, graph())
      const runA = db.createRun({
        objective: 'own the nested worker',
        coordinatorHandle: handles.coordinator,
        coordinatorPaneKey: paneKey('coordinator')
      })
      const creatorAuthority = runtime.getOrchestrationDispatchAuthority(handles.creator)
      const coordinatorAuthority = runtime.getOrchestrationDispatchAuthority(handles.coordinator)
      expect(creatorAuthority?.processIncarnation).toBeTruthy()
      expect(coordinatorAuthority?.processIncarnation).toBeTruthy()
      const creatorTask = db.createTask({ spec: 'create nested work', runId: runA.id })
      createRootDispatch(
        db,
        creatorTask.id,
        handles.creator,
        paneKey('creator'),
        undefined,
        creatorAuthority?.processIncarnation ?? undefined
      )
      const workerTask = db.createTask({
        spec: 'nested work',
        runId: runA.id,
        createdByTerminalHandle: handles.creator,
        createdByPaneKey: paneKey('creator'),
        createdByProcessIncarnation: creatorAuthority?.processIncarnation ?? undefined,
        createdByRunGeneration: runA.consumer_generation
      })
      const workerDispatch = createRootDispatch(
        db,
        workerTask.id,
        handles.worker,
        paneKey('worker')
      )
      const coordinatorCreatedTask = db.createTask({
        spec: 'coordinator-created work',
        runId: runA.id,
        createdByTerminalHandle: handles.coordinator,
        createdByPaneKey: paneKey('coordinator'),
        createdByProcessIncarnation: coordinatorAuthority?.processIncarnation ?? undefined,
        createdByRunGeneration: runA.consumer_generation
      })
      const coordinatorCreatedDispatch = createRootDispatch(
        db,
        coordinatorCreatedTask.id,
        handles['coordinator-created-worker'],
        paneKey('coordinator-created-worker')
      )
      expect(
        runtime.syncWindowGraph(1, graph()).agentOrchestrationByPaneKey?.[paneKey('worker')]
      ).toMatchObject({
        parentTerminalHandle: handles.creator,
        parentPaneKey: paneKey('creator'),
        coordinatorHandle: handles.coordinator,
        orchestrationRunId: runA.id
      })

      const oldCreatorPaneKey = paneKey('creator')
      terminalByName.creator.tabId = 'tab-creator-reminted'
      terminalByName.creator.ptyId = 'pty-creator-reminted'
      const remintedCreatorHandle = runtime.preAllocateHandleForPty(terminalByName.creator.ptyId)
      runtime.syncWindowGraph(1, graph())
      const runB = db.createRun({
        objective: 'rebind the creator pane',
        coordinatorHandle: remintedCreatorHandle,
        coordinatorPaneKey: paneKey('creator')
      })
      const reboundContext = runtime.syncWindowGraph(1, graph()).agentOrchestrationByPaneKey?.[
        paneKey('worker')
      ]

      expect(db.getRun(runA.id)).toMatchObject({
        coordinator_handle: handles.coordinator,
        consumer_generation: 1
      })
      expect(oldCreatorPaneKey).not.toBe(paneKey('creator'))
      expect(db.getRun(runB.id)).toMatchObject({ coordinator_handle: remintedCreatorHandle })
      expect(reboundContext).toMatchObject({
        taskId: workerTask.id,
        dispatchId: workerDispatch.id,
        dispatchStatus: 'dispatched',
        parentTerminalHandle: handles.coordinator,
        parentPaneKey: paneKey('coordinator'),
        coordinatorHandle: handles.coordinator,
        orchestrationRunId: runA.id
      })

      db.createRun({
        objective: 'rebind the original coordinator pane',
        coordinatorHandle: handles.coordinator,
        coordinatorPaneKey: paneKey('coordinator')
      })
      const unboundContext = runtime.syncWindowGraph(1, graph()).agentOrchestrationByPaneKey?.[
        paneKey('coordinator-created-worker')
      ]

      expect(db.getRun(runA.id)).toMatchObject({
        coordinator_handle: null,
        coordinator_pane_key: null,
        consumer_generation: 2
      })
      expect(unboundContext).toEqual({
        taskId: coordinatorCreatedTask.id,
        dispatchId: coordinatorCreatedDispatch.id,
        dispatchStatus: 'dispatched',
        taskTitle: 'coordinator-created work',
        displayName: 'coordinator-created work',
        orchestrationRunId: runA.id
      })
    } finally {
      db.close()
    }
  })

  it('queries each stable terminal handle once while publishing orchestration context', () => {
    const runtime = new OrcaRuntimeService(store)
    const terminals = Array.from({ length: 100 }, (_, index) => ({
      tabId: `tab-query-${index}`,
      leafId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ptyId: `pty-query-${index}`,
      paneRuntimeId: index + 1
    }))
    const handles = terminals.map((terminal) => runtime.preAllocateHandleForPty(terminal.ptyId))
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'query count oracle',
        coordinatorHandle: handles[99],
        coordinatorPaneKey: makePaneKey(terminals[99].tabId, terminals[99].leafId)
      })
      const task = db.createTask({ spec: 'one dispatched terminal', runId: run.id })
      const dispatch = createRootDispatch(
        db,
        task.id,
        handles[0],
        makePaneKey(terminals[0].tabId, terminals[0].leafId)
      )
      const getActiveDispatchForTerminal = vi.spyOn(db, 'getActiveDispatchForTerminal')
      const getLatestDispatchForTerminal = vi.spyOn(db, 'getLatestDispatchForTerminal')
      const getTask = vi.spyOn(db, 'getTask')
      const getRun = vi.spyOn(db, 'getRun')
      const getActiveCoordinatorRun = vi.spyOn(db, 'getActiveCoordinatorRun')
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)

      const graph = {
        tabs: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: terminal.tabId,
          activeLeafId: terminal.leafId,
          layout: null
        })),
        leaves: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: terminal.leafId,
          paneRuntimeId: terminal.paneRuntimeId,
          ptyId: terminal.ptyId,
          paneTitle: null
        }))
      }
      runtime.syncWindowGraph(1, graph)

      const queryCounts = {
        activeDispatch: getActiveDispatchForTerminal.mock.calls.length,
        latestDispatch: getLatestDispatchForTerminal.mock.calls.length,
        task: getTask.mock.calls.length,
        run: getRun.mock.calls.length,
        legacyCoordinator: getActiveCoordinatorRun.mock.calls.length
      }

      db.completeDispatch(dispatch.id)
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 5_000)
      for (const query of [
        getActiveDispatchForTerminal,
        getLatestDispatchForTerminal,
        getTask,
        getRun,
        getActiveCoordinatorRun
      ]) {
        query.mockClear()
      }
      runtime.syncWindowGraph(1, graph)

      const historicalQueryCounts = {
        activeDispatch: getActiveDispatchForTerminal.mock.calls.length,
        latestDispatch: getLatestDispatchForTerminal.mock.calls.length,
        task: getTask.mock.calls.length,
        run: getRun.mock.calls.length,
        legacyCoordinator: getActiveCoordinatorRun.mock.calls.length
      }
      expect({
        active: {
          ...queryCounts,
          total: Object.values(queryCounts).reduce((sum, n) => sum + n)
        },
        historical: {
          ...historicalQueryCounts,
          total: Object.values(historicalQueryCounts).reduce((sum, n) => sum + n)
        }
      }).toEqual({
        active: {
          activeDispatch: 100,
          latestDispatch: 99,
          task: 1,
          run: 1,
          legacyCoordinator: 0,
          total: 201
        },
        historical: {
          activeDispatch: 100,
          latestDispatch: 100,
          task: 0,
          run: 0,
          legacyCoordinator: 0,
          total: 200
        }
      })
    } finally {
      vi.useRealTimers()
      db.close()
    }
  })

  it('returns completed orchestration context for renderer-synced terminal leaves', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '33333333-3333-4333-8333-333333333333'
    const coordinatorLeafId = '44444444-4444-4444-8444-444444444444'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const coordinatorPaneKey = makePaneKey('tab-coordinator', coordinatorLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => undefined),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-done',
              run_id: 'run-1',
              task_id: 'task-done',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now()).toISOString()
            }
          : undefined
      ),
      getTask: vi.fn(() => ({
        id: 'task-done',
        run_id: 'run-1',
        created_by_terminal_handle: coordinatorHandle
      })),
      getRun: vi.fn(() => ({
        id: 'run-1',
        coordinator_handle: coordinatorHandle,
        legacy: 0
      }))
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: coordinatorLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: coordinatorLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toMatchObject({
      taskId: 'task-done',
      dispatchId: 'ctx-done',
      dispatchStatus: 'completed',
      parentPaneKey: coordinatorPaneKey,
      parentTerminalHandle: coordinatorHandle
    })
  })

  it('does not attach an unrelated active coordinator run to a completed dispatch', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '55555555-5555-4555-8555-555555555555'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => undefined),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-done',
              task_id: 'task-done',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now()).toISOString()
            }
          : undefined
      ),
      getTask: vi.fn(() => ({
        id: 'task-done'
      })),
      getActiveCoordinatorRun: vi.fn(() => ({
        id: 'run-unrelated',
        coordinator_handle: 'term_unrelated'
      }))
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toEqual({
      taskId: 'task-done',
      dispatchId: 'ctx-done',
      dispatchStatus: 'completed'
    })
  })

  it.each(['failed', 'circuit_broken'] as const)(
    'returns recent %s orchestration context without an active coordinator',
    (dispatchStatus) => {
      const runtime = new OrcaRuntimeService(store)
      const workerLeafId = '66666666-6666-4666-8666-666666666666'
      const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
      const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
      const getActiveCoordinatorRun = vi.fn(() => ({
        id: 'run-unrelated',
        coordinator_handle: 'term_unrelated'
      }))
      runtime.setOrchestrationDb({
        getActiveDispatchForTerminal: vi.fn(() => undefined),
        getLatestDispatchForTerminal: vi.fn(() => ({
          id: 'ctx-settled',
          task_id: 'task-settled',
          assignee_handle: workerHandle,
          status: dispatchStatus,
          completed_at: new Date(Date.now()).toISOString()
        })),
        getActiveCoordinatorRun
      } as never)
      runtime.attachWindow(1)

      const result = runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-worker',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Claude Code',
            activeLeafId: workerLeafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-worker',
            worktreeId: TEST_WORKTREE_ID,
            leafId: workerLeafId,
            paneRuntimeId: 1,
            ptyId: 'pty-worker',
            paneTitle: null
          }
        ]
      })

      expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toEqual({
        taskId: 'task-settled',
        dispatchId: 'ctx-settled',
        dispatchStatus
      })
      expect(getActiveCoordinatorRun).not.toHaveBeenCalled()
    }
  )

  it('does not return stale completed orchestration context for renderer-synced terminal leaves', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '77777777-7777-4777-8777-777777777777'
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => undefined),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-stale',
              task_id: 'task-stale',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1).toISOString()
            }
          : undefined
      )
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey).toBeUndefined()
  })

  it('falls back to cwd lineage when the caller terminal handle is stale', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/cwd-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'cwd-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cwd-child',
      lineage: {
        callerTerminalHandle: 'term_stale',
        cwdParentWorktree: `id:${parentId}`
      }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' }
    })
    expect(result.worktree).toMatchObject({
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: result.lineage
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
  })

  it('keeps cwd-inferred lineage best-effort when the cwd parent cannot be resolved', async () => {
    const childPath = '/tmp/workspaces/no-cwd-parent'
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'no-cwd-parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'no-cwd-parent',
      lineage: {
        cwdParentWorktree: 'id:repo-1::/tmp/missing-parent'
      }
    })

    expect(result.lineage).toBeNull()
    expect(result.worktree).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message:
          'Worktree created, but Orca could not validate the current directory as a parent context.'
      })
    ])
  })

  it('infers orchestration lineage from task-id comments when dispatch is completed', async () => {
    const workerPath = '/tmp/worktree-worker'
    const childPath = '/tmp/workspaces/worker-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const workerId = `${TEST_REPO_ID}::${workerPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [workerId]: makeWorktreeMeta({
        instanceId: 'worker-instance',
        displayName: 'worker'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getDispatchContext: vi.fn(() => ({
        task_id: 'task_abc123',
        assignee_handle: workerHandle,
        status: 'completed'
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          title: 'Worker',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: workerPath,
          head: 'fed',
          branch: 'feature/worker',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      comment: 'Created via orchestration task task_abc123'
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: workerId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_abc123'
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeInstanceId: 'worker-instance'
      })
    )
  })

  it('infers orchestration lineage from task creator when no dispatch context exists', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/parent-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'parent'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const parentHandle = runtime.preAllocateHandleForPty('pty-parent')
    runtime.setOrchestrationDb({
      getDispatchContext: vi.fn(() => undefined),
      getTask: vi.fn(() => ({
        id: 'task_creator123',
        created_by_terminal_handle: parentHandle
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-parent',
          worktreeId: parentId,
          title: 'Parent',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-parent',
          worktreeId: parentId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-parent',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'fed',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'parent-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'parent-child',
      comment: 'Created via orchestration task task_creator123'
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_creator123'
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeInstanceId: 'parent-instance'
      })
    )
  })
})
