import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { err, isErr, isOk, ok, unwrap, unwrapOr } from './result'

describe('Result<T, E>', () => {
  it.each([
    ['hello', true],
    [42, true],
    [null, true],
    [undefined, true]
  ])('constructs ok(%s) properly', (val, expectedOk) => {
    const res = ok(val)
    expect(res.ok).toBe(expectedOk)
    expect(isOk(res)).toBe(true)
    expect(isErr(res)).toBe(false)
    expect(unwrap(res)).toBe(val)
    expect(unwrapOr(res, 'fallback')).toBe(val)
  })

  it('constructs err properly and unwraps fallback or throws', () => {
    const errorObj = new Error('boom')
    const res = err(errorObj)
    expect(res.ok).toBe(false)
    expect(isOk(res)).toBe(false)
    expect(isErr(res)).toBe(true)
    expect(unwrapOr(res, 'safe')).toBe('safe')
    expect(() => unwrap(res)).toThrow('boom')
  })

  it('preserves algebraic roundtrips and laws via fast-check', () => {
    fc.assert(
      fc.property(fc.string(), (str) => {
        const o = ok(str)
        expect(unwrap(o)).toBe(str)
        expect(unwrapOr(o, 'fallback')).toBe(str)
      })
    )

    fc.assert(
      fc.property(fc.string(), fc.string(), (errorMsg, fallback) => {
        const e = err(errorMsg)
        expect(unwrapOr(e, fallback)).toBe(fallback)
      })
    )
  })
})
