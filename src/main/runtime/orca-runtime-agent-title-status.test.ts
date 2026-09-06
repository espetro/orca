import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_WORKTREE_PATH,
  resetRuntimeTestMocks,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
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
})
