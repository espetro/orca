import { describe, expect, it } from 'vitest'

import {
  INTL_AI_DEFAULT_LOCALE,
  INTL_AI_LOCALES_DIR,
  INTL_AI_TARGET_LOCALES,
  buildIntlAiConfig
} from './intl-ai.config.mts'

describe('intl-ai orca config', () => {
  it('targets all four locales with en as source', () => {
    expect(INTL_AI_TARGET_LOCALES).toEqual(['es', 'ja', 'ko', 'zh'])
    expect(INTL_AI_DEFAULT_LOCALE).toBe('en')
  })

  it('maps localeDir to the renderer locales directory', () => {
    expect(INTL_AI_LOCALES_DIR).toBe('src/renderer/src/i18n/locales')
  })

  it('builds a config with the brace processor and free alias model', () => {
    const config = buildIntlAiConfig()
    expect(config.model).toBe('openrouter/free')
    expect(config.processor.name).toBe('orca-double-brace')
    expect(config.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(config.locales).toEqual(['en', 'es', 'ja', 'ko', 'zh'])
  })

  it('never embeds a real API key', () => {
    const config = buildIntlAiConfig()
    expect(config.apiKey).not.toMatch(/sk-/)
  })

  it('accepts an operator model override', () => {
    expect(buildIntlAiConfig({ model: 'google/gemini-2.0-flash-exp:free' }).model).toBe(
      'google/gemini-2.0-flash-exp:free'
    )
  })

  it('keeps a conservative batch size', () => {
    expect(buildIntlAiConfig().batchSize).toBeLessThanOrEqual(32)
  })
})
