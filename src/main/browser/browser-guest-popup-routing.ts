import { randomUUID } from 'node:crypto'

import { shell } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import type { BrowserPopupEvent } from '../../shared/browser-guest-events'
import {
  BROWSER_CLICKED_LINK_ROUTING_WORLD_ID,
  buildBrowserClickedLinkRoutingScript,
  buildBrowserIframeClickedLinkRoutingScript
} from './browser-clicked-link-routing'
import type { resolveBrowserRouteGuestPopupOpener } from './browser-route-guest-popup-ownership'
import {
  createPageInitiatedTabBudget,
  type PageInitiatedTabBudget
} from './browser-page-initiated-tab-budget'
import { isNewBrowserTabPopupIntent } from './browser-popup-new-tab-intent'
import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'

export type PopupOwnerContext = {
  browserTabId: string
  rootGuestWebContentsId: number
}

export function isChromiumInternalErrorUrl(url: string): boolean {
  return url.startsWith('chrome-error://')
}

export function safeOrigin(rawUrl: string): string {
  const external = normalizeExternalBrowserUrl(rawUrl)
  const urlToParse = external ?? rawUrl
  try {
    return new URL(urlToParse).origin
  } catch {
    return external ?? 'unknown'
  }
}

const SAFE_POPUP_WINDOW_OPTIONS = {
  alwaysOnTop: false,
  closable: true,
  focusable: true,
  frame: true,
  fullscreen: false,
  kiosk: false,
  modal: false,
  movable: true,
  opacity: 1,
  show: true,
  simpleFullscreen: false,
  skipTaskbar: false,
  titleBarStyle: 'default',
  transparent: false,
  // Why: Electron applies these before createWindow; feature strings/opener inheritance must not relax the child's isolation.
  webPreferences: {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false
  }
} satisfies Electron.BrowserWindowConstructorOptions

export type GuestPopupRoutingPorts = {
  /** tabIdByWebContentsId — guest id to owning tab id. */
  resolveTabIdForGuest(guestWebContentsId: number): string | undefined
  resolveWebContentsIdForTab(browserTabId: string): number | undefined
  resolveRoutePopupOpener: typeof resolveBrowserRouteGuestPopupOpener
  tryConsumePageInitiatedTab(rootGuestWebContentsId: number): boolean
  openLinkInOrcaTab(browserTabId: string, rawUrl: string): boolean
  forwardOrQueuePopupEvent(
    guestWebContentsId: number,
    event: Omit<BrowserPopupEvent, 'browserPageId'>
  ): void
  attachGuestPolicies(guest: Electron.WebContents, ownerContext: PopupOwnerContext | null): void
  createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): Electron.WebContents
}

export class GuestPopupRoutingController {
  private readonly ownerContextByGuestId = new Map<number, PopupOwnerContext>()
  private readonly clickedLinkFrameNameByGuestId = new Map<number, string>()
  private readonly pageInitiatedTabBudgetByRootGuestId = new Map<number, PageInitiatedTabBudget>()

  constructor(private readonly ports: GuestPopupRoutingPorts) {}

  setInheritedOwnerContext(guestId: number, ownerContext: PopupOwnerContext): void {
    this.ownerContextByGuestId.set(guestId, ownerContext)
  }

  getOwnerContext(guestWebContentsId: number): PopupOwnerContext | null {
    const browserTabId = this.ports.resolveTabIdForGuest(guestWebContentsId)
    if (browserTabId) {
      return { browserTabId, rootGuestWebContentsId: guestWebContentsId }
    }
    // Route popups live in an Orca-built window, so they never pass through did-create-window and
    // have no inherited context; their owning page comes from the route popup registry instead.
    const routeOpenerWebContentsId = this.ports.resolveRoutePopupOpener(guestWebContentsId)
    if (routeOpenerWebContentsId !== null) {
      const openerTabId = this.ports.resolveTabIdForGuest(routeOpenerWebContentsId)
      return openerTabId
        ? { browserTabId: openerTabId, rootGuestWebContentsId: routeOpenerWebContentsId }
        : null
    }
    const inherited = this.ownerContextByGuestId.get(guestWebContentsId)
    if (
      inherited &&
      this.ports.resolveWebContentsIdForTab(inherited.browserTabId) ===
        inherited.rootGuestWebContentsId
    ) {
      return inherited
    }
    this.ownerContextByGuestId.delete(guestWebContentsId)
    return null
  }

  getClickedLinkFrameName(guestId: number): string | undefined {
    return this.clickedLinkFrameNameByGuestId.get(guestId)
  }

  /** True only for the guest's own (non-inherited) owner context. */
  hasDirectOwnerContext(guestWebContentsId: number): boolean {
    return this.ownerContextByGuestId.has(guestWebContentsId)
  }

  // Why: tests inspect attach-time popup state through the manager without reaching into this controller.
  get testOwnerContextByGuestId(): Map<number, PopupOwnerContext> {
    return this.ownerContextByGuestId
  }

  get testClickedLinkFrameNameByGuestId(): Map<number, string> {
    return this.clickedLinkFrameNameByGuestId
  }

  /** Shared across the whole opener tree, so a chain of popups draws from one budget. */
  tryConsumePageInitiatedTab(rootGuestWebContentsId: number): boolean {
    let budget = this.pageInitiatedTabBudgetByRootGuestId.get(rootGuestWebContentsId)
    if (!budget) {
      budget = createPageInitiatedTabBudget()
      this.pageInitiatedTabBudgetByRootGuestId.set(rootGuestWebContentsId, budget)
    }
    return budget.tryConsume(Date.now())
  }

  createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): Electron.WebContents {
    const popup = openPopupWithOriginBar(options, targetUrl)
    // Why: Electron emits no did-create-window for createWindow children, so attach the opener's policies here.
    this.ports.attachGuestPolicies(popup.contentWebContents, this.getOwnerContext(openerGuest.id))
    this.ports.forwardOrQueuePopupEvent(openerGuest.id, {
      origin: safeOrigin(targetUrl),
      action: 'opened-in-orca'
    })
    // Why: match Electron's child-window lifecycle so closing the owning tab doesn't orphan session-bearing popups.
    const closePopupWithOpener = (): void => popup.close()
    openerGuest.once('destroyed', closePopupWithOpener)
    popup.onClosed(() => {
      if (!openerGuest.isDestroyed()) {
        openerGuest.off('destroyed', closePopupWithOpener)
      }
    })
    return popup.contentWebContents
  }

  /**
   * Install clicked-link routing listeners and the window-open policy on a freshly attached browsing guest.
   * Returns the partial cleanup that drops this controller's listeners (frame/link-routing state).
   */
  installPopupAndClickedLinkRouting(guest: Electron.WebContents): () => void {
    // Why: only the primary embedded browser converts new-tab clicks to Orca tabs; OAuth child windows keep native link behavior.
    const clickedLinkFrameName = `__orca_clicked_link_foreground_${randomUUID()}`
    this.clickedLinkFrameNameByGuestId.set(guest.id, clickedLinkFrameName)
    let clickedLinkRoutingActive = true

    const pendingIframeRoutingInstalls = new Map<Electron.WebFrameMain, () => void>()
    const iframeFrameNameByFrame = new Map<Electron.WebFrameMain, string>()
    const iframeFrameByFrameName = new Map<string, Electron.WebFrameMain>()
    const clearIframeFrameName = (frame: Electron.WebFrameMain): void => {
      const name = iframeFrameNameByFrame.get(frame)
      if (!name) {
        return
      }
      iframeFrameNameByFrame.delete(frame)
      iframeFrameByFrameName.delete(name)
    }
    const installIframeClickedLinkRouting = (frame: Electron.WebFrameMain): void => {
      clearIframeFrameName(frame)
      if (!clickedLinkRoutingActive || frame.isDestroyed()) {
        return
      }
      const name = `__orca_clicked_link_iframe_foreground_${randomUUID()}`
      iframeFrameNameByFrame.set(frame, name)
      iframeFrameByFrameName.set(name, frame)
      // Why: child-frame tokens live in the page world, so consume after one trusted click and replace before the next.
      void frame
        .executeJavaScript(
          buildBrowserIframeClickedLinkRoutingScript(name, process.platform === 'darwin'),
          false
        )
        .catch(() => {
          if (iframeFrameNameByFrame.get(frame) === name) {
            clearIframeFrameName(frame)
          }
        })
    }
    const installClickedLinkRouting = (): void => {
      if (!clickedLinkRoutingActive || !clickedLinkFrameName || guest.isDestroyed()) {
        return
      }
      // Why: an isolated-world listener labels real anchor clicks without exposing the frame name to page scripts.
      void guest
        .executeJavaScriptInIsolatedWorld(
          BROWSER_CLICKED_LINK_ROUTING_WORLD_ID,
          [
            {
              // Why: mobile emulation spoofs the UA as iOS, so use the real host platform from main for modifier routing.
              code: buildBrowserClickedLinkRoutingScript(
                clickedLinkFrameName,
                process.platform === 'darwin'
              )
            }
          ],
          false
        )
        .catch(() => {})
    }
    guest.on('dom-ready', installClickedLinkRouting)

    const handleFrameCreated = (
      _event: Electron.Event,
      { frame }: Electron.FrameCreatedDetails
    ): void => {
      if (!clickedLinkFrameName || !frame || frame.parent === null) {
        return
      }
      for (const knownFrame of iframeFrameNameByFrame.keys()) {
        if (knownFrame.isDestroyed()) {
          clearIframeFrameName(knownFrame)
        }
      }
      const installAfterDomReady = (): void => {
        pendingIframeRoutingInstalls.delete(frame)
        installIframeClickedLinkRouting(frame)
      }
      pendingIframeRoutingInstalls.set(frame, installAfterDomReady)
      frame.once('dom-ready', installAfterDomReady)
    }
    guest.on('frame-created', handleFrameCreated)

    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Why: popup descendants inherit the opener's owner context but must not replace its primary registration.
      this.ports.attachGuestPolicies(window.webContents, this.getOwnerContext(guest.id))
    }
    guest.on('did-create-window', handleDidCreateWindow)

    guest.setWindowOpenHandler(({ url, frameName, disposition, features }) => {
      const ownerContext = this.getOwnerContext(guest.id)
      const browserTabId = ownerContext?.browserTabId ?? null
      const browserUrl = normalizeBrowserNavigationUrl(url)
      const externalUrl = normalizeExternalBrowserUrl(url)
      const expectedClickedLinkFrameName = this.clickedLinkFrameNameByGuestId.get(guest.id)
      const iframeFrame = frameName ? iframeFrameByFrameName.get(frameName) : undefined
      let isClickedLink = Boolean(
        expectedClickedLinkFrameName && frameName === expectedClickedLinkFrameName
      )
      if (!isClickedLink && iframeFrame) {
        isClickedLink = true
        clearIframeFrameName(iframeFrame)
        queueMicrotask(() => installIframeClickedLinkRouting(iframeFrame))
      }

      if (isClickedLink) {
        if (browserTabId && browserUrl && this.ports.openLinkInOrcaTab(browserTabId, browserUrl)) {
          this.ports.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(browserUrl),
            action: 'opened-in-orca'
          })
        }
        // Why: a recognized gesture must never fall through to a native popup if its renderer vanished mid-click.
        return { action: 'deny' }
      }

      // Why: an unnamed, featureless window.open() is Chromium's own new-tab shape, so an Orca tab is
      // the honest presentation; a floating origin-bar window is not. Opener-dependent shapes are
      // excluded by isNewBrowserTabPopupIntent and still get a real child window below.
      if (
        ownerContext &&
        externalUrl &&
        isNewBrowserTabPopupIntent({ frameName, disposition, features })
      ) {
        // Why: one activation lets a page loop window.open, and each routed tab persists into
        // workspace session state, so it survives the quit that used to clear popup windows.
        if (!this.tryConsumePageInitiatedTab(ownerContext.rootGuestWebContentsId)) {
          this.ports.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(externalUrl),
            action: 'blocked'
          })
          return { action: 'deny' }
        }
        if (this.ports.openLinkInOrcaTab(ownerContext.browserTabId, externalUrl)) {
          this.ports.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(externalUrl),
            action: 'opened-in-orca'
          })
        }
        // Why: a recognized new-tab intent must never fall through to a native popup if its renderer vanished mid-open.
        return { action: 'deny' }
      }

      // Why: file URLs are fine for in-pane previews, but must not spawn native child windows targeting local paths.
      const canOpenAsChild = Boolean(externalUrl || browserUrl === ORCA_BROWSER_BLANK_URL)
      if (browserTabId && canOpenAsChild) {
        // Why: OAuth may request size/position, but content must not create deceptive or inescapable native chrome.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
          // Why: default child windows lack an address bar; host in an Orca origin-bar window so the destination is verifiable.
          createWindow: (options: PopupChildWindowOptions) =>
            this.ports.createPopupChildWindowWithOriginBar(guest, url, options)
        }
      } else if (externalUrl) {
        // Why: Kagi target=_blank popup URLs still contain the bearer token; redact before handing to the OS browser.
        void shell.openExternal(redactKagiSessionToken(externalUrl))
        this.ports.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else {
        // Why: popup URLs can carry auth redirects/one-time tokens; surface only sanitized origin metadata.
        this.ports.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(url),
          action: 'blocked'
        })
      }
      return { action: 'deny' }
    })

    return () => {
      clickedLinkRoutingActive = false
      this.clickedLinkFrameNameByGuestId.delete(guest.id)
      try {
        guest.off('dom-ready', installClickedLinkRouting)
        guest.off('frame-created', handleFrameCreated)
        guest.off('did-create-window', handleDidCreateWindow)
        for (const [frame, install] of pendingIframeRoutingInstalls) {
          if (!frame.isDestroyed()) {
            frame.off('dom-ready', install)
          }
        }
        pendingIframeRoutingInstalls.clear()
        iframeFrameNameByFrame.clear()
        iframeFrameByFrameName.clear()
      } catch {
        // guest may already be destroyed
      }
    }
  }

  forgetGuest(guestWebContentsId: number): void {
    this.clickedLinkFrameNameByGuestId.delete(guestWebContentsId)
    this.ownerContextByGuestId.delete(guestWebContentsId)
    this.pageInitiatedTabBudgetByRootGuestId.delete(guestWebContentsId)
    // Why: a popup must stop inheriting authorization the moment its owner retires, before Chromium destroys the child.
    for (const [popupGuestId, owner] of this.ownerContextByGuestId) {
      if (owner.rootGuestWebContentsId === guestWebContentsId) {
        this.ownerContextByGuestId.delete(popupGuestId)
      }
    }
  }

  clearAll(): void {
    this.ownerContextByGuestId.clear()
    this.clickedLinkFrameNameByGuestId.clear()
    this.pageInitiatedTabBudgetByRootGuestId.clear()
  }
}
