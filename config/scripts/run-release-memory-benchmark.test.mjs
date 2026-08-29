import { describe, expect, it } from 'vitest'
import {
  aggregateHeapSnapshotRetainedByConstructor,
  buildReleaseMemoryArtifact,
  classifyCdpTargetRole,
  defaultArtifactPath,
  fixturePreset,
  median,
  parseReleaseMemoryBenchmarkArgs,
  resolveAppExecutable,
  summarizeRoleRss
} from './run-release-memory-benchmark.mjs'
import { normalizeBenchmarkArtifact } from './compare-benchmark-artifacts.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function minimalV8Snapshot(entries) {
  // node_fields: type, name, id, self_size → width 4; node_types[0] lists node types.
  const strings = ['(root)']
  const nodes = []
  for (const [name, selfSizeBytes] of entries) {
    nodes.push(1, strings.length, 0, selfSizeBytes)
    strings.push(name)
  }
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size'],
        node_types: [['hidden', 'object', 'string'], 'string', 'number', 'number']
      }
    },
    nodes,
    strings
  }
}

describe('run-release-memory-benchmark helpers', () => {
  it('parses required and optional CLI args with defaults', () => {
    const parsed = parseReleaseMemoryBenchmarkArgs(['--app', '/tmp/Orca.app'])
    expect(parsed.app).toBe('/tmp/Orca.app')
    expect(parsed.fixture).toBe('standard')
    expect(parsed.durationSeconds).toBe(600)
    expect(parsed.cdpPort).toBe(9223)
    expect(parsed.out).toBeNull()

    const custom = parseReleaseMemoryBenchmarkArgs([
      '--app',
      '/tmp/unpacked',
      '--fixture',
      'standard',
      '--duration',
      '30',
      '--out',
      '/tmp/x.json'
    ])
    expect(custom.durationSeconds).toBe(30)
    expect(custom.out).toBe('/tmp/x.json')
  })

  it('rejects missing --app, unknown args, and invalid values', () => {
    expect(() => parseReleaseMemoryBenchmarkArgs([])).toThrow('--app')
    expect(() => parseReleaseMemoryBenchmarkArgs(['--fixture'])).toThrow('Missing value')
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--nope'])).toThrow(
      'Unknown argument'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--duration', 'x'])).toThrow(
      'Invalid --duration'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--fixture', 'mega'])).toThrow(
      'Unknown fixture'
    )
  })

  it('classifies CDP target roles', () => {
    expect(classifyCdpTargetRole({ type: 'page' })).toBe('renderer')
    expect(classifyCdpTargetRole({ type: 'iframe' })).toBe('renderer')
    expect(classifyCdpTargetRole({ type: 'node', title: 'Orca Main' })).toBe('main')
    expect(classifyCdpTargetRole({ type: 'gpu_process' })).toBe('gpu')
    expect(classifyCdpTargetRole({ type: 'service_worker' })).toBe('helper')
    expect(classifyCdpTargetRole({ type: 'browser' })).toBe('helper')
  })

  it('summarizes per-role RSS samples with Bytes-suffixed keys', () => {
    const summary = summarizeRoleRss([
      { roles: { renderer: 100, main: 50 } },
      { roles: { renderer: 300, main: 50 } }
    ])
    expect(summary.rendererRssMedianBytes).toBe(200)
    expect(summary.rendererRssMaxBytes).toBe(300)
    expect(summary.mainRssMedianBytes).toBe(50)
    expect(summary.totalRssMedianBytes).toBe(250)
    expect(summary.sampleCount).toBe(2)
  })

  it('aggregates heap snapshot self-size by constructor', () => {
    const summary = aggregateHeapSnapshotRetainedByConstructor(
      minimalV8Snapshot([
        ['Object', 1_000],
        ['Array', 2_500],
        ['Object', 500]
      ])
    )
    expect(summary.totalSelfBytes).toBe(4_000)
    expect(summary.topConstructors[0]).toEqual({ name: 'Array', selfSizeBytes: 2_500 })
    expect(summary.topConstructors[1]).toEqual({ name: 'Object', selfSizeBytes: 1_500 })
  })

  it('builds a bench:compare-compatible artifact', () => {
    const artifact = buildReleaseMemoryArtifact({
      label: 'baseline',
      options: { app: '/tmp/Orca.app', fixture: 'standard', durationSeconds: 600 },
      rssSummary: summarizeRoleRss([{ roles: { renderer: 1234, main: 567 } }]),
      heapBoot: { totalSelfBytes: 10 },
      heapIdle: { totalSelfBytes: 20 }
    })
    expect(artifact.benchmark).toBe('orca-release-memory')
    expect(artifact.summary.rendererRssMedianBytes).toBe(1234)

    const dir = mkdtempSync(join(tmpdir(), 'orca-release-memory-artifact-'))
    try {
      const artifactPath = join(dir, 'artifact.json')
      writeFileSync(artifactPath, JSON.stringify(artifact))
      const normalized = normalizeBenchmarkArtifact(artifactPath)
      expect(normalized.kind).toBe('summary')
      expect(
        normalized.metrics.find((metric) => metric.key === 'summary.totalRssMedianBytes')
      ).toMatchObject({ unit: 'bytes', value: 1801 })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('resolves app executables per platform and defaults fixture and path helpers', () => {
    expect(resolveAppExecutable('/tmp/Orca.app', 'darwin')).toBe(
      '/tmp/Orca.app/Contents/MacOS/Orca'
    )
    expect(resolveAppExecutable('/tmp/linux-unpacked', 'linux')).toBe('/tmp/linux-unpacked')
    expect(fixturePreset('standard')).toEqual({ terminalPanes: 4, editor: true, browserTab: true })
    expect(fixturePreset('nope')).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([])).toBeNull()
    expect(defaultArtifactPath(new Date('2026-08-29T10:20:30.400Z'))).toBe(
      join('tests', 'tools', 'benchmarks', 'results', 'release-memory-2026-08-29-10-20-30.json')
    )
  })
})
