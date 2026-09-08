import type { AppProcessMetric } from './app-environment'
import type { HostMemory } from './process-stats-types'

export type ResourceProcessType = 'main' | 'renderer' | 'gpu' | 'utility' | 'zygote' | 'other'

export type ResourceSample = {
  timestamp: number
  pid: number
  /** Lowercased appMetrics `type`: 'browser'->'main', 'tab'->'renderer'. */
  type: ResourceProcessType
  rssBytes: number
  /** From appMetrics memory.workingSetSize (KB as reported, kept in KB units). */
  workingSetKb: number | null
  /** macOS phys_footprint; null = unavailable (never 0). */
  footprintBytes: number | null
  cpuPercent: number
}

export type HostContext = {
  availableMemoryBytes: number
  /** Reuses HostAvailableMemorySource values. */
  availableMemorySource: string
  loadAverage1m: number
  /** null = not darwin / unsupported. */
  thermal: { cpuSpeedLimitPercent: number | null } | null
  /** darwin vm_stat deltas vs previous tick; null elsewhere. */
  pageinsDelta: number | null
  pageoutsDelta: number | null
}

export type ResourceTick = {
  timestamp: number
  samples: ResourceSample[]
  host: HostContext
  mainProcess: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
  } | null
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
  /** Convenience copy, same order as ticks. */
  hostSamples: HostContext[]
}

export type ResourceRecorder = {
  start(): void
  stop(): void
  mark(name: string): void
  dump(): ResourceDump
  isRunning(): boolean
}

/** Structural promise-based execFile so callers can avoid importing node:child_process. */
export type ExecFileFn = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

export type RecorderOptions = {
  tickMs: number
  ringCapacity: number
  now: () => number
  execFile: ExecFileFn
  getAppMetrics: () => AppProcessMetric[]
  hostMemory: () => Promise<HostMemory>
}
/** Implemented in src/main/metrics/resource-recorder.ts (this file owns the contract types). */
export type CreateResourceRecorder = (options?: Partial<RecorderOptions>) => ResourceRecorder
