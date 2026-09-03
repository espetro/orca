import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decodeGitCQuotedPath } from './git-cquoted-path'

describe('decodeGitCQuotedPath', () => {
  it('preserves an octal UTF-8 BOM instead of treating it as Git framing', () => {
    expect(decodeGitCQuotedPath('"\\357\\273\\277name"')).toBe('\uFEFFname')
  })

  it('decodes adjacent UTF-8 octal bytes after a BOM', () => {
    expect(decodeGitCQuotedPath('"\\357\\273\\277\\343\\201\\202"')).toBe('\uFEFFあ')
  })

  it('never throws on arbitrary input strings', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(typeof decodeGitCQuotedPath(input)).toBe('string')
      })
    )
  })

  it('leaves unquoted paths untouched (identity)', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.startsWith('"') || !s.endsWith('"') || s.length < 2),
        (unquoted) => {
          expect(decodeGitCQuotedPath(unquoted)).toBe(unquoted)
        }
      )
    )
  })
})
