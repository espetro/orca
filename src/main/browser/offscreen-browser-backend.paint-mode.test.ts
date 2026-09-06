import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  webPreferencesByWindow: [] as Record<string, unknown>[],
  paintMode: 'auto' as 'auto' | 'always'
}))

class MockWebContents {
  readonly id: number

  constructor(id: number) {
    this.id = id
  }

  setBackgroundThrottling(): void {}

  once(): void {}
}

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly webContents: MockWebContents
    constructor(options: { webPreferences: Record<string, unknown> }) {
      mocks.webPreferencesByWindow.push(options.webPreferences)
      this.webContents = new MockWebContents(mocks.webPreferencesByWindow.length)
    }
    isDestroyed(): boolean {
      return false
    }
    on(): void {}
  }
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: vi.fn(() => ({ id: 'default', partition: 'persist:orca-browser' }))
  }
}))
vi.mock('./serve-browser-settings', () => ({
  resolveServeBrowserPaintMode: () => mocks.paintMode
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'

describe('OffscreenBrowserBackend paintWhenInitiallyHidden', () => {
  let backend: OffscreenBrowserBackend

  beforeEach(() => {
    mocks.webPreferencesByWindow.length = 0
    backend = new OffscreenBrowserBackend({
      registerOffscreenGuest: vi.fn(() => true)
    } as never)
  })

  it('passes paintWhenInitiallyHidden: false in auto mode', async () => {
    mocks.paintMode = 'auto'
    await backend.createTab({ url: 'https://example.com' })
    expect(mocks.webPreferencesByWindow[0].paintWhenInitiallyHidden).toBe(false)
  })

  it('omits paintWhenInitiallyHidden in always mode', async () => {
    mocks.paintMode = 'always'
    await backend.createTab({ url: 'https://example.com' })
    expect('paintWhenInitiallyHidden' in mocks.webPreferencesByWindow[0]).toBe(false)
  })
})
