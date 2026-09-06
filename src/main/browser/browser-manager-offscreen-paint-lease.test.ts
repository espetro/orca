import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const { guestSetBackgroundThrottlingMock, guestOffMock, guestOnMock,
  guestSetWindowOpenHandlerMock, guestOpenDevToolsMock, webContentsFromIdMock } = browserMocks

function makeOffscreenGuest(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: guestSetWindowOpenHandlerMock,
    on: guestOnMock,
    off: guestOffMock,
    openDevTools: guestOpenDevToolsMock
  }
}

describe('browserManager offscreen paint lease', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  it('re-throttles an offscreen guest at registration and toggles throttling across acquire/release', () => {
    const guest = makeOffscreenGuest(3301)
    webContentsFromIdMock.mockImplementation((id: number) => (id === guest.id ? guest : null))

    const registered = browserManager.registerOffscreenGuest({
      browserPageId: 'page-offscreen-lease',
      webContentsId: guest.id
    })
    expect(registered).toBe(true)
    // attachGuestPolicies disables throttling; offscreen registration immediately re-enables it.
    expect(guestSetBackgroundThrottlingMock.mock.calls).toEqual([[false], [true]])

    const release = browserManager.acquireOffscreenPaint(guest.id)
    expect(guestSetBackgroundThrottlingMock).toHaveBeenLastCalledWith(false)

    release()
    expect(guestSetBackgroundThrottlingMock).toHaveBeenLastCalledWith(true)

    // Re-acquire after release still lifts throttling (frames delivered again on re-hide).
    const release2 = browserManager.acquireOffscreenPaint(guest.id)
    expect(guestSetBackgroundThrottlingMock).toHaveBeenLastCalledWith(false)
    release2()
    expect(guestSetBackgroundThrottlingMock).toHaveBeenLastCalledWith(true)
  })

  it('is a no-op for unknown or non-offscreen ids', () => {
    const release = browserManager.acquireOffscreenPaint(999999)
    expect(typeof release).toBe('function')
    expect(() => release()).not.toThrow()
  })

  it('returns an idempotent release per lease', () => {
    const guest = makeOffscreenGuest(3302)
    webContentsFromIdMock.mockImplementation((id: number) => (id === guest.id ? guest : null))
    browserManager.registerOffscreenGuest({
      browserPageId: 'page-offscreen-idempotent',
      webContentsId: guest.id
    })

    const first = browserManager.acquireOffscreenPaint(guest.id)
    const second = browserManager.acquireOffscreenPaint(guest.id)
    first()
    first()
    second()
    // Throttling is only re-enabled once the last lease is released.
    const calls = guestSetBackgroundThrottlingMock.mock.calls as [boolean][]
    // Registration: [false, true]. Leases: [false] then final [true].
    expect(calls).toEqual([[false], [true], [false], [true]])
    expect(guestSetBackgroundThrottlingMock).toHaveBeenLastCalledWith(true)
  })
})
