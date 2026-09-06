/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  ORIGINAL_PLATFORM,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  closeLocalWatcherForWorktreePathMock,
  closeRemoteWatcherForWorktreePathMock,
  computeWorktreePathMock,
  createRuntime,
  createStaleRuntimeWorktreeStore,
  deferred,
  deleteWorktreeHistoryDirMock,
  ensurePathWithinWorkspaceMock,
  findExistingWorktreeSymlinkPathsMock,
  forceDeleteLocalBranchMock,
  forgetLocalWatcherRemovalSnapshotMock,
  forgetRemoteWatcherRemovalSnapshotMock,
  getPRForBranchMock,
  invalidateAuthorizedRootsCacheMock,
  makeWorktreeMeta,
  removeWorktreeLinkedPathsMock,
  resetRuntimeTestMocks,
  restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemoteWatcherAfterFailedRemovalMock,
  setPlatform,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getBranchConflictKind } from '../git/repo'
import {
  addWorktree,
  assertWorktreeCleanForRemoval,
  listWorktrees,
  listWorktreesStrict,
  removeWorktree
} from '../git/worktree'
import { getEffectiveHooks, loadHooks, runHook } from '../hooks'
import { WATCHER_REMOVAL_DRAIN_BUDGET_MS } from '../ipc/watcher-removal-drain'
import { beginWatcherInstall } from '../ipc/watcher-removal-gate'
import {
  registerPty as registerLocalPtyMemoryRow,
  unregisterPty as unregisterLocalPtyMemoryRow
} from '../memory/pty-registry'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gitRunner from '../git/runner'
import * as localWorktreeFilesystem from '../local-worktree-filesystem'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('creates the first terminal by id when duplicate repo entries expose the same path', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-duplicate-path' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-duplicate-path' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    const duplicatePath = '/tmp/workspaces/runtime-duplicate-terminal'
    const getRepos = vi.spyOn(store, 'getRepos').mockReturnValue([
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-duplicate-entry',
        path: '/tmp/repo-secondary-worktree',
        displayName: 'repo-secondary-worktree',
        badgeColor: 'red',
        addedAt: 2
      }
    ])
    computeWorktreePathMock.mockReturnValue(duplicatePath)
    ensurePathWithinWorkspaceMock.mockReturnValue(duplicatePath)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: duplicatePath,
        head: 'def',
        branch: 'runtime-duplicate-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'runtime-duplicate-terminal'
      })

      expect(result.warning).toBeUndefined()
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: duplicatePath,
          worktreeId: result.worktree.id
        })
      )
    } finally {
      getRepos.mockRestore()
    }
  })

  it('resolves an exact path selector when duplicate repo entries expose the same path', async () => {
    const runtime = new OrcaRuntimeService(store)
    const duplicatePath = '/tmp/workspaces/runtime-duplicate-selector'
    const getRepos = vi.spyOn(store, 'getRepos').mockReturnValue([
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-duplicate-entry',
        path: '/tmp/repo-secondary-worktree',
        displayName: 'repo-secondary-worktree',
        badgeColor: 'red',
        addedAt: 2
      }
    ])
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: duplicatePath,
        head: 'def',
        branch: 'runtime-duplicate-selector',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      const worktree = await runtime.showManagedWorktree(`path:${duplicatePath}`)

      expect(worktree.id).toBe(`${TEST_REPO_ID}::${duplicatePath}`)
      expect(worktree.path).toBe(duplicatePath)
    } finally {
      getRepos.mockRestore()
    }
  })

  it('keeps CLI-created worktrees successful when initial terminal creation fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockRejectedValue(new Error('pty unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-terminal-fail',
        head: 'def',
        branch: 'runtime-terminal-fail',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'runtime-terminal-fail'
        })
      ).resolves.toMatchObject({
        worktree: expect.objectContaining({
          path: '/tmp/workspaces/runtime-terminal-fail'
        }),
        warning:
          'Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      })
      expect(spawn).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[worktree-create] Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('activates CLI-created worktrees only when explicitly requested', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-activate',
        head: 'def',
        branch: 'runtime-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activate',
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      undefined,
      undefined,
      undefined
    )
  })

  it('stamps createdAt alongside lastActivityAt so CLI-created worktrees get the Recent-sort grace window', async () => {
    // Why: without createdAt, ambient PTY bumps in other worktrees can push the new one below them in Recent sort.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: {} })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-grace',
        head: 'def',
        branch: 'runtime-grace',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const before = Date.now()
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-grace'
    })
    const after = Date.now()

    expect(result.worktree.createdAt).toBeDefined()
    expect(result.worktree.createdAt).toBeGreaterThanOrEqual(before)
    expect(result.worktree.createdAt).toBeLessThanOrEqual(after)
    // Both fields must share the same now so grace-window math (max(lastActivityAt, createdAt + GRACE_MS)) is well-defined.
    expect(result.worktree.createdAt).toBe(result.worktree.lastActivityAt)
  })

  it('routes runtime worktree creation through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
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
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const createdWorktree = {
      path: '/tmp/workspaces/runtime-wsl',
      head: 'def',
      branch: 'refs/heads/runtime-wsl',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees).mockResolvedValue([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/runtime-wsl^{commit}')) {
        throw new Error('missing local branch')
      }
      if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') {
        return { stdout: `${TEST_REPO_PATH}/.git\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'runtime-wsl',
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/runtime-wsl',
          remoteUrl: 'git@github.com:contributor/orca.git'
        }
      })

      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/runtime-wsl'
      })
      expect(gitSpy).toHaveBeenCalledWith(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
        cwd: TEST_REPO_PATH,
        timeout: 15_000,
        wslDistro: 'Ubuntu'
      })
      expect(getBranchConflictKind).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'runtime-wsl',
        'origin/main',
        { wslDistro: 'Ubuntu' }
      )
      expect(getPRForBranchMock).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'runtime-wsl',
        null,
        null,
        null,
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'runtime-wsl',
        'origin/main',
        false,
        false,
        {
          remoteTrackingBase: {
            base: 'origin/main',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            remote: 'origin'
          },
          suggestLocalBaseRefUpdate: true,
          wslDistro: 'Ubuntu'
        }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['check-ref-format', '--branch', 'contributor/runtime-wsl'],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          'pr-contributor-orca',
          '+refs/heads/contributor/runtime-wsl:refs/remotes/pr-contributor-orca/contributor/runtime-wsl'
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'branch',
          '--set-upstream-to',
          'pr-contributor-orca/contributor/runtime-wsl',
          'runtime-wsl'
        ],
        { cwd: createdWorktree.path, wslDistro: 'Ubuntu' }
      )
      expect(listWorktrees).toHaveBeenCalledWith(TEST_REPO_PATH, { wslDistro: 'Ubuntu' })
    } finally {
      gitSpy.mockRestore()
    }
  })

  function createWorktreeRemovalRuntime(runtimeStore: unknown = store): OrcaRuntimeService {
    const emptyPtyProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    return new OrcaRuntimeService(runtimeStore as never, undefined, {
      getLocalProvider: () => emptyPtyProvider as never,
      getSshProvider: () => emptyPtyProvider as never
    })
  }

  it('skips archive hooks for CLI worktree removal by default', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      TEST_WORKTREE_PATH,
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({ path: TEST_WORKTREE_PATH })
      })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
    )
  })

  it('passes project shared links through the runtime removal preflight and cleanup', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(loadHooks).mockReturnValue({
      scripts: {},
      worktree: { sharedDirectories: ['node_modules'] }
    })
    findExistingWorktreeSymlinkPathsMock.mockResolvedValue(['node_modules'])
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(findExistingWorktreeSymlinkPathsMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH, [
      'node_modules'
    ])
    expect(assertWorktreeCleanForRemoval).toHaveBeenCalledWith(TEST_WORKTREE_PATH, false, {
      ignoredUntrackedPaths: ['node_modules']
    })
    expect(removeWorktreeLinkedPathsMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH, ['node_modules'])
  })

  it('forgets exact-id orphan metadata when the parent repo is already gone', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const runtime = createWorktreeRemovalRuntime(orphanStore)

    // Nothing left the disk, so non-desktop callers must be able to tell "forgotten" from "deleted".
    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({
      warning: expect.stringContaining(TEST_WORKTREE_PATH)
    })

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'runtime:env-1')
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
    // Nothing is deleted on disk here, so the surviving directory's watchers must still be released.
    expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
      TEST_WORKTREE_PATH,
      expect.objectContaining({ remainingMs: expect.any(Function) })
    )
    // Regression: the directory survives, so its watchers must be restored rather than forgotten.
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
  })

  it('scopes a runtime-host orphan PTY sweep to its environment, not the local host', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${TEST_WORKTREE_ID}@@1` }]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'local-pty-1')
    runtime.registerPty('local-pty-1', TEST_WORKTREE_ID)
    registerLocalPtyMemoryRow({
      ptyId: 'local-pty-1',
      worktreeId: TEST_WORKTREE_ID,
      sessionId: null,
      paneKey: null,
      pid: null
    })

    try {
      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    } finally {
      unregisterLocalPtyMemoryRow('local-pty-1')
    }

    // Regression: `repoId::path` collides across hosts, so a runtime-owned orphan
    // must never kill the live PTYs of a same-id LOCAL workspace.
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('fails closed before teardown when a qualified target loses its host owner', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'local'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${TEST_WORKTREE_ID}@@1` }]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'local-pty-1')
    runtime.registerPty('local-pty-1', TEST_WORKTREE_ID)
    const internals = runtime as unknown as {
      resolveWorktreeRemovalTarget: () => Promise<{
        id: string
        repoId: string
        path: string
      }>
    }
    internals.resolveWorktreeRemovalTarget = vi.fn().mockResolvedValue({
      id: TEST_WORKTREE_ID,
      repoId: TEST_REPO_ID,
      path: TEST_WORKTREE_PATH
    })

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, false, false, 'runtime:env-b')
    ).rejects.toThrow('no longer belongs to runtime:env-b')

    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(removeWorktreeMeta).not.toHaveBeenCalled()
    expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
  })

  it('still sweeps the local host for an ownerless orphan', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'local-pty-1')
    runtime.registerPty('local-pty-1', TEST_WORKTREE_ID)

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(localProvider.listProcesses).toHaveBeenCalled()
    expect(stopAndWait).toHaveBeenCalledWith('local-pty-1', expect.anything())
  })

  it('restores rather than forgets watchers for the orphan directory that survives', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const runtime = createWorktreeRemovalRuntime(orphanStore)

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    // Regression: the gate must finish(false) — forgetting watchers would silently deafen a
    // folder workspace or File Explorer pane rooted at this still-present directory.
    expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
      TEST_WORKTREE_PATH,
      expect.objectContaining({ remainingMs: expect.any(Function) })
    )
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('warns that a missing-repo removal only forgot the workspace', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const runtime = createWorktreeRemovalRuntime(orphanStore)

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    // Regression: CLI and mobile share this method, so success alone must not read as "deleted".
    expect(result.warning).toEqual(expect.stringContaining(TEST_WORKTREE_PATH))
    expect(result.warning).toEqual(expect.stringContaining(TEST_REPO_ID))
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('sweeps an orphaned SSH worktree through its host provider', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'ssh:ssh-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const sshProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const getSshProvider = vi.fn(() => sshProvider as never)
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never,
      getSshProvider
    })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({
      warning: expect.stringContaining(TEST_WORKTREE_PATH)
    })

    expect(getSshProvider).toHaveBeenCalledWith('ssh-1')
    expect(sshProvider.listProcesses).toHaveBeenCalled()
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(closeRemoteWatcherForWorktreePathMock).toHaveBeenCalledWith('ssh-1', TEST_WORKTREE_PATH)
    // The remote directory survives, so its watchers are restored, not forgotten.
    expect(restoreRemoteWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(
      'ssh-1',
      TEST_WORKTREE_PATH
    )
    expect(forgetRemoteWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
  })

  it('does not remove a runtime worktree when watcher teardown cannot release it', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = { ...store, getRepos: () => [repo], getRepo: () => repo }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    deleteWorktreeHistoryDirMock.mockClear()
    closeLocalWatcherForWorktreePathMock.mockRejectedValue(
      new Error('file watcher process did not exit after termination deadline')
    )

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      'file watcher process did not exit after termination deadline'
    )

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('stops worktree PTYs before removing linked paths', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = { ...store, getRepos: () => [repo], getRepo: () => repo }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(removeWorktree).mockResolvedValue({})
    removeWorktreeLinkedPathsMock.mockImplementationOnce(async () => {
      // Destructive teardown must bound the underlying RPCs below the sweep deadline.
      expect(stopAndWait).toHaveBeenCalledWith(
        'pty-1',
        expect.objectContaining({ deadlineMs: expect.any(Number) })
      )
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(removeWorktreeLinkedPathsMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH, ['node_modules'])
  })

  it('waits for every watcher layer to settle before restoring after teardown failure', async () => {
    const runtime = createRuntime()
    let finishRuntimeClose: () => void = () => {}
    const runtimeClose = new Promise<void>((resolve) => {
      finishRuntimeClose = resolve
    })
    const fileCommands = (
      runtime as unknown as {
        fileCommands: {
          closeFileExplorerWatchersForPath: (path: string) => Promise<void>
          restoreFileExplorerWatchersAfterFailedRemoval: (path: string) => Promise<void>
        }
      }
    ).fileCommands
    vi.spyOn(fileCommands, 'closeFileExplorerWatchersForPath').mockReturnValueOnce(runtimeClose)
    const restoreRuntime = vi
      .spyOn(fileCommands, 'restoreFileExplorerWatchersAfterFailedRemoval')
      .mockResolvedValue(undefined)
    closeLocalWatcherForWorktreePathMock.mockRejectedValueOnce(
      new Error('desktop watcher close failed')
    )

    const result = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH).catch((error) => error)
    await Promise.resolve()
    expect(restoreLocalWatcherAfterFailedRemovalMock).not.toHaveBeenCalled()
    expect(restoreRuntime).not.toHaveBeenCalled()

    finishRuntimeClose()
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        message: 'desktop watcher close failed'
      })
    )
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(restoreRuntime).toHaveBeenCalledWith(TEST_WORKTREE_PATH, undefined)
  })

  it('restores runtime watchers when CLI worktree deletion fails after teardown', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockRejectedValue(new Error('delete failed'))

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow('delete failed')

    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
    const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
    finishRetry()
  })

  it('closes before and after draining a pre-removal watcher install', async () => {
    const runtime = createRuntime()
    const finishInstall = beginWatcherInstall(TEST_WORKTREE_PATH)

    const acquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH)
    await vi.waitFor(() => expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledTimes(1))
    expect(() => beginWatcherInstall(TEST_WORKTREE_PATH)).toThrow(
      'cannot start while the worktree is being removed'
    )

    finishInstall()
    const gate = await acquiring
    expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledTimes(2)
    await gate.finish(false)
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)

    const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
    finishRetry()
  })

  it('proceeds when a wedged install never releases the removal fence', async () => {
    vi.useFakeTimers()
    // Held across the whole acquire and never released — models a native subscribe that ignores abort
    // and never settles. The removal must abandon the fence slot rather than leak it into later suites.
    beginWatcherInstall(TEST_WORKTREE_PATH)
    try {
      const runtime = createRuntime()

      let acquired = false
      const acquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH).then((gate) => {
        acquired = true
        return gate
      })
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS - 1)
      expect(acquired).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const gate = await acquiring
      expect(acquired).toBe(true)
      expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledTimes(2)

      // The fence must not stay armed: releasing the gate re-admits installs under this root.
      await gate.finish(true)
      const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
      finishRetry()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-spend the drain budget on a removal after a wedged install was abandoned', async () => {
    vi.useFakeTimers()
    beginWatcherInstall(TEST_WORKTREE_PATH)
    try {
      const runtime = createRuntime()

      const firstAcquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH)
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS)
      await (await firstAcquiring).finish(true)

      let secondAcquired = false
      const secondAcquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH).then((gate) => {
        secondAcquired = true
        return gate
      })
      await vi.advanceTimersByTimeAsync(1)

      expect(secondAcquired).toBe(true)
      await (await secondAcquiring).finish(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers forced Windows runtime long-path removal and keeps skipped-hook warnings', async () => {
    setPlatform('win32')
    const runtime = createWorktreeRemovalRuntime()
    await mkdir(TEST_WORKTREE_PATH, { recursive: true })
    await writeFile(join(TEST_WORKTREE_PATH, 'scratch.txt'), 'delete me')
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: 'error: failed to delete deep/file.txt: Filename too long'
      })
    )
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValue([])

    try {
      const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)

      expect(result).toEqual({
        preservedBranch: { branchName: 'feature/foo', head: 'abc' },
        warning: `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
      })
      expect(gitSpy).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: TEST_REPO_PATH
      })
      if (ORIGINAL_PLATFORM === 'win32') {
        await expect(lstat(TEST_WORKTREE_PATH)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    } finally {
      gitSpy.mockRestore()
      await rm(TEST_WORKTREE_PATH, { recursive: true, force: true })
    }
  })

  it('refuses runtime Windows recovery while Git still reports the row and keeps metadata', async () => {
    setPlatform('win32')
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      removeWorktreeMeta
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    const removePathSpy = vi
      .spyOn(localWorktreeFilesystem, 'removeLocalWorktreePath')
      .mockResolvedValue(undefined)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: 'error: failed to delete deep/file.txt: Filename too long'
      })
    )

    try {
      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)).rejects.toThrow(
        `Failed to force delete worktree at ${TEST_WORKTREE_PATH}. error: failed to delete deep/file.txt: Filename too long`
      )
      expect(removePathSpy).not.toHaveBeenCalled()
      expect(gitSpy).not.toHaveBeenCalledWith(['worktree', 'prune'], expect.anything())
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      removePathSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('retries stale runtime Git registration cleanup after prior filesystem recovery', async () => {
    setPlatform('win32')
    const missingWorktreePath = 'C:\\workspace\\already-removed'
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const registeredWorktrees = [
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: missingWorktreePath,
        head: 'abc',
        branch: 'refs/heads/feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ]
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    vi.mocked(listWorktrees).mockResolvedValue(registeredWorktrees)
    vi.mocked(listWorktreesStrict).mockResolvedValueOnce(registeredWorktrees).mockResolvedValue([])
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })

    try {
      const result = await runtime.removeManagedWorktree(worktreeId, true)

      expect(result).toEqual({
        preservedBranch: { branchName: 'feature/foo', head: 'abc' }
      })
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(gitSpy).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: TEST_REPO_PATH
      })
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('preserves a locked missing runtime registration even with force', async () => {
    setPlatform('win32')
    const missingWorktreePath = 'C:\\workspace\\locked-already-removed'
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const registeredWorktrees = [
      {
        path: missingWorktreePath,
        head: 'abc',
        branch: 'refs/heads/feature/foo',
        isBare: false,
        isMainWorktree: false,
        locked: true,
        lockReason: 'active agent session'
      }
    ]
    vi.mocked(listWorktreesStrict).mockResolvedValue(registeredWorktrees)
    vi.mocked(removeWorktree).mockResolvedValue({})

    await expect(runtime.removeManagedWorktree(worktreeId, true, false)).rejects.toThrow(
      'Worktree is locked by Git. Lock reason: active agent session'
    )

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('routes runtime worktree removal through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
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
      })
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(assertWorktreeCleanForRemoval).toHaveBeenCalledWith(TEST_WORKTREE_PATH, false, {
      wslDistro: 'Ubuntu'
    })
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false, {
      knownRemovedWorktree: expect.objectContaining({ path: TEST_WORKTREE_PATH }),
      wslDistro: 'Ubuntu'
    })
  })

  it('deletes a Windows runtime worktree using the canonical registered path', async () => {
    setPlatform('win32')
    const repo = {
      id: TEST_REPO_ID,
      path: 'C:\\repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
    const requestedWorktreeId = `${TEST_REPO_ID}::C:/workspaces/improve-dashboard`
    const registeredWorktree = {
      path: 'c:\\workspaces\\Improve-Dashboard',
      head: 'feature-head',
      branch: 'refs/heads/improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? repo : undefined),
      getAllWorktreeMeta: () => ({
        [requestedWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        worktreeId === requestedWorktreeId ? makeWorktreeMeta() : undefined,
      getProjects: () => [
        {
          id: 'project-1',
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
      })
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: repo.path,
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      registeredWorktree
    ])
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        path: repo.path,
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      registeredWorktree
    ])
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(requestedWorktreeId)

    expect(listWorktrees).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
    expect(listWorktreesStrict).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemoval).toHaveBeenCalledWith(registeredWorktree.path, false, {
      wslDistro: 'Ubuntu'
    })
    expect(removeWorktree).toHaveBeenCalledWith(repo.path, registeredWorktree.path, false, {
      knownRemovedWorktree: registeredWorktree,
      wslDistro: 'Ubuntu'
    })
  })

  it('surfaces selected-runtime list failures during runtime worktree removal', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
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
      })
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
    vi.mocked(listWorktreesStrict).mockRejectedValue(new Error('wsl git list failed'))

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      'wsl git list failed'
    )

    expect(listWorktrees).toHaveBeenCalledWith(TEST_REPO_PATH, { wslDistro: 'Ubuntu' })
    expect(listWorktreesStrict).toHaveBeenCalledWith(TEST_REPO_PATH, { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('force-deletes a branch that was preserved by runtime worktree removal', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.forceDeletePreservedBranch(
      TEST_WORKTREE_ID,
      'feature/test',
      'def456'
    )

    expect(result).toEqual({ deleted: true })
    expect(forceDeleteLocalBranchMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/test',
      'def456'
    )
  })

  it('force-deletes an SSH branch that was preserved by runtime worktree removal', async () => {
    const remoteRepo = {
      ...store.getRepo(TEST_REPO_ID)!,
      path: '/remote/repo',
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: '/remote/feature-wt',
      head: 'def456',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
    const remoteWorktreeId = `${remoteRepo.id}::${remoteWorktree.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [remoteWorktreeId]: makeWorktreeMeta()
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
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
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: remoteRepo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        remoteWorktree
      ]),
      removeWorktree: vi.fn().mockResolvedValue({
        preservedBranch: { branchName: 'feature/test', head: 'def456' }
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await runtime.removeManagedWorktree(remoteWorktreeId)
      const result = await runtime.forceDeletePreservedBranch(
        remoteWorktreeId,
        'feature/test',
        'def456'
      )

      expect(result).toEqual({ deleted: true })
      expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
        '/remote/repo',
        'feature/test',
        'def456'
      )
      expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('force-deletes a preserved branch on the qualified host when repo ids collide', async () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = {
      ...localRepo,
      path: '/remote/repo',
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: TEST_WORKTREE_PATH,
      head: 'def456',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({
        hostId: 'local',
        preserveBranchOnDelete: true
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string, hostId?: string) => {
        if (!hostId || metaById[worktreeId]?.hostId === hostId) {
          delete metaById[worktreeId]
        }
      }
    }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: remoteRepo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        remoteWorktree
      ]),
      removeWorktree: vi.fn().mockResolvedValue({
        preservedBranch: { branchName: 'feature/test', head: 'def456' }
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, false, false, 'ssh:ssh-1')
      expect(provider.removeWorktree).toHaveBeenCalledWith(TEST_WORKTREE_PATH, false)
      expect(metaById[TEST_WORKTREE_ID]?.hostId).toBe('local')
      const result = await runtime.forceDeletePreservedBranch(
        TEST_WORKTREE_ID,
        'feature/test',
        'def456',
        'ssh:ssh-1'
      )

      expect(result).toEqual({ deleted: true })
      expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
        remoteRepo.path,
        'feature/test',
        'def456'
      )
      expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('routes runtime preserved-branch force-delete through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
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
      })
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })
    const gitExec = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    await runtime.forceDeletePreservedBranch(TEST_WORKTREE_ID, 'feature/test', 'def456')

    const runGit = forceDeleteLocalBranchMock.mock.calls[0]?.[3]
    expect(runGit).toEqual(expect.any(Function))
    await runGit?.(['status'], TEST_REPO_PATH)
    expect(gitExec).toHaveBeenCalledWith(['status'], {
      cwd: TEST_REPO_PATH,
      wslDistro: 'Ubuntu'
    })
  })

  it('rejects stale preserved-branch runtime cleanup actions with an old head', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'new456' }
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await expect(
      runtime.forceDeletePreservedBranch(TEST_WORKTREE_ID, 'feature/test', 'old123')
    ).rejects.toThrow('No preserved branch cleanup is pending')
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('coalesces concurrent runtime worktree removals for the same worktree id', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)
    const second = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)

    await removeStarted.promise
    await Promise.resolve()
    expect(removeWorktree).toHaveBeenCalledTimes(1)

    finishRemoval.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
  })

  it('does not coalesce concurrent same-id removals on different hosts', async () => {
    const runtimeStore = {
      ...store,
      getRepos: () => [
        { ...store.getRepos()[0], executionHostId: 'local' },
        { ...store.getRepos()[0], executionHostId: 'runtime:env-1' }
      ]
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.spyOn(runtime, 'acquireFileWatcherRemoval').mockResolvedValue({ finish: vi.fn() })
    const bothStarted = deferred<void>()
    const finishRemovals = deferred<void>()
    let startedCount = 0
    vi.mocked(removeWorktree).mockImplementation(async () => {
      startedCount += 1
      if (startedCount === 2) {
        bothStarted.resolve()
      }
      await finishRemovals.promise
      return {}
    })

    const local = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'local')
    const paired = runtime.removeManagedWorktree(
      TEST_WORKTREE_ID,
      true,
      false,
      false,
      'runtime:env-1'
    )

    await bothStarted.promise
    expect(removeWorktree).toHaveBeenCalledTimes(2)

    finishRemovals.resolve()
    await expect(Promise.all([local, paired])).resolves.toEqual([{}, {}])
  })

  it('rejects concurrent runtime worktree removals for the same id with different options', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await removeStarted.promise
    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)).rejects.toThrow(
      'Worktree deletion already in progress'
    )

    expect(removeWorktree).toHaveBeenCalledTimes(1)
    finishRemoval.resolve()
    await expect(first).resolves.toEqual({})
  })

  it('treats forced runtime deletion of an already-missing unregistered worktree as cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-'))
    const missingWorktreePath = join(parentDir, 'already-deleted')
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('treats normal runtime deletion of an already-missing unregistered worktree as cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-'))
    const missingWorktreePath = join(parentDir, 'already-deleted')
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId)).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('routes already-missing SSH runtime history cleanup through the PTY owner', async () => {
    const repo = {
      id: 'repo-runtime-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const worktreeId = `${repo.id}::/remote/already-deleted`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({ hostId: 'ssh:ssh-1', orcaCreationSource: 'ssh' })
    }
    const removeWorktreeMeta = vi.fn((id: string) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      removeWorktreeMeta
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const fsProvider = {
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    const deleteWorktreeHistory = vi.fn().mockResolvedValue(undefined)
    const ptyProvider = { deleteWorktreeHistory } as never
    registerSshGitProvider(repo.connectionId, gitProvider as never)
    registerSshFilesystemProvider(repo.connectionId, fsProvider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getSshProvider: () => ptyProvider
    })

    try {
      await expect(runtime.removeManagedWorktree(`id:${worktreeId}`)).resolves.toEqual({})
    } finally {
      unregisterSshGitProvider(repo.connectionId)
      unregisterSshFilesystemProvider(repo.connectionId)
    }

    expect(deleteWorktreeHistory).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistory.mock.invocationCallOrder[0]).toBeLessThan(
      removeWorktreeMeta.mock.invocationCallOrder[0]
    )
    expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:ssh-1')
  })

  it('routes SSH runtime orphan-directory history cleanup through the PTY owner', async () => {
    const repo = {
      id: 'repo-runtime-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const worktreePath = '/remote/orphan'
    const worktreeId = `${repo.id}::${worktreePath}`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({
        hostId: 'ssh:ssh-1',
        orcaCreatedAt: Date.now(),
        orcaCreationSource: 'ssh'
      })
    }
    const removeWorktreeMeta = vi.fn((id: string) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      removeWorktreeMeta
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const fsProvider = {
      lstat: vi.fn(async (path: string) => ({
        type: path === `${worktreePath}/.git` ? 'file' : 'directory'
      })),
      readFile: vi.fn(async (path: string) => ({
        isBinary: false,
        content:
          path === `${worktreePath}/.git`
            ? `gitdir: ${repo.path}/.git/worktrees/orphan\n`
            : `${worktreePath}/.git\n`
      })),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    const deleteWorktreeHistory = vi.fn().mockResolvedValue(undefined)
    const ptyProvider = {
      listProcesses: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
      deleteWorktreeHistory
    }
    registerSshGitProvider(repo.connectionId, gitProvider as never)
    registerSshFilesystemProvider(repo.connectionId, fsProvider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getSshProvider: () => ptyProvider as never
    })

    try {
      await expect(runtime.removeManagedWorktree(`id:${worktreeId}`, true)).resolves.toEqual({})
    } finally {
      unregisterSshGitProvider(repo.connectionId)
      unregisterSshFilesystemProvider(repo.connectionId)
    }

    expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
    expect(deleteWorktreeHistory).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistory.mock.invocationCallOrder[0]).toBeLessThan(
      removeWorktreeMeta.mock.invocationCallOrder[0]
    )
  })

  it('force-removes a legacy Orca-created runtime orphaned worktree directory after Git tracking is gone', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    const worktreeId = `${TEST_REPO_ID}::${orphanPath}`
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      createdAt: Date.now()
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
        orphanPath,
        expect.objectContaining({ remainingMs: expect.any(Function) })
      )
      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      // Why: Windows can keep a just-inspected git admin dir busy briefly.
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('prompts then force-removes an Orca-created runtime unregistered leftover directory with no git marker', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-leftover-'))
    const repoPath = join(parentDir, 'repo')
    const leftoverPath = join(parentDir, 'leftover')
    const worktreeId = `${TEST_REPO_ID}::${leftoverPath}`
    await mkdir(leftoverPath, { recursive: true })
    await writeFile(join(leftoverPath, 'leftover.txt'), 'kept until force\n')
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      orcaCreatedAt: Date.now(),
      orcaCreationSource: 'runtime'
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'status') {
        throw new Error('fatal: not a git repository')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId)).rejects.toThrow(
        'Worktree is no longer registered with Git but its directory remains.'
      )
      await expect(lstat(leftoverPath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      await expect(lstat(leftoverPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
      expect(gitSpy).toHaveBeenCalledWith(['status', '--short'], { cwd: leftoverPath })
    } finally {
      gitSpy.mockRestore()
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('rejects an Orca-created runtime unregistered local directory with a git directory', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-standalone-'))
    const repoPath = join(parentDir, 'repo')
    const standalonePath = join(parentDir, 'standalone')
    const worktreeId = `${TEST_REPO_ID}::${standalonePath}`
    await mkdir(join(standalonePath, '.git'), { recursive: true })
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      orcaCreatedAt: Date.now(),
      orcaCreationSource: 'runtime'
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).rejects.toThrow(
        `Refusing to delete unregistered worktree path: ${standalonePath}`
      )

      await expect(lstat(standalonePath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('does not inspect or delete a local path when SSH runtime orphan cleanup has no filesystem provider', async () => {
    const localPath = await mkdtemp(join(tmpdir(), 'orca-runtime-ssh-missing-fs-'))
    const repo = {
      id: 'repo-runtime-ssh-missing-fs',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-missing-fs'
    }
    const worktreeId = `${repo.id}::${localPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({
        orcaCreatedAt: Date.now(),
        orcaCreationSource: 'ssh'
      })
    }
    const removeWorktreeMeta = vi.fn((id: string) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      setWorktreeMeta: (id: string, meta: Partial<WorktreeMeta>) => {
        metaById[id] = { ...(metaById[id] ?? makeWorktreeMeta()), ...meta }
        return metaById[id]
      },
      removeWorktreeMeta
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider(repo.connectionId, gitProvider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await expect(runtime.removeManagedWorktree(`id:${worktreeId}`, true)).rejects.toThrow(
        'SSH filesystem provider unavailable'
      )

      await expect(lstat(localPath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider(repo.connectionId)
      await rm(localPath, { recursive: true, force: true })
    }
  })

  it('still rejects forced runtime unregistered delete paths that exist on disk', async () => {
    const existingWorktreePath = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-existing-'))
    const worktreeId = `${TEST_REPO_ID}::${existingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).rejects.toThrow(
        'Refusing to delete unregistered worktree path'
      )

      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(existingWorktreePath, { recursive: true, force: true })
    }
  })

  it('rejects CLI worktree removal when the target contains another registered worktree', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: TEST_WORKTREE_PATH,
        head: 'parent',
        branch: 'refs/heads/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: `${TEST_WORKTREE_PATH}/child`,
        head: 'child',
        branch: 'refs/heads/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: TEST_WORKTREE_PATH,
        head: 'parent',
        branch: 'refs/heads/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: `${TEST_WORKTREE_PATH}/child`,
        head: 'child',
        branch: 'refs/heads/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, true)).rejects.toThrow(
      `Refusing to delete worktree because it contains another registered worktree: ${TEST_WORKTREE_PATH}/child`
    )

    expect(runHook).not.toHaveBeenCalled()
    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('fails dirty non-force deletes before PTY teardown', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('Worktree has uncommitted or untracked changes.'), {
        stdout: '?? scratch.txt\n'
      })
    )

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      `Failed to delete worktree at ${TEST_WORKTREE_PATH}. ?? scratch.txt`
    )

    expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('fails locked dirty-force deletes before hooks, link cleanup, or PTY teardown', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { archive: 'pnpm worktree:archive' }
    })
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        ...MOCK_GIT_WORKTREES[0],
        locked: true,
        lockReason: 'active agent session'
      }
    ])

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, true)).rejects.toThrow(
      `Failed to force delete worktree at ${TEST_WORKTREE_PATH}. Worktree is locked by Git.`
    )

    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('rechecks a runtime Git lock after the archive hook before teardown', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { archive: 'pnpm worktree:archive' }
    })
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce([
        {
          ...MOCK_GIT_WORKTREES[0],
          locked: true,
          lockReason: 'locked during archive'
        }
      ])

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, true)).rejects.toThrow(
      'Worktree is locked by Git'
    )

    expect(runHook).toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('formats preflight subprocess failures and skips PTY teardown', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: unable to read current working directory\n'
      })
    )

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      `Failed to delete worktree at ${TEST_WORKTREE_PATH}. fatal: unable to read current working directory`
    )

    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('falls through to orphan cleanup when preflight reports missing/non-repo worktree', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: `fatal: '${TEST_WORKTREE_PATH}' is not a working tree`
      })
    )
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({ stdout: '', stderr: '' })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({})
    expect(removeWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      TEST_WORKTREE_PATH,
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({ path: TEST_WORKTREE_PATH })
      })
    )
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
  })

  it('drops the bounded scan cache when orphan-cleanup removal completes', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: `fatal: '${TEST_WORKTREE_PATH}' is not a working tree`
      })
    )
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({ stdout: '', stderr: '' })

    // Prime the bounded raw scan cache with the worktree still present.
    await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({})

    // Regression (#8882): orphan-cleanup removal must also drop the raw scan cache, or the worktree lingers in listings until the 30s TTL.
    vi.mocked(listWorktrees).mockResolvedValue([])
    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toMatchObject(
      { worktrees: [] }
    )
  })

  it('runs archive hooks for CLI worktree removal when hooks are explicitly enabled', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, true)

    expect(runHook).toHaveBeenCalledWith(
      'archive',
      TEST_WORKTREE_PATH,
      expect.objectContaining({ id: TEST_REPO_ID, path: TEST_REPO_PATH }),
      undefined,
      undefined
    )
    expect(removeWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      TEST_WORKTREE_PATH,
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({ path: TEST_WORKTREE_PATH })
      })
    )
  })

  it('clears optimistic reconcile tokens when a CLI worktree removal succeeds', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const worktreeBaseStatus = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      worktreeBaseStatus,
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    await runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        base: 'origin/main'
      },
      branchName: 'feature',
      createdBaseSha: 'created-sha',
      token,
      fetchPromise: Promise.resolve({ ok: true })
    })

    expect(worktreeBaseStatus).not.toHaveBeenCalled()
  })

  const remoteTrackingBase = {
    remote: 'origin',
    branch: 'main',
    ref: 'refs/remotes/origin/main',
    base: 'origin/main'
  }

  function createReconcileRuntime(): {
    runtime: OrcaRuntimeService
    worktreeBaseStatus: ReturnType<typeof vi.fn>
  } {
    const worktreeBaseStatus = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreeBaseStatus,
      worktreeRemoteBranchConflict: vi.fn()
    } as never)
    return { runtime, worktreeBaseStatus }
  }

  function mockReconcileGit(options: {
    postFetchSha?: string
    ancestor?: boolean
    baseRefMissing?: boolean
  }) {
    const { postFetchSha = 'new-base-sha', ancestor = true, baseRefMissing = false } = options

    return vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const command = args as string[]
      const cwd = (options as { cwd?: string } | undefined)?.cwd
      if (
        cwd === TEST_REPO_PATH &&
        command[0] === 'rev-parse' &&
        command[1] === '--verify' &&
        command[2] === `${remoteTrackingBase.ref}^{commit}`
      ) {
        if (baseRefMissing) {
          throw new Error('missing base ref')
        }
        return { stdout: `${postFetchSha}\n`, stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'merge-base') {
        if (!ancestor) {
          throw new Error('not ancestor')
        }
        return { stdout: '', stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'rev-list') {
        return { stdout: '3\n', stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'log') {
        return { stdout: 'base commit 3\nbase commit 2\n', stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'config') {
        throw new Error('config missing')
      }
      if (
        cwd === TEST_REPO_PATH &&
        command[0] === 'rev-parse' &&
        command[1] === '--verify' &&
        command[2] === 'refs/remotes/origin/feature^{commit}'
      ) {
        throw new Error('no publish branch conflict')
      }
      throw new Error(`unexpected git command: ${command.join(' ')}`)
    })
  }

  async function reconcileWithToken(runtime: OrcaRuntimeService, token: string): Promise<void> {
    await runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: remoteTrackingBase,
      branchName: 'feature',
      createdBaseSha: 'created-base-sha',
      token,
      fetchPromise: Promise.resolve({ ok: true })
    })
  }

  it('emits drift without mutating when the fetched base fast-forwards created HEAD', async () => {
    const { runtime, worktreeBaseStatus } = createReconcileRuntime()
    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({})
    try {
      await reconcileWithToken(runtime, token)

      expect(gitSpy).not.toHaveBeenCalledWith(['reset', '--hard', 'new-base-sha'], {
        cwd: TEST_WORKTREE_PATH
      })
      expect(worktreeBaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'drift',
          behind: 3,
          recentSubjects: ['base commit 3', 'base commit 2']
        })
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('emits current when the fetched base still matches created HEAD', async () => {
    const { runtime, worktreeBaseStatus } = createReconcileRuntime()
    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({ postFetchSha: 'created-base-sha' })
    try {
      await reconcileWithToken(runtime, token)

      expect(worktreeBaseStatus).toHaveBeenCalledWith({
        repoId: TEST_REPO_ID,
        worktreeId: TEST_WORKTREE_ID,
        base: 'origin/main',
        remote: 'origin',
        status: 'current'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('emits base_changed without mutation when the fetched base rewrote history', async () => {
    const { runtime, worktreeBaseStatus } = createReconcileRuntime()
    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({ ancestor: false })
    try {
      await reconcileWithToken(runtime, token)

      expect(gitSpy).not.toHaveBeenCalledWith(['reset', '--hard', 'new-base-sha'], {
        cwd: TEST_WORKTREE_PATH
      })
      expect(worktreeBaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'base_changed' })
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('skips stale-token reconciles without mutating or emitting stale status', async () => {
    const stale = createReconcileRuntime()
    const staleToken = stale.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    stale.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const staleGitSpy = mockReconcileGit({})
    try {
      await reconcileWithToken(stale.runtime, staleToken)
      expect(stale.worktreeBaseStatus).not.toHaveBeenCalled()
      expect(staleGitSpy).not.toHaveBeenCalled()
    } finally {
      staleGitSpy.mockRestore()
    }
  })

  it('emits unknown without mutation when fetch fails or the base ref is missing', async () => {
    const fetchFailure = createReconcileRuntime()
    const fetchFailureToken = fetchFailure.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    await fetchFailure.runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: remoteTrackingBase,
      branchName: 'feature',
      createdBaseSha: 'created-base-sha',
      token: fetchFailureToken,
      fetchPromise: Promise.resolve({ ok: false, errorKind: 'git_error' })
    })
    expect(fetchFailure.worktreeBaseStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown' })
    )

    const missingBase = createReconcileRuntime()
    const missingBaseToken = missingBase.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({ baseRefMissing: true })
    try {
      await reconcileWithToken(missingBase.runtime, missingBaseToken)
      expect(gitSpy).not.toHaveBeenCalledWith(['reset', '--hard', 'new-base-sha'], {
        cwd: TEST_WORKTREE_PATH
      })
      expect(missingBase.worktreeBaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'unknown' })
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('invalidates the filesystem-auth cache after CLI worktree creation', async () => {
    // Reproduces: stale filesystem-auth cache made git:branchCompare fail with "Access denied" for CLI-created worktree paths.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/cli-worktree')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/cli-worktree')
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/cli-worktree',
        head: 'abc',
        branch: 'cli-worktree',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cli-worktree'
    })

    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('preserves create-time metadata on later runtime listings when Windows path formatting differs', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      getRepo: (id: string) => runtimeStore.getRepos().find((repo) => repo.id === id),
      getRepos: () => [
        {
          id: 'repo-1',
          path: 'C:\\repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existingMeta = metaById[worktreeId]
        const nextMeta: WorktreeMeta = {
          displayName: meta.displayName ?? existingMeta?.displayName ?? '',
          comment: meta.comment ?? existingMeta?.comment ?? '',
          linkedIssue: meta.linkedIssue ?? existingMeta?.linkedIssue ?? null,
          linkedPR: meta.linkedPR ?? existingMeta?.linkedPR ?? null,
          linkedLinearIssue: meta.linkedLinearIssue ?? existingMeta?.linkedLinearIssue ?? null,
          linkedGitLabMR: meta.linkedGitLabMR ?? existingMeta?.linkedGitLabMR ?? null,
          linkedGitLabIssue: meta.linkedGitLabIssue ?? existingMeta?.linkedGitLabIssue ?? null,
          isArchived: meta.isArchived ?? existingMeta?.isArchived ?? false,
          isUnread: meta.isUnread ?? existingMeta?.isUnread ?? false,
          isPinned: meta.isPinned ?? existingMeta?.isPinned ?? false,
          sortOrder: meta.sortOrder ?? existingMeta?.sortOrder ?? 0,
          lastActivityAt: meta.lastActivityAt ?? existingMeta?.lastActivityAt ?? 0
        }
        metaById[worktreeId] = nextMeta
        return nextMeta
      },
      removeWorktreeMeta: () => {},
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
      addRetiredWorktreeName: () => {},
      mergeRetiredWorktreeNames: () => false,
      getGitHubCache: () => undefined as never,
      getSettings: () => ({
        workspaceDir: 'C:\\workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      })
    }
    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const runtime = new OrcaRuntimeService(runtimeStore)
    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'Improve Dashboard'
    })
    const listed = await runtime.listManagedWorktrees('id:repo-1')

    expect(listed.worktrees).toMatchObject([
      {
        id: 'repo-1::C:/workspaces/improve-dashboard',
        displayName: 'Improve Dashboard'
      }
    ])
  })
})
