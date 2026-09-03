import { describe, expect, it } from 'vitest'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'

describe('shouldShowMobileDriverOverlay', () => {
  it.each([
    ['mobile', null, true],
    ['idle', 'mobile-fit', true],
    ['idle', 'remote-desktop-fit', false],
    ['desktop', 'desktop-fit', false]
  ] as const)('evaluates (%s, %s) -> %s', (driver, fit, expected) => {
    expect(shouldShowMobileDriverOverlay(driver, fit)).toBe(expected)
  })
})
