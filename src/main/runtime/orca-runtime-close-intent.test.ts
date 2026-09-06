/* eslint-disable max-lines -- Why: close-intent/mobile-resilience tests share cross-test runtime state, so this slice stays one file */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  InMemoryOrchestrationMessages,
  MOCK_GIT_WORKTREES,
  ORIGINAL_PLATFORM,
  ORIGIN_HEAD_COMPONENT,
  ORIGIN_REMOTE_URL,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_FOLDER_WORKSPACE_PATH,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  bindSinglePtyRun,
  closeGitLabMRMock,
  closeLocalWatcherForWorktreePathMock,
  closeRemoteWatcherForWorktreePathMock,
  computeWorktreePathMock,
  createFolderWorkspaceRuntimeStore,
  createGitLabIssueMock,
  createRuntime,
  createStaleRuntimeWorktreeStore,
  deferred,
  deleteWorktreeHistoryDirMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  electronMocks,
  ensurePathWithinWorkspaceMock,
  expectStablePaneKeyEnv,
  findExistingWorktreeSymlinkPathsMock,
  forceDeleteLocalBranchMock,
  forgetLocalWatcherRemovalSnapshotMock,
  forgetRemoteWatcherRemovalSnapshotMock,
  getActiveMultiplexerMock,
  getGitLabJobTraceMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  getGitLabWorkItemDetailsMock,
  getGlabKnownHostsMock,
  getPRForBranchMock,
  getPullRequestPushTargetMock,
  getSshGitProviderMock,
  invalidateAuthorizedRootsCacheMock,
  isOriginMainBaseRefProbe,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabMergeRequestsMock,
  listGitLabTodosMock,
  listGitLabWorkItemsMock,
  makeDeferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeInfo,
  makeWorktreeMeta,
  mergeGitLabMRMock,
  muxRequestMock,
  pendingMailPointerRepoints,
  removeWorktreeLinkedPathsMock,
  reopenGitLabMRMock,
  resetRuntimeTestMocks,
  resolveGitLabMRDiscussionMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemoteWatcherAfterFailedRemovalMock,
  retryGitLabJobMock,
  setInMemoryOrchestrationMessages,
  setPlatform,
  store,
  syncSinglePty,
  updateGitLabIssueMock,
  updateGitLabMRMock,
  updateGitLabMRReviewersMock,
  withPlatform
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../shared/setup-agent-sequencing'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
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
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import {
  WORKTREE_PROCESS_SWEEP_TIMEOUT_MS,
  WORKTREE_TEARDOWN_RPC_MARGIN_MS
} from './worktree-teardown'
import { ipcMain } from 'electron'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import * as gitRunner from '../git/runner'
import * as worktreePathComparison from '../ipc/worktree-path-comparison'
import * as localWorktreeFilesystem from '../local-worktree-filesystem'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  describe('close intent adjudication', () => {
    // Shared setup: a renderer-adopted tab whose PTY the host sees alive.
    function makeAdoptedLiveTabRuntime(): {
      runtime: OrcaRuntimeService
      getSession: () => WorkspaceSessionState
      kill: ReturnType<typeof vi.fn>
      closeTerminal: ReturnType<typeof vi.fn>
      closeTerminalTab: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      processes: { id: string; cwd: string; title: string }[]
    } {
      const servePtyId = 'serve-live-1'
      const processes = [{ id: servePtyId, cwd: TEST_WORKTREE_PATH, title: 'Live' }]
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: servePtyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Live Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const closeTerminalTab = vi.fn(async () => {})
      const listProcesses = vi.fn(async () => processes)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses
      })
      runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Live Terminal',
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
            ptyId: servePtyId
          }
        ]
      })
      return {
        runtime,
        getSession,
        kill,
        closeTerminal,
        closeTerminalTab,
        listProcesses,
        processes
      }
    }

    it.each(['pty-exit', 'cleanup'] as const)(
      'refuses a %s echoed close while the PTY is live and republishes the snapshot',
      async (reason) => {
        const { runtime, getSession, kill, closeTerminal, closeTerminalTab } =
          makeAdoptedLiveTabRuntime()
        const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
        const events: { worktree: string; snapshotVersion: number; tabs: unknown[] }[] = []
        const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

        const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason
        })

        unsubscribe()
        // No destructive branch may run: no PTY kill, no renderer close relay.
        expect(result).toEqual({
          closed: true,
          refused: true,
          refusalReason: 'live-host-pty',
          snapshotRepublished: true
        })
        expect(kill).not.toHaveBeenCalled()
        expect(closeTerminalTab).not.toHaveBeenCalled()
        expect(closeTerminal).not.toHaveBeenCalled()
        expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
        // The snapshot is republished (version bumped) so the echoing client
        // re-adds and re-attaches the still-live tab.
        const republished = events.filter((event) => event.worktree === TEST_WORKTREE_ID)
        expect(republished.length).toBeGreaterThan(0)
        const last = republished.at(-1)!
        expect(last.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
        expect(
          last.tabs.some((tab) => (tab as { parentTabId?: string }).parentTabId === 'host-tab')
        ).toBe(true)
      }
    )

    it('coalesces a reconnect close burst onto one authoritative PTY inventory', async () => {
      const { runtime, listProcesses, processes } = makeAdoptedLiveTabRuntime()
      const inventory = deferred<typeof processes>()
      listProcesses.mockImplementation(() => inventory.promise)

      const closes = Promise.all([
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'pty-exit'
        }),
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'cleanup'
        })
      ])
      await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1))
      inventory.resolve(processes)

      await expect(closes).resolves.toEqual([
        expect.objectContaining({ refused: true, refusalReason: 'live-host-pty' }),
        expect.objectContaining({ refused: true, refusalReason: 'live-host-pty' })
      ])
      expect(listProcesses).toHaveBeenCalledTimes(1)
    })

    it('keeps a live persisted PTY whose pane binding has not reconnected yet', async () => {
      const ptyId = 'persisted-pty'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Persisted Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Live' }]
      })

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'cleanup'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('keeps an explicit user close destructive while the PTY is live', async () => {
      const { runtime, closeTerminalTab } = makeAdoptedLiveTabRuntime()

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'user'
      })

      // Legacy whole-parent relay: the renderer close transaction still runs.
      expect(closeTerminalTab).toHaveBeenCalledWith('host-tab')
    })

    it('keeps a reasonless legacy close and republishes its live mirror', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.refuseUnattributedMobileSessionTabClose(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab'
      )
      const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'missing-intent',
        snapshotRepublished: true
      })
      expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('refuses a lifecycle close from a stale host publication', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const terminal = current.tabs.find((tab) => tab.type === 'terminal')
      if (!terminal || terminal.status !== 'ready') {
        throw new Error('expected a ready terminal fixture')
      }

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: 'stale-epoch',
        expectedTerminalHandle: terminal.terminal
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'stale-publication',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('refuses a reused tab id that names a different terminal incarnation', async () => {
      const { runtime, kill, closeTerminal, closeTerminalTab } = makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: current.publicationEpoch,
        expectedTerminalHandle: 'term-from-retired-incarnation'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'stale-terminal',
        snapshotRepublished: true
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    it('leaves dead renderer-owned retirement to the renderer without relaying a close', async () => {
      const { runtime, processes, kill, closeTerminal, closeTerminalTab } =
        makeAdoptedLiveTabRuntime()
      const current = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      const terminal = current.tabs.find((tab) => tab.type === 'terminal')
      if (!terminal || terminal.status !== 'ready') {
        throw new Error('expected a ready terminal fixture')
      }
      runtime.onPtyExit('serve-live-1', 0)
      processes.length = 0

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit',
        expectedPublicationEpoch: current.publicationEpoch,
        expectedTerminalHandle: terminal.terminal
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'retirement-owner'
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
    })

    function makeSplitLeafRuntime(): {
      runtime: OrcaRuntimeService
      getSession: () => WorkspaceSessionState
      kill: ReturnType<typeof vi.fn>
      closeTerminal: ReturnType<typeof vi.fn>
    } {
      const layout = makeHeadlessTerminalLayout({
        [HEADLESS_LEAF_ID]: 'serve-left',
        [HEADLESS_SECOND_LEAF_ID]: 'serve-right'
      })
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: 'serve-left',
                worktreeId: TEST_WORKTREE_ID,
                title: 'Split Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: { 'host-tab': layout }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.setNotifier({ closeTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Split Terminal',
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
            ptyId: 'serve-left',
            paneTitle: 'L'
          },
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_SECOND_LEAF_ID,
            paneRuntimeId: 2,
            ptyId: 'serve-right',
            paneTitle: 'R'
          }
        ]
      })
      return { runtime, getSession, kill, closeTerminal }
    }

    it('refuses a pty-exit echoed close of a live split leaf (direct-kill branch)', async () => {
      const { runtime, getSession, kill, closeTerminal } = makeSplitLeafRuntime()

      await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'pty-exit' }
      )

      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('still kills a live split leaf for an explicit user close', async () => {
      const { runtime, kill } = makeSplitLeafRuntime()

      await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'user' }
      )

      expect(kill).toHaveBeenCalledWith('serve-right')
      expect(kill).not.toHaveBeenCalledWith('serve-left')
    })

    it('refuses without republishing when the echoed leaf is dead but a sibling is live', async () => {
      // Why: the only reachable close path for a single leaf destroys the whole
      // parent (live sibling included), so the close must be refused — but a
      // republish would re-add the dead leaf on the echoing client and feed a
      // refuse→republish→re-echo loop.
      const { runtime, getSession, kill, closeTerminal } = makeSplitLeafRuntime()
      runtime.onPtyExit('serve-right', 0)
      const events: { worktree: string }[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

      const result = await runtime.closeMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        `host-tab::${HEADLESS_SECOND_LEAF_ID}`,
        { reason: 'pty-exit' }
      )

      unsubscribe()
      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty'
      })
      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(events.filter((event) => event.worktree === TEST_WORKTREE_ID)).toEqual([])
    })

    it('refuses a pty-exit echoed close of a runtime-owned headless tab with a live PTY', async () => {
      // Why: the headless close path kills every leaf PTY and de-persists the
      // parent; an echo must not reach it while the host sees the PTY alive.
      const servePtyId = 'serve-headless-live'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: servePtyId,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Serve Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
          }
        })
      )
      const kill = vi.fn(() => true)
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.setNotifier({ closeTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Serve Terminal',
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
            ptyId: servePtyId,
            paneTitle: 'A'
          }
        ]
      })

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(kill).not.toHaveBeenCalled()
      expect(closeTerminal).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
    })

    it('retires a dead headless tab on a pty-exit echoed close', async () => {
      // Why: headless hosts have no renderer pty-exit handling of their own;
      // they rely on the client echo to retire genuinely dead tab records.
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    })

    it('retires a dead headless tab whose exited PTY still has a retained record', async () => {
      // Why: onPtyExit keeps the disconnected record in ptysById for status and
      // exit reads — the production state after a real exit. The gate must not
      // read record presence as liveness or the dead tab never retires and the
      // client echo loops.
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const processes: { id: string; cwd: string; title: string }[] = [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Shell' }
      ]
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => processes
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      // Seed the connected PTY record from the controller listing, then let the
      // process die: the record flips to disconnected but stays retained.
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      runtime.onPtyExit('persisted-pty', 0)
      processes.length = 0

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      expect(kill).not.toHaveBeenCalled()
    })

    it('keeps a headless tab when the provider inventory is unavailable', async () => {
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const kill = vi.fn(() => true)
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: () => true,
        kill,
        getForegroundProcess: async () => null,
        listProcesses: async () => {
          throw new Error('access denied')
        }
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      const result = await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
        reason: 'pty-exit'
      })

      expect(result).toEqual({
        closed: true,
        refused: true,
        refusalReason: 'unknown-liveness',
        snapshotRepublished: true
      })
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
      expect(kill).not.toHaveBeenCalled()
    })
  })

  it('builds mobile session agent launch commands on the runtime host', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
        agentDefaultEnv: { 'command-code': { COMMAND_CODE_PROFILE: 'mobile-env' } }
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'command-code'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "command-code --profile mobile '--yolo'",
        cwd: TEST_WORKTREE_PATH,
        env: expect.objectContaining({
          COMMAND_CODE_PROFILE: 'mobile-env'
        }),
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('injects mobile quick-command prompts into the host-built agent startup command', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-prompt' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { codex: 'codex' },
        agentDefaultArgs: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'codex',
      agentPrompt: 'Review this diff'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/^codex .*'Review this diff'$/),
        launchAgent: 'codex',
        cwd: TEST_WORKTREE_PATH
      })
    )
  })

  it('rejects startup prompts for agents that require post-ready stdin', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-prompt' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'aider',
        agentPrompt: 'Review this diff'
      })
    ).rejects.toThrow('does not support startup prompt quick commands')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses portable Unix quoting for mobile agent launch commands in WSL project runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
      const runtime = new OrcaRuntimeService({
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
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `command-code --profile mobile '--note' 'can'"'"'t'`,
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('keeps PowerShell quoting for mobile agent launch commands in Windows host runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "command-code --profile mobile '--note' 'can''t'",
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('uses cmd.exe quoting for mobile agent launch commands in local Windows host runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-cmd' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
          terminalWindowsShell: 'cmd.exe'
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'command-code --profile mobile "--note" "can\'t"',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('publishes headless mobile session agent identity with synthesized PTY status', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'claude'
    })
    runtime.onPtyData('pty-agent', '\x1b]0;✳ Claude Code\x07', Date.now())

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(created.tab).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude'
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'claude'
        })
      })
    ])
  })

  it('rejects disabled mobile session agent launches before spawning', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('validates mobile terminal insertion anchors before resolving agent launch commands', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        afterTabId: 'stale-tab',
        agent: 'codex'
      })
    ).rejects.toThrow('after_tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forwards inactive mobile terminal creation to the renderer without focusing it', async () => {
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal,
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string; activate?: boolean }) => {
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: { send: vi.fn() } },
        { requestId: payload.requestId, error: 'spoofed renderer reply' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: `tab-renderer::${HEADLESS_LEAF_ID}`,
                parentTabId: 'tab-renderer',
                leafId: HEADLESS_LEAF_ID,
                ptyId: 'pty-renderer',
                title: 'Terminal',
                viewMode: 'chat',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        {
          requestId: payload.requestId,
          tabId: 'tab-renderer',
          title: 'Terminal'
        }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      viewMode: 'chat'
    })

    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        activate: false,
        source: 'runtime-session',
        viewMode: 'chat'
      })
    )
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(result.tab).toMatchObject({ parentTabId: 'tab-renderer', isActive: false })

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-renderer',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ parentTabId: 'tab-renderer', ptyId: 'pty-renderer' })
    ])

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-renderer',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 3,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-renderer',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 4,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('dedupes concurrent mobile terminal creates that share a clientMutationId', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: 'tab-renderer::pane:1',
                parentTabId: 'tab-renderer',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const [first, second] = await Promise.all([
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        clientMutationId: 'mutation-1'
      }),
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        clientMutationId: 'mutation-1'
      })
    ])

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(1)
    expect(second).toBe(first)
    expect(first.tab).toMatchObject({ parentTabId: 'tab-renderer' })
  })

  it('returns the settled success for a retried clientMutationId whose response was lost', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: 'tab-renderer::pane:1',
                parentTabId: 'tab-renderer',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const first = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-lost-response'
    })
    // Why: the phone retries the same key when the create response was lost; within the retention window it must reuse the terminal.
    const retried = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-lost-response'
    })

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(1)
    expect(retried).toBe(first)
  })

  it('does not dedupe mobile terminal creates across worktrees with the same clientMutationId', async () => {
    const otherWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-b`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: '/tmp/worktree-b',
        head: 'def',
        branch: 'feature/bar',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [otherWorktreeId]: makeWorktreeMeta({ displayName: 'other' })
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string; worktreeId: string }) => {
      const parentTabId =
        payload.worktreeId === TEST_WORKTREE_ID ? 'tab-renderer-a' : 'tab-renderer-b'
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: parentTabId, title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const firstCreate = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-1'
    })
    const secondCreate = runtime.createMobileSessionTerminal(`id:${otherWorktreeId}`, {
      activate: false,
      clientMutationId: 'mutation-1'
    })
    await vi.waitFor(() => {
      const createRequests = send.mock.calls.filter(
        ([channel]) => channel === 'terminal:requestTabCreate'
      )
      expect(createRequests).toHaveLength(2)
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer-a',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-renderer-a',
          paneTitle: null
        },
        {
          tabId: 'tab-renderer-b',
          worktreeId: otherWorktreeId,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-renderer-b',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-a',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: 'tab-renderer-a::pane:1',
              parentTabId: 'tab-renderer-a',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: false
            }
          ]
        },
        {
          worktree: otherWorktreeId,
          publicationEpoch: 'epoch-b',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: 'tab-renderer-b::pane:1',
              parentTabId: 'tab-renderer-b',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: false
            }
          ]
        }
      ]
    })
    const [first, second] = await Promise.all([firstCreate, secondCreate])

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(2)
    expect(first.tab).toMatchObject({ parentTabId: 'tab-renderer-a' })
    expect(second.tab).toMatchObject({ parentTabId: 'tab-renderer-b' })
  })

  it('materializes a renderer-created mobile terminal whose surface stays pending', async () => {
    vi.useFakeTimers()
    try {
      const pendingLeafId = '33333333-3333-4333-8333-333333333333'
      const closeTerminal = vi.fn()
      const revealTerminalSession = vi.fn()
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-materialized' })
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession,
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal,
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true,
        viewMode: 'terminal'
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-pending',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-pending::${pendingLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-pending::${pendingLeafId}`,
                parentTabId: 'tab-pending',
                leafId: pendingLeafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(999)

      expect(settled).toBe(false)
      expect(spawn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      const result = await settledCreate

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-pending',
        leafId: pendingLeafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/),
        viewMode: 'terminal',
        isActive: true
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-pending',
          leafId: pendingLeafId,
          persistHostSessionBinding: true,
          preAllocatedHandle: expect.stringMatching(/^term_/)
        })
      )
      expect(revealTerminalSession).toHaveBeenCalledWith(
        TEST_WORKTREE_ID,
        expect.objectContaining({
          ptyId: 'pty-materialized',
          tabId: 'tab-pending',
          leafId: pendingLeafId,
          viewMode: 'terminal'
        })
      )
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls back a half-created terminal whose surface never publishes', async () => {
    vi.useFakeTimers()
    try {
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal,
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      // Why: reply with a tabId but never sync a surface graph, so waitForMobileTerminalSurface times out and rollback runs.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-ghost', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const pending = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false
      })
      const settled = pending.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.advanceTimersByTimeAsync(11_000)
      const outcome = await settled

      expect(outcome.ok).toBe(false)
      expect(closeTerminal).toHaveBeenCalledWith('tab-ghost')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the five #7587 mobile-create tests share one notifier factory so interface changes live in one place.
  function createMobileCreateTestNotifier(
    closeTerminal: (tabId: string, paneRuntimeId?: number) => void
  ) {
    return {
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal,
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    }
  }

  it('rolls back a mobile create when the materialize spawn fails and no live PTY backs the tab', async () => {
    vi.useFakeTimers()
    try {
      const pendingLeafId = '99999999-9999-4999-8999-999999999999'
      const closeTerminal = vi.fn()
      // Why: #7587 rescue is gated on a live PTY, not on a mere surface — else this handle-less failed-spawn dead shell would resolve as success.
      const spawn = vi.fn().mockRejectedValue(new Error('spawn failed'))
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      const settled = create.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Only the tab shell publishes (no ptyId → never ready); no PTY ever binds.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-pending',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-pending::${pendingLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-pending::${pendingLeafId}`,
                parentTabId: 'tab-pending',
                leafId: pendingLeafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      // Ready-fallback (1s) expires → materialize runs → spawn rejects → catch.
      await vi.advanceTimersByTimeAsync(2_000)
      const outcome = await settled

      expect(outcome.ok).toBe(false)
      expect(closeTerminal).toHaveBeenCalledWith('tab-pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer never publishes the surface', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '44444444-4444-4444-8444-444444444444'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why: reply with a tabId but never sync a matching graph, reproducing a renderer that spawns the PTY but stalls graph-sync past the surface timeout (#7587).
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-alive', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true,
        viewMode: 'chat'
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // A shell-only snapshot can win the first race but omit launch props; the later PTY rescue must fill the explicit mode.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-shell',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-alive::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-alive::${leafId}`,
                parentTabId: 'tab-alive',
                leafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      // The renderer's PTY spawn registers with the tab binding (as the pty IPC layer now does) after the shell-only snapshot.
      runtime.registerPty('pty-alive', TEST_WORKTREE_ID, null, {
        tabId: 'tab-alive',
        leafId
      })

      // Resolves promptly, well under MOBILE_TERMINAL_SURFACE_TIMEOUT_MS (10s).
      await vi.advanceTimersByTimeAsync(50)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-alive',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/),
        viewMode: 'chat'
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer PTY spawn races ahead of the reply', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '55555555-5555-4555-8555-555555555555'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why: spawn and tabCreate reply are independent IPC channels; here the PTY registers before the reply, so the pre-wait check resolves it.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        runtime.registerPty('pty-early', TEST_WORKTREE_ID, null, {
          tabId: 'tab-early',
          leafId
        })
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-early', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Resolves via the immediate pre-wait rescue, well under the 10s timeout (not the catch path).
      await vi.advanceTimersByTimeAsync(50)
      expect(settled).toBe(true)
      const result = await settledCreate

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-early',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers the agent launch command when a create settles over a bare renderer PTY', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const write = vi.fn((_ptyId: string, _data: string) => true)
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: {}
        })
      } as never)
      runtime.setPtyController({
        spawn: vi.fn(),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        // Why: the pane spawned before its startup queue landed (the #7587
        // renderer-stall class), so no spawn command is recorded for the PTY.
        runtime.registerPty('pty-bare', TEST_WORKTREE_ID, null, { tabId: 'tab-bare', leafId })
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-bare', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        activate: true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      const result = await create

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-bare',
        leafId,
        status: 'ready'
      })
      // Why: the adopted PTY never launched codex, so the settle must type the
      // launch command (Enter as its own write) instead of succeeding silently.
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[0][0]).toBe('pty-bare')
      expect(String(write.mock.calls[0][1])).toMatch(/codex/)
      expect(write.mock.calls[1]).toEqual(['pty-bare', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-deliver the agent launch command when the adopted renderer PTY spawned with one', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '88888888-8888-4888-8888-888888888888'
      const write = vi.fn((_ptyId: string, _data: string) => true)
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: {}
        })
      } as never)
      runtime.setPtyController({
        spawn: vi.fn(),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        // Why: mirrors the spawn IPC handler — a command-carrying spawn records
        // its launch command right after registering the PTY.
        runtime.registerPty('pty-carried', TEST_WORKTREE_ID, null, { tabId: 'tab-carried', leafId })
        runtime.noteTerminalSpawnCommand('pty-carried', 'codex')
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-carried', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        activate: true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      const result = await create

      expect(result.tab).toMatchObject({ type: 'terminal', parentTabId: 'tab-carried' })
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer snapshot is rejected by the version guard', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '66666666-6666-4666-8666-666666666666'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-guard', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })
      // Why: seed an inflated stored version under a stable epoch (the state prior renderer publications leave behind).
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-guard',
            snapshotVersion: 50,
            activeGroupId: 'group-guard',
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Renderer republishes with a stale (lower) version under the same epoch, so syncMobileSessionTabs rejects it — the reporter's stall variant (#7587).
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-guard',
            snapshotVersion: 1,
            activeGroupId: 'group-guard',
            activeTabId: `tab-guard::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-guard::${leafId}`,
                parentTabId: 'tab-guard',
                leafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(50)
      // The rejected renderer sync must not have resolved the create.
      expect(settled).toBe(false)
      // Prove the rejection: the stored snapshot still lacks the tab.
      const beforeRescue = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(
        beforeRescue.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'tab-guard')
      ).toBe(false)

      // The renderer's own PTY spawn registers with the binding and rescues it.
      runtime.registerPty('pty-guard', TEST_WORKTREE_ID, null, {
        tabId: 'tab-guard',
        leafId
      })
      await vi.advanceTimersByTimeAsync(50)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-guard',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive at the surface timeout when only a leaf-synced PTY backs the tab', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why (#7587): leaf graph-sync lands identity without registerPty, so only the catch-path rescue saves the stalled live session.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-catch', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Let the create clear its pre-wait check and park in waitForMobileTerminalSurface before any identity arrives.
      await vi.advanceTimersByTimeAsync(50)

      // Identity arrives via leaf graph-sync, NOT registerPty, so no rescue fires and the surface is never published.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-catch',
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId: 'pty-catch'
          }
        ]
      })

      // Surface still unpublished, so the create is still pending.
      expect(settled).toBe(false)

      // Cross the 10s surface timeout: the catch path must rescue from the live PTY, not roll the session back destructively.
      await vi.advanceTimersByTimeAsync(11_000)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-catch',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports browser tab creation as unsupported for a windowless host with no offscreen backend', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('does not support browser panes')
    })
  })

  it('creates a browser tab via the offscreen backend for a headless runtime server', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const createTab = vi.fn(async () => ({ browserPageId: 'page-headless' }))
    runtime.setOffscreenBrowserBackend({ createTab, closeTab: vi.fn() })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).resolves.toEqual({ browserPageId: 'page-headless' })
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com' }))
  })

  it('cancels an in-flight same-connection browser screencast before replacing it', async () => {
    const runtime = createRuntime()
    const firstStart = deferred<{
      subscriptionId: string
      ready: never
      flushPendingFrame: () => void
      session: { stop: () => void; done: Promise<void> }
    }>()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const thirdDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const thirdStop = vi.fn(() => thirdDone.resolve())
    const browserScreencast = vi
      .fn()
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:second',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        flushPendingFrame: () => {},
        session: { stop: secondStop, done: secondDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:third',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:third',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        flushPendingFrame: () => {},
        session: { stop: thirdStop, done: thirdDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const secondEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await Promise.resolve()

    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: secondEmit }
    )
    const thirdEmit = vi.fn()
    const third = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: thirdEmit }
    )
    await Promise.resolve()

    expect(browserScreencast).toHaveBeenCalledTimes(1)

    firstStart.resolve({
      subscriptionId: 'browser-screencast:page-1:first',
      ready: {} as never,
      flushPendingFrame: () => {},
      session: { stop: firstStop, done: firstDone.promise }
    })
    await first
    await Promise.resolve()

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(firstEmit).not.toHaveBeenCalled()
    expect(browserScreencast).toHaveBeenCalledTimes(2)

    await second
    await Promise.resolve()

    expect(secondStop).toHaveBeenCalledTimes(1)
    expect(browserScreencast).toHaveBeenCalledTimes(3)
    expect(thirdEmit).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:third' })
    )

    runtime.cleanupSubscription('browser-screencast:page-1:third')
    await third

    expect(thirdStop).toHaveBeenCalledTimes(1)
  })

  it('keeps same-page screencasts alive for independent connections', async () => {
    const runtime = createRuntime()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const ready = (subscriptionId: string) => ({
      type: 'ready' as const,
      subscriptionId,
      browserPageId: 'page-1',
      format: 'jpeg' as const,
      tab: {
        browserPageId: 'page-1',
        index: 0,
        url: 'about:blank',
        title: 'Browser',
        active: true
      }
    })
    const browserScreencast = vi
      .fn()
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:first',
        ready: ready('browser-screencast:page-1:first'),
        flushPendingFrame: () => {},
        session: { stop: firstStop, done: firstDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: ready('browser-screencast:page-1:second'),
        flushPendingFrame: () => {},
        session: { stop: secondStop, done: secondDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await vi.waitFor(() =>
      expect(firstEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:first' })
      )
    )

    const secondEmit = vi.fn()
    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-2', sendBinary: vi.fn(), emit: secondEmit }
    )

    await vi.waitFor(() =>
      expect(secondEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:second' })
      )
    )
    expect(browserScreencast).toHaveBeenCalledTimes(2)
    expect(firstStop).not.toHaveBeenCalled()

    runtime.cleanupSubscription('browser-screencast:page-1:second')
    await second
    expect(firstStop).not.toHaveBeenCalled()
    expect(secondStop).toHaveBeenCalledTimes(1)
    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await first
    expect(firstStop).toHaveBeenCalledTimes(1)
  })

  it('dedupes async subscription cleanup and retains a failed cleanup for retry', async () => {
    const runtime = createRuntime()
    const cleanupError = new Error('physical teardown incomplete')
    const firstCleanup = deferred<void>()
    const cleanup = vi
      .fn()
      .mockReturnValueOnce(firstCleanup.promise)
      .mockRejectedValue(cleanupError)
    runtime.registerSubscriptionCleanup('files-watch-1', cleanup, 'conn-1')

    const first = runtime.cleanupSubscriptionAndWait('files-watch-1')
    const duplicate = runtime.cleanupSubscriptionAndWait('files-watch-1')
    expect(cleanup).toHaveBeenCalledTimes(1)
    firstCleanup.reject(cleanupError)
    await expect(first).rejects.toBe(cleanupError)
    await expect(duplicate).rejects.toBe(cleanupError)

    await expect(runtime.cleanupSubscriptionAndWait('files-watch-1')).rejects.toBe(cleanupError)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('does not let an old connection cleanup tear down its replacement subscription', async () => {
    const runtime = createRuntime()
    const oldDone = deferred<void>()
    const oldCleanup = vi.fn(() => oldDone.promise)
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:stable', oldCleanup, 'conn-old')
    runtime.registerSubscriptionCleanup('terminal:stable', replacementCleanup, 'conn-new')
    expect(oldCleanup).toHaveBeenCalledTimes(1)

    runtime.cleanupSubscriptionsForConnection('conn-old')
    expect(replacementCleanup).not.toHaveBeenCalled()

    runtime.cleanupSubscriptionsForConnection('conn-new')
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
    oldDone.resolve()
    await Promise.resolve()
  })

  it('does not let a delayed cleanup retry tear down its replacement subscription', async () => {
    const runtime = createRuntime()
    const physicalExit = deferred<void>()
    const oldDone = deferred<void>()
    const cleanupError = new Error('physical teardown incomplete')
    const oldCleanup = vi.fn(() => oldDone.promise)
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('files-watch:stable', oldCleanup, 'conn-old')
    const oldAttempt = runtime.cleanupSubscriptionAndWait('files-watch:stable')
    runtime.retrySubscriptionCleanupAfter('files-watch:stable', oldCleanup, physicalExit.promise)
    runtime.registerSubscriptionCleanup('files-watch:stable', replacementCleanup, 'conn-new')

    oldDone.reject(cleanupError)
    await expect(oldAttempt).rejects.toBe(cleanupError)
    physicalExit.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(oldCleanup).toHaveBeenCalledTimes(1)
    expect(replacementCleanup).not.toHaveBeenCalled()
    await runtime.cleanupSubscriptionAndWait('files-watch:stable')
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
  })

  it('releases an owned subscription only while its registration still owns the id', async () => {
    const runtime = createRuntime()
    const oldCleanup = vi.fn()
    const replacementCleanup = vi.fn()

    const oldRegistration = runtime.registerOwnedSubscriptionCleanup(
      'terminal:owned',
      oldCleanup,
      'conn-old'
    )

    runtime.registerOwnedSubscriptionCleanup('terminal:owned', replacementCleanup, 'conn-new')
    expect(oldCleanup).toHaveBeenCalledTimes(1)

    // The stale registration must not reach the replacement that now owns the id.
    oldRegistration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).not.toHaveBeenCalled()
  })

  it('releases an owned subscription when the registration is still current', async () => {
    const runtime = createRuntime()
    const cleanup = vi.fn()

    const registration = runtime.registerOwnedSubscriptionCleanup('terminal:live', cleanup, 'conn')
    registration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanup).toHaveBeenCalledTimes(1)
    // A second release is a no-op: the registration no longer owns the id.
    registration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses an unsubscribe from a connection that no longer owns the subscription', async () => {
    const runtime = createRuntime()
    const oldCleanup = vi.fn()
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:unsub', oldCleanup, 'conn-old')
    runtime.registerSubscriptionCleanup('terminal:unsub', replacementCleanup, 'conn-new')

    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:unsub', 'conn-old')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).not.toHaveBeenCalled()

    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:unsub', 'conn-new')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
  })

  it('reports an unregistered subscription as gone rather than refused', async () => {
    const runtime = createRuntime()

    // Why it matters: a client retrying on `false` would otherwise chase a dead id.
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:missing', 'conn-a')).toBe(true)
  })

  it('reports a refusal even when a sibling id was merely absent', async () => {
    const runtime = createRuntime()
    const bareCleanup = vi.fn()
    const compositeCleanup = vi.fn()

    // A clientless stream registers under the bare id; a client-scoped one under the composite.
    runtime.registerSubscriptionCleanup('terminal-1', bareCleanup, 'conn-a')
    runtime.registerSubscriptionCleanup('terminal-1:phone-1', compositeCleanup, 'conn-b')

    // conn-a owns the bare id but not the composite: one genuine teardown, one refusal.
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal-1', 'conn-a')).toBe(true)
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal-1:phone-1', 'conn-a')).toBe(
      false
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bareCleanup).toHaveBeenCalledTimes(1)
    expect(compositeCleanup).not.toHaveBeenCalled()
  })

  // Why: the lease-only branch's unguarded compensating handleMobileUnsubscribe is only
  // safe while a viewport-less subscribe cannot yield to the macrotask queue. Pin it so
  // adding an await to that path fails here instead of silently killing a live lease.
  it('settles a viewport-less mobile subscribe without leaving the microtask queue', async () => {
    const runtime = createRuntime()
    let settled = false

    void runtime.handleMobileSubscribe('pty-lease', 'phone-1', undefined).then(() => {
      settled = true
    })
    // Drain microtasks only: any real await on this path leaves this unsettled.
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve()
    }

    expect(settled).toBe(true)
  })

  it('tears down unconditionally for in-process callers that have no connection', async () => {
    const runtime = createRuntime()
    const cleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:inproc', cleanup, 'conn-owner')
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:inproc', undefined)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses browser screencast frames before ready and replays them once it is emitted', async () => {
    const runtime = createRuntime()
    const done = deferred<void>()
    const stop = vi.fn(() => done.resolve())
    const startupFrame = new Uint8Array([1, 2, 3])
    const sendBinary = vi.fn()
    const emit = vi.fn()
    let pendingFrame: Uint8Array | null = null
    let gatedSend!: (bytes: Uint8Array) => boolean | void
    const browserScreencast = vi.fn(
      async (_params: unknown, stream: { sendBinary: typeof sendBinary }) => {
        gatedSend = stream.sendBinary
        // Why: a joining subscriber's viewport snapshot is captured here, before the caller
        // has emitted ready, so the fan-out retains what the gate refuses.
        if (gatedSend(startupFrame) === false) {
          pendingFrame = startupFrame
        }
        expect(sendBinary).not.toHaveBeenCalled()
        return {
          subscriptionId: 'browser-screencast:page-1:first',
          ready: {
            type: 'ready',
            subscriptionId: 'browser-screencast:page-1:first',
            browserPageId: 'page-1',
            format: 'jpeg',
            tab: {
              browserPageId: 'page-1',
              index: 0,
              url: 'about:blank',
              title: 'Browser',
              active: true
            }
          },
          flushPendingFrame: () => {
            const bytes = pendingFrame
            pendingFrame = null
            if (bytes) {
              gatedSend(bytes)
            }
          },
          session: { stop, done: done.promise }
        }
      }
    )

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const task = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary, emit }
    )

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
    )
    // The gate still refuses the frame on arrival; it reaches the client only via the
    // post-ready replay, so a static page does not leave the subscriber frameless.
    expect(sendBinary).toHaveBeenCalledExactlyOnceWith(startupFrame)

    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await task
  })

  it('delivers pending mail via notifyMessageArrived when the recipient is already idle', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'after wait'
      })

      // Why: notifyMessageArrived is the send-path hook; it must push-on-idle
      // without requiring another agent-status transition (#12536).
      runtime.notifyMessageArrived(terminal.handle, 'status')

      // The push is deferred one microtask so it lands behind any resolved check.
      await Promise.resolve()
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(write).not.toHaveBeenCalledWith('pty-1', expect.stringContaining('after wait'))
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points a Run mailbox at its live-idle coordinator without replaying pending rows', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      db.setRun({
        id: 'run_mailbox',
        coordinator_handle: terminal.handle,
        coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
      })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      const message = db.insertMessage({
        from: 'term_worker',
        to: 'run:run_mailbox',
        subject: 'one P3 finding',
        body: 'private worker report',
        type: 'worker_done'
      })

      runtime.notifyMessageArrived('run:run_mailbox', 'worker_done')
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_mailbox`.\n'
      )
      expect(write).not.toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('private worker report')
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))

      runtime.notifyMessageArrived('run:run_mailbox', 'worker_done')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(500)
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints worker_done when a stale waiter wakes without consuming it', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      db.setRun({
        id: 'run_stale_waiter',
        coordinator_handle: terminal.handle,
        coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
      })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      write.mockClear()

      const staleWait = runtime.waitForMessage('run:run_stale_waiter', {
        typeFilter: ['worker_done'],
        timeoutMs: 60_000
      })
      db.insertMessage({
        from: 'term_final_worker',
        to: 'run:run_stale_waiter',
        subject: 'final worker settled',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived('run:run_stale_waiter', 'worker_done')

      await expect(staleWait).resolves.toBe('notified')
      expect(write).not.toHaveBeenCalled()

      db.insertMessage({
        from: 'term_other_worker',
        to: 'run:run_stale_waiter',
        subject: 'newer status',
        type: 'status'
      })
      runtime.deliverPendingMessagesForHandle('run:run_stale_waiter', new Set(['worker_done']))
      await vi.advanceTimersByTimeAsync(500)

      const pointers = () =>
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      expect(pointers()).toHaveLength(1)
      expect(pointers()[0]?.[1]).toContain('You have 1 orchestration message')

      await vi.advanceTimersByTimeAsync(1_500)
      expect(pointers()).toHaveLength(2)
      expect(pointers()[1]?.[1]).toContain('You have 1 orchestration message')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints on the retry edge when live idle won the send race', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'settled at idle edge',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived(terminal.handle, 'worker_done')
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()

      const leaf = [
        ...(
          runtime as unknown as {
            leaves: Map<
              string,
              { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
            >
          }
        ).leaves.values()
      ][0]
      leaf.lastAgentStatus = 'idle'
      leaf.lastAgentStatusObservedLive = true

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves later delivery to the idle edge instead of polling a working mailbox', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const pendingReads = vi.spyOn(db, 'getUndeliveredUnreadMessages')
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'wait for idle'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(pendingReads).not.toHaveBeenCalled()
      expect(pendingMailPointerRepoints(runtime)).toBe(0)

      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(pendingReads).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points restored mail when a live-idle PTY remounts after the repair edge', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.registerPreAllocatedHandleForPty('pty-1', terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      runtime.markRendererReloading(1)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'restored'
      })
      setInMemoryOrchestrationMessages(runtime, db)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).not.toHaveBeenCalled()

      syncSinglePty(runtime)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep retrying when every pending row was already pointed', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'once'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      expect(pendingMailPointerRepoints(runtime)).toBe(0)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repoints pending rows restored with a live-idle coordinator', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({
        from: 'term_worker',
        to: terminal.handle,
        subject: 'survived restart',
        type: 'worker_done'
      })
      write.mockClear()

      setInMemoryOrchestrationMessages(runtime, db)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a pending repoint after its database closes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new OrchestrationDb(':memory:')
      const write = vi.fn().mockReturnValue(true)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      db.insertMessage({ from: 'term_worker', to: terminal.handle, subject: 'pending' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      db.close()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('points already-idle Run mail after Codex replaces its completion title', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    db.setRun({
      id: 'run_codex_native_title',
      coordinator_handle: terminal.handle,
      coordinator_pane_key: `${terminal.tabId}:${terminal.leafId}`
    })
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;fix-12953-orchestration-mail-pointer\x07', 101)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    db.insertMessage({
      from: 'term_worker',
      to: 'run:run_codex_native_title',
      subject: 'real-agent smoke complete',
      body: 'The package name is orca.',
      type: 'worker_done'
    })

    runtime.notifyMessageArrived('run:run_codex_native_title', 'worker_done')
    await Promise.resolve()

    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_codex_native_title`.\n'
      )
    })
    db.close()
  })

  it('does not inject pending mail on notify when the recipient is still working', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    bindSinglePtyRun(db, terminal.handle)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const message = db.insertMessage({
      from: 'sender',
      to: terminal.handle,
      subject: 'while working'
    })
    write.mockClear()

    runtime.notifyMessageArrived(terminal.handle, 'status')
    await Promise.resolve()

    expect(write).not.toHaveBeenCalled()
    // Why: busy must leave the row undelivered so a later idle can push it;
    // a stamp-without-write would suppress later delivery (#12584 CodeRabbit).
    expect(message.delivered_at).toBeNull()
    db.close()
  })

  it('delivers on a first live idle frame that follows a seeded idle with no transition', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex done' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'restored idle'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      write.mockClear()

      // Why no working frame: a resumed agent sitting at its prompt emits an
      // already-idle title first. The seed left lastAgentStatus 'idle', so there
      // is no transition — only the liveness edge can release the row (#12536).
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 100)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not push on a cold-restore seeded idle status with no live observation', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      // Why: the persisted title is historical — the agent may have gone busy
      // across the relaunch, so a seeded 'idle' must not authorize a PTY write.
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex done' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'seeded idle'
      })
      write.mockClear()

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()

      // The first live idle frame authorizes it and the row still delivers.
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a resolved check consume its rows before a later same-tick notify pushes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: resolveMessageWaiter removes the waiter synchronously, but the check
      // handler marks its rows read a microtask later. Two sends resuming off one
      // shared in-flight promise put a no-waiter notify inside that window, so the
      // push must not inject rows the resolved check is about to return.
      const consumed = runtime
        .waitForMessage(mailbox, { timeoutMs: 5_000 })
        .then(() => db.getUnreadMessages(mailbox).map((row) => (row.read = 1)))
      const first = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'pulled' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const second = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'also pulled'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await consumed
      await Promise.resolve()
      expect(write).not.toHaveBeenCalled()
      expect(first.delivered_at).toBeNull()
      expect(second.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves rows a live filtered waiter reserved out of the pushed batch', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: the push reads every pending row, not just the one that woke it. A
      // `status` notify is unclaimed and pushes, but the worker_done row landing
      // in the same drain belongs to this waiter's check — injecting it too would
      // deliver that completion twice (pane + check return).
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['worker_done'],
        timeoutMs: 5_000
      })
      const status = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'unclaimed status',
        type: 'status'
      })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const done = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'reserved completion',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived(terminal.handle, 'worker_done')

      await expect(waitPromise).resolves.toBe('notified')
      await vi.advanceTimersByTimeAsync(600)
      const payloads = write.mock.calls
        .map(([, data]) => data)
        .filter((data): data is string => typeof data === 'string')
      expect(payloads).toContain(
        '\nYou have 1 orchestration message. Run `orca orchestration check --run run_test`.\n'
      )
      expect(payloads.some((data) => data.includes('reserved completion'))).toBe(false)
      expect(status.delivered_at).toEqual(expect.any(String))
      expect(done.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips rows claimed by a waiter that registered after the notify', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'claimed late',
        type: 'status'
      })
      // Why: the notify snapshot is empty — no waiter existed yet. A check that
      // blocks before the deferred push runs still owns this row, so only the
      // push-time read of live waiters can keep it out of the pane.
      runtime.notifyMessageArrived(terminal.handle, 'status')
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['status'],
        timeoutMs: 5_000
      })
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      expect(message.delivered_at).toBeNull()

      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waitPromise).resolves.toBe('timed_out')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not carry pty-record live authority into a rebuilt leaf after a same-id respawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      // Why a UUID leaf id: the retirement fence's pty-candidate clause compares
      // parsePaneKey(pty.paneKey).leafId to the republished leafId, and a non-UUID
      // id falls back to `tabId:paneRuntimeId`, so it is always fenced after exit.
      const leafId = '11111111-1111-1111-8111-111111111111'
      const syncUuidLeaf = (): void => {
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
              ptyId: 'pty-1',
              paneTitle: null
            }
          ]
        })
      }
      syncUuidLeaf()

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      runtime.onPtyExit('pty-1', 0)
      runtime.onPtySpawned('pty-1', undefined, { awaitsRegistration: false })
      // Drop the leaf, then republish it: the rebuilt record's tailSource is the
      // PTY record rather than the previous leaf, which is what pins the clear
      // onPtyExit applies at the pty level.
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      syncUuidLeaf()

      const leaves = (
        runtime as unknown as {
          leaves: Map<
            string,
            { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
          >
        }
      ).leaves
      expect(leaves.size).toBeGreaterThan(0)
      const rebuilt = [...leaves.values()][0]
      expect(rebuilt.lastAgentStatus).toBe('idle')
      expect(rebuilt.lastAgentStatusObservedLive).toBe(false)

      setInMemoryOrchestrationMessages(runtime, db)
      const [republished] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, republished.handle)
      const message = db.insertMessage({
        from: 'sender',
        to: republished.handle,
        subject: 'rebuilt leaf'
      })
      runtime.notifyMessageArrived(republished.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps live idle authority across a renderer graph republish', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: syncWindowGraph rebuilds every leaf record on any pane/tab change.
      // An idle agent emits no new title, so dropping the live-status carry here
      // would strand mail until the next OSC frame — the #12536 symptom.
      syncSinglePty(runtime)

      const [republished] = (await runtime.listTerminals()).terminals
      const message = db.insertMessage({
        from: 'sender',
        to: republished.handle,
        subject: 'after republish'
      })

      runtime.notifyMessageArrived(republished.handle, 'status')
      await Promise.resolve()

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reuse the dead process live idle authority after a same-id respawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      write.mockClear()

      // Why: a cold restore respawns under the same session id and makes the
      // leaf writable again before any new title. The dead process's live idle
      // must not authorize typing into its replacement mid-turn.
      runtime.onPtyExit('pty-1', 0)
      runtime.onPtySpawned('pty-1', undefined, { awaitsRegistration: false })
      setInMemoryOrchestrationMessages(runtime, db)
      bindSinglePtyRun(db, terminal.handle)
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'after same id respawn'
      })

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toBeNull()

      // The replacement's first live idle frame re-authorizes delivery — with no
      // working frame, since exit keeps lastAgentStatus 'idle' for `ps` and the
      // replacement can come up straight at an idle prompt (no transition).
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 200)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes to an idle pane when the only live waiter filters out the message type', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })

      // Why: a `check --wait --types worker_done` waiter never returns a status
      // row — check re-reads under the same filter — so it is not the consumer
      // and treating it as one would strand the message (#12536).
      const waitPromise = runtime.waitForMessage(mailbox, {
        typeFilter: ['worker_done'],
        timeoutMs: 5_000
      })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'unfiltered status',
        type: 'status'
      })
      write.mockClear()

      runtime.notifyMessageArrived(terminal.handle, 'status')

      await Promise.resolve()
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(message.delivered_at).toEqual(expect.any(String))

      // The filtered waiter stays blocked; the push did not consume its wake.
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(waitPromise).resolves.toBe('timed_out')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a registered waiter without PTY-injecting when the leaf is already idle', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      const mailbox = bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const message = db.insertMessage({
        from: 'sender',
        to: terminal.handle,
        subject: 'for check wait'
      })
      write.mockClear()

      // Why: blocked orchestration.check --wait is an explicit pull; push must
      // not stamp delivered_at or type into the pane (double delivery, #12584).
      const waitPromise = runtime.waitForMessage(mailbox, { timeoutMs: 5_000 })
      runtime.notifyMessageArrived(terminal.handle, 'status')

      await expect(waitPromise).resolves.toBe('notified')
      expect(write).not.toHaveBeenCalled()
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-inject the same message when notify fires again during Enter delay', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'once only' })

      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()

      const pointerWrites = write.mock.calls.filter(
        ([, payload]) => typeof payload === 'string' && payload.includes('orca orchestration check')
      )
      expect(pointerWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      const enterWrites = write.mock.calls.filter(([, payload]) => payload === '\r')
      expect(enterWrites).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers a second message parked during Enter delay once the flight settles', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
      const first = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'first' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      // Why the flush: the deferred push must actually arm its flight before the
      // second message arrives, or this exercises a plain batch instead.
      await Promise.resolve()

      // Why: mid-flight notify parks the leaf; flight settle re-runs delivery
      // so the second row is not lost and is not double-injected with the first.
      const second = db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'second' })
      runtime.notifyMessageArrived(terminal.handle, 'status')
      await Promise.resolve()
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(1)
      expect(second.delivered_at).toBeNull()

      // Why: release must not require another agent-status OSC — only the
      // delayed-Enter flight timer. Advancing 3s with no status output covers
      // timer-only settle (CodeRabbit settling-timeout gap, #12584).
      await vi.advanceTimersByTimeAsync(3_000)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      expect(first.delivered_at).toEqual(expect.any(String))
      expect(
        write.mock.calls.filter(
          ([, payload]) =>
            typeof payload === 'string' && payload.includes('orca orchestration check')
        )
      ).toHaveLength(2)
      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(second.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps already-idle status after tui-idle wait for immediate message delivery', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    bindSinglePtyRun(db, terminal.handle)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
    await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
    db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'after wait' })

    runtime.deliverPendingMessagesForHandle(terminal.handle)

    expect(write).toHaveBeenCalledWith(
      'pty-1',
      expect.stringContaining('You have 1 orchestration message')
    )
    db.close()
  })

  it('resolves message waiters when notifyMessageArrived is called', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', { timeoutMs: 5000 })
    runtime.notifyMessageArrived('term_abc')
    await expect(waitPromise).resolves.toBe('notified')
  })

  it('does not resolve type-filtered message waiters for unrelated message types', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', {
      typeFilter: ['worker_done', 'escalation'],
      timeoutMs: 5000
    })
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })

    runtime.notifyMessageArrived('term_abc', 'heartbeat')
    await Promise.resolve()

    expect(settled).toBe(false)

    runtime.notifyMessageArrived('term_abc', 'worker_done')
    await waitPromise
    expect(settled).toBe(true)
  })

  it('removes message waiter abort listeners after message arrival', async () => {
    const runtime = new OrcaRuntimeService(store)
    const controller = new AbortController()
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const waitPromise = runtime.waitForMessage('term_abc', {
      timeoutMs: 5000,
      signal: controller.signal
    })
    runtime.notifyMessageArrived('term_abc')
    await waitPromise

    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('resolves message waiters on timeout when no message arrives', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const wait = runtime.waitForMessage('term_abc', { timeoutMs: 100 })

      await vi.advanceTimersByTimeAsync(99)
      let settled = false
      void wait.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(wait).resolves.toBe('timed_out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows only one exclusive mailbox waiter and supports explicit cancellation', async () => {
    const runtime = new OrcaRuntimeService(store)
    const first = runtime.waitForMessage('run:run_1', {
      timeoutMs: 5000,
      exclusive: true
    })

    await expect(
      runtime.waitForMessage('run:run_1', { timeoutMs: 5000, exclusive: true })
    ).resolves.toBe('waiter_exists')
    runtime.cancelMessageWaiters('run:run_1')
    await expect(first).resolves.toBe('cancelled')
  })

  it('rejects leaf PTY waits when the request signal aborts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const controller = new AbortController()

      const waitPromise = runtime
        .waitForLeafPtyId('missing-handle', 60_000, controller.signal)
        .then(() => 'resolved')
        .catch((error: Error) => error.message)

      controller.abort()
      const outcomePromise = Promise.race([
        waitPromise,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
      await vi.advanceTimersByTimeAsync(0)

      expect(await outcomePromise).toBe('request_aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails terminal waits closed when the handle goes stale during reload', async () => {
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

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.markRendererReloading(1)

    await expect(waitPromise).rejects.toThrow('terminal_handle_stale')
  })

  it('tui-idle times out when PTY data has no agent OSC title transitions', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
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
      runtime.onPtyData('pty-1', 'running migration step 4/9\n', 123)

      const [terminal] = (await runtime.listTerminals()).terminals
      const waitPromise = runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(12_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tui-idle resolves on agent working→idle OSC title transition', async () => {
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

    // Simulate agent starting work (braille spinner = working)
    runtime.onPtyData('pty-1', '\x1b]0;\u280b Working on task\x07output\n', 100)

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })

    // Simulate agent finishing (✳ = Claude Code idle)
    runtime.onPtyData('pty-1', '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const result = await waitPromise
    expect(result.condition).toBe('tui-idle')
    expect(result.satisfied).toBe(true)
  })

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

  it('returns a setup launch payload for CLI-created worktrees when hooks are explicitly enabled', async () => {
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-test',
        head: 'def',
        branch: 'runtime-hook-test',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-test',
      runHooks: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-test',
      'pnpm worktree:setup',
      undefined,
      undefined,
      undefined
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(addWorktree).toHaveBeenCalledWith(
      '/tmp/repo',
      '/tmp/workspaces/runtime-hook-test',
      'runtime-hook-test',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-test',
        branch: 'runtime-hook-test'
      }),
      setup: {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
        }
      }
    })
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('passes setup payloads through when explicitly activating CLI-created worktrees', async () => {
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-activate'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-activate',
        head: 'def',
        branch: 'runtime-hook-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-activate',
      runHooks: true,
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('passes the selected Windows setup shell into runtime runner generation', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        terminalWindowsShell: 'git-bash'
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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

    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\runtime-hook-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\runtime-hook-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(resolveSetupRunnerShell).mockReturnValue({ family: 'posix' })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-activate'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: 'C:/workspaces/runtime-hook-activate',
        head: 'def',
        branch: 'runtime-hook-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-activate',
      runHooks: true,
      activate: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      'C:\\workspaces\\runtime-hook-activate',
      'pnpm worktree:setup',
      undefined,
      { family: 'posix' },
      undefined
    )
    expect(result.setup).toMatchObject({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' }
    })
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('follows normal setup policy for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hook-skip',
        head: 'def',
        branch: 'runtime-hook-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-skip'
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-skip',
      'pnpm worktree:setup',
      undefined,
      undefined,
      undefined
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-skip',
        branch: 'runtime-hook-skip'
      })
    })
    expect(result.setup).toBeUndefined()
    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: undefined,
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        // Why: createTerminal stamps ORCA_PANE_KEY/TAB_ID/WORKTREE_ID so hook-based agent status can attribute events to a stable pane.
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip',
          ORCA_TAB_ID: expect.stringMatching(UUID_RE),
          ORCA_PANE_KEY: expect.any(String),
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const setupSpawnEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(setupSpawnEnv)
    const setupLeafId = setupSpawnEnv.ORCA_PANE_KEY.slice(`${setupSpawnEnv.ORCA_TAB_ID}:`.length)
    // Why: a background CLI create adopts its tabs silently — surfaceOwner:false
    // keeps the sidebar from scrolling to a workspace the user never asked for.
    expect(revealTerminalSession).toHaveBeenLastCalledWith(result.worktree.id, {
      ptyId: 'pty-setup',
      title: 'Setup',
      activate: false,
      surfaceOwner: false,
      tabId: setupSpawnEnv.ORCA_TAB_ID,
      leafId: setupLeafId
    })
  })

  it('uses returned WSL setup shell metadata when runtime spawns setup', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\runtime-hook-wsl')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\runtime-hook-wsl')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-wsl'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:/workspaces/runtime-hook-wsl',
        head: 'def',
        branch: 'runtime-hook-wsl',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-wsl'
    })

    expect(result.setup).toBeUndefined()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /mnt/c/repo/.git/orca/setup-runner.sh',
        env: expect.objectContaining({
          ORCA_ROOT_PATH: 'C:\\repo',
          ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-wsl',
          ORCA_TAB_ID: expect.stringMatching(UUID_RE),
          ORCA_PANE_KEY: expect.any(String),
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
  })

  it('uses the shell-aware setup runner for windowless creates without a startup command', async () => {
    // Regression (C1): with no authoritative window and no startup command the
    // create fell back to runHook, which hardcodes cmd.exe on Windows and so ran
    // batch even when the configured terminal resolves to Git Bash.
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-windowless' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    // Deliberately no attachWindow: this is the windowless/CLI create path.

    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\runtime-hook-windowless')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\runtime-hook-windowless')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(resolveSetupRunnerShell).mockReturnValue({ family: 'posix' })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspaces\\runtime-hook-windowless'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:/workspaces/runtime-hook-windowless',
        head: 'def',
        branch: 'runtime-hook-windowless',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-windowless',
      awaitTerminalProvisioning: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      'C:\\workspaces\\runtime-hook-windowless',
      'pnpm worktree:setup',
      undefined,
      { family: 'posix' },
      undefined
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(result.setupReceipt).toMatchObject({ state: 'running' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'bash /c/repo/.git/orca/setup-runner.sh',
        worktreeId: result.worktree.id
      })
    )
  })

  it('reports the in-process setup hook as running when nothing can launch the runner', async () => {
    // Regression (C1): the fire-and-forget hook is the last resort when there is
    // no PTY controller; reporting spawn_failed made callers retry a live hook.
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-no-pty')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-no-pty')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hook-no-pty',
        head: 'def',
        branch: 'runtime-hook-no-pty',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-no-pty',
      awaitTerminalProvisioning: true
    })

    expect(createSetupRunnerScript).not.toHaveBeenCalled()
    expect(runHook).toHaveBeenCalledWith(
      'setup',
      '/tmp/workspaces/runtime-hook-no-pty',
      expect.objectContaining({ id: 'repo-1' }),
      '/tmp/workspaces/runtime-hook-no-pty',
      undefined
    )
    expect(result.setupReceipt).toMatchObject({ state: 'running' })
  })

  it('sequences setup before startup for opted-in local headless worktree creates', async () => {
    const waitRepo = {
      ...store.getRepo('repo-1')!,
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [waitRepo],
      getRepo: (id: string) => (id === 'repo-1' ? waitRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-headless-startup' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-headless-startup' })
      .mockResolvedValueOnce({ id: 'pty-headless-setup' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-headless-startup-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-headless-startup-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-headless-startup-setup'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-headless-startup-setup',
        head: 'def',
        branch: 'runtime-headless-startup-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-headless-startup-setup',
      setupDecision: 'run',
      startup: { command: 'claude', viewMode: 'chat' }
    })

    expect(createSetupRunnerScript).toHaveBeenCalled()
    expect(runHook).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ viewMode: 'chat' })
    )
    // Why: setup is provisioned fire-and-forget; the wait-for-setup guarantee comes from the shell nonce/marker, not JS spawn ordering.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const startup = spawn.mock.calls[0]![0] as {
      command: string
      env: Record<string, string>
    }
    const startupCommand = startup.command
    const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
    expect(nonceMatch?.[1]).toBeTruthy()
    expect(startupCommand.length).toBeLessThan(256)
    expect(startupScript).toContain('exec claude')
    expect(startupScript).toContain('/mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('printf')
    expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
    expect(result.setup).toBeUndefined()
  })

  it('starts setup and startup side by side by default for local headless worktree creates', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-headless-parallel' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-headless-parallel-startup' })
      .mockResolvedValueOnce({ id: 'pty-headless-parallel-setup' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-headless-parallel')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-headless-parallel')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-headless-parallel'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-headless-parallel',
        head: 'def',
        branch: 'runtime-headless-parallel',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-headless-parallel',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    // Why: setup now spawns fire-and-forget on a later tick; wait for both PTYs.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'claude' }))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.stringContaining('__ORCA_SETUP_COMPLETE__:')
      })
    )
    expect(result.setupReceipt).toMatchObject({
      state: 'running',
      terminalHandle: expect.stringMatching(/^term_/)
    })
  })

  it('observes setup completion through the launch shell the runner was written for', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-observed-wsl-shell' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-observed-wsl-startup' })
      .mockResolvedValueOnce({ id: 'pty-observed-wsl-setup' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-observed-wsl-shell')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-observed-wsl-shell')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-observed-wsl-shell'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-observed-wsl-shell',
        head: 'def',
        branch: 'runtime-observed-wsl-shell',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-observed-wsl-shell',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    expect(setupCommand).toContain('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('__ORCA_SETUP_COMPLETE__:')
  })

  it('creates the first terminal for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created-worktree' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-initial-terminal',
        head: 'def',
        branch: 'runtime-initial-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-initial-terminal'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-initial-terminal',
        worktreeId: result.worktree.id,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    const initialSpawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(initialSpawnEnv)
    const initialLeafId = initialSpawnEnv.ORCA_PANE_KEY.slice(
      `${initialSpawnEnv.ORCA_TAB_ID}:`.length
    )
    // Why: the renderer treats a missing surfaceOwner as "reveal the owner", which
    // scrolled the sidebar to background CLI creates.
    expect(revealTerminalSession).toHaveBeenCalledWith(result.worktree.id, {
      ptyId: 'pty-created-worktree',
      title: null,
      activate: false,
      surfaceOwner: false,
      tabId: initialSpawnEnv.ORCA_TAB_ID,
      leafId: initialLeafId
    })
  })

  it('does not surface the new workspace when a background CLI create launches its agent', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-background-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-background-agent' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-background-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-background-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-background-agent',
        head: 'def',
        branch: 'runtime-background-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-background-agent',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // `orca worktree create --agent claude` without --activate: the agent tab is
    // adopted, but the sidebar must stay on whatever the user was reading.
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-background-agent',
        activate: false,
        surfaceOwner: false
      })
    )
  })

  it('still surfaces the new workspace when the caller explicitly activates it', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-activated-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-activated-agent' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activated-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activated-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-activated-agent',
        head: 'def',
        branch: 'runtime-activated-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activated-agent',
      activate: true,
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // No-regression guard: an explicit --activate still reveals the workspace, so
    // surfaceOwner must stay absent.
    const revealPayload = revealTerminalSession.mock.calls[0]?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({ ptyId: 'pty-activated-agent' })
    )
    expect(revealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('still surfaces the new workspace when hooks run in the foreground', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-hooks-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-hooks-agent' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hooks-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hooks-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hooks-agent',
        head: 'def',
        branch: 'runtime-hooks-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hooks-agent',
      runHooks: true,
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    const revealPayload = revealTerminalSession.mock.calls[0]?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({ ptyId: 'pty-hooks-agent' })
    )
    expect(revealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('honors split setup placement for CLI-created worktrees without startup agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-vertical' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-cli-setup-main' })
      .mockResolvedValueOnce({ id: 'pty-cli-setup-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm install'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-cli-setup-split'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-split',
        head: 'def',
        branch: 'runtime-cli-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-split',
      setupDecision: 'run'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expectStablePaneKeyEnv(mainEnv)
    expectStablePaneKeyEnv(setupEnv)
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-cli-setup-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('does not surface the new workspace when a background create splits its setup pane', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-bg-split-main' })
      .mockResolvedValueOnce({ id: 'pty-bg-split-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-bg-split-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-bg-split-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-bg-split-setup'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-bg-split-setup',
        head: 'def',
        branch: 'runtime-bg-split-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-bg-split-setup',
      setupDecision: 'run'
    })

    // Split launch modes reach the renderer through splitTerminal, not
    // createTerminal — that path must suppress owner surfacing too.
    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    await vi.waitFor(() =>
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-bg-split-setup',
          tabId: mainEnv.ORCA_TAB_ID,
          activate: false,
          surfaceOwner: false,
          splitDirection: 'horizontal'
        })
      )
    )
  })

  it('still surfaces the new workspace when an activating create splits its setup pane', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-active-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-active-split-main' })
      .mockResolvedValueOnce({ id: 'pty-active-split-setup' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-active-split-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-active-split-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-active-split-setup'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-active-split-setup',
        head: 'def',
        branch: 'runtime-active-split-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-active-split-setup',
      activate: true,
      setupDecision: 'run',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // No-regression guard: an explicit --activate still reveals the workspace.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-active-split-setup',
          splitDirection: 'horizontal'
        })
      )
    )
    const splitRevealPayload = revealTerminalSession.mock.lastCall?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(splitRevealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('does not warn when setup is explicitly skipped for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-setup-skip' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-skip' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-skip',
        head: 'def',
        branch: 'runtime-cli-setup-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-skip',
      setupDecision: 'skip',
      awaitTerminalProvisioning: true
    })

    expect(result.warning).toBeUndefined()
    expect(result.setupReceipt).toMatchObject({ requested: 'skip', state: 'skipped' })
    expect(createSetupRunnerScript).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('materializes default tabs for inactive local managed worktree creates', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-default-dev' })
      .mockResolvedValueOnce({ id: 'pty-default-test' })
    const revealTerminalSession = vi
      .fn()
      .mockResolvedValueOnce({ tabId: 'tab-default-dev' })
      .mockResolvedValueOnce({ tabId: 'tab-default-test' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-default-tabs')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-default-tabs')
    vi.mocked(getDefaultTabsLaunch).mockReturnValue({
      runCommands: true,
      tabs: [
        { title: 'Dev', command: 'pnpm dev' },
        { title: 'Test', command: 'pnpm test' }
      ]
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-default-tabs',
        head: 'def',
        branch: 'runtime-default-tabs',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-default-tabs',
      setupDecision: 'run'
    })

    expect(result.defaultTabs).toEqual({
      runCommands: true,
      tabs: [
        { title: 'Dev', command: 'pnpm dev' },
        { title: 'Test', command: 'pnpm test' }
      ]
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn.mock.calls[0]![0]).toMatchObject({ command: 'pnpm dev' })
    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'pnpm test' })
    expect(revealTerminalSession).toHaveBeenNthCalledWith(
      1,
      result.worktree.id,
      expect.objectContaining({ title: 'Dev', activate: false })
    )
    expect(revealTerminalSession).toHaveBeenNthCalledWith(
      2,
      result.worktree.id,
      expect.objectContaining({ title: 'Test', activate: false })
    )
  })

  it('uses desktop task agent selection and bracketed-pastes startup drafts for local worktrees', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: { codex: 'codex --profile work' }
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-startup-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-draft',
        head: 'def',
        branch: 'runtime-startup-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/123'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-draft',
      startupDraft: draftUrl,
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-draft',
        command: "codex --profile work '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-startup-draft', '\x1b[?2004h', Date.now())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(write).not.toHaveBeenCalled()

    runtime.onPtyData('pty-startup-draft', '›', Date.now())
    await Promise.resolve()
    await Promise.resolve()

    expect(write).toHaveBeenCalledWith('pty-startup-draft', `\x1b[200~${draftUrl}\x1b[201~`)
  })

  it('keeps the 8s main-runtime startup readiness budget for non-Codex agents', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'opencode' as const,
        agentCmdOverrides: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-opencode-draft-timeout' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-opencode-draft-timeout' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-opencode-draft-timeout')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-opencode-draft-timeout')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-opencode-draft-timeout',
        head: 'def',
        branch: 'runtime-opencode-draft-timeout',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-opencode-draft-timeout',
      startupDraft: 'https://github.com/stablyai/orca/issues/456'
    })

    await vi.advanceTimersByTimeAsync(7999)
    expect(write).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    runtime.onPtyData('pty-opencode-draft-timeout', '\x1b[?2004h\x1b[?25h', Date.now())
    await Promise.resolve()
    await Promise.resolve()

    expect(write).not.toHaveBeenCalled()
  })

  it('rejects explicit startup commands for disabled selected agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const]
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-disabled-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'disabled-startup',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled. Choose an enabled agent before creating.')

    expect(spawn).not.toHaveBeenCalled()
    expect(addWorktree).not.toHaveBeenCalled()
  })

  it('launches explicit startup agents with prompts for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-agent-startup' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-agent-startup',
        head: 'def',
        branch: 'runtime-cli-agent-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-agent-startup',
      startupAgent: 'codex',
      startupPrompt: 'hi'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-agent-startup',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
  })

  it('sends follow-up prompts for CLI-created stdin-after-start startup agents', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-aider-startup' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => 'aider'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-aider-startup',
        head: 'def',
        branch: 'runtime-cli-aider-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-aider-startup',
      startupAgent: 'aider',
      startupPrompt: 'fix it'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-aider-startup',
        command: "aider '--yes-always'",
        worktreeId: result.worktree.id
      })
    )
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-cli-aider-startup', 'fix it\r')
    })
  })

  it('does not send stdin-after-start prompts into a shell when the agent never starts', async () => {
    vi.useFakeTimers()
    try {
      const metaById: Record<string, WorktreeMeta> = {}
      const runtimeStore = {
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          agentCmdOverrides: {}
        }),
        getAllWorktreeMeta: () => metaById,
        getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
        setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
          metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
          return metaById[worktreeId]
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-cli-aider-shell' }),
        write,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        hasChildProcesses: vi.fn().mockResolvedValue(false)
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-shell' }),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)

      computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: '/tmp/workspaces/runtime-cli-aider-shell',
          head: 'def',
          branch: 'runtime-cli-aider-shell',
          isBare: false,
          isMainWorktree: false
        }
      ])

      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'runtime-cli-aider-shell',
        startupAgent: 'aider',
        startupPrompt: 'fix it'
      })

      await vi.advanceTimersByTimeAsync(6000)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the resolved fallback agent when the requested startup draft agent is disabled', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        disabledTuiAgents: ['codex' as const],
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-fallback-draft' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-fallback-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-fallback-draft',
        head: 'def',
        branch: 'runtime-fallback-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-fallback-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/456',
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-fallback-draft',
        command: expect.stringContaining('claude'),
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('honors split setup placement for opted-in local startup-draft worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        setupScriptLaunchMode: 'split-vertical' as const
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-split-main' })
      .mockResolvedValueOnce({ id: 'pty-startup-split-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-startup-split' })
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
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-split',
        head: 'def',
        branch: 'runtime-startup-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-split',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      setupDecision: 'run',
      activate: true,
      awaitTerminalProvisioning: true
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: expect.stringContaining('codex')
        }),
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh'),
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split',
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const startup = spawn.mock.calls[0]![0] as {
      command: string
      env: Record<string, string>
    }
    const startupCommand = startup.command
    const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
    expect(nonceMatch?.[1]).toBeTruthy()
    const markerPath = `/tmp/repo/.git/orca/setup-runner.sh.${nonceMatch![1]}.done`
    expect(startupCommand.length).toBeLessThan(256)
    expect(startupScript).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(setupCommand).toContain('printf')
    expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
    expect(startupScript).toContain(markerPath)
    expect(setupCommand).toContain(markerPath)
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expect(result.setup).toBeUndefined()
    expect(result.setupReceipt).toMatchObject({
      state: 'running',
      terminalHandle: expect.stringMatching(/^term_/)
    })
    expect(mainEnv.ORCA_TAB_ID).toBeDefined()
    expect(mainEnv.ORCA_PANE_KEY).toBeDefined()
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-startup-split-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('passes the wrapped setup command to activation when startup spawned but setup did not', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-main' })
      .mockRejectedValueOnce(new Error('setup spawn failed'))
    const activateWorktree = vi.fn()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-main' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-retry')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-retry')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-retry'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-retry',
        head: 'def',
        branch: 'runtime-startup-setup-retry',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-retry',
      setupDecision: 'run',
      activate: true,
      startup: { command: 'claude' }
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      expect.objectContaining({
        runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
        command: expect.stringContaining('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
      }),
      undefined,
      undefined
    )
    const activationSetup = activateWorktree.mock.calls[0]?.[2] as { command?: string } | undefined
    expect(activationSetup?.command).toContain('printf')
  })

  it('lets explicit startup draft agents override the desktop default', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue([])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'claude' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-explicit-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-explicit-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-explicit-draft',
        head: 'def',
        branch: 'runtime-explicit-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/789'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-explicit-draft',
      startupDraft: draftUrl,
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-explicit-draft',
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-explicit-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-explicit-draft', `\x1b[200~${draftUrl}\x1b[201~`)
    })
  })

  it('does not auto-launch an agent for startup drafts when the default is blank', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude', 'codex'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'blank' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-blank-draft' })
    const activateWorktree = vi.fn()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-blank-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-blank-draft',
        head: 'def',
        branch: 'runtime-blank-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-blank-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(metaById[result.worktree.id]?.createdWithAgent).toBeUndefined()
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      result.worktree.id,
      undefined,
      undefined,
      undefined
    )
  })

  it('forwards generated-name provenance while launching SSH startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['claude'])
    const created = {
      path: '/remote/repo-nautilus-2',
      head: 'def',
      branch: 'refs/heads/nautilus-2',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
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
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: null,
        agentCmdOverrides: {}
      }),
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: ['nautilus'] }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-startup-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const draftUrl = 'https://github.com/stablyai/orca/pull/456'
    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'nautilus',
      nameWasGenerated: true,
      startupDraft: draftUrl
    })

    expect(detectRemoteAgentsMock).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'nautilus-2',
      '/remote/repo-nautilus-2',
      expect.any(Object)
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/remote/repo-nautilus-2',
        command: `claude '--dangerously-skip-permissions' --prefill '${draftUrl}'`,
        connectionId: 'ssh-1',
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('pre-marks remote Codex workspaces trusted before pasting startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['codex'])
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-draft',
      head: 'def',
      branch: 'refs/heads/mobile-codex-draft',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
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
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-draft'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-draft',
        startupDraft: 'https://github.com/stablyai/orca/issues/789'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.createDir).toHaveBeenCalledWith('/home/dev/.codex')
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-draft"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-draft',
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('pre-marks remote Codex workspaces trusted before explicit startup commands', async () => {
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-command',
      head: 'def',
      branch: 'refs/heads/mobile-codex-command',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
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
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => store.getSettings(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-command'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-command' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-command',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-command"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-command',
          command: 'codex',
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('passes SSH connection ids through GitLab task operations', async () => {
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Issue title',
          state: 'opened',
          url: 'https://gitlab.example/issues/7',
          labels: ['bug'],
          updatedAt: '2026-05-22T00:00:00Z',
          author: 'alex'
        }
      ],
      totalPages: 3
    })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue(['bug', 'frontend'])
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 1,
      url: 'https://gitlab.example/issues/1'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })

    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    const issues = await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', '@me', 50, 3)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'New issue', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { state: 'closed' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Looks good')
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Ship it')
    const inlineCommentInput = {
      body: 'please fix',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineCommentInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1, 2])
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      '/remote/repo',
      50,
      'origin',
      'opened',
      '@me',
      'ssh-1',
      {},
      3
    )
    expect(issues.items).toEqual([
      {
        id: `gitlab-issue-${TEST_REPO_ID}-7`,
        type: 'issue',
        number: 7,
        title: 'Issue title',
        state: 'opened',
        url: 'https://gitlab.example/issues/7',
        labels: ['bug'],
        updatedAt: '2026-05-22T00:00:00Z',
        author: 'alex',
        repoId: TEST_REPO_ID
      }
    ])
    expect(issues).toMatchObject({ totalPages: 3 })
    expect(listGitLabTodosMock).toHaveBeenCalledWith('/remote/repo', 'ssh-1')
    expect(listGitLabLabelsMock).toHaveBeenCalledWith('/remote/repo', 'origin', 'ssh-1')
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      'New issue',
      'Body',
      'origin',
      'ssh-1'
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      { state: 'closed' },
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      'Looks good',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'Ship it',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      inlineCommentInput,
      'origin',
      'ssh-1',
      undefined
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'discussion-1',
      true,
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'squash',
      'origin',
      'ssh-1',
      undefined
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(reopenGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'mr',
      'origin',
      'ssh-1',
      undefined
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      [1, 2],
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      '/remote/repo',
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue',
      'ssh-1'
    )
  })

  it('routes runtime GitLab issue, MR, work-item, and todo actions through the selected WSL project runtime', async () => {
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
    const localGitOptions = { wslDistro: 'Ubuntu' }
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({ items: [] })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue([])
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 7,
      url: 'https://gitlab.example/issues/7'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'opened', 1, 20)
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'opened', 1, 20)
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', undefined, 20)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'Title', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { body: 'Updated' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Comment')

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      undefined,
      null,
      localGitOptions,
      1
    )
    expect(listGitLabTodosMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, localGitOptions)
    expect(listGitLabLabelsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'Title',
      'Body',
      undefined,
      null,
      localGitOptions
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      { body: 'Updated' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
  })

  it('routes runtime GitLab MR details, review-management, job, and pasted URL actions through the selected WSL project runtime', async () => {
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
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const inlineInput = {
      body: 'Inline',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRMock.mockResolvedValue({ ok: true })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'trace' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({ type: 'mr', number: 8 })

    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMR(TEST_REPO_ID, 8, { title: 'Renamed' })
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1])
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Comment')
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr'
    )

    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      { title: 'Renamed' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      [1],
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      inlineInput,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'discussion-1',
      true,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'squash',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(reopenGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr',
      null,
      localGitOptions
    )
  })

  it('normalizes runtime GitLab issue list arguments like the desktop IPC path', async () => {
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.listGitLabRepoIssues(
      TEST_REPO_ID,
      'closed',
      'someone-else' as never,
      250.8,
      20_000
    )
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'all', '@me', 0.7, 0)
    await runtime.listGitLabRepoIssues(
      TEST_REPO_ID,
      'unexpected' as never,
      '@me',
      Number.NaN,
      Number.NaN
    )

    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      1,
      TEST_REPO_PATH,
      100,
      undefined,
      'closed',
      undefined,
      null,
      {},
      10_000
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      2,
      TEST_REPO_PATH,
      1,
      undefined,
      'all',
      '@me',
      null,
      {},
      1
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      3,
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      '@me',
      null,
      {},
      1
    )
  })

  it('records GitLab pasted-project recents only after successful runtime lookup', async () => {
    let settings = {
      ...store.getSettings(),
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: []
      }
    }
    const updateSettings = vi.fn((updates: Record<string, unknown>) => {
      settings = { ...settings, ...updates } as typeof settings
    })
    const runtimeStore = {
      ...store,
      getSettings: () => settings,
      updateSettings
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(updateSettings).toHaveBeenCalledWith({
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: [
          expect.objectContaining({
            host: 'gitlab.example.com',
            path: 'group/project',
            lastOpenedAt: expect.any(String)
          })
        ]
      }
    })

    updateSettings.mockClear()
    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce(null)
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/missing' },
      404,
      'issue'
    )

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('threads explicit origin preference through runtime WSL PR base resolution', async () => {
    setPlatform('win32')
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
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
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (isOriginMainBaseRefProbe(args)) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'config') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (args[2] !== 'origin' && args[2] !== 'upstream') {
          throw new Error(`unexpected remote: ${String(args[2])}`)
        }
        const url =
          args[2] === 'origin'
            ? 'git@github.com:org/repo.git'
            : 'git@github.com:org/upstream-repo.git'
        return { stdout: `${url}\n`, stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'origin/feature/add-feature'
      ) {
        return { stdout: 'pr-head-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedPrBase({
        repoSelector: 'id:repo-1',
        prNumber: 42,
        headRefName: 'feature/add-feature',
        isCrossRepository: false
      })

      expect(result).toMatchObject({
        baseBranch: 'pr-head-sha',
        headSha: 'pr-head-sha',
        branchNameOverride: 'feature/add-feature'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          'origin',
          '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(['rev-parse', '--verify', 'origin/feature/add-feature'], {
        cwd: TEST_REPO_PATH,
        wslDistro: 'Ubuntu'
      })
      // Why: the explicit origin preference must short-circuit before any
      // identity probe, so no remote — not just upstream — gets a get-url.
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['remote', 'get-url', expect.anything()],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('resolves SSH GitHub fork PR heads through the write-capable fetch RPC', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
        }
        if (args[0] === 'remote') {
          return { stdout: 'origin\nupstream\n', stderr: '' }
        }
        if (
          args[0] === 'rev-parse' &&
          args[2] === `refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
        ) {
          return { stdout: 'remote-fork-pr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitHubPullRequestHead: vi
        .fn()
        .mockResolvedValue(`refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42`),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedPrBase({
      repoSelector: 'id:repo-1',
      prNumber: 42,
      headRefName: 'contributor/fix',
      isCrossRepository: true
    })

    expect(result).toEqual({
      baseBranch: 'remote-fork-pr-sha',
      headSha: 'remote-fork-pr-sha',
      branchNameOverride: 'contributor/fix'
    })
    expect(provider.fetchGitHubPullRequestHead).toHaveBeenCalledWith('/remote/repo', 'origin', 42)
    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/remote/repo',
      42,
      'ssh-1',
      {},
      'origin'
    )
    expect(provider.exec).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      '/remote/repo'
    )
  })

  it('resolves local GitLab fork MR bases from the target project MR head ref', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'fork-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/merge-requests/42/head:refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42`
        ],
        { cwd: TEST_REPO_PATH, timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        { cwd: TEST_REPO_PATH }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        { cwd: TEST_REPO_PATH }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('captures the fork MR head from a dedicated ref, not the shared FETCH_HEAD', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    // Why: simulate a concurrent `git fetch origin` clobbering FETCH_HEAD with the
    // default-branch tip. The resolved base must come from the durable Orca MR ref.
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)
        if (ref === 'FETCH_HEAD') {
          return { stdout: 'mainbranchtip000\n', stderr: '' }
        }
        if (ref === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`) {
          return { stdout: 'mrheadsha111\n', stderr: '' }
        }
        throw new Error(`unexpected rev-parse ref: ${ref}`)
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'mrheadsha111',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'FETCH_HEAD'],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('keeps the durable MR head when the head fetch fails but the local ref resolves', async () => {
    // Why: mirror compare-base soft-keep — a transient fetch failure must not
    // fail the resolve when a prior fetch already pinned refs/orca/merge-requests/<iid>.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'pinned-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it.each([
    ["fatal: couldn't find remote ref refs/merge-requests/42/head", 'deleted MR / cleaned fork'],
    ['Authentication failed. Check your remote credentials.', 'auth failure'],
    [
      'This SSH host is running an older Orca relay that cannot fetch merge request heads. Reconnect to deploy the latest relay, then try again.',
      'stale relay'
    ]
  ])('fails hard instead of soft-keeping the durable MR head on: %s', async (message) => {
    // Why: soft-keep on a non-transient failure would check out a dead or
    // unauthorized tip (or mask the reconnect prompt) with a success UX.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error(message)
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        error: `Failed to fetch refs/merge-requests/42/head: ${message}`
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('routes runtime GitLab fork MR base git calls through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
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
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        isCrossRepository: true
      })

      expect(result).toEqual({ baseBranch: 'fork-mr-sha' })
      expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'origin',
        ['gitlab.com', 'git.internal'],
        null,
        { wslDistro: 'Ubuntu' }
      )
      expect(gitSpy).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
        cwd: TEST_REPO_PATH,
        wslDistro: 'Ubuntu'
      })
      expect(gitSpy).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/merge-requests/42/head:refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42`
        ],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        { cwd: TEST_REPO_PATH, wslDistro: 'Ubuntu' }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('resolves SSH GitLab fork MR bases from the target project MR head ref', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
        }
        if (
          args[0] === 'rev-parse' &&
          args[1] === '--verify' &&
          args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77^{commit}`
        ) {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi
        .fn()
        .mockResolvedValue(`refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77`),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 77,
      sourceBranch: 'contrib/remote-fix',
      targetBranch: 'main',
      isCrossRepository: true
    })

    expect(result).toEqual({
      baseBranch: 'remote-fork-mr-sha',
      compareBaseRef: 'refs/remotes/origin/main'
    })
    expect(provider.fetchGitLabMergeRequestHead).toHaveBeenCalledWith('/remote/repo', 'origin', 77)
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77^{commit}`],
      '/remote/repo'
    )
    expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      ['gitlab.com', 'git.internal'],
      'ssh-1'
    )
  })

  it('resolves SSH GitLab same-repo MR bases through remote-tracking fetches', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/fix') {
          return { stdout: 'same-repo-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi.fn().mockResolvedValue(undefined),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 78,
      sourceBranch: 'feature/fix',
      targetBranch: 'main'
    })

    expect(result).toEqual({
      baseBranch: 'origin/feature/fix',
      compareBaseRef: 'refs/remotes/origin/main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'feature/fix',
      'refs/remotes/origin/feature/fix'
    )
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
    expect(provider.fetchGitLabMergeRequestHead).not.toHaveBeenCalled()
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/fix'],
      '/remote/repo'
    )
  })

  it('keeps the MR source base when the optional compare-base fetch fails', async () => {
    // Why (#6263): a merged MR's target ref may be deleted; a failed compare-base fetch must not drop the worktree onto the default branch.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (
        args[0] === 'fetch' &&
        args[2] === '+refs/heads/feature/fix:refs/remotes/origin/feature/fix'
      ) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch' && args[2] === '+refs/heads/main:refs/remotes/origin/main') {
        // Target branch was deleted on the remote (merged MR).
        throw new Error("couldn't find remote ref refs/heads/main")
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/fix') {
        return { stdout: 'same-repo-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 79,
        sourceBranch: 'feature/fix',
        targetBranch: 'main'
      })

      expect(result).toEqual({
        baseBranch: 'origin/feature/fix',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
      expect(result).not.toHaveProperty('compareBaseRef')
      expect(result).not.toHaveProperty('error')
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('keeps the MR compare base when the fetch fails but the local ref resolves', async () => {
    // Why: a transient fetch failure must not drop a compare base we already have on disk.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (
        args[0] === 'fetch' &&
        args[2] === '+refs/heads/feature/fix:refs/remotes/origin/feature/fix'
      ) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch' && args[2] === '+refs/heads/main:refs/remotes/origin/main') {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      }
      if (args[0] === 'rev-parse' && args[2] === 'origin/feature/fix') {
        return { stdout: 'same-repo-mr-sha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 80,
        sourceBranch: 'feature/fix',
        targetBranch: 'main'
      })

      expect(result).toEqual({
        baseBranch: 'origin/feature/fix',
        compareBaseRef: 'refs/remotes/origin/main',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('keeps a cross-repo fork MR compare base when the fetch fails but the local ref resolves', async () => {
    // Why: mirror the GitHub fork soft-fail-keep — a transient compare-base fetch
    // failure must not drop a base we already have on disk onto the fork MR head SHA.
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const durableLocalRef = `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77`
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[2] === `${durableLocalRef}^{commit}`) {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
          return { stdout: 'base-commit-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi.fn().mockResolvedValue(durableLocalRef),
      fetchRemoteTrackingRef: vi.fn(async () => {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 77,
        sourceBranch: 'contrib/remote-fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'remote-fork-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(provider.exec).toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
        '/remote/repo'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

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

  describe('browser page targeting', () => {
    function mockLiveBrowserGuest(): void {
      electronMocks.webContents.fromId.mockReturnValue({
        isDestroyed: () => false
      })
    }

    it('passes explicit page ids through without resolving the current worktree', async () => {
      vi.mocked(listWorktrees).mockClear()
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      const result = await runtime.browserSnapshot({ page: 'page-1' })

      expect(result.browserPageId).toBe('page-1')
      expect(snapshotMock).toHaveBeenCalledWith(undefined, 'page-1')
      expect(listWorktrees).not.toHaveBeenCalled()
    })

    it('resolves explicit worktree selectors when page ids are also provided', async () => {
      vi.mocked(listWorktrees).mockClear()
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await runtime.browserSnapshot({
        worktree: 'branch:feature/foo',
        page: 'page-1'
      })

      expect(snapshotMock).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'page-1')
    })

    it('routes tab switch and capture start by explicit page id', async () => {
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 2,
        browserPageId: 'page-2'
      })
      const captureStartMock = vi.fn().mockResolvedValue({
        capturing: true
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        captureStart: captureStartMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-2', 2]])),
        tabList: vi.fn(() => ({
          tabs: [
            { browserPageId: 'page-0', index: 0, url: 'about:blank', title: '', active: false },
            { browserPageId: 'page-1', index: 1, url: 'about:blank', title: '', active: false },
            { browserPageId: 'page-2', index: 2, url: 'about:blank', title: '', active: true }
          ]
        }))
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-2' })).resolves.toEqual({
        switched: 2,
        browserPageId: 'page-2'
      })
      await expect(runtime.browserCaptureStart({ page: 'page-2' })).resolves.toEqual({
        capturing: true
      })
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-2')
      expect(captureStartMock).toHaveBeenCalledWith(undefined, 'page-2')
    })

    it('accepts focus on tab switch without altering bridge args (focus is main-side concern)', async () => {
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 0,
        browserPageId: 'page-1'
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
        tabList: vi.fn(() => ({
          tabs: [{ browserPageId: 'page-1', index: 0, url: 'about:blank', title: '', active: true }]
        }))
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-1', focus: true })).resolves.toEqual({
        switched: 0,
        browserPageId: 'page-1'
      })
      // Bridge is unchanged — focus is delivered to the renderer via IPC, not threaded through bridge state.
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-1')
    })

    it('does not silently drop invalid explicit worktree selectors for page-targeted commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn()

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserSnapshot({
          worktree: 'path:/tmp/missing-worktree',
          page: 'page-1'
        })
      ).rejects.toThrow('selector_not_found')
      expect(snapshotMock).not.toHaveBeenCalled()
    })

    it('does not silently drop invalid explicit worktree selectors for non-page browser commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()
      const tabListMock = vi.fn()

      runtime.setAgentBrowserBridge({
        tabList: tabListMock
      } as never)

      await expect(
        runtime.browserTabList({
          worktree: 'path:/tmp/missing-worktree'
        })
      ).rejects.toThrow('selector_not_found')
      expect(tabListMock).not.toHaveBeenCalled()
    })

    it('rejects closing an unknown page id instead of treating it as success', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'missing-page'
        })
      ).rejects.toThrow('Browser page missing-page was not found')
    })

    it('rejects closing a page outside the explicitly scoped worktree', async () => {
      mockLiveBrowserGuest()
      vi.mocked(listWorktrees).mockResolvedValue([
        ...MOCK_GIT_WORKTREES,
        {
          path: '/tmp/worktree-b',
          head: 'def',
          branch: 'feature/bar',
          isBare: false,
          isMainWorktree: false
        }
      ])
      const runtime = createRuntime()
      const getRegisteredTabsMock = vi.fn((worktreeId?: string) =>
        worktreeId === `${TEST_REPO_ID}::/tmp/worktree-b` ? new Map() : new Map([['page-1', 1]])
      )

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: getRegisteredTabsMock
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'page-1',
          worktree: 'path:/tmp/worktree-b'
        })
      ).rejects.toThrow('Browser page page-1 was not found in this worktree')
      expect(getRegisteredTabsMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/tmp/worktree-b`)
    })
  })

  describe('removeManagedWorktree PTY teardown (design §4.3)', () => {
    function createProviderStub(
      listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
    ): {
      spawn: ReturnType<typeof vi.fn>
      attach: ReturnType<typeof vi.fn>
      write: ReturnType<typeof vi.fn>
      resize: ReturnType<typeof vi.fn>
      shutdown: ReturnType<typeof vi.fn>
      sendSignal: ReturnType<typeof vi.fn>
      getCwd: ReturnType<typeof vi.fn>
      getInitialCwd: ReturnType<typeof vi.fn>
      clearBuffer: ReturnType<typeof vi.fn>
      acknowledgeDataEvent: ReturnType<typeof vi.fn>
      hasChildProcesses: ReturnType<typeof vi.fn>
      getForegroundProcess: ReturnType<typeof vi.fn>
      serialize: ReturnType<typeof vi.fn>
      revive: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      getDefaultShell: ReturnType<typeof vi.fn>
      getProfiles: ReturnType<typeof vi.fn>
      onData: ReturnType<typeof vi.fn>
      onReplay: ReturnType<typeof vi.fn>
      onExit: ReturnType<typeof vi.fn>
    } {
      return {
        spawn: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent: vi.fn(),
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        listProcesses: vi.fn(listProcesses),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn(),
        onData: vi.fn().mockReturnValue(() => {}),
        onReplay: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn().mockReturnValue(() => {})
      }
    }

    it('RPC-initiated delete awaits matching PTYs before git', async () => {
      // Seed the runtime with a live leaf whose worktreeId matches the target.
      const callOrder: string[] = []
      const stopAndWait = vi.fn(async (id: string) => {
        callOrder.push(`stop-and-wait:${id}`)
        return true
      })
      const localProvider = createProviderStub(async () => [])
      vi.mocked(assertWorktreeCleanForRemoval).mockImplementation(async () => {
        callOrder.push('preflight')
      })
      vi.mocked(removeWorktree).mockImplementation(async () => {
        callOrder.push('git-removeWorktree')
        return {}
      })

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => {
          callOrder.push('getLocalProvider')
          return localProvider as never
        }
      })
      runtime.setPtyController({
        write: () => true,
        kill: vi.fn(() => true),
        stopAndWait,
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1')

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // Destructive teardown must bound the underlying RPCs below the sweep deadline.
      expect(stopAndWait).toHaveBeenCalledWith(
        'pty-1',
        expect.objectContaining({ deadlineMs: expect.any(Number) })
      )
      // The provider-prefix sweep and the git removal must happen AFTER the
      // runtime-graph physical stop. Git removal must NOT start before it.
      const preflightIdx = callOrder.indexOf('preflight')
      const stopIdx = callOrder.indexOf('stop-and-wait:pty-1')
      const gitIdx = callOrder.indexOf('git-removeWorktree')
      expect(preflightIdx).toBeGreaterThanOrEqual(0)
      expect(stopIdx).toBeGreaterThan(preflightIdx)
      expect(stopIdx).toBeGreaterThanOrEqual(0)
      expect(gitIdx).toBeGreaterThan(stopIdx)
    })

    it('does not start Git removal when physical PTY stop cannot be proven', async () => {
      // A failed stop only rejects when a fresh inventory still shows the PTY
      // live; keep pty-1 present so the exit cannot be proven.
      const localProvider = createProviderStub(async () => [
        { id: 'pty-1', cwd: '/tmp', title: 'shell' }
      ])
      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => localProvider as never
      })
      runtime.setPtyController({
        write: () => true,
        kill: vi.fn(() => true),
        stopAndWait: vi.fn(async () => false),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1')

      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
        'Failed to physically stop every PTY'
      )

      expect(removeWorktree).not.toHaveBeenCalled()
    })

    it('thunk resolves the installed provider lazily, not at construction time', async () => {
      // Simulates the daemon adapter being installed AFTER construction; a capture-at-construction refactor would break this.
      const preDaemonProvider = createProviderStub(async () => [
        { id: '1', cwd: '/tmp', title: 'shell' },
        { id: '2', cwd: '/tmp', title: 'shell' }
      ])
      const postDaemonProvider = createProviderStub(async () => [
        { id: `${TEST_WORKTREE_ID}@@aaaaaaaa`, cwd: '/tmp', title: 'shell' }
      ])
      let currentProvider: ReturnType<typeof createProviderStub> = preDaemonProvider
      const onPtyStopped = vi.fn()

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => currentProvider as never,
        onPtyStopped
      })
      vi.mocked(removeWorktree).mockResolvedValue({})

      // Simulate daemon-init swapping the provider after construction.
      currentProvider = postDaemonProvider

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // The post-daemon provider's prefix-matching session must have been
      // shut down, proving the thunk resolved lazily at call time.
      expect(postDaemonProvider.shutdown).toHaveBeenCalledWith(
        `${TEST_WORKTREE_ID}@@aaaaaaaa`,
        expect.objectContaining({ immediate: true })
      )
      expect(onPtyStopped).toHaveBeenCalledWith(`${TEST_WORKTREE_ID}@@aaaaaaaa`)
      // The pre-daemon provider must not have been consulted for the kill.
      expect(preDaemonProvider.shutdown).not.toHaveBeenCalled()
    })
  })
  describe('stale terminal handle resolution (#7718)', () => {
    function syncSingleTerminalGraph(runtime: OrcaRuntimeService, ptyId: string): void {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
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
            ptyId,
            paneTitle: 'Terminal 1'
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Terminal 1',
                isActive: true
              }
            ]
          }
        ]
      })
    }

    // Why: client-created terminals (terminal.create) hold LEAF handles that can diverge from the pane's current PTY across reconnects.
    function issueLeafHandle(runtime: OrcaRuntimeService, ptyId: string): string {
      const internals = runtime as unknown as {
        leaves: Map<string, { ptyId: string | null }>
        issueHandle: (leaf: unknown) => string
      }
      const leaf = Array.from(internals.leaves.values()).find(
        (candidate) => candidate.ptyId === ptyId
      )
      if (!leaf) {
        throw new Error('expected leaf record')
      }
      return internals.issueHandle(leaf)
    }

    it('errors with terminal_handle_stale instead of adopting a replacement PTY', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      syncSingleTerminalGraph(runtime, 'pty-a')
      const handle = issueLeafHandle(runtime, 'pty-a')

      // Simulate the pane's PTY being replaced while the remote client still holds the old handle.
      const internals = runtime as unknown as {
        leaves: Map<string, { ptyId: string | null }>
      }
      for (const leaf of internals.leaves.values()) {
        if (leaf.ptyId === 'pty-a') {
          leaf.ptyId = 'pty-b'
        }
      }

      // The unguarded resolver silently adopts the new PTY — the misroute.
      expect(runtime.resolveLeafForHandle(handle)).toEqual({ ptyId: 'pty-b' })
      // The guarded resolver surfaces the staleness so clients can re-derive.
      expect(() => runtime.resolveLiveLeafForHandle(handle)).toThrow('terminal_handle_stale')
      expect(runtime.getLiveTerminalPaneKey(handle)).toBeNull()
    })

    it('lets a handle issued before its first PTY adopt that PTY without erroring', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      syncSingleTerminalGraph(runtime, 'pty-a')
      const handle = issueLeafHandle(runtime, 'pty-a')

      // Simulate the mobile pre-spawn flow: the handle record predates the PTY (ptyId null); its first PTY must still resolve.
      const internals = runtime as unknown as {
        handles: Map<string, { ptyId: string | null }>
      }
      const record = internals.handles.get(handle)
      if (!record) {
        throw new Error('expected handle record')
      }
      record.ptyId = null

      expect(runtime.resolveLiveLeafForHandle(handle)).toEqual({ ptyId: 'pty-a' })
    })

    it('keeps terminal cwd resolution fail-soft when the provider is unavailable', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      syncSingleTerminalGraph(runtime, 'pty-a')
      const handle = issueLeafHandle(runtime, 'pty-a')
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        getCwd: async () => {
          throw new Error('ssh disconnected')
        }
      })

      await expect(runtime.resolveTerminalCwd(handle)).resolves.toBeNull()
    })
  })

  describe('mobile terminal create resilience (#7718)', () => {
    it('cancels the surface wait without rolling back when the client connection dies', async () => {
      vi.useFakeTimers()
      try {
        const closeTerminal = vi.fn()
        const runtime = new OrcaRuntimeService(store)
        runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
        const abort = new AbortController()
        const webContents = { send: vi.fn() }
        const send = vi.fn((_channel: string, payload: { requestId: string }) => {
          ipcMain.emit(
            'terminal:tabCreateReply',
            { sender: webContents },
            { requestId: payload.requestId, tabId: 'tab-abort', title: 'Terminal' }
          )
        })
        webContents.send = send
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
        electronMocks.BrowserWindow.fromId.mockReturnValue({
          isDestroyed: () => false,
          webContents
        })

        const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          activate: false,
          signal: abort.signal
        })
        const settled = create.then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error })
        )
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

        // Client socket dies mid-wait: create must settle right away (not the 10s timeout) and must NOT close the tab (real terminal exists).
        abort.abort()
        await vi.advanceTimersByTimeAsync(0)
        const outcome = await settled

        expect(outcome.ok).toBe(false)
        if (outcome.ok === false) {
          expect(outcome.error.message).toBe('client_disconnected')
        }
        expect(closeTerminal).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a mobile-created terminal alive when its live shell has no registered pane key', async () => {
      vi.useFakeTimers()
      try {
        const closeTerminal = vi.fn()
        const runtime = new OrcaRuntimeService(store)
        runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
        const webContents = { send: vi.fn() }
        const send = vi.fn((_channel: string, payload: { requestId: string }) => {
          ipcMain.emit(
            'terminal:tabCreateReply',
            { sender: webContents },
            { requestId: payload.requestId, tabId: 'tab-stall', title: 'Terminal' }
          )
        })
        webContents.send = send
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
        electronMocks.BrowserWindow.fromId.mockReturnValue({
          isDestroyed: () => false,
          webContents
        })

        const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          activate: false
        })
        const settled = create.then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error })
        )
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

        // A live shell backs the tab but its leaf id isn't a terminal UUID, so no pane key registers (stalled renderer publication).
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [
            {
              tabId: 'tab-stall',
              worktreeId: TEST_WORKTREE_ID,
              leafId: 'pane:1',
              paneRuntimeId: 1,
              ptyId: 'pty-stall',
              paneTitle: null
            }
          ]
        })

        await vi.advanceTimersByTimeAsync(11_000)
        const outcome = await settled

        // The create fails, but the timeout must not kill the live terminal (the "tab dies after ~10s" symptom).
        expect(outcome.ok).toBe(false)
        if (outcome.ok === false) {
          expect(outcome.error.message).toContain('Timed out')
        }
        expect(closeTerminal).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
