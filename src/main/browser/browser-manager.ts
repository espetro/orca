/* eslint-disable max-lines -- Why: single privileged facade for guest registration, authorization, and lifecycle cleanup; keeps the browser security boundary in one file. */
import type {
  BrowserCertificateFailure,
  BrowserLoadError,
  BrowserSessionUserAgentMode,
  BrowserViewportOverride
} from '../../shared/browser-workspace-types'
import type {
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserGrabScreenshot
} from '../../shared/browser-grab-types'
import type { KeybindingOverrides } from '../../shared/keybindings'
import {
  type BrowserAnnotationViewportBridgeOptions,
  BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
  buildBrowserAnnotationViewportBridgeScript
} from '../../shared/browser-annotation-viewport-bridge'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken,
  toSecureCertificateEndpoint
} from '../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { webContents } from 'electron'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import {
  BrowserCertificateTrustController,
  type ManagedBrowserGuestContext
} from './browser-certificate-trust-controller'
import { GuestDownloadRelay } from './browser-guest-download-relay'
import { GuestEventForwarding } from './browser-guest-event-forwarding'
import {
  GuestPopupRoutingController,
  isChromiumInternalErrorUrl,
  safeOrigin,
  type PopupOwnerContext
} from './browser-guest-popup-routing'
import { AuthUserAgentOverrideController } from './browser-auth-user-agent-override'
import { BrowserGrabSelectionController } from './browser-grab-selection-controller'
import { acquireAutomationVisibilityViaRenderer } from './browser-automation-visibility'
import {
  installDocPreviewGuestPolicy,
  isWorkspaceDocPageId,
  getWorkspaceDocPageGuest
} from './doc-preview-guest-policy'
import { resolveRendererWebContents } from './browser-guest-renderer-target'
import { setupGrabShortcutForwarding } from './browser-guest-grab-shortcuts'
import { setupGuestContextMenu } from './browser-guest-context-menu'
import { setupGuestMouseWheelZoomForwarding } from './browser-guest-wheel-zoom'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'
import { resolveBrowserRouteGuestPopupOpener } from './browser-route-guest-popup-ownership'
import { OffscreenPaintLease } from './offscreen-paint-lease'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'

export type BrowserGuestRegistration = {
  browserPageId?: string
  browserTabId?: string
  workspaceId?: string
  worktreeId?: string
  sessionProfileId?: string | null
  userAgentMode?: BrowserSessionUserAgentMode
  webContentsId: number
  rendererWebContentsId: number
}

export type BrowserGuestPolicy =
  | { profile: 'browsing' }
  | { profile: 'workspace-doc'; host: Electron.WebContents }
const BROWSING_GUEST_POLICY: BrowserGuestPolicy = { profile: 'browsing' }
type PendingMainFrameNavigation = {
  currentUrl: string
  supersededUrls: string[]
}

export class BrowserManager {
  private settingsResolver:
    | (() => {
        keybindings?: KeybindingOverrides
        mobileEmulatorEnabled?: boolean
      })
    | null = null
  private readonly offscreenPaintLease = new OffscreenPaintLease()
  private readonly webContentsIdByTabId = new Map<string, number>()
  // Why: reverse map gives O(1) guest→tab lookups on every mouse/load/permission/popup event.
  private readonly tabIdByWebContentsId = new Map<number, string>()
  // Why: keyed by the opener tree's root so named child popups can't each mint a fresh tab quota.
  private readonly workspaceIdByPageId = new Map<string, string>()
  private readonly sessionProfileIdByPageId = new Map<string, string | null>()
  private readonly userAgentModeByPageId = new Map<string, BrowserSessionUserAgentMode>()
  private readonly rendererWebContentsIdByTabId = new Map<string, number>()
  // Why: serialize per-tab setViewportOverride so rapid toggles don't interleave CDP commands and leave emulation in a wrong state.
  private readonly viewportOpsByTabId = new Map<string, Promise<unknown>>()
  // Why: presence means the preset requires a CDP UA override (installed or in flight), so navigation
  // can re-issue it against the target URL's identity.
  private readonly viewportUaOverrideMobileByTabId = new Map<string, boolean>()
  // Why: the in-flight main-frame navigation target, held only until commit or failure — getURL()
  // still reports the outgoing page until then. See resolveTabNavigationUrl.
  private readonly pendingNavigationByGuestId = new Map<number, PendingMainFrameNavigation>()
  private readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  private readonly grabShortcutCleanupByTabId = new Map<string, () => void>()
  private readonly shortcutForwardingCleanupByTabId = new Map<string, () => void>()
  private readonly mouseWheelZoomCleanupByTabId = new Map<string, () => void>()
  private readonly annotationViewportBridgeOpsByTabId = new Map<string, Promise<unknown>>()
  private readonly worktreeIdByTabId = new Map<string, string>()
  private readonly policyAttachedGuestIds = new Set<number>()
  private readonly offscreenGuestIds = new Set<number>()
  private readonly policyCleanupByGuestId = new Map<number, () => void>()
  private readonly loadErrorsByGuestId = new Map<number, BrowserLoadError>()
  // Why: did-start-navigation hides the overlay optimistically; stash the cleared error so did-fail-load(-3) can restore an aborted nav.
  private readonly clearedLoadErrorsByGuestId = new Map<number, BrowserLoadError>()
  private browserGuestStateChangedListener: ((worktreeId: string) => void) | null = null
  private certificateTrustController: BrowserCertificateTrustController | null = null
  private shouldForwardDictationShortcut: (() => boolean) | null = null
  private readonly popupRouting = new GuestPopupRoutingController({
    resolveTabIdForGuest: (guestId) => this.tabIdByWebContentsId.get(guestId),
    resolveWebContentsIdForTab: (tabId) => this.webContentsIdByTabId.get(tabId),
    resolveRoutePopupOpener: resolveBrowserRouteGuestPopupOpener,
    tryConsumePageInitiatedTab: (rootId) => this.popupRouting.tryConsumePageInitiatedTab(rootId),
    openLinkInOrcaTab: (tabId, url) => this.openLinkInOrcaTab(tabId, url),
    forwardOrQueuePopupEvent: (guestId, event) =>
      this.guestEvents.forwardOrQueuePopupEvent(guestId, event),
    attachGuestPolicies: (guest, ownerContext) =>
      this.attachGuestPolicies(guest, ownerContext, BROWSING_GUEST_POLICY),
    createPopupChildWindowWithOriginBar: (opener, url, options) =>
      this.popupRouting.createPopupChildWindowWithOriginBar(opener, url, options)
  })
  private readonly guestEvents = new GuestEventForwarding({
    resolveRendererForBrowserTab: (tabId) => this.resolveRendererForBrowserTab(tabId),
    resolveBrowserTabIdForGuestWebContentsId: (guestId) =>
      this.resolveBrowserTabIdForGuestWebContentsId(guestId)
  })
  private readonly downloadRelay = new GuestDownloadRelay({
    resolveOwnerContext: (guestId) => this.popupRouting.getOwnerContext(guestId),
    resolveRendererForBrowserTab: (tabId) => this.resolveRendererForBrowserTab(tabId),
    resolveRendererWebContentsIdForTab: (tabId) =>
      this.rendererWebContentsIdByTabId.get(tabId) ?? null
  })
  private readonly authUaOverride = new AuthUserAgentOverrideController({
    resolveDirectTabIdForGuest: (guestId) => this.tabIdByWebContentsId.get(guestId),
    resolveOwnerTabIdForGuest: (guestId) => this.resolveBrowserTabIdForGuestWebContentsId(guestId),
    userAgentModeByPageIdGet: (tabId) => this.userAgentModeByPageId.get(tabId),
    viewportUaOverrideMobileByTabIdGet: (tabId) => this.viewportUaOverrideMobileByTabId.get(tabId),
    sendViewportUserAgentOverride: (guest, mobile, url, baseUserAgent) =>
      this.authUaOverride.sendViewportUserAgentOverride(guest, mobile, url, baseUserAgent),
    resolveTabNavigationUrl: (guest) => this.resolveTabNavigationUrl(guest),
    reapplyViewportUserAgentOverride: (guest, tabId, url) =>
      this.reapplyViewportUserAgentOverride(guest, tabId, url)
  })
  private readonly grabSessionController = new BrowserGrabSelectionController()

  // Why: tests inspect per-guest popup state; these are the same maps the routing controller owns.
  get popupOwnerContextByGuestId(): Map<number, unknown> {
    return this.popupRouting.testOwnerContextByGuestId
  }
  get clickedLinkFrameNameByGuestId(): Map<number, string> {
    return this.popupRouting.testClickedLinkFrameNameByGuestId
  }

  setDictationShortcutForwardingPredicate(predicate: (() => boolean) | null): void {
    this.shouldForwardDictationShortcut = predicate
  }

  setBrowserGuestStateChangedListener(listener: ((worktreeId: string) => void) | null): void {
    this.browserGuestStateChangedListener = listener
  }

  setCertificateTrustController(controller: BrowserCertificateTrustController): void {
    this.certificateTrustController = controller
  }

  installCertificateRequestGuard(session: Electron.Session): void {
    this.certificateTrustController?.installSessionRequestGuard(session)
  }

  removeCertificateRequestGuard(session: Electron.Session): void {
    this.certificateTrustController?.removeSessionRequestGuard(session)
  }

  setSettingsResolver(
    resolver: () => {
      keybindings?: KeybindingOverrides
      mobileEmulatorEnabled?: boolean
    }
  ): void {
    this.settingsResolver = resolver
  }

  // Why: addScriptToEvaluateOnNewDocument (CDP) is the only reliable pre-page-script hook per nav; executeJavaScript ran on the old page context.
  private injectAntiDetection(guest: Electron.WebContents): () => void {
    let disposed = false
    let reattachTimer: ReturnType<typeof setTimeout> | null = null

    const attach = (): void => {
      if (disposed || guest.isDestroyed()) {
        return
      }
      try {
        if (!guest.debugger.isAttached()) {
          guest.debugger.attach('1.3')
        }
        void guest.debugger
          .sendCommand('Page.enable', {})
          .then(() =>
            guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
              source: ANTI_DETECTION_SCRIPT
            })
          )
          .catch(() => {})
      } catch {
        /* best-effort — debugger may be unavailable */
      }
    }

    // Why: proxy/bridge stop detaches the debugger and drops injections; re-attach (500ms delay to avoid racing a mid-restart) to keep overrides.
    const onDetach = (): void => {
      this.authUaOverride.forgetGuest(guest.id)
      if (!disposed && !guest.isDestroyed() && reattachTimer === null) {
        reattachTimer = setTimeout(() => {
          reattachTimer = null
          attach()
        }, 500)
      }
    }

    try {
      attach()
      guest.debugger.on('detach', onDetach)
    } catch {
      /* best-effort */
    }

    return () => {
      disposed = true
      if (reattachTimer !== null) {
        clearTimeout(reattachTimer)
        reattachTimer = null
      }
      try {
        guest.debugger.off('detach', onDetach)
      } catch {
        /* guest may already be destroyed */
      }
    }
  }

  private resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId: number): string | null {
    return this.popupRouting.getOwnerContext(guestWebContentsId)?.browserTabId ?? null
  }

  private resolveRendererForBrowserTab(browserTabId: string): Electron.WebContents | null {
    const rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (!rendererWebContentsId) {
      return null
    }
    const renderer = webContents.fromId(rendererWebContentsId)
    if (!renderer || renderer.isDestroyed()) {
      return null
    }
    return renderer
  }

  // Why: screenshots target page ids but visible chrome is keyed by workspace id; activate by workspace or the webview stays hidden and capture times out.
  async ensureWebviewVisible(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return () => {}
    }
    const browserWorkspaceId = this.workspaceIdByPageId.get(browserPageId) ?? browserPageId
    const worktreeId = this.worktreeIdByTabId.get(browserPageId) ?? null
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return () => {}
    }

    const prev = await renderer
      .executeJavaScript(
        `(function() {
          var store = window.__store;
          if (!store) return null;
          var state = store.getState();
          var prevTabType = state.activeTabType;
          var prevActiveWorktreeId = state.activeWorktreeId || null;
          var prevActiveBrowserWorkspaceId = state.activeBrowserTabId || null;
          var prevActiveBrowserPageId = null;
          var prevFocusedGroupTabId = null;
          var targetWorktreeId = ${JSON.stringify(worktreeId)};
          var browserWorkspaceId = ${JSON.stringify(browserWorkspaceId)};
          var browserPageId = ${JSON.stringify(browserPageId)};
          var browserTabsByWorktree = state.browserTabsByWorktree || {};

          if (prevActiveWorktreeId) {
            var prevFocusedGroupId = (state.activeGroupIdByWorktree || {})[prevActiveWorktreeId];
            var prevGroups = (state.groupsByWorktree || {})[prevActiveWorktreeId] || [];
            for (var pg = 0; pg < prevGroups.length; pg++) {
              if (prevGroups[pg].id === prevFocusedGroupId) {
                prevFocusedGroupTabId = prevGroups[pg].activeTabId;
                break;
              }
            }
          }

          if (prevActiveBrowserWorkspaceId) {
            for (var prevWtId in browserTabsByWorktree) {
              var prevBrowserTabs = browserTabsByWorktree[prevWtId] || [];
              for (var pbt = 0; pbt < prevBrowserTabs.length; pbt++) {
                if (prevBrowserTabs[pbt].id === prevActiveBrowserWorkspaceId) {
                  prevActiveBrowserPageId = prevBrowserTabs[pbt].activePageId || null;
                  break;
                }
              }
              if (prevActiveBrowserPageId) break;
            }
          }

          if (
            targetWorktreeId &&
            prevActiveWorktreeId !== targetWorktreeId &&
            typeof state.setActiveWorktree === 'function'
          ) {
            state.setActiveWorktree(targetWorktreeId);
            state = store.getState();
          }

          var foundWorkspace = null;
          for (var wtId in browserTabsByWorktree) {
            var tabs = browserTabsByWorktree[wtId] || [];
            for (var i = 0; i < tabs.length; i++) {
              if (tabs[i].id === browserWorkspaceId) {
                foundWorkspace = tabs[i];
                if (!targetWorktreeId) {
                  targetWorktreeId = wtId;
                }
                break;
              }
            }
            if (foundWorkspace) break;
          }

          var hasTargetPage = false;
          var targetPages = (state.browserPagesByWorkspace || {})[browserWorkspaceId] || [];
          for (var pageIndex = 0; pageIndex < targetPages.length; pageIndex++) {
            if (targetPages[pageIndex].id === browserPageId) {
              hasTargetPage = true;
              break;
            }
          }

          if (foundWorkspace) {
            if (typeof state.setActiveBrowserTab === 'function') {
              state.setActiveBrowserTab(browserWorkspaceId);
              state = store.getState();
            } else {
              var allTabs = state.unifiedTabsByWorktree || {};
              var found = null;
              for (var unifiedWtId in allTabs) {
                var unifiedTabs = allTabs[unifiedWtId] || [];
                for (var unifiedIndex = 0; unifiedIndex < unifiedTabs.length; unifiedIndex++) {
                  if (
                    unifiedTabs[unifiedIndex].contentType === 'browser' &&
                    unifiedTabs[unifiedIndex].entityId === browserWorkspaceId
                  ) {
                    found = unifiedTabs[unifiedIndex];
                    break;
                  }
                }
                if (found) break;
              }
              if (found) {
                state.activateTab(found.id);
              }
              state.setActiveTabType('browser');
              state = store.getState();
            }
            // Why: activating the workspace alone is not enough for screenshot
            // capture when a browser workspace contains multiple pages. The
            // compositor only paints the currently mounted page guest.
            if (
              hasTargetPage &&
              foundWorkspace.activePageId !== browserPageId &&
              typeof state.setActiveBrowserPage === 'function'
            ) {
              state.setActiveBrowserPage(browserWorkspaceId, browserPageId);
              state = store.getState();
            }
          }

          return {
            prevTabType: prevTabType,
            prevActiveWorktreeId: prevActiveWorktreeId,
            prevActiveBrowserWorkspaceId: prevActiveBrowserWorkspaceId,
            prevActiveBrowserPageId: prevActiveBrowserPageId,
            prevFocusedGroupTabId: prevFocusedGroupTabId,
            targetWorktreeId: targetWorktreeId,
            targetBrowserWorkspaceId: foundWorkspace ? browserWorkspaceId : null,
            targetBrowserPageId: foundWorkspace && hasTargetPage ? browserPageId : null
          };
        })()`
      )
      .catch(() => null)

    const needsRestore =
      prev &&
      (prev.prevTabType !== 'browser' ||
        prev.prevActiveWorktreeId !== prev.targetWorktreeId ||
        prev.prevFocusedGroupTabId !== null ||
        prev.prevActiveBrowserWorkspaceId !== prev.targetBrowserWorkspaceId ||
        prev.prevActiveBrowserPageId !== prev.targetBrowserPageId)

    if (!needsRestore) {
      return () => {}
    }

    return () => {
      if (!prev || !renderer || renderer.isDestroyed()) {
        return
      }
      renderer
        .executeJavaScript(
          `(function() {
            var store = window.__store;
            if (!store) return;
            var state = store.getState();
            if (
              ${JSON.stringify(prev?.prevActiveWorktreeId)} &&
              ${JSON.stringify(prev?.prevActiveWorktreeId)} !==
                ${JSON.stringify(prev?.targetWorktreeId)} &&
              typeof state.setActiveWorktree === 'function'
            ) {
              state.setActiveWorktree(${JSON.stringify(prev?.prevActiveWorktreeId)});
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} !==
                ${JSON.stringify(prev?.targetBrowserWorkspaceId)} &&
              typeof state.setActiveBrowserTab === 'function'
            ) {
              state.setActiveBrowserTab(${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)});
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserPageId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserPageId)} !==
                ${JSON.stringify(prev?.targetBrowserPageId)} &&
              typeof state.setActiveBrowserPage === 'function'
            ) {
              // Why: Orca remembers the last browser workspace/page even when
              // the user is currently in terminal/editor view. Screenshot prep
              // temporarily switches that hidden browser selection state, so
              // restore it independently of the visible tab type.
              state.setActiveBrowserPage(
                ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)},
                ${JSON.stringify(prev?.prevActiveBrowserPageId)}
              );
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevTabType)} !== 'browser' &&
              ${JSON.stringify(prev?.prevFocusedGroupTabId)}
            ) {
              state.activateTab(${JSON.stringify(prev?.prevFocusedGroupTabId)});
            }
            if (${JSON.stringify(prev?.prevTabType)} !== 'browser') {
              state.setActiveTabType(${JSON.stringify(prev?.prevTabType)});
            }
          })()`
        )
        .catch(() => {})
    }
  }

  /** Lifts background throttling on an offscreen guest while the returned release is held; no-op for unknown/destroyed ids. */
  acquireOffscreenPaint(webContentsId: number): () => void {
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed() || !this.offscreenGuestIds.has(webContentsId)) {
      return () => {}
    }
    return this.offscreenPaintLease.acquire(guest)
  }

  /** True while any screencast/screenshot lease pins the guest's paint output. */
  isPaintLeaseHeld(webContentsId: number): boolean {
    return this.offscreenPaintLease.isHeld(webContentsId)
  }

  async acquireAutomationVisibility(guestWebContentsId: number): Promise<() => void> {    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return () => {}
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return () => {}
    }
    return acquireAutomationVisibilityViaRenderer(renderer, browserPageId)
  }

  attachGuestPolicies(
    guest: Electron.WebContents,
    inheritedOwnerContext: PopupOwnerContext | null = null,
    policy: BrowserGuestPolicy = BROWSING_GUEST_POLICY
  ): void {
    if (this.policyAttachedGuestIds.has(guest.id)) {
      return
    }
    this.policyAttachedGuestIds.add(guest.id)
    // Why one door with a profile rather than a second installer beside it: whether a guest was
    // policy-attached at all is what registration and teardown both key on, so a guest that took
    // another path into the app is invisible to both.
    if (policy.profile === 'workspace-doc') {
      this.attachWorkspaceDocGuestPolicies(guest, policy.host)
      return
    }
    if (inheritedOwnerContext) {
      this.popupRouting.setInheritedOwnerContext(guest.id, inheritedOwnerContext)
    }
    // Why: bot detectors probe APIs that differ in Electron webviews; inject overrides each load so manual browsing passes.
    const disposeAntiDetection = this.injectAntiDetection(guest)
    // Why: disable throttling so background screenshots still get frames; else the compositor stalls and capture returns empty.
    guest.setBackgroundThrottling(false)
    // Why: offscreen guests are re-throttled so the paint lease governs their paint output; desktop webview guests keep it disabled.
    if (this.offscreenGuestIds.has(guest.id)) {
      guest.setBackgroundThrottling(true)
    }
    const detachPopupRouting = this.popupRouting.installPopupAndClickedLinkRouting(guest)

    const navigationGuard = (event: Electron.Event, url: string): boolean => {
      // Why: Turnstile loads challenge resources via blob:; blocking them trips error 600010. Allow only http(s) blobs, not opaque ones.
      if (url.startsWith('blob:https://') || url.startsWith('blob:http://')) {
        return true
      }
      // Why: initial file:// attach is allowed for user-opened previews, but block later file:// redirects so remote pages can't probe the FS.
      if (url.startsWith('file:')) {
        event.preventDefault()
        return false
      }
      if (!normalizeBrowserNavigationUrl(url)) {
        // Why: will-attach-webview only validates the initial src; keep enforcing the allowlist on later navs.
        event.preventDefault()
        return false
      }
      return true
    }

    const willRedirectHandler = (
      event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!navigationGuard(event, url) || !isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      this.updatePendingNavigationForRedirect(guest.id, url)
      this.applyGoogleAuthUserAgent(guest, url, { duringRedirect: true })
    }

    const didFailLoadHandler = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) {
        return
      }
      // Why: a nav that never committed must not leave its target standing as the tab's host.
      const failedNavigationWasCurrent = this.failPendingNavigation(guest.id, validatedURL)
      if (failedNavigationWasCurrent) {
        // The attempted host never committed, so restore every UA layer to the document that remains.
        this.applyGoogleAuthUserAgent(guest, guest.getURL())
      }
      const browserPageId = this.tabIdByWebContentsId.get(guest.id)
      const certificateFailure = browserPageId
        ? this.certificateTrustController?.getFailure(browserPageId)
        : null
      if (
        certificateFailure &&
        toSecureCertificateEndpoint(validatedURL || guest.getURL()) ===
          toSecureCertificateEndpoint(certificateFailure.origin)
      ) {
        // Why: this cancellation carries the existing cert warning; don't overwrite it with ERR_ABORTED copy.
        return
      }
      if (errorCode === -3) {
        // Why: an aborted nav never committed; restore the error did-start-navigation cleared so it isn't lost.
        const clearedError = this.clearedLoadErrorsByGuestId.get(guest.id)
        if (clearedError !== undefined) {
          this.clearedLoadErrorsByGuestId.delete(guest.id)
          this.loadErrorsByGuestId.set(guest.id, clearedError)
          this.guestEvents.forwardOrQueueGuestLoadFailure(guest.id, clearedError)
          this.notifyBrowserGuestStateChanged(guest.id)
        }
        return
      }
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      const loadError = this.buildLoadError(
        errorCode,
        errorDescription || 'This site could not be reached.',
        validatedURL || guest.getURL() || 'about:blank'
      )
      this.loadErrorsByGuestId.set(guest.id, loadError)
      this.guestEvents.forwardOrQueueGuestLoadFailure(guest.id, loadError)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didStartNavigationHandler = (
      _event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      // Why: getURL() still reports the previous committed URL until this navigation commits, so
      // every UA writer must read the in-flight target or they disagree about the tab's host.
      this.startPendingNavigation(guest.id, url)
      this.applyGoogleAuthUserAgent(guest, url)
      this.certificateTrustController?.onMainFrameNavigationStarted(guest.id)
      // Why: a pre-registration failure belongs only to its own nav; a replacement nav must not replay it.
      this.guestEvents.clearPendingLoadFailure(guest.id)
      const activeError = this.loadErrorsByGuestId.get(guest.id)
      if (activeError === undefined) {
        // Why: no error to hide; drop any stale stash so a later abort can't resurrect an old failure.
        this.clearedLoadErrorsByGuestId.delete(guest.id)
        return
      }
      this.clearedLoadErrorsByGuestId.set(guest.id, activeError)
      this.loadErrorsByGuestId.delete(guest.id)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didNavigateHandler = (_event: Electron.Event, url: string): void => {
      // Why: once committed, getURL() reports this url, so the pending target is redundant.
      this.pendingNavigationByGuestId.delete(guest.id)
      // Why: a committed nav makes the did-start-navigation stash obsolete; drop it so a later ERR_ABORTED can't restore an error over it.
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      this.certificateTrustController?.onMainFrameNavigationCommitted(guest.id, url)
    }

    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', willRedirectHandler)
    guest.on('did-start-navigation', didStartNavigationHandler)
    guest.on('did-navigate', didNavigateHandler)
    guest.on('did-fail-load', didFailLoadHandler)
    const handleDestroyed = (): void => {
      // Why: guests can die before renderer registration, else attach-time closures leak until shutdown.
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)

    // Why: store cleanup so unregisterGuest can drop these listeners on teardown and let the WebContents wrapper GC.
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeAntiDetection()
      detachPopupRouting()
      try {
        guest.off('destroyed', handleDestroyed)
      } catch {
        // guest may already be destroyed
      }
      if (!guest.isDestroyed()) {
        guest.off('will-navigate', navigationGuard)
        guest.off('will-redirect', willRedirectHandler)
        guest.off('did-start-navigation', didStartNavigationHandler)
        guest.off('did-navigate', didNavigateHandler)
        guest.off('did-fail-load', didFailLoadHandler)
      }
    })
  }

  /**
   * A workspace document is not the web: no popups, no link routing, no anti-detection, and no
   * navigation bookkeeping for chrome it does not have. What it does share with a browsing guest is
   * this method's teardown, so a retired preview drops its listeners on the same path.
   */
  private attachWorkspaceDocGuestPolicies(
    guest: Electron.WebContents,
    host: Electron.WebContents
  ): void {
    const disposeDocPolicy = installDocPreviewGuestPolicy(guest, host)
    const handleDestroyed = (): void => {
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDocPolicy()
      try {
        guest.off('destroyed', handleDestroyed)
      } catch {
        // guest may already be destroyed
      }
    })
  }

  private applyGoogleAuthUserAgent(
    guest: Electron.WebContents,
    url: string,
    options: { duringRedirect?: boolean } = {}
  ): void {
    this.authUaOverride.applyGoogleAuthUserAgent(guest, url, options)
  }

  private startPendingNavigation(guestId: number, url: string): void {
    const pending = this.pendingNavigationByGuestId.get(guestId)
    this.pendingNavigationByGuestId.set(guestId, {
      currentUrl: url,
      supersededUrls: pending ? [...pending.supersededUrls, pending.currentUrl] : []
    })
  }

  private updatePendingNavigationForRedirect(guestId: number, url: string): void {
    const pending = this.pendingNavigationByGuestId.get(guestId)
    if (!pending) {
      this.pendingNavigationByGuestId.set(guestId, {
        currentUrl: url,
        supersededUrls: []
      })
      return
    }
    pending.currentUrl = url
  }

  private failPendingNavigation(guestId: number, failedUrl: string): boolean {
    const pending = this.pendingNavigationByGuestId.get(guestId)
    if (!pending) {
      return false
    }
    const supersededIndex = pending.supersededUrls.indexOf(failedUrl)
    if (supersededIndex !== -1) {
      pending.supersededUrls.splice(supersededIndex, 1)
      return false
    }
    if (pending.currentUrl !== failedUrl) {
      return false
    }
    this.pendingNavigationByGuestId.delete(guestId)
    return true
  }

  // Why: webContents.getURL() reports the last COMMITTED url, so mid-navigation it names the host
  // the tab is leaving, not the one it is entering. Every UA writer must resolve the host through
  // here or two writers racing the same navigation will pick opposite identities.
  private resolveTabNavigationUrl(guest: Electron.WebContents): string {
    return this.pendingNavigationByGuestId.get(guest.id)?.currentUrl ?? guest.getURL()
  }

  // Why: Emulation.setUserAgentOverride is set once and stands across every later navigation,
  // outranking setUserAgent for navigator.userAgent. A viewport preset applied before reaching an
  // auth host would otherwise pin navigator.userAgent to the Chrome-shaped preset UA while the
  // request header says Firefox — the two-layer disagreement this scope exists to remove.
  private reapplyViewportUserAgentOverride(
    guest: Electron.WebContents,
    browserTabId: string,
    url: string
  ): void {
    const mobile = this.viewportUaOverrideMobileByTabId.get(browserTabId)
    if (mobile === undefined) {
      return
    }
    // Why: no queue needed — debugger.sendCommand dispatches in call order over one channel, so the
    // later-issued write wins. What matters is that both writers resolve the SAME host, which they
    // now do via the navigation target rather than the stale committed URL.
    void this.authUaOverride.sendViewportUserAgentOverride(guest, mobile, url).catch(() => {})
  }

  /** Route guests own their own popup handler, so their denials arrive here instead. */
  reportRouteGuestPopupBlocked(input: { openerWebContentsId: number; url: string }): void {
    this.guestEvents.forwardOrQueuePopupEvent(input.openerWebContentsId, {
      origin: safeOrigin(input.url),
      action: 'blocked'
    })
  }

  private retireStaleGuestWebContents(previousWebContentsId: number): void {
    // Why: after a renderer-process swap, stop the dead guest id resolving to the live page so stale callbacks don't hit the wrong session.
    this.cleanupGuestPolicyAttachment(previousWebContentsId)
  }

  private cleanupGuestPolicyAttachment(guestWebContentsId: number): void {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (browserTabId && this.webContentsIdByTabId.get(browserTabId) === guestWebContentsId) {
      this.webContentsIdByTabId.delete(browserTabId)
    }
    this.tabIdByWebContentsId.delete(guestWebContentsId)
    this.certificateTrustController?.onGuestRetired(guestWebContentsId)
    const policyCleanup = this.policyCleanupByGuestId.get(guestWebContentsId)
    if (policyCleanup) {
      policyCleanup()
      this.policyCleanupByGuestId.delete(guestWebContentsId)
    }
    this.policyAttachedGuestIds.delete(guestWebContentsId)
    this.offscreenGuestIds.delete(guestWebContentsId)
    this.popupRouting.forgetGuest(guestWebContentsId)
    this.authUaOverride.forgetGuest(guestWebContentsId)
    this.pendingNavigationByGuestId.delete(guestWebContentsId)
    this.guestEvents.clearForGuest(guestWebContentsId)
    this.downloadRelay.cancelPendingDownloadsForGuest(guestWebContentsId)
  }

  registerGuest({
    browserPageId,
    browserTabId: legacyBrowserTabId,
    workspaceId,
    worktreeId,
    sessionProfileId,
    userAgentMode,
    webContentsId,
    rendererWebContentsId
  }: BrowserGuestRegistration): boolean {
    const browserTabId = browserPageId ?? legacyBrowserTabId
    // Why refuse rather than overwrite: the two halves of the registry must stay disjoint, or one
    // id resolves in both and the tool door silently prefers the document guest over the page.
    if (!browserTabId || isWorkspaceDocPageId(browserTabId)) {
      return false
    }
    // Why: on guest-surface swap, cancel any grab bound to the old guest's listeners so it doesn't strand on a stale webContents.
    this.cancelGrabOp(browserTabId, 'evicted')

    const previousCleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }

    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }

    // Why: don't trust the renderer-sent id blindly — a compromised renderer could pass the main window's id; only accept webview guests.
    if (guest.getType() !== 'webview') {
      return false
    }
    if (!this.policyAttachedGuestIds.has(webContentsId)) {
      // Why: only trust guests that passed attach-time policy install, or a renderer could point us at an arbitrary webview.
      return false
    }

    const previousWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      this.retireStaleGuestWebContents(previousWebContentsId)
    }
    this.webContentsIdByTabId.set(browserTabId, webContentsId)
    this.tabIdByWebContentsId.set(webContentsId, browserTabId)
    if (workspaceId) {
      this.workspaceIdByPageId.set(browserTabId, workspaceId)
    }
    this.sessionProfileIdByPageId.set(browserTabId, sessionProfileId ?? null)
    if (userAgentMode) {
      this.userAgentModeByPageId.set(browserTabId, userAgentMode)
    } else {
      this.userAgentModeByPageId.delete(browserTabId)
    }
    this.rendererWebContentsIdByTabId.set(browserTabId, rendererWebContentsId)
    if (worktreeId) {
      this.worktreeIdByTabId.set(browserTabId, worktreeId)
    }
    this.certificateTrustController?.onGuestRegistered(webContentsId, browserTabId)

    this.setupContextMenu(browserTabId, guest)
    this.setupGrabShortcut(browserTabId, guest)
    this.setupShortcutForwarding(browserTabId, guest)
    this.setupMouseWheelZoomForwarding(browserTabId, guest)
    this.guestEvents.flushPendingLoadFailure(browserTabId, webContentsId)
    this.guestEvents.flushPendingPermissionEvents(browserTabId, webContentsId)
    this.guestEvents.flushPendingPopupEvents(browserTabId, webContentsId)
    this.downloadRelay.flushPendingDownloadRequests(browserTabId, webContentsId)
    return true
  }

  unregisterGuest(browserTabId: string): void {
    // Why the check on the exit door too: a document page withdraws by revoking its grant, never
    // through here, so its id arriving is misaddressed — and the cancel below would evict that
    // preview's live grab on the strength of it.
    if (isWorkspaceDocPageId(browserTabId)) {
      return
    }
    // Why: teardown mid-grab must cancel it so the renderer gets a signal, not a dangling Promise.
    this.cancelGrabOp(browserTabId, 'evicted')

    // Why: remove attachGuestPolicies listeners so their guest-WebContents closures don't block GC.
    const guestWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (guestWebContentsId !== undefined) {
      this.cleanupGuestPolicyAttachment(guestWebContentsId)
    }

    const cleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (cleanup) {
      cleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }
    const shortcutCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (shortcutCleanup) {
      shortcutCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }
    const fwdCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (fwdCleanup) {
      fwdCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }
    const mouseWheelZoomCleanup = this.mouseWheelZoomCleanupByTabId.get(browserTabId)
    if (mouseWheelZoomCleanup) {
      mouseWheelZoomCleanup()
      this.mouseWheelZoomCleanupByTabId.delete(browserTabId)
    }
    // Why: downloads are per-tab chrome; closing the tab must cancel active writes, not orphan them.
    for (const [downloadId, download] of this.downloadRelay.listDownloads().entries()) {
      if (download.browserTabId === browserTabId && !download.terminalEvent) {
        this.downloadRelay.cancelDownloadInternal(
          downloadId,
          'Tab closed before download completed.'
        )
      }
    }
    const wcId = this.webContentsIdByTabId.get(browserTabId)
    if (wcId !== undefined) {
      this.tabIdByWebContentsId.delete(wcId)
    }
    this.webContentsIdByTabId.delete(browserTabId)
    this.rendererWebContentsIdByTabId.delete(browserTabId)
    this.workspaceIdByPageId.delete(browserTabId)
    this.sessionProfileIdByPageId.delete(browserTabId)
    this.userAgentModeByPageId.delete(browserTabId)
    this.worktreeIdByTabId.delete(browserTabId)
    // Why: drop the viewport-op chain so the Map doesn't retain a promise keyed to a destroyed guest.
    this.viewportOpsByTabId.delete(browserTabId)
    this.viewportUaOverrideMobileByTabId.delete(browserTabId)
    if (wcId !== undefined) {
      this.pendingNavigationByGuestId.delete(wcId)
    }
    this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
  }

  // Why: headless orca serve has no <webview> window; back pages with offscreen WebContents and skip the webview-only setup.
  registerOffscreenGuest({
    browserPageId,
    worktreeId,
    sessionProfileId,
    userAgentMode,
    webContentsId
  }: {
    browserPageId: string
    worktreeId?: string
    sessionProfileId?: string | null
    userAgentMode?: BrowserSessionUserAgentMode
    webContentsId: number
  }): boolean {
    // Why the same check on both registration doors: one id resolving in both halves is the exact
    // confusion the split registries exist to prevent.
    if (isWorkspaceDocPageId(browserPageId)) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }
    // Why: offscreen pages have no renderer webview listeners, so main owns their load-failure lifecycle.
    this.offscreenGuestIds.add(webContentsId)
    this.attachGuestPolicies(guest)
    const previousWebContentsId = this.webContentsIdByTabId.get(browserPageId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      this.retireStaleGuestWebContents(previousWebContentsId)
    }
    this.webContentsIdByTabId.set(browserPageId, webContentsId)
    this.tabIdByWebContentsId.set(webContentsId, browserPageId)
    this.sessionProfileIdByPageId.set(browserPageId, sessionProfileId ?? null)
    if (userAgentMode) {
      this.userAgentModeByPageId.set(browserPageId, userAgentMode)
    } else {
      this.userAgentModeByPageId.delete(browserPageId)
    }
    if (worktreeId) {
      this.worktreeIdByTabId.set(browserPageId, worktreeId)
    }
    this.certificateTrustController?.onGuestRegistered(webContentsId, browserPageId)
    return true
  }

  unregisterAll(): void {
    // Cancel all active grab ops before tearing down registrations
    this.grabSessionController.cancelAll('evicted')
    this.downloadRelay.cancelAll('Orca is shutting down.')
    browserDownloadDestinationReservations.clear()
    for (const browserTabId of this.webContentsIdByTabId.keys()) {
      this.unregisterGuest(browserTabId)
    }
    this.policyAttachedGuestIds.clear()
    this.offscreenGuestIds.clear()
    // Why: unregisterGuest skips guests that were policy-attached but never registered; invoke their cleanup closures here.
    for (const cleanup of this.policyCleanupByGuestId.values()) {
      cleanup()
    }
    this.policyCleanupByGuestId.clear()
    this.popupRouting.clearAll()
    this.tabIdByWebContentsId.clear()
    this.worktreeIdByTabId.clear()
    this.sessionProfileIdByPageId.clear()
    this.userAgentModeByPageId.clear()
    this.viewportUaOverrideMobileByTabId.clear()
    this.authUaOverride.clearAll()
    this.pendingNavigationByGuestId.clear()
    this.guestEvents.clearAll()
    this.loadErrorsByGuestId.clear()
    this.clearedLoadErrorsByGuestId.clear()
    this.mouseWheelZoomCleanupByTabId.clear()
    this.annotationViewportBridgeOpsByTabId.clear()
  }

  getGuestWebContentsId(browserTabId: string): number | null {
    return this.webContentsIdByTabId.get(browserTabId) ?? null
  }

  getWebContentsIdByTabId(): Map<string, number> {
    return this.webContentsIdByTabId
  }

  getWorktreeIdForTab(browserTabId: string): string | undefined {
    return this.worktreeIdByTabId.get(browserTabId)
  }

  getRendererContextForGuest(
    guestWebContentsId: number
  ): { browserPageId: string; renderer: Electron.WebContents } | null {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return null
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    return renderer ? { browserPageId, renderer } : null
  }

  getSessionProfileIdForTab(browserTabId: string): string | null {
    return this.sessionProfileIdByPageId.get(browserTabId) ?? null
  }

  getBrowserPageLoadError(browserPageId: string): BrowserLoadError | null {
    const webContentsId = this.webContentsIdByTabId.get(browserPageId)
    return webContentsId === undefined
      ? null
      : (this.loadErrorsByGuestId.get(webContentsId) ?? null)
  }

  getBrowserPageCertificateFailure(browserPageId: string): BrowserCertificateFailure | null {
    return this.certificateTrustController?.getFailure(browserPageId) ?? null
  }

  getManagedBrowserGuestContext(webContentsId: number): ManagedBrowserGuestContext | null {
    if (this.popupRouting.hasDirectOwnerContext(webContentsId)) {
      return null
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId) ?? null
    const offscreen = this.offscreenGuestIds.has(webContentsId)
    if (!offscreen && !this.policyAttachedGuestIds.has(webContentsId)) {
      return null
    }
    if (!offscreen) {
      const guest = webContents.fromId(webContentsId)
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') {
        return null
      }
    }
    return {
      browserPageId,
      worktreeId: browserPageId ? (this.worktreeIdByTabId.get(browserPageId) ?? null) : null,
      sessionProfileId: browserPageId
        ? (this.sessionProfileIdByPageId.get(browserPageId) ?? null)
        : null,
      owner: offscreen ? 'offscreen' : 'desktop-webview'
    }
  }

  // Why: centralize Kagi session-token redaction so every load-error path (did-fail-load, cert failure) strips it.
  private buildLoadError(code: number, description: string, rawUrl: string): BrowserLoadError {
    return {
      code,
      description,
      validatedUrl: redactKagiSessionToken(rawUrl)
    }
  }

  notifyCertificateFailureChanged(
    webContentsId: number,
    failure: BrowserCertificateFailure | null,
    navigationUrl?: string
  ): void {
    if (failure && navigationUrl) {
      const loadError = this.buildLoadError(failure.errorCode ?? -1, failure.error, navigationUrl)
      this.loadErrorsByGuestId.set(webContentsId, loadError)
      this.guestEvents.forwardOrQueueGuestLoadFailure(webContentsId, loadError)
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId)
    if (!browserPageId) {
      return
    }
    if (this.offscreenGuestIds.has(webContentsId)) {
      this.notifyBrowserGuestStateChanged(webContentsId)
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    renderer?.send('browser:certificate-failure-changed', { browserPageId, failure })
  }

  private notifyBrowserGuestStateChanged(webContentsId: number): void {
    if (!this.offscreenGuestIds.has(webContentsId)) {
      return
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId)
    const worktreeId = browserPageId ? this.worktreeIdByTabId.get(browserPageId) : null
    if (worktreeId) {
      // Why: runs inside an Electron guest event dispatch, so an escaping throw would be a fatal uncaught exception.
      try {
        this.browserGuestStateChangedListener?.(worktreeId)
      } catch (error) {
        console.error('[browser-manager] browserGuestStateChanged listener failed', error)
      }
    }
  }

  notifyPermissionDenied(args: {
    guestWebContentsId: number
    permission: string
    rawUrl: string
  }): void {
    this.guestEvents.forwardOrQueuePermissionDenied(args.guestWebContentsId, {
      permission: args.permission,
      origin: safeOrigin(args.rawUrl)
    })
  }

  handleGuestWillDownload(args: { guestWebContentsId: number; item: Electron.DownloadItem }): void {
    this.downloadRelay.handleGuestWillDownload(args)
  }

  cancelDownload(args: { downloadId: string; senderWebContentsId: number }): boolean {
    return this.downloadRelay.cancelDownload(args)
  }

  // Why: guests are isolated from Orca's preload bridge, so main owns the devtools escape hatch after a tab→guest lookup.
  async openDevTools(browserTabId: string): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    return true
  }

  // Why: emulate viewport via CDP; never detach the debugger here or per-guest overrides (addScriptToEvaluateOnNewDocument) are cleared.
  async setViewportOverride(
    browserTabId: string,
    override: BrowserViewportOverride | null
  ): Promise<boolean> {
    // Why: chain per-tab so rapid toggles don't interleave CDP commands and the last-requested override wins.
    const prev = this.viewportOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetViewportOverrideImpl(browserTabId, override))
    this.viewportOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      // Why: only clear if we're still the tail; a later call may have replaced the entry, and deleting would break serialization.
      if (this.viewportOpsByTabId.get(browserTabId) === next) {
        this.viewportOpsByTabId.delete(browserTabId)
      }
    }
  }

  async setAnnotationViewportBridge(
    browserTabId: string,
    options: BrowserAnnotationViewportBridgeOptions,
    resolveGuest: () => Electron.WebContents | null
  ): Promise<boolean> {
    const prev = this.annotationViewportBridgeOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetAnnotationViewportBridgeImpl(options, resolveGuest))
    this.annotationViewportBridgeOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      if (this.annotationViewportBridgeOpsByTabId.get(browserTabId) === next) {
        this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
      }
    }
  }

  // Why the caller resolves the guest: the same bridge serves browsing pages and workspace
  // documents, which live in different halves of the page registry.
  // Why a resolver and not the guest itself: this op may have waited behind another one, and a
  // cross-process navigation meanwhile swaps the tab's contents without destroying the old one —
  // injecting into the guest the request named would bridge a page nobody is looking at.
  // Why no tab id: with teardown gone this reaches only the guest the resolver hands back, and
  // taking an id it cannot act on would invite the next reader to act on it.
  private async doSetAnnotationViewportBridgeImpl(
    options: BrowserAnnotationViewportBridgeOptions,
    resolveGuest: () => Electron.WebContents | null
  ): Promise<boolean> {
    // Why no teardown here: the resolver already unregisters a page whose guest died, and the only
    // case it uniquely leaves is an ownership mismatch on a healthy page — where tearing down would
    // cancel that page's in-flight downloads and grabs over a request that was merely misaddressed.
    const guest = resolveGuest()
    if (!guest || guest.isDestroyed()) {
      return false
    }

    try {
      // Why: run the scroll bridge in an isolated world so page scripts can't read the per-tab token or tamper with it.
      await guest.executeJavaScriptInIsolatedWorld(
        BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
        [{ code: buildBrowserAnnotationViewportBridgeScript(options) }],
        false
      )
      return true
    } catch {
      return false
    }
  }

  private async doSetViewportOverrideImpl(
    browserTabId: string,
    override: BrowserViewportOverride | null
  ): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }

    try {
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
    } catch (err) {
      // Why: attach throws if DevTools is open on the guest; log context so this failure mode is diagnosable.
      console.warn('[browser-manager] setViewportOverride: failed to attach debugger', {
        browserTabId,
        webContentsId,
        error: err instanceof Error ? err.message : String(err)
      })
      return false
    }

    const dbg = guest.debugger
    try {
      if (override) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: override.width,
          height: override.height,
          deviceScaleFactor: override.deviceScaleFactor,
          mobile: override.mobile
        })
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: override.mobile,
          maxTouchPoints: override.mobile ? 5 : 0
        })
        // Why: viewport sizing must not override a profile's explicit native-UA identity.
        if (this.userAgentModeByPageId.get(browserTabId) !== 'native') {
          // Navigation must see the preset intent while the final CDP command is in flight.
          this.viewportUaOverrideMobileByTabId.set(browserTabId, override.mobile)
          // Why: same sender as the navigation path, so both resolve the tab's host identically.
          await this.authUaOverride.sendViewportUserAgentOverride(guest, override.mobile)
        }
      } else {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {})
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: false,
          maxTouchPoints: 0
        })
        const trackedMobile = this.viewportUaOverrideMobileByTabId.get(browserTabId)
        // A navigation after this point must not re-install the override behind the clear.
        this.viewportUaOverrideMobileByTabId.delete(browserTabId)
        try {
          if (this.authUaOverride.hasStateForGuest(guest.id)) {
            const url = this.resolveTabNavigationUrl(guest)
            const restored = await this.authUaOverride.applyAuthUserAgentOverrideOverCdp(
              guest,
              false,
              url,
              isGoogleAuthUrl(url) ? googleAuthUserAgent() : guest.session.getUserAgent()
            )
            if (!restored) {
              throw new Error('Failed to preserve auth user agent')
            }
          } else {
            // Why: passing an empty string restores the session default UA.
            await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' })
          }
        } catch (error) {
          if (trackedMobile !== undefined) {
            this.viewportUaOverrideMobileByTabId.set(browserTabId, trackedMobile)
          }
          throw error
        }
      }
      return true
    } catch {
      return false
    }
  }

  // --- Browser Context Grab — main-owned operations ---

  /** Validate that the sender owns browserTabId; returns the guest WebContents or null. */
  /**
   * The guest a request from `senderWebContentsId` may act on, across both halves of the page
   * registry. This is the only door taught about workspace-document guests: they are kept out of
   * the browsing maps entirely, so page management, agent commands, download routing and
   * certificate attribution all miss them without a guard of their own — and a reader who opens a
   * tool on the document in front of them still gets an answer.
   */
  getAuthorizedGuest(
    browserTabId: string,
    senderWebContentsId: number
  ): Electron.WebContents | null {
    const docGuest = getWorkspaceDocPageGuest(browserTabId, senderWebContentsId)
    if (docGuest) {
      return docGuest
    }
    const registeredRenderer = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (registeredRenderer == null || registeredRenderer !== senderWebContentsId) {
      return null
    }
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    if (guestId == null) {
      return null
    }
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return null
    }
    return guest
  }

  /** Returns true if a grab operation is currently active for this tab. */
  hasActiveGrabOp(browserTabId: string): boolean {
    return this.grabSessionController.hasActiveGrabOp(browserTabId)
  }

  setGrabMode(
    browserTabId: string,
    enabled: boolean,
    guest: Electron.WebContents
  ): Promise<boolean> {
    return this.grabSessionController.setGrabMode(browserTabId, enabled, guest)
  }

  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    return this.grabSessionController.awaitGrabSelection(browserTabId, opId, guest)
  }

  /** Cancel an active grab operation for the given tab. */
  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    this.grabSessionController.cancelGrabOp(browserTabId, reason)
  }

  captureSelectionScreenshot(
    _browserTabId: string,
    rect: BrowserGrabRect,
    guest: Electron.WebContents
  ): Promise<BrowserGrabScreenshot | null> {
    return this.grabSessionController.captureSelectionScreenshot(_browserTabId, rect, guest)
  }

  extractHoverPayload(
    _browserTabId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabPayload | null> {
    return this.grabSessionController.extractHoverPayload(_browserTabId, guest)
  }

  private setupContextMenu(browserTabId: string, guest: Electron.WebContents): void {
    this.contextMenuCleanupByTabId.set(
      browserTabId,
      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: (tabId) => this.resolveRendererForBrowserTab(tabId)
      })
    )
  }

  // Why: forward grab's Cmd/Ctrl+C from a focused guest only when no edit field/selection is active, so native copy still works.
  private setupGrabShortcut(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }

    this.grabShortcutCleanupByTabId.set(
      browserTabId,
      setupGrabShortcutForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        hasActiveGrabOp: (tabId) => this.hasActiveGrabOp(tabId),
        getKeybindings: () => this.settingsResolver?.().keybindings
      })
    )
  }

  // Why: a focused webview guest is a separate process, so its key events never reach the renderer; intercept and forward app shortcuts.
  private setupShortcutForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }

    this.shortcutForwardingCleanupByTabId.set(
      browserTabId,
      setupGuestShortcutForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        shouldForwardDictationShortcut: () => this.shouldForwardDictationShortcut?.() ?? false,
        isMobileEmulatorEnabled: () => this.settingsResolver?.().mobileEmulatorEnabled !== false,
        getKeybindings: () => this.settingsResolver?.().keybindings,
        resolveWorktreeId: (tabId) => this.worktreeIdByTabId.get(tabId) ?? null,
        resolveWorkspaceId: (tabId) => this.workspaceIdByPageId.get(tabId) ?? null
      })
    )
  }

  private setupMouseWheelZoomForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.mouseWheelZoomCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.mouseWheelZoomCleanupByTabId.delete(browserTabId)
    }

    this.mouseWheelZoomCleanupByTabId.set(
      browserTabId,
      setupGuestMouseWheelZoomForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId)
      })
    )
  }

  private openLinkInOrcaTab(browserTabId: string, rawUrl: string): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === ORCA_BROWSER_BLANK_URL) {
      return false
    }
    // Why: only the renderer owns Orca's worktree/tab model; main forwards a validated URL, never letting guest content mutate it.
    renderer.send('browser:open-link-in-orca-tab', {
      browserPageId: browserTabId,
      url: normalizedUrl
    })
    return true
  }
}

export const browserManager = new BrowserManager()
export const browserCertificateTrustController = new BrowserCertificateTrustController({
  resolveManagedGuestContext: (webContentsId) =>
    browserManager.getManagedBrowserGuestContext(webContentsId),
  resolveWebContentsIdForPage: (browserPageId) =>
    browserManager.getGuestWebContentsId(browserPageId),
  resolveWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  onFailureChanged: (webContentsId, failure, navigationUrl) =>
    browserManager.notifyCertificateFailureChanged(webContentsId, failure, navigationUrl)
})
browserManager.setCertificateTrustController(browserCertificateTrustController)
