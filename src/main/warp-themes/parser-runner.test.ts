import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const workerState = vi.hoisted(() => ({
  instances: [] as {
    terminated: boolean
    posted: { content?: unknown }[]
    listeners: Map<string, (arg?: unknown) => void>
    emit: (event: string, arg?: unknown) => void
    on: (event: string, listener: (arg?: unknown) => void) => void
    once: (event: string, listener: (arg?: unknown) => void) => void
    postMessage: (message: unknown) => void
    terminate: () => Promise<number>
    removeAllListeners: () => void
  }[]
}))

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('worker_threads', () => ({
  Worker: class MockWorker {
    terminated = false
    posted: { content?: unknown }[] = []
    listeners = new Map<string, (arg?: unknown) => void>()

    once(event: string, listener: (arg?: unknown) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    on(event: string, listener: (arg?: unknown) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    removeAllListeners(): void {
      this.listeners.clear()
    }

    postMessage(message: unknown): void {
      this.posted.push(message as { content?: unknown })
    }

    async terminate(): Promise<number> {
      this.terminated = true
      this.emit('exit', 1)
      return 0
    }

    emit(event: string, arg?: unknown): void {
      this.listeners.get(event)?.(arg)
    }

    constructor(_workerPath: string) {
      workerState.instances.push(this)
    }
  }
}))

import type { ParsedWarpThemeResult } from './parser'
import type * as ParserRunnerModule from './parser-runner'

let parserRunner: typeof ParserRunnerModule

function successResult(name: string): ParsedWarpThemeResult {
  return { ok: true, theme: { name } as ParsedWarpThemeResult extends { ok: true; theme: infer T } ? T : never }
}

async function resolveFirstParse(
  result: ParsedWarpThemeResult,
  instanceIndex = 0
): Promise<void> {
  const worker = workerState.instances[instanceIndex]
  const request = worker?.posted.at(-1) as { id?: number } | undefined
  worker?.emit('message', { id: request?.id, result })
}

describe('parseWarpThemeYamlWithTimeout', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    parserRunner = await import('./parser-runner')
    workerState.instances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function parse(
    content: string,
    fileLabel: string,
    timeoutMs?: number
  ): Promise<ParsedWarpThemeResult> {
    return parserRunner.parseWarpThemeYamlWithTimeout(
      content,
      fileLabel,
      {},
      timeoutMs ? { timeoutMs } : {}
    )
  }

  it('returns worker parser results', async () => {
    const resultPromise = parse('name: Test', 'test.yaml')
    const worker = workerState.instances[0]
    await resolveFirstParse({ ok: false, reason: 'Invalid YAML' })

    await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'Invalid YAML' })
    expect(worker?.terminated).toBe(false)
  })

  it('terminates the worker when parsing exceeds the budget', async () => {
    const resultPromise = parse('name: Slow', 'slow.yaml')
    const worker = workerState.instances[0]

    await vi.advanceTimersByTimeAsync(parserRunner.WARP_THEME_PARSE_TIMEOUT_MS)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: 'Theme file took too long to parse.'
    })
    expect(worker?.terminated).toBe(true)
  })

  it('uses the shorter operation-budget timeout when provided', async () => {
    const resultPromise = parse('name: Slow', 'slow.yaml', 25)
    const worker = workerState.instances[0]

    await vi.advanceTimersByTimeAsync(24)
    expect(worker?.terminated).toBe(false)

    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: 'Theme file took too long to parse.'
    })
    expect(worker?.terminated).toBe(true)
  })

  it('tears down the worker after the idle period', async () => {
    const resultPromise = parse('name: Test', 'test.yaml')
    await resolveFirstParse(successResult('Test'))
    await expect(resultPromise).resolves.toEqual(successResult('Test'))
    expect(workerState.instances[0]?.terminated).toBe(false)

    await vi.advanceTimersByTimeAsync(parserRunner.WARP_THEME_PARSER_IDLE_TEARDOWN_MS - 1)
    expect(workerState.instances[0]?.terminated).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(workerState.instances[0]?.terminated).toBe(true)
  })

  it('respawns a fresh worker on the next parse after idle teardown', async () => {
    const first = parse('name: First', 'first.yaml')
    await resolveFirstParse(successResult('First'))
    await first
    await vi.advanceTimersByTimeAsync(parserRunner.WARP_THEME_PARSER_IDLE_TEARDOWN_MS)
    expect(workerState.instances).toHaveLength(1)

    const second = parse('name: Second', 'second.yaml')
    expect(workerState.instances).toHaveLength(2)
    const respawned = workerState.instances[1]
    expect(respawned?.terminated).toBe(false)
    expect((respawned?.posted[0] as { content?: string })?.content).toBe('name: Second')

    await resolveFirstParse(successResult('Second'), 1)
    await expect(second).resolves.toEqual(successResult('Second'))
  })

  it('keeps the worker alive while idle timers keep resetting across parses', async () => {
    const first = parse('name: First', 'first.yaml')
    await resolveFirstParse(successResult('First'))
    await first

    await vi.advanceTimersByTimeAsync(parserRunner.WARP_THEME_PARSER_IDLE_TEARDOWN_MS / 2)
    const second = parse('name: Second', 'second.yaml')
    await resolveFirstParse(successResult('Second'))
    await second

    await vi.advanceTimersByTimeAsync(parserRunner.WARP_THEME_PARSER_IDLE_TEARDOWN_MS / 2 - 1)
    expect(workerState.instances[0]?.terminated).toBe(false)
    expect(workerState.instances).toHaveLength(1)
  })
})
