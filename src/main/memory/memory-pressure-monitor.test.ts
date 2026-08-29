import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostMemory } from '../../shared/process-stats-types'

const { collectHostMemoryMock } = vi.hoisted(() => ({
  collectHostMemoryMock: vi.fn()
}))

vi.mock('./host-memory', () => ({
  collectHostMemory: collectHostMemoryMock
}))

async function loadMonitor() {
  vi.resetModules()
  return import('./memory-pressure-monitor')
}

function fakeHost(availableFraction: number): HostMemory {
  const total = 10_000_000_000
  const available = Math.round(total * availableFraction)
  return {
    totalMemory: total,
    freeMemory: available,
    availableMemory: available,
    availableMemorySource: 'free-memory',
    usedMemory: total - available,
    memoryUsagePercent: (1 - availableFraction) * 100,
    cpuCoreCount: 4,
    loadAverage1m: 1
  }
}

function makeSession(cleared: string[], name: string, visible = false) {
  return {
    get name() {
      return name
    },
    visible,
    clearCache: vi.fn(async () => {
      cleared.push(name)
    })
  }
}

async function setup(availableFraction: number, opts: Record<string, unknown> = {}) {
  const { startMemoryPressureMonitor } = await loadMonitor()
  collectHostMemoryMock.mockReset()
  collectHostMemoryMock.mockResolvedValue(fakeHost(availableFraction))
  const cleared: string[] = []
  const sessions = [
    makeSession(cleared, 'background-a'),
    makeSession(cleared, 'background-b'),
    makeSession(cleared, 'visible-a', true)
  ]
  const clock = { t: 1_000 }
  const monitor = startMemoryPressureMonitor({
    listSessions: () => sessions,
    intervalMs: 0,
    thresholdFraction: 0.1,
    cooldownMs: 60_000,
    now: () => clock.t,
    ...opts
  })
  return { monitor, cleared, clock, sessions }
}

describe('memory pressure monitor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('clears background session caches and emits when available memory crosses the threshold', async () => {
    const { monitor, cleared } = await setup(0.05)
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)

    await monitor.checkNow()

    expect(cleared).toEqual(['background-a', 'background-b'])
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'system-pressure', availableFraction: 0.05 })
    )
    monitor.stop()
  })

  it('does not clear the cache of visible sessions', async () => {
    const { monitor, cleared, sessions } = await setup(0.02)
    await monitor.checkNow()
    expect(cleared).not.toContain('visible-a')
    expect(sessions[2].clearCache).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('does not retrigger during the cooldown window', async () => {
    const { monitor, cleared, clock } = await setup(0.01)
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)

    await monitor.checkNow()
    expect(cleared).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(1)

    clock.t += 30_000
    await monitor.checkNow()
    expect(cleared).toHaveLength(2)
    expect(listener).toHaveBeenCalledTimes(1)

    clock.t += 31_000
    await monitor.checkNow()
    expect(cleared).toHaveLength(4)
    expect(listener).toHaveBeenCalledTimes(2)
    monitor.stop()
  })

  it('does nothing when memory is healthy', async () => {
    const { monitor, cleared } = await setup(0.5)
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)
    await monitor.checkNow()
    expect(cleared).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('purges on minimize but respects the cooldown', async () => {
    const { monitor, cleared, clock } = await setup(0.5)
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)

    await monitor.purgeForMinimize()
    expect(cleared).toHaveLength(2)
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'minimize' })
    )

    await monitor.purgeForMinimize()
    expect(cleared).toHaveLength(2)

    clock.t += 60_001
    await monitor.purgeForMinimize()
    expect(cleared).toHaveLength(4)
    monitor.stop()
  })

  it('survives host memory sampling failures without emitting', async () => {
    const { monitor, cleared } = await setup(0.5)
    collectHostMemoryMock.mockRejectedValue(new Error('sampling failed'))
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)
    await expect(monitor.checkNow()).resolves.toBeUndefined()
    expect(cleared).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('emits the signal even when no session source is provided', async () => {
    const { startMemoryPressureMonitor } = await loadMonitor()
    collectHostMemoryMock.mockReset()
    collectHostMemoryMock.mockResolvedValue(fakeHost(0.03))
    const clock = { t: 0 }
    const monitor = startMemoryPressureMonitor({
      intervalMs: 0,
      now: () => clock.t
    })
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)
    await monitor.checkNow()
    expect(listener).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it('stops responding after stop()', async () => {
    const { monitor, cleared } = await setup(0.01)
    monitor.stop()
    const listener = vi.fn()
    monitor.emitter.on('memory-pressure', listener)
    await monitor.checkNow()
    await monitor.purgeForMinimize()
    expect(cleared).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()
  })
})
