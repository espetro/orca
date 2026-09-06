/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  MOCK_GIT_WORKTREES,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_FOLDER_WORKSPACE_PATH,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createFolderWorkspaceRuntimeStore,
  deferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  resetRuntimeTestMocks,
  store,
  syncSinglePty,
  withPlatform
} from './orca-runtime-test-fixture'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { listWorktrees } from '../git/worktree'
import { registerSshGitProvider } from '../providers/ssh-git-dispatch'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)
describe('OrcaRuntimeService', () => {
  it('builds a compact worktree summary from persisted and live runtime state', async () => {
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
    runtime.onPtyData('pty-1', 'build green\n', 321)

    const summaries = await runtime.getWorktreePs()
    expect(summaries).toEqual({
      worktrees: [
        {
          workspaceKind: 'git',
          worktreeId: 'repo-1::/tmp/worktree-a',
          repoId: 'repo-1',
          hostId: 'local',
          terminalPlatform: process.platform,
          repo: 'repo',
          path: '/tmp/worktree-a',
          branch: 'feature/foo',
          isArchived: false,
          isMainWorktree: false,
          hasHostSidebarActivity: true,
          parentWorktreeId: null,
          childWorktreeIds: [],
          displayName: 'foo',
          workspaceStatus: 'in-progress',
          sortOrder: 0,
          linkedIssue: 123,
          linkedPR: null,
          linkedLinearIssue: null,
          linkedGitLabMR: null,
          linkedGitLabIssue: null,
          comment: '',
          isPinned: false,
          isActive: false,
          status: 'active',
          unread: false,
          liveTerminalCount: 1,
          hasAttachedPty: true,
          lastActivityAt: 0,
          lastOutputAt: 321,
          preview: 'build green',
          agents: []
        }
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('reads the linked-PR state from the renderer repoId-keyed GitHub cache', async () => {
    // Regression: renderer keys the PR cache by repoId::branch; reading by path::branch missed every entry (muted mobile badge).
    const runtimeStore = {
      ...store,
      getGitHubCache: () => ({
        pr: {
          [`${TEST_REPO_ID}::feature/foo`]: {
            data: { number: 42, state: 'merged' },
            fetchedAt: 1
          }
        },
        issue: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.linkedPR).toEqual({ number: 42, state: 'merged' })
  })

  it('carries persisted worktree host ownership in mobile summaries', async () => {
    const metaById = {
      [TEST_WORKTREE_ID]: {
        ...store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        hostId: 'runtime:owner-runtime' as const
      }
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)).toMatchObject({
      repoId: TEST_REPO_ID,
      hostId: 'runtime:owner-runtime'
    })
  })

  it('emits only instance- and boundary-validated lineage parents in mobile summaries', async () => {
    // Regression: shipped mobile clients trust parentWorktreeId blindly, so worktree.ps must not emit stale same-path lineage.
    const parentPath = join(tmpdir(), 'worktree-parent')
    const validChildPath = join(tmpdir(), 'worktree-child-valid')
    const staleChildPath = join(tmpdir(), 'worktree-child-stale')
    const crossHostChildPath = join(tmpdir(), 'worktree-child-cross-host')
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const validChildId = `${TEST_REPO_ID}::${validChildPath}`
    const staleChildId = `${TEST_REPO_ID}::${staleChildPath}`
    const crossHostChildId = `${TEST_REPO_ID}::${crossHostChildPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        hostId: 'local',
        projectId: 'project-a'
      }),
      [validChildId]: makeWorktreeMeta({
        instanceId: 'child-instance',
        hostId: 'local',
        projectId: 'project-a'
      }),
      // The stale child path was reused by a replacement checkout.
      [staleChildId]: makeWorktreeMeta({ instanceId: 'replacement-instance' }),
      [crossHostChildId]: makeWorktreeMeta({
        instanceId: 'cross-host-child-instance',
        hostId: 'runtime:other-host',
        projectId: 'project-a'
      })
    }
    const makeLineage = (childId: string, worktreeInstanceId: string): WorktreeLineage => ({
      worktreeId: childId,
      worktreeInstanceId,
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    })
    const lineageById: Record<string, WorktreeLineage> = {
      [validChildId]: makeLineage(validChildId, 'child-instance'),
      [staleChildId]: makeLineage(staleChildId, 'old-child-instance'),
      [crossHostChildId]: makeLineage(crossHostChildId, 'cross-host-child-instance')
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById,
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId]
    }
    vi.mocked(listWorktrees).mockResolvedValue(
      [parentPath, validChildPath, staleChildPath, crossHostChildPath].map((path) => ({
        path,
        head: 'abc',
        branch: `feature/${basename(path)}`,
        isBare: false,
        isMainWorktree: false
      }))
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees.find((worktree) => worktree.worktreeId === validChildId)).toMatchObject({
      parentWorktreeId: parentId,
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'parent-instance'
    })
    const staleSummary = worktrees.find((worktree) => worktree.worktreeId === staleChildId)
    expect(staleSummary).toMatchObject({
      parentWorktreeId: null,
      worktreeInstanceId: 'replacement-instance'
    })
    expect(staleSummary?.lineageWorktreeInstanceId).toBeUndefined()
    expect(staleSummary?.parentWorktreeInstanceId).toBeUndefined()
    const crossHostSummary = worktrees.find((worktree) => worktree.worktreeId === crossHostChildId)
    expect(crossHostSummary).toMatchObject({
      parentWorktreeId: null,
      worktreeInstanceId: 'cross-host-child-instance'
    })
    expect(crossHostSummary?.lineageWorktreeInstanceId).toBeUndefined()
    expect(crossHostSummary?.parentWorktreeInstanceId).toBeUndefined()
    expect(worktrees.find((worktree) => worktree.worktreeId === parentId)).toMatchObject({
      childWorktreeIds: [validChildId]
    })
  })

  it('resolves WSL platforms only for repos represented in mobile summaries', async () => {
    await withPlatform('win32', async () => {
      const primaryRepo = store.getRepos()[0]!
      let repos = [
        primaryRepo,
        ...Array.from({ length: 100 }, (_, index) => ({
          ...primaryRepo,
          id: `repo-represented-${index}`,
          path: `C:\\repo-represented-${index}`,
          displayName: `repo-represented-${index}`
        }))
      ]
      const getProjects = vi.fn(() =>
        repos.slice(0, 101).map((repo, index) => ({
          id: `project-${index}`,
          displayName: repo.displayName,
          badgeColor: 'blue',
          sourceRepoIds: [repo.id],
          localWindowsRuntimePreference:
            index === 0
              ? ({ kind: 'wsl' as const, distro: 'Ubuntu' } as const)
              : ({ kind: 'windows-host' as const } as const),
          createdAt: 0,
          updatedAt: 0
        }))
      )
      const getSettings = vi.fn(() => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' as const }
      }))
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => repos,
        getProjects,
        getSettings
      } as never)

      const { worktrees } = await runtime.getWorktreePs()

      expect(worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)).toMatchObject({
        repoId: TEST_REPO_ID,
        terminalPlatform: 'linux'
      })
      expect(getProjects).toHaveBeenCalledTimes(1)
      expect(getSettings).toHaveBeenCalledTimes(2)
      getProjects.mockClear()
      getSettings.mockClear()
      repos = [
        ...repos,
        ...Array.from({ length: 2_000 }, (_, index) => ({
          ...repos[0]!,
          id: `repo-unresolved-${index}`,
          path: `C:\\repo-unresolved-${index}`,
          displayName: `repo-unresolved-${index}`
        }))
      ]

      await runtime.getWorktreePs()

      // Why: the cache already owns the batch-resolved platforms; newly persisted repos must not trigger another scan.
      expect(getProjects).not.toHaveBeenCalled()
      expect(getSettings).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps each worktree poll paired with its platform generation', async () => {
    await withPlatform('win32', async () => {
      let runtimePreference: { kind: 'wsl'; distro: string } | { kind: 'windows-host' } = {
        kind: 'wsl',
        distro: 'Ubuntu'
      }
      const runtimeStore = {
        ...store,
        getProjects: () => [
          {
            id: 'project-generation',
            displayName: 'generation',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: runtimePreference,
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          localWindowsRuntimeDefault: { kind: 'windows-host' as const }
        })
      }
      const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
      vi.mocked(listWorktrees)
        .mockImplementationOnce(() => staleScan.promise)
        .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      const runtime = new OrcaRuntimeService(runtimeStore as never)

      const stalePoll = runtime.getWorktreePs()
      runtimePreference = { kind: 'windows-host' }
      runtime.notifyBranchRenamed(TEST_REPO_ID)
      const freshPoll = await runtime.getWorktreePs()
      staleScan.resolve(MOCK_GIT_WORKTREES)
      const staleResult = await stalePoll

      // Why: invalidation can let a newer scan finish first; each result keeps the platform map from its own generation.
      expect(staleResult.worktrees[0]).toMatchObject({ terminalPlatform: 'linux' })
      expect(freshPoll.worktrees[0]).toMatchObject({ terminalPlatform: 'win32' })
    })
  })

  it('omits worktrees hidden by the host visibility policy from mobile summaries', async () => {
    const hiddenExternalRepo = {
      ...store.getRepos()[0],
      externalWorktreeVisibility: 'hide' as const,
      externalWorktreeVisibilityLegacy: false
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [hiddenExternalRepo],
      getRepo: () => hiddenExternalRepo
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.getWorktreePs()).resolves.toMatchObject({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })
  })

  it('applies linked-checkout source visibility to mobile summaries', async () => {
    const linkedPath = '/tmp/linked'
    const scratchPath = `${linkedPath}/.claude/worktrees/review`
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: linkedPath,
        head: 'linked',
        branch: 'feature/linked',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: scratchPath,
        head: 'scratch',
        branch: 'feature/review',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const makeRuntime = (externalWorktreeVisibility: 'hide' | 'show', claude: 'hide' | 'show') => {
      const repo = {
        ...store.getRepos()[0],
        externalWorktreeVisibility,
        externalWorktreeVisibilityLegacy: false,
        worktreeVisibilitySourcePreferences: { builtIn: { claude, gsd: 'hide' as const } }
      }
      return new OrcaRuntimeService({
        ...store,
        getRepos: () => [repo],
        getRepo: () => repo
      } as never)
    }

    const hiddenSource = await makeRuntime('show', 'hide').getWorktreePs()
    const shownSource = await makeRuntime('hide', 'show').getWorktreePs()

    expect(hiddenSource.worktrees.map((worktree) => worktree.path)).not.toContain(scratchPath)
    expect(shownSource.worktrees.map((worktree) => worktree.path)).toContain(scratchPath)
  })

  it('resolves files through a source-visible linked-checkout worktree', async () => {
    const linkedPath = '/tmp/linked'
    const scratchPath = `${linkedPath}/.claude/worktrees/review`
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: linkedPath,
        head: 'linked',
        branch: 'feature/linked',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: scratchPath,
        head: 'scratch',
        branch: 'feature/review',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const repo = {
      ...store.getRepos()[0],
      externalWorktreeVisibility: 'hide' as const,
      externalWorktreeVisibilityLegacy: false,
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show' as const, gsd: 'hide' as const }
      }
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo
    } as never)

    const target = await (
      runtime as unknown as {
        resolveKnownWorkspaceFileTarget: (
          path: string,
          executionHostId: 'local'
        ) => Promise<{ worktree: { path: string }; relativePath: string } | null>
      }
    ).resolveKnownWorkspaceFileTarget(`${scratchPath}/src/app.ts`, 'local')

    expect(target).toMatchObject({
      worktree: { path: scratchPath },
      relativePath: 'src/app.ts'
    })
  })

  it('applies global custom-source visibility to mobile summaries and file resolution', async () => {
    const globalRoot = '/tmp/global-worktrees'
    const globalWorktreePath = `${globalRoot}/review`
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: globalWorktreePath,
        head: 'review',
        branch: 'feature/review',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const repo = {
      ...store.getRepos()[0],
      externalWorktreeVisibility: 'hide' as const,
      externalWorktreeVisibilityLegacy: false
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo,
      getSettings: () => ({
        ...store.getSettings(),
        worktreeVisibilityDefaults: {
          external: 'hide' as const,
          customSources: [{ id: 'global', rootPath: globalRoot }],
          sourcePreferences: { custom: { global: 'show' as const } }
        }
      })
    } as never)

    const summaries = await runtime.getWorktreePs()
    const target = await (
      runtime as unknown as {
        resolveKnownWorkspaceFileTarget: (
          path: string,
          executionHostId: 'local'
        ) => Promise<{ worktree: { path: string }; relativePath: string } | null>
      }
    ).resolveKnownWorkspaceFileTarget(`${globalWorktreePath}/src/app.ts`, 'local')

    expect(summaries.worktrees.map((worktree) => worktree.path)).toContain(globalWorktreePath)
    expect(target).toMatchObject({
      worktree: { path: globalWorktreePath },
      relativePath: 'src/app.ts'
    })
  })

  it('marks saved session tabs with live PTYs as host sidebar activity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID)
    runtime.onPtyData('persisted-pty', 'ready\n', 456)

    const { worktrees } = await runtime.getWorktreePs()
    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true,
      status: 'active',
      liveTerminalCount: 1
    })
  })

  it('attributes live legacy PTYs from saved layout bindings when their panes are hidden', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          ptyId: null
        }))
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null),
      // Legacy local PTYs have opaque ids and the local provider cannot recover cwd.
      listProcesses: vi.fn(async () => [{ id: 'persisted-pty', cwd: '', title: 'shell' }])
    })

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true,
      hasAttachedPty: true,
      liveTerminalCount: 1
    })
  })

  it('prefers migrated layout ownership over a worktree id frozen in the PTY id', async () => {
    const priorWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-before-rename`
    const migratedPtyId = `${priorWorktreeId}@@daemon-controller-pty`
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          ptyId: null
        }))
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: migratedPtyId })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null),
      listProcesses: vi.fn(async () => [{ id: migratedPtyId, cwd: '', title: 'shell' }])
    })

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true,
      hasAttachedPty: true,
      liveTerminalCount: 1
    })
  })

  it('does not project persisted wake identifiers as live terminal activity', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      activeWorktreeIdsOnShutdown: [TEST_WORKTREE_ID]
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null),
      listProcesses: vi.fn(async () => [])
    })

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      status: 'inactive'
    })
  })

  it('projects zero after sleep despite stale renderer leaves and persisted tabs', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const processLists = [
      [{ id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Shell' }],
      [],
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
    runtime.attachWindow(1)
    const publishStaleGraph = (): void => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Shell',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'persisted-pty'
          }
        ]
      })
    }
    publishStaleGraph()

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    // Why: another connected client can republish a pre-sleep graph after physical teardown.
    publishStaleGraph()
    const firstObserver = await runtime.getWorktreePs()
    const secondObserver = await runtime.getWorktreePs()

    for (const result of [firstObserver, secondObserver]) {
      expect(result.worktrees[0]).toMatchObject({
        worktreeId: TEST_WORKTREE_ID,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        status: 'inactive'
      })
    }
  })

  it('marks saved browser tabs as host sidebar activity like desktop', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        browserTabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'browser-1',
              worktreeId: TEST_WORKTREE_ID,
              url: 'https://example.com',
              title: 'Example',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true
    })
  })

  it('falls back to the path-keyed GitHub cache entry', async () => {
    const runtimeStore = {
      ...store,
      getGitHubCache: () => ({
        pr: {
          [`${TEST_REPO_PATH}::feature/foo`]: {
            data: { number: 7, state: 'open' },
            fetchedAt: 1
          }
        },
        issue: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.linkedPR).toEqual({ number: 7, state: 'open' })
  })

  it('includes folder workspaces in compact worktree summaries for mobile', async () => {
    const folderWorkspace = makeFolderWorkspace({
      name: 'GG',
      comment: 'dujiao-next-eval'
    })
    const projectGroup = makeFolderProjectGroup({ name: 'Store' })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )

    const { worktrees } = await runtime.getWorktreePs()
    const folderSummary = worktrees.find(
      (worktree) => worktree.worktreeId === TEST_FOLDER_WORKSPACE_KEY
    )

    expect(folderSummary).toMatchObject({
      workspaceKind: 'folder-workspace',
      worktreeId: TEST_FOLDER_WORKSPACE_KEY,
      repoId: `folder-workspace:${TEST_FOLDER_PROJECT_GROUP_ID}`,
      repo: 'Store',
      path: TEST_FOLDER_WORKSPACE_PATH,
      branch: '',
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: false,
      displayName: 'GG',
      comment: 'dujiao-next-eval',
      isPinned: false,
      unread: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      status: 'inactive'
    })
  })

  it('attaches inline agent rows from the latest OSC 9999 status', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '22222222-2222-4222-8222-222222222222'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex","lastAssistantMessage":"on it"}\x07',
      321
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        paneKey: `tab-1:${leafId}`,
        parentPaneKey: null,
        state: 'working',
        agentType: 'codex',
        prompt: 'ship it',
        lastAssistantMessage: 'on it',
        interrupted: false,
        stateStartedAt: expect.any(Number),
        updatedAt: expect.any(Number)
      })
    ])
  })

  it('attaches inline agent rows from hook-reported status (not just OSC)', async () => {
    // Why: agent status arrives via hooks, not OSC; worktree.ps reads the hook snapshot so mobile surfaces those agents.
    const leafId = '33333333-3333-4333-8333-333333333333'
    const paneKey = `tab-1:${leafId}`
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'ship it',
          agentType: 'claude',
          lastAssistantMessage: 'on it',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    const workerHandle = runtime.preAllocateHandleForPty('pty-1')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-1',
              task_id: 'task-1',
              assignee_handle: workerHandle,
              status: 'dispatched'
            }
          : undefined
      ),
      getLatestDispatchForTerminal: vi.fn(() => undefined),
      getTask: vi.fn(() => ({
        id: 'task-1',
        task_title: 'Dispatch prompt work',
        display_name: 'Review dispatch prompts and make worker labels distinct',
        spec: 'Review dispatch prompts\n\nand make worker labels distinct'
      })),
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        paneKey,
        state: 'working',
        agentType: 'claude',
        prompt: 'ship it',
        taskTitle: 'Dispatch prompt work',
        displayName: 'Review dispatch prompts and make worker labels distinct',
        lastAssistantMessage: 'on it',
        stateStartedAt: now - 100,
        updatedAt: now
      })
    ])
    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
  })

  it('projects monitoring for folder workspaces without assuming a git worktree', async () => {
    const now = Date.now()
    const folderWorkspace = makeFolderWorkspace({ name: 'GG' })
    const projectGroup = makeFolderProjectGroup({ name: 'Store' })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never,
      undefined,
      {
        getAgentStatusSnapshot: () => [
          {
            paneKey: 'folder-pane',
            worktreeId: TEST_FOLDER_WORKSPACE_KEY,
            state: 'working',
            workingMode: 'monitoring',
            prompt: 'watch tests',
            agentType: 'claude',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 100
          }
        ]
      }
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_FOLDER_WORKSPACE_KEY)

    expect(summary).toMatchObject({
      workspaceKind: 'folder-workspace',
      status: 'working',
      workingMode: 'monitoring'
    })
  })
  it('projects monitoring over a title-derived working status', async () => {
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'tab-1:1',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working', workingMode: 'monitoring' })
  })
  it('keeps hook monitoring mode when a newer mode-less OSC row reports the same work', async () => {
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'tab-1:1',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now - 100,
          stateStartedAt: now - 200
        }
      ]
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"watch tests","agentType":"claude"}\x07',
      1
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working', workingMode: 'monitoring' })
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        state: 'working',
        workingMode: 'monitoring',
        prompt: 'watch tests'
      })
    ])
  })
  it('does not carry hook monitoring mode into a newer OSC turn', async () => {
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'tab-1:1',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now - 100,
          stateStartedAt: now - 200
        }
      ]
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"fix tests","agentType":"claude"}\x07',
      1
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working' })
    expect(summary).not.toHaveProperty('workingMode')
    expect(summary?.agents).toEqual([
      expect.objectContaining({ state: 'working', prompt: 'fix tests' })
    ])
  })
  it('keeps title-only foreground work ahead of monitoring in another pane', async () => {
    const now = Date.now()
    const monitoringLeafId = '33333333-3333-4333-8333-333333333333'
    const foregroundLeafId = '44444444-4444-4444-8444-444444444444'
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `monitoring-tab:${monitoringLeafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'monitoring-tab',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'monitoring-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: monitoringLeafId,
          layout: null
        },
        {
          tabId: 'foreground-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: foregroundLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'monitoring-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: monitoringLeafId,
          paneRuntimeId: 1,
          ptyId: 'monitoring-pty',
          paneTitle: 'claude'
        },
        {
          tabId: 'foreground-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: foregroundLeafId,
          paneRuntimeId: 2,
          ptyId: 'foreground-pty',
          paneTitle: 'claude working'
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working' })
    expect(summary).not.toHaveProperty('workingMode')
    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey: `monitoring-tab:${monitoringLeafId}` })
    ])
  })
  it('keeps title-only foreground work ahead of monitoring in another split pane', async () => {
    const now = Date.now()
    const tabId = 'split-tab'
    const monitoringLeafId = '33333333-3333-4333-8333-333333333333'
    const foregroundLeafId = '44444444-4444-4444-8444-444444444444'
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `${tabId}:${monitoringLeafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId,
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: monitoringLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: monitoringLeafId,
          paneRuntimeId: 1,
          ptyId: 'monitoring-pty',
          paneTitle: 'claude'
        },
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: foregroundLeafId,
          paneRuntimeId: 2,
          ptyId: 'foreground-pty',
          paneTitle: 'claude working'
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working' })
    expect(summary).not.toHaveProperty('workingMode')
  })

  it('suppresses restored-unconfirmed hook rows from worktree.ps', async () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `tab-1:${leafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'may have finished offline',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100,
          restoredUnconfirmed: true
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: []
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ hasHostSidebarActivity: false, status: 'inactive', agents: [] })
  })

  it('uses mirrored tab ownership after a workspace rename instead of stale hook attribution', async () => {
    const renamedPath = '/tmp/worktree-renamed'
    const renamedWorktreeId = `${TEST_REPO_ID}::${renamedPath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: renamedPath,
        head: 'def',
        branch: 'feature/renamed',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const metaById = {
      ...store.getAllWorktreeMeta(),
      [renamedWorktreeId]: makeWorktreeMeta({ displayName: 'renamed' })
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      activeWorktreeId: renamedWorktreeId,
      activeTabIdByWorktree: { [renamedWorktreeId]: 'host-tab' },
      tabsByWorktree: {
        [renamedWorktreeId]: [
          {
            id: 'host-tab',
            ptyId: null,
            worktreeId: renamedWorktreeId,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => session
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'continue after rename',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    // No renderer graph on purpose: headless rename attribution must work from
    // the persisted session alone.
    const { worktrees } = await runtime.getWorktreePs()
    const oldSummary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
    const renamedSummary = worktrees.find((worktree) => worktree.worktreeId === renamedWorktreeId)

    expect(oldSummary?.agents).toEqual([])
    expect(renamedSummary).toMatchObject({
      hasHostSidebarActivity: true,
      status: 'working',
      agents: [expect.objectContaining({ prompt: 'continue after rename' })]
    })
  })

  it('keeps a fresh OSC row when the cached hook row for the same pane is older', async () => {
    const now = Date.now()
    const leafId = '44444444-4444-4444-8444-444444444444'
    const paneKey = `tab-1:${leafId}`
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'stale hook row',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now - AGENT_STATUS_STALE_AFTER_MS - 1,
          stateStartedAt: now - AGENT_STATUS_STALE_AFTER_MS - 100
        }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"fresh OSC row","agentType":"codex"}\x07',
      321
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey, prompt: 'fresh OSC row', agentType: 'codex' })
    ])
  })

  it.each([
    ['blocked', 0, true, 'permission'],
    ['waiting', 0, true, 'permission'],
    ['done', 0, false, 'inactive'],
    ['working', -AGENT_STATUS_STALE_AFTER_MS - 1, false, 'inactive']
  ] as const)(
    'projects %s agent activity to mobile at freshness offset %s',
    async (state, updatedAtOffset, hasHostSidebarActivity, status) => {
      const now = Date.now()
      const runtime = new OrcaRuntimeService(store, undefined, {
        getAgentStatusSnapshot: () => [
          {
            paneKey: 'tab-1:33333333-3333-4333-8333-333333333333',
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'tab-1',
            state,
            prompt: 'mobile parity',
            agentType: 'codex',
            connectionId: null,
            receivedAt: now + updatedAtOffset,
            stateStartedAt: now - 100
          }
        ]
      })
      // Why: local rows only project while their tab exists (#6072); freshness
      // is what varies here, so keep the tab present in the runtime graph.
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            activeLeafId: '33333333-3333-4333-8333-333333333333',
            layout: null
          }
        ],
        leaves: []
      })

      const { worktrees } = await runtime.getWorktreePs()

      const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
      expect(summary).toMatchObject({ hasHostSidebarActivity, status })
      // Why: inactive must mean "projected but not fresh", never "row dropped".
      expect(summary?.agents).toHaveLength(1)
    }
  )

  it('drops a hydrated done hook row after its local tab is closed', async () => {
    // Why (#6072): last-status.json hydrates hook rows for days; a closed tab's
    // agent must not resurface on mobile as current worktree activity.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-tab:66666666-6666-4666-8666-666666666666',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'closed-tab',
          state: 'done',
          prompt: 'refactor the parser',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({
      liveTerminalCount: 0,
      hasHostSidebarActivity: false,
      status: 'inactive',
      agents: []
    })
  })

  it('keeps a hydrated row while its persisted session tab exists and no renderer graph is attached', async () => {
    // Why: headless serve has no renderer graph; session.tabs.list serves this
    // tab to mobile as current, so its agent row must stay (desktop parity).
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'headless-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'headless-tab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'headless-tab',
          state: 'done',
          prompt: 'finished while headless',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ state: 'done', prompt: 'finished while headless' })
    ])
  })

  it('resolves legacy numeric pane keys through the stale filter too', async () => {
    // Why: non-UUID leaves produce `tabId:paneRuntimeId` keys with no tabId
    // field; they still name a real tab and must not bypass the filter.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'open-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-tab:7',
          worktreeId: TEST_WORKTREE_ID,
          state: 'done',
          prompt: 'stale legacy pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        },
        {
          paneKey: 'open-tab:9',
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'live legacy pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey: 'open-tab:9', prompt: 'live legacy pane' })
    ])
  })

  it('keeps a local hook row while a connected PTY still backs its pane', async () => {
    // Why: daemon-held terminals stay live across renderer graph gaps even when
    // no session tab records them; a connected PTY is proof the pane exists.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const paneKey = 'daemon-tab:77777777-7777-4777-8777-777777777777'
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'daemon-tab',
          state: 'working',
          prompt: 'long-running daemon agent',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    // paneKey-only record: the tabId rescue must not be what keeps this row.
    runtime['recordPtyWorktree']('daemon-pty', TEST_WORKTREE_ID, {
      connected: true,
      paneKey
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey, state: 'working', prompt: 'long-running daemon agent' })
    ])
    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
  })

  it('keeps a local hook row when a connected PTY matches only its tab id', async () => {
    // Split-pane sibling: the PTY's paneKey names another leaf of the same tab,
    // so only the tabId conjunct can rescue this row.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'daemon-tab:88888888-8888-4888-8888-888888888887',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'daemon-tab',
          state: 'working',
          prompt: 'sibling pane agent',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    runtime['recordPtyWorktree']('daemon-pty-2', TEST_WORKTREE_ID, {
      connected: true,
      tabId: 'daemon-tab',
      paneKey: 'daemon-tab:99999999-9999-4999-8999-999999999998'
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ prompt: 'sibling pane agent', state: 'working' })
    ])
  })

  it('keeps a retained OSC row via its connected PTY after the pane binding is cleared', async () => {
    // A controller incarnation change nulls pty.tabId/paneKey while the PTY
    // stays connected (adoptControllerTerminalHandle); the ptyId conjunct is
    // then the only rescue for the retained OSC row.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime['recordPtyWorktree']('osc-pty', TEST_WORKTREE_ID, {
      connected: true,
      tabId: 'osc-tab',
      paneKey: 'osc-tab:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    runtime.onPtyData(
      'osc-pty',
      '\x1b]9999;{"state":"working","prompt":"osc reporter","agentType":"codex"}\x07',
      1
    )
    const pty = runtime['ptysById'].get('osc-pty')!
    pty.tabId = null
    pty.paneKey = null

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'osc reporter' })])
  })

  it('keeps the connected-PTY rescue when a hook row outraces the OSC row for the same pane', async () => {
    // Hook payloads carry no ptyId; the OSC-observed one must survive the
    // hook row winning the freshness race or the ptyId rescue goes dead.
    const paneKey = 'race-tab:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'race-tab',
          state: 'working',
          prompt: 'hook-fresh agent',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now() + 60_000,
          stateStartedAt: Date.now() - 100
        }
      ]
    })
    runtime['recordPtyWorktree']('race-pty', TEST_WORKTREE_ID, {
      connected: true,
      tabId: 'race-tab',
      paneKey
    })
    runtime.onPtyData(
      'race-pty',
      '\x1b]9999;{"state":"working","prompt":"osc ping","agentType":"codex"}\x07',
      1
    )
    const pty = runtime['ptysById'].get('race-pty')!
    pty.tabId = null
    pty.paneKey = null

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'hook-fresh agent' })])
  })

  it('keeps a retained OSC row from an SSH pane after its PTY disconnects', async () => {
    // Why: OSC snapshots must carry the pane transport; hardcoding local would
    // strip the SSH exemption off rows whose freshest update arrived via OSC.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime['recordPtyWorktree']('ssh-osc-pty', TEST_WORKTREE_ID, {
      connected: true,
      connectionId: 'ssh-osc-1',
      tabId: 'ssh-tab',
      paneKey: 'ssh-tab:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    runtime.onPtyData(
      'ssh-osc-pty',
      '\x1b]9999;{"state":"working","prompt":"remote osc agent","agentType":"codex"}\x07',
      1
    )
    runtime['recordPtyWorktree']('ssh-osc-pty', TEST_WORKTREE_ID, { connected: false })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'remote osc agent' })])
  })

  it('keeps a hook row with an unresolvable pane key', async () => {
    // Why: no tabId means staleness is unprovable; the filter must pass it.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'opaque-key-without-structure',
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'unattributable pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'unattributable pane' })])
  })

  it('keeps a WSL hook row while its tab is still in the session', async () => {
    // Guards the WSL clause against over-filtering: local-tab evidence must
    // rescue WSL rows exactly like null-connection rows.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'open-wsl-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'open-wsl-tab:99999999-9999-4999-8999-999999999997',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'open-wsl-tab',
          state: 'working',
          prompt: 'live in WSL',
          agentType: 'codex',
          connectionId: 'wsl:Ubuntu',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'live in WSL' })])
  })

  it('drops a hydrated WSL hook row after its local tab is closed', async () => {
    // Why: WSL relay ids are transport provenance; the pane remains local.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-wsl-tab:99999999-9999-4999-8999-999999999999',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'closed-wsl-tab',
          state: 'done',
          prompt: 'finished in WSL',
          agentType: 'codex',
          connectionId: 'wsl:Ubuntu',
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([])
  })

  it('keeps remote hook rows whose tabs are only tracked on the remote host', async () => {
    // Why: the local session partition for an SSH host can be empty while the
    // remote host owns the terminals; absence there is not proof of a close.
    const remoteRepo = {
      id: 'repo-ssh-6072',
      path: '/home/me/project',
      displayName: 'remote-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-6072'
    }
    const remoteWorktree = {
      path: '/home/me/project/.worktrees/feature-agents',
      head: 'def',
      branch: 'refs/heads/feature/agents',
      isBare: false,
      isMainWorktree: false
    }
    const remoteWorktreeId = `${remoteRepo.id}::${remoteWorktree.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [remoteWorktreeId]: makeWorktreeMeta({ displayName: 'Remote agents' })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => getDefaultWorkspaceSession()
    }
    registerSshGitProvider('ssh-6072', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'remote-tab:88888888-8888-4888-8888-888888888888',
          worktreeId: remoteWorktreeId,
          tabId: 'remote-tab',
          state: 'working',
          prompt: 'remote agent without local tab records',
          agentType: 'codex',
          connectionId: 'ssh-6072',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === remoteWorktreeId)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ prompt: 'remote agent without local tab records' })
    ])
  })
})
