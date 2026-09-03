import { describe, expect, it } from 'vitest'
import {
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

describe('hosted review Ready capabilities', () => {
  it.each([
    ['GitHub', GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY],
    ['GitLab', GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY]
  ])('advertises %s mutation contract (%s)', (_name, capability) => {
    expect(RUNTIME_CAPABILITIES).toContain(capability)
  })
})
