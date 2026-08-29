#!/usr/bin/env node
// Packaged-release memory benchmark: launches a built .app (or unpacked dir)
// with --remote-debugging-port, drives a deterministic fixture (terminals +
// editor + browser tab), samples per-process RSS every 2s grouped by CDP
// target role, takes heap snapshot summaries at boot and idle marks, and
// writes a bench:compare-compatible JSON artifact. Sampling-only: never
// mutates app behavior; the app is always killed at the end.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectToApp, waitForStoreReady } from './windows-apphang-repro/electron-dev-session.mjs'
import { classify, descendantsOf, readProcessRows } from './idle-cpu-process-sampling.mjs'

export const DEFAULT_CDP_PORT = 9223
export const DEFAULT_DURATION_SECONDS = 600
export const SAMPLE_INTERVAL_MS = 2_000
export const DEFAULT_FIXTURE = 'standard'

const FIXTURES = {
  standard: { terminalPanes: 4, editor: true, browserTab: true }
}

export function parseReleaseMemoryBenchmarkArgs(argv) {
  const options = {
    app: null,
    fixture: DEFAULT_FIXTURE,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    cdpPort: DEFAULT_CDP_PORT,
    out: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      index += 1
      return value
    }
    if (arg === '--') {
      continue
    } else if (arg === '--app') {
      options.app = readValue()
    } else if (arg === '--fixture') {
      options.fixture = readValue()
    } else if (arg === '--duration') {
      options.durationSeconds = Number(readValue())
    } else if (arg === '--cdp-port') {
      options.cdpPort = Number(readValue())
    } else if (arg === '--out') {
      options.out = readValue()
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new Error(`Invalid --duration: ${options.durationSeconds}`)
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) {
    throw new Error(`Invalid --cdp-port: ${options.cdpPort}`)
  }
  if (!FIXTURES[options.fixture]) {
    throw new Error(
      `Unknown fixture: ${options.fixture} (available: ${Object.keys(FIXTURES).join(', ')})`
    )
  }
  if (!options.app) {
    throw new Error('--app <path-to-.app-or-unpacked-dir> is required')
  }
  return options
}

function printUsage() {
  console.log(
    `Usage: node config/scripts/run-release-memory-benchmark.mjs --app <path> [options]

Options:
  --app <path>        Path to a packaged .app bundle or unpacked release dir (required)
  --fixture <name>    Fixture preset (default: ${DEFAULT_FIXTURE}; available: ${Object.keys(FIXTURES).join(', ')})
  --duration <secs>   Idle sampling window in seconds (default: ${DEFAULT_DURATION_SECONDS})
  --cdp-port <port>   Remote debugging port (default: ${DEFAULT_CDP_PORT})
  --out <path>        Artifact JSON path (default: tests/tools/benchmarks/results/release-memory-<timestamp>.json)
  -h, --help          Show this help`
  )
}

export function fixturePreset(name) {
  return FIXTURES[name] ?? null
}

// Group a CDP /json list target into main/renderer/gpu/helper by its type and url.
export function classifyCdpTargetRole(target) {
  const type = String(target?.type ?? '')
  const url = String(target?.url ?? '')
  const title = String(target?.title ?? '')
  if (type === 'page' || type === 'iframe') {
    return 'renderer'
  }
  if (type === 'node' || /orca.*(main|electron)/i.test(`${title} ${url}`)) {
    return 'main'
  }
  if (type === 'gpu_process' || url.includes('gpu')) {
    return 'gpu'
  }
  if (type === 'service_worker' || type === 'shared_worker') {
    return 'helper'
  }
  return 'helper'
}

export function median(values) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

// samples: [{ atMs, roles: { renderer: bytes, main: bytes, ... } }] → per-role
// median/mean plus a grand total. Keys end in Bytes so bench:compare units work.
export function summarizeRoleRss(samples) {
  const roles = new Map()
  for (const sample of samples) {
    for (const [role, bytes] of Object.entries(sample.roles ?? {})) {
      if (!Number.isFinite(bytes)) {
        continue
      }
      const list = roles.get(role) ?? []
      list.push(bytes)
      roles.set(role, list)
    }
  }
  const summary = {}
  let totalMedian = 0
  for (const [role, values] of [...roles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const roleMedian = median(values)
    summary[`${role}RssMedianBytes`] = roleMedian
    summary[`${role}RssMaxBytes`] = Math.max(...values)
    totalMedian += roleMedian ?? 0
  }
  summary.totalRssMedianBytes = totalMedian
  summary.sampleCount = samples.length
  return summary
}

// Aggregate a V8 heap snapshot (already-parsed object with snapshot.meta +
// nodes + strings) into total heap size plus self-size per constructor.
export function aggregateHeapSnapshotRetainedByConstructor(snapshot, topN = 10) {
  const meta = snapshot?.snapshot?.meta
  const nodes = snapshot?.nodes
  const strings = snapshot?.strings
  if (!Array.isArray(nodes) || !Array.isArray(strings) || !meta?.node_fields) {
    throw new Error('Invalid V8 heap snapshot: missing nodes/strings/meta')
  }
  const fields = meta.node_fields
  const fieldTypes = meta.node_types ?? []
  const typeIndex = fields.indexOf('type')
  const nameIndex = fields.indexOf('name')
  const selfSizeIndex = fields.indexOf('self_size')
  const nodeWidth = fields.length
  const objectTypeIndex = Array.isArray(fieldTypes[typeIndex])
    ? fieldTypes[typeIndex].indexOf('object')
    : -1
  const byConstructor = new Map()
  let totalSelfBytes = 0
  for (let offset = 0; offset + nodeWidth <= nodes.length; offset += nodeWidth) {
    if (objectTypeIndex !== -1 && nodes[offset + typeIndex] !== objectTypeIndex) {
      continue
    }
    const selfBytes = nodes[offset + selfSizeIndex] ?? 0
    totalSelfBytes += selfBytes
    const name = strings[nodes[offset + nameIndex]] ?? '(unknown)'
    byConstructor.set(name, (byConstructor.get(name) ?? 0) + selfBytes)
  }
  const topConstructors = [...byConstructor.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topN)
    .map(([name, selfSizeBytes]) => ({ name, selfSizeBytes }))
  return { totalSelfBytes, nodeWidth, topConstructors }
}

// Shape the final bench:compare artifact. `summary` must only contain finite
// numbers — compare-benchmark-artifacts.mjs flattens it into `summary.*` keys
// and infers 'bytes' units from the Bytes suffix.
export function buildReleaseMemoryArtifact({
  label,
  createdAt = new Date().toISOString(),
  options,
  rssSummary,
  heapBoot,
  heapIdle,
  platform = { platform: process.platform, arch: process.arch, cpus: os.cpus().length }
}) {
  if (rssSummary == null) {
    throw new Error('rssSummary is required')
  }
  return {
    label,
    createdAt,
    benchmark: 'orca-release-memory',
    options: { ...options },
    platform,
    summary: { ...rssSummary },
    heap: {
      boot: heapBoot ?? null,
      idle: heapIdle ?? null
    }
  }
}

export function defaultArtifactPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)
  return path.join(
    'tests',
    'tools',
    'benchmarks',
    'results',
    `release-memory-${stamp}.json`
  )
}

export function resolveAppExecutable(appPath, platform = process.platform) {
  if (platform === 'darwin' && appPath.endsWith('.app')) {
    const appName = path.basename(appPath, '.app')
    return path.join(appPath, 'Contents', 'MacOS', appName)
  }
  if (platform === 'win32') {
    const exe = path.join(appPath, `${path.basename(appPath)}.exe`)
    return existsSync(exe) ? exe : appPath
  }
  return appPath
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchCdpTargets(cdpPort, timeoutMs = 60_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        if (Array.isArray(targets) && targets.length > 0) {
          return targets
        }
      }
    } catch {}
    await sleep(500)
  }
  throw new Error(`Timed out waiting for CDP targets on port ${cdpPort}`)
}

// One RSS sample: classify app processes from `ps` (ppid chain rooted at the
// root pid) into roles, then add CDP /json/list targets whose role labels the
// ps-based renderer/other split cannot distinguish.
export function sampleRssSnapshot(rootPid, targets = []) {
  const rows = readProcessRows()
  const procs = descendantsOf(rows, rootPid)
  const roles = {}
  for (const proc of procs) {
    const role = classify(proc, rootPid)
    if (role !== 'other-descendant') {
      roles[role] = (roles[role] ?? 0) + proc.rssBytes
    }
  }
  // Refine renderer/other split using CDP target roles (page targets map to
  // renderer processes; service workers to helpers).
  for (const target of targets) {
    const cdpRole = classifyCdpTargetRole(target)
    if (cdpRole === 'renderer' || cdpRole === 'helper') {
      roles[`cdp-${cdpRole}-target-count`] = (roles[`cdp-${cdpRole}-target-count`] ?? 0) + 1
    }
  }
  return { atMs: Date.now(), pid: rootPid, roles }
}

async function sampleRssLoop(rootPid, cdpPort, durationSeconds) {
  const samples = []
  const deadline = Date.now() + durationSeconds * 1_000
  while (Date.now() < deadline) {
    const targets = await fetchCdpTargets(cdpPort, 10_000).catch(() => [])
    samples.push(sampleRssSnapshot(rootPid, targets))
    await sleep(SAMPLE_INTERVAL_MS)
  }
  return samples
}

// HeapProfiler.takeHeapSnapshot streams chunked JSON; assemble, then aggregate
// retained/self size by constructor. reportProgress off keeps it one-shot.
export async function takeHeapSnapshotSummary(cdpSession, { topN = 10 } = {}) {
  const chunks = []
  cdpSession.on('HeapProfiler.addHeapSnapshotChunk', (event) => {
    chunks.push(event.chunk)
  })
  await cdpSession.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  const snapshot = JSON.parse(chunks.join(''))
  const summary = aggregateHeapSnapshotRetainedByConstructor(snapshot, topN)
  return { takenAt: new Date().toISOString(), ...summary }
}

// Deterministic fixture via the app runtime client surface (window.api +
// __store), same approach as terminal-cold-park-resource-bench: open N terminal
// panes, an editor, and a browser tab, waiting for each to register in the store.
async function applyFixture(page, preset) {
  return page.evaluate(async (config) => {
    const store = window.__store
    if (!store) {
      return { applied: false, error: 'store-unavailable' }
    }
    const state = store.getState()
    const opened = { terminals: 0, editor: false, browserTab: false }
    for (let index = 0; index < config.terminalPanes; index += 1) {
      const result = await state.openTerminal?.()
      if (result !== false) {
        opened.terminals += 1
      }
    }
    if (config.editor) {
      const result = await state.openEditor?.()
      opened.editor = result !== false
    }
    if (config.browserTab) {
      const result = await state.openBrowserTab?.()
      opened.browserTab = result !== false
    }
    return { applied: true, ...opened }
  }, preset)
}

async function main() {
  const options = parseReleaseMemoryBenchmarkArgs(process.argv.slice(2))
  const executable = resolveAppExecutable(options.app)
  if (!existsSync(executable)) {
    throw new Error(`App executable not found: ${executable}`)
  }
  const artifactPath = options.out ?? defaultArtifactPath()
  console.log(
    `[release-memory] app=${executable} fixture=${options.fixture} duration=${options.durationSeconds}s cdp=${options.cdpPort}`
  )
  const child = spawn(executable, [`--remote-debugging-port=${options.cdpPort}`], {
    stdio: 'ignore',
    detached: false
  })
  const rootPid = child.pid
  let bootHeapSummary = null
  let idleHeapSummary = null
  let fixtureState = null
  let samples = []
  try {
    await fetchCdpTargets(options.cdpPort, 120_000)
    const browser = await connectToApp(options.cdpPort)
    const context = browser.contexts()[0]
    const page = context?.pages()[0]
    if (!page) {
      throw new Error('No renderer page available over CDP')
    }
    await waitForStoreReady(page)
    const cdpSession = await context.newCDPSession(page)
    bootHeapSummary = await takeHeapSnapshotSummary(cdpSession)
    fixtureState = await applyFixture(page, fixturePreset(options.fixture))
    console.log(`[release-memory] fixture ${JSON.stringify(fixtureState)}`)
    samples = await sampleRssLoop(rootPid, options.cdpPort, options.durationSeconds)
    idleHeapSummary = await takeHeapSnapshotSummary(cdpSession)
    const artifact = buildReleaseMemoryArtifact({
      label: path.basename(options.app),
      options: { ...options, app: options.app },
      rssSummary: summarizeRoleRss(samples),
      heapBoot: bootHeapSummary,
      heapIdle: idleHeapSummary
    })
    mkdirSync(path.dirname(path.resolve(artifactPath)), { recursive: true })
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(`[release-memory] wrote ${artifactPath}`)
  } finally {
    child.kill('SIGTERM')
    await sleep(250)
    if (child.exitCode === null) {
      child.kill('SIGKILL')
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
