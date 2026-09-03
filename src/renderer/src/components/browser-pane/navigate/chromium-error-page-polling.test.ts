import { describe, expect, it } from 'vitest'
import { shouldPollChromiumErrorPage } from './chromium-error-page-polling'

describe('shouldPollChromiumErrorPage', () => {
  it.each([
    [{ isActive: true, loading: true }, true],
    [{ isActive: false, loading: true }, false],
    [{ isActive: true, loading: false }, false],
    [{ isActive: false, loading: false }, false]
  ])('evaluates %j -> %s', (input, expected) => {
    expect(shouldPollChromiumErrorPage(input)).toBe(expected)
  })
})
