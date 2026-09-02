import { describe, expect, it } from 'vitest'
import {
  parseDarwinThermal,
  parseFootprintTool,
  parsePsFootprint,
  parseVmStatDeltas
} from './resource-recorder-parsers'

describe('parsePsFootprint', () => {
  it('parses phys_footprint from real /usr/bin/footprint output (MB units)', () => {
    const stdout = [
      '======================================================================',
      'Orca Helper [77425]: 64-bit    Footprint: 22 MB (16384 bytes per page)',
      '    phys_footprint: 22 MB',
      '    phys_footprint_peak: 27 MB',
      '======================================================================'
    ].join('\n')
    expect(parseFootprintTool(stdout)).toBe(22 * 1048576)
  })

  it('falls back to the summary Footprint line in KB', () => {
    expect(parseFootprintTool('Footprint: 1361 KB (16384 bytes per page)')).toBe(1361 * 1024)
  })

  it('returns null on unrelated output', () => {
    expect(parseFootprintTool('no such process')).toBeNull()
  })
  it('parses pid, rss (KB), and phys_footprint (bytes)', () => {
    const rows = parsePsFootprint('  1234  51200  104857600\n  5678  25600  52428800\n')

    expect(rows.get(1234)).toEqual({ rssBytes: 52_428_800, footprintBytes: 104_857_600 })
    expect(rows.get(5678)).toEqual({ rssBytes: 26_214_400, footprintBytes: 52_428_800 })
    expect(rows.size).toBe(2)
  })

  it('accepts pid+rss rows (macOS without phys_footprint keyword) with null footprint', () => {
    const rows = parsePsFootprint('  1234  51200\n  5678  25600\n')

    expect(rows.get(1234)).toEqual({ rssBytes: 52_428_800, footprintBytes: null })
    expect(rows.get(5678)).toEqual({ rssBytes: 26_214_400, footprintBytes: null })
  })

  it('skips header and junk lines', () => {
    const stdout = [
      '  PID      RSS  FOOTPRINT',
      'not a ps line at all',
      '  99  1024  2048',
      '',
      '  abc  1  2'
    ].join('\n')

    const rows = parsePsFootprint(stdout)

    expect(rows.size).toBe(1)
    expect(rows.get(99)).toEqual({ rssBytes: 1_048_576, footprintBytes: 2048 })
  })

  it('returns empty map for malformed input', () => {
    expect(parsePsFootprint('').size).toBe(0)
    expect(parsePsFootprint('garbage\n\n').size).toBe(0)
  })
})

describe('parseDarwinThermal', () => {
  it('parses CPU_Speed_Limit from pmset -g therm output', () => {
    const stdout = 'CPU_Speed_Limit = 100\nCPU_Scheduler_Limit = 100\n'

    expect(parseDarwinThermal(stdout)).toEqual({ cpuSpeedLimitPercent: 100 })
    expect(parseDarwinThermal('CPU_Speed_Limit = 75\n')).toEqual({ cpuSpeedLimitPercent: 75 })
  })

  it('returns null percent on n/a values', () => {
    expect(parseDarwinThermal('CPU_Speed_Limit = n/a\n')).toEqual({ cpuSpeedLimitPercent: null })
  })

  it('returns null on unsupported output', () => {
    expect(parseDarwinThermal('No thermal warning')).toBeNull()
    expect(parseDarwinThermal('')).toBeNull()
  })
})

describe('parseVmStatDeltas', () => {
  it('computes deltas between two vm_stat outputs', () => {
    const prev = 'Page size of 16384 bytes\nPage ins: 1000.\nPage outs: 500.\n'
    const next = 'Page size of 16384 bytes\nPage ins: 1030.\nPage outs: 510.\n'

    expect(parseVmStatDeltas(prev, next)).toEqual({ pageinsDelta: 30, pageoutsDelta: 10 })
  })

  it('returns null when either output is malformed', () => {
    const good = 'Page ins: 1000.\nPage outs: 500.\n'

    expect(parseVmStatDeltas('no counters here', good)).toBeNull()
    expect(parseVmStatDeltas(good, 'Page ins: 1.\n')).toBeNull()
  })
})
