# Interface contract: resource-observability chrome (exp/mem-observability)

Shared types all lanes code against. Lanes must match names exactly for merge.

## Types (new file `src/shared/resource-recorder-types.ts`, owner: M1)

```ts
export type ResourceProcessType = 'main' | 'renderer' | 'gpu' | 'utility' | 'zygote' | 'other'

export type ResourceSample = {
  timestamp: number          // epoch ms
  pid: number
  type: ResourceProcessType  // lowercased appMetrics `type`: 'browser'->'main', 'tab'->'renderer'
  rssBytes: number
  workingSetKb: number | null   // from appMetrics memory.workingSetSize
  footprintBytes: number | null // macOS phys_footprint; null = unavailable (never 0)
  cpuPercent: number
}

export type HostContext = {
  availableMemoryBytes: number
  availableMemorySource: string   // reuse HostAvailableMemorySource values
  loadAverage1m: number
  thermal: { cpuSpeedLimitPercent: number | null } | null // null = not darwin / unsupported
  pageinsDelta: number | null   // darwin vm_stat deltas vs previous tick; null elsewhere
  pageoutsDelta: number | null
}

export type ResourceTick = {
  timestamp: number
  samples: ResourceSample[]
  host: HostContext
  mainProcess: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number } | null
}

export type ResourceMarker = { timestamp: number; name: string }

export type ResourceDump = {
  schema: 'orca.resource-dump'
  schemaVersion: 1
  recordedAt: number
  platform: string
  appVersion: string
  appCommit: string | null
  uptimeSeconds: number
  recorderConfig: { tickMs: number; ringCapacity: number; startedAt: number }
  ticks: ResourceTick[]
  markers: ResourceMarker[]
  hostSamples: HostContext[]   // convenience copy, same order as ticks
}

export type ResourceRecorder = {
  start(): void
  stop(): void
  mark(name: string): void
  dump(): ResourceDump
  isRunning(): boolean
}

export function createResourceRecorder(options?: Partial<RecorderOptions>): ResourceRecorder
export type RecorderOptions = {
  tickMs: number              // default 2000
  ringCapacity: number        // default 3600
  now: () => number           // injectable clock, default Date.now
  execFile: child-process execFile injection, default promisified execFile
  getAppMetrics: () => AppProcessMetric[]  // default () => getAppEnvironment().getAppMetrics()
  hostMemory: () => Promise<HostMemory>    // default collectHostMemory
}
```

## Recorder module (owner: M1) — `src/main/metrics/resource-recorder.ts`

- Singleton `startResourceRecorderIfEnabled()` reads env `ORCA_RESOURCE_RECORDER === '1'`; exports `getResourceRecorder(): ResourceRecorder | null`.
- macOS helpers in `src/shared/` (unit-testable, pure string parsers):
  - `parsePsFootprint(stdout: string): Map<number, { rssBytes, footprintBytes }>` — parses `ps -o pid=,rss=,phys_footprint= -p <pids>` (macOS reports phys_footprint in bytes; rss in KB).
  - `parseDarwinThermal(stdout: string): { cpuSpeedLimitPercent: number | null } | null` — parses `pmset -g therm` "CPU_Speed_Limit = 100" style lines.
  - `parseVmStatDeltas(prev, next): { pageinsDelta, pageoutsDelta } | null` — parses `vm_stat` "Page ins: N." lines, computes deltas.
- `ps` batched: ONE execFile per tick for all pids.

## Bridge (owner: M2)

- Renderer e2e bridge lives at `window.__orcaE2E__` (NEW global, NOT window.api). Gated: only installed when `e2eConfig.exposeStore` is true (i.e. VITE_EXPOSE_STORE builds). Add to `src/renderer/src/lib/e2e-config.ts`-adjacent module; install point: after `installWebPreloadApi()` in `src/renderer/src/web/main.tsx` AND equivalent electron preload path if one exists (search `window.api =` in src/preload).
- Shape:
  ```ts
  window.__orcaE2E__ = {
    resources: {
      dump(): Promise<ResourceDump>,   // resolves via recorder.dump(); rejects 'recorder-disabled' if off
      mark(name: string): void
    }
  }
  ```
- Renderer→main: renderer side calls recorder through `window.api` diagnostic bridge ONLY IF existing pattern allows; otherwise the dump is produced in main and delivered via a new one-shot ipc `resources:dump`. Simplest correct: main starts recorder; expose `resources:dump`/`resources:mark` ipc handlers gated on `app.isPackaged === false || ORCA_RESOURCE_RECORDER` env, and web client bridges via `window.api.diagnostics`-style runtime call. M2 owns this decision; keep the surface identical (`__orcaE2E__.resources.dump/mark`).
- Tests live next to bridge code, `*.test.ts`, mock ipc/recorder with vi.mock, mirroring `web-preload-api-composition.test.ts`.

## CLI contract (owner: M3) — `config/scripts/resource-metrics-analysis.mjs`

Exports (pure, for tests + M4):

```js
export function loadDump(jsonOrPath) // accepts object or path string
export function perMetricStats(ticks, role, metric) // -> { median, q1, q3, iqr, p10, p90, min, max, n }
export function detectTrend(samples, { windowMinutes }) // -> { slopeBytesPerMin, monotonic: boolean } (linear regression)
export function detectMarkerAlignedSteps(ticks, markers, thresholdRatio) // -> [{ markerName, before, after, delta }]
export function devianceReport(dump) // -> { flags: [{ kind, detail }], sampleCount, staleTicks }
export function compareDumps(dumpA, dumpB) // -> { metrics: [{ role, metric, a: stats, b: stats, verdict: 'improved'|'regressed'|'inconclusive', deltaMedian }], deviance: { a: devianceReport, b: devianceReport } }
export function renderMarkdownReport(comparison) // deterministic string (sorted keys)
export function buildComparisonArtifact(comparison) // JSON.stringify with sorted keys, 2-space
```

- Metric keys: `<role>.rssBytes`, `<role>.footprintBytes`, `<role>.cpuPercent`, plus `mainProcess.heapUsedBytes`, `host.availableMemoryBytes`.
- Verdict rule: IQRs disjoint → improved (A) / regressed (B) by median direction; else `inconclusive`.
- Deviance flags: `thermal-limit`, `host-degraded-source`, `loadavg-spike`, `snapshot-taken-in-window`, `drift-suspected` (|slope| > 1MB/min), `marker-step`, `stale-samples`, `low-sample-count`.
- CLI: `node config/scripts/resource-metrics-analysis.mjs <dumpA.json> <dumpB.json> [--out report.md] [--json artifact.json]`.
- npm script (M4 adds to package.json on its lane; merge takes M4's): `"bench:compare-memory": "node config/scripts/resource-metrics-analysis.mjs"`.
- Tests: `config/scripts/resource-metrics-analysis.test.mjs` (vitest picks up `config/scripts/**/*.test.mjs`).

## Harness v2 (owner: M4) — extend `config/scripts/run-release-memory-benchmark.mjs` + `.test.mjs`

Start from the w1 version (`orca-mem-worktrees/w1:config/scripts/run-release-memory-benchmark.mjs`, 473 lines; branch exp/mem-obs-m4 is at b3dd46d4 which does NOT have it — `git checkout exp/mem-w1 -- config/scripts/run-release-memory-benchmark.mjs config/scripts/run-release-memory-benchmark.test.mjs` first).

- New args: `--settle-s` (default 30), `--window-s` (default 120, replaces --duration as default path but keep --duration alias), `--no-editor`, `--ab <dumpA> <dumpB>` (order A,B,B,A,A,B), `--runs N` (default 3, enforced ≥3 for --ab), `--recorder` (default on; sets ORCA_RESOURCE_RECORDER=1 in child env).
- Flow per run: spawn (isolated env unchanged + ORCA_RESOURCE_RECORDER=1) → fixture → wait for `window.__orcaE2E__.resources` then `mark('fixture-ready')` → settle → sample window → heap snapshot AFTER window + `mark('snapshot-taken')` → `resources.dump()` → artifact = dump + external ps cross-check (single sweep at window end) + fixture fields (`fixture: 'standard'|'no-editor'`, runIndex, label).
- Drop CDP role classification for metrics (CDP still used for fixture control + heap snapshots).
- Tests: arg parsing, abOrder(['A','B']) === ['A','B','B','A','A','B'], artifact schema (fixture, runIndex, dump present).

## Docs (owner: M5, on m3 lane after M3 lands)

`tests/tools/benchmarks/results/RESOURCE-BENCH-PLAYBOOK.md`. Note `.gitignore:76` ignores `results/*.json` — the plan requires committing raw run JSONs for M6; add a targeted negation (`!tests/tools/benchmarks/results/2026-08-30-resource-*.json`) or a results/resource-validation/ subdir exception when committing artifacts.

## Git / merge discipline

- Lanes: `exp/mem-obs-m1..m4`, worktrees `orca-mem-worktrees/m1..m4`. Each lane commits atomically (conventional commits, no co-author).
- M1 and M2 both touch `ResourceDump` types: M1 owns `src/shared/resource-recorder-types.ts`; M2 must import from there (it will exist after merge; until then declare a local `type` import stub guarded so tests pass: `import type { ResourceDump } from '../../../shared/resource-recorder-types'` — if absent on your lane, create the file with EXACTLY the type block above and M1's version wins at merge).
- Tests scoped to own module paths only.
