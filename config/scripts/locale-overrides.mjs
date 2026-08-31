// One-stop registry for every locale override consumed by locale-translation-policy.mjs.
// Barrel re-exports — preserves the per-file semantic split (regex arrays vs. per-en
// maps vs. per-key maps vs. helper functions) without inventing a single bag.

// ── per-locale value overrides (en → locale) ──────────────────────────────
export { JA_VALUE_OVERRIDES } from './locale-ja-value-overrides.mjs'
export { KO_VALUE_OVERRIDES } from './locale-ko-value-overrides.mjs'
export { ZH_VALUE_OVERRIDES } from './locale-zh-value-overrides.mjs'

// ── per-locale phrase-fix regex arrays ────────────────────────────────────
export { JA_PHRASE_FIXES } from './locale-ja-phrase-fixes.mjs'
export { KO_PHRASE_FIXES_ROUND4 } from './locale-ko-phrase-fixes.mjs' // locale-phrase-fixes.mjs spreads round4 + round5 internally
export { ZH_PHRASE_FIXES_ROUND5 } from './locale-zh-phrase-fixes-round5.mjs'

// ── per-key overrides ────────────────────────────────────────────────────
export { CROSS_LOCALE_KEY_OVERRIDES } from './locale-cross-locale-key-overrides.mjs'
export { JA_KEY_OVERRIDES } from './locale-ja-key-overrides.mjs'
export { KO_KEY_OVERRIDES } from './locale-ko-key-overrides.mjs'
export { MACOS_TCC_KEY_OVERRIDES } from './locale-macos-tcc-key-overrides.mjs'

// ── aggregated records the orchestrator publishes ─────────────────────────
export { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mjs'
export { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mjs'
export { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.mjs'

// ── brand / generic-term tables ───────────────────────────────────────────
export { BRAND_MISTRANSLATIONS } from './locale-brand-mistranslations.mjs'
export { LOCALIZABLE_GENERIC_TERMS } from './locale-generic-ui-terms.mjs'
export { CJK_LATIN_SPACED_TERMS } from './locale-cjk-latin-spaced-terms.mjs'

// ── pure helpers ──────────────────────────────────────────────────────────
export { isScreenCursorContext } from './locale-screen-cursor-exemptions.mjs'
export { isStyleValue } from './locale-style-values.mjs'
export {
  isLocalizableGenericTerm,
  isCanonicalGenericRendering,
  canonicalGenericRenderings,
  overlapsCanonicalRendering
} from './locale-generic-ui-terms.mjs'
export { mergeLocaleKeyOverrides } from './locale-key-override-merge.mjs'
