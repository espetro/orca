/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRuntimeTestMocks, getRepoUpstreamMock, store } from './orca-runtime-test-fixture'

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gitRunner from '../git/runner'

import { OrcaRuntimeService } from './orca-runtime'

import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('does not hijack a legacy SSH repo at the same path into a runtime host', async () => {
    // A legacy SSH repo resolves to `ssh:<connectionId>` even with null executionHostId, so a same-path runtime import creates a new repo instead of adopting it.
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-ssh-1',
        path: '/workspace',
        displayName: 'workspace',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'folder',
        connectionId: 'ssh-target-1'
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/workspace', 'folder', 'runtime:env-1')

    expect(repos).toHaveLength(2)
    expect(repo.id).not.toBe('repo-ssh-1')
    expect(repo).toMatchObject({ path: '/workspace', executionHostId: 'runtime:env-1' })
    // The legacy SSH repo must be untouched (no executionHostId stamped onto it).
    expect(repos[0]).toMatchObject({ id: 'repo-ssh-1', connectionId: 'ssh-target-1' })
    expect(repos[0]).not.toHaveProperty('executionHostId')
  })

  it('only a runtime host adopts an unstamped repo; local/ssh imports never stamp it', async () => {
    // Local and legacy runtime repos both have null executionHostId/connectionId, so only a runtime host may backfill; local/ssh imports leave it untouched.
    for (const importHostId of ['local', 'ssh:ssh-target-9'] as const) {
      const repos: Record<string, unknown>[] = [
        {
          id: 'repo-local-1',
          path: '/workspace',
          displayName: 'workspace',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        }
      ]
      const runtimeStore = {
        ...store,
        getRepos: () => [...repos] as never,
        addRepo: (repo: Record<string, unknown>) => {
          repos.push(repo)
        },
        getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
        updateRepo: (id: string, updates: Record<string, unknown>) => {
          const index = repos.findIndex((repo) => repo.id === id)
          if (index === -1) {
            return null
          }
          repos[index] = { ...repos[index], ...updates }
          return repos[index] as never
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)

      const repo = await runtime.addRepo('/workspace', 'folder', importHostId)

      // The matched repo is returned unchanged — no new repo, no executionHostId stamped.
      expect(repos).toHaveLength(1)
      expect(repo.id).toBe('repo-local-1')
      expect(repos[0]).not.toHaveProperty('executionHostId')
    }
  })

  it('keeps project clone setup on the cloned host-qualified repo', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.setupProjectClone({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(1)
      expect(result.repo).toMatchObject({
        path: clonePath,
        executionHostId: 'runtime:env-1',
        projectHostSetupMethod: 'cloned'
      })
      expect(result.setup).toMatchObject({
        repoId: result.repo.id,
        hostId: 'runtime:env-1',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('refuses SSH hosts instead of setting the project up on the local machine', async () => {
    // Why: both inputs must be paths the pre-guard code would have accepted. An unwritable
    // destination fails at mkdir and a non-repo path fails at isGitRepo, which would leave the
    // side-effect assertions below unable to observe the local clone/probe they exist to catch.
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-ssh-guard-'))
    const existingFolder = join(destination, 'orca')
    mkdirSync(existingFolder, { recursive: true })
    execFileSync('git', ['init'], { cwd: existingFolder, stdio: 'ignore' })
    const spawnSpy = vi
      .spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
      .mockImplementation(() => {
        // Why: unreachable while the guard holds; stubbed so a regression records the call
        // instead of shelling out to a real network clone.
        const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
        proc.stderr = new EventEmitter()
        setImmediate(() => proc.emit('close', 1, null))
        return proc as never
      })
    const repos: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const cloneError = await runtime
        .setupProjectClone({
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:openclaw',
          url: 'https://example.com/orca.git',
          destination
        })
        .catch((error: unknown) => error)
      const existingFolderError = await runtime
        .setupProjectExistingFolder({
          projectId: 'github:stablyai/orca',
          hostId: 'ssh:openclaw',
          path: existingFolder,
          kind: 'git'
        })
        .catch((error: unknown) => error)

      // Why: the defect was a silent local clone/probe recorded as remote, not a bad message,
      // so the absent side effects are asserted before the wording. Both calls are awaited
      // first so a regression reports the corruption rather than stopping at the first throw.
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(repos).toHaveLength(0)
      expect(cloneError).toMatchObject({
        message: expect.stringMatching(/SSH hosts are not supported/)
      })
      expect(existingFolderError).toMatchObject({
        message: expect.stringMatching(/SSH hosts are not supported/)
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('adopts public clone repos into host-qualified project setup', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = []
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const cloned = await runtime.cloneRepo('https://example.com/orca.git', destination)
      expect(cloned).toMatchObject({
        path: clonePath
      })
      expect(cloned).not.toHaveProperty('executionHostId')

      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-1',
        path: clonePath,
        kind: 'git',
        setupMethod: 'cloned'
      })

      expect(repos).toHaveLength(1)
      expect(result.repo).toMatchObject({
        id: cloned.id,
        path: clonePath,
        executionHostId: 'runtime:env-1',
        projectHostSetupMethod: 'cloned'
      })
      expect(result.setup).toMatchObject({
        repoId: cloned.id,
        hostId: 'runtime:env-1',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('keeps project clone repos split by runtime host on the same clone path', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-project-clone-'))
    const clonePath = join(destination, 'orca')
    const spawnSpy = vi.spyOn(gitRunner, 'gitSpawnAfterWindowsEnvironmentReady')
    const repos: Record<string, unknown>[] = [
      {
        id: 'repo-host-a',
        path: clonePath,
        displayName: 'orca',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ]
    getRepoUpstreamMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const runtimeStore = {
      ...store,
      getRepos: () => [...repos] as never,
      addRepo: (repo: Record<string, unknown>) => {
        repos.push(repo)
      },
      getRepo: (id: string) => repos.find((repo) => repo.id === id) as never,
      updateRepo: (id: string, updates: Record<string, unknown>) => {
        const index = repos.findIndex((repo) => repo.id === id)
        if (index === -1) {
          return null
        }
        repos[index] = { ...repos[index], ...updates }
        return repos[index] as never
      },
      getProjects: () => projectHostSetupProjectionFromRepos(repos as never).projects as never,
      getProjectHostSetups: () =>
        projectHostSetupProjectionFromRepos(repos as never).setups as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => {
        mkdirSync(clonePath, { recursive: true })
        execFileSync('git', ['init'], { cwd: clonePath, stdio: 'ignore' })
        proc.emit('close', 0, null)
      })
      return proc as never
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.setupProjectClone({
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:env-2',
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(2)
      expect(repos[0]).toMatchObject({
        id: 'repo-host-a',
        executionHostId: 'runtime:env-1'
      })
      expect(result.repo).toMatchObject({
        path: clonePath,
        executionHostId: 'runtime:env-2'
      })
      expect(result.repo.id).not.toBe('repo-host-a')
      expect(result.setup).toMatchObject({
        repoId: result.repo.id,
        hostId: 'runtime:env-2',
        setupMethod: 'cloned'
      })
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })
})
