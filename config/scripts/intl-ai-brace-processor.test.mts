import { describe, expect, it } from 'vitest'

import {
  INTL_AI_BRACE_PROCESSOR,
  INTL_AI_BRACE_PROCESSOR_NAME
} from './intl-ai-brace-processor.mts'

describe('intl-ai brace processor', () => {
  it('extracts single and multiple placeholders', () => {
    expect(INTL_AI_BRACE_PROCESSOR.extractTokens('Hello {{value0}}')).toEqual(['{{value0}}'])
    expect(INTL_AI_BRACE_PROCESSOR.extractTokens('{{value0}} of {{value1}}')).toEqual([
      '{{value0}}',
      '{{value1}}'
    ])
  })

  it('extracts placeholders across multiline strings', () => {
    expect(INTL_AI_BRACE_PROCESSOR.extractTokens('line1 {{value0}}\nline2 {{value1}}')).toEqual([
      '{{value0}}',
      '{{value1}}'
    ])
  })

  it('returns empty for strings without placeholders', () => {
    expect(INTL_AI_BRACE_PROCESSOR.extractTokens('no markers here')).toEqual([])
  })

  it('treats ICU lookalike single braces as pass-through tokens', () => {
    expect(INTL_AI_BRACE_PROCESSOR.extractTokens('{count, plural, other {items}}')).toEqual([])
    expect(INTL_AI_BRACE_PROCESSOR.validate('{count} items', '{count} éléments')).toEqual({
      valid: true
    })
  })

  it('validate passes when translated keeps every source placeholder', () => {
    expect(
      INTL_AI_BRACE_PROCESSOR.validate('Open {{value0}} now', 'Abrir {{value0}} ahora')
    ).toEqual({ valid: true })
  })

  it('validate rejects a dropped placeholder', () => {
    const result = INTL_AI_BRACE_PROCESSOR.validate('Open {{value0}} now', 'Abrir ahora')
    expect(result.valid).toBe(false)
    expect(result.errors?.[0]).toContain('{{value0}}')
  })

  it('validate rejects a renamed or reformatted placeholder', () => {
    const result = INTL_AI_BRACE_PROCESSOR.validate('Open {{value0}} now', 'Abrir {value0} ahora')
    expect(result.valid).toBe(false)
    expect(result.errors?.[0]).toContain('{{value0}}')
  })

  it('validate rejects placeholders invented by the model', () => {
    const result = INTL_AI_BRACE_PROCESSOR.validate('Open now', 'Abrir {{value0}} ahora')
    expect(result.valid).toBe(false)
    expect(result.errors?.[0]).toContain('{{value0}}')
  })

  it('getSyntaxHint mentions the double-brace form', () => {
    expect(INTL_AI_BRACE_PROCESSOR.getSyntaxHint()).toContain('{{value0}}')
  })

  it('exposes a stable processor name', () => {
    expect(INTL_AI_BRACE_PROCESSOR_NAME).toBe('orca-double-brace')
    expect(INTL_AI_BRACE_PROCESSOR.name).toBe(INTL_AI_BRACE_PROCESSOR_NAME)
  })
})
