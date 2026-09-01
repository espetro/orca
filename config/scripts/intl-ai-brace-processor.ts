import type { IntlAiProcessor } from '@intl-ai/api/internal'

// Portable-upstream: zero Orca-specific imports; a candidate for a builtin
// `processor: "double-brace"` option upstream (plan: upstream contribution 1).

export const INTL_AI_BRACE_PROCESSOR_NAME = 'orca-double-brace'

const BRACE_TOKEN_RE = /\{\{[^{}]+\}\}/g

export const INTL_AI_BRACE_PROCESSOR: IntlAiProcessor = {
  name: INTL_AI_BRACE_PROCESSOR_NAME,
  extractTokens(message): string[] {
    return message.match(BRACE_TOKEN_RE) ?? []
  },
  validate(source, translated) {
    const sourceTokens: string[] = source.match(BRACE_TOKEN_RE) ?? []
    const translatedTokens: string[] = translated.match(BRACE_TOKEN_RE) ?? []
    if (sourceTokens.length === 0) {
      if (translatedTokens.length === 0) {
        return { valid: true }
      }
      return {
        valid: false,
        errors: translatedTokens.map(
          (token) => `Unknown placeholder ${token} (not present in source)`
        )
      }
    }
    const missing = sourceTokens.filter((token) => !translatedTokens.includes(token))
    if (missing.length > 0) {
      return {
        valid: false,
        errors: missing.map((token) => `Missing placeholder ${token} in translation`)
      }
    }
    const unknown = translatedTokens.filter((token) => !sourceTokens.includes(token))
    if (unknown.length > 0) {
      return {
        valid: false,
        errors: unknown.map((token) => `Unknown placeholder ${token} (not present in source)`)
      }
    }
    return { valid: true }
  },
  getSyntaxHint() {
    return (
      'Placeholders look like {{value0}} (double curly braces). Keep every placeholder ' +
      'from the source EXACTLY as written, same name and braces, positioned naturally ' +
      'in the translated sentence. Never translate, rename, or reformat placeholders.'
    )
  }
}
