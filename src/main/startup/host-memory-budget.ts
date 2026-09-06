import { totalmem } from 'node:os'

export type HostMemoryTier = 'low' | 'mid' | 'high'

export type HostMemoryBudget = {
  tier: HostMemoryTier
  totalGib: number
  rendererMaxOldSpaceMb: number
  optimizeForSize: boolean
  exposeGc: boolean
  daemonMaxOldSpaceMb: number
  pluginHostMaxOldSpaceMb: number
  parcelWatcherMaxOldSpaceMb: number
  disableGpuMemoryBufferVideoFrames: boolean
  purgeAndSuspendGpu: boolean
  enableLowEndDeviceMode: boolean
  rendererProcessLimit: number | null
}

const BYTES_PER_GIB = 1024 * 1024 * 1024

// Why: scale process heap caps and Chromium launch knobs to host RAM so low-spec machines avoid OOM/swap thrash.
export function deriveHostMemoryBudget(totalBytes: number = totalmem()): HostMemoryBudget {
  const totalGib = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / BYTES_PER_GIB : 0

  if (totalGib < 12) {
    return {
      tier: 'low',
      totalGib,
      rendererMaxOldSpaceMb: 768,
      optimizeForSize: true,
      exposeGc: true,
      daemonMaxOldSpaceMb: 128,
      pluginHostMaxOldSpaceMb: 128,
      parcelWatcherMaxOldSpaceMb: 96,
      disableGpuMemoryBufferVideoFrames: true,
      purgeAndSuspendGpu: true,
      enableLowEndDeviceMode: true,
      rendererProcessLimit: 2
    }
  }

  if (totalGib < 24) {
    return {
      tier: 'mid',
      totalGib,
      rendererMaxOldSpaceMb: 2048,
      optimizeForSize: false,
      exposeGc: false,
      daemonMaxOldSpaceMb: 256,
      pluginHostMaxOldSpaceMb: 256,
      parcelWatcherMaxOldSpaceMb: 160,
      disableGpuMemoryBufferVideoFrames: false,
      purgeAndSuspendGpu: false,
      enableLowEndDeviceMode: false,
      rendererProcessLimit: null
    }
  }

  return {
    tier: 'high',
    totalGib,
    rendererMaxOldSpaceMb: 4096,
    optimizeForSize: false,
    exposeGc: false,
    daemonMaxOldSpaceMb: 384,
    pluginHostMaxOldSpaceMb: 384,
    parcelWatcherMaxOldSpaceMb: 256,
    disableGpuMemoryBufferVideoFrames: false,
    purgeAndSuspendGpu: false,
    enableLowEndDeviceMode: false,
    rendererProcessLimit: null
  }
}
