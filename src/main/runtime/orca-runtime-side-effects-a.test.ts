import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import {
  resetRuntimeTestMocks,
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  InMemoryOrchestrationMessages,
  LIST_PROVIDER_DEADLINE,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  antigravityPromptBeforeModelReadyScreen,
  antigravityReadyScreen,
  bindSinglePtyRun,
  deferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRpcRequest,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  setInMemoryOrchestrationMessages,
  setPlatform,
  store,
  syncSinglePty,
  waitForMobileSessionTabsEvents,
  withPlatform
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { MAX_OSC_TITLE_CHARS, detectAgentStatusFromTitle } from '../../shared/agent-detection'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { appendNormalizedToTailBuffer, buildPreview } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import {
  appendRecentPtyPathCandidates,
  recentTerminalOutputIncludesPath,
  recentTerminalPathCandidatesIncludePath
} from './terminal-output-path-candidates'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('reveals a background terminal session when focusing its handle', async () => {
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-adopted' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await expect(runtime.focusTerminal(handle)).resolves.toMatchObject({
      handle,
      tabId: 'tab-adopted',
      worktreeId: TEST_WORKTREE_ID
    })
    // Why: focus reveal must reuse createTerminal's pre-minted tabId so a retry adopts under the paneKey baked into env.
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      tabId: expect.stringMatching(UUID_RE),
      leafId: expect.stringMatching(UUID_RE)
    })
  })

  it('replays captured launch config when focusing a background agent session', async () => {
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-adopted' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: 'codex',
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      title: 'worker'
    })
    const firstReveal = revealTerminalSession.mock.calls[0]?.[1] as
      | { launchToken?: string; tabId?: string; leafId?: string }
      | undefined
    revealTerminalSession.mockClear()

    await runtime.focusTerminal(handle)

    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      launchConfig: {
        agentCommand: 'codex',
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: firstReveal?.launchToken,
      launchAgent: 'codex',
      tabId: firstReveal?.tabId,
      leafId: firstReveal?.leafId
    })
  })

  it('reveals background terminal sessions with the freshest PTY title', async () => {
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-adopted' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'Claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude agents\x07', 100)

    await runtime.focusTerminal(handle)

    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        ptyId: 'pty-bg',
        title: 'claude agents'
      })
    )
  })

  it('rejects focusing an exited background terminal session', async () => {
    const revealTerminalSession = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    revealTerminalSession.mockClear()
    runtime.onPtyExit('pty-bg', 0)

    await expect(runtime.focusTerminal(handle)).rejects.toThrow('terminal_exited')
    expect(revealTerminalSession).not.toHaveBeenCalled()
  })

  it('renames background terminal handles without requiring a visible tab', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const renamed = await runtime.renameTerminal(handle, 'Worker')
    expect(renamed).toMatchObject({
      handle,
      title: 'Worker'
    })
    expect(renamed.tabId).not.toContain(':')
    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      tabId: renamed.tabId,
      title: 'Worker'
    })
  })

  it('keeps a background terminal handle stable while reveal adoption is racing', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await runtime.focusTerminal(handle)
    ;(runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId.delete('pty-bg')

    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      handle,
      ptyId: 'pty-bg'
    })
  })

  it('coalesces concurrent focusTerminal navigations so only the latest full reveal runs', async () => {
    // Instant reveals during createTerminal; switch to gated mock before focus storm.
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-create' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({ id: 'pty-a' })
        .mockResolvedValueOnce({ id: 'pty-b' })
        .mockResolvedValueOnce({ id: 'pty-c' }),
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const a = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'a',
      presentation: 'background'
    })
    const b = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'b',
      presentation: 'background'
    })
    const c = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'c',
      presentation: 'background'
    })

    let releaseFirstReveal!: (value: { tabId: string }) => void
    let firstRevealStarted = false
    const firstRevealGate = new Promise<{ tabId: string }>((resolve) => {
      releaseFirstReveal = resolve
    })
    revealTerminalSession.mockReset()
    revealTerminalSession.mockImplementation(() => {
      if (!firstRevealStarted) {
        firstRevealStarted = true
        return firstRevealGate
      }
      return Promise.resolve({ tabId: 'tab-latest' })
    })

    const pA = runtime.focusTerminal(a.handle)
    await vi.waitFor(() => {
      expect(firstRevealStarted).toBe(true)
    })
    const pB = runtime.focusTerminal(b.handle)
    const pC = runtime.focusTerminal(c.handle)

    // B is superseded while A is in flight — identity only, never navigated.
    await expect(pB).resolves.toMatchObject({
      handle: b.handle,
      navigated: false
    })
    releaseFirstReveal({ tabId: 'tab-a' })
    // A may still complete reveal work, but if C superseded it, navigated is false.
    const aResult = await pA
    expect(aResult.handle).toBe(a.handle)
    expect(aResult.navigated).toBe(false)
    await expect(pC).resolves.toMatchObject({
      handle: c.handle,
      tabId: 'tab-latest',
      navigated: true
    })

    // B must never have started a reveal; only A and/or C.
    const revealedPtyIds = revealTerminalSession.mock.calls.map(
      (call) => (call[1] as { ptyId?: string }).ptyId
    )
    expect(revealedPtyIds).not.toContain('pty-b')
    expect(revealedPtyIds.at(-1)).toBe('pty-c')
  })

  it('reports a queued PTY focus as not navigated when its notifier disappears', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    runtime.registerPty('pty-b', TEST_WORKTREE_ID)
    const terminals = (await runtime.listTerminals()).terminals
    const terminalA = terminals.find((terminal) => terminal.ptyId === 'pty-a')
    const terminalB = terminals.find((terminal) => terminal.ptyId === 'pty-b')
    expect(terminalA).toBeDefined()
    expect(terminalB).toBeDefined()

    let releaseReveal!: (value: { tabId: string }) => void
    const revealGate = new Promise<{ tabId: string }>((resolve) => {
      releaseReveal = resolve
    })
    const revealTerminalSession = vi
      .fn()
      .mockImplementationOnce(() => revealGate)
      .mockResolvedValue({ tabId: 'tab-b' })
    runtime.setNotifier({ revealTerminalSession } as never)

    const first = runtime.focusTerminal(terminalA!.handle)
    await vi.waitFor(() => expect(revealTerminalSession).toHaveBeenCalledOnce())
    const queued = runtime.focusTerminal(terminalB!.handle)
    runtime.setNotifier(null)
    releaseReveal({ tabId: 'tab-a' })

    await expect(first).resolves.toMatchObject({ handle: terminalA!.handle, navigated: false })
    await expect(queued).resolves.toMatchObject({ handle: terminalB!.handle, navigated: false })
    expect(revealTerminalSession).toHaveBeenCalledOnce()
  })

  it('reports an in-flight PTY focus as not navigated when its notifier disappears', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.ptyId === 'pty-a'
    )
    expect(terminal).toBeDefined()

    let releaseReveal!: (value: { tabId: string }) => void
    const revealTerminalSession = vi.fn(
      () =>
        new Promise<{ tabId: string }>((resolve) => {
          releaseReveal = resolve
        })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    const focus = runtime.focusTerminal(terminal!.handle)
    await vi.waitFor(() => expect(revealTerminalSession).toHaveBeenCalledOnce())
    runtime.setNotifier(null)
    releaseReveal({ tabId: 'tab-a' })

    await expect(focus).resolves.toMatchObject({
      handle: terminal!.handle,
      tabId: 'tab-a',
      navigated: false
    })
  })

  it('does not invoke a stale graph-leaf focus notifier after queued PTY work', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-leaf',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Starting terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-leaf',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })
    const leafTerminal = (await runtime.listTerminals()).terminals.find(
      (terminal) => terminal.tabId === 'tab-leaf'
    )
    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    const ptyTerminal = (await runtime.listTerminals()).terminals.find(
      (terminal) => terminal.ptyId === 'pty-a'
    )
    expect(ptyTerminal).toBeDefined()
    expect(leafTerminal).toBeDefined()

    let releaseReveal!: (value: { tabId: string }) => void
    const revealGate = new Promise<{ tabId: string }>((resolve) => {
      releaseReveal = resolve
    })
    const focusTerminal = vi.fn()
    const revealTerminalSession = vi.fn(() => revealGate)
    runtime.setNotifier({
      revealTerminalSession,
      focusTerminal
    } as never)

    const first = runtime.focusTerminal(ptyTerminal!.handle)
    await vi.waitFor(() => expect(revealTerminalSession).toHaveBeenCalledOnce())
    const queued = runtime.focusTerminal(leafTerminal!.handle)
    runtime.setNotifier(null)
    releaseReveal({ tabId: 'tab-a' })

    await expect(first).resolves.toMatchObject({ handle: ptyTerminal!.handle, navigated: false })
    await expect(queued).resolves.toMatchObject({ handle: leafTerminal!.handle, navigated: false })
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('reports graph-leaf focus as not navigated without a host notifier', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-leaf',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Starting terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-leaf',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: null
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.focusTerminal(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      tabId: 'tab-leaf',
      worktreeId: TEST_WORKTREE_ID,
      navigated: false
    })
  })

  it('clears terminal scrollback through the PTY controller and headless buffer', async () => {
    const clearBuffer = vi.fn().mockResolvedValue(undefined)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      clearBuffer
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\n`,
      123
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.clearTerminalBuffer(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      cleared: true
    })

    expect(clearBuffer).toHaveBeenCalledWith('pty-1')
    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot?.data).not.toContain('line-0')
  })

  it('waits for terminal exit and resolves with the exit status', async () => {
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
    runtime.onPtyExit('pty-1', 7)

    await expect(waitPromise).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 7
    })
  })

  it('keeps partial-line output readable across cursor-based pagination', async () => {
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
    runtime.onPtyData('pty-1', 'hel', 100)

    // Non-cursor reads include the partial line for UI display
    const firstRead = await runtime.readTerminal(terminal.handle)
    expect(firstRead.tail).toEqual(['hel'])
    expect(firstRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', 'lo', 101)

    // Cursor reads exclude partial lines to prevent duplication (partial now, then completed line next read).
    const secondRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstRead.nextCursor)
    })
    expect(secondRead.tail).toEqual([])
    expect(secondRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\nworld\n', 102)

    const thirdRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(secondRead.nextCursor)
    })
    expect(thirdRead.tail).toEqual(['hello', 'world'])
    expect(thirdRead.nextCursor).toBe('2')
  })

  it('paginates retained terminal output with explicit limits and truncation metadata', async () => {
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
    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 150 }, (_, index) => `line-${index}`).join('\n')}\n`,
      100
    )

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe('line-30')
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.latestCursor).toBe('150')

    const defaultCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(defaultCursorRead.tail).toHaveLength(150)
    expect(defaultCursorRead.nextCursor).toBe('150')
    expect(defaultCursorRead.limited).toBe(false)

    const firstPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 50 })
    expect(firstPage.tail).toHaveLength(50)
    expect(firstPage.tail[0]).toBe('line-0')
    expect(firstPage.nextCursor).toBe('50')
    expect(firstPage.limited).toBe(true)
    expect(firstPage.truncated).toBe(false)

    const fractionalPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 0.5 })
    expect(fractionalPage.tail).toEqual(['line-0'])
    expect(fractionalPage.nextCursor).toBe('1')
    expect(fractionalPage.limited).toBe(true)

    const secondPage = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstPage.nextCursor),
      limit: 200
    })
    expect(secondPage.tail).toHaveLength(100)
    expect(secondPage.tail[0]).toBe('line-50')
    expect(secondPage.nextCursor).toBe('150')
    expect(secondPage.limited).toBe(false)

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2100 }, (_, index) => `later-${index}`).join('\n')}\n`,
      101
    )

    const staleCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 5 })
    expect(staleCursorRead.truncated).toBe(true)
    expect(staleCursorRead.oldestCursor).toBe('250')
    expect(staleCursorRead.tail).toEqual([
      'later-100',
      'later-101',
      'later-102',
      'later-103',
      'later-104'
    ])
    expect(staleCursorRead.nextCursor).toBe('255')

    const futureCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 9999 })
    expect(futureCursorRead.tail).toEqual([])
    expect(futureCursorRead.nextCursor).toBe('2250')
    expect(futureCursorRead.limited).toBe(false)
  })

  // Why: PR #2553 keeps retained output cursor-reachable while previews stay bounded (not full-transcript payloads).
  it('keeps terminal read payloads bounded while retained output remains pageable', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const linePayload = 'x'.repeat(24)
    const lines = Array.from(
      { length: 2000 },
      (_, index) => `line-${index.toString().padStart(4, '0')}-${linePayload}`
    )
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThan(10_000)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe(lines.at(-120))
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.nextCursor).toBe('2000')
    expect(preview.latestCursor).toBe('2000')

    const collected: string[] = []
    let cursor = Number(preview.oldestCursor)
    const latestCursor = Number(preview.latestCursor)
    for (let pageIndex = 0; cursor < latestCursor; pageIndex += 1) {
      expect(pageIndex).toBeLessThan(10)
      const page = await runtime.readTerminal(terminal.handle, { cursor, limit: 333 })
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(16_000)
      expect(page.tail.length).toBeGreaterThan(0)
      expect(page.tail.length).toBeLessThanOrEqual(333)
      expect(page.returnedLineCount).toBe(page.tail.length)

      collected.push(...page.tail)
      const nextCursor = Number(page.nextCursor)
      expect(nextCursor).toBeGreaterThan(cursor)
      cursor = nextCursor
    }

    expect(collected).toHaveLength(lines.length)
    expect(collected.findIndex((line, index) => line !== lines[index])).toBe(-1)
  })

  it('trims terminal read preview character budget without per-line array shifts', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}-${'x'.repeat(400)}`)
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)
    // Why: xterm-headless uses Array.shift while draining writes; this test guards read-preview trimming, not emulator parsing.
    await runtime.serializeMainTerminalBuffer('pty-1')

    const originalShift = Array.prototype.shift
    let shiftCallCount = 0
    Array.prototype.shift = function (...args) {
      shiftCallCount += 1
      return originalShift.apply(this, args)
    }
    let preview: Awaited<ReturnType<typeof runtime.readTerminal>>
    try {
      preview = await runtime.readTerminal(terminal.handle)
    } finally {
      Array.prototype.shift = originalShift
    }

    expect(preview.limited).toBe(true)
    expect(preview.tail.at(-1)).toBe(lines.at(-1))
    expect(preview.tail.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(32 * 1024)
    expect(shiftCallCount).toBe(0)
  })

  it('falls back to renderer visible screen when uncursored TUI tail is blank', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '   ').join('\n')}\n`, 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('reads and shows the runtime-owned alternate-screen grid without serialization', async () => {
    const serializeBuffer = vi.fn()
    const serializeProviderBuffer = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      'shell history\r\n\x1b[?1049h\x1b[2J\x1b[HClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
      100
    )

    const read = await runtime.readTerminal(terminal.handle)
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(shown.preview).toBe('Claude Code\nWorking on fix\nTool: Read')
    expect(serializeBuffer).not.toHaveBeenCalled()
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('classifies older provider alternate-screen snapshots from ANSI', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049h\x1b[2J\x1b[HRemote Vim\r\nediting README.md\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless'
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Remote Vim', 'editing README.md'])
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(true)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('honors the last ANSI screen transition when older provider metadata is absent', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hOld TUI\r\n\x1b[?1049l',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless'
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['shell history'])
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(false)
  })

  it.each([
    {
      name: 'live exit wins over an alternate provider snapshot',
      snapshotData: '\x1b[?1049h\x1b[2J\x1b[HStale TUI\r\n',
      snapshotMode: true,
      liveData: '\x1b[?1049lreturned shell\r\n',
      expectedMode: false,
      expectedLine: 'shell history'
    },
    {
      name: 'live entry wins over a primary provider snapshot',
      snapshotData: 'stale shell\r\n',
      snapshotMode: false,
      liveData: '\x1b[?1049h\x1b[2J\x1b[HLive TUI\r\nnew frame\r\n',
      expectedMode: true,
      expectedLine: 'Live TUI'
    }
  ])('$name', async ({ snapshotData, snapshotMode, liveData, expectedMode, expectedLine }) => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    runtime.onPtyData('pty-1', liveData, 101)
    resolveSnapshot({
      data: snapshotData,
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: snapshotMode
    })

    const read = await readPromise
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(expectedMode)
    expect(read.tail.join('\n')).toContain(expectedLine)
    expect(read.tail.join('\n')).not.toContain('Stale TUI')
  })

  it('rejects a provider visible frame after live non-mode-switch output advances', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    runtime.onPtyData('pty-1', 'live progress\r\n', 101)
    resolveSnapshot({
      data: '\x1b[?1049h\x1b[2J\x1b[HStale Ready screen\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const read = await readPromise
    expect(read.tail).toEqual(['shell history'])
    expect(read.tail.join('\n')).not.toContain('Stale Ready screen')
  })

  it('rejects a full provider screen frame after live output advances', async () => {
    type Snapshot = {
      data: string
      scrollbackAnsi: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(
        () =>
          new Promise<Snapshot>((resolve) => {
            resolveSnapshot = resolve
          })
      )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle, { screen: true })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledTimes(2))
    runtime.onPtyData('pty-1', 'live progress\r\n', 101)
    resolveSnapshot({
      data: '\x1b[?1049h\x1b[2J\x1b[HStale full screen\r\n',
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const read = await readPromise
    expect(read.source).toBe('screen-unavailable')
    expect(read.tail.join('\n')).not.toContain('Stale full screen')
  })

  it('shares one provider snapshot between concurrent read and show calls', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    const showPromise = runtime.showTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    resolveSnapshot({
      data: '\x1b[?1049h\x1b[2J\x1b[HShared TUI frame\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const [read, shown] = await Promise.all([readPromise, showPromise])
    expect(read.tail).toEqual(['Shared TUI frame'])
    expect(shown.preview).toBe('Shared TUI frame')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('keeps cursor reads provider-free on restored alternate-screen PTYs', async () => {
    const serializeProviderBuffer = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0 })

    expect(read.tail).toEqual(['shell history'])
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('backs off after a provider snapshot failure instead of retrying for show', async () => {
    const serializeProviderBuffer = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'shell history\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(['shell history'])
    expect(shown.preview).toBe('shell history')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('falls back once to a mounted renderer when a known alternate provider fails', async () => {
    const serializeProviderBuffer = vi
      .fn()
      .mockResolvedValueOnce({
        data: '\x1b[?1049h\x1b[2J\x1b[HProvider TUI\r\n',
        cols: 80,
        rows: 24,
        seq: 900,
        source: 'headless',
        alternateScreen: true
      })
      .mockRejectedValue(new Error('provider unavailable'))
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049h\x1b[2J\x1b[HRenderer TUI\r\n',
      cols: 80,
      rows: 24
    })
    let rendererMounted = false
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => rendererMounted
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals
    await expect(runtime.readTerminal(terminal.handle)).resolves.toMatchObject({
      tail: ['Provider TUI']
    })
    runtime.onPtyData('pty-1', 'new output', 100)
    rendererMounted = true

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Renderer TUI'])
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
    expect(serializeBuffer).toHaveBeenCalledOnce()
  })

  it('bounds a stuck provider snapshot and shares the timed-out request', async () => {
    vi.useFakeTimers()
    try {
      const serializeProviderBuffer = vi.fn(() => new Promise<never>(() => undefined))
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer,
        hasRendererSerializer: () => false
      })
      syncSinglePty(runtime)
      runtime.onPtyData('pty-1', 'shell history\r\n', 100)
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-1',
        { value: 900, generation: 'continued' },
        0
      )
      const [terminal] = (await runtime.listTerminals()).terminals

      const reads = Promise.all([
        runtime.readTerminal(terminal.handle),
        runtime.showTerminal(terminal.handle)
      ])
      await vi.advanceTimersByTimeAsync(750)
      const [read, shown] = await reads

      expect(read.tail).toEqual(['shell history'])
      expect(shown.preview).toBe('shell history')
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a provider frame when the PTY generation resets during capture', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'old shell\r\n', 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence('pty-1')
    )
    resolveSnapshot({
      data: '\x1b[?1049hStale generation TUI\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    const read = await readPromise
    expect(read.tail.join('\n')).not.toContain('Stale generation TUI')
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(false)
  })

  it('rejects a visible frame when its terminal handle changes during capture', async () => {
    type Snapshot = {
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }
    let resolveSnapshot!: (snapshot: Snapshot) => void
    const serializeProviderBuffer = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const readPromise = runtime.readTerminal(terminal.handle)
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    syncSinglePty(runtime, 'pty-2')
    resolveSnapshot({
      data: '\x1b[?1049hWrong terminal frame\r\n',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })

    await expect(readPromise).rejects.toThrow('terminal_handle_stale')
  })

  it('bounds provider visible frames for read and show responses', async () => {
    const visibleLines = [
      'skip-1',
      'skip-2',
      'A'.repeat(49),
      'B'.repeat(49),
      'C'.repeat(49),
      'D'.repeat(49),
      'E'.repeat(49),
      'F'.repeat(50)
    ]
    const expectedTail = visibleLines.slice(-6)
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: `\x1b[?1049h\x1b[2J\x1b[H${visibleLines.join('\r\n')}\r\n`,
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle, { limit: 6 })
    const shown = await runtime.showTerminal(terminal.handle)

    expect(read.tail).toEqual(expectedTail)
    expect(read.returnedLineCount).toBe(6)
    expect(shown.preview).toBe(expectedTail.join('\n'))
    expect(shown.preview.length).toBe(300)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('returns renderer visible screen lines through terminal.read RPC JSON result', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nChecking files\r\nWaiting for input\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRpcRequest('terminal.read', { terminal: terminal.handle })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({
      terminal: {
        handle: terminal.handle,
        status: 'running',
        tail: ['Claude Code', 'Checking files', 'Waiting for input']
      }
    })
  })

  it('separates composer draft text from rendered terminal output', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\r\n  and close the pull request\x1b[22m\x1b[1A\x1b[3G',
      100
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release\nand close the pull request'
    })
  })

  it('keeps renderer-fallback composer drafts separate from terminal output', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\x1b[22m\x1b[3G',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('separates composer drafts from provider-owned terminal screens', async () => {
    const serializeProviderBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hBuild passed\r\n────────\r\n❯ \x1b[2mproceed with the release\x1b[22m\x1b[3G',
      cols: 80,
      rows: 24,
      seq: 900,
      source: 'headless',
      alternateScreen: true
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false
    })
    syncSinglePty(runtime)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    const read = await runtime.readTerminal(terminal.handle)

    expect(read).toMatchObject({
      source: 'screen',
      tail: ['Build passed', '────────', '❯'],
      draft: 'proceed with the release'
    })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('does not use renderer visible-screen fallback for cursor transcript reads', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'Visible TUI\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '   \n', 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0 })

    expect(read.tail).toEqual([''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('does not use renderer visible-screen fallback for a short blank shell tail', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'shell prompt\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\n\n', 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['', ''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('trims oversized terminal output bursts without per-line array shifts', async () => {
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index}`)
    const result = appendNormalizedToTailBuffer([], '', `${lines.join('\n')}\n`)
    const shiftCallCount = shiftSpy.mock.calls.length
    shiftSpy.mockRestore()

    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(2000)
    expect(result.lines.slice(0, 5)).toEqual([
      'line-3000',
      'line-3001',
      'line-3002',
      'line-3003',
      'line-3004'
    ])
    expect(shiftCallCount).toBe(0)
  })

  it('trims terminal tail character budget without per-line array shifts', () => {
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    const lines = Array.from({ length: 1000 }, (_, index) => `line-${index}-${'x'.repeat(300)}`)
    const result = appendNormalizedToTailBuffer([], '', `${lines.join('\n')}\n`)
    const shiftCallCount = shiftSpy.mock.calls.length
    shiftSpy.mockRestore()

    let retainedChars = lines.reduce((sum, line) => sum + line.length, 0)
    let expectedStartIndex = 0
    while (expectedStartIndex < lines.length && retainedChars > 256 * 1024) {
      retainedChars -= lines[expectedStartIndex].length
      expectedStartIndex += 1
    }

    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(lines.slice(expectedStartIndex))
    expect(result.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(256 * 1024)
    expect(shiftCallCount).toBe(0)
  })

  it('builds terminal previews without mapping the full retained tail', () => {
    const lines = Array.from({ length: 5000 }, (_, index) =>
      index % 2 === 0 ? `line-${index}` : '   '
    )
    const mapSpy = vi.spyOn(Array.prototype, 'map')

    const preview = buildPreview(lines, 'partial-tail')
    const mapCallCount = mapSpy.mock.calls.length
    mapSpy.mockRestore()

    expect(preview).toBe(
      ['line-4990', 'line-4992', 'line-4994', 'line-4996', 'line-4998', 'partial-tail'].join('\n')
    )
    expect(mapCallCount).toBe(0)
  })

  it('keeps recent PTY replay output capped without needing previous data for large chunks', () => {
    const previous = 'old-output'.repeat(1000)
    const data = 'new-output'.repeat(1000)
    const outputLimit = 64 * 1024

    const smallTail = new RecentPtyOutputBuffer()
    smallTail.append(previous)
    smallTail.append('tail')
    expect(smallTail.read()).toBe(`${previous}tail`.slice(-outputLimit))

    const combined = new RecentPtyOutputBuffer()
    combined.append(previous)
    combined.append(data)
    expect(combined.read()).toBe(`${previous}${data}`.slice(-outputLimit))

    const fresh = new RecentPtyOutputBuffer()
    fresh.append(data)
    expect(fresh.read()).toBe(data.slice(-outputLimit))
  })

  it('keeps mobile-visible artifact paths in bounded PTY path candidates', () => {
    const artifactPath = '/tmp/result-visible-in-mobile-scrollback.json'
    const prefix = 'x'.repeat(8 * 1024)
    const candidates = appendRecentPtyPathCandidates(undefined, `${artifactPath}\n${prefix}`)

    expect(candidates.length).toBeGreaterThan(0)
    expect(recentTerminalPathCandidatesIncludePath(candidates, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('keeps dotted spaced artifact paths in bounded PTY path candidates', () => {
    const artifactPath = '/tmp/v1.2 reports/result.json'
    const prefix = 'x'.repeat(8 * 1024)
    const candidates = appendRecentPtyPathCandidates(undefined, `wrote ${artifactPath}\n${prefix}`)

    expect(recentTerminalPathCandidatesIncludePath(candidates, artifactPath, artifactPath)).toBe(
      true
    )
    expect(recentTerminalPathCandidatesIncludePath(candidates, '/tmp/v1.2', '/tmp/v1.2')).toBe(
      false
    )
  })

  it('does not swallow trailing prose ending in a filename into candidates', () => {
    const candidates = appendRecentPtyPathCandidates(
      undefined,
      '/tmp/app.log failed to start app.py\n'
    )

    expect(
      recentTerminalPathCandidatesIncludePath(candidates, '/tmp/app.log', '/tmp/app.log')
    ).toBe(true)
    expect(
      recentTerminalPathCandidatesIncludePath(
        candidates,
        '/tmp/app.log failed to start app.py',
        '/tmp/app.log failed to start app.py'
      )
    ).toBe(false)
  })

  it('bounds candidate extraction cost on pathological separator floods', () => {
    const flood = '/'.repeat(64 * 1024)
    const start = performance.now()
    const candidates = appendRecentPtyPathCandidates(undefined, flood)
    const elapsed = performance.now() - start

    expect(candidates).toEqual([])
    // Why: the extension regex is quadratic per line; unbounded it took seconds on the PTY hot path. Loose bound to avoid CI flake.
    expect(elapsed).toBeLessThan(500)
  })

  it('strips retained terminal path line and hash locators before matching', () => {
    const colonPath = '/tmp/orca report/result.json'
    const hashPath = '/tmp/result-hash.json'
    const candidates = appendRecentPtyPathCandidates(
      undefined,
      `wrote ${colonPath}:12:3 for you\nfile://${hashPath}#L12C3 generated\n`
    )

    expect(recentTerminalPathCandidatesIncludePath(candidates, colonPath, colonPath)).toBe(true)
    expect(recentTerminalPathCandidatesIncludePath(candidates, hashPath, hashPath)).toBe(true)
  })

  it('keeps non-loopback file URI authorities in retained PTY path candidates', () => {
    const candidates = appendRecentPtyPathCandidates(
      undefined,
      'wrote file://remote-host/tmp/result.json\n'
    )

    expect(
      recentTerminalPathCandidatesIncludePath(
        candidates,
        '//remote-host/tmp/result.json',
        '//remote-host/tmp/result.json'
      )
    ).toBe(true)
    expect(
      recentTerminalPathCandidatesIncludePath(candidates, '/tmp/result.json', '/tmp/result.json')
    ).toBe(false)
  })

  it('keeps loopback file URI paths as local retained PTY path candidates', () => {
    const candidates = appendRecentPtyPathCandidates(
      undefined,
      'wrote file://localhost/tmp/result.json#L12\n'
    )

    expect(
      recentTerminalPathCandidatesIncludePath(candidates, '/tmp/result.json', '/tmp/result.json')
    ).toBe(true)
  })

  it('keeps tmpdir artifact paths in bounded PTY path candidates', () => {
    const artifactPath = join(tmpdir(), 'orca-runtime-retained-result.json')
    const candidates = appendRecentPtyPathCandidates(undefined, `wrote ${artifactPath}\n`)

    expect(recentTerminalPathCandidatesIncludePath(candidates, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('matches WSL UNC artifact paths against POSIX terminal output candidates', () => {
    const candidates = appendRecentPtyPathCandidates(undefined, 'wrote /tmp/result.json\n')

    expect(
      recentTerminalPathCandidatesIncludePath(
        candidates,
        '\\\\wsl.localhost\\Ubuntu\\tmp\\result.json',
        '\\\\wsl.localhost\\Ubuntu\\tmp\\result.json'
      )
    ).toBe(true)
  })

  it('keeps bounded PTY path candidates under a total byte budget', () => {
    const longCandidate = `/tmp/${'x'.repeat(5 * 1024)}.json`
    const candidates = appendRecentPtyPathCandidates(undefined, `${longCandidate}\n`)

    expect(candidates).toEqual([])

    let retained: string[] | undefined
    for (let index = 0; index < 200; index += 1) {
      retained = appendRecentPtyPathCandidates(retained, `/tmp/${'a'.repeat(900)}-${index}.json\n`)
    }
    const totalBytes = (retained ?? []).reduce(
      (sum, candidate) => sum + Buffer.byteLength(candidate, 'utf8'),
      0
    )
    expect(totalBytes).toBeLessThanOrEqual(64 * 1024)
  })

  it('keeps Windows file URI drive paths in bounded PTY path candidates', () => {
    const artifactPath = 'C:/Users/me/AppData/Local/Temp/result.json'
    const prefix = 'x'.repeat(8 * 1024)
    const candidates = appendRecentPtyPathCandidates(
      undefined,
      `file:///C:/Users/me/AppData/Local/Temp/result.json\n${prefix}`
    )

    expect(recentTerminalPathCandidatesIncludePath(candidates, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('matches terminal artifact paths only when they appear in recent terminal output', () => {
    expect(
      recentTerminalOutputIncludesPath(
        'wrote /tmp/orca report/result.json:12:3',
        '/tmp/orca report/result.json',
        '/tmp/orca report/result.json'
      )
    ).toBe(true)
    expect(
      recentTerminalOutputIncludesPath(
        '\x1b]8;;file:///tmp/orca%20report/result.json\x1b\\result\x1b]8;;\x1b\\',
        '/tmp/orca report/result.json',
        '/tmp/orca report/result.json'
      )
    ).toBe(true)
    expect(
      recentTerminalOutputIncludesPath(
        '\x1b]8;;file:///tmp/caf%C3%A9.txt\x1b\\result\x1b]8;;\x1b\\',
        '/tmp/café.txt',
        '/tmp/café.txt'
      )
    ).toBe(true)
    expect(
      recentTerminalOutputIncludesPath(
        'wrote /tmp/orca report/other.json',
        '/tmp/orca report/result.json',
        '/tmp/orca report/result.json'
      )
    ).toBe(false)
  })

  it('does not match terminal artifact path prefixes as provenance', () => {
    expect(
      recentTerminalOutputIncludesPath(
        'wrote /tmp/result.json.bak',
        '/tmp/result.json',
        '/tmp/result.json'
      )
    ).toBe(false)
    expect(
      recentTerminalOutputIncludesPath(
        'wrote /tmp/result.json:12:3',
        '/tmp/result.json',
        '/tmp/result.json'
      )
    ).toBe(true)
  })

  it('matches terminal artifact paths inside loopback file URI output', () => {
    expect(
      recentTerminalOutputIncludesPath(
        'wrote file://127.0.0.1/tmp/result.json',
        '/tmp/result.json',
        '/tmp/result.json'
      )
    ).toBe(true)
    expect(
      recentTerminalOutputIncludesPath(
        'wrote file://[::1]/tmp/result.json',
        '/tmp/result.json',
        '/tmp/result.json'
      )
    ).toBe(true)
    expect(
      recentTerminalOutputIncludesPath(
        'wrote file:///C:/Users/me/AppData/Local/Temp/result.json',
        'C:/Users/me/AppData/Local/Temp/result.json',
        'C:/Users/me/AppData/Local/Temp/result.json'
      )
    ).toBe(true)
    expect(
      recentTerminalOutputIncludesPath(
        'wrote file://localhost/C:/Users/me/AppData/Local/Temp/result.json',
        'C:/Users/me/AppData/Local/Temp/result.json',
        'C:/Users/me/AppData/Local/Temp/result.json'
      )
    ).toBe(true)
  })

  it('applies terminal redraw controls before retaining previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Working\rWorking 1s\rWorking 2s', 100)

    const carriageRead = await runtime.readTerminal(terminal.handle)
    expect(carriageRead.tail).toEqual(['Working 2s'])
    expect(carriageRead.latestCursor).toBe('0')

    runtime.onPtyData('pty-1', '\b\b3s', 101)
    const backspaceRead = await runtime.readTerminal(terminal.handle)
    expect(backspaceRead.tail).toEqual(['Working 3s'])
    expect(backspaceRead.latestCursor).toBe('0')

    runtime.onPtyData('pty-1', '\rDone\n', 102)
    const completedRead = await runtime.readTerminal(terminal.handle)
    expect(completedRead.tail).toEqual(['Done'])
    expect(completedRead.latestCursor).toBe('1')
  })

  it('applies ANSI terminal redraw controls before retaining previews', async () => {
    const cursorRedraw = appendNormalizedToTailBuffer([], '', 'Working 10%\x1b[3D25%')
    expect(cursorRedraw.partialLine).toBe('Working 25%')

    const eraseLineKeepsCursor = appendNormalizedToTailBuffer([], '', 'ABC\x1b[2KXY\n')
    expect(eraseLineKeepsCursor.lines).toEqual(['   XY'])

    const eraseWithoutCarriageReturn = appendNormalizedToTailBuffer(
      [],
      'Downloading 10%',
      '\x1b[2K\x1b[1GDownloading 20%'
    )
    expect(eraseWithoutCarriageReturn.partialLine).toBe('Downloading 20%')

    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      'Working\r\x1b[2K\x1b[1G\x1b[?25l\x1b[32mDone\x1b[0m\x1b]0;title\u0007\n',
      100
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['Done'])
    expect(read.latestCursor).toBe('1')
  })

  it('retains ANSI-only status redraws instead of appending every frame', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working', 100)
    const initialPreview = await runtime.readTerminal(terminal.handle)
    expect(initialPreview.tail).toEqual(['• Working'])

    runtime.onPtyData('pty-1', '\x1b[2K\x1b[1G• Working.', 101)
    const redrawPreview = await runtime.readTerminal(terminal.handle)
    expect(redrawPreview.tail).toEqual(['• Working.'])
    expect(redrawPreview.tail.join('\n')).not.toContain('• Working• Working')

    runtime.onPtyData('pty-1', '\x1b[2K\x1b[1G• Working..', 102)
    const latestPreview = await runtime.readTerminal(terminal.handle)
    expect(latestPreview.tail).toEqual(['• Working..'])
    expect(latestPreview.latestCursor).toBe('0')

    const cursorReadBeforeNewline = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(cursorReadBeforeNewline.tail).toEqual([])
    expect(cursorReadBeforeNewline.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\n', 103)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working..'])
    expect(read.latestCursor).toBe('1')
    expect(read.tail.join('\n')).not.toContain('• Working• Working')

    const cursorReadAfterNewline = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(cursorReadAfterNewline.tail).toEqual(['• Working..'])
    expect(cursorReadAfterNewline.nextCursor).toBe('1')
  })

  it('retains multi-line ANSI footer redraws instead of appending old frames', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working\nTool call\n', 100)
    runtime.onPtyData(
      'pty-1',
      '\x1b[2A\x1b[2K\x1b[1G• Working.\n\x1b[2K\x1b[1GTool call finished\n',
      101
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working.', 'Tool call finished'])
    expect(read.latestCursor).toBe('4')
    expect(read.tail.join('\n')).not.toContain('• Working\nTool call\n• Working.')
    expect(read.tail.join('\n')).not.toContain('2A')
    expect(read.tail.join('\n')).not.toContain('2K')
  })

  it('keeps the cursor column when erasing full lines in multi-line redraws', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABC\nxyz', 100)
    runtime.onPtyData('pty-1', '\x1b[1A\x1b[2KXY\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['   XY'])
    expect(read.tail.join('\n')).not.toContain('ABCXY')
    expect(read.tail.join('\n')).not.toContain('2K')
  })

  it('retains split multi-line ANSI footer redraw state across chunks', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working\nTool call\n', 100)
    const beforeRedraw = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(beforeRedraw.tail).toEqual(['• Working', 'Tool call'])
    expect(beforeRedraw.nextCursor).toBe('2')

    runtime.onPtyData('pty-1', '\x1b[2A', 101)
    const betweenChunks = await runtime.readTerminal(terminal.handle)
    expect(betweenChunks.tail).toEqual(['• Working'])
    expect(betweenChunks.latestCursor).toBe('2')

    runtime.onPtyData('pty-1', '\x1b[2K\x1b[1G• Working.\n\x1b[2K\x1b[1GTool call finished\n', 102)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working.', 'Tool call finished'])
    expect(read.latestCursor).toBe('4')

    const cursorRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(beforeRedraw.nextCursor)
    })
    expect(cursorRead.tail).toEqual(['• Working.', 'Tool call finished'])
    expect(cursorRead.oldestCursor).toBe('0')
    expect(cursorRead.nextCursor).toBe('4')
  })

  it('does not let stale lower rows hide earlier corrected footer rows from cursor reads', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'A\nB\nC\n', 100)
    const beforeRedraw = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(beforeRedraw.tail).toEqual(['A', 'B', 'C'])
    expect(beforeRedraw.nextCursor).toBe('3')

    runtime.onPtyData('pty-1', '\x1b[2A\x1b[2K\x1b[1GB2\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['A', 'B2'])
    expect(read.latestCursor).toBe('4')

    const cursorRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(beforeRedraw.nextCursor)
    })
    expect(cursorRead.tail).toEqual(['B2'])
    expect(cursorRead.oldestCursor).toBe('0')
    expect(cursorRead.nextCursor).toBe('4')
  })

  it('keeps cursor pagination stable across a CUU redraw of the live screen', async () => {
    const runtime = new OrcaRuntimeService(store)
    const liveScreen = new HeadlessEmulator({ cols: 80, rows: 24 })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const initialOutput = 'A\r\nB\r\nC\r\n'
    const redraw = '\x1b[2A\x1b[2K\x1b[1GB2\r\n'
    runtime.onPtyData('pty-1', initialOutput, 100)
    await liveScreen.write(initialOutput)

    const firstPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 2 })
    expect(firstPage).toMatchObject({
      tail: ['A', 'B'],
      truncated: false,
      limited: true,
      oldestCursor: '0',
      nextCursor: '2',
      latestCursor: '3',
      returnedLineCount: 2
    })

    runtime.onPtyData('pty-1', redraw, 101)
    await liveScreen.write(redraw)

    // Why: CUU changes the mutable screen, but completed-line pagination is a distinct contract.
    expect(liveScreen.getVisibleLines().filter((line) => line.length > 0)).toEqual(['A', 'B2', 'C'])
    await expect(runtime.readTerminal(terminal.handle, { cursor: 2 })).resolves.toMatchObject({
      tail: ['C', 'B2'],
      truncated: false,
      limited: false,
      oldestCursor: '0',
      nextCursor: '4',
      latestCursor: '4',
      returnedLineCount: 2
    })

    liveScreen.dispose()
  })

  it('records completed transcript lines before later CUU redraws in the same PTY chunk', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'A\r\nB\r\nC\r\n\x1b[2A\x1b[2K\x1b[1GB2\r\n', 100)

    await expect(runtime.readTerminal(terminal.handle, { cursor: 0 })).resolves.toMatchObject({
      tail: ['A', 'B', 'C', 'B2'],
      truncated: false,
      oldestCursor: '0',
      nextCursor: '4',
      latestCursor: '4'
    })
  })

  it('bounds completed transcript entries from a single multi-line redraw chunk', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const lines = Array.from({ length: 2100 }, (_, index) => `redraw-${index}`)
    runtime.onPtyData('pty-1', `\x1b[1A${lines.join('\n')}\n`, 100)

    await expect(
      runtime.readTerminal(terminal.handle, { cursor: 0, limit: 3 })
    ).resolves.toMatchObject({
      tail: ['redraw-100', 'redraw-101', 'redraw-102'],
      truncated: true,
      oldestCursor: '100',
      nextCursor: '103',
      latestCursor: '2100'
    })
  })

  it('retains multi-line ANSI redraws when the last footer row stays partial', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '• Working\nTool call\n', 100)
    const beforeRedraw = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(beforeRedraw.nextCursor).toBe('2')

    runtime.onPtyData(
      'pty-1',
      '\x1b[2A\x1b[2K\x1b[1G• Working.\n\x1b[2K\x1b[1GTool call still running',
      101
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['• Working.', 'Tool call still running'])
    expect(read.latestCursor).toBe('3')

    const cursorRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(beforeRedraw.nextCursor)
    })
    expect(cursorRead.tail).toEqual(['• Working.'])
    expect(cursorRead.oldestCursor).toBe('0')
    expect(cursorRead.nextCursor).toBe('3')

    runtime.onPtyData('pty-1', '\n', 102)
    const completedPartialRead = await runtime.readTerminal(terminal.handle, { cursor: 3 })
    expect(completedPartialRead.tail).toEqual(['Tool call still running'])
    expect(completedPartialRead.nextCursor).toBe('4')
  })

  it('does not retain split ANSI controls as visible terminal preview text', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Working\r\x1b[', 100)
    runtime.onPtyData('pty-1', '38;2;190;210;223;49mWo', 101)

    const colorRead = await runtime.readTerminal(terminal.handle)
    const colorRetained = colorRead.tail.join('\n')
    expect(colorRetained).toContain('Wo')
    expect(colorRetained).not.toContain('38;2')
    expect(colorRetained).not.toContain('49m')

    runtime.onPtyData('pty-1', 'rking\x1b[?2026', 102)
    runtime.onPtyData('pty-1', 'l', 103)

    const modeRead = await runtime.readTerminal(terminal.handle)
    const retained = modeRead.tail.join('\n')
    expect(retained).toContain('Working')
    expect(retained).not.toContain('38;2')
    expect(retained).not.toContain('?2026')
    expect(retained).not.toContain('49m')

    runtime.onPtyData('pty-1', ` done\x1b]0;${'x'.repeat(5000)}`, 104)
    runtime.onPtyData('pty-1', '\u0007\n', 105)

    const longRead = await runtime.readTerminal(terminal.handle)
    const longRetained = longRead.tail.join('\n')
    expect(longRetained).toContain('Working done')
    expect(longRetained).not.toContain('x'.repeat(100))
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('x'.repeat(MAX_OSC_TITLE_CHARS))
  })

  it('applies ANSI split redraw controls without leaking raw params', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Frame old', 100)
    runtime.onPtyData('pty-1', '\x1b[', 101)

    const pendingEraseRead = await runtime.readTerminal(terminal.handle)
    expect(pendingEraseRead.tail).toEqual(['Frame old'])
    expect(pendingEraseRead.tail.join('\n')).not.toContain('[')

    runtime.onPtyData('pty-1', '2K\x1b[', 102)
    const pendingColumnRead = await runtime.readTerminal(terminal.handle)
    expect(pendingColumnRead.tail.join('\n')).not.toContain('2K')
    expect(pendingColumnRead.tail.join('\n')).not.toContain('1G')

    runtime.onPtyData('pty-1', '1GFrame new\n', 103)
    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(read.tail).toEqual(['Frame new'])
    expect(retained).not.toContain('2K')
    expect(retained).not.toContain('1G')
  })

  it('retains same-line redraw cursor position across split full-line erase chunks', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABC', 100)
    runtime.onPtyData('pty-1', '\x1b[2K', 101)
    const erasedRead = await runtime.readTerminal(terminal.handle)
    expect(erasedRead.tail).toEqual([])

    runtime.onPtyData('pty-1', 'XY\n', 102)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['   XY'])
    expect(read.tail.join('\n')).not.toContain('ABCXY')
    expect(read.tail.join('\n')).not.toContain('2K')
  })

  it('keeps huge ANSI cursor movement params bounded in retained previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const infinityParam = '9'.repeat(400)
    runtime.onPtyData('pty-1', `A\x1b[1000000000CZ\n`, 100)
    runtime.onPtyData('pty-1', `B\x1b[${infinityParam}GQ\n`, 101)
    for (let index = 0; index < 50; index += 1) {
      runtime.onPtyData('pty-1', `R${index}\x1b[2K\x1b[999999CZ\n`, 102 + index)
    }

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 60 })
    expect(read.tail).toHaveLength(52)
    for (const line of read.tail) {
      expect(line.length).toBeLessThan(5000)
      expect(line).not.toContain('1000000000')
      expect(line).not.toContain(infinityParam)
      expect(line).not.toContain('999999')
    }
    expect(read.tail[0]?.startsWith('A')).toBe(true)
    expect(read.tail[0]?.endsWith('Z')).toBe(true)
    expect(read.tail[1]?.startsWith('B')).toBe(true)
    expect(read.tail[1]?.endsWith('Q')).toBe(true)
    expect(read.tail.at(-1)?.endsWith('Z')).toBe(true)
  })

  it('bounds retained work for many newline-separated huge ANSI cursor movements', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b[4000GZ\n'.repeat(3000), 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 2000 })
    expect(read.latestCursor).toBe('3000')
    expect(read.oldestCursor).not.toBe('0')
    expect(read.tail.length).toBeLessThan(100)
    for (const line of read.tail) {
      expect(line.length).toBeLessThanOrEqual(4000)
      expect(line.endsWith('Z')).toBe(true)
      expect(line).not.toContain('4000G')
    }
  })

  it('applies ANSI erase-from-start line controls in retained previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[3D\x1b[1KXY\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['  XYE'])
    expect(read.tail.join('\n')).not.toContain('ABC')
    expect(read.tail.join('\n')).not.toContain('1K')
  })

  it('applies ANSI stripping for private or intermediate CSI line controls', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[?99DXY\n', 100)
    runtime.onPtyData('pty-1', 'ABCDE\x1b[1$DXY\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['ABCDEXY', 'ABCDEXY'])
    expect(read.tail.join('\n')).not.toContain('?99D')
    expect(read.tail.join('\n')).not.toContain('1$D')
  })

  it('applies ANSI stripping for unsupported erase-line modes', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Old\x1b[3KNew\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['OldNew'])
    expect(read.tail.join('\n')).not.toContain('3K')
  })

  it('does not retain split ST-terminated string controls as preview text', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Before \x1b_Gi=31337,s=1,', 100)
    runtime.onPtyData('pty-1', 'v=1,a=q,t=d,f=24;AAAA\x1b\\After\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(retained).toContain('BeforeAfter')
    expect(retained).not.toContain('Gi=31337')
    expect(retained).not.toContain('AAAA')
  })

  it('preserves non-ASCII terminal preview text in chunks with controls', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b[32mHéllo 🌊\x1b[0m\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['Héllo 🌊'])
  })

  it('detects split OSC titles before retaining terminal previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Codex work', 100)
    runtime.onPtyData('pty-1', 'ing\x07Visible\n', 101)

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('Codex working')
    expect(pty?.lastAgentStatus).toBe('working')

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail.join('\n')).toContain('Visible')
    expect(read.tail.join('\n')).not.toContain('Codex working')
  })

  it('detects ST-terminated OSC titles split before the final backslash', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x1b', 100)
    runtime.onPtyData('pty-1', '\\Visible\n', 101)

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('Codex working')
    expect(pty?.lastAgentStatus).toBe('working')
  })

  it('preserves a trailing escape after a completed OSC title', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07\x1b', 100)
    runtime.onPtyData('pty-1', ']0;Codex done\x07Visible\n', 101)

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('Codex done')
    expect(pty?.lastAgentStatus).toBe('idle')
  })

  it('normalizes rotating Grok working-frame OSC titles to one stable stored title', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;⠋ - Waiting for response… - grok\x07', 100)
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('⠋ Grok')
    expect(pty?.lastAgentStatus).toBe('working')

    // A different rotating frame must store an identical title — title equality is what stops per-frame session-tab and mobile-snapshot touch.
    runtime.onPtyData('pty-1', '\x1b]0;⠴ - Thinking - grok\x07', 101)
    expect(pty?.lastOscTitle).toBe('⠋ Grok')
    expect(pty?.lastAgentStatus).toBe('working')
  })

  it('does not republish mobile session tabs for same-status Grok title frames', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;⠋ - Waiting for response… - grok\x07', 100)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;⠴ - Thinking - grok\x07', 101)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;⠙ - Responding - grok\x07', 102)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '⠋ Grok',
        agentStatus: expect.objectContaining({ state: 'working' })
      })
    )

    unsubscribe()
  })

  // #7970: headless serve has no renderer syncing tab.agentStatus, so hook-only transitions must republish the snapshot carrying the retained hook payload.
  it('republishes mobile session tabs with hook payloads for title-less OSC 9999 transitions', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-only-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData(
      'hook-only-pty',
      '\x1b]9999;{"state":"working","prompt":"fix the tests","agentType":"opencode"}\x07',
      100
    )

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix the tests',
          agentType: 'opencode'
        })
      })
    )

    runtime.onPtyData(
      'hook-only-pty',
      '\x1b]9999;{"state":"waiting","prompt":"fix the tests","agentType":"opencode"}\x07',
      101
    )

    await waitForMobileSessionTabsEvents(events, 2)
    expect(events).toHaveLength(2)
    expect(events[1]?.tabs[0]?.type === 'terminal' && events[1].tabs[0].agentStatus).toEqual(
      expect.objectContaining({ state: 'waiting' })
    )

    unsubscribe()
  })

  // Why: restored OMP panes can retain the hook while the wrapped Pi owns foreground (#6364).
  it('keeps an OMP hook labeled OMP when the wrapped pi child owns the foreground', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'omp-flicker-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      // Why: the remote relay reads the deeper `pi` child of the omp process tree.
      getForegroundProcess: async () => 'pi'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'omp-tab',
      leafId: HEADLESS_LEAF_ID
    })
    // Restored/mirrored pane: no launchAgent, only the pi foreground read remains.
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { launchAgent: string | null; foregroundAgent: string | null }>
      }
    ).ptysById.get('omp-flicker-pty')!
    pty.launchAgent = null
    pty.foregroundAgent = 'pi'
    events.length = 0

    runtime.onPtyData(
      'omp-flicker-pty',
      '\x1b]0;⠋ Pi\x07' +
        '\x1b]9999;{"state":"working","prompt":"fix the bug","agentType":"omp"}\x07',
      100
    )

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '⠋ OMP',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'omp',
          terminalTitle: '⠋ OMP'
        })
      })
    )

    unsubscribe()
  })

  it('does not republish mobile session tabs for repeated identical OSC 9999 payloads', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-ping-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-ping-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    const payload = '\x1b]9999;{"state":"working","prompt":"same","agentType":"codex"}\x07'
    runtime.onPtyData('hook-ping-pty', payload, 100)
    runtime.onPtyData('hook-ping-pty', payload, 101)
    runtime.onPtyData('hook-ping-pty', payload, 102)

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toHaveLength(1)

    unsubscribe()
  })

  it('suppresses a retained hook working status once the shell owns the pane title again', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-exit-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-exit-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData(
      'hook-exit-pty',
      '\x1b]9999;{"state":"working","prompt":"long task","agentType":"codex"}\x07',
      100
    )
    // Agent exits without a hook done event and the shell takes the title back; the stuck-spinner guard (#1437) must win over the retained hook row.
    runtime.onPtyData('hook-exit-pty', '\x1b]0;zsh\x07', 101)

    await waitForMobileSessionTabsEvents(events, 1)
    const last = events.at(-1)?.tabs[0]
    expect(last?.type).toBe('terminal')
    expect(last?.type === 'terminal' ? last.agentStatus : null).toBeFalsy()

    unsubscribe()
  })

  it('stores normalized Pi idle OSC titles that still classify as idle', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;π - my-project\x07', 100)
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('π - my-project')
    expect(pty?.lastAgentStatus).toBe('idle')
    // Why: worktree.ps / mobile re-detect from stored lastOscTitle, not the raw OSC frame; the preserved π title must still classify as idle after normalize.
    expect(detectAgentStatusFromTitle(pty?.lastOscTitle ?? '')).toBe('idle')
  })

  it('normalizes hydration-seeded Grok and Pi titles the same as live OSC frames', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    ;(
      runtime as unknown as {
        applySeededAgentStatus: (ptyId: string, title: string) => void
      }
    ).applySeededAgentStatus('pty-1', '⠴ - Thinking - grok')
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null; lastAgentStatus: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('⠋ Grok')
    // Seed writes leaf status only; re-detect from the stored title must still report working so later live frames compare equal and don't thrash.
    expect(detectAgentStatusFromTitle(pty?.lastOscTitle ?? '')).toBe('working')

    ;(
      runtime as unknown as {
        applySeededAgentStatus: (ptyId: string, title: string) => void
      }
    ).applySeededAgentStatus('pty-1', 'π - my-project')
    expect(pty?.lastOscTitle).toBe('π - my-project')
    expect(detectAgentStatusFromTitle(pty?.lastOscTitle ?? '')).toBe('idle')
  })

  it('stores other-agent OSC titles that merely end in grok unchanged', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;⠋ wire up grok\x07', 100)
    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { lastOscTitle: string | null }>
      }
    ).ptysById.get('pty-1')
    expect(pty?.lastOscTitle).toBe('⠋ wire up grok')

    // Claude/Codex braille + task ending " - grok" is not a Grok frame shape.
    runtime.onPtyData('pty-1', '\x1b]0;⠋ fix the flaky suite - grok\x07', 101)
    expect(pty?.lastOscTitle).toBe('⠋ fix the flaky suite - grok')
  })

  it('seeds newly synced leaves from PTY pending ANSI state', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('pty-1', 'Working\r\x1b[', 100)

    syncSinglePty(runtime)
    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '38;2;190;210;223;49mDone\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(retained).toContain('Done')
    expect(retained).not.toContain('38;2')
    expect(retained).not.toContain('49m')
  })

  it('normalizes large CRLF-heavy terminal chunks without regex replacement or line splits', async () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime)
    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${'line\r\n'.repeat(10_000)}tail`, 100)
    const read = await runtime.readTerminal(terminal.handle, { limit: 5 })
    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern], index) =>
        pattern instanceof RegExp &&
        pattern.source === '\\r\\n' &&
        typeof replaceSpy.mock.contexts[index] === 'string' &&
        replaceSpy.mock.contexts[index].length > 10_000
    )
    const usedLineSplit = splitSpy.mock.calls.some(([separator], index) => {
      const splitSeparator = separator as unknown
      return (
        (splitSeparator === '\n' ||
          (splitSeparator instanceof RegExp && splitSeparator.source === '\\r?\\n')) &&
        typeof splitSpy.mock.contexts[index] === 'string' &&
        splitSpy.mock.contexts[index].length > 10_000
      )
    })

    expect(read.tail.at(-1)).toBe('tail')
    expect(usedCrlfReplace).toBe(false)
    expect(usedLineSplit).toBe(false)
  })

  it('bounds retained partial terminal output before preview reads', async () => {
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
    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2000 }, (_, index) => `line-${index}`).join('\n')}\n`,
      99
    )
    runtime.onPtyData('pty-1', `${'x'.repeat(40_000)}tail-marker-0`, 100)
    type RetainedTailState = {
      tailBuffer: string[]
      tailPartialLine: string
      tailTruncated: boolean
    }
    const cappedPartialState = (
      runtime as unknown as {
        ptysById: Map<string, RetainedTailState>
      }
    ).ptysById.get('pty-1')
    const retainedLineBuffer = cappedPartialState?.tailBuffer
    for (let index = 1; index < 5; index += 1) {
      runtime.onPtyData('pty-1', `${'x'.repeat(40_000)}tail-marker-${index}`, 100 + index)
    }

    const retained = (
      runtime as unknown as {
        ptysById: Map<string, RetainedTailState>
      }
    ).ptysById.get('pty-1')
    expect(retained?.tailBuffer).toBe(retainedLineBuffer)
    expect(retained?.tailPartialLine).toHaveLength(4000)
    expect(retained?.tailPartialLine.endsWith('tail-marker-4')).toBe(true)
    expect(retained?.tailTruncated).toBe(true)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail.at(-1)).toHaveLength(4000)
    expect(preview.tail.at(-1)?.endsWith('tail-marker-4')).toBe(true)
    expect(preview.truncated).toBe(true)
    expect(preview.nextCursor).toBe('2000')
  })

  it('delivers pending orchestration messages to an already-idle agent', async () => {
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
      db.setActiveCoordinatorRun({ coordinator_handle: 'term_other' })
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits the mail pointer in an active coordinator pane', async () => {
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
      db.setActiveCoordinatorRun({ coordinator_handle: terminal.handle })
      db.insertMessage({
        from: 'term_sender',
        to: terminal.handle,
        subject: 'hello coordinator'
      })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      const submitWrites = write.mock.calls.filter(
        ([ptyId, text]) => ptyId === 'pty-1' && text === '\r'
      )
      expect(submitWrites).toHaveLength(1)

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('injects pending orchestration messages into Cursor Agent without auto-submitting', async () => {
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
      runtime.onPtyData('pty-1', '\x1b]0;\u280b Cursor Agent\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Cursor ready\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello cursor' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      const submitWrites = write.mock.calls.filter(
        ([ptyId, text]) => ptyId === 'pty-1' && text === '\r'
      )
      expect(submitWrites).toHaveLength(0)

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still auto-submits to a non-Cursor agent when its idle title mentions Cursor Agent', async () => {
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
      syncSinglePty(runtime, 'pty-1', { tabTitle: 'cursor-repro-branch' })

      const [terminal] = (await runtime.listTerminals()).terminals
      bindSinglePtyRun(db, terminal.handle)
      runtime.onPtyData('pty-1', '\x1b]0;. Investigate Cursor Agent\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;* Investigate Cursor Agent\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello claude' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      expect(write).toHaveBeenCalledWith(
        'pty-1',
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replay an already-delivered message on a later idle transition', async () => {
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
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const firstInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('orca orchestration check')
      ).length
      expect(firstInjections).toBe(1)

      // The row remains pending, so the in-memory sequence watermark prevents replay.
      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const totalInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('orca orchestration check')
      ).length
      expect(totalInjections).toBe(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts preallocated ORCA_TERMINAL_HANDLE as a valid runtime handle', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'ready\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.handle).toBe(handle)
    expect(read.tail).toEqual(['ready'])
  })

  it('recovers exported ORCA_TERMINAL_HANDLE from discovered live PTY sessions', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-1',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_exported'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    expect(listed.terminals[0]?.handle).toBe('term_exported')

    runtime.onPtyData('pty-1', 'after restart\n', 100)
    await expect(runtime.readTerminal('term_exported')).resolves.toMatchObject({
      handle: 'term_exported',
      tail: ['after restart']
    })
    await expect(
      runtime.sendTerminal('term_exported', { text: 'still writable' })
    ).resolves.toMatchObject({
      handle: 'term_exported',
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('adopts a v1.4.150-shaped agent, setup, and shell orphan as one topology transaction', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const writes: [string, string][] = []
    const resize = vi.fn(() => true)
    const processes = [
      ['pty-agent', 'inc-agent', 'term_agent', 'Agent'],
      ['pty-setup', 'inc-setup', 'term_setup', 'Setup'],
      ['pty-shell', 'inc-shell', 'term_shell', 'Shell']
    ] as const
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const listProcesses = vi.fn(async () =>
      processes.map(([id, incarnationId, terminalHandle, title]) => ({
        id,
        incarnationId,
        terminalHandle,
        title,
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }))
    )
    runtime.setPtyController({
      write: (ptyId, data) => {
        writes.push([ptyId, data])
        return true
      },
      resize,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals.map((terminal) => terminal.tabId)).toEqual(
      processes.map(([id]) => `pty:${id}`)
    )
    const targeted = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`, 100, {
      handles: ['term_setup'],
      requireFreshPtyLiveness: true
    })
    expect(targeted).toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_setup', ptyId: 'pty-setup' })],
      totalCount: 1,
      truncated: false
    })
    runtime.onPtyData('pty-agent', 'legacy output\n', 1)

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_agent',
            ptyId: 'pty-agent',
            incarnationId: 'stale-incarnation',
            tabId: 'tab-agent',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      activeTabId: 'tab-agent',
      activeGroupId: 'legacy-group',
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: ['tab-agent', 'tab-setup', 'tab-shell'][index]!,
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      }))
    })

    expect(adopted.adopted).toBe(true)
    expect(adopted.topologyRevision).toBe(1)
    expect(adopted.snapshot.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID,
          title: 'Agent',
          terminal: 'term_agent'
        }),
        expect.objectContaining({
          parentTabId: 'tab-setup',
          leafId: HEADLESS_SECOND_LEAF_ID,
          title: 'Setup',
          terminal: 'term_setup'
        }),
        expect.objectContaining({
          parentTabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID,
          title: 'Shell',
          terminal: 'term_shell'
        })
      ])
    )
    expect(adopted.snapshot.tabGroups).toEqual([
      expect.objectContaining({
        activeTabId: 'tab-agent',
        tabOrder: ['tab-agent', 'tab-setup', 'tab-shell']
      })
    ])
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)

    await runtime.sendTerminal('term_agent', { text: 'input' })
    await runtime.updateRemoteDesktopViewer('pty-agent', 'viewer', 'client', 132, 41)
    expect(writes).toEqual([['pty-agent', 'input']])
    expect(resize).toHaveBeenCalledWith('pty-agent', 132, 41)
    await expect(runtime.readTerminal('term_agent')).resolves.toMatchObject({
      tail: ['legacy output']
    })

    const inventoryCount = listProcesses.mock.calls.length
    const agentPty = (
      runtime as unknown as {
        ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
      }
    ).ptysById.get('pty-agent')!
    agentPty.tabId = null
    agentPty.paneKey = null
    const secondClient = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: ['tab-agent', 'tab-setup', 'tab-shell'][index]!,
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      }))
    })
    expect(secondClient).toMatchObject({ adopted: false, topologyRevision: 1 })
    expect(agentPty).toMatchObject({
      tabId: 'tab-agent',
      paneKey: makePaneKey('tab-agent', HEADLESS_LEAF_ID)
    })
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCount + 1)
    expect(listProcesses).toHaveBeenLastCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(
      (await runtime.listTerminals()).terminals.find((terminal) => terminal.ptyId === 'pty-agent')
    ).toMatchObject({
      handle: 'term_agent',
      orphaned: false,
      tabId: 'tab-agent',
      leafId: HEADLESS_LEAF_ID
    })
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCount + 2)
    expect(listProcesses).toHaveBeenLastCalledWith(undefined, LIST_PROVIDER_DEADLINE)
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_agent',
            ptyId: 'pty-agent',
            incarnationId: 'inc-agent',
            tabId: 'competing-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('preserves concurrent workspace-session changes when async orphan persistence fails', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      flushPendingOrThrowAsync: vi.fn(() => {
        durableWriteStarted.resolve()
        return durableWrite.promise
      })
    } as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          terminalHandle: 'term_async_rollback',
          title: 'Async rollback',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    const adoption = runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      claims: [
        {
          terminal: 'term_async_rollback',
          ptyId: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          tabId: 'tab-async-rollback',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })
    await durableWriteStarted.promise
    setSession({
      ...getSession(),
      activeTabIdByWorktree: {
        ...getSession().activeTabIdByWorktree,
        'concurrent-worktree': 'concurrent-tab'
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(adoption).rejects.toThrow('disk unavailable')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['tab-async-rollback']).toBeUndefined()
    expect(getSession().activeTabIdByWorktree?.['concurrent-worktree']).toBe('concurrent-tab')
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID] ?? 0).toBe(0)
  })

  function publishLegacyWorkerReveal(
    runtime: OrcaRuntimeService,
    identity: { worktreeId: string; tabId: string; leafId: string; ptyId: string },
    title = 'Recovered legacy worker'
  ): { tabId: string; identity: typeof identity } {
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId: identity.tabId,
          worktreeId: identity.worktreeId,
          title,
          activeLeafId: identity.leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: identity.tabId,
          worktreeId: identity.worktreeId,
          leafId: identity.leafId,
          paneRuntimeId: 1,
          ptyId: identity.ptyId
        }
      ]
    })
    return { tabId: identity.tabId, identity }
  }

  it('fences provider resume and reveals one exact live legacy worker without stealing focus', async () => {
    const workerLeafId = HEADLESS_LEAF_ID
    const coordinatorLeafId = HEADLESS_SECOND_LEAF_ID
    const workerPaneKey = `legacy-worker:${workerLeafId}`
    const incarnationId = '22222222-2222-4222-8222-222222222222'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_WORKTREE_ID,
      activeTabId: 'coordinator',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'coordinator' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'coordinator-group' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'coordinator',
            ptyId: 'pty-coordinator',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Coordinator',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        coordinator: makeHeadlessTerminalLayout({
          [coordinatorLeafId]: 'pty-coordinator'
        })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'coordinator-group',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'coordinator',
            tabOrder: ['coordinator']
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const flushOrThrow = vi.fn()
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow } as never, undefined, {
      canRecoverPersistentLocalPtys: () => true,
      attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash }) =>
        paneKey === workerPaneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey, source: 'hydrated_commitment' }
          : null
    })
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-legacy',
          task_id: 'task-legacy',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    const write = vi.fn(() => true)
    const kill = vi.fn(() => true)
    const READY_SCREEN =
      ' >_ OpenAI Codex (v0.131.0)\r\n model:       gpt-5.5 high\r\n directory:   /repo\r\n'
    // Why scrollbackRows-aware: a visible-only request gets the grid in `data`;
    // a scrollback request gets history. Collapsing the two would let a test
    // pass on evidence the caller never asked for.
    const serializeProviderBuffer = vi
      .fn()
      .mockImplementation(async (_ptyId: string, opts?: { scrollbackRows?: number }) => ({
        data: opts?.scrollbackRows === 0 ? READY_SCREEN : '',
        scrollbackAnsi: opts?.scrollbackRows === 0 ? '' : READY_SCREEN,
        cols: 80,
        rows: 24,
        seq: 100,
        source: 'headless' as const,
        alternateScreen: false
      }))
    runtime.setPtyController({
      write,
      kill,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => false,
      serializeProviderBuffer,
      hasPty: (ptyId) => ptyId === 'pty-legacy',
      listProcesses: async () => [
        {
          id: 'pty-legacy',
          incarnationId,
          terminalHandle: 'term_legacy',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(
        runtime,
        {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: workerLeafId,
          ptyId: 'pty-legacy'
        },
        'Legacy worker'
      )
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    runtime.prepareLegacyWorkerTerminalRecovery()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    const recovered = await runtime.reconcileLegacyWorkerTerminals({
      materializeRenderer: true
    })

    expect(recovered).toMatchObject({
      adoptedDispatchIds: ['dispatch-legacy'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().activeTabIdByWorktree?.[TEST_WORKTREE_ID]).toBe('coordinator')
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]?.[0]).toMatchObject({
      activeTabId: 'coordinator',
      tabOrder: ['coordinator', 'legacy-worker']
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-legacy',
      title: 'Legacy worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-worker',
      leafId: workerLeafId,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_legacy',
        incarnationId
      }
    })
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
    expect(write).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    const [terminal] = (await runtime.listTerminals()).terminals
    await expect(runtime.readTerminal(terminal.handle)).resolves.toMatchObject({
      tail: [' >_ OpenAI Codex (v0.131.0)', ' model:       gpt-5.5 high', ' directory:   /repo']
    })
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-legacy', {
      scrollbackRows: 120
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
    // Why: the ready banner stays in scrollback for the whole session, so a
    // working grid must not inherit idleness from its own history (#15569 review).
    serializeProviderBuffer.mockResolvedValueOnce({
      data: '  working on it (12s)\r\n  Esc to interrupt\r\n',
      scrollbackAnsi: READY_SCREEN,
      cols: 80,
      rows: 24,
      seq: 101,
      source: 'headless' as const,
      alternateScreen: false
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
    const lateReadySnapshot = deferred<{
      data: string
      scrollbackAnsi: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }>()
    const snapshotSequence = runtime.getPtyOutputSequence('pty-legacy')
    serializeProviderBuffer.mockImplementationOnce(() => lateReadySnapshot.promise)
    const staleReadyWait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 50
    })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledTimes(4))
    runtime.onPtyData('pty-legacy', '\x1b[H', Date.now())
    lateReadySnapshot.resolve({
      data: READY_SCREEN,
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: snapshotSequence,
      source: 'headless',
      alternateScreen: false
    })
    await expect(staleReadyWait).rejects.toThrow('timeout')
    serializeProviderBuffer.mockResolvedValueOnce({
      data: 'Do you trust this workspace directory?\r\n1. Yes\r\n2. No\r\n',
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: 101,
      source: 'headless' as const,
      alternateScreen: false
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'codex-trust-workspace'
    })
    serializeProviderBuffer.mockImplementationOnce(() => new Promise(() => {}))
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(6)
    // Why args, not counts: the one-shot responses above ignore their options,
    // so only this asserts every idle probe asked for the visible grid alone.
    expect(serializeProviderBuffer.mock.calls.slice(1)).toEqual([
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }]
    ])
    await expect(runtime.readTerminal(terminal.handle)).resolves.toBeDefined()
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(6)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term_legacy',
        paneKey: workerPaneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN
      })
    ).toMatchObject({
      terminalHandle: 'term_legacy',
      paneKey: workerPaneKey,
      processIncarnation: `pty-legacy:${incarnationId}`
    })

    await runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)
    expect(flushOrThrow).toHaveBeenCalled()

    serializeProviderBuffer.mockClear()
    runtime.onPtyExit('pty-legacy', 0, incarnationId)
    runtime.onPtySpawned('pty-legacy', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      awaitsRegistration: false
    })
    const replacementHandle = runtime.createPreAllocatedTerminalHandle()
    runtime.registerPreAllocatedHandleForPty('pty-legacy', replacementHandle)
    await expect(runtime.readTerminal(replacementHandle)).resolves.toMatchObject({ tail: [] })
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('retries renderer reveal before clearing an adopted legacy worker resume fence', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '44444444-4444-4444-8444-444444444444'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-reveal-retry',
          task_id: 'task-reveal-retry',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_reveal_retry',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-reveal-retry:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_reveal_retry'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-reveal-retry',
      listProcesses: async () => [
        {
          id: 'pty-reveal-retry',
          incarnationId,
          terminalHandle: 'term_reveal_retry',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer unavailable'))
      .mockImplementationOnce(() =>
        publishLegacyWorkerReveal(runtime, {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: HEADLESS_LEAF_ID,
          ptyId: 'pty-reveal-retry'
        })
      )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-reveal-retry'],
      deferredDispatchIds: []
    })
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
  })

  function makePostRevealWorkerRecoveryHarness(
    hasPty: (ptyId: string) => boolean | null,
    listProcesses?: () => Promise<
      {
        id: string
        incarnationId: string
        terminalHandle: string
        title: string
        cwd: string
        worktreeId: string
        wslDistro: null
      }[]
    >
  ): {
    runtime: OrcaRuntimeService
    getSession: () => WorkspaceSessionState
    workerPaneKey: string
    ptyId: string
    incarnationId: string
    terminalHandle: string
    kill: ReturnType<typeof vi.fn>
    revealTerminalSession: ReturnType<typeof vi.fn>
    resolveLegacyWorkerTerminalRecovery: ReturnType<typeof vi.fn>
  } {
    const workerPaneKey = `legacy-post-reveal:${HEADLESS_LEAF_ID}`
    const ptyId = 'pty-post-reveal'
    const incarnationId = '45454545-4545-4545-8545-454545454545'
    const terminalHandle = 'term_post_reveal'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-post-reveal',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-post-reveal-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-post-reveal',
          task_id: 'task-post-reveal',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_post_reveal',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_post_reveal'
        }
      ]
    } as unknown as OrchestrationDb)
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill,
      getForegroundProcess: async () => null,
      hasPty,
      listProcesses:
        listProcesses ??
        (async () => [
          {
            id: ptyId,
            incarnationId,
            terminalHandle: 'term_post_reveal',
            title: 'Post-reveal worker',
            cwd: TEST_WORKTREE_PATH,
            worktreeId: TEST_WORKTREE_ID,
            wslDistro: null
          }
        ])
    })
    const revealTerminalSession = vi.fn().mockResolvedValue({
      tabId: 'legacy-post-reveal',
      identity: {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      }
    })
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)
    return {
      runtime,
      getSession,
      workerPaneKey,
      ptyId,
      incarnationId,
      terminalHandle,
      kill,
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    }
  }

  it('keeps a revealed worker fenced until its exact renderer graph is published', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => true)
      const identity = {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      }
      harness.revealTerminalSession.mockResolvedValue({
        tabId: identity.tabId,
        identity
      })

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeDefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()

      harness.runtime.attachWindow(1)
      harness.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            title: 'Post-reveal worker',
            activeLeafId: identity.leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            leafId: identity.leafId,
            paneRuntimeId: 1,
            ptyId: identity.ptyId
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
      expect(
        (await harness.runtime.listTerminals()).terminals.filter(
          (terminal) => terminal.ptyId === identity.ptyId
        )
      ).toEqual([
        expect.objectContaining({
          handle: harness.terminalHandle,
          incarnationId: harness.incarnationId,
          orphaned: false,
          worktreeId: identity.worktreeId,
          tabId: identity.tabId,
          leafId: identity.leafId
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires the exact worker when it exits after renderer reveal', async () => {
    const liveProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)
    harness.revealTerminalSession.mockImplementation(() =>
      publishLegacyWorkerReveal(harness.runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      })
    )

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(
      (
        harness.runtime as unknown as {
          ptysById: Map<string, { connected: boolean; incarnationId?: string }>
        }
      ).ptysById.get(harness.ptyId)
    ).toMatchObject({ connected: false, incarnationId: '45454545-4545-4545-8545-454545454545' })
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('re-reveals a recovered worker after the renderer graph epoch changes', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => false)
      harness.runtime.attachWindow(TEST_WINDOW_ID)
      harness.revealTerminalSession
        .mockResolvedValueOnce({
          tabId: 'legacy-post-reveal',
          identity: {
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'legacy-post-reveal',
            leafId: HEADLESS_LEAF_ID,
            ptyId: harness.ptyId
          }
        })
        .mockImplementationOnce(() =>
          publishLegacyWorkerReveal(harness.runtime, {
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'legacy-post-reveal',
            leafId: HEADLESS_LEAF_ID,
            ptyId: harness.ptyId
          })
        )

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      harness.runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })
      harness.runtime.markRendererReloading(TEST_WINDOW_ID)
      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-post-reveal'],
        deferredDispatchIds: []
      })

      expect(harness.revealTerminalSession).toHaveBeenCalledTimes(2)
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps recovery fenced when the renderer omits the exact reveal identity', async () => {
    const harness = makePostRevealWorkerRecoveryHarness(() => false)
    harness.revealTerminalSession.mockResolvedValue({ tabId: 'legacy-post-reveal' })

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-post-reveal']
    })

    expect(harness.revealTerminalSession).toHaveBeenCalledTimes(2)
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeDefined()
    expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
  })

  it('reconciles a same-id process replacement before headless adoption', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '56565656-5656-4656-8656-565656565656',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)

    await expect(harness.runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'rolled_back',
      harness.ptyId
    )
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('reconciles a same-id process replacement after renderer materialization', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '67676767-6767-4767-8767-676767676767',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)
    harness.revealTerminalSession.mockImplementation(() =>
      publishLegacyWorkerReveal(harness.runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      })
    )

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(harness.getSession().terminalLayoutsByTabId['legacy-post-reveal']).toBeUndefined()
    const runtimeState = harness.runtime as unknown as {
      tabs: Map<string, unknown>
      leaves: Map<string, unknown>
      ptysById: Map<string, { connected: boolean; incarnationId: string | null }>
    }
    expect(runtimeState.tabs.has('legacy-post-reveal')).toBe(false)
    expect([...runtimeState.leaves.keys()].some((key) => key.includes('legacy-post-reveal'))).toBe(
      false
    )
    expect(runtimeState.ptysById.get(harness.ptyId)).toMatchObject({
      connected: true,
      incarnationId: replacement.incarnationId
    })
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'rolled_back',
      harness.ptyId
    )
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('keeps the legacy worker resume fence in memory when persistence fails', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '99999999-9999-4999-8999-999999999999'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    let flushCount = 0
    const flushPendingOrThrowAsync = vi.fn(() => {
      flushCount += 1
      if (flushCount === 1) {
        return Promise.resolve()
      }
      durableWriteStarted.resolve()
      return durableWrite.promise
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-persistence-failure',
          task_id: 'task-persistence-failure',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_persistence_failure',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-persistence-failure:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_persistence_failure'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-persistence-failure',
      listProcesses: async () => [
        {
          id: 'pty-persistence-failure',
          incarnationId,
          terminalHandle: 'term_persistence_failure',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-persistence-failure'
      })
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const recovery = runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    await durableWriteStarted.promise
    const concurrentPaneKey = `concurrent:${HEADLESS_SECOND_LEAF_ID}`
    setSession({
      ...getSession(),
      sleepingAgentSessionsByPaneKey: {
        ...getSession().sleepingAgentSessionsByPaneKey,
        [concurrentPaneKey]: {
          ...session.sleepingAgentSessionsByPaneKey![workerPaneKey]!,
          paneKey: concurrentPaneKey,
          tabId: 'concurrent-tab'
        }
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(recovery).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-persistence-failure']
    })
    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(getSession().sleepingAgentSessionsByPaneKey?.[concurrentPaneKey]?.tabId).toBe(
      'concurrent-tab'
    )
    expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('requeues an active Task before clearing recovery for an authoritatively missing worker', async () => {
    const workerPaneKey = `legacy-missing:${HEADLESS_LEAF_ID}`
    const incarnationId = '32323232-3232-4232-8232-323232323232'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-missing',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-missing-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const flushPendingOrThrowAsync = vi.fn(() => {
      durableWriteStarted.resolve()
      return durableWrite.promise
    })
    const flushOrThrow = vi.fn(() => {
      throw new Error('synchronous persistence must not run')
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'continue after missing worker recovery' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_missing_worker',
        paneKey: workerPaneKey,
        processIncarnation: `pty-missing-worker:${incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        listProcesses: async () => []
      })
      const resolveLegacyWorkerTerminalRecovery = vi.fn()
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)

      const recovery = runtime.reconcileLegacyWorkerTerminals()
      await durableWriteStarted.promise

      expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      durableWrite.resolve()

      await expect(recovery).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [started.dispatch.id],
        deferredDispatchIds: []
      })

      expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()
      expect(flushPendingOrThrowAsync).toHaveBeenCalledWith({
        drainToStableGeneration: false
      })
      expect(flushOrThrow).not.toHaveBeenCalled()
      expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
        status: 'failed',
        failure_count: 1
      })
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('abandoned')
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        workerPaneKey,
        'rolled_back',
        'pty-missing-worker'
      )
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
    } finally {
      db.close()
    }
  })

  it('waits for durability before retry settles a resolution already present in memory', async () => {
    const workerPaneKey = `legacy-missing-retry:${HEADLESS_LEAF_ID}`
    const incarnationId = '34343434-3434-4434-8434-343434343434'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-missing-retry',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-missing-retry-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const firstDurableWrite = deferred<void>()
    const firstDurableWriteStarted = deferred<void>()
    const retryDurableWrite = deferred<void>()
    const retryDurableWriteStarted = deferred<void>()
    let flushCount = 0
    const flushPendingOrThrowAsync = vi.fn(() => {
      flushCount += 1
      if (flushCount === 1) {
        firstDurableWriteStarted.resolve()
        return firstDurableWrite.promise
      }
      retryDurableWriteStarted.resolve()
      return retryDurableWrite.promise
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'retry missing worker recovery' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_missing_retry',
        paneKey: workerPaneKey,
        processIncarnation: `pty-missing-retry:${incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        listProcesses: async () => []
      })
      const resolveLegacyWorkerTerminalRecovery = vi.fn()
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const firstRecovery = runtime.reconcileLegacyWorkerTerminals()
      await firstDurableWriteStarted.promise
      setSession({ ...getSession(), sleepingAgentSessionsByPaneKey: undefined })
      firstDurableWrite.reject(new Error('disk unavailable'))

      await expect(firstRecovery).resolves.toMatchObject({
        exitedDispatchIds: [],
        deferredDispatchIds: [started.dispatch.id]
      })
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      expect(getSession().sleepingAgentSessionsByPaneKey).toBeUndefined()

      const retry = runtime.reconcileLegacyWorkerTerminals()
      await retryDurableWriteStarted.promise
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      retryDurableWrite.resolve()

      await expect(retry).resolves.toMatchObject({
        exitedDispatchIds: [started.dispatch.id],
        deferredDispatchIds: []
      })
      expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('abandoned')
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        workerPaneKey,
        'rolled_back',
        'pty-missing-retry'
      )
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
      warn.mockRestore()
    } finally {
      db.close()
    }
  })

  it('retires provider resume only after authoritative inventory proves the legacy PTY exited', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const secondWorkerPaneKey = `legacy-worker-two:${HEADLESS_SECOND_LEAF_ID}`
    const incarnationId = '33333333-3333-4333-8333-333333333333'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        },
        [secondWorkerPaneKey]: {
          paneKey: secondWorkerPaneKey,
          tabId: 'legacy-worker-two',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session-two' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-exited',
          task_id: 'task-exited',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_exited',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-exited:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_exited'
        },
        {
          dispatch_id: 'dispatch-exited-two',
          task_id: 'task-exited-two',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_exited_two',
          assignee_pane_key: secondWorkerPaneKey,
          process_incarnation: `pty-exited-two:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_exited_two'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async (connectionId?: string | null) => {
      if (connectionId !== null) {
        throw new Error('unrelated SSH inventory must not run')
      }
      return [
        {
          id: 'pty-exited-two',
          incarnationId,
          terminalHandle: 'term_exited_two',
          title: 'Exited worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: () => false,
      listProcesses
    })
    const revealTerminalSession = vi.fn()
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    runtime.prepareLegacyWorkerTerminalRecovery()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-exited-two'],
      exitedDispatchIds: ['dispatch-exited'],
      deferredDispatchIds: []
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[secondWorkerPaneKey]).toBeUndefined()
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'legacy-worker-two', ptyId: 'pty-exited-two' })
    ])
    expect(revealTerminalSession).not.toHaveBeenCalled()
    expect(
      (
        runtime as unknown as {
          ptysById: Map<string, { connected: boolean }>
        }
      ).ptysById.get('pty-exited-two')
    ).toMatchObject({ connected: true })
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(secondWorkerPaneKey, 'adopted')
  })

  it('retries inventory and unknown liveness without revealing a ghost worker', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '55555555-5555-4555-8555-555555555555'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-inventory-unavailable',
          task_id: 'task-inventory-unavailable',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_inventory_unavailable',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-inventory-unavailable:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_inventory_unavailable'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('local provider unavailable'))
      .mockResolvedValue([
        {
          id: 'pty-inventory-unavailable',
          incarnationId,
          terminalHandle: 'term_inventory_unavailable',
          title: 'Recovered legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ])
    const hasPty = vi.fn().mockReturnValueOnce(null).mockReturnValue(true)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty,
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-inventory-unavailable'
      })
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    vi.useFakeTimers()
    try {
      await expect(
        runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-inventory-unavailable']
      })
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
      expect(listProcesses).toHaveBeenCalledOnce()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(revealTerminalSession).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)

      expect(listProcesses).toHaveBeenCalledTimes(4)
      expect(listProcesses.mock.calls.map((call) => call[0])).toEqual([null, null, null, null])
      expect(hasPty).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([
        expect.objectContaining({ id: 'legacy-worker', ptyId: 'pty-inventory-unavailable' })
      ])
      expect(revealTerminalSession).toHaveBeenCalledOnce()
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(listProcesses).toHaveBeenCalledTimes(4)
      expect(revealTerminalSession).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a coalesced SSH worker recovery retry when its provider disconnects', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const reconcile = vi.spyOn(runtime, 'reconcileLegacyWorkerTerminals').mockResolvedValue({
        blockedPaneCount: 1,
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
      const retryInternals = runtime as unknown as {
        updateLegacyWorkerTerminalRecoveryRetry: (
          plan: {
            candidates: { dispatchId: string; ptyId: string }[]
          },
          deferredDispatchIds: ReadonlySet<string>,
          options: { connectionId?: string; materializeRenderer?: boolean }
        ) => void
      }
      const plan = {
        candidates: [
          {
            dispatchId: 'dispatch-ssh-retry',
            ptyId: 'ssh:ssh-retry@@pty-worker'
          }
        ]
      }
      const deferred = new Set(['dispatch-ssh-retry'])

      retryInternals.updateLegacyWorkerTerminalRecoveryRetry(plan, deferred, {
        connectionId: 'ssh-retry',
        materializeRenderer: true
      })
      retryInternals.updateLegacyWorkerTerminalRecoveryRetry(plan, deferred, {
        connectionId: 'ssh-retry',
        materializeRenderer: true
      })
      runtime.notifySshStateChanged('ssh-retry', {
        targetId: 'ssh-retry',
        status: 'disconnected',
        error: null,
        reconnectAttempt: 0
      })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(reconcile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps live workers fenced without exact controller identity evidence', async () => {
    const incarnationId = '56565656-5656-4656-8656-565656565656'
    const cases = [
      {
        name: 'missing',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_missing'
      },
      {
        name: 'ambiguous',
        leafId: '22222222-2222-4222-8222-222222222222',
        terminalHandle: 'term_ambiguous'
      },
      {
        name: 'wrong-handle',
        leafId: '33333333-3333-4333-8333-333333333333',
        terminalHandle: 'term_wrong_handle'
      },
      {
        name: 'wrong-incarnation',
        leafId: '44444444-4444-4444-8444-444444444444',
        terminalHandle: 'term_wrong_incarnation'
      }
    ] as const
    const sleepingAgentSessionsByPaneKey = Object.fromEntries(
      cases.map(({ name, leafId }) => {
        const paneKey = `legacy-${name}:${leafId}`
        return [
          paneKey,
          {
            paneKey,
            tabId: `legacy-${name}`,
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: `session-${name}` },
            prompt: 'continue',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        ]
      })
    ) as WorkspaceSessionState['sleepingAgentSessionsByPaneKey']
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () =>
        cases.map(({ name, leafId, terminalHandle }) => ({
          dispatch_id: `dispatch-${name}`,
          task_id: `task-${name}`,
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: terminalHandle,
          assignee_pane_key: `legacy-${name}:${leafId}`,
          process_incarnation: `pty-${name}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: terminalHandle
        }))
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-missing',
        title: 'Missing identity',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-ambiguous',
        incarnationId,
        terminalHandle: 'term_ambiguous',
        title: 'Ambiguous identity',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-ambiguous-other',
        incarnationId,
        terminalHandle: 'term_ambiguous',
        title: 'Ambiguous identity duplicate',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-wrong-handle',
        incarnationId,
        terminalHandle: 'term_other',
        title: 'Wrong handle',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-wrong-incarnation',
        incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        terminalHandle: 'term_wrong_incarnation',
        title: 'Wrong incarnation',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-wrong-handle', 'dispatch-wrong-incarnation'],
      deferredDispatchIds: ['dispatch-missing', 'dispatch-ambiguous']
    })
    expect(listProcesses).toHaveBeenCalledOnce()
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    for (const { name, leafId } of cases.slice(0, 2)) {
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`legacy-${name}:${leafId}`]
          ?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
    }
    for (const { name, leafId } of cases.slice(2)) {
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`legacy-${name}:${leafId}`]
      ).toBeUndefined()
    }
  })

  it('adopts an exact live legacy worker in a folder workspace', async () => {
    const workerPaneKey = `legacy-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '66666666-6666-4666-8666-666666666666'
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-legacy-worker-folder-'))
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-folder',
          task_id: 'task-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-folder-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_FOLDER_WORKSPACE_KEY,
          agent_terminal_handle: 'term_folder'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-folder-legacy',
        incarnationId,
        terminalHandle: 'term_folder',
        title: 'Folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-folder-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-folder'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-folder-worker',
        ptyId: 'pty-folder-legacy',
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-legacy',
      title: 'Folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_folder',
        incarnationId
      }
    })
  })

  it('adopts an SSH folder legacy worker through its SSH workspace-session partition', async () => {
    const connectionId = 'ssh-folder'
    const ptyId = `ssh:${connectionId}@@pty-folder-legacy`
    const workerPaneKey = `legacy-ssh-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '67676767-6767-4767-8767-676767676767'
    const folderPath = '/srv/platform'
    const sshInitialSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-ssh-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-ssh-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(sshInitialSession)
    const localSession = getDefaultWorkspaceSession()
    let sshSession = sshInitialSession
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? sshSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      sshSession = next
    })
    const folderWorkspace = makeFolderWorkspace({ folderPath, connectionId })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
        getWorkspaceSession,
        setWorkspaceSession,
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-ssh-folder',
          task_id: 'task-ssh-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_ssh_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_FOLDER_WORKSPACE_KEY,
          agent_terminal_handle: 'term_ssh_folder'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_folder',
        title: 'SSH folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === ptyId,
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-ssh-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)
    registerSshFilesystemProvider(connectionId, {
      stat: vi.fn(async () => ({ size: 0, type: 'directory', mtime: 1 }))
    } as never)

    try {
      expect(runtime.prepareLegacyWorkerTerminalRecovery()).toMatchObject({
        blockedPanes: [expect.objectContaining({ paneKey: workerPaneKey })]
      })
      expect(
        sshSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId,
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-ssh-folder'],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
    } finally {
      unregisterSshFilesystemProvider(connectionId)
    }

    expect(sshSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(getWorkspaceSession).toHaveBeenCalledWith(`ssh:${connectionId}`)
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(connectionId, LIST_PROVIDER_DEADLINE)
    expect(sshSession.tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-ssh-folder-worker',
        ptyId,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId,
      title: 'SSH folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-ssh-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_ssh_folder',
        incarnationId
      }
    })
  })

  it('fences an unresolved folder legacy worker in its exact retained session partition', () => {
    const connectionId = 'ssh-unresolved-folder'
    const worktreeId = 'folder:missing-folder'
    const workerPaneKey = `legacy-unresolved-folder-worker:${HEADLESS_LEAF_ID}`
    const remoteInitialSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-unresolved-folder-worker',
          worktreeId,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-unresolved-folder-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const localSession = getDefaultWorkspaceSession()
    let remoteSession = remoteInitialSession
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? remoteSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      remoteSession = next
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getFolderWorkspaces: () => [],
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local', `ssh:${connectionId}`],
      setWorkspaceSession,
      flushOrThrow: vi.fn()
    } as never)
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-unresolved-folder',
          task_id: 'task-unresolved-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_unresolved_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: 'pty-unresolved-folder:68686868-6868-4868-8868-686868686868',
          worker_state: 'ready',
          worktree_id: worktreeId,
          agent_terminal_handle: 'term_unresolved_folder'
        }
      ]
    } as unknown as OrchestrationDb)

    expect(runtime.prepareLegacyWorkerTerminalRecovery()).toMatchObject({
      blockedPanes: [expect.objectContaining({ paneKey: workerPaneKey, worktreeId })]
    })
    expect(
      remoteSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(setWorkspaceSession).toHaveBeenCalledOnce()
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
  })

  it('adopts an SSH legacy worker only after its matching relay is ready', async () => {
    const connectionId = 'ssh-legacy-worker'
    const ptyId = `ssh:${connectionId}@@pty-legacy-worker`
    const workerPaneKey = `legacy-ssh-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '77777777-7777-4777-8777-777777777777'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-ssh-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-ssh-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const localSession = getDefaultWorkspaceSession()
    let sshSession = session
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? sshSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      sshSession = next
    })
    const getSession = (): WorkspaceSessionState => sshSession
    const remoteRepo = {
      ...store.getRepos()[0],
      connectionId
    }
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_legacy',
        title: 'SSH legacy worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ])
    const serializeProviderBuffer = vi.fn().mockResolvedValue(null)
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: ' >_ OpenAI Codex (v0.131.0)\r\n model:       gpt-5.5 high\r\n directory:   /repo\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
        getWorkspaceSession,
        setWorkspaceSession,
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-ssh',
          task_id: 'task-ssh',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_ssh_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_ssh_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === ptyId,
      listProcesses,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => true
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-ssh-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn(async () => [
        {
          path: TEST_WORKTREE_PATH,
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ])
    } as never)

    try {
      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId: 'ssh-wrong-host',
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-ssh']
      })
      expect(listProcesses).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(getWorkspaceSession).toHaveBeenCalledWith(`ssh:${connectionId}`)

      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId,
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-ssh'],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
      expect(listProcesses).toHaveBeenLastCalledWith(connectionId, LIST_PROVIDER_DEADLINE)
    } finally {
      unregisterSshGitProvider(connectionId)
    }

    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId,
      title: 'SSH legacy worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-ssh-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_ssh_legacy',
        incarnationId
      }
    })
    await expect(
      runtime.waitForTerminal('term_ssh_legacy', { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(serializeBuffer).toHaveBeenCalledOnce()
  })

  it('refuses a cross-distro WSL worker and adopts it after exact host ownership matches', async () => {
    setPlatform('win32')
    const workerPaneKey = `legacy-wsl-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '88888888-8888-4888-8888-888888888888'
    let observedDistro = 'Debian'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-wsl-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-wsl-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getProjects: () => [
          {
            id: 'project-wsl',
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
        }),
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-wsl',
          task_id: 'task-wsl',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_wsl_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-wsl-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_wsl_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    // Declares the scope parameter so mock.calls keeps it — the runtime passes a deadline
    // alongside it, and a bare `async () =>` would type the call tuple as empty.
    const listProcesses = vi.fn(async (_connectionId?: string | null) => [
      {
        id: 'pty-wsl-legacy',
        incarnationId,
        terminalHandle: 'term_wsl_legacy',
        title: 'WSL legacy worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: observedDistro
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-wsl-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-wsl-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-wsl-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-wsl']
    })
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(revealTerminalSession).not.toHaveBeenCalled()

    observedDistro = 'Ubuntu'
    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-wsl'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(listProcesses).toHaveBeenCalledTimes(5)
    expect(listProcesses.mock.calls.map((call) => call[0])).toEqual([null, null, null, null, null])
  })

  it('restores orphan pane and group topology without replacing a newer host-owned tab', async () => {
    const session: WorkspaceSessionState = {
      ...makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'terminal-3' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'terminal-3',
              ptyId: 'pty-new',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 3',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 3
            }
          ]
        },
        terminalLayoutsByTabId: {
          'terminal-3': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'pty-new' })
        }
      }),
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-live',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'terminal-3',
            tabOrder: ['terminal-3']
          }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: { type: 'leaf', groupId: 'group-live' }
      },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-live' },
      terminalPtyIncarnationsByPaneKey: {
        [`terminal-3:${HEADLESS_LEAF_ID}`]: 'inc-new'
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-new',
          incarnationId: 'inc-new',
          terminalHandle: 'term_new',
          title: 'Terminal 3',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-agent',
          incarnationId: 'inc-agent',
          terminalHandle: 'term_agent',
          title: 'Claude',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-setup',
          incarnationId: 'inc-setup',
          terminalHandle: 'term_setup',
          title: 'Setup',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-shell',
          incarnationId: 'inc-shell',
          terminalHandle: 'term_shell',
          title: 'Shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-shell',
      activeGroupId: 'group-old-right',
      claims: [
        {
          terminal: 'term_agent',
          ptyId: 'pty-agent',
          incarnationId: 'inc-agent',
          tabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID
        },
        {
          terminal: 'term_setup',
          ptyId: 'pty-setup',
          incarnationId: 'inc-setup',
          tabId: 'tab-agent',
          leafId: HEADLESS_SECOND_LEAF_ID
        },
        {
          terminal: 'term_shell',
          ptyId: 'pty-shell',
          incarnationId: 'inc-shell',
          tabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID
        }
      ],
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.7,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: null
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: HEADLESS_THIRD_LEAF_ID
          }
        ],
        groups: [
          {
            id: 'group-old-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          {
            id: 'group-old-right',
            activeTabId: 'tab-shell',
            tabOrder: ['tab-shell']
          }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-old-left' },
          second: { type: 'leaf', groupId: 'group-old-right' }
        }
      }
    })

    expect(adopted.snapshot.activeGroupId).toBe('group-old-right')
    expect(adopted.snapshot.activeTabId).toBe(`tab-shell::${HEADLESS_THIRD_LEAF_ID}`)
    expect(adopted.snapshot.tabGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'group-live', tabOrder: ['terminal-3'] }),
        expect.objectContaining({ id: 'group-old-left', tabOrder: ['tab-agent'] }),
        expect.objectContaining({ id: 'group-old-right', tabOrder: ['tab-shell'] })
      ])
    )
    expect(adopted.snapshot.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: 'group-live' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.6,
        first: { type: 'leaf', groupId: 'group-old-left' },
        second: { type: 'leaf', groupId: 'group-old-right' }
      }
    })
    expect(getSession().terminalLayoutsByTabId['tab-agent']).toMatchObject({
      root: { type: 'split', direction: 'horizontal', ratio: 0.7 },
      activeLeafId: HEADLESS_SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [HEADLESS_LEAF_ID]: 'pty-agent',
        [HEADLESS_SECOND_LEAF_ID]: 'pty-setup'
      }
    })
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'terminal-3',
      'tab-agent',
      'tab-shell'
    ])
  })

  it('canonicalizes an equivalent persisted worktree key without duplicating terminal topology', async () => {
    const aliasWorktreeId = `${TEST_REPO_ID}::/tmp//worktree-a/`
    const base = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: {
        [`host-tab:${HEADLESS_LEAF_ID}`]: 'inc-alias'
      }
    })
    const session: WorkspaceSessionState = {
      ...base,
      activeTabIdByWorktree: { [aliasWorktreeId]: 'host-tab' },
      tabsByWorktree: {
        [aliasWorktreeId]: base.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          worktreeId: aliasWorktreeId
        }))
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'persisted-pty',
          incarnationId: 'inc-alias',
          terminalHandle: 'term_alias',
          title: 'Alias shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: [
        {
          terminal: 'term_alias',
          ptyId: 'persisted-pty',
          incarnationId: 'inc-alias',
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })

    expect(adopted).toMatchObject({ adopted: true, topologyRevision: 1 })
    expect(adopted.snapshot.worktree).toBe(TEST_WORKTREE_ID)
    expect(Object.keys(getSession().tabsByWorktree)).toContain(TEST_WORKTREE_ID)
    expect(Object.keys(getSession().tabsByWorktree)).not.toContain(aliasWorktreeId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.worktreeId).toBe(TEST_WORKTREE_ID)
    expect(getSession().activeTabIdByWorktree).toEqual({ [TEST_WORKTREE_ID]: 'host-tab' })
  })

  it('keeps current-generation tab and leaf identity across a host restart', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: {
        [`host-tab:${HEADLESS_LEAF_ID}`]: 'inc-current'
      },
      terminalTopologyRevisionByRepoId: { [TEST_REPO_ID]: 4 }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    let connected = true
    const writes: [string, string][] = []
    const resize = vi.fn(() => true)
    const makeRuntime = (): OrcaRuntimeService => {
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      runtime.setPtyController({
        write: (ptyId, data) => {
          writes.push([ptyId, data])
          return true
        },
        resize,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () =>
          connected
            ? [
                {
                  id: 'persisted-pty',
                  incarnationId: 'inc-current',
                  terminalHandle: 'term_current',
                  title: 'Current shell',
                  cwd: TEST_WORKTREE_PATH,
                  worktreeId: TEST_WORKTREE_ID,
                  wslDistro: null
                }
              ]
            : []
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      return runtime
    }

    const originalRuntime = makeRuntime()
    const beforeRestart = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    connected = false
    const disconnected = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    connected = true
    const reconnected = await originalRuntime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const restarted = makeRuntime()
    const afterRestart = await restarted.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const listed = await restarted.listTerminals(`id:${TEST_WORKTREE_ID}`)
    restarted.onPtyData('persisted-pty', 'after restart\n', 1)
    await restarted.sendTerminal('term_current', { text: 'input' })
    await restarted.updateRemoteDesktopViewer('persisted-pty', 'viewer', 'client', 132, 41)

    expect(beforeRestart.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current',
      title: 'Persisted Terminal'
    })
    expect(afterRestart.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current'
    })
    expect(disconnected.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(reconnected.tabs[0]).toMatchObject({
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: 'term_current'
    })
    expect(listed.terminals[0]).toMatchObject({
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-current',
      orphaned: false
    })
    expect(listed.topologyRevisions?.[TEST_WORKTREE_ID]).toBe(4)
    await expect(restarted.readTerminal('term_current')).resolves.toMatchObject({
      tail: ['after restart']
    })
    expect(writes).toEqual([['persisted-pty', 'input']])
    expect(resize).toHaveBeenCalledWith('persisted-pty', 132, 41)
  })

  it('uses topology CAS before a client can claim a still-orphaned PTY', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      terminalTopologyRevisionByRepoId: { [TEST_REPO_ID]: 7 }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-cas',
          incarnationId: 'inc-cas',
          terminalHandle: 'term_cas',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 6,
        claims: [
          {
            terminal: 'term_cas',
            ptyId: 'pty-cas',
            incarnationId: 'inc-cas',
            tabId: 'tab-cas',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_topology_conflict')
  })

  it('keeps orphaned list and show writability aligned with the send gate', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const writes: [string, string][] = []
    runtime.setPtyController({
      write: (ptyId: string, data: string) => {
        writes.push([ptyId, data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-orphan',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    } as never)
    runtime.registerPty('pty-orphan', TEST_WORKTREE_ID)
    runtime.onPtySpawned('pty-orphan', 'inc-orphan', { awaitsRegistration: false })

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const entry = listed.terminals.find((terminal) => terminal.ptyId === 'pty-orphan')
    expect(entry).toMatchObject({ orphaned: true, connected: true, writable: true })

    const shown = await runtime.showTerminal(entry!.handle)
    expect(shown.writable).toBe(true)
    await expect(runtime.sendTerminal(entry!.handle, { text: 'hi' })).resolves.toMatchObject({
      accepted: true
    })
    expect(writes).toEqual([['pty-orphan', 'hi']])
  })

  it('rejects connection mismatch and reused handles while allowing a WSL-owned orphan', async () => {
    const makeRuntime = (): OrcaRuntimeService => {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
      })
      return new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    }
    const ownerMismatch = makeRuntime()
    ownerMismatch.registerPty('pty-wrong-owner', TEST_WORKTREE_ID, 'ssh-other-host')
    ownerMismatch.onPtySpawned('pty-wrong-owner', 'inc-owner', { awaitsRegistration: false })
    ownerMismatch.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-wrong-owner',
          incarnationId: 'inc-owner',
          terminalHandle: 'term_wrong_owner',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    await expect(
      ownerMismatch.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_wrong_owner',
            ptyId: 'pty-wrong-owner',
            incarnationId: 'inc-owner',
            tabId: 'tab-owner',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_owner_mismatch')

    const reusedHandle = makeRuntime()
    for (const [ptyId, incarnationId] of [
      ['pty-first', 'inc-first'],
      ['pty-second', 'inc-second']
    ] as const) {
      reusedHandle.registerPty(ptyId, TEST_WORKTREE_ID)
      reusedHandle.onPtySpawned(ptyId, incarnationId, { awaitsRegistration: false })
    }
    reusedHandle.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-first',
          incarnationId: 'inc-first',
          terminalHandle: 'term_reused',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-second',
          incarnationId: 'inc-second',
          terminalHandle: 'term_reused',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    await expect(
      reusedHandle.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_reused',
            ptyId: 'pty-second',
            incarnationId: 'inc-second',
            tabId: 'tab-second',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')

    await withPlatform('win32', async () => {
      const makeWslRuntime = (reportedWslDistro?: string | null): OrcaRuntimeService => {
        const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
        })
        const wsl = new OrcaRuntimeService({
          ...runtimeStore,
          flushOrThrow: vi.fn(),
          getProjects: () => [
            {
              id: 'project-wsl',
              displayName: 'WSL',
              badgeColor: 'blue',
              sourceRepoIds: [TEST_REPO_ID],
              localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
              createdAt: 1,
              updatedAt: 1
            }
          ],
          getSettings: () => ({
            ...store.getSettings(),
            localWindowsRuntimeDefault: { kind: 'windows-host' }
          })
        } as never)
        wsl.registerPty('pty-wsl', TEST_WORKTREE_ID, null, undefined, true)
        wsl.onPtySpawned('pty-wsl', 'inc-wsl', { awaitsRegistration: false })
        wsl.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          listProcesses: async () => [
            {
              id: 'pty-wsl',
              incarnationId: 'inc-wsl',
              terminalHandle: 'term_wsl',
              title: 'shell',
              cwd: TEST_WORKTREE_PATH,
              worktreeId: TEST_WORKTREE_ID,
              ...(reportedWslDistro !== undefined ? { wslDistro: reportedWslDistro } : {})
            }
          ]
        })
        return wsl
      }
      const request = {
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_wsl',
            ptyId: 'pty-wsl',
            incarnationId: 'inc-wsl',
            tabId: 'tab-wsl',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      }

      await expect(makeWslRuntime('Ubuntu').adoptTerminalOrphans(request)).resolves.toMatchObject({
        adopted: true,
        topologyRevision: 1
      })
      await expect(makeWslRuntime('Debian').adoptTerminalOrphans(request)).rejects.toThrow(
        'terminal_orphan_owner_mismatch'
      )
      await expect(makeWslRuntime().adoptTerminalOrphans(request)).rejects.toThrow(
        'terminal_orphan_owner_mismatch'
      )
    })
  })

  it('preserves legacy pane and group topology without changing host focus', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'other-worktree',
      activeTabId: 'other-tab',
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const processes = [
      ['pty-left', 'inc-left', 'term_left'],
      ['pty-right', 'inc-right', 'term_right'],
      ['pty-shell', 'inc-shell', 'term_shell']
    ] as const
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        processes.map(([id, incarnationId, terminalHandle]) => ({
          id,
          incarnationId,
          terminalHandle,
          title: id,
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }))
    })

    await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-agent',
      activeGroupId: 'group-left',
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: index < 2 ? 'tab-agent' : 'tab-shell',
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      })),
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.35,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: HEADLESS_SECOND_LEAF_ID
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: null
          }
        ],
        groups: [
          {
            id: 'group-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          { id: 'group-right', activeTabId: 'tab-shell', tabOrder: ['tab-shell'] }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      }
    })

    expect(getSession()).toMatchObject({
      activeWorktreeId: 'other-worktree',
      activeTabId: 'other-tab',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'tab-agent' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          { id: 'group-left', activeTabId: 'tab-agent', tabOrder: ['tab-agent'] },
          { id: 'group-right', activeTabId: 'tab-shell', tabOrder: ['tab-shell'] }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: expect.objectContaining({
          type: 'split',
          direction: 'vertical',
          ratio: 0.6
        })
      },
      terminalLayoutsByTabId: {
        'tab-agent': expect.objectContaining({
          root: expect.objectContaining({
            type: 'split',
            direction: 'horizontal',
            ratio: 0.35
          }),
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: HEADLESS_SECOND_LEAF_ID
        })
      }
    })
  })

  it('never lets an old handle adopt a replacement PTY incarnation', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    let process = {
      id: 'reused-pty-id',
      incarnationId: 'inc-old',
      terminalHandle: 'term_old',
      title: 'old',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    }
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [process]
    })
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_old', incarnationId: 'inc-old' })]
    })

    process = { ...process, incarnationId: 'inc-new', terminalHandle: 'term_new', title: 'new' }
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_old',
            ptyId: process.id,
            incarnationId: 'inc-new',
            tabId: 'stale-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_new', incarnationId: 'inc-new' })]
    })
  })

  it('rejects a proposed visual surface occupied by a different PTY', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'occupied-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'occupied',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'occupied-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'visual-pty'
        }
      ]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'orphan-pty',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'orphan',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_orphan',
            ptyId: 'orphan-pty',
            incarnationId: 'inc-orphan',
            tabId: 'occupied-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_surface_occupied')
  })

  it('rejects ambiguous duplicate persisted bindings before idempotence', async () => {
    const duplicateTab = (id: string) => ({
      id,
      ptyId: 'duplicate-pty',
      worktreeId: TEST_WORKTREE_ID,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [duplicateTab('duplicate-a'), duplicateTab('duplicate-b')]
      },
      terminalLayoutsByTabId: {
        'duplicate-a': {
          root: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
          activeLeafId: HEADLESS_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: 'duplicate-pty' }
        },
        'duplicate-b': {
          root: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID },
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_SECOND_LEAF_ID]: 'duplicate-pty' }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`duplicate-a:${HEADLESS_LEAF_ID}`]: 'inc-duplicate',
        [`duplicate-b:${HEADLESS_SECOND_LEAF_ID}`]: 'inc-duplicate'
      }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'duplicate-pty',
          incarnationId: 'inc-duplicate',
          terminalHandle: 'term_duplicate',
          title: 'duplicate',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_duplicate',
            ptyId: 'duplicate-pty',
            incarnationId: 'inc-duplicate',
            tabId: 'duplicate-a',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('does not adopt a discovered terminal handle already bound to another live PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writesByPty = new Map<string, string[]>()
    runtime.setPtyController({
      write: (ptyId, data) => {
        writesByPty.set(ptyId, [...(writesByPty.get(ptyId) ?? []), data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-victim',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        },
        {
          id: 'pty-imposter',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    const handles = listed.terminals.map((terminal) => terminal.handle)
    expect(handles).toContain('term_victim')
    expect(new Set(handles).size).toBe(handles.length)

    await expect(
      runtime.sendTerminal('term_victim', { text: 'for victim' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writesByPty.get('pty-victim')).toEqual(['for victim'])
    expect(writesByPty.has('pty-imposter')).toBe(false)
  })

  it('keeps an already-bound terminal handle when discovery reports a different exported one', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-1',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_from_env'
        }
      ]
    })
    runtime.registerPreAllocatedHandleForPty('pty-1', 'term_already_bound')

    const listed = await runtime.listTerminals()
    expect(listed.terminals[0]?.handle).toBe('term_already_bound')
    await expect(
      runtime.sendTerminal('term_already_bound', { text: 'still routed' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writes).toEqual(['still routed'])
    // the reported-but-not-adopted handle must not resolve to the live pty
    await expect(runtime.readTerminal('term_from_env')).rejects.toThrow()
  })

  it('binds advertised URLs for renderer-restored PTYs that skip registerPty', () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-restored')
    runtime.onPtyData('pty-restored', 'Network: https://restored.example.com:3001/\n', 100)

    expect(advertisedUrlWatcher.lookup(TEST_WORKTREE_ID, 3001)?.origin).toBe(
      'https://restored.example.com:3001'
    )
  })

  it('keeps preallocated terminal handles valid across renderer reloads', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    syncSinglePty(runtime, null)
    runtime.onPtyData('pty-1', 'after reload\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after reload'])
  })

  it('keeps preallocated terminal handles valid when a reload graph omits the live leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after omitted leaf\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after omitted leaf'])
  })

  it('keeps preallocated terminal handles valid after graph unavailable during reload', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markGraphUnavailable(1)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after unavailable\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after unavailable'])
  })

  it('keeps runtime-created PTY handles valid after graph unavailable', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-bg', 'after unavailable\n', 100)

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      tail: ['after unavailable']
    })
    await expect(runtime.sendTerminal(handle, { text: 'still writable' })).resolves.toMatchObject({
      handle,
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('preserves runtime-created PTY process identity after graph unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const incarnation = runtime.getTerminalProcessIncarnation(handle)

    runtime.markGraphUnavailable(1)

    expect(runtime.getTerminalProcessIncarnation(handle)).toBe(incarnation)
  })

  it('preserves PTY process identity while a renderer surface detaches and reattaches', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({
        id: 'pty-bg',
        incarnationId: 'incarnation-bg'
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const [tabId, leafId] = created.paneKey?.split(':') ?? []
    if (!tabId || !leafId) {
      throw new Error('expected stable pane identity')
    }
    const syncSurface = (ptyId: string | null): void => {
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
            ptyId,
            paneTitle: 'Codex'
          }
        ]
      })
    }

    syncSurface('pty-bg')
    await runtime.listTerminals()
    const before = runtime.getTerminalProcessIncarnation(created.handle)
    syncSurface(null)
    syncSurface('pty-bg')
    await runtime.listTerminals()

    expect(runtime.getTerminalProcessIncarnation(created.handle)).toBe(before)

    runtime.registerPty('pty-bg', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      incarnationId: 'incarnation-replacement'
    })
    expect(runtime.getTerminalProcessIncarnation(created.handle)).not.toBe(before)
  })

  it('recognizes runtime-created PTY handles with agent launch titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex package-cache cleanup'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not treat a bare Cursor Agent native title as a running agent session', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Why: the native title is identity, not liveness — Cursor never decorates it, so it
    // reads the same whether cursor-agent is parked or long gone. Sends auto-submit Enter,
    // so identity alone must not unlock one.
    syncSinglePty(runtime, 'pty-1', { tabTitle: 'bash', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('does not authorize an OpenCode marker left on a shell pane', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'OC | zsh' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('authorizes a hookless OpenCode marker with an OpenCode foreground process', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'opencode'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'OC | Native session' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'idle'
    })
  })

  it('does not authorize an OpenCode marker left on a runtime PTY shell', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'OC | zsh'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
  })

  // Why: a leaf with no PTY is the same no-evidence case as an unreadable foreground —
  // nothing was even asked, so the bare title is all that is left. The corroborating
  // foreground here is deliberately unreachable: no ptyId means no read.
  it('does not treat a bare Cursor title as an agent on a leaf with no pty', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    syncSinglePty(runtime, null, { tabTitle: 'bash', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  // Why: a renderer can push the bare title straight onto the pane, skipping the stale
  // clear the other tests drive. Arriving that way it lands on top of a `working` status
  // the spinner left behind, so the pane looks doubly like an agent — and is still just a
  // shell. The tab is left untitled so the bare title is the only evidence in play: the
  // refusal is decided at the foreground, and the stale-status gate is held shut behind it.
  it('does not let a renderer-pushed bare Cursor title revive stale agent status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    syncSinglePty(runtime, 'pty-1', { tabTitle: '' })
    runtime.onPtyData('pty-1', '\x1b]0;⠋ Cursor Agent\x07', 100)
    syncSinglePty(runtime, 'pty-1', { tabTitle: '', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    expect(terminal.title).toBe('Cursor Agent')
    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  // Why: pins the outer catch, not a reachable state — the production controller
  // (src/main/ipc/pty.ts) already normalizes provider failures, a dropped SSH channel
  // included, to null before this sees them. Nothing else here makes the read throw.
  it('does not treat a bare Cursor title as an agent when the foreground read throws', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => {
        throw new Error('ssh channel closed')
      }
    })
    syncSinglePty(runtime, 'pty-1', { tabTitle: '', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  // Why: cursor-agent is a node program, so `node` in the foreground plus a Cursor title
  // looks like corroboration. It is not — the wrapper retry has to resolve a real agent
  // name, and timing out means it never did.
  it('does not treat a bare Cursor title as an agent behind a wrapper foreground', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'node'
      })
      syncSinglePty(runtime, 'pty-1', { tabTitle: '', paneTitle: 'Cursor Agent' })
      const [terminal] = (await runtime.listTerminals()).terminals

      const running = runtime.isTerminalRunningAgent(terminal.handle)
      await vi.advanceTimersByTimeAsync(7_000)
      await expect(running).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recognize runtime-created Claude agents management screens as agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('uses stale runtime-created PTY status when there is no title or foreground evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    runtime.setPtyController(null)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets Claude agents management titles clear stale runtime-created title status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    pty.lastOscTitle = 'claude agents'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not recognize live Claude agents panes from a Claude foreground process', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('lets Claude agents pane titles override stale live-leaf title status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('lets Claude agents OSC titles override stale live-leaf pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not let stale tab-level Claude agents titles suppress current pane activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', {
      tabTitle: 'claude agents',
      paneTitle: 'claude working'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('does not let stale tab-level agent titles override current neutral pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1', {
      tabTitle: 'claude working',
      paneTitle: 'bash'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not let stale live-leaf status override current neutral pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not expose stale live-leaf agent status after Claude agents title supersedes it', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    expect(runtime.getAgentStatusForHandle(terminal.handle)).toBeNull()
  })

  it('lists live terminals with fresh pane titles over stale tab titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
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
          ptyId: 'pty-1',
          paneTitle: 'claude agents'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    expect(terminal.title).toBe('claude agents')
  })

  it('does not let stale Claude agents OSC titles suppress current pane activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('lets adopted pane Claude agents titles override stale PTY-handle activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('lets adopted neutral pane titles override stale PTY-handle activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('lets adopted neutral pane titles use non-shell foreground fallback', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets adopted neutral pane titles retry wrapper foregrounds until recognized', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('does not poll a wrapper foreground for a speculative CLI prompt send', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(
      runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
    ).resolves.toBe(false)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
  })

  it.each(['claude', 'codex'] as const)(
    'authorizes settled CLI prompts only after positive %s foreground identity',
    async (agent) => {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => agent
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
      const [terminal] = (await runtime.listTerminals()).terminals

      await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(true)
    }
  )

  it('keeps a recognized non-target agent on legacy CLI prompt delivery', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'gemini'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(false)
  })

  it('keeps stale Codex launch identity on legacy delivery after the shell returns', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex working',
      launchAgent: 'codex'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
    await expect(runtime.isTerminalRunningSettledPromptAgent(handle)).resolves.toBe(false)
  })

  it('waits for delayed wrapper foreground cache enrichment', async () => {
    const getForegroundProcess = vi.fn(async () => (Date.now() >= 4_000 ? 'codex' : 'node'))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(4_200)

      await expect(result).resolves.toBe(true)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recognize arbitrary foreground TUIs as running agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'vim'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not recognize unresolved wrapper foregrounds as running agents', async () => {
    const getForegroundProcess = vi.fn().mockResolvedValue('node')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    vi.useFakeTimers()
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(7_000)

      await expect(result).resolves.toBe(false)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets live neutral pane titles retry wrapper foregrounds until recognized', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('keeps Claude management titles suppressed after wrapper foreground refreshes', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('claude')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('lets adopted Claude agents pane titles use non-Claude foreground fallback', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('keeps ready prompt evidence when an adopted pane title is neutral', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex working'
    })
    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets adopted pane agent titles override stale PTY Claude agents titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude agents\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude working' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets current Claude agents PTY titles override stale runtime-created OSC titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastOscTitle = 'claude working'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not let stale Claude agents OSC titles suppress current PTY title activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastOscTitle = 'claude agents'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes fresh runtime-created agent OSC titles over stale Claude agents launch titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('keeps Claude agents management evidence when controller refresh reports a Claude process title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      listProcesses: async () => [{ id: 'pty-bg', cwd: TEST_WORKTREE_PATH, title: 'claude' }]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await runtime.getWorktreePs()

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('allows non-Claude foreground agents after preserved Claude agents management evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex',
      listProcesses: async () => [{ id: 'pty-bg', cwd: TEST_WORKTREE_PATH, title: 'zsh' }]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await runtime.getWorktreePs()

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not let stale PTY status override a fresh neutral PTY title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'Claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;Claude working\x07', 100)
    runtime.onPtyData('pty-bg', '\x1b]0;zsh\x07', 101)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not use stale runtime-created PTY status when a neutral PTY title exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'zsh'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    runtime.setPtyController(null)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes ready prompt evidence even with a stale Claude agents title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes runtime-created Codex PTY handles from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes runtime-created Antigravity PTY handles from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData('pty-bg', antigravityReadyScreen(), 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes Antigravity ready tails with the prompt before the model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData('pty-bg', antigravityPromptBeforeModelReadyScreen(), 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes live leaf Antigravity terminals from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
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
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', antigravityReadyScreen(), 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('does not recognize partial Antigravity startup output as an agent', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Gemini 3.5 Flash (High)'
      ].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('rejects a later Antigravity header with a prompt but no model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        antigravityReadyScreen(),
        '\nAntigravity CLI 1.0.4\n',
        'user@example.com (Antigravity Business)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n',
        '>\n'
      ].join(''),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('uses the latest Antigravity header when checking readiness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        antigravityReadyScreen(),
        '\nAntigravity CLI 1.0.4\n',
        'user@example.com (Antigravity Business)\n',
        'Gemini 4 Experimental (High)\n',
        'Do you trust this workspace directory?\n'
      ].join(''),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes Antigravity prompts written as the current partial line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3\n',
        'user@example.com (Antigravity Business)\n',
        'Gemini 3.5 Flash (High)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n'
      ].join(''),
      100
    )
    runtime.onPtyData('pty-bg', '   >   ', 101)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not classify agy workspace paths or titles without the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: '/tmp/agy-workspace',
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
          ptyId: 'pty-1',
          paneTitle: '/tmp/agy-workspace'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'cd /tmp/agy-workspace\n', 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('keeps mobile terminal surfaces visible while their leaf handle is pending', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
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

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('keeps mobile terminal surfaces pending while a live leaf has no PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
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
          ptyId: null,
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

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('selects a visible active pane when terminal visual layout prunes a stale leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const parentLayout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'pane:1' },
        second: { type: 'leaf', leafId: 'pane:2' }
      },
      activeLeafId: 'pane:1',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:2': 'pty-2' }
    }
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Split terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'Live pane'
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
          tabGroups: [
            {
              id: 'group-1',
              activeTabId: 'missing-tab',
              tabOrder: ['missing-tab', 'tab-1']
            }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Stale pane',
              parentLayout,
              isActive: true
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'Live pane',
              parentLayout,
              isActive: false
            }
          ]
        }
      ]
    })

    const result = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(result.visualLayouts).toMatchObject([
      {
        worktreeId: TEST_WORKTREE_ID,
        root: {
          type: 'group',
          activeTabId: 'tab-1',
          tabs: [
            {
              tabId: 'tab-1',
              activeLeafId: 'pane:2',
              panes: {
                type: 'terminal',
                leafId: 'pane:2',
                active: true
              }
            }
          ]
        }
      }
    ])
  })
})
