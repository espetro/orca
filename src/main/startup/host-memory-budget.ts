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
  maxRetainedHiddenWebglContexts: number
  enableLowEndDeviceMode: boolean
  rendererProcessLimit: number | null
}

const BYTES_PER_GIB = 1024 * 1024 * 1024

const TIER_BUDGETS: Record<HostMemoryTier, Omit<HostMemoryBudget, 'tier' | 'totalGib'>> = {
  low: {
    rendererMaxOldSpaceMb: 768,
    optimizeForSize: true,
    exposeGc: true,
    daemonMaxOldSpaceMb: 128,
    pluginHostMaxOldSpaceMb: 128,
    parcelWatcherMaxOldSpaceMb: 96,
    disableGpuMemoryBufferVideoFrames: true,
    purgeAndSuspendGpu: true,
    maxRetainedHiddenWebglContexts: 0,
    enableLowEndDeviceMode: true,
    rendererProcessLimit: 2
  },
  mid: {
    rendererMaxOldSpaceMb: 2048,
    optimizeForSize: false,
    exposeGc: false,
    daemonMaxOldSpaceMb: 256,
    pluginHostMaxOldSpaceMb: 256,
    parcelWatcherMaxOldSpaceMb: 160,
    disableGpuMemoryBufferVideoFrames: false,
    purgeAndSuspendGpu: false,
    maxRetainedHiddenWebglContexts: 2,
    enableLowEndDeviceMode: false,
    rendererProcessLimit: null
  },
  high: {
    rendererMaxOldSpaceMb: 4096,
    optimizeForSize: false,
    exposeGc: false,
    daemonMaxOldSpaceMb: 384,
    pluginHostMaxOldSpaceMb: 384,
    parcelWatcherMaxOldSpaceMb: 256,
    disableGpuMemoryBufferVideoFrames: false,
    purgeAndSuspendGpu: false,
    maxRetainedHiddenWebglContexts: 6,
    enableLowEndDeviceMode: false,
    rendererProcessLimit: null
  }
}

export const HOST_MEMORY_TIER_ENV_VAR = 'ORCA_HOST_MEMORY_TIER'

/**
 * An explicit tier from ORCA_HOST_MEMORY_TIER, or null to fall through to the
 * RAM thresholds. Lets a bench A/B pin a tier without faking os.totalmem() —
 * same override precedent as ORCA_RENDERER_HEAP_MB in renderer-heap-headroom.ts.
 */
export function parseHostMemoryTierOverride(value: string | undefined): HostMemoryTier | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'mid' || normalized === 'high') {
    return normalized
  }
  return null
}

function tierFromTotalGib(totalGib: number): HostMemoryTier {
  if (totalGib < 12) {
    return 'low'
  }
  if (totalGib < 24) {
    return 'mid'
  }
  return 'high'
}

// Why: scale process heap caps and Chromium launch knobs to host RAM so low-spec machines avoid OOM/swap thrash.
export function deriveHostMemoryBudget(
  totalBytes: number = totalmem(),
  env: NodeJS.ProcessEnv = process.env
): HostMemoryBudget {
  const totalGib = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / BYTES_PER_GIB : 0
  // totalGib stays the real reading even when the tier is forced, so artifacts
  // record both "what this host has" and "what tier we ran it as".
  const tier =
    parseHostMemoryTierOverride(env[HOST_MEMORY_TIER_ENV_VAR]) ?? tierFromTotalGib(totalGib)
  return { tier, totalGib, ...TIER_BUDGETS[tier] }
}
