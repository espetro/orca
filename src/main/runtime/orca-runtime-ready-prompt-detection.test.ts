import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  antigravityPromptBeforeModelReadyScreen,
  antigravityReadyScreen,
  resetRuntimeTestMocks,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
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
})
