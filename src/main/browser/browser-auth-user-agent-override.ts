import type { BrowserSessionUserAgentMode } from '../../shared/browser-workspace-types'
import { getBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'
import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'
import { buildViewportUserAgentOverride } from './browser-viewport-user-agent'
import { cleanElectronUserAgent } from './browser-session-ua'

export type AuthUserAgentOverrideOperation = {
  sequence: number
  userAgent: string
}
export type AuthUserAgentOverrideState = {
  confirmed: AuthUserAgentOverrideOperation | null
  nextSequence: number
  pending: AuthUserAgentOverrideOperation[]
}

export type AuthUserAgentOverridePorts = {
  /** tabIdByWebContentsId — direct (non-popup) tab lookup. */
  resolveDirectTabIdForGuest(guestId: number): string | undefined
  /** Owner tab id, including popup inheritance. */
  resolveOwnerTabIdForGuest(guestId: number): string | null
  userAgentModeByPageIdGet(browserTabId: string): BrowserSessionUserAgentMode | undefined
  viewportUaOverrideMobileByTabIdGet(browserTabId: string): boolean | undefined
  sendViewportUserAgentOverride(
    guest: Electron.WebContents,
    mobile: boolean,
    url?: string,
    baseUserAgent?: string
  ): Promise<void>
  resolveTabNavigationUrl(guest: Electron.WebContents): string
  reapplyViewportUserAgentOverride(
    guest: Electron.WebContents,
    browserTabId: string,
    url: string
  ): void
}

export function canOverrideUserAgentOverCdp(guest: Electron.WebContents): boolean {
  try {
    return !guest.isDestroyed() && guest.debugger.isAttached()
  } catch {
    return false
  }
}

export class AuthUserAgentOverrideController {
  private readonly stateByGuestId = new Map<number, AuthUserAgentOverrideState>()

  constructor(private readonly ports: AuthUserAgentOverridePorts) {}

  hasStateForGuest(guestId: number): boolean {
    return this.stateByGuestId.has(guestId)
  }

  forgetGuest(guestId: number): void {
    this.stateByGuestId.delete(guestId)
  }

  clearAll(): void {
    this.stateByGuestId.clear()
  }

  // Why: navigator.userAgent (read by Google's auth JS) reflects the WebContents UA,
  // not the request header, so the header-level Firefox switch in setupClientHintsOverride
  // must be matched here per navigation or the two layers disagree — itself a bot tell.
  // Restores the session's base identity off the auth hosts. Native-UA profiles opt out
  // of the whole clean-UA path, so they keep their untouched identity everywhere.
  applyGoogleAuthUserAgent(
    guest: Electron.WebContents,
    url: string,
    options: { duringRedirect?: boolean } = {}
  ): void {
    const browserPageId = this.ports.resolveDirectTabIdForGuest(guest.id)
    // Why: popup child windows get these policies but are never in tabIdByWebContentsId, so a direct
    // lookup misses the native-UA opt-out and would hand a native profile's popup the Firefox UA.
    // That is worse than doing nothing: native sessions skip setupClientHintsOverride entirely, so
    // the popup would send the raw Electron UA on the wire while navigator.userAgent claims Firefox.
    const ownerTabId = this.ports.resolveOwnerTabIdForGuest(guest.id)
    // Session state is authoritative before renderer registration and after a native profile imports a source UA.
    const mode =
      getBrowserSessionUserAgentMode(guest.session) ??
      (ownerTabId ? this.ports.userAgentModeByPageIdGet(ownerTabId) : undefined)
    if (mode === 'native') {
      return
    }
    const firefoxUa = googleAuthUserAgent()
    const overrideState = this.stateByGuestId.get(guest.id)
    const latestPendingOverride = overrideState?.pending.at(-1)
    const confirmedOverride = overrideState?.confirmed
    const currentOverride =
      latestPendingOverride && latestPendingOverride.sequence > (confirmedOverride?.sequence ?? -1)
        ? latestPendingOverride
        : confirmedOverride
    const currentUa = currentOverride?.userAgent ?? guest.getUserAgent()
    const nextUa = isGoogleAuthUrl(url)
      ? firefoxUa
      : // Only restore when the auth-host override is actually in place, so normal
        // navigation never touches the session UA.
        currentUa === firefoxUa
        ? guest.session.getUserAgent()
        : null
    let authOverrideIssuedOverCdp = false
    if (nextUa !== null && nextUa !== currentUa) {
      // Why: WebContents.setUserAgent() during a redirect makes Chromium cancel the in-flight
      // navigation (ERR_ABORTED) and replay the original request, which a POST-started OAuth chain
      // cannot survive — the sign-in lands on a blank tab. CDP retargets navigator.userAgent without
      // touching the navigation, and it outranks the WebContents UA from then on, so a guest that
      // switches to it stays on it. The wire UA never depended on this write: setupClientHintsOverride
      // rewrites User-Agent per request for auth-host URLs on its own.
      if (options.duringRedirect === true || overrideState !== undefined) {
        if (canOverrideUserAgentOverCdp(guest)) {
          authOverrideIssuedOverCdp = true
          // Why: go through the viewport builder rather than writing nextUa raw, so both CDP writers
          // resolve one identity for this URL — Firefox on auth hosts, the profile's clean base off
          // them, any mobile preset preserved. Writing the session UA directly would put the
          // unlaundered Electron token back on the wire.
          void this.applyAuthUserAgentOverrideOverCdp(
            guest,
            (browserPageId
              ? this.ports.viewportUaOverrideMobileByTabIdGet(browserPageId)
              : undefined) ?? false,
            url,
            nextUa
          )
        }
        // Why: with no debugger there is no way to retarget the identity without cancelling the
        // redirect. A stale navigator.userAgent is recoverable; a dead navigation is not.
      } else {
        guest.setUserAgent(nextUa)
      }
    }
    // Why: gate on the DIRECT page id, not ownerTabId — a popup has no device-metrics override of
    // its own, so inheriting the owner tab's preset UA would pair a mobile UA with a desktop viewport.
    if (browserPageId && !authOverrideIssuedOverCdp) {
      this.ports.reapplyViewportUserAgentOverride(guest, browserPageId, url)
    }
  }

  applyAuthUserAgentOverrideOverCdp(
    guest: Electron.WebContents,
    mobile: boolean,
    url: string,
    userAgent: string
  ): Promise<boolean> {
    if (!canOverrideUserAgentOverCdp(guest)) {
      return Promise.resolve(false)
    }
    const state = this.stateByGuestId.get(guest.id) ?? {
      confirmed: null,
      nextSequence: 0,
      pending: []
    }
    const operation = { sequence: ++state.nextSequence, userAgent }
    state.pending.push(operation)
    this.stateByGuestId.set(guest.id, state)
    return this.ports.sendViewportUserAgentOverride(guest, mobile, url, userAgent).then(
      () => this.settleAuthUserAgentOverride(guest.id, state, operation, true),
      () => {
        this.settleAuthUserAgentOverride(guest.id, state, operation, false)
        return false
      }
    )
  }

  private settleAuthUserAgentOverride(
    guestId: number,
    state: AuthUserAgentOverrideState,
    operation: AuthUserAgentOverrideOperation,
    succeeded: boolean
  ): boolean {
    if (this.stateByGuestId.get(guestId) !== state) {
      return false
    }
    if (succeeded && (state.confirmed?.sequence ?? -1) < operation.sequence) {
      state.confirmed = operation
    }
    const pendingIndex = state.pending.indexOf(operation)
    if (pendingIndex !== -1) {
      state.pending.splice(pendingIndex, 1)
    }
    if (state.confirmed === null && state.pending.length === 0) {
      this.stateByGuestId.delete(guestId)
    }
    return true
  }

  /** Emulation.setUserAgentOverride via the viewport builder; see browser-manager call sites. */
  async sendViewportUserAgentOverride(
    guest: Electron.WebContents,
    mobile: boolean,
    url?: string,
    baseUserAgent?: string
  ): Promise<void> {
    if (guest.isDestroyed() || !guest.debugger.isAttached()) {
      return
    }
    await guest.debugger.sendCommand(
      'Emulation.setUserAgentOverride',
      buildViewportUserAgentOverride({
        url: url ?? this.ports.resolveTabNavigationUrl(guest),
        mobile,
        // Why: the session UA is the profile's stable base identity. guest.getUserAgent() is not:
        // applyGoogleAuthUserAgent leaves it pinned to the Firefox auth UA once a guest switches to
        // the CDP override, so reading it back here would republish that identity on ordinary hosts.
        baseUserAgent: cleanElectronUserAgent(baseUserAgent ?? guest.session.getUserAgent())
      })
    )
  }
}
