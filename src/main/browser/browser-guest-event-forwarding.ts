import type {
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../shared/browser-guest-events'
import { redactKagiSessionToken } from '../../shared/browser-url'

export type PendingPermissionEvent = Omit<BrowserPermissionDeniedEvent, 'browserPageId'>
export type PendingPopupEvent = Omit<BrowserPopupEvent, 'browserPageId'>
export type GuestLoadFailure = { code: number; description: string; validatedUrl: string }

export type GuestEventForwardingPorts = {
  resolveRendererForBrowserTab(browserTabId: string): Electron.WebContents | null
  resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId: number): string | null
}

/**
 * Renderer event delivery for guests that may fire before tab registration: forward when the
 * renderer is known, otherwise queue by guest id and replay on registration.
 */
export class GuestEventForwarding {
  private readonly pendingLoadFailuresByGuestId = new Map<number, GuestLoadFailure>()
  private readonly pendingPermissionEventsByGuestId = new Map<number, PendingPermissionEvent[]>()
  private readonly pendingPopupEventsByGuestId = new Map<number, PendingPopupEvent[]>()

  constructor(private readonly ports: GuestEventForwardingPorts) {}

  forwardOrQueueGuestLoadFailure(guestWebContentsId: number, loadError: GuestLoadFailure): void {
    const browserTabId = this.ports.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      // Why: a failure can arrive before the tab is registered; queue by guest ID so registerGuest can replay it.
      this.pendingLoadFailuresByGuestId.set(guestWebContentsId, loadError)
      return
    }
    this.sendGuestLoadFailure(browserTabId, loadError)
  }

  flushPendingLoadFailure(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingLoadFailuresByGuestId.get(guestWebContentsId)
    if (!pending) {
      return
    }
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.sendGuestLoadFailure(browserTabId, pending)
  }

  clearPendingLoadFailure(guestWebContentsId: number): void {
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
  }

  private sendGuestLoadFailure(browserTabId: string, loadError: GuestLoadFailure): void {
    const renderer = this.ports.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }

    // Why: redact Kagi session tokens before the renderer persists validatedUrl to disk.
    renderer.send('browser:guest-load-failed', {
      browserPageId: browserTabId,
      loadError: {
        ...loadError,
        validatedUrl: redactKagiSessionToken(loadError.validatedUrl)
      }
    })
  }

  forwardOrQueuePermissionDenied(guestWebContentsId: number, event: PendingPermissionEvent): void {
    const browserTabId = this.ports.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPermissionEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPermissionDenied(browserTabId, event)
  }

  flushPendingPermissionEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPermissionDenied(browserTabId, event)
    }
  }

  private sendPermissionDenied(browserTabId: string, event: PendingPermissionEvent): void {
    const renderer = this.ports.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:permission-denied', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPermissionDeniedEvent)
  }

  forwardOrQueuePopupEvent(guestWebContentsId: number, event: PendingPopupEvent): void {
    const browserTabId = this.ports.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPopupEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPopupEvent(browserTabId, event)
  }

  flushPendingPopupEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPopupEvent(browserTabId, event)
    }
  }

  private sendPopupEvent(browserTabId: string, event: PendingPopupEvent): void {
    const renderer = this.ports.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:popup', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPopupEvent)
  }

  clearForGuest(guestWebContentsId: number): void {
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
  }

  clearAll(): void {
    this.pendingLoadFailuresByGuestId.clear()
    this.pendingPermissionEventsByGuestId.clear()
    this.pendingPopupEventsByGuestId.clear()
  }
}
