/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  MOCK_GIT_WORKTREES,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeDeferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  resetRuntimeTestMocks,
  setPlatform,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { listWorktrees } from '../git/worktree'
import { registerSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  WORKTREE_PROCESS_SWEEP_TIMEOUT_MS,
  WORKTREE_TEARDOWN_RPC_MARGIN_MS
} from './worktree-teardown'
import { win32 } from 'node:path'
import * as worktreePathComparison from '../ipc/worktree-path-comparison'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('marks the desktop-active worktree as isActive', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()
    const active = worktrees.filter((w) => w.isActive)
    expect(active).toHaveLength(1)
    expect(active[0]?.worktreeId).toBe(TEST_WORKTREE_ID)
  })

  it('includes SSH-backed worktrees in the mobile worktree summary', async () => {
    const remoteRepo = {
      id: 'repo-ssh',
      path: '/home/me/project',
      displayName: 'remote-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: '/home/me/project/.worktrees/feature-mobile',
      head: 'def',
      branch: 'refs/heads/feature/mobile',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {
      [`${remoteRepo.id}::${remoteWorktree.path}`]: makeWorktreeMeta({
        displayName: 'Remote mobile'
      })
    }
    const getRepo = vi.fn((id: string) => (id === remoteRepo.id ? remoteRepo : undefined))
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    registerSshGitProvider('ssh-1', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)

    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        Array.from({ length: 100 }, (_, index) => ({
          paneKey: `remote-tab:${String(index).padStart(8, '0')}-5555-4555-8555-555555555555`,
          worktreeId: `${remoteRepo.id}::${remoteWorktree.path}/`,
          tabId: 'remote-tab',
          state: 'working',
          prompt: 'remote agent without a PTY',
          agentType: 'codex',
          connectionId: 'ssh-1',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })
    const summaries = await runtime.getWorktreePs()

    // Why: equal keys prove polled worktree.ps rows can share the per-request index instead of repeating path scans.
    expect(worktreePathComparison.worktreePathComparisonKey(remoteWorktree.path, 'linux')).toBe(
      worktreePathComparison.worktreePathComparisonKey(`${remoteWorktree.path}/`, 'linux')
    )

    expect(summaries.worktrees).toEqual([
      expect.objectContaining({
        worktreeId: `${remoteRepo.id}::${remoteWorktree.path}`,
        repoId: remoteRepo.id,
        repo: 'remote-vm',
        path: remoteWorktree.path,
        displayName: 'Remote mobile',
        hasHostSidebarActivity: true,
        status: 'working',
        agents: expect.arrayContaining([
          expect.objectContaining({
            prompt: 'remote agent without a PTY',
            agentType: 'codex'
          })
        ])
      })
    ])
    expect(summaries.worktrees[0]?.agents).toHaveLength(100)
    expect(getRepo).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['relative', 'project', 'feature\\name', 'feature/name', 'feature\\name', true],
    [
      'absolute',
      'C:\\remote',
      '/remote/feature\\name',
      '/remote/feature/name',
      '/remote/feature\\name',
      true
    ],
    ['Windows SSH alias', 'C:\\remote', 'feature\\name', 'feature/name', 'feature/name', false]
  ] as const)(
    'handles %s worktree paths when projecting mobile agents',
    async (_kind, repoPath, backslashPath, slashPath, projectedPath, includeSlashWorktree) => {
      setPlatform('win32')
      const remoteRepo = {
        id: 'repo-relative-ssh',
        path: repoPath,
        displayName: 'relative-vm',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-relative'
      }
      const backslashWorktree = {
        path: backslashPath,
        head: 'abc',
        branch: 'refs/heads/backslash',
        isBare: false,
        isMainWorktree: false
      }
      const slashWorktree = {
        ...backslashWorktree,
        path: slashPath,
        branch: 'refs/heads/slash'
      }
      const runtimeStore = {
        ...store,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined
      }
      registerSshGitProvider('ssh-relative', {
        listWorktrees: vi
          .fn()
          .mockResolvedValue(
            includeSlashWorktree ? [backslashWorktree, slashWorktree] : [backslashWorktree]
          )
      } as never)

      const now = Date.now()
      const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
        getAgentStatusSnapshot: () =>
          Array.from({ length: 100 }, (_, index) => ({
            paneKey: `relative-tab:${String(index).padStart(8, '0')}-5555-4555-8555-555555555555`,
            worktreeId: `${remoteRepo.id}::${projectedPath}/`,
            tabId: 'relative-tab',
            state: 'working',
            prompt: 'relative path agent',
            agentType: 'codex',
            connectionId: 'ssh-relative',
            receivedAt: now,
            stateStartedAt: now - 100
          }))
      })

      const summaries = await runtime.getWorktreePs()
      const backslashSummary = summaries.worktrees.find(
        (worktree) => worktree.path === backslashWorktree.path
      )
      const slashSummary = summaries.worktrees.find(
        (worktree) => worktree.path === slashWorktree.path
      )

      expect(backslashSummary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
      expect(backslashSummary?.agents).toHaveLength(100)
      expect(slashSummary?.agents).toEqual(includeSlashWorktree ? [] : undefined)
      const comparisonPlatform = repoPath.startsWith('C:') ? 'win32' : 'linux'
      const backslashKey = worktreePathComparison.worktreePathComparisonKey(
        backslashPath,
        comparisonPlatform
      )
      const slashKey = worktreePathComparison.worktreePathComparisonKey(
        slashPath,
        comparisonPlatform
      )
      expect(backslashKey === slashKey).toBe(!includeSlashWorktree)
    }
  )

  it('projects 100 distinct pair-aware paths without rescanning the worktree list', async () => {
    const remoteRepo = {
      id: 'repo-pair-aware-scale',
      path: '/remote',
      displayName: 'pair-aware-scale-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-pair-aware-scale'
    }
    let pathReadCount = 0
    const remoteWorktrees = Array.from({ length: 100 }, (_, index) => {
      const path = `C:relative\\feature-${String(index).padStart(3, '0')}`
      return {
        get path() {
          pathReadCount += 1
          return path
        },
        head: `head-${index}`,
        branch: `refs/heads/feature-${index}`,
        isBare: false,
        isMainWorktree: false
      }
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-pair-aware-scale', {
      listWorktrees: vi.fn().mockResolvedValue(remoteWorktrees)
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        remoteWorktrees.map((worktree, index) => ({
          paneKey: `pair-aware-tab:${String(index).padStart(8, '0')}-9999-4999-8999-999999999999`,
          worktreeId: `${remoteRepo.id}::${win32.resolve(worktree.path)}`,
          tabId: 'pair-aware-tab',
          state: 'working' as const,
          prompt: `pair-aware agent ${index}`,
          agentType: 'codex',
          connectionId: 'ssh-pair-aware-scale',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })

    const summaries = await runtime.getWorktreePs()

    expect(summaries.worktrees).toHaveLength(100)
    expect(summaries.worktrees.every((worktree) => worktree.agents?.length === 1)).toBe(true)
    // Why: property reads make the scaling assertion mutation-sensitive without a flaky wall-clock threshold.
    expect(pathReadCount).toBeLessThan(2_000)
  })

  it('bounds 2000 distinct malformed path misses per mobile poll', async () => {
    const remoteRepo = {
      id: 'repo-malformed-scale',
      path: '/remote',
      displayName: 'malformed-scale-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-malformed-scale'
    }
    let pathReadCount = 0
    const remoteWorktrees = Array.from({ length: 2_000 }, (_, index) => {
      const path = `/remote/worktree-${String(index).padStart(4, '0')}`
      return {
        get path() {
          pathReadCount += 1
          return path
        },
        head: `head-${index}`,
        branch: `refs/heads/worktree-${index}`,
        isBare: false,
        isMainWorktree: false
      }
    })
    const getRepo = vi.fn((id: string) => (id === remoteRepo.id ? remoteRepo : undefined))
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-malformed-scale', {
      listWorktrees: vi.fn().mockResolvedValue(remoteWorktrees)
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        Array.from({ length: 2_000 }, (_, index) => ({
          paneKey: `malformed-tab:${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          worktreeId: `${remoteRepo.id}::relative/./missing-${String(index).padStart(4, '0')}\\leaf`,
          tabId: 'malformed-tab',
          state: 'working' as const,
          prompt: `missing agent ${index}`,
          agentType: 'codex',
          connectionId: 'ssh-malformed-scale',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })

    const summaries = await runtime.getWorktreePs()

    expect(summaries).toMatchObject({ totalCount: 2_000, truncated: true })
    expect(summaries.worktrees.every((worktree) => worktree.agents?.length === 0)).toBe(true)
    expect(getRepo).toHaveBeenCalledTimes(remoteWorktrees.length)
    // Why: the prior fallback read every worktree path per distinct miss, exceeding the 3s worktree.ps poll interval at this scale.
    expect(pathReadCount).toBeLessThan(40_000)
  })

  it('caches repeated malformed path misses before normalizing them again', async () => {
    const remoteRepo = {
      id: 'repo-repeated-miss',
      path: '/remote',
      displayName: 'repeated-miss-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-repeated-miss'
    }
    const remoteWorktree = {
      path: '/remote/existing',
      head: 'head-existing',
      branch: 'refs/heads/existing',
      isBare: false,
      isMainWorktree: false
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-repeated-miss', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        Array.from({ length: 2_000 }, (_, index) => ({
          paneKey: `repeated-miss-tab:${String(index).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
          worktreeId: `${remoteRepo.id}::relative/./missing\\leaf`,
          tabId: 'repeated-miss-tab',
          state: 'working' as const,
          prompt: `repeated missing agent ${index}`,
          agentType: 'codex',
          connectionId: 'ssh-repeated-miss',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })
    const cwdSpy = vi.spyOn(process, 'cwd')

    try {
      const summaries = await runtime.getWorktreePs()

      expect(summaries.worktrees[0]?.agents).toEqual([])
      // Why: resolving a relative comparison key consults cwd; a raw miss must do that once per poll, not per agent row.
      expect(cwdSpy.mock.calls.length).toBeLessThan(50)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('keeps no-PTY agent worktrees in the truncated mobile summary', async () => {
    const remoteRepo = {
      id: 'repo-truncated-ssh',
      path: '/remote',
      displayName: 'truncated-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-truncated'
    }
    const targetPath = '/remote/zzz-live-agent'
    const remoteWorktrees = [
      ...Array.from({ length: 200 }, (_, index) => ({
        path: `/remote/inactive-${String(index).padStart(3, '0')}`,
        head: `head-${index}`,
        branch: `refs/heads/inactive-${index}`,
        isBare: false,
        isMainWorktree: false
      })),
      {
        path: targetPath,
        head: 'live-agent',
        branch: 'refs/heads/live-agent',
        isBare: false,
        isMainWorktree: false
      }
    ]
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined
    }
    registerSshGitProvider('ssh-truncated', {
      listWorktrees: vi.fn().mockResolvedValue(remoteWorktrees)
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'truncated-tab:77777777-7777-4777-8777-777777777777',
          worktreeId: `${remoteRepo.id}::${targetPath}/`,
          tabId: 'truncated-tab',
          state: 'working',
          prompt: 'live beyond the default limit',
          agentType: 'codex',
          connectionId: 'ssh-truncated',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const summaries = await runtime.getWorktreePs()
    const target = summaries.worktrees.find((worktree) => worktree.path === targetPath)

    expect(summaries).toMatchObject({ totalCount: 201, truncated: true })
    expect(summaries.worktrees).toHaveLength(200)
    expect(target).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
    expect(target?.agents).toHaveLength(1)
  })

  it('keeps pinned and unread worktrees when active rows fill the mobile summary limit', async () => {
    setPlatform('win32')
    const remoteRepo = {
      id: 'repo-pinned-limit',
      path: '/remote',
      displayName: 'pinned-limit-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-pinned-limit'
    }
    const activeWorktrees = Array.from({ length: 199 }, (_, index) => ({
      path: `relative/active-${String(index).padStart(3, '0')}`,
      head: `head-${index}`,
      branch: `refs/heads/active-${index}`,
      isBare: false,
      isMainWorktree: false
    }))
    const pinnedPath = 'relative/zzz-pinned'
    const pinnedWorktree = {
      path: pinnedPath,
      head: 'pinned',
      branch: 'refs/heads/pinned',
      isBare: false,
      isMainWorktree: false
    }
    const unreadPath = 'relative/zzz-unread'
    const unreadWorktree = {
      ...pinnedWorktree,
      path: unreadPath,
      head: 'unread',
      branch: 'refs/heads/unread'
    }
    const pinnedId = `${remoteRepo.id}::${pinnedPath}`
    const unreadId = `${remoteRepo.id}::${unreadPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [pinnedId]: makeWorktreeMeta({ isPinned: true }),
      [unreadId]: makeWorktreeMeta({ isUnread: true })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    }
    registerSshGitProvider('ssh-pinned-limit', {
      listWorktrees: vi.fn().mockResolvedValue([...activeWorktrees, pinnedWorktree, unreadWorktree])
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () =>
        activeWorktrees.map((worktree, index) => ({
          paneKey: `active-tab:${String(index).padStart(8, '0')}-8888-4888-8888-888888888888`,
          worktreeId: `${remoteRepo.id}::${worktree.path.replace('relative/', 'relative/./')}`,
          tabId: 'active-tab',
          state: 'working' as const,
          prompt: 'active row',
          agentType: 'codex',
          connectionId: 'ssh-pinned-limit',
          receivedAt: now,
          stateStartedAt: now - 100
        }))
    })

    const summaries = await runtime.getWorktreePs()

    expect(summaries).toMatchObject({ totalCount: 201, truncated: true })
    expect(summaries.worktrees).toHaveLength(200)
    expect(summaries.worktrees.find((worktree) => worktree.worktreeId === pinnedId)).toMatchObject({
      isPinned: true,
      hasHostSidebarActivity: false
    })
    expect(summaries.worktrees.find((worktree) => worktree.worktreeId === unreadId)).toMatchObject({
      unread: true,
      hasHostSidebarActivity: false
    })
    expect(
      worktreePathComparison.worktreePathComparisonKey(activeWorktrees[0]!.path, 'linux')
    ).toBe(
      worktreePathComparison.worktreePathComparisonKey(
        activeWorktrees[0]!.path.replace('relative/', 'relative/./'),
        'linux'
      )
    )
  })

  it('clears stale working status after the agent exits and the shell takes over the title', async () => {
    // Why (#1437): sticky lastAgentStatus left the spinner on 'working' after agent exit; recompute from the live OSC title each call.
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex working',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const working = await runtime.getWorktreePs()
    expect(working.worktrees[0].status).toBe('working')

    // Agent exits, shell title takes over — mobile must flip to 'active' like desktop's getWorktreeStatus.
    runtime.onPtyData('pty-1', '\x1b]0;bash\x07', 200)
    const afterExit = await runtime.getWorktreePs()
    expect(afterExit.worktrees[0].status).toBe('active')
  })

  it('shows worktree.ps active when the current pane is the Claude agents screen', async () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('active')
  })

  it('shows worktree.ps working when the current pane supersedes a Claude agents OSC title', async () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('working')
  })

  it('fails terminal stop closed while the renderer graph is reloading', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.markRendererReloading(1)

    await expect(runtime.stopTerminalsForWorktree('id:repo-1::/tmp/worktree-a')).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(killed).toBe(false)
  })

  it('stops by exact id when the selector no longer resolves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    // An orphaned workspace's repo is gone, so only the caller's id can identify it.
    await expect(
      runtime.stopTerminalsForWorktree('id:repo-gone::/tmp/gone', {
        resolvedWorktreeId: TEST_WORKTREE_ID
      })
    ).resolves.toEqual({ stopped: 1 })
    expect(kill).toHaveBeenCalledWith('pty-1')
  })

  it('does not sweep a sibling workspace sharing the checkout dir of an exact id', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    // Regression for #10252: folder-workspace instances share one checkout dir, so comparing
    // filesystem paths (which strip `::workspace:<uuid>`) would match the root and its siblings
    // and kill their live terminals.
    await expect(
      runtime.stopTerminalsForWorktree('id:repo-gone::/tmp/gone', {
        resolvedWorktreeId: `${TEST_WORKTREE_ID}::workspace:11111111-1111-1111-1111-111111111111`
      })
    ).resolves.toEqual({ stopped: 0 })
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not sweep a same-id terminal owned by another connection', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    await expect(
      runtime.stopTerminalsForWorktree('id:repo-gone::/tmp/gone', {
        resolvedWorktreeId: TEST_WORKTREE_ID,
        resolvedConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({ stopped: 0 })
    expect(kill).not.toHaveBeenCalled()
  })

  it('stops only the owning connection when one worktree id lives on two hosts', async () => {
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, null)
    // The store keeps one `repoId::path` per host, so deleting the SSH copy must leave the
    // local copy's terminals running — the fence the destructive removal paths now supply.
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-1')
    runtime.registerPty('pty-local', TEST_WORKTREE_ID, null)

    await expect(
      runtime.stopTerminalsForWorktree(TEST_WORKTREE_ID, {
        resolvedWorktreeId: TEST_WORKTREE_ID,
        resolvedConnectionId: 'ssh-1'
      })
    ).resolves.toEqual({ stopped: 1 })
    expect(kill).toHaveBeenCalledWith('pty-ssh')
    expect(kill).not.toHaveBeenCalledWith('pty-local')
  })

  it('awaits physical PTY stop when destructive teardown supplies shared dedupe', async () => {
    const runtime = new OrcaRuntimeService(store)
    const physicalStop = makeDeferred()
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => {
      await physicalStop.promise
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)
    const stopPty = vi.fn(async (_ptyId: string, stop: () => boolean | Promise<boolean>) => ({
      stopped: await stop(),
      owner: true
    }))

    const stopping = runtime.stopTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, { stopPty })
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledWith('pty-1'))
    expect(kill).not.toHaveBeenCalled()
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    physicalStop.resolve()
    await expect(stopping).resolves.toEqual({ stopped: 1 })
  })

  it('passes a margin-adjusted RPC deadline into stopAndWait for destructive teardown', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)
    const stopPty = vi.fn(async (_ptyId: string, stop: () => boolean | Promise<boolean>) => ({
      stopped: await stop(),
      owner: true
    }))

    // Why: the runtime-graph sweep must bound the underlying shutdown/list RPCs
    // below the sweep deadline, or a wedged daemon trips the outer sweep deadline.
    const deadline = Date.now() + WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
    await expect(
      runtime.stopTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, { deadline, stopPty })
    ).resolves.toEqual({ stopped: 1 })

    expect(stopAndWait).toHaveBeenCalledTimes(1)
    const [ptyId, opts] = stopAndWait.mock.calls[0] as unknown as [
      string,
      { deadlineMs?: number } | undefined
    ]
    expect(ptyId).toBe('pty-1')
    // Pin the margin: RPCs must settle WORKTREE_TEARDOWN_RPC_MARGIN_MS before the
    // sweep deadline so the accurate stop failure outruns the sweep-timeout error.
    expect(opts?.deadlineMs).toBe(deadline - WORKTREE_TEARDOWN_RPC_MARGIN_MS)
  })

  it('fails terminal listing closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const listPromise = runtime.listTerminals('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(listPromise).rejects.toThrow('runtime_unavailable')
  })

  it('fails terminal stop closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(stopPromise).rejects.toThrow('runtime_unavailable')
    expect(killed).toBe(false)
  })

  it('does not stop a reused PTY after the teardown deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const killed = vi.fn(() => true)
      runtime.setPtyController({
        write: () => true,
        kill: killed,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Claude',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'reused-pty'
          }
        ]
      })

      let releaseListWorktrees = () => {}
      vi.mocked(listWorktrees).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
          })
      )
      const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo', {
        deadline: Date.now() + 25
      })

      await vi.advanceTimersByTimeAsync(25)
      releaseListWorktrees()

      await expect(stopPromise).resolves.toEqual({ stopped: 0 })
      expect(killed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sleeps every freshly discovered worktree PTY without a hydrated renderer graph', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [
      [
        { id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' },
        { id: 'pty-2', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual(
          expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
        )
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 2,
      stoppedPtyIds: ['pty-1', 'pty-2'],
      livePtyIds: ['pty-1', 'pty-2'],
      postStopVerified: true
    })
    expect(stopped).toEqual(['pty-1', 'pty-2'])
  })

  it('uses provider-owned worktree identity when a PTY cwd has drifted', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    const processLists = [
      [
        {
          id: 'opaque-pty-id',
          cwd: '/tmp/outside-the-worktree',
          title: 'Shell',
          worktreeId: TEST_WORKTREE_ID
        }
      ],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stoppedPtyIds: ['opaque-pty-id'], postStopVerified: true })
    expect(stopAndWait).toHaveBeenCalledWith(
      'opaque-pty-id',
      expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
    )
  })

  it('sleeps a Windows-equivalent provider worktree identity after one request', async () => {
    const windowsPath = 'C:\\Repo\\Feature'
    const windowsWorktreeId = `${TEST_REPO_ID}::${windowsPath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: windowsPath,
        head: 'windows-head',
        branch: 'feature/windows',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(store)
    const processLists = [
      [
        {
          id: 'windows-pty',
          cwd: 'C:/REPO/FEATURE',
          title: 'Shell',
          worktreeId: `${TEST_REPO_ID}::c:/repo/feature`
        }
      ],
      []
    ]
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${windowsWorktreeId}`)
    ).resolves.toMatchObject({ stoppedPtyIds: ['windows-pty'], postStopVerified: true })
    expect(stopAndWait).toHaveBeenCalledWith(
      'windows-pty',
      expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
    )
  })

  it('prefers migrated persisted ownership over a provider worktree id frozen at spawn', async () => {
    const priorWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-before-rename`
    const migratedPtyId = `${priorWorktreeId}@@daemon-controller-pty`
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: migratedPtyId })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const processLists = [
      [
        {
          id: migratedPtyId,
          cwd: '/tmp/outside-the-worktree',
          title: 'Shell',
          worktreeId: priorWorktreeId
        }
      ],
      []
    ]
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stoppedPtyIds: [migratedPtyId], postStopVerified: true })
    expect(stopAndWait).toHaveBeenCalledWith(
      migratedPtyId,
      expect.objectContaining({ keepHistory: true, deadlineMs: expect.any(Number) })
    )
  })

  it('treats an already-sleeping worktree as a verified idempotent success', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })

    const first = await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const retry = await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(first).toEqual({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: [],
      postStopVerified: true
    })
    expect(retry).toEqual(first)
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('fails worktree sleep closed when fresh host liveness is unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('daemon unavailable')
      }
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_liveness_unavailable'
    )
  })

  it('surfaces physical worktree PTY stop failure', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => false),
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }]
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).rejects.toThrow(
      'terminal_worktree_sleep_failed'
    )
  })

  it('stops only PTYs owned by the selected worktree', async () => {
    const otherWorktreePath = '/tmp/worktree-b'
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: otherWorktreePath,
        head: 'def',
        branch: 'feature/other',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const otherPty = { id: 'pty-other', cwd: otherWorktreePath, title: 'Other' }
    const processLists = [
      [{ id: 'pty-target', cwd: TEST_WORKTREE_PATH, title: 'Target' }, otherPty],
      [otherPty]
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? [otherPty]
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stoppedPtyIds: ['pty-target'], postStopVerified: true })
    expect(stopped).toEqual(['pty-target'])
  })

  it('does not stop a provider-owned foreign PTY referenced by stale target state', async () => {
    const otherWorktreePath = '/tmp/worktree-b'
    const otherWorktreeId = `${TEST_REPO_ID}::${otherWorktreePath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: otherWorktreePath,
        head: 'def',
        branch: 'feature/other',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'pty-foreign' })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-foreign',
          cwd: otherWorktreePath,
          title: 'Other',
          worktreeId: otherWorktreeId
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'stale-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Stale',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'stale-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-foreign'
        }
      ]
    })

    const projectedTarget = (await runtime.getWorktreePs()).worktrees.find(
      (worktree) => worktree.worktreeId === TEST_WORKTREE_ID
    )
    expect(projectedTarget).toMatchObject({ liveTerminalCount: 0, hasAttachedPty: false })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 0,
      stoppedPtyIds: [],
      livePtyIds: [],
      postStopVerified: true
    })
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('fails closed for an unresolved explicit foreign provider owner', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'opaque-foreign-pty' })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'opaque-foreign-pty',
          cwd: TEST_WORKTREE_PATH,
          title: 'Other',
          worktreeId: `${TEST_REPO_ID}::/temporarily-unresolved-foreign-worktree`
        }
      ]
    })

    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('reports a PTY that remains live after acknowledged worktree sleep', async () => {
    const runtime = new OrcaRuntimeService(store)
    const liveProcess = { id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => [liveProcess]
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_worktree_sleep_still_live',
      remainingLivePtyIds: ['pty-1']
    })
  })

  it('reports unavailable post-stop liveness instead of assuming convergence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const clientEvents: RuntimeClientEvent[][] = [[], []]
    for (const events of clientEvents) {
      runtime.onClientEvent((event) => events.push(event))
    }
    let listCount = 0
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        listCount += 1
        if (listCount === 2) {
          throw new Error('daemon unavailable')
        }
        return listCount === 1 ? [{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }] : []
      }
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_liveness_unavailable'
    })
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
    for (const events of clientEvents) {
      expect(
        events
          .filter(
            (event): event is Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }> =>
              event.type === 'worktreeTerminalSleepState'
          )
          .filter((event) => event.phase === 'committed')
          .flatMap((event) => event.ptyIds)
      ).toContain('pty-1')
      expect(
        events.some(
          (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'cancelled'
        )
      ).toBe(false)
    }
  })

  it('coalesces two clients sleeping the same host worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const initialInventory = deferred<{ id: string; cwd: string; title: string }[]>()
    const listProcesses = vi
      .fn()
      .mockImplementationOnce(() => initialInventory.promise)
      .mockResolvedValueOnce([])
    const stopAndWait = vi.fn(async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const first = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const second = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    initialInventory.resolve([{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }])

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(stopAndWait).toHaveBeenCalledTimes(1)
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })

  it('serializes a new terminal spawn behind physical sleep convergence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stop = deferred<boolean>()
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'pty-before-sleep', cwd: TEST_WORKTREE_PATH, title: 'Shell' }])
      .mockResolvedValueOnce([])
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        const result = await stop.promise
        runtime.onPtyExit(ptyId, -1)
        return result
      },
      getForegroundProcess: async () => null,
      listProcesses
    })

    const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1))
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'started', ptyIds: ['pty-before-sleep'] })
    ])
    let spawnLeaseAcquired = false
    const spawnLease = runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID).then((release) => {
      spawnLeaseAcquired = true
      return release
    })
    await Promise.resolve()
    expect(spawnLeaseAcquired).toBe(false)

    stop.resolve(true)
    await expect(sleep).resolves.toMatchObject({ postStopVerified: true })
    const releaseSpawn = await spawnLease
    expect(spawnLeaseAcquired).toBe(true)
    releaseSpawn()
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([])
    expect(
      events
        .filter((event) => event.type === 'worktreeTerminalSleepState')
        .map((event) => event.phase)
    ).toEqual(['started', 'committed', 'woken'])
  })

  it('waits for an in-flight spawn before inventorying worktree sleep', async () => {
    const runtime = new OrcaRuntimeService(store)
    const listProcesses = vi.fn().mockResolvedValue([])
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null,
      listProcesses
    })
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)

    const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await Promise.resolve()
    expect(listProcesses).not.toHaveBeenCalled()
    releaseSpawn()

    await expect(sleep).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it('expires while queued behind a spawn and never stops it later', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const listProcesses = vi.fn().mockResolvedValue([])
      const stopAndWait = vi.fn(async () => true)
      runtime.setPtyController({
        write: () => true,
        kill: () => false,
        stopAndWait,
        getForegroundProcess: async () => null,
        listProcesses
      })
      const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)

      const sleep = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      const rejection = expect(sleep).rejects.toThrow('terminal_worktree_sleep_timeout')
      await vi.advanceTimersByTimeAsync(12_001)
      await rejection
      releaseSpawn()
      await Promise.resolve()

      expect(listProcesses).not.toHaveBeenCalled()
      expect(stopAndWait).not.toHaveBeenCalled()
      const releaseNextSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
      releaseNextSpawn()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the worktree terminal mutation when a wake client-event listener throws', async () => {
    const runtime = new OrcaRuntimeService(store)
    const secondListenerEvents: RuntimeClientEvent[] = []
    // Why: a broken paired-client relay can throw synchronously while delivering the wake
    // notification. That must not abort the wake or (regression) leak the per-worktree terminal
    // mutation acquired in acquireWorktreeTerminalSpawn, or every later sleep wedges for 12s.
    runtime.onClientEvent((event) => {
      if (event.type === 'worktreeTerminalSleepState' && event.phase === 'woken') {
        throw new Error('relay_send_failed')
      }
    })
    runtime.onClientEvent((event) => secondListenerEvents.push(event))
    const processLists = [[{ id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' }], [], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    // Sleep leaves the worktree in a 'sleeping' state so the next spawn emits the 'woken' event.
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

    // The wake acquires the mutation and emits 'woken'; a throwing subscriber must not surface.
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
    releaseSpawn()

    // Isolation: the second subscriber still received the 'woken' event.
    expect(
      secondListenerEvents.some(
        (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'woken'
      )
    ).toBe(true)

    // Regression: the mutation was released, so a subsequent sleep converges instead of throwing
    // terminal_worktree_sleep_timeout.
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ postStopVerified: true })
  })

  it('isolates a throwing subscriber across runtime listener fan-out', () => {
    const runtime = new OrcaRuntimeService(store)
    const delivered: number[] = []
    // Why: the shared notifyRuntimeListeners guard must let sibling fan-outs (here mobile
    // notifications) survive a throwing subscriber, not just the client-event path.
    runtime.onNotificationDispatched(() => {
      throw new Error('subscriber_send_failed')
    })
    runtime.onNotificationDispatched((event) => {
      delivered.push(event.notificationSeq ?? -1)
    })

    expect(() =>
      runtime.dispatchMobileNotification({
        type: 'notification',
        source: 'test',
        title: 'Test',
        body: 'Body',
        worktreeId: TEST_WORKTREE_ID
      })
    ).not.toThrow()

    // The second subscriber still received the event despite the first throwing.
    expect(delivered).toHaveLength(1)
  })

  it('keeps the original committed disposition across an idempotent retry', async () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const processLists = [
      [{ id: 'pty-preserved-history', cwd: TEST_WORKTREE_PATH, title: 'Shell' }],
      [],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-preserved-history'] })
    ])
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(TEST_WORKTREE_ID)
    releaseSpawn()

    const sleepEvents = events.filter((event) => event.type === 'worktreeTerminalSleepState')
    expect(sleepEvents.map((event) => event.phase)).toEqual(['started', 'committed', 'woken'])
    expect(sleepEvents.at(-1)?.ptyIds).toEqual(['pty-preserved-history'])
  })

  it('keeps concurrent sleep coalesced until every launched stop settles', async () => {
    const runtime = new OrcaRuntimeService(store)
    const clientEvents: RuntimeClientEvent[][] = [[], []]
    for (const events of clientEvents) {
      runtime.onClientEvent((event) => events.push(event))
    }
    const secondStop = deferred<boolean>()
    const failedPty = { id: 'pty-fails', cwd: TEST_WORKTREE_PATH, title: 'Claude' }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([
        failedPty,
        { id: 'pty-slow', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ])
      .mockResolvedValueOnce([failedPty])
      .mockResolvedValueOnce([failedPty])
      .mockResolvedValueOnce([])
    let failedAttempts = 0
    const stopAndWait = vi.fn(async (ptyId: string) => {
      if (ptyId === 'pty-fails') {
        failedAttempts += 1
        if (failedAttempts === 1) {
          throw new Error('stop failed')
        }
        runtime.onPtyExit(ptyId, -1)
        return true
      }
      const stopped = await secondStop.promise
      runtime.onPtyExit(ptyId, -1)
      return stopped
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const first = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledTimes(2))
    const concurrent = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    secondStop.resolve(true)

    await expect(first).rejects.toThrow('terminal_worktree_sleep_failed')
    await expect(concurrent).rejects.toThrow('terminal_worktree_sleep_failed')
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-slow'] })
    ])
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ postStopVerified: true, stoppedPtyIds: ['pty-fails'] })
    expect(stopAndWait).toHaveBeenCalledTimes(3)
    for (const events of clientEvents) {
      const sleepEvents = events.filter(
        (event): event is Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }> =>
          event.type === 'worktreeTerminalSleepState'
      )
      expect(
        [
          ...new Set(
            sleepEvents
              .filter((event) => event.phase === 'committed')
              .flatMap((event) => event.ptyIds)
          )
        ].sort()
      ).toEqual(['pty-fails', 'pty-slow'])
      expect(
        sleepEvents.filter((event) => event.phase === 'cancelled').flatMap((event) => event.ptyIds)
      ).toEqual(['pty-fails'])
    }
  })

  it('stops exactly the expected live PTYs for a worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual({ keepHistory: true })
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'], {
        keepHistory: true
      })
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: true
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('reports recoverable post-stop liveness failure after exact terminal stop', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [
      [{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }],
      new Error('daemon unavailable')
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        const next = processLists.shift()
        if (next instanceof Error) {
          throw next
        }
        return next ?? []
      }
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_liveness_unavailable'
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('rejects exact terminal stop when async PTY stop fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual({ keepHistory: true })
        return false
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }]
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'], {
        keepHistory: true
      })
    ).rejects.toThrow('terminal_exact_stop_failed')
    expect(stopped).toEqual(['pty-1'])
  })

  it('rejects exact terminal stop when the live PTY set has extras', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' },
        { id: 'pty-shell', cwd: '/tmp/worktree-a', title: 'Shell' }
      ]
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-2',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Shell',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-2',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-shell'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).rejects.toThrow('terminal_stop_pty_set_mismatch')
    expect(stopped).toEqual([])
  })

  it('allows target-only exact terminal stop when sibling PTYs remain live', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [
      [
        { id: 'pty-1', cwd: TEST_WORKTREE_PATH, title: 'Claude' },
        { id: 'pty-shell', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ],
      [{ id: 'pty-shell', cwd: TEST_WORKTREE_PATH, title: 'Shell' }]
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId, opts) => {
        stopped.push(ptyId)
        expect(opts).toEqual({ keepHistory: true })
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-2',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-2',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-shell'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`, ['pty-1'], {
        keepHistory: true,
        targetOnly: true
      })
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1', 'pty-shell'],
      postStopVerified: true,
      remainingLivePtyIds: ['pty-shell']
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('rejects exact terminal stop for multiple expected PTYs before stopping anything', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' },
        { id: 'pty-2', cwd: '/tmp/worktree-a', title: 'Codex' }
      ]
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1', 'pty-2'])
    ).rejects.toThrow('terminal_exact_stop_requires_single_pty')
    expect(stopped).toEqual([])
  })

  it('uses fresh post-stop liveness instead of stale renderer leaves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        },
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'stale-pty'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).resolves.toMatchObject({
      stoppedPtyIds: ['pty-1']
    })
    expect(stopped).toEqual(['pty-1'])
  })

  it('omits stale renderer leaves when fresh PTY liveness is required', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Stale',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'stale-pty'
        }
      ]
    })

    const terminals = await runtime.listTerminals('id:repo-1::/tmp/worktree-a', undefined, {
      requireFreshPtyLiveness: true
    })

    expect(terminals.terminals).toEqual([])
  })

  it('omits unbound renderer placeholders when fresh PTY liveness is required', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Sleeping terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`, undefined, {
      requireFreshPtyLiveness: true
    })

    expect(terminals).toMatchObject({ terminals: [], totalCount: 0 })
  })

  it('fails terminal listing closed when fresh PTY liveness is required and unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('provider unavailable')
      }
    })

    await expect(
      runtime.listTerminals('id:repo-1::/tmp/worktree-a', undefined, {
        requireFreshPtyLiveness: true
      })
    ).rejects.toThrow('terminal_liveness_unavailable')
  })
})
