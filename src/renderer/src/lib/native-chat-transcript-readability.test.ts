import { describe, expect, it } from 'vitest'
import { isNativeChatTranscriptLocalReadable } from './native-chat-transcript-readability'

describe('native chat transcript readability', () => {
  it.each([
    [null, true],
    ['runtime-ssh-env-1', true],
    ['ssh-target-1', false],
    [undefined, false]
  ])('evaluates hostId %s -> %s', (hostId, expected) => {
    expect(isNativeChatTranscriptLocalReadable(hostId)).toBe(expected)
  })
})
