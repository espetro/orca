// MERGE: replaced by exp/mem-obs-m1 (M1 owns this file; contract-exact copy).
import type { ProcessMetric } from 'electron'

export type HostMemory = {
  availableMemoryBytes: number
  availableMemorySource: string
  loadAverage1m: number
}

export type ResourceProcessType = 'main' | 'renderer' | 'gpu' | 'utility' | 'zygote' | 'other'

export type ResourceSample = {
  timestamp: number
  pid: number
  type: ResourceProcessType
  rssBytes: number
  workingSetKb: number | null
  footprintBytes: number | null
  cpuPercent: number
}

export type HostContext = {
  availableMemoryBytes: number
  availableMemorySource: string
  loadAverage1m: number
  thermal: { cpuSpeedLimitPercent: number | null } | null
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
  hostSamples: HostContext[]
}

export type ResourceRecorder = {
  start(): void
  stop(): void
  mark(name: string): void
  dump(): ResourceDump
  isRunning(): boolean
}

export type RecorderOptions = {
  tickMs: number
  ringCapacity: number
  now: () => number
  execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  getAppMetrics: () => ProcessMetric[]
  hostMemory: () => Promise<HostMemory>
}

export function createResourceRecorder(_options?: Partial<RecorderOptions>): ResourceRecorder {
  throw new Error('not-implemented-on-this-lane')
}
