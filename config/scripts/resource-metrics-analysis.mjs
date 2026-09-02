// Memory benchmark dump comparison. Lower is better for every compared
// metric (rss/footprint/heap are memory, cpuPercent is load), so an A-side
// median below B-side median counts as 'improved' across the board.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const USAGE =
  'Usage: node config/scripts/resource-metrics-analysis.mjs <dumpA.json> <dumpB.json> ' +
  '[--a <glob-or-path>...] [--b <glob-or-path>...] [--out report.md] [--json artifact.json]'

const ROLES = ['main', 'renderer', 'gpu', 'utility', 'zygote', 'other']
const SAMPLE_METRICS = ['rssBytes', 'footprintBytes', 'cpuPercent', 'workingSetKb']
const DRIFT_THRESHOLD_BYTES_PER_MIN = 1024 * 1024
const MARKER_STEP_RATIO = 0.05
const STALE_TICK_FACTOR = 3
const LOW_SAMPLE_COUNT = 10

export function loadDump(jsonOrPath) {
  const parsed =
    typeof jsonOrPath === 'string'
      ? existsSync(jsonOrPath)
        ? JSON.parse(readFileSync(jsonOrPath, 'utf8'))
        : (() => {
            throw new Error(`dump file not found: ${jsonOrPath}`)
          })()
      : jsonOrPath
  // Accept both a bare ResourceDump and a harness run artifact wrapping one.
  if (parsed?.schema === 'orca.resource-bench-run') {
    if (!parsed.dump) {
      throw new Error('run artifact has no dump (recorder was disabled?)')
    }
    return parsed.dump
  }
  return parsed
}

// Load each path (or inline JSON) into a dump; wraps loadDump.
export function loadDumps(paths) {
  return paths.map((p) => loadDump(p))
}

const GLOB_CHARS = /[*?[]/

function globToRegExp(pattern) {
  const source = pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`)
}

// Expand one shell-style glob (only * and ?) relative to cwd via readdirSync.
function expandGlob(pattern) {
  const absolute = pattern.startsWith('/')
  const parts = pattern.split('/')
  let candidates = [absolute ? '/' : '.']
  for (const part of parts) {
    if (part === '') {
      continue
    }
    if (!GLOB_CHARS.test(part)) {
      candidates = candidates.map((c) => `${c === '.' ? '' : c}/${part}`.replace(/^\/\//, '/'))
      continue
    }
    const re = globToRegExp(part)
    const next = []
    for (const dir of candidates) {
      let entries
      try {
        entries = readdirSync(dir === '.' ? '.' : dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (re.test(entry.name) && !entry.name.startsWith('.')) {
          next.push(`${dir === '/' ? '' : dir}/${entry.name}`)
        }
      }
    }
    candidates = next
  }
  return candidates.filter((c) => {
    try {
      return c !== '/' && c !== '.' && statSync(c).isFile()
    } catch {
      return false
    }
  })
}

// Expand patterns/literals to existing files; literal paths are kept as-is and
// validated by loadDump. Errors when a glob pattern matches nothing.
export function expandPaths(patterns) {
  const expanded = []
  for (const pattern of patterns) {
    if (!GLOB_CHARS.test(pattern)) {
      expanded.push(pattern)
      continue
    }
    const matches = expandGlob(pattern).sort()
    if (matches.length === 0) {
      throw new Error(`glob pattern matched no files: ${pattern}`)
    }
    expanded.push(...matches)
  }
  if (expanded.length === 0) {
    throw new Error('no dump files given')
  }
  return expanded
}

// Pool multiple dumps into one by concatenating time series so medians/IQR
// aggregate over all ticks (median-of-runs via pooled samples).
export function mergeDumps(dumps) {
  if (dumps.length === 1) {
    return dumps[0]
  }
  const mergeBy = (key) => dumps.flatMap((d) => d[key] ?? [])
  return {
    ...dumps[0],
    ticks: mergeBy('ticks'),
    markers: mergeBy('markers'),
    hostSamples: mergeBy('hostSamples')
  }
}

// Linear-interpolation percentile (standard method, R-7).
function percentile(sortedValues, q) {
  if (sortedValues.length === 0) {
    return null
  }
  const pos = (sortedValues.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) {
    return sortedValues[lo]
  }
  return sortedValues[lo] + (pos - lo) * (sortedValues[hi] - sortedValues[lo])
}

function round6(value) {
  return value === null ? null : Math.round(value * 1e6) / 1e6
}

function numericStats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  return {
    median: round6(percentile(sorted, 0.5)),
    q1: round6(q1),
    q3: round6(q3),
    iqr: round6(q3 - q1),
    p10: round6(percentile(sorted, 0.1)),
    p90: round6(percentile(sorted, 0.9)),
    min: round6(sorted[0]),
    max: round6(sorted.at(-1)),
    n: sorted.length
  }
}

export function perMetricStats(ticks, role, metric) {
  if (role === 'mainProcess') {
    const values = ticks
      .map((t) => t.mainProcess?.[metric])
      .filter((v) => v !== null && v !== undefined)
    return numericStats(values)
  }
  if (role === 'host') {
    const values = ticks.map((t) => t.host?.[metric]).filter((v) => v !== null && v !== undefined)
    return numericStats(values)
  }
  const values = []
  for (const tick of ticks) {
    for (const sample of tick.samples ?? []) {
      if (sample.type !== role) {
        continue
      }
      const value = sample[metric]
      // null footprintBytes means unavailable, never zero; exclude from stats
      if (value === null || value === undefined) {
        continue
      }
      values.push(value)
    }
  }
  return numericStats(values)
}

// Least-squares slope of value vs timestamp. Values in bytes -> bytes/min.
export function detectTrend(samples, { windowMinutes } = {}) {
  if (samples.length < 2) {
    return { slopeBytesPerMin: 0, monotonic: false }
  }
  let slice = samples
  if (windowMinutes !== undefined && windowMinutes !== null) {
    const lastTs = samples.at(-1).timestamp
    const cutoff = lastTs - windowMinutes * 60_000
    slice = samples.filter((s) => s.timestamp >= cutoff)
  }
  const n = slice.length
  if (n < 2) {
    return { slopeBytesPerMin: 0, monotonic: false }
  }
  const meanT = slice.reduce((acc, s) => acc + s.timestamp, 0) / n
  const meanV = slice.reduce((acc, s) => acc + s.value, 0) / n
  let num = 0
  let den = 0
  for (const s of slice) {
    num += (s.timestamp - meanT) * (s.value - meanV)
    den += (s.timestamp - meanT) ** 2
  }
  if (den === 0) {
    return { slopeBytesPerMin: 0, monotonic: false }
  }
  // slope per ms -> per minute
  const slope = (num / den) * 60_000
  let monotonic = true
  let sign = 0
  for (let i = 1; i < slice.length; i++) {
    const delta = slice[i].value - slice[i - 1].value
    if (delta === 0) {
      continue
    }
    const currentSign = delta > 0 ? 1 : -1
    if (sign === 0) {
      sign = currentSign
    } else if (currentSign !== sign) {
      monotonic = false
      break
    }
  }
  return { slopeBytesPerMin: round6(slope), monotonic }
}

export function detectMarkerAlignedSteps(ticks, markers, thresholdRatio = MARKER_STEP_RATIO) {
  const results = []
  if (ticks.length === 0) {
    return results
  }
  const roles = new Map()
  for (const tick of ticks) {
    for (const sample of tick.samples ?? []) {
      if (!roles.has(sample.type)) {
        roles.set(sample.type, [])
      }
      roles.get(sample.type).push({ timestamp: sample.timestamp, value: sample.rssBytes })
    }
  }
  for (const marker of markers) {
    for (const [role, samples] of roles) {
      const before = samples.filter((s) => s.timestamp < marker.timestamp)
      const after = samples.filter((s) => s.timestamp >= marker.timestamp)
      if (before.length === 0 || after.length === 0) {
        continue
      }
      const beforeMedian = before.reduce((a, s) => a + s.value, 0) / before.length
      const afterMedian = after.reduce((a, s) => a + s.value, 0) / after.length
      const delta = afterMedian - beforeMedian
      if (Math.abs(delta) > thresholdRatio * beforeMedian) {
        results.push({
          markerName: marker.name,
          role,
          before: round6(beforeMedian),
          after: round6(afterMedian),
          delta: round6(delta)
        })
      }
    }
  }
  results.sort(
    (a, b) =>
      a.markerName.localeCompare(b.markerName) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role)
  )
  return results
}

function median(values) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  return percentile(sorted, 0.5)
}

export function devianceReport(dump) {
  const flags = []
  const ticks = dump.ticks ?? []
  const hostSamples = dump.hostSamples ?? ticks.map((t) => t.host)

  for (const host of hostSamples) {
    const limit = host?.thermal?.cpuSpeedLimitPercent
    if (limit !== null && limit !== undefined && limit < 100) {
      flags.push({ kind: 'thermal-limit', detail: `cpuSpeedLimitPercent=${limit}` })
      break
    }
  }
  for (const host of hostSamples) {
    if (dump.platform === 'darwin' && host?.availableMemorySource === 'free-memory') {
      flags.push({
        kind: 'host-degraded-source',
        detail: 'availableMemorySource=free-memory on darwin'
      })
      break
    }
  }
  const loadavgs = hostSamples
    .map((h) => h?.loadAverage1m)
    .filter((v) => v !== null && v !== undefined)
  const loadavgMedian = median(loadavgs)
  if (loadavgs.length > 0 && loadavgMedian > 0) {
    const max = Math.max(...loadavgs)
    if (max > 2 * loadavgMedian) {
      flags.push({ kind: 'loadavg-spike', detail: `max=${max} median=${loadavgMedian}` })
    }
  }
  if ((dump.markers ?? []).some((m) => m.name === 'snapshot-taken')) {
    flags.push({ kind: 'snapshot-taken-in-window', detail: 'marker snapshot-taken present' })
  }

  for (const role of ROLES) {
    const samples = []
    for (const tick of ticks) {
      for (const sample of tick.samples ?? []) {
        if (sample.type === role) {
          samples.push({ timestamp: sample.timestamp, value: sample.rssBytes })
        }
      }
    }
    if (samples.length === 0) {
      continue
    }
    const trend = detectTrend(samples)
    if (Math.abs(trend.slopeBytesPerMin) > DRIFT_THRESHOLD_BYTES_PER_MIN) {
      flags.push({
        kind: 'drift-suspected',
        detail: `${role}.rssBytes slope=${trend.slopeBytesPerMin} bytes/min`
      })
    }
  }

  const steps = detectMarkerAlignedSteps(ticks, dump.markers ?? [], MARKER_STEP_RATIO)
  for (const step of steps) {
    flags.push({
      kind: 'marker-step',
      detail: `${step.markerName} ${step.role}.rssBytes delta=${step.delta}`
    })
  }

  const timestamps = ticks.map((t) => t.timestamp)
  let staleTicks = 0
  if (timestamps.length > 2) {
    const deltas = []
    for (let i = 1; i < timestamps.length; i++) {
      deltas.push(timestamps[i] - timestamps[i - 1])
    }
    const expected = median(deltas)
    for (const delta of deltas) {
      if (delta > STALE_TICK_FACTOR * expected) {
        staleTicks++
      }
    }
    if (staleTicks > 0) {
      flags.push({
        kind: 'stale-samples',
        detail: `${staleTicks} gaps > ${STALE_TICK_FACTOR}x median tick interval`
      })
    }
  }

  const sampleCount = ticks.reduce((acc, t) => acc + (t.samples?.length ?? 0), 0)
  if (sampleCount < LOW_SAMPLE_COUNT) {
    flags.push({ kind: 'low-sample-count', detail: `sampleCount=${sampleCount}` })
  }

  return { flags, sampleCount, staleTicks }
}

const ROLE_ORDER = new Map(ROLES.map((r, i) => [r, i]))
const METRIC_ORDER = new Map(SAMPLE_METRICS.map((m, i) => [m, i]))
const EXTRA_METRICS = [
  { role: 'mainProcess', metric: 'heapUsedBytes' },
  { role: 'host', metric: 'availableMemoryBytes' }
]

function compareMetric(a, b) {
  // Lower median wins; lower is better for memory and cpu alike (see header).
  if (a.median < b.median) {
    return 'improved'
  }
  return 'regressed'
}

function iqrOverlaps(a, b) {
  return a.q1 <= b.q3 && b.q1 <= a.q3
}

function collectMetricEntries(ticks) {
  const roles = new Set()
  for (const tick of ticks) {
    for (const sample of tick.samples ?? []) {
      roles.add(sample.type)
    }
  }
  const entries = EXTRA_METRICS.filter(({ role }) =>
    ticks.some((t) => (role === 'mainProcess' ? t.mainProcess : t.host))
  )
  for (const role of roles) {
    for (const metric of SAMPLE_METRICS) {
      entries.push({ role, metric })
    }
  }
  entries.sort((x, y) => {
    const roleDiff =
      (ROLE_ORDER.get(x.role) ?? ROLES.length) - (ROLE_ORDER.get(y.role) ?? ROLES.length)
    if (roleDiff !== 0) {
      return roleDiff
    }
    return (
      (METRIC_ORDER.get(x.metric) ?? SAMPLE_METRICS.length) -
      (METRIC_ORDER.get(y.metric) ?? SAMPLE_METRICS.length)
    )
  })
  return entries
}

export function compareDumps(dumpA, dumpB) {
  const a = Array.isArray(dumpA) ? mergeDumps(dumpA) : dumpA
  const b = Array.isArray(dumpB) ? mergeDumps(dumpB) : dumpB
  const entriesA = collectMetricEntries(a.ticks ?? [])
  const entriesB = collectMetricEntries(b.ticks ?? [])
  const keyOf = (e) => `${e.role}.${e.metric}`
  const entries = [...new Map([...entriesA, ...entriesB].map((e) => [keyOf(e), e])).values()]
  entries.sort((x, y) => {
    const roleDiff =
      (ROLE_ORDER.get(x.role) ?? ROLES.length) - (ROLE_ORDER.get(y.role) ?? ROLES.length)
    if (roleDiff !== 0) {
      return roleDiff
    }
    return (
      (METRIC_ORDER.get(x.metric) ?? SAMPLE_METRICS.length) -
      (METRIC_ORDER.get(y.metric) ?? SAMPLE_METRICS.length)
    )
  })

  const metrics = []
  for (const { role, metric } of entries) {
    const statsA = perMetricStats(a.ticks ?? [], role, metric)
    const statsB = perMetricStats(b.ticks ?? [], role, metric)
    if (statsA.n === 0 && statsB.n === 0) {
      continue
    }
    let verdict
    if (statsA.n === 0 || statsB.n === 0) {
      verdict = 'inconclusive'
    } else if (iqrOverlaps(statsA, statsB)) {
      verdict = 'inconclusive'
    } else {
      verdict = compareMetric(statsA, statsB)
    }
    metrics.push({
      role,
      metric,
      a: statsA,
      b: statsB,
      verdict,
      deltaMedian: round6(statsA.median - statsB.median)
    })
  }
  return {
    metrics,
    deviance: { a: devianceReport(a), b: devianceReport(b) }
  }
}

const ROLE_LABELS = { mainProcess: 'main-process', host: 'host' }
const metricLabel = (role, metric) => `${ROLE_LABELS[role] ?? role}.${metric}`

export function renderMarkdownReport(comparison) {
  const lines = []
  lines.push('# Memory benchmark comparison')
  lines.push('')
  lines.push('Lower is better for all metrics (memory bytes and cpu percent).')
  lines.push('')
  lines.push('| metric | a median | b median | delta (a-b) | verdict |')
  lines.push('| --- | --- | --- | --- | --- |')
  const fmt = (v) => (v === null || v === undefined ? 'n/a' : String(v))
  for (const m of comparison.metrics) {
    lines.push(
      `| ${metricLabel(m.role, m.metric)} | ${fmt(m.a.median)} | ${fmt(m.b.median)} | ${fmt(m.deltaMedian)} | ${m.verdict} |`
    )
  }
  lines.push('')
  for (const side of ['a', 'b']) {
    const report = comparison.deviance[side]
    lines.push(`## Deviance (${side})`)
    lines.push('')
    if (report.flags.length === 0) {
      lines.push('No flags.')
    }
    for (const flag of report.flags) {
      lines.push(`- ${flag.kind}: ${flag.detail}`)
    }
    lines.push('')
    lines.push(`samples=${report.sampleCount} staleTicks=${report.staleTicks}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function buildComparisonArtifact(comparison) {
  return stableStringifyIndent(comparison, 0)
}

function stableStringifyIndent(value, depth) {
  const pad = '  '.repeat(depth)
  const padInner = '  '.repeat(depth + 1)
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }
    return `[\n${value.map((v) => `${padInner}${stableStringifyIndent(v, depth + 1)}`).join(',\n')}\n${pad}]`
  }
  const keys = Object.keys(value).sort()
  if (keys.length === 0) {
    return '{}'
  }
  return `{\n${keys.map((k) => `${padInner}${JSON.stringify(k)}: ${stableStringifyIndent(value[k], depth + 1)}`).join(',\n')}\n${pad}}`
}

const FLAG_VALUE_CONSUMERS = new Set(['--out', '--json', '--a', '--b'])

export function parseArgs(argv) {
  const positional = []
  const aPaths = []
  const bPaths = []
  let out = null
  let json = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      out = argv[++i]
    } else if (arg === '--json') {
      json = argv[++i]
    } else if (arg === '--a') {
      while (argv[i + 1] !== undefined && !FLAG_VALUE_CONSUMERS.has(argv[i + 1])) {
        aPaths.push(argv[++i])
      }
    } else if (arg === '--b') {
      while (argv[i + 1] !== undefined && !FLAG_VALUE_CONSUMERS.has(argv[i + 1])) {
        bPaths.push(argv[++i])
      }
    } else {
      positional.push(arg)
    }
  }
  if ((aPaths.length > 0 || bPaths.length > 0) && positional.length > 0) {
    throw new Error('cannot mix positional dump paths with --a/--b flags')
  }
  if (positional.length > 0 && positional.length !== 2) {
    throw new Error(USAGE)
  }
  if (positional.length === 0 && (aPaths.length === 0 || bPaths.length === 0)) {
    throw new Error(USAGE)
  }
  return {
    dumpAPaths: positional.length > 0 ? [positional[0]] : aPaths,
    dumpBPaths: positional.length > 0 ? [positional[1]] : bPaths,
    dumpAPath: positional[0] ?? null,
    dumpBPath: positional[1] ?? null,
    out,
    json
  }
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error.message)
    return 1
  }
  let dumpAPaths
  let dumpBPaths
  try {
    dumpAPaths = expandPaths(args.dumpAPaths)
    dumpBPaths = expandPaths(args.dumpBPaths)
  } catch (error) {
    console.error(error.message)
    return 1
  }
  const comparison = compareDumps(loadDumps(dumpAPaths), loadDumps(dumpBPaths))
  const markdown = renderMarkdownReport(comparison)
  const artifact = buildComparisonArtifact(comparison)
  if (args.out) {
    writeFileSync(args.out, markdown)
  } else {
    console.log(markdown)
  }
  if (args.json) {
    writeFileSync(args.json, `${artifact}\n`)
  }
  return 0
}

// CLI entry: skip when imported by tests
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
