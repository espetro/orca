import { getAppEnvironment } from '../../shared/app-environment'
import type { AppProcessMetric, AppEnvironment } from '../../shared/app-environment'
import { collectHostMemory } from '../memory/host-memory'
import type { HostMemory } from '../../shared/process-stats-types'
import os from 'node:os'
import type {
  HostContext,
  RecorderOptions,
  ResourceDump,
  ResourceMarker,
  ResourceRecorder,
  ResourceSample,
  ResourceTick
} from '../../shared/resource-recorder-types'
import { execFileAsync } from '../../shared/child-process/exec-file'
import {
  parseDarwinThermal,
  parseFootprintTool,
  parsePsFootprint,
  parseVmStatDeltas
} from '../../shared/resource-recorder-parsers'

const DEFAULT_TICK_MS = 2_000
const DEFAULT_RING_CAPACITY = 3_600

type ResolvedOptions = Required<RecorderOptions>

/** Electron `app` read lazily so unit tests import this module without electron. */
function readElectronAppVersion(): string | null {
  try {
    const electron = require('electron') as { app?: { getVersion(): string } }
    return electron.app?.getVersion() ?? null
  } catch {
    return null
  }
}

function normalizeType(raw: string | undefined): ResourceSample['type'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'browser':
      return 'main'
    case 'tab':
      return 'renderer'
    case 'gpu':
      return 'gpu'
    case 'utility':
      return 'utility'
    case 'zygote':
      return 'zygote'
    default:
      return 'other'
  }
}

class ResourceRecorderImpl implements ResourceRecorder {
  private readonly options: ResolvedOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private ticks: ResourceTick[] = []
  private markers: ResourceMarker[] = []
  private startedAt: number | null = null
  private prevVmStat: { stdout: string } | null = null

  constructor(options: ResolvedOptions) {
    this.options = options
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.startedAt = this.options.now()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  mark(name: string): void {
    this.markers.push({ timestamp: this.options.now(), name })
    if (this.markers.length > this.options.ringCapacity) {
      this.markers.splice(0, this.markers.length - this.options.ringCapacity)
    }
  }

  dump(): ResourceDump {
    const now = this.options.now()
    let appVersion: string | null = null
    try {
      appVersion = readElectronAppVersion() ?? process.env.ORCA_APP_VERSION ?? null
    } catch {
      appVersion = process.env.ORCA_APP_VERSION ?? null
    }
    return {
      schema: 'orca.resource-dump',
      schemaVersion: 1,
      recordedAt: now,
      platform: os.platform(),
      appVersion: appVersion ?? 'unknown',
      appCommit: process.env.ORCA_APP_COMMIT ?? null,
      uptimeSeconds: Math.floor(process.uptime()),
      recorderConfig: {
        tickMs: this.options.tickMs,
        ringCapacity: this.options.ringCapacity,
        startedAt: this.startedAt ?? now
      },
      ticks: [...this.ticks],
      markers: [...this.markers],
      hostSamples: this.ticks.map((tick) => tick.host)
    }
  }

  private async tick(): Promise<void> {
    const timestamp = this.options.now()
    const isDarwin = os.platform() === 'darwin'
    const metrics = safeAppMetrics(this.options.getAppMetrics)

    const samples: ResourceSample[] = metrics.map((metric) => ({
      timestamp,
      pid: metric.pid,
      type: normalizeType(metric.type),
      rssBytes: 0,
      workingSetKb: metric.memory?.workingSetSize ?? null,
      footprintBytes: null,
      cpuPercent: metric.cpu?.percentCPUUsage ?? 0
    }))

    // Main-process row from Node itself (browser type maps to 'main').
    let mainProcess: ResourceTick['mainProcess'] = null
    try {
      const memory = process.memoryUsage()
      mainProcess = {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external
      }
    } catch {
      mainProcess = null
    }

    const host = await this.collectHost(isDarwin)

    if (isDarwin && samples.length > 0) {
      await this.applyFootprints(samples)
    }

    this.pushTick({ timestamp, samples, host, mainProcess })
  }

  private async applyFootprints(samples: ResourceSample[]): Promise<void> {
    const pids = [...new Set(samples.map((sample) => sample.pid))].join(',')
    try {
      const { stdout } = await this.options.execFile('ps', ['-o', 'pid=,rss=', '-p', pids])
      const rows = parsePsFootprint(stdout)
      for (const sample of samples) {
        const row = rows.get(sample.pid)
        if (row) {
          sample.rssBytes = row.rssBytes
        }
      }
    } catch {
      // ps failed this tick: rssBytes stays 0 fallback.
    }
    // phys_footprint is not a ps keyword on modern macOS; probe per pid instead.
    for (const sample of samples) {
      try {
        const { stdout } = await this.options.execFile('/usr/bin/footprint', [
          '-p',
          String(sample.pid)
        ])
        sample.footprintBytes = parseFootprintTool(stdout)
      } catch {
        sample.footprintBytes = null
      }
    }
  }

  private async collectHost(isDarwin: boolean): Promise<HostContext> {
    let hostMemory: HostMemory | null = null
    try {
      hostMemory = await this.options.hostMemory()
    } catch {
      hostMemory = null
    }

    const thermal = isDarwin ? await this.readThermal() : null
    const deltas = isDarwin ? await this.readVmStatDeltas() : null

    return {
      availableMemoryBytes: hostMemory?.availableMemory ?? 0,
      availableMemorySource: hostMemory?.availableMemorySource ?? 'unavailable',
      loadAverage1m: hostMemory?.loadAverage1m ?? 0,
      thermal,
      pageinsDelta: deltas?.pageinsDelta ?? null,
      pageoutsDelta: deltas?.pageoutsDelta ?? null
    }
  }

  private async readThermal(): Promise<HostContext['thermal']> {
    try {
      const { stdout } = await this.options.execFile('pmset', ['-g', 'therm'])
      return parseDarwinThermal(stdout)
    } catch {
      return null
    }
  }

  private async readVmStatDeltas(): Promise<{
    pageinsDelta: number
    pageoutsDelta: number
  } | null> {
    try {
      const { stdout } = await this.options.execFile('vm_stat', [])
      const prev = this.prevVmStat
      this.prevVmStat = { stdout }
      if (!prev) {
        return null
      }
      return parseVmStatDeltas(prev.stdout, stdout)
    } catch {
      this.prevVmStat = null
      return null
    }
  }

  private pushTick(tick: ResourceTick): void {
    this.ticks.push(tick)
    if (this.ticks.length > this.options.ringCapacity) {
      this.ticks.splice(0, this.ticks.length - this.options.ringCapacity)
    }
  }
}

function safeAppMetrics(get: () => AppProcessMetric[]): AppProcessMetric[] {
  try {
    return get()
  } catch {
    return []
  }
}

function resolveOptions(options?: Partial<RecorderOptions>): ResolvedOptions {
  const partial = options ?? {}
  return {
    tickMs: partial.tickMs ?? DEFAULT_TICK_MS,
    ringCapacity: partial.ringCapacity ?? DEFAULT_RING_CAPACITY,
    now: partial.now ?? Date.now,
    execFile: partial.execFile ?? execFileAsync,
    getAppMetrics:
      partial.getAppMetrics ?? (() => (getAppEnvironment() as AppEnvironment).getAppMetrics()),
    hostMemory: partial.hostMemory ?? collectHostMemory
  }
}

/** createResourceRecorder from the shared contract (src/shared/resource-recorder-types.ts). */
export function createResourceRecorder(options?: Partial<RecorderOptions>): ResourceRecorder {
  return new ResourceRecorderImpl(resolveOptions(options))
}

let singleton: ResourceRecorder | null = null

export function startResourceRecorderIfEnabled(): ResourceRecorder | null {
  if (process.env.ORCA_RESOURCE_RECORDER !== '1') {
    return null
  }
  if (!singleton) {
    singleton = createResourceRecorder()
    singleton.start()
  }
  return singleton
}

export function getResourceRecorder(): ResourceRecorder | null {
  return singleton
}

/** Test seam: clears the singleton without stopping timers (tests inject their own recorder). */
export function resetResourceRecorderForTests(): void {
  singleton?.stop()
  singleton = null
}
