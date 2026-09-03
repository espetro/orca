import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { clampCheckDetailsHeight } from './check-details-resize'

describe('clampCheckDetailsHeight', () => {
  it.each([
    [20, 72],
    [260, 260],
    [900, 520]
  ])('clamps %i -> %i', (input, expected) => {
    expect(clampCheckDetailsHeight(input)).toBe(expected)
  })

  it('always clamps any height within [72, 520]', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10000, max: 100000 }), (val) => {
        const clamped = clampCheckDetailsHeight(val)
        expect(clamped).toBeGreaterThanOrEqual(72)
        expect(clamped).toBeLessThanOrEqual(520)
      })
    )
  })
})
