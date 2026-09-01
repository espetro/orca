import { describe, expect, it } from 'vitest'

import {
  OPENROUTER_BASE_URL,
  OPENROUTER_FREE_ALIAS,
  OPENROUTER_PINNED_FREE_MODELS,
  isModelAllowlisted,
  resolveModelPolicy
} from './intl-ai-model-policy.mts'

describe('intl-ai model policy', () => {
  it('allows the free alias', () => {
    expect(resolveModelPolicy(OPENROUTER_FREE_ALIAS, false)).toEqual({
      kind: 'allowed',
      model: OPENROUTER_FREE_ALIAS
    })
  })

  it('allows every pinned free model', () => {
    expect(OPENROUTER_PINNED_FREE_MODELS.length).toBeGreaterThanOrEqual(2)
    for (const model of OPENROUTER_PINNED_FREE_MODELS) {
      expect(resolveModelPolicy(model, false)).toEqual({ kind: 'allowed', model })
    }
  })

  it('refuses a non-allowlisted model without --allow-paid', () => {
    const decision = resolveModelPolicy('anthropic/claude-sonnet-4', false)
    expect(decision.kind).toBe('refused')
    if (decision.kind === 'refused') {
      expect(decision.reason).toContain('--allow-paid')
    }
  })

  it('accepts a non-allowlisted model with --allow-paid', () => {
    expect(resolveModelPolicy('anthropic/claude-sonnet-4', true)).toEqual({
      kind: 'allowed',
      model: 'anthropic/claude-sonnet-4'
    })
  })

  it('isModelAllowlisted keys on the :free suffix', () => {
    expect(isModelAllowlisted('some-provider/whatever:free')).toBe(true)
    expect(isModelAllowlisted('some-provider/whatever')).toBe(false)
    expect(isModelAllowlisted(OPENROUTER_FREE_ALIAS)).toBe(true)
  })

  it('pins the OpenRouter base URL', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })
})
