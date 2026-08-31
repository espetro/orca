import { CROSS_LOCALE_KEY_OVERRIDES } from './locale-cross-locale-key-overrides.mts'
import { JA_KEY_OVERRIDES } from './locale-ja-key-overrides.mts'
import { KO_KEY_OVERRIDES } from './locale-ko-key-overrides.mts'
import { MACOS_TCC_KEY_OVERRIDES } from './locale-macos-tcc-key-overrides.mts'

export type LocaleKeyOverrideMap = Record<string, Record<string, string>>

type OverrideMap = Record<string, Record<string, string>>

export function mergeLocaleKeyOverrides(base: LocaleKeyOverrideMap): LocaleKeyOverrideMap {
  const merged: LocaleKeyOverrideMap = { ...base }
  for (const [key, overrides] of Object.entries(CROSS_LOCALE_KEY_OVERRIDES as OverrideMap)) {
    merged[key] = { ...merged[key], ...overrides }
  }
  for (const [key, overrides] of Object.entries(KO_KEY_OVERRIDES as OverrideMap)) {
    // KO split overrides can share keys with zh/ja repairs; merge per locale.
    merged[key] = { ...merged[key], ...overrides }
  }
  for (const [key, overrides] of Object.entries(JA_KEY_OVERRIDES as OverrideMap)) {
    merged[key] = { ...merged[key], ...overrides }
  }
  for (const [key, overrides] of Object.entries(MACOS_TCC_KEY_OVERRIDES as OverrideMap)) {
    merged[key] = { ...merged[key], ...overrides }
  }
  return merged
}
