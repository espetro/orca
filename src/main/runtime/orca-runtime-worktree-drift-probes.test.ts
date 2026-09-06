/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  isOriginMainBaseRefProbe,
  setPlatform,
  store
} from './orca-runtime-test-fixture'

import * as gitRunner from '../git/runner'
import { listWorktrees } from '../git/worktree'

import { getBaseRefDefault } from '../git/repo'
import { OrcaRuntimeService } from './orca-runtime'

import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('routes local WSL project hosted review flows through runtime git options', async () => {
    setPlatform('win32')
    const wslStore = {
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
    const runtime = new OrcaRuntimeService(wslStore as never)
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'github',
      number: 76,
      title: 'Feature WSL',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/76',
      status: 'success',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    })
    createHostedReviewMock.mockResolvedValueOnce({
      ok: true,
      number: 77,
      url: 'https://github.com/acme/orca/pull/77'
    })

    await runtime.getHostedReviewForBranch({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/wsl',
      linkedGitHubPR: 76
    })
    await runtime.getHostedReviewCreationEligibility({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/wsl',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await runtime.createHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/wsl',
      title: 'Feature WSL',
      body: '',
      draft: false
    })
    await runtime.createStackedHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'stack/parent',
      head: 'feature/wsl',
      title: 'Feature WSL',
      body: '',
      draft: false
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        connectionId: null,
        branch: 'feature/wsl',
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    )
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        connectionId: null,
        branch: 'feature/wsl',
        linkedGitHubPR: 76,
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    )
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      expect.objectContaining({
        provider: 'github',
        head: 'feature/wsl',
        title: 'Feature WSL'
      }),
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
    expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      expect.objectContaining({
        provider: 'github',
        base: 'stack/parent',
        head: 'feature/wsl'
      }),
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
  })

  it('treats SSH worktree drift as unknown without local git probes', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(getBaseRefDefault).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getWorktreeMeta: () => null
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.probeWorktreeDrift('path:/remote/repo')).resolves.toBeNull()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(getBaseRefDefault).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('routes local WSL project worktree drift probes through runtime git options', async () => {
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
    const wslGitOptions = { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
    let driftCounts = '1\t2\n'
    const asyncGitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: `${TEST_REPO_PATH}/.git\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: driftCounts, stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: 'base commit 2\nbase commit 1\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    try {
      const result = await runtime.probeWorktreeDrift(`id:${TEST_WORKTREE_ID}`)

      expect(result).toEqual({
        base: 'origin/main',
        behind: 2,
        recentSubjects: ['base commit 2', 'base commit 1']
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        { ...wslGitOptions, timeout: 15_000 }
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(['remote'], wslGitOptions)
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        wslGitOptions
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(['fetch', 'origin'], {
        ...wslGitOptions,
        timeout: 60_000
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['log', '--format=%s', '-n', '5', 'HEAD..origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )

      driftCounts = '3\t0\n'
      asyncGitSpy.mockClear()

      await expect(runtime.probeWorktreeDrift(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
        base: 'origin/main',
        behind: 0,
        recentSubjects: []
      })
      expect(asyncGitSpy).toHaveBeenCalledWith(
        ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
        { cwd: TEST_WORKTREE_PATH, wslDistro: 'Ubuntu', timeout: 15_000 }
      )
      expect(asyncGitSpy.mock.calls.some(([args]) => args[0] === 'log')).toBe(false)
    } finally {
      asyncGitSpy.mockRestore()
    }
  })
})
