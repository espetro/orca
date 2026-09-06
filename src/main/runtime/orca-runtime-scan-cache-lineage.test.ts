/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  deferred,
  getSshGitProviderMock,
  makeWorktreeInfo,
  makeWorktreeMeta,
  resetRuntimeTestMocks,
  store,
  withPlatform
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import { listWorktrees } from '../git/worktree'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('rejects invalid positive limits for bounded list commands', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.getWorktreePs(-1)).rejects.toThrow('invalid_limit')
    await expect(runtime.listManagedWorktrees(undefined, 0)).rejects.toThrow('invalid_limit')
    await expect(runtime.searchRepoRefs('id:repo-1', 'main', -5)).rejects.toThrow('invalid_limit')
  })

  it('returns capped SSH refs for empty runtime repo searches', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
        }
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\0origin/main',
            'refs/remotes/upstream/feature-x\0upstream/feature-x',
            'refs/remotes/upstream/HEAD\0upstream/HEAD',
            'refs/heads/local-only\0local-only'
          ].join('\n'),
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs('id:remote-repo', '', 2)

    expect(result).toEqual({
      refs: ['origin/main', 'upstream/feature-x'],
      refDetails: [
        { refName: 'origin/main', localBranchName: 'main' },
        { refName: 'upstream/feature-x', localBranchName: 'feature-x' }
      ],
      truncated: true
    })
    expect(provider.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--exclude=refs/remotes/**/HEAD',
        '--count=12',
        'refs/heads/**/**',
        'refs/heads/**/**/**',
        'refs/remotes/**/**',
        'refs/remotes/**/**/**'
      ]),
      '/home/user/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(['remote'], '/home/user/repo')
  })

  it('retries runtime SSH ref searches without --exclude for older git hosts', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\n', stderr: '' })
        }
        if (argv.includes('--exclude=refs/remotes/**/HEAD')) {
          return Promise.reject(
            Object.assign(new Error("unknown option `exclude'"), {
              stderr: "error: unknown option `exclude'"
            })
          )
        }
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\0origin/main',
            'refs/remotes/origin/HEAD\0origin/HEAD',
            'refs/remotes/origin/feature-x\0origin/feature-x'
          ].join('\n'),
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs('id:remote-repo', '', 1)
    const repeatedResult = await runtime.searchRepoRefs('id:remote-repo', '', 1)

    expect(result).toEqual({
      refs: ['origin/main'],
      refDetails: [{ refName: 'origin/main', localBranchName: 'main' }],
      truncated: true
    })
    expect(repeatedResult).toEqual(result)
    const forEachRefCalls = provider.exec.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(3)
    expect(forEachRefCalls[0][0]).toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).not.toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).toContain('--count=108')
    expect(forEachRefCalls[2][0]).not.toContain('--exclude=refs/remotes/**/HEAD')
  })

  it('resolves SSH worktrees when manually updating lineage', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo-child',
        head: 'abc',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/home/user/repo-parent',
        head: 'def',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(listSshWorktrees).toHaveBeenCalledWith(remoteRepo.path)
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual'
      })
    )
  })

  it('resolves SSH lineage updates from stored metadata when the scan cache misses', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual'
      })
    )
  })

  it('does not resolve unknown SSH worktree ids from scan-miss fallback', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage: vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toThrow('selector_not_found')
  })

  it('rejects SSH lineage updates when Orca worktree identity is missing', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {}
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const fsProvider = {
      readFile: vi.fn(),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/home/user/repo-child',
          head: 'abc',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: '/home/user/repo-parent',
          head: 'def',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      await expect(
        runtime.updateManagedWorktreeMeta(`id:${childId}`, {
          lineage: { parentWorktree: `id:${parentId}` }
        })
      ).rejects.toThrow('Worktree instance identity was unavailable')
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.createDir).not.toHaveBeenCalled()
    expect(fsProvider.writeFile).not.toHaveBeenCalled()
    expect(setWorktreeLineage).not.toHaveBeenCalled()
  })

  it('rejects local lineage updates when Orca worktree identity is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-lineage-'))
    const repoPath = join(tempRoot, 'repo')
    const childPath = join(tempRoot, 'child')
    const parentPath = join(tempRoot, 'parent')
    const repoId = 'local-repo'
    const childId = `${repoId}::${childPath}`
    const parentId = `${repoId}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {}
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const runtimeStore = {
      ...store,
      getRepo: (id: string) =>
        id === repoId
          ? {
              id: repoId,
              path: repoPath,
              displayName: 'local',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined,
      getRepos: () => [
        {
          id: repoId,
          path: repoPath,
          displayName: 'local',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: childPath,
        head: 'abc',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: parentPath,
        head: 'def',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      await mkdir(childPath, { recursive: true })

      await expect(
        runtime.updateManagedWorktreeMeta(`id:${childId}`, {
          lineage: { parentWorktree: `id:${parentId}` }
        })
      ).rejects.toThrow('Worktree instance identity was unavailable')

      await expect(lstat(join(childPath, '.orca'))).rejects.toThrow()
      await expect(lstat(join(parentPath, '.orca'))).rejects.toThrow()
      expect(setWorktreeLineage).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps workspace lineage in sync when manually reparenting a worktree', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const setWorkspaceLineage = vi.fn((lineage: WorkspaceLineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage,
      setWorkspaceLineage
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

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
    expect(setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        childInstanceId: 'child-instance',
        parentWorkspaceKey: `worktree:${parentId}`,
        parentInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
  })

  it.each([
    {
      boundary: 'repository',
      childRepoId: 'repo-child',
      parentRepoId: 'repo-parent',
      childMeta: {},
      parentMeta: {}
    },
    {
      boundary: 'known host',
      childRepoId: TEST_REPO_ID,
      parentRepoId: TEST_REPO_ID,
      childMeta: { hostId: 'runtime:child-host' as const },
      parentMeta: { hostId: 'runtime:parent-host' as const }
    },
    {
      boundary: 'known project',
      childRepoId: TEST_REPO_ID,
      parentRepoId: TEST_REPO_ID,
      childMeta: { projectId: 'project-child' },
      parentMeta: { projectId: 'project-parent' }
    }
  ])('rejects manual lineage writes across a $boundary boundary', async (scenario) => {
    const repos = [...new Set([scenario.childRepoId, scenario.parentRepoId])].map((id) => ({
      id,
      path: join(tmpdir(), id),
      displayName: id,
      badgeColor: 'blue' as const,
      addedAt: 1
    }))
    const childRepoPath = repos.find((repo) => repo.id === scenario.childRepoId)!.path
    const parentRepoPath = repos.find((repo) => repo.id === scenario.parentRepoId)!.path
    const childPath = join(childRepoPath, 'child')
    const parentPath = join(parentRepoPath, 'parent')
    const childId = `${scenario.childRepoId}::${childPath}`
    const parentId = `${scenario.parentRepoId}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance', ...scenario.childMeta }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance', ...scenario.parentMeta })
    }
    const setWorktreeLineage = vi.fn()
    const setWorkspaceLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage,
      setWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [
      ...(repoPath === childRepoPath ? [makeWorktreeInfo(childPath)] : []),
      ...(repoPath === parentRepoPath ? [makeWorktreeInfo(parentPath)] : [])
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toThrow(
      'Parent worktree must belong to the same repository, execution host, and project.'
    )

    expect(setWorktreeLineage).not.toHaveBeenCalled()
    expect(setWorkspaceLineage).not.toHaveBeenCalled()
  })

  it('clears workspace lineage when manually removing a parent', async () => {
    const childPath = '/tmp/worktree-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const removeWorktreeLineage = vi.fn()
    const removeWorkspaceLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeLineage,
      removeWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { noParent: true }
    })

    expect(removeWorktreeLineage).toHaveBeenCalledWith(childId)
    expect(removeWorkspaceLineage).toHaveBeenCalledWith(`worktree:${childId}`)
  })

  it('strips Orca provenance fields from runtime metadata updates', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
      return metaById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${TEST_WORKTREE_ID}`, {
      comment: 'keep me',
      orcaCreatedAt: 123,
      orcaCreationSource: 'runtime',
      orcaCreationWorkspaceLayout: { path: '/tmp', nestWorkspaces: false }
    })

    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { comment: 'keep me' })
  })

  it('ignores stale instance-mismatched lineage when validating manual cycle repairs', async () => {
    const parentPath = '/tmp/worktree-a'
    const childPath = '/tmp/worktree-b'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'new-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) =>
        worktreeId === parentId
          ? {
              worktreeId: parentId,
              worktreeInstanceId: 'old-parent-instance',
              parentWorktreeId: childId,
              parentWorktreeInstanceId: 'child-instance',
              origin: 'manual' as const,
              capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
              createdAt: 1
            }
          : undefined,
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/a',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/b',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'new-parent-instance'
      })
    )
  })

  it('rejects lineage updates when upgraded metadata is missing a parent instance id', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta(),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage: vi.fn((_worktreeId: string, lineage) => lineage)
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

    await expect(
      runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toThrow('Worktree instance identity was unavailable')

    expect(runtimeStore.setWorktreeLineage).not.toHaveBeenCalled()
  })

  it('rotates a missing parent instance during runtime selector scans before same-path reuse', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'old-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'old-parent-instance',
        origin: 'manual' as const,
        capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage: vi.fn((worktreeId: string) => {
        delete lineageById[worktreeId]
      }),
      setWorktreeLineage
    }
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValue([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.showManagedWorktree(`id:${childId}`)
    const rotatedParentInstance = metaById[parentId].instanceId
    expect(rotatedParentInstance).toBeTruthy()
    expect(rotatedParentInstance).not.toBe('old-parent-instance')
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'rescanned' })
    expect(metaById[parentId].instanceId).toBe(rotatedParentInstance)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'touch' })
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: rotatedParentInstance
      })
    )
  })

  it('does not prune lineage when a runtime local worktree scan fails', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
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
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).rejects.toThrow('selector_not_found')

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('returns a non-authoritative detected list when a runtime local worktree scan fails', async () => {
    const removeWorktreeLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getAllWorktreeLineage: () => ({}),
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toEqual({
      repoId: TEST_REPO_ID,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('revalidates missing worktrees before stopping their local provider sessions', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const survivingId = `${TEST_REPO_ID}::/tmp/surviving`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' },
        { id: `${survivingId}@@surviving-session`, cwd: '/tmp/surviving', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: true,
      source: 'git',
      worktrees: [{ id: survivingId }] as never
    })

    const result = await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      deletedId,
      survivingId
    ])

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalledWith(
      `${survivingId}@@surviving-session`,
      expect.anything()
    )
  })

  // Why (#10562): the renderer purges its state regardless of the sweep result, so
  // revalidating against a cached scan (30s TTL) that still lists an already-deleted
  // directory would strand those PTYs permanently — nothing asks a second time.
  it('revalidates against a fresh scan instead of a warm worktree-scan cache', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })

    // Warm the scan cache while the worktree still exists.
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/deleted', head: 'abc', branch: 'd', isBare: false, isMainWorktree: false }
    ])
    await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [deletedId])
    expect(localProvider.shutdown).not.toHaveBeenCalled()

    // The worktree is now gone; the cached scan must not mask that.
    vi.mocked(listWorktrees).mockResolvedValue([])
    const result = await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      deletedId
    ])

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
  })

  it('does not stop sessions after a non-authoritative revalidation', async () => {
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })

    await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      `${TEST_REPO_ID}::/tmp/deleted`
    ])

    expect(localProvider.listProcesses).not.toHaveBeenCalled()
  })

  // Why: an explicit connection identity only narrows the selector, it must not
  // change the grammar. Treating the selector as a bare repo id made every
  // `path:`/`name:` selector fail repo_not_found on this path alone.
  it('resolves non-id selectors when a connection identity is supplied', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const localRepo = store.getRepos()[0]
    const runtime = new OrcaRuntimeService(
      { ...store, getRepos: () => [localRepo, { ...localRepo, connectionId: 'ssh-1' }] } as never,
      undefined,
      { getLocalProvider: () => localProvider as never }
    )
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: true,
      source: 'git',
      worktrees: []
    })

    // `path:` is ambiguous across the two rows; connectionId null selects the local one.
    const result = await runtime.teardownMissingManagedWorktreeTerminals(
      `path:${localRepo.path}`,
      [deletedId],
      null
    )

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
  })

  it('uses the connection-scoped repo when local and SSH repo ids collide', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const sshProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@ssh-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const localRepo = store.getRepos()[0]
    const sshRepo = { ...localRepo, connectionId: 'ssh-1' }
    const runtime = new OrcaRuntimeService(
      {
        ...store,
        getRepos: () => [localRepo, sshRepo]
      } as never,
      undefined,
      {
        getLocalProvider: () => localProvider as never,
        getSshProvider: (connectionId) =>
          connectionId === 'ssh-1' ? (sshProvider as never) : undefined
      }
    )
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: true,
      source: 'git',
      worktrees: []
    })

    await runtime.teardownMissingManagedWorktreeTerminals(TEST_REPO_ID, [deletedId], 'ssh-1')

    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@ssh-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
  })

  it('hydrates runtime detected lists with instance-validated legacy lineage', async () => {
    const parentPath = join(tmpdir(), 'worktree-parent')
    const childPath = join(tmpdir(), 'worktree-child')
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
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
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getAllWorktreeLineage: () => lineageById
    } as never)
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktreeInfo(childPath),
      makeWorktreeInfo(parentPath)
    ])

    const result = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(result.worktrees).toEqual([
      expect.objectContaining({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({ parentWorktreeInstanceId: 'parent-instance' })
      }),
      expect.objectContaining({
        id: parentId,
        parentWorktreeId: null,
        childWorktreeIds: [childId],
        lineage: null
      })
    ])
  })

  it('hydrates folder-repo detected rows with instance-validated legacy lineage', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: 'blue' as const,
      addedAt: 1,
      kind: 'folder' as const
    }
    const parentId = `${folderRepo.id}::${folderRepo.path}`
    const childId = `${parentId}::workspace:child-instance`
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
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    } as never)

    const result = await runtime.listDetectedManagedWorktrees(`id:${folderRepo.id}`)

    expect(result.worktrees).toEqual([
      expect.objectContaining({
        id: parentId,
        parentWorktreeId: null,
        childWorktreeIds: [childId],
        lineage: null
      }),
      expect.objectContaining({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({ parentWorktreeInstanceId: 'parent-instance' })
      })
    ])
  })

  it('keeps colliding folder workspace metadata scoped to its owning host', async () => {
    const localRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'local-folder',
      badgeColor: 'blue' as const,
      addedAt: 1,
      kind: 'folder' as const
    }
    const remoteRepo = {
      ...localRepo,
      displayName: 'remote-folder',
      connectionId: 'ssh-1'
    }
    const rootId = `${localRepo.id}::${localRepo.path}`
    const childId = `${rootId}::workspace:local-child`
    const metaById: Record<string, WorktreeMeta> = {
      [rootId]: makeWorktreeMeta({
        hostId: 'local',
        displayName: 'local-root-name',
        comment: 'local-only-comment',
        isPinned: true
      }),
      [childId]: makeWorktreeMeta({
        hostId: 'local',
        instanceId: 'local-child',
        displayName: 'local-child-name'
      })
    }
    const setWorktreeMeta = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)

    const result = await runtime.listDetectedManagedWorktrees(`id:${remoteRepo.id}`, 'ssh-1')

    expect(result.worktrees).toEqual([
      expect.objectContaining({
        id: rootId,
        hostId: 'ssh:ssh-1',
        displayName: 'remote-folder',
        comment: '',
        isPinned: false
      })
    ])
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('hides agent scratch created inside a linked checkout from runtime listings', async () => {
    const linkedCheckoutPath = '/tmp/worktree-a'
    const scratchPath = `${linkedCheckoutPath}/.claude/worktrees/agent-a04ccaaa`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktreeInfo(TEST_REPO_PATH),
      makeWorktreeInfo(linkedCheckoutPath),
      makeWorktreeInfo(scratchPath)
    ])
    const runtime = createRuntime()

    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const listed = await runtime.listManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(detected.worktrees.find((worktree) => worktree.path === scratchPath)).toMatchObject({
      ownership: 'agent-scratch',
      visible: false
    })
    expect(listed.worktrees.map((worktree) => worktree.path)).toEqual([
      TEST_REPO_PATH,
      linkedCheckoutPath
    ])
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('bounds repeated detected worktree scans across the reported 15-repo shape', async () => {
    vi.mocked(listWorktrees).mockReset()
    const repos = Array.from({ length: 15 }, (_, index) => ({
      id: `repo-${index + 1}`,
      path: `/tmp/repo-${index + 1}`,
      displayName: `repo-${index + 1}`,
      badgeColor: 'blue' as const,
      addedAt: 1
    }))
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    } as never)
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [
      {
        path: `${repoPath}/main`,
        head: repoPath,
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const poll = async () =>
      Promise.all(repos.map((repo) => runtime.listDetectedManagedWorktrees(`id:${repo.id}`)))
    const first = await poll()
    expect(listWorktrees).toHaveBeenCalledTimes(15)
    const second = await poll()

    expect(first.flatMap((result) => result.worktrees)).toHaveLength(15)
    expect(second.flatMap((result) => result.worktrees)).toHaveLength(15)
    expect(second.flatMap((result) => result.worktrees).map((worktree) => worktree.path)).toEqual(
      repos.map((repo) => `${repo.path}/main`)
    )
    expect(listWorktrees).toHaveBeenCalledTimes(15)
  })

  it('worktree scan cache: shares one in-flight repo scan across concurrent consumers', async () => {
    vi.mocked(listWorktrees).mockClear()
    const pending = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    vi.mocked(listWorktrees).mockReturnValueOnce(pending.promise)
    const runtime = createRuntime()

    const detected = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    const resolved = runtime.listManagedWorktrees()
    await Promise.resolve()
    expect(listWorktrees).toHaveBeenCalledTimes(1)

    pending.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
    await expect(Promise.all([detected, resolved])).resolves.toBeTruthy()
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('worktree scan cache: keeps colliding local and SSH owners warm independently', async () => {
    vi.mocked(listWorktrees).mockClear()
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, path: '/remote/repo', connectionId: 'ssh-1' }
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([makeWorktreeInfo('/remote/worktree')])
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [localRepo, remoteRepo]
    } as never)
    vi.mocked(listWorktrees).mockResolvedValue([makeWorktreeInfo(TEST_WORKTREE_PATH)])

    try {
      await runtime.listManagedWorktrees()
      runtime.notifyWorktreesChangedForRemoteClients(TEST_REPO_ID)
      await runtime.listManagedWorktrees()

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(provider.listWorktrees).toHaveBeenCalledTimes(1)

      unregisterSshGitProvider('ssh-1')
      const replacementProvider = {
        listWorktrees: vi.fn().mockResolvedValue([makeWorktreeInfo('/remote/replacement')])
      }
      registerSshGitProvider('ssh-1', replacementProvider as never)
      runtime.notifyWorktreesChangedForRemoteClients(TEST_REPO_ID)
      await runtime.listManagedWorktrees()

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(replacementProvider.listWorktrees).toHaveBeenCalledTimes(1)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('keeps detected metadata scoped to the selected colliding host', async () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, path: '/remote/repo', connectionId: 'ssh-1' }
    const worktreePath = '/same/worktree'
    const worktreeId = `${TEST_REPO_ID}::${worktreePath}`
    const localMeta = makeWorktreeMeta({
      hostId: 'local',
      displayName: 'local-only-name',
      comment: 'local-only-comment',
      isPinned: true
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
      getAllWorktreeMeta: () => ({ [worktreeId]: localMeta }),
      getWorktreeMeta: (id: string) => (id === worktreeId ? localMeta : undefined)
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue([makeWorktreeInfo(worktreePath)]) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`, 'ssh-1')

      expect(result.worktrees).toEqual([
        expect.objectContaining({
          id: worktreeId,
          hostId: 'ssh:ssh-1',
          comment: '',
          isPinned: false
        })
      ])
      expect(result.worktrees[0]?.displayName).not.toBe('local-only-name')
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('does not project one colliding host lineage onto another host rows', async () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, connectionId: 'ssh-1' }
    const parentPath = '/same/parent'
    const childPath = '/same/child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ hostId: 'ssh:ssh-1', instanceId: 'remote-parent' }),
      [childId]: makeWorktreeMeta({ hostId: 'ssh:ssh-1', instanceId: 'remote-child' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'remote-child',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'remote-parent',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      getAllWorktreeLineage: () => lineageById
    }
    const rows = [makeWorktreeInfo(childPath), makeWorktreeInfo(parentPath)]
    vi.mocked(listWorktrees).mockResolvedValue(rows)
    const provider = { listWorktrees: vi.fn().mockResolvedValue(rows) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const resolved = await (
        runtime as unknown as { listResolvedWorktrees: () => Promise<Worktree[]> }
      ).listResolvedWorktrees()
      const localChild = resolved.find(
        (worktree) => worktree.id === childId && worktree.hostId === 'local'
      )
      const remoteChild = resolved.find(
        (worktree) => worktree.id === childId && worktree.hostId === 'ssh:ssh-1'
      )

      expect(localChild).toMatchObject({ parentWorktreeId: null, lineage: null })
      expect(remoteChild).toMatchObject({ parentWorktreeId: parentId })
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: rescans immediately after worktree invalidation', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = createRuntime()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    runtime.notifyBranchRenamed(TEST_REPO_ID)
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })

  it('worktree scan cache: repo invalidation preserves sibling raw scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const repos = [
      { ...store.getRepos()[0], id: 'repo-a', path: '/tmp/repo-a' },
      { ...store.getRepos()[0], id: 'repo-b', path: '/tmp/repo-b' }
    ]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    } as never)
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [makeWorktreeInfo(repoPath)])

    await runtime.listDetectedManagedWorktrees('id:repo-a')
    await runtime.listDetectedManagedWorktrees('id:repo-b')
    runtime.notifyBranchRenamed('repo-a')
    await runtime.listDetectedManagedWorktrees('id:repo-b')
    await runtime.listDetectedManagedWorktrees('id:repo-a')

    expect(listWorktrees).toHaveBeenCalledTimes(3)
    expect(listWorktrees).toHaveBeenNthCalledWith(3, '/tmp/repo-a')
  })

  it('worktree scan cache: metadata invalidation preserves raw scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = createRuntime()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    runtime.notifyWorktreesChangedForRemoteClients(TEST_REPO_ID)
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  // #11994: the host renderer already applied its own repos:changed, so re-notifying it
  // would re-sort the sidebar; only the client-event stream may fire here.
  it('notifyReposChangedForRemoteClients emits to clients without re-notifying the host', () => {
    const runtime = createRuntime()
    const reposChanged = vi.fn()
    runtime.setNotifier({ reposChanged } as never)
    const events: { type: string }[] = []
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    runtime.notifyReposChangedForRemoteClients()
    unsubscribe()

    expect(events).toEqual([{ type: 'reposChanged' }])
    expect(reposChanged).not.toHaveBeenCalled()
  })

  it('persists changed worktree order once and emits targeted invalidations', () => {
    const firstId = `${TEST_REPO_ID}::/tmp/first`
    const secondId = `${TEST_REPO_ID}::/tmp/second`
    const metaById: Record<string, Partial<WorktreeMeta>> = {
      [firstId]: { sortOrder: 200 },
      [secondId]: { sortOrder: 100 }
    }
    const setWorktreeMeta = vi.fn((id: string, updates: Partial<WorktreeMeta>) => {
      metaById[id] = { ...metaById[id], ...updates }
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorktreeMeta: (id: string) => metaById[id],
      setWorktreeMeta
    } as never)
    const events: { type: string; repoId?: string }[] = []
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    expect(runtime.persistManagedWorktreeSortOrder([firstId, secondId])).toEqual({ updated: 0 })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(events).toEqual([])

    expect(runtime.persistManagedWorktreeSortOrder([secondId, firstId])).toEqual({ updated: 2 })
    unsubscribe()

    expect(setWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ type: 'worktreesChanged', repoId: TEST_REPO_ID }])
  })

  it('worktree scan cache: folder metadata invalidation preserves raw scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const runtime = createRuntime()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    runtime.notifyFolderWorkspaceChanged()
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('worktree scan cache: expires scans per repo without coupling sibling repos', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.useFakeTimers({ now: 0 })
    try {
      const repos = [
        { ...store.getRepos()[0], id: 'repo-a', path: '/tmp/repo-a' },
        { ...store.getRepos()[0], id: 'repo-b', path: '/tmp/repo-b' }
      ]
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => repos,
        getRepo: (id: string) => repos.find((repo) => repo.id === id)
      } as never)
      vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [makeWorktreeInfo(repoPath)])

      await runtime.listDetectedManagedWorktrees('id:repo-a')
      await vi.advanceTimersByTimeAsync(10_000)
      await runtime.listDetectedManagedWorktrees('id:repo-b')
      await vi.advanceTimersByTimeAsync(20_000)
      await runtime.listDetectedManagedWorktrees('id:repo-a')
      await runtime.listDetectedManagedWorktrees('id:repo-b')

      expect(listWorktrees).toHaveBeenCalledTimes(3)
      expect(listWorktrees).toHaveBeenNthCalledWith(3, '/tmp/repo-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('worktree scan cache: does not cache non-authoritative SSH scan failures', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo]
    }
    const provider = { listWorktrees: vi.fn() }
    provider.listWorktrees
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockResolvedValueOnce([makeWorktreeInfo(TEST_WORKTREE_PATH)])
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: false })
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: true })
      expect(provider.listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: invalidates when SSH availability changes', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo]
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: true })
      unregisterSshGitProvider('ssh-1')
      await expect(
        runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      ).resolves.toMatchObject({ authoritative: false })
      expect(provider.listWorktrees).toHaveBeenCalledTimes(1)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: SSH state changes do not evict local repo scans', async () => {
    vi.mocked(listWorktrees).mockClear()
    const localRepo = { ...store.getRepo(TEST_REPO_ID)!, id: 'local-repo' }
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, id: 'remote-repo', connectionId: 'ssh-1' }
    const repos = [localRepo, remoteRepo]
    const remoteStore = {
      ...store,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getRepos: () => repos
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES) }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.listDetectedManagedWorktrees('id:local-repo')
      await runtime.listDetectedManagedWorktrees('id:remote-repo')
      runtime.notifySshStateChanged('ssh-1', {
        targetId: 'ssh-1',
        status: 'disconnected',
        error: null,
        reconnectAttempt: 0
      })
      await runtime.listDetectedManagedWorktrees('id:local-repo')
      await runtime.listDetectedManagedWorktrees('id:remote-repo')

      expect(listWorktrees).toHaveBeenCalledTimes(1)
      expect(provider.listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('worktree scan cache: SSH state changes invalidate empty resolved snapshots', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-empty' }
    const remoteStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo]
    }
    const provider = { listWorktrees: vi.fn().mockResolvedValue([]) }
    registerSshGitProvider('ssh-empty', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.listManagedWorktrees()).resolves.toMatchObject({ totalCount: 0 })
      runtime.notifySshStateChanged('ssh-empty', {
        targetId: 'ssh-empty',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      await expect(runtime.listManagedWorktrees()).resolves.toMatchObject({ totalCount: 0 })
      expect(provider.listWorktrees).toHaveBeenCalledTimes(2)
    } finally {
      unregisterSshGitProvider('ssh-empty')
    }
  })

  it('worktree scan cache: SSH state changes for unknown targets keep local snapshots in flight', async () => {
    vi.mocked(listWorktrees).mockClear()
    const pending = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    vi.mocked(listWorktrees).mockReturnValueOnce(pending.promise)
    const runtime = new OrcaRuntimeService(store)

    const first = runtime.listManagedWorktrees()
    await Promise.resolve()
    runtime.notifySshStateChanged('ssh-unknown', {
      targetId: 'ssh-unknown',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })
    pending.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
    await expect(first).resolves.toMatchObject({ totalCount: 1 })
    await expect(runtime.listManagedWorktrees()).resolves.toMatchObject({ totalCount: 1 })

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('worktree scan cache: separates local project runtime changes', async () => {
    vi.mocked(listWorktrees).mockClear()
    let runtimeDefault: unknown = { kind: 'windows-host' }
    const runtimeStore = {
      ...store,
      getProjects: () => [{ id: 'project-1', sourceRepoIds: [TEST_REPO_ID] }],
      getSettings: () => ({ ...store.getSettings(), localWindowsRuntimeDefault: runtimeDefault })
    }

    await withPlatform('win32', async () => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      runtimeDefault = { kind: 'wsl', distro: 'Ubuntu' }
      await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    })

    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })

  it('worktree scan cache: ignores a late result from an older runtime key', async () => {
    vi.mocked(listWorktrees).mockClear()
    let runtimeDefault: unknown = { kind: 'windows-host' }
    const runtimeStore = {
      ...store,
      getProjects: () => [{ id: 'project-1', sourceRepoIds: [TEST_REPO_ID] }],
      getSettings: () => ({ ...store.getSettings(), localWindowsRuntimeDefault: runtimeDefault })
    }
    const firstScan = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    const secondScan = deferred<ReturnType<typeof makeWorktreeInfo>[]>()
    vi.mocked(listWorktrees)
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(secondScan.promise)

    await withPlatform('win32', async () => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const first = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      await Promise.resolve()
      expect(listWorktrees).toHaveBeenCalledTimes(1)

      runtimeDefault = { kind: 'wsl', distro: 'Ubuntu' }
      const second = runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
      await Promise.resolve()
      expect(listWorktrees).toHaveBeenCalledTimes(2)

      secondScan.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
      await second
      firstScan.resolve([makeWorktreeInfo(TEST_WORKTREE_PATH)])
      await first
      await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    })

    expect(listWorktrees).toHaveBeenCalledTimes(2)
  })
})
