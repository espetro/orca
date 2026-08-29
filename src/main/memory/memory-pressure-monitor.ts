/**
 * System memory-pressure response for the main process.
 *
 * Polls host memory on a cadence (reusing `collectHostMemory` from
 * `host-memory.ts` rather than a second sampling path). When the
 * available-memory fraction drops below a threshold it responds by:
 *   - clearing the cache of background (non-visible) sessions, and
 *   - emitting a 'memory-pressure' signal that other modules (e.g. a
 *     hibernation planner) can subscribe to.
 *
 * A minimize hook runs the same purge when the user minimizes a window.
 *
 * Session visibility: callers may mark sessions `visible: true` to exempt
 * them. When visibility is not reported we treat the session as background
 * and clear its cache anyway (conservative: caches are regenerable, so
 * over-clearing is cheap while under-clearing leaves pressure unrelieved).
 *
 * Responses are rate-limited by a cooldown so sustained pressure does not
 * trigger repeated sweeps.
 */

import { EventEmitter } from 'node:events'
import { collectHostMemory } from './host-memory'
import type { HostMemory } from '../../shared/process-stats-types'

export const DEFAULT_PRESSURE_THRESHOLD_FRACTION = 0.1
export const DEFAULT_PRESSURE_COOLDOWN_MS = 5 * 60 * 1000
export const DEFAULT_PRESSURE_POLL_INTERVAL_MS = 30 * 1000

/** Minimal session surface the monitor interacts with. */
export type MemoryPressureSession = {
  clearCache: () => Promise<void> | void
  /** When true the session hosts a visible view and is exempt from purging. */
  visible?: boolean
}

export type MemoryPressureReason = 'system-pressure' | 'minimize'

export type MemoryPressureEvent = {
  reason: MemoryPressureReason
  availableFraction: number
}

export type MemoryPressureOptions = {
  /** Enumerate sessions eligible for cache clearing. */
  listSessions?: () => MemoryPressureSession[]
  /** Host memory sampler; defaults to the shared host-memory collector. */
  getHostMemory?: () => Promise<HostMemory>
  /** Available fraction below which pressure is declared (default 0.1). */
  thresholdFraction?: number
  /** Minimum spacing between responses in ms (default 5 minutes). */
  cooldownMs?: number
  /** Sampling cadence in ms (default 30 seconds). */
  intervalMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export type MemoryPressureMonitor = {
  /** Fired with the pressure reason whenever a purge runs. */
  emitter: EventEmitter
  /** Run the purge response as if the user minimized a window. */
  purgeForMinimize: () => Promise<void>
  /** Force a single pressure evaluation (used by tests and manual checks). */
  checkNow: () => Promise<void>
  stop: () => void
}

export function startMemoryPressureMonitor(
  options: MemoryPressureOptions = {}
): MemoryPressureMonitor {
  const thresholdFraction = options.thresholdFraction ?? DEFAULT_PRESSURE_THRESHOLD_FRACTION
  const cooldownMs = options.cooldownMs ?? DEFAULT_PRESSURE_COOLDOWN_MS
  const intervalMs = options.intervalMs ?? DEFAULT_PRESSURE_POLL_INTERVAL_MS
  const now = options.now ?? Date.now
  const getHostMemory = options.getHostMemory ?? collectHostMemory
  const listSessions =
    options.listSessions ??
    (() => {
      // No session source provided: nothing to clear, but the signal is
      // still emitted so subscribers can react.
      return []
    })

  const emitter = new EventEmitter()
  let lastResponseAt = -Infinity
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function respond(reason: MemoryPressureReason, availableFraction: number): Promise<void> {
    lastResponseAt = now()
    const sessions = listSessions()
    await Promise.all(
      sessions
        .filter((session) => session.visible !== true)
        .map((session) => Promise.resolve(session.clearCache()))
    )
    emitter.emit('memory-pressure', { reason, availableFraction } satisfies MemoryPressureEvent)
  }

  async function evaluate(): Promise<void> {
    if (stopped) {
      return
    }
    let host: HostMemory
    try {
      host = await getHostMemory()
    } catch (err) {
      console.warn('[memory-pressure] host memory sampling failed', err)
      return
    }
    const availableFraction =
      host.totalMemory > 0 ? host.availableMemory / host.totalMemory : 1
    if (availableFraction >= thresholdFraction) {
      return
    }
    if (now() - lastResponseAt < cooldownMs) {
      return
    }
    await respond('system-pressure', availableFraction)
  }

  async function purgeForMinimize(): Promise<void> {
    if (stopped) {
      return
    }
    if (now() - lastResponseAt < cooldownMs) {
      return
    }
    await respond('minimize', Number.NaN)
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void evaluate()
    }, intervalMs)
    timer.unref?.()
  }

  return {
    emitter,
    purgeForMinimize,
    checkNow: evaluate,
    stop: () => {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      emitter.removeAllListeners()
    }
  }
}
