import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_WORKTREE_PATH,
  acknowledgeAgentPromptSubmit,
  renderGateCapMs,
  resetRuntimeTestMocks,
  store
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('splits text and enter writes for background terminal handles', async () => {
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
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await runtime.sendTerminal(handle, { text: 'continue', enter: true })

    expect(writes).toEqual(['continue', '\r'])
  })

  it('sends agent prompts as bracketed paste before submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      const prompt = 'line one\nline two\x1b[201~'

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasted = [
        AGENT_PROMPT_BRACKETED_PASTE_START,
        'line one\nline two<ESC>[201~',
        AGENT_PROMPT_BRACKETED_PASTE_END
      ].join('')
      expect(result).toMatchObject({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(`${pasted}\r`, 'utf8')
      })
      expect(writes).toEqual([pasted, '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['claude', 'codex'] as const)(
    'waits for %s composer output frames to settle before one submit',
    async (agent) => {
      vi.useFakeTimers()
      try {
        const writes: string[] = []
        let composerReady = false
        let prematureEnters = 0
        let submissions = 0
        const runtime = new OrcaRuntimeService(store)
        runtime.setPtyController({
          spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
          write: (_ptyId, data) => {
            writes.push(data)
            if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
              setTimeout(() => {
                runtime.onPtyData('pty-bg', 'partial redraw without cursor', Date.now())
              }, 650)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', '\x1b[?2', Date.now())
              }, 750)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', '5h intermediate frame', Date.now())
              }, 751)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', 'continued composer render', Date.now())
              }, 900)
              setTimeout(() => {
                composerReady = true
                runtime.onPtyData('pty-bg', 'final composer frame', Date.now())
              }, 1_000)
            }
            if (data === '\r') {
              if (composerReady) {
                submissions += 1
              } else {
                prematureEnters += 1
              }
              acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
            }
            return true
          },
          kill: () => true,
          getForegroundProcess: async () => null
        })
        const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
          launchAgent: agent
        })
        const assertAuthority = vi.fn()

        const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
          beforeWrite: assertAuthority
        })
        await vi.advanceTimersByTimeAsync(500)

        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(150)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(101)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(1_748)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(1)
        await sendPromise
        expect(prematureEnters).toBe(0)
        expect(submissions).toBe(1)
        expect(writes.filter((data) => data === '\r')).toHaveLength(1)
        expect(assertAuthority).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(
    (Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]).filter(
      (agent) => agent !== 'claude' && agent !== 'codex'
    )
  )('holds Enter for the full open-loop submit delay for %s', async (agent) => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: agent
      })

      const submitDelayMs = getAgentPromptSubmitDelayMs(
        process.platform,
        Buffer.byteLength(buildAgentPromptPasteBytes('review this change'), 'utf8')
      )
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(submitDelayMs - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a foreground Codex prompt when launch metadata has not arrived', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', '\x1b[?25hcomposer rendered', Date.now())
            }, 1_200)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      await expect(runtime.isTerminalRunningSettledPromptAgent(handle)).resolves.toBe(true)
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(1_199)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise

      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits a silent Claude composer once after the bounded render fallback', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(renderGateCapMs('review this change') - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a late Codex render marker a fresh quiescence window', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 7_900)
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', 'final slow composer frame', Date.now())
            }, 8_100)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'codex'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(8_000)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_599)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a Claude render that never settles to one fallback submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 100)
            for (const delay of [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000]) {
              setTimeout(
                () => runtime.onPtyData('pty-bg', `render frame ${delay}`, Date.now()),
                delay
              )
            }
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      // The marker at 100 ms re-arms the cap, but the ingest term is absolute: a prompt this
      // small is already ingested by then, so the fallback is one flat render timeout later.
      await vi.advanceTimersByTimeAsync(100 + 8_000 - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('chunks large agent prompt paste frames before delayed submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = `${'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)}\ntail`

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasteWrites = writes.slice(0, -1)
      expect(result.bytesWritten).toBe(
        Buffer.byteLength(`${buildAgentPromptPasteBytes(prompt)}\r`, 'utf8')
      )
      expect(writes.at(-1)).toBe('\r')
      expect(pasteWrites.length).toBeGreaterThan(1)
      expect(pasteWrites.join('')).toBe(buildAgentPromptPasteBytes(prompt))
      expect(pasteWrites[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(pasteWrites.at(-1)).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes an incomplete agent prompt paste when a later chunk write fails', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let writeCount = 0
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writeCount += 1
          writes.push(data)
          return writeCount !== 2
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      const sendRejection = expect(sendPromise).rejects.toThrow('terminal_not_writable')
      await vi.runAllTimersAsync()

      await sendRejection
      expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(writes.at(-1)).toBe(AGENT_PROMPT_BRACKETED_PASTE_END)
      expect(writes).not.toContain('\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('chunks large terminal.send text before provider writes', async () => {
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
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const text = ['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'].join('')

    const result = await runtime.sendTerminal(handle, { text })

    expect(result).toMatchObject({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(text, 'utf8')
    })
    expect(writes).toEqual(['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'])
  })

  it('yields while validating accepted large terminal.send text before provider writes', async () => {
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
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    vi.useFakeTimers()
    try {
      const sendPromise = runtime.sendTerminal(handle, { text })

      expect(writes).toEqual([])

      await vi.runAllTimersAsync()
      const result = await sendPromise

      expect(result).toMatchObject({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(text, 'utf8')
      })
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.join('')).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized terminal.send text before provider writes', async () => {
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
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await expect(
      runtime.sendTerminal(handle, { text: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) })
    ).rejects.toThrow(TERMINAL_INPUT_TOO_LARGE_ERROR)
    expect(writes).toEqual([])
  })
})
