import type { IntlAiConfig } from '@intl-ai/api'

import { INTL_AI_BRACE_PROCESSOR } from './intl-ai-brace-processor.ts'
import { OPENROUTER_BASE_URL, OPENROUTER_FREE_ALIAS } from './intl-ai-model-policy.ts'

export const INTL_AI_LOCALES_DIR = 'src/renderer/src/i18n/locales'
export const INTL_AI_DEFAULT_LOCALE = 'en'
export const INTL_AI_TARGET_LOCALES = ['es', 'ja', 'ko', 'zh'] as const

export type IntlAiTargetLocale = (typeof INTL_AI_TARGET_LOCALES)[number]

export type IntlAiOrcaConfig = Omit<IntlAiConfig, 'apiKey' | 'processor'> & {
  apiKey: string
  processor: typeof INTL_AI_BRACE_PROCESSOR
}

export function buildIntlAiConfig(overrides?: {
  model?: string
  batchSize?: number
}): IntlAiOrcaConfig {
  return {
    defaultLocale: INTL_AI_DEFAULT_LOCALE,
    locales: [INTL_AI_DEFAULT_LOCALE, ...INTL_AI_TARGET_LOCALES],
    localeDir: INTL_AI_LOCALES_DIR,
    provider: 'openai',
    baseURL: OPENROUTER_BASE_URL,
    model: overrides?.model ?? OPENROUTER_FREE_ALIAS,
    apiKey: 'resolved-at-runtime-by-intl-ai-env',
    processor: INTL_AI_BRACE_PROCESSOR,
    maxRetries: 3,
    batchSize: overrides?.batchSize ?? 24,
    quality: { threshold: 0.8, maxRetries: 2 }
  }
}
