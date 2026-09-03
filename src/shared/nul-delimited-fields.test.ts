import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { iterateNulDelimitedFields } from './nul-delimited-fields'

describe('iterateNulDelimitedFields', () => {
  it('preserves empty and trailing fields without materializing a split array', () => {
    expect([...iterateNulDelimitedFields('one\0\0three\0')]).toEqual(['one', '', 'three', ''])
  })

  it('matches string.split("\\0") equivalence for arbitrary fields joined by NUL', () => {
    fc.assert(
      fc.property(fc.array(fc.string().map((s) => s.replaceAll('\0', ''))), (fields) => {
        const joined = fields.join('\0')
        expect([...iterateNulDelimitedFields(joined)]).toEqual(joined.split('\0'))
      })
    )
  })
})
