import { describe, expect, it } from 'vitest'
import { deriveHostMemoryBudget, parseHostMemoryTierOverride } from './host-memory-budget'

const GIB = 1024 * 1024 * 1024
const NO_ENV: NodeJS.ProcessEnv = {}

describe('deriveHostMemoryBudget', () => {
  it('assigns low tier for memory < 12 GiB', () => {
    const budget4 = deriveHostMemoryBudget(4 * GIB)
    expect(budget4.tier).toBe('low')
    expect(budget4.totalGib).toBe(4)
    expect(budget4.rendererMaxOldSpaceMb).toBe(768)
    expect(budget4.optimizeForSize).toBe(true)
    expect(budget4.exposeGc).toBe(true)
    expect(budget4.daemonMaxOldSpaceMb).toBe(128)
    expect(budget4.pluginHostMaxOldSpaceMb).toBe(128)
    expect(budget4.parcelWatcherMaxOldSpaceMb).toBe(96)
    expect(budget4.disableGpuMemoryBufferVideoFrames).toBe(true)
    expect(budget4.purgeAndSuspendGpu).toBe(true)
    expect(budget4.maxRetainedHiddenWebglContexts).toBe(0)
    expect(budget4.enableLowEndDeviceMode).toBe(true)
    expect(budget4.rendererProcessLimit).toBe(2)

    const budget8 = deriveHostMemoryBudget(8 * GIB)
    expect(budget8.tier).toBe('low')
    expect(budget8.rendererMaxOldSpaceMb).toBe(768)
    expect(budget8.enableLowEndDeviceMode).toBe(true)
    expect(budget8.rendererProcessLimit).toBe(2)

    const budget11 = deriveHostMemoryBudget(11.9 * GIB)
    expect(budget11.tier).toBe('low')
  })

  it('assigns mid tier for 12 GiB <= memory < 24 GiB', () => {
    const budget12 = deriveHostMemoryBudget(12 * GIB)
    expect(budget12.tier).toBe('mid')
    expect(budget12.totalGib).toBe(12)
    expect(budget12.rendererMaxOldSpaceMb).toBe(2048)
    expect(budget12.optimizeForSize).toBe(false)
    expect(budget12.exposeGc).toBe(false)
    expect(budget12.daemonMaxOldSpaceMb).toBe(256)
    expect(budget12.pluginHostMaxOldSpaceMb).toBe(256)
    expect(budget12.parcelWatcherMaxOldSpaceMb).toBe(160)
    expect(budget12.disableGpuMemoryBufferVideoFrames).toBe(false)
    expect(budget12.purgeAndSuspendGpu).toBe(false)
    expect(budget12.maxRetainedHiddenWebglContexts).toBe(2)
    expect(budget12.enableLowEndDeviceMode).toBe(false)
    expect(budget12.rendererProcessLimit).toBeNull()

    const budget16 = deriveHostMemoryBudget(16 * GIB)
    expect(budget16.tier).toBe('mid')
    expect(budget16.rendererMaxOldSpaceMb).toBe(2048)

    const budget23 = deriveHostMemoryBudget(23.9 * GIB)
    expect(budget23.tier).toBe('mid')
  })

  it('assigns high tier for memory >= 24 GiB', () => {
    const budget24 = deriveHostMemoryBudget(24 * GIB)
    expect(budget24.tier).toBe('high')
    expect(budget24.totalGib).toBe(24)
    expect(budget24.rendererMaxOldSpaceMb).toBe(4096)
    expect(budget24.optimizeForSize).toBe(false)
    expect(budget24.exposeGc).toBe(false)
    expect(budget24.daemonMaxOldSpaceMb).toBe(384)
    expect(budget24.pluginHostMaxOldSpaceMb).toBe(384)
    expect(budget24.parcelWatcherMaxOldSpaceMb).toBe(256)
    expect(budget24.disableGpuMemoryBufferVideoFrames).toBe(false)
    expect(budget24.purgeAndSuspendGpu).toBe(false)
    expect(budget24.maxRetainedHiddenWebglContexts).toBe(6)
    expect(budget24.enableLowEndDeviceMode).toBe(false)
    expect(budget24.rendererProcessLimit).toBeNull()

    const budget64 = deriveHostMemoryBudget(64 * GIB)
    expect(budget64.tier).toBe('high')
    expect(budget64.rendererMaxOldSpaceMb).toBe(4096)
  })

  it('safely defaults invalid or non-positive memory readings to low tier', () => {
    expect(deriveHostMemoryBudget(0).tier).toBe('low')
    expect(deriveHostMemoryBudget(-1).tier).toBe('low')
    expect(deriveHostMemoryBudget(Number.NaN).tier).toBe('low')
    expect(deriveHostMemoryBudget(Number.POSITIVE_INFINITY).tier).toBe('low')
  })

  it('defaults to reading os.totalmem() when no argument is supplied', () => {
    const budget = deriveHostMemoryBudget()
    expect(['low', 'mid', 'high']).toContain(budget.tier)
    expect(budget.totalGib).toBeGreaterThan(0)
  })
})

describe('ORCA_HOST_MEMORY_TIER override', () => {
  it('parses low/mid/high case-insensitively and rejects anything else', () => {
    expect(parseHostMemoryTierOverride('low')).toBe('low')
    expect(parseHostMemoryTierOverride('  HIGH ')).toBe('high')
    expect(parseHostMemoryTierOverride('Mid')).toBe('mid')
    expect(parseHostMemoryTierOverride('')).toBeNull()
    expect(parseHostMemoryTierOverride(undefined)).toBeNull()
    expect(parseHostMemoryTierOverride('lowish')).toBeNull()
  })

  it('forces the requested tier while keeping the real totalGib reading', () => {
    const forcedHigh = deriveHostMemoryBudget(8 * GIB, { ORCA_HOST_MEMORY_TIER: 'high' })
    expect(forcedHigh.tier).toBe('high')
    expect(forcedHigh.totalGib).toBe(8)
    expect(forcedHigh.rendererMaxOldSpaceMb).toBe(4096)
    expect(forcedHigh.enableLowEndDeviceMode).toBe(false)
    expect(forcedHigh.rendererProcessLimit).toBeNull()

    const forcedLow = deriveHostMemoryBudget(64 * GIB, { ORCA_HOST_MEMORY_TIER: 'low' })
    expect(forcedLow.tier).toBe('low')
    expect(forcedLow.totalGib).toBe(64)
    expect(forcedLow.rendererMaxOldSpaceMb).toBe(768)
    expect(forcedLow.rendererProcessLimit).toBe(2)
  })

  it('falls through to the RAM thresholds when the override is absent or invalid', () => {
    expect(deriveHostMemoryBudget(8 * GIB, NO_ENV).tier).toBe('low')
    expect(deriveHostMemoryBudget(16 * GIB, { ORCA_HOST_MEMORY_TIER: 'huge' }).tier).toBe('mid')
  })
})
