import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import {
  buildComparisonArtifact,
  compareDumps,
  compareFootprintCategories,
  detectMarkerAlignedSteps,
  detectTrend,
  devianceReport,
  expandPaths,
  loadDump,
  loadDumps,
  mergeDumps,
  parseArgs,
  perCategoryDirtyStats,
  perMetricStats,
  renderMarkdownReport
} from './resource-metrics-analysis.mjs'
// compareFootprintCategories/perCategoryDirtyStats are re-exported above from
// ./footprint-category-comparison.mjs, exercised here via the analysis surface.

function makeSample(
  type,
  rssBytes,
  { timestamp = 0, footprintBytes = rssBytes, cpuPercent = 1, footprintCategories = null } = {}
) {
  return {
    timestamp,
    pid: 1,
    type,
    rssBytes,
    workingSetKb: null,
    footprintBytes,
    footprintCategories,
    cpuPercent
  }
}

function makeTick(index, samples, overrides = {}) {
  return {
    timestamp: 1_000 + index * 2_000,
    samples: samples.map((s) => ({ ...s, timestamp: 1_000 + index * 2_000 })),
    host: {
      availableMemoryBytes: 8e9,
      availableMemorySource: 'purgeable-and-free',
      loadAverage1m: 2,
      thermal: { cpuSpeedLimitPercent: null },
      pageinsDelta: null,
      pageoutsDelta: null
    },
    mainProcess: null,
    ...overrides
  }
}

function makeDump(ticks, overrides = {}) {
  const markers = overrides.markers ?? []
  delete overrides.markers
  return {
    schema: 'orca.resource-dump',
    schemaVersion: 1,
    recordedAt: 0,
    platform: 'darwin',
    appVersion: '1.0.0',
    appCommit: null,
    uptimeSeconds: 60,
    recorderConfig: { tickMs: 2000, ringCapacity: 3600, startedAt: 0 },
    ticks,
    markers,
    hostSamples: ticks.map((t) => t.host),
    ...overrides
  }
}

function constantTicks(n, rssBytes, extra = {}) {
  return Array.from({ length: n }, (_, i) => makeTick(i, [makeSample('renderer', rssBytes)], extra))
}

describe('loadDump', () => {
  it('accepts object input', () => {
    const dump = makeDump([])
    expect(loadDump(dump)).toBe(dump)
  })

  it('accepts a path string', () => {
    const tmp = `${import.meta.dirname}/tmp-load-dump-fixture.json`
    writeFileSync(tmp, JSON.stringify(makeDump(constantTicks(1, 100))))
    expect(loadDump(tmp).schema).toBe('orca.resource-dump')
  })
})

describe('perMetricStats', () => {
  it('computes IQR and percentiles with linear interpolation', () => {
    const ticks = Array.from({ length: 11 }, (_, i) =>
      makeTick(i, [makeSample('renderer', (i + 1) * 100)])
    )
    const stats = perMetricStats(ticks, 'renderer', 'rssBytes')
    expect(stats.n).toBe(11)
    expect(stats.median).toBe(600)
    expect(stats.q1).toBe(350)
    expect(stats.q3).toBe(850)
    expect(stats.iqr).toBe(500)
    expect(stats.p10).toBe(200)
    expect(stats.p90).toBe(1000)
    expect(stats.min).toBe(100)
    expect(stats.max).toBe(1100)
  })

  it('excludes null footprintBytes from n', () => {
    const ticks = [
      makeTick(0, [makeSample('renderer', 100, { footprintBytes: null })]),
      makeTick(1, [makeSample('renderer', 200, { footprintBytes: 220 })])
    ]
    const stats = perMetricStats(ticks, 'renderer', 'footprintBytes')
    expect(stats.n).toBe(1)
    expect(stats.median).toBe(220)
  })

  it('reads mainProcess.heapUsedBytes and host.availableMemoryBytes', () => {
    const ticks = [makeTick(0, [], { mainProcess: { heapUsedBytes: 500 } })]
    expect(perMetricStats(ticks, 'mainProcess', 'heapUsedBytes').median).toBe(500)
    expect(perMetricStats(ticks, 'host', 'availableMemoryBytes').median).toBe(8e9)
  })
})

describe('detectTrend', () => {
  it('computes least-squares slope in bytes/min', () => {
    const samples = Array.from({ length: 7 }, (_, i) => ({
      timestamp: i * 30_000,
      value: 100e6 + i * 10e6
    }))
    const { slopeBytesPerMin, monotonic } = detectTrend(samples)
    expect(slopeBytesPerMin).toBeCloseTo(20e6, -4)
    expect(monotonic).toBe(true)
  })

  it('is not monotonic when deltas change sign (zero deltas allowed)', () => {
    const zigzag = [0, 60, 0, 60].map((s, i) => ({ timestamp: i * 30_000, value: 100e6 + s }))
    expect(detectTrend(zigzag).monotonic).toBe(false)
    const flatish = [0, 0, 60].map((s, i) => ({ timestamp: i * 30_000, value: 100e6 + s }))
    expect(detectTrend(flatish).monotonic).toBe(true)
  })
})

describe('detectMarkerAlignedSteps', () => {
  it('detects a step larger than threshold ratio', () => {
    const ticks = [
      ...Array.from({ length: 5 }, (_, i) => makeTick(i, [makeSample('renderer', 100e6)])),
      ...Array.from({ length: 5 }, (_, i) => makeTick(10 + i, [makeSample('renderer', 150e6)]))
    ]
    const markers = [{ timestamp: ticks[5].timestamp, name: 'open-tab' }]
    const steps = detectMarkerAlignedSteps(ticks, markers, 0.05)
    expect(steps).toHaveLength(1)
    expect(steps[0].markerName).toBe('open-tab')
    expect(steps[0].role).toBe('renderer')
    expect(steps[0].delta).toBe(50e6)
  })

  it('ignores steps below threshold', () => {
    const ticks = [
      ...Array.from({ length: 5 }, (_, i) => makeTick(i, [makeSample('renderer', 100e6)])),
      ...Array.from({ length: 5 }, (_, i) => makeTick(10 + i, [makeSample('renderer', 101e6)]))
    ]
    const markers = [{ timestamp: ticks[5].timestamp, name: 'noop' }]
    expect(detectMarkerAlignedSteps(ticks, markers, 0.05)).toHaveLength(0)
  })
})

describe('devianceReport', () => {
  it('flags thermal-limit when cpu speed limit below 100', () => {
    const ticks = constantTicks(10, 100e6, {
      host: {
        availableMemoryBytes: 8e9,
        availableMemorySource: 'purgeable-and-free',
        loadAverage1m: 2,
        thermal: { cpuSpeedLimitPercent: 70 },
        pageinsDelta: null,
        pageoutsDelta: null
      }
    })
    const report = devianceReport(makeDump(ticks))
    expect(report.flags.some((f) => f.kind === 'thermal-limit')).toBe(true)
  })

  it('flags low-sample-count', () => {
    const report = devianceReport(makeDump(constantTicks(2, 100e6)))
    expect(report.flags.some((f) => f.kind === 'low-sample-count')).toBe(true)
    expect(report.sampleCount).toBe(2)
    expect(report.staleTicks).toBe(0)
  })

  it('flags stale-samples on gaps > 3x median tick interval', () => {
    const ticks = Array.from({ length: 10 }, (_, i) => makeTick(i, [makeSample('renderer', 100e6)]))
    ticks[4].timestamp += 60_000 // gap of 62s vs 2s median
    const report = devianceReport(makeDump(ticks))
    expect(report.staleTicks).toBeGreaterThanOrEqual(1)
    expect(report.flags.some((f) => f.kind === 'stale-samples')).toBe(true)
  })

  it('flags snapshot-taken-in-window marker', () => {
    const ticks = constantTicks(10, 100e6)
    const dump = makeDump(ticks, {
      markers: [{ timestamp: ticks[9].timestamp, name: 'snapshot-taken' }]
    })
    expect(devianceReport(dump).flags.some((f) => f.kind === 'snapshot-taken-in-window')).toBe(true)
  })

  it('flags drift-suspected above 1MB/min', () => {
    const ticks = Array.from({ length: 10 }, (_, i) =>
      makeTick(i, [makeSample('renderer', 100e6 + i * 10e6)])
    )
    const report = devianceReport(makeDump(ticks))
    expect(report.flags.some((f) => f.kind === 'drift-suspected')).toBe(true)
  })

  it('flags loadavg-spike when max > 2x median', () => {
    const ticks = Array.from({ length: 10 }, (_, i) =>
      makeTick(i, [makeSample('renderer', 100e6)], {
        host: {
          availableMemoryBytes: 8e9,
          availableMemorySource: 'purgeable-and-free',
          loadAverage1m: i === 9 ? 10 : 2,
          thermal: { cpuSpeedLimitPercent: null },
          pageinsDelta: null,
          pageoutsDelta: null
        }
      })
    )
    expect(devianceReport(makeDump(ticks)).flags.some((f) => f.kind === 'loadavg-spike')).toBe(true)
  })

  it('flags host-degraded-source on darwin free-memory', () => {
    const ticks = Array.from({ length: 10 }, (_, i) =>
      makeTick(i, [makeSample('renderer', 100e6)], {
        host: {
          availableMemoryBytes: 8e9,
          availableMemorySource: 'free-memory',
          loadAverage1m: 2,
          thermal: { cpuSpeedLimitPercent: null },
          pageinsDelta: null,
          pageoutsDelta: null
        }
      })
    )
    expect(
      devianceReport(makeDump(ticks)).flags.some((f) => f.kind === 'host-degraded-source')
    ).toBe(true)
  })

  it('flags marker-step', () => {
    const ticks = [
      ...Array.from({ length: 5 }, (_, i) => makeTick(i, [makeSample('renderer', 100e6)])),
      ...Array.from({ length: 5 }, (_, i) => makeTick(10 + i, [makeSample('renderer', 150e6)]))
    ]
    const dump = makeDump(ticks, { markers: [{ timestamp: ticks[5].timestamp, name: 'open-tab' }] })
    expect(devianceReport(dump).flags.some((f) => f.kind === 'marker-step')).toBe(true)
  })
})

describe('compareDumps', () => {
  it('verdicts improved when A has disjoint lower IQR', () => {
    const a = makeDump(constantTicks(10, 100e6))
    const b = makeDump(constantTicks(10, 200e6))
    const comparison = compareDumps(a, b)
    const rss = comparison.metrics.find((m) => m.role === 'renderer' && m.metric === 'rssBytes')
    expect(rss.verdict).toBe('improved')
    expect(rss.deltaMedian).toBe(-100e6)
  })

  it('verdicts regressed when A has disjoint upper IQR', () => {
    const a = makeDump(constantTicks(10, 200e6))
    const b = makeDump(constantTicks(10, 100e6))
    const rss = compareDumps(a, b).metrics.find(
      (m) => m.role === 'renderer' && m.metric === 'rssBytes'
    )
    expect(rss.verdict).toBe('regressed')
  })

  it('verdicts inconclusive when IQRs overlap', () => {
    const a = makeDump(
      Array.from({ length: 10 }, (_, i) => makeTick(i, [makeSample('renderer', 100e6 + i * 2e6)]))
    )
    const b = makeDump(
      Array.from({ length: 10 }, (_, i) => makeTick(i, [makeSample('renderer', 105e6 + i * 2e6)]))
    )
    const rss = compareDumps(a, b).metrics.find(
      (m) => m.role === 'renderer' && m.metric === 'rssBytes'
    )
    expect(rss.verdict).toBe('inconclusive')
  })

  it('carries deviance reports for both sides', () => {
    const a = makeDump(constantTicks(10, 100e6))
    const b = makeDump(constantTicks(2, 200e6))
    const { deviance } = compareDumps(a, b)
    expect(deviance.a.flags).toHaveLength(0)
    expect(deviance.b.flags.some((f) => f.kind === 'low-sample-count')).toBe(true)
  })
})

describe('footprint categories', () => {
  const cats = (dirtyByCategory) =>
    Object.entries(dirtyByCategory).map(([category, dirtyBytes]) => ({
      category,
      dirtyBytes,
      cleanBytes: 0,
      reclaimableBytes: 0,
      regions: 1
    }))

  function categoryDump(n, dirtyByCategory, type = 'main') {
    return makeDump(
      Array.from({ length: n }, (_, i) =>
        makeTick(i, [makeSample(type, 100e6, { footprintCategories: cats(dirtyByCategory) })])
      )
    )
  }

  it('perCategoryDirtyStats pools dirty bytes per category', () => {
    const dump = categoryDump(5, { 'JS/V8': 134e6, PartitionAlloc: 82e6 })
    const stats = perCategoryDirtyStats(dump.ticks, 'main')
    expect(stats.get('JS/V8').median).toBe(134e6)
    expect(stats.get('JS/V8').n).toBe(5)
    expect(stats.get('PartitionAlloc').median).toBe(82e6)
  })

  it('verdicts improved when A category dirty bytes are disjointly lower', () => {
    const a = categoryDump(10, { 'JS/V8': 90e6 })
    const b = categoryDump(10, { 'JS/V8': 134e6 })
    const rows = compareFootprintCategories(a, b)
    const v8 = rows.find((r) => r.category === 'JS/V8')
    expect(v8.role).toBe('main')
    expect(v8.verdict).toBe('improved')
    expect(v8.deltaMedian).toBe(-44e6)
  })

  it('is inconclusive when a category is present on only one side', () => {
    const a = categoryDump(10, { 'JS/V8': 90e6, IOSurface: 10e6 })
    const b = categoryDump(10, { 'JS/V8': 90e6 })
    const rows = compareFootprintCategories(a, b)
    expect(rows.find((r) => r.category === 'IOSurface').verdict).toBe('inconclusive')
  })

  it('compareDumps exposes [] and renders no section when no category table exists', () => {
    const comparison = compareDumps(
      makeDump(constantTicks(10, 100e6)),
      makeDump(constantTicks(10, 200e6))
    )
    expect(comparison.footprintCategories).toEqual([])
    expect(renderMarkdownReport(comparison)).not.toContain('Footprint categories')
  })

  it('renders a Footprint categories table when data is present', () => {
    const comparison = compareDumps(
      categoryDump(10, { 'gpu/IOSurface': 60e6 }, 'gpu'),
      categoryDump(10, { 'gpu/IOSurface': 185e6 }, 'gpu')
    )
    const md = renderMarkdownReport(comparison)
    expect(md).toContain('## Footprint categories')
    expect(md).toContain('| gpu | gpu/IOSurface |')
  })
})

describe('determinism', () => {
  it('markdown and JSON artifacts are stable across builds', () => {
    const a = makeDump(constantTicks(10, 100e6))
    const b = makeDump(constantTicks(10, 200e6))
    const first = compareDumps(a, b)
    const second = compareDumps(a, b)
    const json1 = buildComparisonArtifact(first)
    const json2 = buildComparisonArtifact(second)
    expect(json1).toBe(json2)
    expect(renderMarkdownReport(first)).toBe(renderMarkdownReport(second))
    expect(JSON.parse(json1)).toEqual(first)
    // key order is sorted
    const parsedKeys = json1.slice(0, json1.indexOf(':')).trim()
    expect(parsedKeys).toBe('{\n  "deviance"')
  })
})

describe('multi-dump glob pooling', () => {
  const tmpDir = `${import.meta.dirname}/tmp-glob-pooling-fixture`

  function writeRun(name, rssBytes) {
    const path = `${tmpDir}/${name}`
    writeFileSync(path, JSON.stringify(makeDump(constantTicks(10, rssBytes))))
    return path
  }

  function withTmpDir(fn) {
    mkdirSync(tmpDir, { recursive: true })
    try {
      return fn()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  it('expandPaths expands globs to sorted matching files', () => {
    withTmpDir(() => {
      const bPath = writeRun('run-2-b.json', 200e6)
      const aPath = writeRun('run-1-a.json', 100e6)
      expect(expandPaths([`${tmpDir}/run-*-a.json`])).toEqual([aPath])
      expect(expandPaths([`${tmpDir}/run-*.json`])).toEqual([aPath, bPath])
    })
  })

  it('expandPaths errors when a glob matches zero files', () => {
    expect(() => expandPaths(['/nonexistent-dir-xyz/*.json'])).toThrow(/matched no files/)
  })

  it('expandPaths keeps literal paths as-is', () => {
    expect(expandPaths(['some/literal.json'])).toEqual(['some/literal.json'])
  })

  it('parseArgs accepts --a/--b with multiple values and repeated flags', () => {
    const args = parseArgs(['--a', 'a1.json', 'a2.json', '--b', 'b1.json', '--b', 'b2.json'])
    expect(args.dumpAPaths).toEqual(['a1.json', 'a2.json'])
    expect(args.dumpBPaths).toEqual(['b1.json', 'b2.json'])
  })

  it('parseArgs keeps two-positional form and rejects mixing', () => {
    expect(parseArgs(['a.json', 'b.json']).dumpAPaths).toEqual(['a.json'])
    expect(() => parseArgs(['x.json', '--a', 'a.json'])).toThrow(/cannot mix/)
    expect(() => parseArgs(['--a', 'a.json'])).toThrow(/Usage:/)
  })

  it('mergeDumps concatenates ticks and hostSamples across runs', () => {
    const merged = mergeDumps([
      makeDump(constantTicks(2, 100e6)),
      makeDump(constantTicks(3, 100e6))
    ])
    expect(merged.ticks).toHaveLength(5)
    expect(merged.hostSamples).toHaveLength(5)
  })

  it('compareDumps accepts dump arrays and pools stats per side', () => {
    const a1 = makeDump(constantTicks(10, 100e6))
    const a2 = makeDump(constantTicks(10, 120e6))
    const b1 = makeDump(constantTicks(10, 200e6))
    const b2 = makeDump(constantTicks(10, 220e6))
    const rss = compareDumps([a1, a2], [b1, b2]).metrics.find(
      (m) => m.role === 'renderer' && m.metric === 'rssBytes'
    )
    expect(rss.a.n).toBe(20)
    expect(rss.b.n).toBe(20)
    expect(rss.verdict).toBe('improved')
    expect(rss.deltaMedian).toBe(-100e6)
  })

  it('loadDumps unwraps run artifacts and loadDump stays backward compatible', () => {
    withTmpDir(() => {
      const path = `${tmpDir}/artifact.json`
      writeFileSync(
        path,
        JSON.stringify({ schema: 'orca.resource-bench-run', dump: makeDump(constantTicks(1, 100)) })
      )
      const [dump] = loadDumps([path])
      expect(dump.schema).toBe('orca.resource-dump')
    })
  })

  it('pooled A of disjoint runs still wins against pooled B', () => {
    withTmpDir(() => {
      writeRun('run-1-a.json', 90e6)
      writeRun('run-2-a.json', 130e6)
      writeRun('run-1-b.json', 200e6)
      writeRun('run-2-b.json', 240e6)
      const aPaths = expandPaths([`${tmpDir}/run-*-a.json`])
      const bPaths = expandPaths([`${tmpDir}/run-*-b.json`])
      const rss = compareDumps(loadDumps(aPaths), loadDumps(bPaths)).metrics.find(
        (m) => m.role === 'renderer' && m.metric === 'rssBytes'
      )
      expect(rss.a.n).toBe(20)
      expect(rss.verdict).toBe('improved')
    })
  })
})
