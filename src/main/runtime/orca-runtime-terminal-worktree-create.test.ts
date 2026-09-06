/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  MOCK_GIT_WORKTREES,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  addWorktreeMock,
  computeWorktreePathMock,
  deferred,
  deleteWorktreeHistoryDirMock,
  ensurePathWithinWorkspaceMock,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixture'

import { addSparseWorktree, addWorktree, listWorktrees } from '../git/worktree'

import { OrcaRuntimeService } from './orca-runtime'

import type { WorktreeMeta } from '../../shared/worktree/meta-types'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('does not reuse stale in-flight worktree scans after creating a worktree', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({
        exhaustedTiers: 0,
        names: Array.from({ length: 100 }, (_unused, index) =>
          index === 0 ? 'nautilus' : `nautilus-${index + 1}`
        )
      })
    })
    const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
    const createdWorktree = {
      path: '/tmp/workspaces/repo-nautilus-101',
      head: 'def',
      branch: 'nautilus-101',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees)
      .mockImplementationOnce(() => staleScan.promise)
      .mockResolvedValueOnce([createdWorktree])
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])

    const staleLookup = runtime.showManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })
    const freshLookup = runtime.showManagedWorktree(result.worktree.id)

    staleScan.resolve(MOCK_GIT_WORKTREES)

    await expect(staleLookup).resolves.toMatchObject({ id: TEST_WORKTREE_ID })
    await expect(freshLookup).resolves.toMatchObject({
      id: result.worktree.id,
      path: createdWorktree.path
    })
    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toMatchObject(
      {
        worktrees: expect.arrayContaining([expect.objectContaining({ path: createdWorktree.path })])
      }
    )
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus-101')
  })

  it('retires a generated name before a post-create listing failure', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/nautilus')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/nautilus')
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('listing unavailable'))

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'nautilus',
        nameWasGenerated: true
      })
    ).rejects.toThrow('listing unavailable')

    expect(addWorktree).toHaveBeenCalled()
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus')
  })

  it('retires a generated sparse name when creation rollback also fails', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({ ...store, addRetiredWorktreeName })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/nautilus')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/nautilus')
    vi.mocked(addSparseWorktree).mockRejectedValueOnce(
      Object.assign(new Error('sparse setup failed'), { cleanupFailed: true })
    )

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'nautilus',
        nameWasGenerated: true,
        sparseCheckout: { directories: ['packages/web'] }
      })
    ).rejects.toThrow('sparse setup failed')

    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus')
  })

  it('neither skips nor retires a name the user typed', async () => {
    // Why: the pool contains ordinary words. Retirement only ever applies to generated names.
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: ['nautilus'] })
    })
    const createdWorktree = {
      path: '/tmp/workspaces/nautilus',
      head: 'def',
      branch: 'nautilus',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    // Not `...Once`: the shared beforeEach re-stubs the resolved value but cannot drain a queue,
    // so leftover one-shots would poison later tests in this file.
    vi.mocked(listWorktrees).mockResolvedValue([...MOCK_GIT_WORKTREES, createdWorktree])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus'
    })

    expect(result.worktree.path).toBe(createdWorktree.path)
    expect(addRetiredWorktreeName).not.toHaveBeenCalled()
  })

  it('creates additional workspace metadata for folder-mode repos through runtime create', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'Folder',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const,
      // removeManagedWorktree executes inside this selected runtime, where PTYs are local ids.
      executionHostId: 'runtime:env-1' as const
    }
    const rootWorktreeId = 'folder-repo::/workspace/folder'
    const rootPriorWorktreeIds = ['folder-repo::/workspace/old-folder']
    const metaById: Record<string, WorktreeMeta> = {
      [rootWorktreeId]: makeWorktreeMeta({
        instanceId: 'root-instance',
        priorWorktreeIds: rootPriorWorktreeIds
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string) => {
        delete metaById[worktreeId]
      }
    }
    let deletedWorktreeId = ''
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${deletedWorktreeId}@@pty-1` }]),
      shutdown: vi.fn(async () => undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_folder_startup',
      tabId: 'tab-folder-startup',
      worktreeId: '',
      title: null,
      surface: 'background'
    })
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:folder-repo',
      name: 'folder-session',
      createdWithAgent: 'codex',
      startup: { command: 'codex', viewMode: 'chat' }
    })

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ command: 'codex', viewMode: 'chat' })
    )
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^folder-repo::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'folder-session',
        isMainWorktree: false,
        createdWithAgent: 'codex'
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({
      instanceId: result.worktree.instanceId,
      displayName: 'folder-session',
      orcaCreationSource: 'runtime',
      createdWithAgent: 'codex'
    })
    await expect(runtime.showManagedWorktree(`id:${result.worktree.id}`)).resolves.toMatchObject({
      id: result.worktree.id,
      repoId: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder-session'
    })
    await expect(runtime.listManagedWorktrees('id:folder-repo')).resolves.toMatchObject({
      totalCount: 2,
      worktrees: [
        expect.objectContaining({
          id: rootWorktreeId,
          isMainWorktree: true,
          priorWorktreeIds: rootPriorWorktreeIds
        }),
        expect.objectContaining({
          id: result.worktree.id,
          isMainWorktree: false
        })
      ]
    })
    await expect(
      runtime.updateManagedWorktreeMeta(`id:${result.worktree.id}`, { comment: 'note' })
    ).resolves.toMatchObject({
      id: result.worktree.id,
      comment: 'note'
    })
    await expect(
      runtime.removeManagedWorktree('id:folder-repo::/workspace/folder')
    ).rejects.toThrow('Cannot delete the project root workspace')
    deletedWorktreeId = result.worktree.id
    await expect(runtime.removeManagedWorktree(`id:${result.worktree.id}`)).resolves.toEqual({})
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${result.worktree.id}@@pty-1`,
      expect.objectContaining({ immediate: true })
    )
    expect(metaById[result.worktree.id]).toBeUndefined()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(result.worktree.id)
    expect(notifier.worktreesChanged).toHaveBeenCalledWith('folder-repo')
  })
})
