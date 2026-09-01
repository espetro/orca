import { ipcRenderer } from 'electron'
import { readBrowserClientHostIdArgument } from '../../shared/browser-client-host-id-argument'
import { createBrowserClientPageRendererRequests } from '../browser-client-page-renderer-requests'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import type {
  BrowserWebAuthnAccountRequest,
  BrowserWebAuthnAccountResponse
} from '../../shared/browser-webauthn-account'
import type { BrowserApi } from '../api/browser-api'

export const browserPageBridge: Pick<
  BrowserApi,
  | 'onClientPageRendererRequest'
  | 'readClientHostId'
  | 'registerGuest'
  | 'isGuestRegistered'
  | 'repairGuestRegistration'
  | 'unregisterGuest'
  | 'onWebAuthnAccountRequest'
  | 'onWebAuthnAccountRequestClosed'
  | 'respondWebAuthnAccount'
  | 'openDevTools'
  | 'setViewportOverride'
  | 'setAnnotationViewportBridge'
  | 'publishClientPageMetadata'
  | 'onGuestLoadFailed'
  | 'onCertificateFailureChanged'
  | 'proceedCertificate'
  | 'onPermissionDenied'
  | 'onPopup'
  | 'onDownloadRequested'
  | 'onDownloadProgress'
  | 'onDownloadFinished'
  | 'onContextMenuRequested'
  | 'onContextMenuDismissed'
  | 'onNavigationUpdate'
  | 'onActivateView'
  | 'onPaneFocus'
  | 'onOpenLinkInOrcaTab'
> = {
  onClientPageRendererRequest: createBrowserClientPageRendererRequests({
    ipc: ipcRenderer,
    isTopFrame: () => window.top === window
  }).subscribe,
  readClientHostId: (): string | null => readBrowserClientHostIdArgument(process.argv),
  registerGuest: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }): Promise<boolean> => ipcRenderer.invoke('browser:registerGuest', args),

  isGuestRegistered: (args: { browserPageId: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke('browser:isGuestRegistered', args),

  repairGuestRegistration: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }): Promise<boolean> => ipcRenderer.invoke('browser:repairGuestRegistration', args),

  unregisterGuest: (args: { browserPageId: string }): Promise<void> =>
    ipcRenderer.invoke('browser:unregisterGuest', args),

  onWebAuthnAccountRequest: (
    callback: (request: BrowserWebAuthnAccountRequest) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: BrowserWebAuthnAccountRequest
    ): void => callback(request)
    ipcRenderer.on('browser:webauthn-account-requested', listener)
    return () => ipcRenderer.removeListener('browser:webauthn-account-requested', listener)
  },

  onWebAuthnAccountRequestClosed: (
    callback: (event: { requestId: string }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }): void =>
      callback(data)
    ipcRenderer.on('browser:webauthn-account-request-closed', listener)
    return () => ipcRenderer.removeListener('browser:webauthn-account-request-closed', listener)
  },

  respondWebAuthnAccount: (response: BrowserWebAuthnAccountResponse): Promise<boolean> =>
    ipcRenderer.invoke('browser:respondWebAuthnAccount', response),

  openDevTools: (args: { browserPageId: string }): Promise<boolean> =>
    ipcRenderer.invoke('browser:openDevTools', args),

  setViewportOverride: (args: {
    browserPageId: string
    override: BrowserViewportOverride | null
  }): Promise<boolean> => ipcRenderer.invoke('browser:setViewportOverride', args),

  setAnnotationViewportBridge: (args): Promise<boolean> =>
    ipcRenderer.invoke('browser:setAnnotationViewportBridge', args),

  publishClientPageMetadata: (args) =>
    ipcRenderer.invoke('browser:publishClientPageMetadata', args),

  onGuestLoadFailed: (
    callback: (args: {
      browserPageId: string
      loadError: { code: number; description: string; validatedUrl: string }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        loadError: { code: number; description: string; validatedUrl: string }
      }
    ) => callback(data)
    ipcRenderer.on('browser:guest-load-failed', listener)
    return () => ipcRenderer.removeListener('browser:guest-load-failed', listener)
  },

  onCertificateFailureChanged: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => callback(data)
    ipcRenderer.on('browser:certificate-failure-changed', listener)
    return () => ipcRenderer.removeListener('browser:certificate-failure-changed', listener)
  },

  proceedCertificate: (args) => ipcRenderer.invoke('browser:proceedCertificate', args),

  onPermissionDenied: (
    callback: (event: { browserPageId: string; permission: string; origin: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; permission: string; origin: string }
    ) => callback(data)
    ipcRenderer.on('browser:permission-denied', listener)
    return () => ipcRenderer.removeListener('browser:permission-denied', listener)
  },

  onPopup: (
    callback: (event: {
      browserPageId: string
      origin: string
      action: 'opened-in-orca' | 'opened-external' | 'blocked'
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        origin: string
        action: 'opened-in-orca' | 'opened-external' | 'blocked'
      }
    ) => callback(data)
    ipcRenderer.on('browser:popup', listener)
    return () => ipcRenderer.removeListener('browser:popup', listener)
  },

  onDownloadRequested: (
    callback: (event: {
      browserPageId: string
      downloadId: string
      origin: string
      filename: string
      totalBytes: number | null
      mimeType: string | null
      savePath: string
      status: 'downloading'
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        downloadId: string
        origin: string
        filename: string
        totalBytes: number | null
        mimeType: string | null
        savePath: string
        status: 'downloading'
      }
    ) => callback(data)
    ipcRenderer.on('browser:download-requested', listener)
    return () => ipcRenderer.removeListener('browser:download-requested', listener)
  },

  onDownloadProgress: (
    callback: (event: {
      browserPageId?: string
      downloadId: string
      receivedBytes: number
      totalBytes: number | null
      state: 'progressing' | 'interrupted' | null
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId?: string
        downloadId: string
        receivedBytes: number
        totalBytes: number | null
        state: 'progressing' | 'interrupted' | null
      }
    ) => callback(data)
    ipcRenderer.on('browser:download-progress', listener)
    return () => ipcRenderer.removeListener('browser:download-progress', listener)
  },

  onDownloadFinished: (
    callback: (event: {
      browserPageId?: string
      downloadId: string
      status: 'completed' | 'canceled' | 'failed'
      savePath: string | null
      remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
      error: string | null
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId?: string
        downloadId: string
        status: 'completed' | 'canceled' | 'failed'
        savePath: string | null
        remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
        error: string | null
      }
    ) => callback(data)
    ipcRenderer.on('browser:download-finished', listener)
    return () => ipcRenderer.removeListener('browser:download-finished', listener)
  },

  onContextMenuRequested: (
    callback: (event: {
      browserPageId: string
      x: number
      y: number
      screenX: number
      screenY: number
      pageUrl: string
      linkUrl: string | null
      selectionText: string
      canGoBack: boolean
      canGoForward: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        browserPageId: string
        x: number
        y: number
        screenX: number
        screenY: number
        pageUrl: string
        linkUrl: string | null
        selectionText: string
        canGoBack: boolean
        canGoForward: boolean
      }
    ) => callback(data)
    ipcRenderer.on('browser:context-menu-requested', listener)
    return () => ipcRenderer.removeListener('browser:context-menu-requested', listener)
  },

  onContextMenuDismissed: (callback: (event: { browserPageId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { browserPageId: string }) =>
      callback(data)
    ipcRenderer.on('browser:context-menu-dismissed', listener)
    return () => ipcRenderer.removeListener('browser:context-menu-dismissed', listener)
  },

  onNavigationUpdate: (
    callback: (event: { browserPageId: string; url: string; title: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; url: string; title: string }
    ) => callback(data)
    ipcRenderer.on('browser:navigation-update', listener)
    return () => ipcRenderer.removeListener('browser:navigation-update', listener)
  },

  onActivateView: (
    callback: (data: { worktreeId?: string; browserPageId?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId?: string; browserPageId?: string }
    ) => callback(data)
    ipcRenderer.on('browser:activateView', listener)
    return () => ipcRenderer.removeListener('browser:activateView', listener)
  },

  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId: string | null; browserPageId: string }
    ) => callback(data)
    ipcRenderer.on('browser:pane-focus', listener)
    return () => ipcRenderer.removeListener('browser:pane-focus', listener)
  },

  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { browserPageId: string; url: string }
    ) => callback(data)
    ipcRenderer.on('browser:open-link-in-orca-tab', listener)
    return () => ipcRenderer.removeListener('browser:open-link-in-orca-tab', listener)
  }
}
