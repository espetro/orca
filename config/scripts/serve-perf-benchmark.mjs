/**
 * Serve-mode performance benchmark: boots the BUILT headless runtime server, measures
 * startup time, resident memory, RPC roundtrip latency, and idle footprint, and writes
 * a machine-readable artifact for per-change comparisons.
 *
 * Complements `runtime-serve-terminal-smoke.mjs`, which asserts correctness; this script
 * measures cost. Run the smoke first if the server has never booted on this checkout.
 *
 * Usage:
 *   pnpm build:electron-vite && node config/scripts/serve-perf-benchmark.mjs
 *   node config/scripts/serve-perf-benchmark.mjs --out .agents/reports/<date>-serve-baseline.json
 *
 * Metrics captured:
 *   - bootMs          ready-payload latency after spawn (time-to-first-ready)
 *   - rssByPid        RSS of every server process tree member at steady state
 *   - rpcP50/P95      wall-clock roundtrip of `worktree list` over N samples
 *   - idleRssAfter5m  RSS after 5 minutes with no client activity
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const projectDir = resolve(import.meta.dirname, '../..')
const serveEntry = join(projectDir, 'out', 'main', 'index.js')
const READY_TIMEOUT_MS = 120_000
const RPC_SAMPLES = Number(process.env.ORCA_BENCH_RPC_SAMPLES ?? '30')
const IDLE_HOLD_MS = Number(process.env.ORCA_BENCH_IDLE_MS ?? '300_000')
const PORT = 6900 + Math.floor(Number(process.env.ORCA_BENCH_PORT_OFFSET ?? '0'))

function log(message) {
  process.stdout.write(`[serve-bench] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[serve-bench] FAIL: ${message}\n`)
  process.exitCode = 1
}

function resolveCli() {
  const built = join(projectDir, 'out', 'cli', 'index.js')
  return existsSync(built)
    ? { command: process.execPath, prefix: [built] }
    : { command: 'orca', prefix: [] }
}

function orca(pairingCode, args, timing) {
  const cli = resolveCli()
  const started = performance.now()
  const result = spawnSync(
    cli.command,
    [...cli.prefix, ...args, '--pairing-code', pairingCode, '--json'],
    {
      encoding: 'utf8',
      shell: false
    }
  )
  const elapsed = performance.now() - started
  if (result.error) {
    throw new Error(`orca ${args[0]} failed to spawn: ${result.error.message}`)
  }
  const line = (result.stdout ?? '').trim()
  if (!line.startsWith('{')) {
    throw new Error(`orca ${args.join(' ')} produced no JSON:\n${result.stdout}\n${result.stderr}`)
  }
  const parsed = JSON.parse(line)
  if (parsed.ok === false) {
    throw new Error(
      `orca ${args.join(' ')} returned ${parsed.error?.code}: ${parsed.error?.message}`
    )
  }
  if (timing) {
    timing.push(elapsed)
  }
  return parsed.result
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = ''
    let serverErr = ''
    const timer = setTimeout(
      () => rejectPromise(new Error(`no ready payload within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      serverErr += chunk
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('{')) {
          continue
        }
        try {
          const payload = JSON.parse(line)
          if (payload.type === 'orca_server_ready') {
            clearTimeout(timer)
            resolvePromise(payload)
            return
          }
        } catch {
          // Partial line; wait for the rest.
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(
        new Error(
          `server exited with ${code} before signalling ready${
            serverErr.trim() ? `:\n${serverErr.trim()}` : ' (no stderr)'
          }`
        )
      )
    })
  })
}

function pairingCodeFrom(payload) {
  const url = payload?.pairing?.url
  if (!url) {
    throw new Error('ready payload carried no pairing offer')
  }
  const code = new URL(url).searchParams.get('code')
  if (!code) {
    throw new Error(`pairing url had no code: ${url}`)
  }
  return code
}

/** Sum of RSS across the server process tree, in bytes. macOS uses ps; Linux uses /proc via ps too. */
function serverTreeRss(rootPid) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', shell: false })
  if (result.status !== 0) {
    throw new Error(`ps failed: ${result.stderr}`)
  }
  const procs = new Map()
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) {
      continue
    }
    procs.set(Number(parts[0]), { ppid: Number(parts[1]), rss: Number(parts[2]) * 1024 })
  }
  const root = procs.get(rootPid)
  if (!root) {
    return null
  }
  let total = root.rss
  for (const [pid, proc] of procs) {
    // Walk ancestors: a proc belongs to the tree if any ancestor is the root.
    let cursor = proc.ppid
    let depth = 0
    while (cursor && depth < 32) {
      if (cursor === rootPid) {
        total += proc.rss
        break
      }
      const parent = procs.get(cursor)
      if (!parent) {
        break
      }
      cursor = parent.ppid
      depth += 1
    }
    void pid
  }
  return total
}

function percentile(samples, fraction) {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[Math.max(0, index)]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'orca-serve-bench-'))
  const serveArgs = [
    serveEntry,
    '--serve',
    '--serve-port',
    String(PORT),
    '--serve-json',
    `--user-data-dir=${userDataDir}`
  ]
  const override = process.env.ORCA_SMOKE_ELECTRON
  const command = override ?? 'npx'
  const args = override ? serveArgs : ['electron', ...serveArgs]

  const bootStart = performance.now()
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORCA_RESOURCE_RECORDER: '1' }
  })
  let pairing = null
  const rpcTimings = []
  const artifact = {
    date: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    port: PORT,
    bootMs: null,
    steadyRssBytes: null,
    steadyRssByPidBytes: null,
    rpcSamples: RPC_SAMPLES,
    rpcP50Ms: null,
    rpcP95Ms: null,
    idleHoldMs: IDLE_HOLD_MS,
    idleRssBytes: null
  }
  try {
    const ready = await waitForReady(child)
    artifact.bootMs = Math.round(performance.now() - bootStart)
    log(`ready in ${artifact.bootMs}ms at ${ready.advertisedEndpoint}`)
    pairing = pairingCodeFrom(ready)

    await sleep(2_000)
    artifact.steadyRssBytes = serverTreeRss(child.pid)
    log(`steady-state tree RSS: ${(artifact.steadyRssBytes / 1024 / 1024).toFixed(1)} MB`)

    for (let i = 0; i < RPC_SAMPLES; i += 1) {
      orca(pairing, ['worktree', 'list'], rpcTimings)
    }
    artifact.rpcP50Ms = Math.round(percentile(rpcTimings, 0.5))
    artifact.rpcP95Ms = Math.round(percentile(rpcTimings, 0.95))
    log(`rpc roundtrip P50=${artifact.rpcP50Ms}ms P95=${artifact.rpcP95Ms}ms`)

    log(`idling ${IDLE_HOLD_MS / 1000}s...`)
    await sleep(IDLE_HOLD_MS)
    artifact.idleRssBytes = serverTreeRss(child.pid)
    log(`idle tree RSS: ${(artifact.idleRssBytes / 1024 / 1024).toFixed(1)} MB`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise((r) => child.on('exit', () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 15_000))
      ])
      if (!exited) {
        child.kill('SIGKILL')
      }
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }

  if (!process.exitCode) {
    const outIndex = process.argv.indexOf('--out')
    const outPath =
      outIndex !== -1
        ? resolve(process.argv[outIndex + 1])
        : join(
            projectDir,
            '.agents',
            'reports',
            `serve-bench-${new Date().toISOString().slice(0, 10)}.json`
          )
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
    log(`wrote ${outPath}`)
    log('PASS')
  }
}

await main()
