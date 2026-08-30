import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import {
  buildComparisonArtifact,
  compareDumps,
  detectMarkerAlignedSteps,
  detectTrend,
  devianceReport,
  loadDump,
  perMetricStats,
  renderMarkdownReport
} from './resource-metrics-analysis.mjs'

function makeSample(
  type,
  rssBytes,
  { timestamp = 0, footprintBytes = rssBytes, cpuPercent = 1 } = {}
) {
  return { timestamp, pid: 1, type, rssBytes, workingSetKb: null, footprintBytes, cpuPercent }
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
