import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

type LocaleScopedOverrides = Record<string, Record<string, string>>

describe('locale-ko-key-overrides', () => {
  it('keeps Korean key override data scoped to Korean values', () => {
    const overrides: unknown = JSON.parse(
      readFileSync(new URL('./locale-ko-key-overrides.json', import.meta.url), 'utf8')
    )
    if (!isLocaleScopedOverrides(overrides)) {
      throw new Error('locale-ko-key-overrides.json must map keys to locale-scoped values')
    }
    for (const value of Object.values(overrides)) {
      expect(Object.keys(value)).toEqual(['ko'])
    }
  })
})

function isLocaleScopedOverrides(value: unknown): value is LocaleScopedOverrides {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return Object.values(value).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      Object.values(entry).every((localeValue) => typeof localeValue === 'string')
  )
}
