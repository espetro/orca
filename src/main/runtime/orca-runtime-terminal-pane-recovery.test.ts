/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  createRuntimeWithSshLease,
  store
} from './orca-runtime-test-fixture'

import { OrcaRuntimeService } from './orca-runtime'

import { makePaneKey } from '../../shared/stable-pane-id'

import type { RuntimeSyncWindowGraph, RuntimeTerminalCreate } from '../../shared/runtime-types'

import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('lists live terminals and issues stable handles for synced leaves', async () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))

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
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'epoch-terminal-handle',
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
              title: 'Claude',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello from terminal\n', 123)

    const terminals = await runtime.listTerminals('branch:feature/foo')
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: 'repo-1::/tmp/worktree-a',
      branch: 'feature/foo',
      ptyId: 'pty-1',
      title: 'Claude',
      preview: 'hello from terminal'
    })

    const shown = await runtime.showTerminal(terminals.terminals[0].handle)
    expect(shown.handle).toBe(terminals.terminals[0].handle)
    expect(shown.ptyId).toBe('pty-1')
    const mobileTabs = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileHandle = mobileTabs.tabs.find((tab) => tab.type === 'terminal')?.terminal
    if (!mobileHandle) {
      throw new Error('expected mobile terminal handle')
    }

    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }], []]
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

    await runtime.sleepTerminalsForWorktree('branch:feature/foo')
    expect(
      events.find(
        (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'started'
      )
    ).toMatchObject({
      terminalHandles: [terminals.terminals[0].handle, mobileHandle].sort()
    })
  })

  it('routes a launch-draft resolution to the handle-owning local and remote renderers', async () => {
    const runtime = new OrcaRuntimeService(store)
    const nativeChatLaunchDraftResolved = vi.fn()
    const events: RuntimeClientEvent[] = []
    runtime.setNotifier({ nativeChatLaunchDraftResolved } as never)
    runtime.onClientEvent((event) => events.push(event))
    runtime.attachWindow(1)
    const graph: RuntimeSyncWindowGraph = {
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
      ],
      mobileSessionTabs: [
        {
          worktree: 'repo-1::/tmp/worktree-a',
          publicationEpoch: 'launch-draft-epoch',
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
              title: 'Claude',
              launchDraft: 'seed',
              launchDraftCreatedAt: 7,
              isActive: true
            }
          ]
        }
      ]
    }
    runtime.syncWindowGraph(1, graph)
    const listed = await runtime.listMobileSessionTabs('branch:feature/foo')
    const mobileTab = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!mobileTab?.terminal) {
      throw new Error('expected mobile terminal handle')
    }
    expect(mobileTab).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 7 })

    runtime.notifyNativeChatLaunchDraftResolved(mobileTab.terminal, {
      text: 'seed',
      createdAt: 7
    })

    expect(nativeChatLaunchDraftResolved).toHaveBeenCalledWith('tab-1', {
      text: 'seed',
      createdAt: 7
    })
    expect(events).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    expect(runtime.getNativeChatLaunchDraftResolutionClientEventSnapshot()).toContainEqual({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    const retired = (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
      (tab) => tab.type === 'terminal'
    )
    expect(retired).not.toHaveProperty('launchDraft')
    expect(retired).not.toHaveProperty('launchDraftCreatedAt')

    runtime.markRendererReloading(1)
    const replay = runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 2
      }))
    })
    expect(replay.nativeChatLaunchDraftResolutions).toEqual([
      { tabId: 'tab-1', text: 'seed', createdAt: 7 }
    ])
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).not.toHaveProperty('launchDraft')

    const reconciled = runtime.syncWindowGraph(1, {
      ...graph,
      mobileSessionTabs: graph.mobileSessionTabs?.map((snapshot) => ({
        ...snapshot,
        publicationEpoch: 'launch-draft-reload',
        snapshotVersion: 3,
        tabs: snapshot.tabs.map((tab) => {
          if (tab.type !== 'terminal') {
            return tab
          }
          return { ...tab, launchDraftCreatedAt: 8 }
        })
      }))
    })
    expect(reconciled.nativeChatLaunchDraftResolutions).toBeUndefined()
    expect(
      (await runtime.listMobileSessionTabs('branch:feature/foo')).tabs.find(
        (tab) => tab.type === 'terminal'
      )
    ).toMatchObject({ launchDraft: 'seed', launchDraftCreatedAt: 8 })
  })

  it('surfaces stale terminal handles for stranded panes and recovers after same-pane wake', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-before-sleep'
        }
      ]
    })

    const beforeSleep = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const staleHandle = beforeSleep.terminals[0]?.handle ?? ''
    expect(staleHandle).toBeTruthy()

    // Why: `terminal.show` is read-only; only a later renderer wake/rebind graph publish can repair this pane's CLI handle surface.
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })

    await expect(runtime.showTerminal(staleHandle)).rejects.toThrow('terminal_handle_stale')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-after-wake'
        }
      ]
    })
    runtime.onPtyData('pty-after-wake', 'resumed in place\n', 123)

    const resolved = runtime.resolveTerminalPane(paneKey)
    expect(resolved).toMatchObject({
      tabId,
      leafId,
      ptyId: 'pty-after-wake'
    })
    await expect(runtime.showTerminal(resolved.handle)).resolves.toMatchObject({
      handle: resolved.handle,
      tabId,
      leafId,
      ptyId: 'pty-after-wake',
      preview: 'resumed in place'
    })
  })

  it('rejects pane resolution when leaf and PTY ownership disagree', () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-1'
    const leafId = HEADLESS_LEAF_ID
    const paneKey = makePaneKey(tabId, leafId)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-mismatched-owner'
        }
      ]
    })
    runtime.registerPty('pty-mismatched-owner', `${TEST_REPO_ID}::/tmp/other-worktree`)

    expect(() => runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID)).toThrow(
      'terminal_not_found'
    )
  })

  it('recovers a disconnected pane through one HUB-owned replacement', async () => {
    const tabId = 'tab-recover'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).resolves.toMatchObject({
      handle: 'term-replacement',
      tabId,
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID
    })
    // persistHostSessionBinding is no longer a per-call opt-in: createTerminal
    // is host-initiated by construction and always persists its binding.
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('rejects missing host panes without authoritative expired binding evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-missing'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term-created',
      tabId,
      paneKey,
      ptyId: 'pty-created',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID)).rejects.toThrow(
      'terminal_not_found'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('rejects recovery for live panes and mismatched worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-live'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-live', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const liveHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, liveHandle)
    ).rejects.toThrow('terminal_not_recoverable')
    await expect(
      runtime.recoverTerminalPane(paneKey, `${TEST_REPO_ID}::/other`, liveHandle)
    ).rejects.toThrow('terminal_not_found')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('returns an already-connected replacement instead of spawning another pane', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-cas'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-old', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const oldHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-old', 0)
    runtime.registerPty('pty-new', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const recovered = await runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, oldHandle)

    expect(recovered.handle).not.toBe(oldHandle)
    expect(recovered.ptyId).toBe('pty-new')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent pane recovery across stale viewer handles', async () => {
    const tabId = 'tab-concurrent'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    let finishCreate!: (result: RuntimeTerminalCreate) => void
    const pendingCreate = new Promise<RuntimeTerminalCreate>((resolve) => {
      finishCreate = resolve
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockReturnValue(pendingCreate)

    const first = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    const second = runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, 'term-other-viewer')
    finishCreate({
      handle: 'term-replacement',
      tabId,
      paneKey,
      ptyId: 'pty-replacement',
      worktreeId: TEST_WORKTREE_ID,
      title: null,
      surface: 'background'
    })

    await expect(first).resolves.toEqual(expect.objectContaining({ handle: 'term-replacement' }))
    await expect(second).rejects.toThrow('terminal_not_found')
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('clears a failed pane recovery so a later reconnect can retry', async () => {
    const tabId = 'tab-retry'
    const runtime = createRuntimeWithSshLease('pty-expired', tabId)
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-expired', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const expiredHandle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-expired', 0)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValueOnce(new Error('relay_reconnecting'))
      .mockResolvedValueOnce({
        handle: 'term-retry',
        tabId,
        paneKey,
        ptyId: 'pty-retry',
        worktreeId: TEST_WORKTREE_ID,
        title: null,
        surface: 'background'
      })

    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).rejects.toThrow('relay_reconnecting')
    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, expiredHandle)
    ).resolves.toMatchObject({ handle: 'term-retry' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('does not recover a pane whose authoritative SSH lease was terminated', async () => {
    const tabId = 'tab-terminated'
    const runtime = createRuntimeWithSshLease('pty-terminated', tabId, 'terminated')
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    runtime.registerPty('pty-terminated', TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
    runtime.onPtyExit('pty-terminated', 0)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('drops a stale leaf when a woken agent PTY is re-keyed to a new leaf on renderer reload', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Why: the agent's pre-allocated ORCA_TERMINAL_HANDLE gives its PTY a handleByPtyId entry — the condition the reload preservation loop keys on.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)

    // Simulate agent sleep + mobile wake: the renderer cold-restores the pane under a NEW leafId while the SAME agent PTY stays live.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    // Before the fix two leaves shared one PTY, so both adopted the same ptyId-keyed handle and paired clients crashed on a duplicate React key.
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
    // The shared handle must NOT have been invalidated — it belongs to leaf-new now.
    await expect(runtime.showTerminal(after.terminals[0].handle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })
  })

  it('still preserves a CLI agent leaf when the reloaded renderer has not rebound its PTY', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    expect((await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals).toHaveLength(1)

    // Renderer reloads but hasn't rebound the pane (empty graph); the live CLI agent PTY + exported handle must survive.
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })

    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].ptyId).toBe('pty-agent')
  })

  it('invalidates a re-keyed leaf-unique handle so in-flight waiters fail fast', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // No preAllocateHandleForPty: a plain terminal's handle is leaf-unique, so a re-key leaves it with no next owner and it goes stale immediately.
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-plain'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals).toHaveLength(1)
    const staleHandle = before.terminals[0].handle
    const waiting = runtime.waitForTerminal(staleHandle, { condition: 'exit', timeoutMs: 30_000 })

    // Re-key WITHOUT a renderer reload (e.g. a pane moved across tabs) while the same PTY stays live under a new leaf.
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-plain'
        }
      ]
    })

    // The waiter must fail fast, not hang until timeout on a dead leaf.
    await expect(waiting).rejects.toThrow('terminal_handle_stale')
    const after = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(after.terminals).toHaveLength(1)
    expect(after.terminals[0].handle).not.toBe(staleHandle)
  })

  it('keeps a live CLI waiter pending when a re-keyed shared handle transfers to the live leaf', async () => {
    const runtime = createRuntime()
    const tabId = 'tab-1'
    // Unlike the leaf-unique case, a shared ptyId-keyed handle re-keyed to a live leaf must transfer WITHOUT rejecting the in-flight CLI waiter.
    runtime.preAllocateHandleForPty('pty-agent')
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-old',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-old',
          paneRuntimeId: 1,
          ptyId: 'pty-agent'
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const sharedHandle = before.terminals[0].handle
    const abort = new AbortController()
    let settled: 'resolved' | 'rejected' | null = null
    const waiting = runtime
      .waitForTerminal(sharedHandle, {
        condition: 'exit',
        timeoutMs: 30_000,
        signal: abort.signal
      })
      .then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        }
      )

    // Re-key WITHOUT a renderer reload while the same agent PTY stays live under a new leaf.
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: 'leaf-new',
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'leaf-new',
          paneRuntimeId: 2,
          ptyId: 'pty-agent'
        }
      ]
    })

    // Let any synchronous stale-handle rejection propagate.
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The shared handle belongs to leaf-new now, so the CLI's live waiter must stay pending (a blanket invalidateLeafHandle would reject it as stale).
    expect(settled).toBeNull()
    // The same handle still resolves to the live PTY under the new leaf.
    await expect(runtime.showTerminal(sharedHandle)).resolves.toMatchObject({
      ptyId: 'pty-agent'
    })

    // Abort only for teardown; the assertion above already proved it was pending.
    abort.abort()
    await waiting
    expect(settled).toBe('rejected')
  })

  it('emits one mobile session terminal tab per live PTY even if two tabs resolve to it', () => {
    const runtime = createRuntime()
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state?: Record<string, unknown>
      ) => void
      mobileSessionTabsByWorktree: Map<string, unknown>
      getMobileSessionTabsForWorktree: (worktreeId: string) => {
        tabs: { type: string; terminal?: string | null }[]
      }
    }
    // Two unclaimed live PTYs on the worktree; the worktree-only fallback binds either to a leafless tab that references it.
    internals.recordPtyWorktree('pty-shared', TEST_WORKTREE_ID, { connected: true })
    internals.recordPtyWorktree('pty-other', TEST_WORKTREE_ID, { connected: true })

    const terminalTab = (leafId: string, ptyId: string) => ({
      type: 'terminal' as const,
      id: `term_dup::${leafId}`,
      parentTabId: 'term_dup',
      leafId,
      ptyId,
      title: 'Agent',
      isActive: leafId === 'leaf-new'
    })

    // Two records (stale headless leaf + live leaf) both resolve to the SAME live PTY — the renderer-graph origin the leaf fix can't reach.
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:test:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'term_dup::leaf-new',
      activeTabType: 'terminal',
      tabs: [terminalTab('leaf-new', 'pty-shared'), terminalTab('leaf-old', 'pty-shared')]
    })
    const deduped = internals.getMobileSessionTabsForWorktree(TEST_WORKTREE_ID)
    const dedupedTerminals = deduped.tabs.filter((tab) => tab.type === 'terminal')
    expect(dedupedTerminals).toHaveLength(1)
    expect(dedupedTerminals[0].terminal).toBeTruthy()

    // Split siblings own DISTINCT PTYs, so they must never be collapsed.
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:test:2',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: 'term_dup::leaf-new',
      activeTabType: 'terminal',
      tabs: [terminalTab('leaf-new', 'pty-shared'), terminalTab('leaf-old', 'pty-other')]
    })
    const split = internals.getMobileSessionTabsForWorktree(TEST_WORKTREE_ID)
    expect(split.tabs.filter((tab) => tab.type === 'terminal')).toHaveLength(2)
  })
})
