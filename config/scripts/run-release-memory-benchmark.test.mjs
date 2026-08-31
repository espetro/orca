import { describe, expect, it } from 'vitest'
import {
  abOrder,
  aggregateHeapSnapshotRetainedByConstructor,
  buildReleaseMemoryArtifact,
  buildResourceBenchArtifact,
  classifyCdpTargetRole,
  defaultArtifactPath,
  fixturePreset,
  median,
  parseReleaseMemoryBenchmarkArgs,
  resolveAppExecutable,
  runArtifactPath,
  summarizeRoleRss,
  takeHeapSnapshotSummary
} from './run-release-memory-benchmark.mjs'
import { reapLeftovers } from './bench-process-reap.mjs'
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
    expect(parsed.settleSeconds).toBe(30)
    expect(parsed.windowSeconds).toBe(120)
    expect(parsed.runs).toBe(3)
    expect(parsed.ab).toBeNull()
    expect(parsed.recorder).toBe(true)
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
    expect(custom.windowSeconds).toBe(30)
    expect(custom.out).toBe('/tmp/x.json')
  })

  it('parses v2 args: --window-s alias, settle, no-editor, runs, recorder, ab', () => {
    const parsed = parseReleaseMemoryBenchmarkArgs([
      '--app',
      '/tmp/Orca.app',
      '--window-s',
      '60',
      '--settle-s',
      '5',
      '--no-editor',
      '--runs',
      '4',
      '--no-recorder'
    ])
    expect(parsed.windowSeconds).toBe(60)
    expect(parsed.settleSeconds).toBe(5)
    expect(parsed.fixture).toBe('no-editor')
    expect(parsed.runs).toBe(4)
    expect(parsed.recorder).toBe(false)

    const ab = parseReleaseMemoryBenchmarkArgs([
      '--ab',
      '/tmp/A.app',
      '/tmp/B.app',
      '--runs',
      '3',
      '--recorder'
    ])
    expect(ab.ab).toEqual(['/tmp/A.app', '/tmp/B.app'])
    expect(ab.runs).toBe(3)
    expect(ab.recorder).toBe(true)
  })

  it('rejects missing --app, unknown args, and invalid values', () => {
    expect(() => parseReleaseMemoryBenchmarkArgs([])).toThrow('--app')
    expect(() => parseReleaseMemoryBenchmarkArgs(['--fixture'])).toThrow('Missing value')
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--nope'])).toThrow(
      'Unknown argument'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--duration', 'x'])).toThrow(
      'Invalid --duration/--window-s'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--fixture', 'mega'])).toThrow(
      'Unknown fixture'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--settle-s', '-1'])).toThrow(
      'Invalid --settle-s'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--app', 'a', '--runs', '0'])).toThrow(
      'Invalid --runs'
    )
    expect(() => parseReleaseMemoryBenchmarkArgs(['--ab', '/tmp/A.app'])).toThrow('Missing value')
  })

  it('enforces --runs >= 3 with --ab', () => {
    expect(() =>
      parseReleaseMemoryBenchmarkArgs(['--ab', '/tmp/A.app', '/tmp/B.app', '--runs', '2'])
    ).toThrow('--ab requires --runs >= 3')
    expect(parseReleaseMemoryBenchmarkArgs(['--ab', '/tmp/A.app', '/tmp/B.app']).runs).toBe(3)
  })

  it('orders A/B runs as interleaved A,B,B,A,A,B', () => {
    expect(abOrder(['A', 'B'], 3)).toEqual(['A', 'B', 'B', 'A', 'A', 'B'])
    expect(abOrder(['A', 'B'], 1)).toEqual(['A', 'B'])
    expect(abOrder(['A', 'B'], 2)).toEqual(['A', 'B', 'B', 'A'])
    expect(abOrder(undefined, 3)).toEqual(['A', 'B', 'B', 'A', 'A', 'B'])
  })

  it('builds a v2 resource-bench artifact with fixture/runIndex/dump', () => {
    const dump = {
      schema: 'orca.resource-dump',
      schemaVersion: 1,
      ticks: [],
      markers: [{ timestamp: 1, name: 'fixture-ready' }]
    }
    const artifact = buildResourceBenchArtifact({
      label: 'Orca',
      fixture: 'no-editor',
      runIndex: 2,
      settleSeconds: 30,
      windowSeconds: 120,
      dump,
      externalCrossCheck: { start: { atMs: 1 }, end: { atMs: 2 } },
      heapBoot: { totalSelfBytes: 10 },
      heapIdle: { totalSelfBytes: 20 },
      gitCommit: 'abc123'
    })
    expect(artifact.schema).toBe('orca.resource-bench-run')
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.fixture).toBe('no-editor')
    expect(artifact.runIndex).toBe(2)
    expect(artifact.dump).toBe(dump)
    expect(artifact.externalCrossCheck).toEqual({ start: { atMs: 1 }, end: { atMs: 2 } })
    expect(artifact.gitCommit).toBe('abc123')
    expect(() => buildResourceBenchArtifact({ label: 'x' })).toThrow('dump is required')
  })

  it('builds per-run artifact paths and exposes a no-editor preset', () => {
    expect(runArtifactPath(null, 'Orca', 'A', 0)).toBe(
      join('tests', 'tools', 'benchmarks', 'results', 'run-Orca-A-0.json')
    )
    expect(runArtifactPath('/tmp/out', 'Orca', 'B', 3)).toBe(join('/tmp/out', 'run-Orca-B-3.json'))
    expect(fixturePreset('no-editor')).toEqual({
      terminalPanes: 4,
      editor: false,
      browserTab: false
    })
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

  describe('run lifecycle hardening (orphaned-bench-procs fix)', () => {
    it('degrades heap snapshot failures to null instead of throwing', async () => {
      const failingSession = {
        on: () => undefined,
        send: async () => {
          throw new Error('Target page, context or browser has been closed')
        },
        detach: async () => undefined
      }
      await expect(takeHeapSnapshotSummary(failingSession)).resolves.toBeNull()
    })

    it('reapLeftovers is a no-op on win32 and tolerates empty sweeps', async () => {
      if (process.platform === 'win32') {
        expect(reapLeftovers('C:/x/Orca.app')).toBeUndefined()
        return
      }
      // No matching processes: pgrep exits 1, reapLeftovers must swallow it.
      expect(() => reapLeftovers('/tmp/orca-no-such-marker-8f3/Orca.app')).not.toThrow()
    })

    it('reapLeftovers SIGKILLs stray processes matching the executable basename', async () => {
      if (process.platform === 'win32') {
        return
      }
      const { spawn: nodeSpawn } = await import('node:child_process')
      // argv[0] rewrite makes the sleeper match the marker for pgrep -f.
      const sleeper = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
        argv0: '/tmp/orca-reap-marker/Orca.app'
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      reapLeftovers('/tmp/orca-reap-marker/Orca.app')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      let alive = true
      try {
        process.kill(sleeper.pid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    })
  })
})
