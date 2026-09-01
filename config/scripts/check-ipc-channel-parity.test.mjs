import { describe, expect, it } from 'vitest'
import {
  computeParity,
  isAllowlisted,
  resolveChannelArgForTest
} from './check-ipc-channel-parity.mjs'

/** @param {string} channel @param {string} kind @returns {import('./check-ipc-channel-parity.mjs').ChannelSite} */
function site(channel, kind) {
  return { channel, file: 'fixture.ts', line: 1, kind }
}

describe('ipc channel parity guard', () => {
  it('passes when both sides declare identical channel sets', () => {
    const report = computeParity(
      [site('app:reload', 'preload-invoke'), site('pty:data', 'preload-listen')],
      [site('app:reload', 'main-handle'), site('pty:data', 'main-listen')],
      { patterns: [], channels: {} }
    )
    expect(report.preloadOnly).toHaveLength(0)
    expect(report.mainOnly).toHaveLength(0)
  })

  it('flags a preload channel missing on the main side', () => {
    const report = computeParity(
      [site('app:reload', 'preload-invoke'), site('git:status', 'preload-invoke')],
      [site('app:reload', 'main-handle')],
      { patterns: [], channels: {} }
    )
    expect(report.preloadOnly.map((entry) => entry.channel)).toEqual(['git:status'])
    expect(report.mainOnly).toHaveLength(0)
  })

  it('flags a main channel missing on the preload side', () => {
    const report = computeParity(
      [site('app:reload', 'preload-invoke')],
      [site('app:reload', 'main-handle'), site('star-nag:show', 'main-listen')],
      { patterns: [], channels: {} }
    )
    expect(report.mainOnly.map((entry) => entry.channel)).toEqual(['star-nag:show'])
  })

  it('exacts allowlisted channels and dynamic patterns from both directions', () => {
    const allowlist = {
      patterns: [{ pattern: '^runtime:subscription:', reason: 'dynamic subscription channels' }],
      channels: { 'export:requestPdf': { reason: 'orphaned listener' } }
    }
    const report = computeParity(
      [site('runtime:subscription:abc', 'preload-listen'), site('export:requestPdf', 'preload-listen')],
      [site('export:requestPdf', 'main-listen')],
      allowlist
    )
    expect(report.preloadOnly).toHaveLength(0)
    expect(report.mainOnly).toHaveLength(0)
    expect(isAllowlisted('runtime:subscription:xyz', allowlist)).toBe(true)
    expect(isAllowlisted('export:requestPdf', allowlist)).toBe(true)
    expect(isAllowlisted('git:status', allowlist)).toBe(false)
  })

  it('does not exempt a renamed channel just because a similar one is allowlisted', () => {
    const allowlist = { patterns: [], channels: { 'export:requestPdf': { reason: 'orphaned' } } }
    const report = computeParity(
      [site('export:requestPdfTypo', 'preload-listen')],
      [],
      allowlist
    )
    expect(report.preloadOnly).toHaveLength(1)
  })

  it('resolves quoted literals, channel constants and rejects dynamic expressions', () => {
    const constants = new Map([['DOC_PREVIEW_MINT_GRANT_CHANNEL', 'docPreview:mintGrant']])
    expect(resolveChannelArgForTest("'git:status'", constants)).toBe('git:status')
    expect(resolveChannelArgForTest('DOC_PREVIEW_MINT_GRANT_CHANNEL', constants)).toBe('docPreview:mintGrant')
    expect(resolveChannelArgForTest('UNKNOWN_CONSTANT', constants)).toBeNull()
    expect(resolveChannelArgForTest('`git:${action}`', constants)).toBeNull()
  })
})
