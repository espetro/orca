import { describe, expect, it } from 'vitest'

import { getRequiredStringFlagAllowingEmpty } from './flags'

describe('CLI flags', () => {
  it.each([
    {
      flag: 'value',
      input: new Map([['value', '']]),
      expected: ''
    },
    {
      flag: 'value',
      input: new Map([['value', 'hello']]),
      expected: 'hello'
    }
  ])('getRequiredStringFlagAllowingEmpty parses correctly for %j', ({ flag, input, expected }) => {
    expect(getRequiredStringFlagAllowingEmpty(input, flag)).toBe(expected)
  })

  it.each([
    { input: new Map([['foo', '']]), flag: 'foo', shouldThrow: true },
    { input: new Map([['bar', 'val']]), flag: 'bar', shouldThrow: false }
  ])('getRequiredStringFlag validates presence for %j', ({ input, flag, shouldThrow }) => {
    if (shouldThrow) {
      expect(() => getRequiredStringFlagAllowingEmpty(new Map(), flag)).toThrow()
    } else {
      expect(getRequiredStringFlagAllowingEmpty(input, flag)).toBe('val')
    }
  })
})
