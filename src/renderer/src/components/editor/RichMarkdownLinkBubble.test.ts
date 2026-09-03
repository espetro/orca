import { describe, expect, it } from 'vitest'
import { isLinkEditCancelShortcut } from './RichMarkdownLinkBubble'

describe('isLinkEditCancelShortcut', () => {
  it.each([
    [{ key: 'k', metaKey: true, ctrlKey: false }, true, true],
    [{ key: 'k', metaKey: false, ctrlKey: true }, true, false],
    [{ key: 'k', metaKey: false, ctrlKey: true }, false, true],
    [{ key: 'k', metaKey: true, ctrlKey: false }, false, false],
    [{ key: 'Escape', metaKey: false, ctrlKey: false }, true, false]
  ])('evaluates event %j with isMac=%s -> %s', (event, isMac, expected) => {
    expect(isLinkEditCancelShortcut(event, isMac)).toBe(expected)
  })
})
