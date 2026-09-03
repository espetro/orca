import { describe, expect, it } from 'vitest'
import {
  getExpectedPreloadProperties,
  getImplementedWebPreloadProperties,
  verifyPreloadParity
} from './check-web-preload-parity.ts'

describe('check-web-preload-parity', () => {
  it('extracts all expected properties from PreloadApi', () => {
    const properties = getExpectedPreloadProperties()
    expect(properties.length).toBeGreaterThanOrEqual(80)
    expect(properties).toContain('projects')
    expect(properties).toContain('folderWorkspaces')
    expect(properties).toContain('speech')
    expect(properties).toContain('pet')
  })

  it('extracts implemented properties from createWebPreloadApi', () => {
    const properties = getImplementedWebPreloadProperties()
    expect(properties.length).toBeGreaterThanOrEqual(80)
    expect(properties).toContain('projects')
    expect(properties).toContain('folderWorkspaces')
    expect(properties).toContain('speech')
    expect(properties).toContain('pet')
  })

  it('achieves 100% parity between PreloadApi and createWebPreloadApi', () => {
    const result = verifyPreloadParity()
    expect(result.missing).toEqual([])
    expect(result.totalImplemented).toBe(result.totalExpected)
  })
})
