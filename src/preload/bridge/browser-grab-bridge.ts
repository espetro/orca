import { ipcRenderer } from 'electron'
import type {
  BrowserCaptureSelectionScreenshotArgs,
  BrowserExtractHoverArgs,
  BrowserSetGrabModeArgs
} from '../../shared/browser-grab-types'
import type { BrowserApi } from '../api/browser-api'

export const browserGrabBridge: Pick<
  BrowserApi,
  | 'cancelDownload'
  | 'setGrabMode'
  | 'awaitGrabSelection'
  | 'cancelGrab'
  | 'captureSelectionScreenshot'
  | 'extractHoverPayload'
  | 'onGrabModeToggle'
  | 'onGrabActionShortcut'
> = {
  cancelDownload: (args: { downloadId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:cancelDownload', args),

  setGrabMode: (args: BrowserSetGrabModeArgs) => ipcRenderer.invoke('browser:setGrabMode', args),

  awaitGrabSelection: (args: { browserPageId: string; opId: string }) =>
    ipcRenderer.invoke('browser:awaitGrabSelection', args),

  cancelGrab: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:cancelGrab', args),

  captureSelectionScreenshot: (args: BrowserCaptureSelectionScreenshotArgs) =>
    ipcRenderer.invoke('browser:captureSelectionScreenshot', args),

  extractHoverPayload: (args: BrowserExtractHoverArgs) =>
    ipcRenderer.invoke('browser:extractHoverPayload', args),

  onGrabModeToggle: (callback: (browserPageId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, browserPageId: string) =>
      callback(browserPageId)
    ipcRenderer.on('browser:grabModeToggle', listener)
    return () => ipcRenderer.removeListener('browser:grabModeToggle', listener)
  },

  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; key: 'c' | 's' }
    ) => callback(data)
    ipcRenderer.on('browser:grabActionShortcut', listener)
    return () => ipcRenderer.removeListener('browser:grabActionShortcut', listener)
  }
}
