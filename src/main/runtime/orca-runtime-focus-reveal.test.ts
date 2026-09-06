import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  resetRuntimeTestMocks,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'

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
})
