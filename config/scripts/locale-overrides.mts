// One-stop registry for every locale override consumed by locale-translation-policy.mts.
// Barrel re-exports — preserves the per-file semantic split (regex arrays vs. per-en
// maps vs. per-key maps vs. helper functions) without inventing a single bag.

// ── per-locale value overrides (en → locale) ──────────────────────────────
export { JA_VALUE_OVERRIDES } from './locale-ja-value-overrides.mts'
export { KO_VALUE_OVERRIDES } from './locale-ko-value-overrides.mts'
export { ZH_VALUE_OVERRIDES } from './locale-zh-value-overrides.mts'

// ── per-locale phrase-fix regex arrays ────────────────────────────────────
export { JA_PHRASE_FIXES } from './locale-ja-phrase-fixes.mts'
export { KO_PHRASE_FIXES_ROUND4 } from './locale-ko-phrase-fixes.mts' // locale-phrase-fixes.mts spreads round4 + round5 internally
export { ZH_PHRASE_FIXES_ROUND5 } from './locale-zh-phrase-fixes-round5.mts'

// ── per-key overrides ────────────────────────────────────────────────────
export { CROSS_LOCALE_KEY_OVERRIDES } from './locale-cross-locale-key-overrides.mts'
export { JA_KEY_OVERRIDES } from './locale-ja-key-overrides.mts'
export { KO_KEY_OVERRIDES } from './locale-ko-key-overrides.mts'
export { MACOS_TCC_KEY_OVERRIDES } from './locale-macos-tcc-key-overrides.mts'

// ── aggregated records the orchestrator publishes ─────────────────────────
export { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mts'
export { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mts'
export { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.mts'

// ── brand / generic-term tables ───────────────────────────────────────────
export { BRAND_MISTRANSLATIONS } from './locale-brand-mistranslations.mts'
export { LOCALIZABLE_GENERIC_TERMS } from './locale-generic-ui-terms.mts'
export { CJK_LATIN_SPACED_TERMS } from './locale-cjk-latin-spaced-terms.mts'

// ── pure helpers ──────────────────────────────────────────────────────────
export { isScreenCursorContext } from './locale-screen-cursor-exemptions.mts'
export { isStyleValue } from './locale-style-values.mts'
export {
  isLocalizableGenericTerm,
  isCanonicalGenericRendering,
  canonicalGenericRenderings,
  overlapsCanonicalRendering
} from './locale-generic-ui-terms.mts'
export { mergeLocaleKeyOverrides } from './locale-key-override-merge.mts'
