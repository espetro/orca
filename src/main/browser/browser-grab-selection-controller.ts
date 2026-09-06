import type {
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserGrabScreenshot
} from '../../shared/browser-grab-types'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'
import { captureSelectionScreenshot as captureGrabSelectionScreenshot } from './browser-grab-screenshot'
import { BrowserGrabSessionController } from './browser-grab-session-controller'

/**
 * Grab-mode lifecycle for one browser tab: overlay arming/teardown, selection await, screenshot
 * capture, and hover payload extraction.
 */
export class BrowserGrabSelectionController {
  private readonly sessionController = new BrowserGrabSessionController()

  hasActiveGrabOp(browserTabId: string): boolean {
    return this.sessionController.hasActiveGrabOp(browserTabId)
  }

  /** Enable/disable grab mode for a tab: on enable inject the overlay runtime, on disable cancel any active grab op. */
  async setGrabMode(
    browserTabId: string,
    enabled: boolean,
    guest: Electron.WebContents
  ): Promise<boolean> {
    if (!enabled) {
      const hadActiveGrabOp = this.hasActiveGrabOp(browserTabId)
      this.cancelGrabOp(browserTabId, 'user')
      if (hadActiveGrabOp) {
        return true
      }
      try {
        await guest.executeJavaScript(buildGuestOverlayScript('teardown'))
        return true
      } catch {
        return false
      }
    }
    // Why: inject the overlay runtime eagerly on arm so the hover UI appears instantly; re-injection is idempotent/safe.
    try {
      await guest.executeJavaScript(buildGuestOverlayScript('arm'))
      return true
    } catch {
      return false
    }
  }

  /**
   * Await a single grab selection on the given tab; resolves once on click, cancel, or error.
   *
   * Why in-guest: before-input-event fires only for keyboard (not mouse) on guests, so the overlay hit-catcher consumes the click.
   */
  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    return this.sessionController.awaitGrabSelection(browserTabId, opId, guest)
  }

  /** Cancel an active grab operation for the given tab. */
  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    this.sessionController.cancelGrabOp(browserTabId, reason)
  }

  cancelAll(reason: BrowserGrabCancelReason): void {
    this.sessionController.cancelAll(reason)
  }

  /** Capture a screenshot of the guest surface, optionally cropped to the given CSS-pixel rect. */
  async captureSelectionScreenshot(
    _browserTabId: string,
    rect: BrowserGrabRect,
    guest: Electron.WebContents
  ): Promise<BrowserGrabScreenshot | null> {
    return captureGrabSelectionScreenshot(rect, guest)
  }

  /** Extract the hovered element's payload without disrupting the active grab overlay/awaitClick listener. */
  async extractHoverPayload(
    _browserTabId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabPayload | null> {
    try {
      const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('extractHover'))
      if (!rawPayload || typeof rawPayload !== 'object') {
        return null
      }
      return clampGrabPayload(rawPayload)
    } catch {
      return null
    }
  }
}
