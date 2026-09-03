import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatPathLineReference } from './line-copy-path'

describe('formatPathLineReference', () => {
  it('uses the standard path:line format', () => {
    expect(formatPathLineReference('src/components/PdfViewer.tsx', 142)).toBe(
      'src/components/PdfViewer.tsx:142'
    )
  })

  it('formats any valid path and line number as path:line', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1 }), (filePath, line) => {
        expect(formatPathLineReference(filePath, line)).toBe(`${filePath}:${line}`)
      })
    )
  })
})
