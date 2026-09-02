import { describe, expect, it } from 'vitest'
import {
  getBenchStartupSwitches,
  parseBenchStartupSwitches,
  BENCH_ALWAYS_DISABLED,
  BENCH_DISABLE_ENV,
  BENCH_ONLY_ENV
} from './bench-startup-switches'

describe('parseBenchStartupSwitches', () => {
  it('reports no bench mode without flags or env', () => {
    const result = parseBenchStartupSwitches(['electron', 'orca'], {})
    expect(result).toEqual({ benchMode: false, only: [], disabled: [] })
  })

  it('parses --only=value', () => {
    const result = parseBenchStartupSwitches(['electron', 'orca', '--only=terminal'], {})
    expect(result.benchMode).toBe(true)
    expect(result.only).toEqual(['terminal'])
    expect(result.disabled).toEqual([])
  })

  it('parses boolean --disable-<subsystem> args', () => {
    const result = parseBenchStartupSwitches(
      ['electron', '--disable-automations', '--disable-mobile'],
      {}
    )
    expect(result.benchMode).toBe(true)
    expect(result.disabled).toEqual(['automations', 'mobile'])
  })

  it('parses ORCA_BENCH_ONLY and ORCA_BENCH_DISABLE env lists', () => {
    const result = parseBenchStartupSwitches([], { [BENCH_ONLY_ENV]: 'terminal,agents' })
    expect(result.only).toEqual(['terminal', 'agents'])
    const disabled = parseBenchStartupSwitches([], { [BENCH_DISABLE_ENV]: ' updates, ,telemetry ' })
    expect(disabled.disabled).toEqual(['updates', 'telemetry'])
  })

  it('merges flags and env, dedupes while keeping insertion order', () => {
    const result = parseBenchStartupSwitches(['--only=terminal', '--disable-updates'], {
      [BENCH_ONLY_ENV]: 'terminal,dashboard',
      [BENCH_DISABLE_ENV]: 'updates'
    })
    expect(result.only).toEqual(['terminal', 'dashboard'])
    expect(result.disabled).toEqual(['updates'])
  })

  it('ignores malformed --only without value and unrelated args', () => {
    const result = parseBenchStartupSwitches(['--only=', '--remote-debugging-port=9222'], {})
    expect(result).toEqual({ benchMode: false, only: [], disabled: [] })
  })

  it('memoizes the process-level parse', () => {
    expect(getBenchStartupSwitches()).toEqual(parseBenchStartupSwitches())
  })

  it('exposes the always-disabled subsystem set', () => {
    expect(BENCH_ALWAYS_DISABLED).toEqual(['experiments', 'telemetry', 'updates'])
  })
})
