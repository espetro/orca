import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { join } from 'node:path'
import type { ParsedWarpThemeResult, ParseWarpThemeOptions } from './parser'

export const WARP_THEME_PARSE_TIMEOUT_MS = 1_000
// Why: mirror the STT module's IDLE_WORKER_TEARDOWN_MS so long-running Orca
// sessions release the parser worker heap after a quiet period instead of
// pinning it forever; the next parse respawns a fresh worker on demand.
export const WARP_THEME_PARSER_IDLE_TEARDOWN_MS = 60 * 60 * 1000

type ParseWarpThemeTimeoutOptions = {
  timeoutMs?: number
}

function getParserWorkerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'warp-theme-parser-worker.js')
  }
  return join(__dirname, 'warp-theme-parser-worker.js')
}

function isParsedWarpThemeResult(value: unknown): value is ParsedWarpThemeResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return record.ok === true || record.ok === false
}

type PendingParse = {
  id: number
  settle: (result: ParsedWarpThemeResult) => void
}

type ParserWorkerMessage = {
  id: number
  result: ParsedWarpThemeResult
}

let worker: Worker | null = null
let nextRequestId = 1
const pendingParses = new Map<number, PendingParse>()
let idleTeardownTimer: NodeJS.Timeout | null = null

function clearIdleTeardownTimer(): void {
  if (idleTeardownTimer) {
    clearTimeout(idleTeardownTimer)
    idleTeardownTimer = null
  }
}

function scheduleIdleTeardown(): void {
  clearIdleTeardownTimer()
  idleTeardownTimer = setTimeout(() => {
    void teardownIdleWorker()
  }, WARP_THEME_PARSER_IDLE_TEARDOWN_MS)
  idleTeardownTimer.unref?.()
}

async function teardownIdleWorker(): Promise<void> {
  clearIdleTeardownTimer()
  if (!worker || pendingParses.size > 0) {
    return
  }
  const idleWorker = worker
  worker = null
  idleWorker.removeAllListeners()
  await idleWorker.terminate()
}

function spawnParserWorker(): Worker {
  const spawned = new Worker(getParserWorkerPath())
  spawned.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') {
      return
    }
    const record = message as Partial<ParserWorkerMessage>
    if (typeof record.id !== 'number') {
      return
    }
    const pending = pendingParses.get(record.id)
    if (!pending) {
      return
    }
    pendingParses.delete(record.id)
    pending.settle(
      isParsedWarpThemeResult(record.result)
        ? record.result
        : { ok: false, reason: 'Theme parser returned an invalid result.' }
    )
    scheduleIdleTeardown()
  })
  spawned.once('error', () => {
    failAllPendingParses('Invalid YAML')
  })
  spawned.once('exit', (code) => {
    if (worker === spawned) {
      worker = null
    }
    if (code !== 0) {
      failAllPendingParses('Theme parser exited before returning a result.')
    }
    scheduleIdleTeardown()
  })
  worker = spawned
  return spawned
}

function failAllPendingParses(reason: string): void {
  for (const pending of pendingParses.values()) {
    pending.settle({ ok: false, reason })
  }
  pendingParses.clear()
}

export function parseWarpThemeYamlWithTimeout(
  content: string,
  fileLabel: string,
  options: ParseWarpThemeOptions = {},
  timeoutOptions: ParseWarpThemeTimeoutOptions = {}
): Promise<ParsedWarpThemeResult> {
  return new Promise((resolve) => {
    const activeWorker = worker ?? spawnParserWorker()
    const id = nextRequestId++
    let settled = false
    // Why: callers may shorten the parse timeout (preview budget) but never
    // extend it past the default cap, keeping untrusted-input parse time bounded.
    const timeoutMs = Math.max(
      0,
      Math.min(WARP_THEME_PARSE_TIMEOUT_MS, timeoutOptions.timeoutMs ?? WARP_THEME_PARSE_TIMEOUT_MS)
    )
    const timeout = setTimeout(() => {
      settle({ ok: false, reason: 'Theme file took too long to parse.' })
      // Why: a parse that exceeds its budget may leave the shared worker in an
      // untrusted state, so drop it; the next parse spawns a fresh worker.
      void teardownWorkerNow(activeWorker)
    }, timeoutMs)
    timeout.unref?.()
    clearIdleTeardownTimer()

    function settle(result: ParsedWarpThemeResult): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      pendingParses.delete(id)
      resolve(result)
    }

    pendingParses.set(id, { id, settle })

    // Why: the worker may have been torn down (idle timeout or a prior parse
    // timeout) between spawn and send; guard against posting to a dead thread.
    activeWorker.postMessage({ id, content, fileLabel, options })
  })
}

async function teardownWorkerNow(target: Worker): Promise<void> {
  if (worker === target) {
    worker = null
  }
  clearIdleTeardownTimer()
  target.removeAllListeners()
  failAllPendingParses('Theme parser exited before returning a result.')
  await target.terminate()
}
