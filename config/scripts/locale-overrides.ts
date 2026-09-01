// One-stop registry for every locale override consumed by locale-translation-policy.ts.
// Barrel re-exports — preserves the per-file semantic split (regex arrays vs. per-en
// maps vs. per-key maps vs. helper functions) without inventing a single bag.

// ── per-locale value overrides (en → locale) ──────────────────────────────
export { JA_VALUE_OVERRIDES } from './locale-ja-value-overrides.ts'
export { KO_VALUE_OVERRIDES } from './locale-ko-value-overrides.ts'
export { ZH_VALUE_OVERRIDES } from './locale-zh-value-overrides.ts'

// ── per-locale phrase-fix regex arrays ────────────────────────────────────
export { JA_PHRASE_FIXES } from './locale-ja-phrase-fixes.ts'
export { KO_PHRASE_FIXES_ROUND4 } from './locale-ko-phrase-fixes.ts' // locale-phrase-fixes.ts spreads round4 + round5 internally
export { ZH_PHRASE_FIXES_ROUND5 } from './locale-zh-phrase-fixes-round5.ts'

// ── per-key overrides ────────────────────────────────────────────────────
export { CROSS_LOCALE_KEY_OVERRIDES } from './locale-cross-locale-key-overrides.ts'
export { JA_KEY_OVERRIDES } from './locale-ja-key-overrides.ts'
export { KO_KEY_OVERRIDES } from './locale-ko-key-overrides.ts'
export { MACOS_TCC_KEY_OVERRIDES } from './locale-macos-tcc-key-overrides.ts'

// ── aggregated records the orchestrator publishes ─────────────────────────
export { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.ts'
export { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.ts'
export { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.ts'

// ── brand / generic-term tables ───────────────────────────────────────────
export { BRAND_MISTRANSLATIONS } from './locale-brand-mistranslations.ts'
export { LOCALIZABLE_GENERIC_TERMS } from './locale-generic-ui-terms.ts'
export { CJK_LATIN_SPACED_TERMS } from './locale-cjk-latin-spaced-terms.ts'

// ── pure helpers ──────────────────────────────────────────────────────────
export { isScreenCursorContext } from './locale-screen-cursor-exemptions.ts'
export { isStyleValue } from './locale-style-values.ts'
export {
  isLocalizableGenericTerm,
  isCanonicalGenericRendering,
  canonicalGenericRenderings,
  overlapsCanonicalRendering
} from './locale-generic-ui-terms.ts'
export { mergeLocaleKeyOverrides } from './locale-key-override-merge.ts'
