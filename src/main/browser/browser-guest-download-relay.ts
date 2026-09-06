import { randomUUID } from 'node:crypto'

import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent
} from '../../shared/browser-guest-events'
import type { BrowserClientDownloadRoute } from './browser-client-download-relay'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { routeBrowserClientDownload } from './browser-client-download-routing'

export type PendingDownloadEvent = Omit<BrowserDownloadRequestedEvent, 'browserPageId'>
type BrowserDownloadDoneState = 'completed' | 'cancelled' | 'interrupted'

export type ActiveDownload = {
  downloadId: string
  guestWebContentsId: number
  browserTabId: string | null
  rendererWebContentsId: number | null
  origin: string
  filename: string
  totalBytes: number | null
  mimeType: string | null
  item: Electron.DownloadItem
  savePath: string
  reservationKey: string | null
  clientRoute: BrowserClientDownloadRoute | null
  remoteDestination: BrowserDownloadFinishedEvent['remoteDestination']
  receivedBytes: number
  transientState: BrowserDownloadProgressEvent['state']
  terminalEvent: BrowserDownloadFinishedEvent | null
  startedSent: boolean
  cleanup: (() => void) | null
}

export type GuestDownloadRelayPorts = {
  /** Owner context for the guest (tab binding); null before registration. */
  resolveOwnerContext(guestWebContentsId: number): {
    browserTabId: string
    rootGuestWebContentsId: number
  } | null
  resolveRendererForBrowserTab(browserTabId: string): Electron.WebContents | null
  resolveRendererWebContentsIdForTab(browserTabId: string): number | null
}

/**
 * Guest-initiated download lifecycle: destination routing, per-tab binding, and
 * started/progress/finished replay to the renderer.
 */
export class GuestDownloadRelay {
  private readonly downloadsById = new Map<string, ActiveDownload>()
  private readonly pendingDownloadIdsByGuestId = new Map<number, string[]>()

  constructor(private readonly ports: GuestDownloadRelayPorts) {}

  listDownloads(): Map<string, ActiveDownload> {
    return this.downloadsById
  }

  /** Called when the manager learns which tab a guest belongs to. */
  handleGuestWillDownload(args: { guestWebContentsId: number; item: Electron.DownloadItem }): void {
    const { guestWebContentsId, item } = args
    const downloadId = randomUUID()
    const requestedFilename = (() => {
      try {
        return item.getFilename() || 'download'
      } catch {
        return 'download'
      }
    })()
    const totalBytes = (() => {
      try {
        const total = item.getTotalBytes()
        return total > 0 ? total : null
      } catch {
        return null
      }
    })()
    const mimeType = (() => {
      try {
        const mime = item.getMimeType()
        return mime || null
      } catch {
        return null
      }
    })()
    const origin = safeOriginOf(item)

    // Why: a client-hosted page's bytes belong on the remote workspace, so main stages them itself
    // instead of reserving a name in the desktop Downloads folder. A popup downloads to its
    // opener's page: the popup itself is a client-local transient with no logical page of its own.
    const ownerContext = this.ports.resolveOwnerContext(guestWebContentsId)
    const decision = routeBrowserClientDownload({
      guestWebContentsId: ownerContext?.rootGuestWebContentsId ?? guestWebContentsId
    })
    const clientRoute = decision.kind === 'remote' ? decision.route : null
    const destination = (() => {
      if (clientRoute) {
        return {
          filename: requestedFilename,
          savePath: clientRoute.stagingPath,
          reservationKey: null
        }
      }
      // Why: a client-hosted download with no resolvable remote destination is canceled rather than
      // written to this desktop's Downloads folder.
      if (decision.kind === 'blocked') {
        return null
      }
      try {
        return browserDownloadDestinationReservations.reserve(requestedFilename)
      } catch (error) {
        console.error('[browser-download] Failed to choose download destination:', error)
        return null
      }
    })()

    const fallbackSavePath = destination?.savePath ?? ''

    const download: ActiveDownload = {
      downloadId,
      guestWebContentsId,
      browserTabId: null,
      rendererWebContentsId: null,
      origin,
      filename: destination?.filename ?? requestedFilename,
      totalBytes,
      mimeType,
      item,
      savePath: fallbackSavePath,
      reservationKey: destination?.reservationKey ?? null,
      clientRoute,
      remoteDestination: undefined,
      receivedBytes: 0,
      transientState: null,
      terminalEvent: null,
      startedSent: false,
      cleanup: null
    }
    this.downloadsById.set(downloadId, download)

    const browserTabId = ownerContext?.browserTabId ?? null
    if (browserTabId) {
      this.bindDownloadToTab(downloadId, browserTabId)
    } else {
      const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId) ?? []
      pending.push(downloadId)
      this.pendingDownloadIdsByGuestId.set(guestWebContentsId, pending)
    }

    if (!destination) {
      this.finishDownloadInternal(
        downloadId,
        'failed',
        decision.kind === 'blocked'
          ? 'Could not save the download to the remote workspace.'
          : 'Could not choose a Downloads file name.'
      )
      try {
        item.cancel()
      } catch {
        // Why: with no destination Chromium must not keep writing invisibly; cancel is best-effort after surfacing the failure.
      }
      return
    }

    try {
      item.setSavePath(destination.savePath)
    } catch (error) {
      console.error('[browser-download] Failed to set download destination:', error)
      this.finishDownloadInternal(downloadId, 'failed', 'Failed to set download destination.')
      try {
        item.cancel()
      } catch {
        // Why: a failed setSavePath can leave Electron partially finalized; cancel is best-effort after the UI is made terminal.
      }
      return
    }

    const updatedHandler = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => {
      download.receivedBytes = this.getDownloadReceivedBytes(download.item)
      download.transientState = state
      this.sendDownloadProgress(download.browserTabId, {
        browserPageId: download.browserTabId ?? undefined,
        downloadId: download.downloadId,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        state
      })
    }
    const doneHandler = (_event: Electron.Event, state: BrowserDownloadDoneState): void => {
      const status: BrowserDownloadFinishedEvent['status'] =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'canceled' : 'failed'
      const failure =
        status === 'failed'
          ? state === 'interrupted'
            ? 'Download was interrupted.'
            : 'Download failed.'
          : null
      if (download.clientRoute) {
        void this.settleClientHostedDownload(download, status, failure)
        return
      }
      this.finishDownloadInternal(download.downloadId, status, failure)
    }
    download.cleanup = (): void => {
      try {
        download.item.off('updated', updatedHandler)
        download.item.off('done', doneHandler)
      } catch {
        // Why: a completed DownloadItem may already be finalized; keep cleanup best-effort so teardown never crashes main.
      }
    }
    item.on('updated', updatedHandler)
    item.once('done', doneHandler)

    if (browserTabId) {
      this.sendDownloadStarted(downloadId)
    }
  }

  cancelDownload(args: { downloadId: string; senderWebContentsId: number }): boolean {
    const download = this.downloadsById.get(args.downloadId)
    if (!download || download.rendererWebContentsId !== args.senderWebContentsId) {
      return false
    }
    this.cancelDownloadInternal(args.downloadId, 'Canceled.')
    return true
  }

  bindDownloadToTab(downloadId: string, browserTabId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    download.browserTabId = browserTabId
    download.rendererWebContentsId = this.ports.resolveRendererWebContentsIdForTab(browserTabId)
  }

  flushPendingDownloadRequests(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    for (const downloadId of pending) {
      this.bindDownloadToTab(downloadId, browserTabId)
      this.flushDownloadSnapshot(downloadId)
    }
  }

  flushDownloadSnapshot(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    this.sendDownloadStarted(downloadId)
    if (download.receivedBytes > 0 || download.transientState) {
      this.sendDownloadProgress(download.browserTabId, {
        browserPageId: download.browserTabId ?? undefined,
        downloadId: download.downloadId,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        state: download.transientState
      })
    }
    if (download.terminalEvent) {
      this.sendDownloadFinished(download.browserTabId, {
        ...download.terminalEvent,
        browserPageId: download.browserTabId ?? undefined
      })
      this.downloadsById.delete(downloadId)
    }
  }

  private sendDownloadStarted(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download?.browserTabId) {
      return
    }
    if (download.startedSent) {
      return
    }
    const renderer = this.ports.resolveRendererForBrowserTab(download.browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-requested', {
      browserPageId: download.browserTabId,
      downloadId: download.downloadId,
      origin: download.origin,
      filename: download.filename,
      totalBytes: download.totalBytes,
      mimeType: download.mimeType,
      savePath: download.savePath,
      status: 'downloading'
    } satisfies BrowserDownloadRequestedEvent)
    download.startedSent = true
  }

  private sendDownloadProgress(
    browserTabId: string | null,
    payload: BrowserDownloadProgressEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.ports.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-progress', payload)
  }

  private sendDownloadFinished(
    browserTabId: string | null,
    payload: BrowserDownloadFinishedEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.ports.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-finished', payload)
  }

  private async settleClientHostedDownload(
    download: ActiveDownload,
    status: BrowserDownloadFinishedEvent['status'],
    failure: string | null
  ): Promise<void> {
    const route = download.clientRoute
    if (!route) {
      return
    }
    if (status !== 'completed') {
      download.clientRoute = null
      await route.abort().catch(() => undefined)
      this.finishDownloadInternal(download.downloadId, status, failure)
      return
    }
    try {
      // Why: the route stays on the record for the whole commit, which spans many round trips -- a
      // cancel arriving mid-stream has to find something to abort or the bytes land anyway.
      const remoteDestination = await route.complete(download.filename)
      download.clientRoute = null
      download.remoteDestination = remoteDestination
      // Why: the staged copy is deleted, so a client save path would name a file that no longer exists.
      download.savePath = ''
      this.finishDownloadInternal(download.downloadId, 'completed', null)
    } catch (error) {
      download.clientRoute = null
      if (download.terminalEvent) {
        // A cancel already reported the outcome; this rejection is that cancel taking effect.
        return
      }
      console.error('[browser-download] Failed to save download to the remote workspace:', error)
      this.finishDownloadInternal(
        download.downloadId,
        'failed',
        'Could not save the download to the remote workspace.'
      )
    }
  }

  cancelDownloadInternal(downloadId: string, reason: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    const shouldSendCancel = !download.terminalEvent

    try {
      download.item.cancel()
    } catch {
      // Why: cancel() can throw on an already-finalized item; best-effort since UI state is authoritative.
    }

    if (shouldSendCancel) {
      this.finishDownloadInternal(downloadId, 'canceled', reason || null)
      return
    }

    this.downloadsById.delete(downloadId)
  }

  finishDownloadInternal(
    downloadId: string,
    status: BrowserDownloadFinishedEvent['status'],
    error: string | null
  ): void {
    const download = this.downloadsById.get(downloadId)
    if (!download || download.terminalEvent) {
      return
    }

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    browserDownloadDestinationReservations.release(download.reservationKey)
    download.reservationKey = null
    if (download.clientRoute) {
      // Why: a cancel path can reach here before the relay settled; the staged copy must not survive.
      void download.clientRoute.abort().catch(() => undefined)
      download.clientRoute = null
    }
    const event: BrowserDownloadFinishedEvent = {
      browserPageId: download.browserTabId ?? undefined,
      downloadId: download.downloadId,
      status,
      savePath: download.savePath || null,
      ...(download.remoteDestination ? { remoteDestination: download.remoteDestination } : {}),
      error
    }
    download.terminalEvent = event
    if (download.browserTabId) {
      this.sendDownloadStarted(downloadId)
      this.sendDownloadFinished(download.browserTabId, event)
      this.downloadsById.delete(downloadId)
    }
  }

  cancelPendingDownloadsForGuest(guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    for (const downloadId of pending) {
      const download = this.downloadsById.get(downloadId)
      if (!download) {
        continue
      }
      if (download.terminalEvent) {
        this.downloadsById.delete(downloadId)
        continue
      }
      this.cancelDownloadInternal(downloadId, 'Browser page closed before download could be shown.')
      const afterCancel = this.downloadsById.get(downloadId)
      if (afterCancel?.terminalEvent && !afterCancel.browserTabId) {
        this.downloadsById.delete(downloadId)
      }
    }
  }

  cancelAll(reason: string): void {
    for (const downloadId of this.downloadsById.keys()) {
      this.cancelDownloadInternal(downloadId, reason)
    }
  }

  private getDownloadReceivedBytes(item: Electron.DownloadItem): number {
    try {
      return Math.max(0, item.getReceivedBytes())
    } catch {
      return 0
    }
  }
}

function safeOriginOf(item: Electron.DownloadItem): string {
  try {
    const external = item.getURL()
    try {
      return new URL(external).origin
    } catch {
      return external || 'unknown'
    }
  } catch {
    return 'unknown'
  }
}
