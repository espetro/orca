import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeRendererHeapCeilingMb } from './renderer-heap-headroom'

vi.mock('electron', () => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn(),
      getSwitchValue: vi.fn(() => '')
    }
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const GIB = 1024 * 1024 * 1024

describe('computeRendererHeapCeilingMb', () => {
  it('returns low-tier ceiling (768 MB) for memory < 12 GiB', () => {
    expect(computeRendererHeapCeilingMb(4 * GIB)).toBe(768)
    expect(computeRendererHeapCeilingMb(6 * GIB)).toBe(768)
    expect(computeRendererHeapCeilingMb(8 * GIB)).toBe(768)
    expect(computeRendererHeapCeilingMb(11.9 * GIB)).toBe(768)
  })

  it('returns mid-tier ceiling (2048 MB) for 12 GiB <= memory < 24 GiB', () => {
    expect(computeRendererHeapCeilingMb(12 * GIB)).toBe(2048)
    expect(computeRendererHeapCeilingMb(16 * GIB)).toBe(2048)
    expect(computeRendererHeapCeilingMb(23.9 * GIB)).toBe(2048)
  })

  it('returns high-tier ceiling (4096 MB) for memory >= 24 GiB', () => {
    expect(computeRendererHeapCeilingMb(24 * GIB)).toBe(4096)
    expect(computeRendererHeapCeilingMb(32 * GIB)).toBe(4096)
    expect(computeRendererHeapCeilingMb(128 * GIB)).toBe(4096)
  })

  it('honors a positive ORCA_RENDERER_HEAP_MB override regardless of RAM', () => {
    expect(computeRendererHeapCeilingMb(4 * GIB, '5000')).toBe(5000)
    expect(computeRendererHeapCeilingMb(128 * GIB, '4096')).toBe(4096)
  })

  it('opts out (null) for default/off/none/0/negative overrides', () => {
    for (const value of ['default', 'off', 'none', '0', '-1']) {
      expect(computeRendererHeapCeilingMb(16 * GIB, value)).toBeNull()
    }
  })

  it('opts out (null) for a fractional override that would floor to 0 (never emits max-old-space-size=0)', () => {
    for (const value of ['0.5', '0.9', '0.0001']) {
      expect(computeRendererHeapCeilingMb(16 * GIB, value)).toBeNull()
    }
  })

  it('falls through to RAM tiers for blank/invalid overrides', () => {
    expect(computeRendererHeapCeilingMb(16 * GIB, '')).toBe(2048)
    expect(computeRendererHeapCeilingMb(16 * GIB, 'abc')).toBe(2048)
    expect(computeRendererHeapCeilingMb(32 * GIB, '')).toBe(4096)
  })

  it('returns null for a non-finite / non-positive RAM reading', () => {
    expect(computeRendererHeapCeilingMb(Number.NaN)).toBeNull()
    expect(computeRendererHeapCeilingMb(0)).toBeNull()
    expect(computeRendererHeapCeilingMb(-1)).toBeNull()
  })
})

describe('enableRendererHeapHeadroom', () => {
  it('configures optimize-for-size, 768MB heap, and expose-gc on low-tier machines', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('')

    enableRendererHeapHeadroom({ totalMemoryBytes: 8 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'js-flags',
      '--optimize-for-size --max-old-space-size=768 --expose-gc'
    )
  })

  it('appends mid-tier 2048MB heap cap without optimize-for-size on mid-RAM machines', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('')

    enableRendererHeapHeadroom({ totalMemoryBytes: 16 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'js-flags',
      '--max-old-space-size=2048'
    )
  })

  it('appends high-tier 4096MB heap cap on high-RAM machines', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('')

    enableRendererHeapHeadroom({ totalMemoryBytes: 32 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'js-flags',
      '--max-old-space-size=4096'
    )
  })

  it('does not set a switch on non-positive RAM readings', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('')

    enableRendererHeapHeadroom({ totalMemoryBytes: 0, env: {} })

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('js-flags', expect.anything())
  })

  it('preserves an explicit prior --max-old-space-size instead of stacking a second value', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('--max-old-space-size=2048')

    enableRendererHeapHeadroom({ totalMemoryBytes: 16 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('js-flags', expect.anything())
  })

  it('merges with an unrelated existing js-flags value', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('--no-opt')

    enableRendererHeapHeadroom({ totalMemoryBytes: 16 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'js-flags',
      '--no-opt --max-old-space-size=2048'
    )
  })
})
