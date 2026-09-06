import { BrowserError } from './cdp-bridge'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { captureFullPageScreenshot } from './cdp-screenshot'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import {
  isAbortedNavigationError,
  waitForAbortedNavigationReplacement,
  resolveMobileTouchClickPoint,
  normalizeCdpMouseButton,
  cdpMouseButtonMask,
  cdpMouseModifierMask,
  focusedValueSetExpression,
  focusedRichTextEditExpression,
  isExplicitContentEditableResult,
  type BrowserMouseModifier,
  type BrowserClickPoint
} from './agent-browser-command-expressions'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { existsSync, readFileSync } from 'node:fs'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { iterateBrowserTextInsertionChunks } from './browser-text-insertion'
import type { AgentBrowserExecOptions } from './agent-browser-session-targets'
import {
  EMBEDDED_NAVIGATION_TIMEOUT_MS,
  WAIT_PROCESS_TIMEOUT_GRACE_MS
} from './agent-browser-command-constants'
import {
  AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES,
  AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES
} from './agent-browser-bridge-constants'

export type ResolvedBrowserCommandTarget = {
  browserPageId: string
  webContentsId: number
}

export type AgentBrowserInteractionPorts = {
  sessions: Map<string, { webContentsId: number }>
  getWebContents(webContentsId: number): Electron.WebContents | null
  requireTargetWebContents(target: ResolvedBrowserCommandTarget): Electron.WebContents
  resolveCommandTarget(
    worktreeId?: string,
    browserPageId?: string,
    requireScopedTarget?: boolean
  ): Promise<ResolvedBrowserCommandTarget> | ResolvedBrowserCommandTarget
  acquireAutomationVisibility(webContentsId: number): Promise<() => void>
  acquireOffscreenPaint(webContentsId: number): () => void
  getBrowserPageLoadError(browserPageId: string): { description: string; code: number } | null
  execAgentBrowser(
    sessionName: string,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<unknown>
  createPageUnavailableError(sessionName: string): BrowserError
  withSerializedScreenshotAccess<T>(execute: () => Promise<T>): Promise<T>
  enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options?: { ensureSession?: boolean; ensureVisible?: boolean; requireScopedTarget?: boolean }
  ): Promise<T>
}

/**
 * Interaction commands that bypass the agent-browser CLI and drive the guest directly via CDP or
 * the Electron WebContents API: embedded navigation, fill/clear, mouse clicks, evaluate,
 * screenshots, reload, and PDF.
 */
export class AgentBrowserInteractionCommands {
  constructor(private readonly ports: AgentBrowserInteractionPorts) {}

  async goto(
    url: string,
    worktreeId: string | undefined,
    browserPageId: string | undefined
  ): Promise<unknown> {
    return this.ports.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => this.runGotoEmbedded(url, worktreeId, target),
      { ensureSession: false }
    )
  }

  private async runGotoEmbedded(
    url: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget
  ): Promise<unknown> {
    const wc = this.ports.requireTargetWebContents(target)
    const navigationUrl = normalizeBrowserNavigationUrl(url)
    if (!navigationUrl) {
      throw new BrowserError('invalid_argument', `Unsupported browser URL: ${url}`)
    }
    const navigationState: { preventUnloadEvent: Electron.Event | null } = {
      preventUnloadEvent: null
    }
    const onWillPreventUnload = (event: Electron.Event): void => {
      navigationState.preventUnloadEvent = event
    }
    wc.on('will-prevent-unload', onWillPreventUnload)
    let navigationAborted = false
    const navigationDeadline = Date.now() + EMBEDDED_NAVIGATION_TIMEOUT_MS
    let navigationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        wc.loadURL(navigationUrl),
        new Promise<never>((_resolve, reject) => {
          navigationTimeout = setTimeout(
            () =>
              reject(
                new Error(`Browser navigation timed out after ${EMBEDDED_NAVIGATION_TIMEOUT_MS}ms`)
              ),
            EMBEDDED_NAVIGATION_TIMEOUT_MS
          )
          navigationTimeout.unref?.()
        })
      ])
    } catch (error) {
      if (navigationTimeout) {
        clearTimeout(navigationTimeout)
        navigationTimeout = null
      }
      if (!this.ports.getWebContents(target.webContentsId)) {
        throw this.ports.createPageUnavailableError(
          `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
        )
      }
      // Why: ERR_ABORTED also covers a page vetoing unload; that navigation did not succeed.
      if (
        !isAbortedNavigationError(error) ||
        (navigationState.preventUnloadEvent !== null &&
          !navigationState.preventUnloadEvent.defaultPrevented)
      ) {
        throw new BrowserError(
          'browser_error',
          `Failed to navigate browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      navigationAborted = true
      // Why: a superseding navigation rejects the first load before its replacement has landed.
      await waitForAbortedNavigationReplacement(
        wc,
        target.browserPageId,
        Math.max(0, navigationDeadline - Date.now())
      )
    } finally {
      wc.removeListener('will-prevent-unload', onWillPreventUnload)
      if (navigationTimeout) {
        clearTimeout(navigationTimeout)
      }
    }

    // Why: cross-process navigation can replace the guest while retaining the same authoritative page id.
    const navigatedTarget = await this.ports.resolveCommandTarget(worktreeId, target.browserPageId)
    const navigatedWebContents = this.ports.requireTargetWebContents(navigatedTarget)
    const loadError = navigationAborted
      ? this.ports.getBrowserPageLoadError(target.browserPageId)
      : null
    if (loadError) {
      throw new BrowserError(
        'browser_error',
        `Failed to navigate browser page ${target.browserPageId}: ${loadError.description} (${loadError.code})`
      )
    }
    return { url: navigatedWebContents.getURL(), title: navigatedWebContents.getTitle() }
  }

  async fill(sessionName: string, element: string, value: string): Promise<unknown> {
    await assertClipboardTextWriteWithinLimitWithYield(value)
    // Why: agent-browser's CDP text insertion loses focus in Electron guests; edit through the browser's input pipeline instead.
    if (!(await this.isExplicitContentEditableTarget(sessionName, element))) {
      await this.ports.execAgentBrowser(sessionName, ['focus', element])
      await this.ports.execAgentBrowser(sessionName, [
        'eval',
        focusedValueSetExpression(JSON.stringify(''))
      ])
      for (const chunk of iterateBrowserTextInsertionChunks(
        value,
        AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
      )) {
        await this.ports.execAgentBrowser(sessionName, [
          'eval',
          focusedValueSetExpression(JSON.stringify(chunk), { append: true })
        ])
      }
      await this.ports.execAgentBrowser(sessionName, [
        'eval',
        focusedValueSetExpression(JSON.stringify(''), { append: true, dispatchEvents: true })
      ])
      return { filled: element }
    }

    await this.fillExplicitContentEditable(sessionName, element, value)
    return { filled: element }
  }

  private isExplicitContentEditableTarget(sessionName: string, element: string): Promise<boolean> {
    return this.ports
      .execAgentBrowser(sessionName, ['get', 'attr', element, 'contenteditable'])
      .then(isExplicitContentEditableResult)
  }

  private async fillExplicitContentEditable(
    sessionName: string,
    element: string,
    value: string
  ): Promise<void> {
    await this.ports.execAgentBrowser(sessionName, ['focus', element])
    // Why: stdin avoids argv limits and keeps replacement atomic; chunked edits can move focus and split a fill across controls.
    await this.ports.execAgentBrowser(sessionName, ['eval', '--stdin'], {
      stdinText: focusedRichTextEditExpression(JSON.stringify(value), { selectAll: true })
    })
  }

  async clear(sessionName: string, element: string): Promise<unknown> {
    if (!(await this.isExplicitContentEditableTarget(sessionName, element))) {
      // Why: agent-browser resolves the ref directly, preserving iframe/shadow-root/unfocusable semantics for ordinary fields.
      await this.ports.execAgentBrowser(sessionName, ['fill', element, ''])
      return { cleared: element }
    }

    await this.fillExplicitContentEditable(sessionName, element, '')
    return { cleared: element }
  }

  async mouseClick(
    target: ResolvedBrowserCommandTarget,
    x: number,
    y: number,
    button?: string,
    radius?: number,
    modifiers?: BrowserMouseModifier[]
  ): Promise<unknown> {
    const wc = this.ports.getWebContents(target.webContentsId)
    if (!wc || wc.isDestroyed()) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${target.browserPageId} is no longer available`
      )
    }
    const cdpButton = normalizeCdpMouseButton(button)
    const buttons = cdpMouseButtonMask(cdpButton)
    const cdpModifiers = cdpMouseModifierMask(modifiers)
    const lease = acquireElectronDebugger(wc)
    try {
      wc.focus()
      const point: BrowserClickPoint =
        cdpButton === 'left'
          ? // Why: DOM activation can't carry Cmd/Ctrl/Alt/Shift, so modifier clicks use the adjusted point and let CDP dispatch the event.
            await resolveMobileTouchClickPoint(wc.debugger, x, y, radius, cdpModifiers === 0)
          : { x, y, adjusted: false, handled: false }
      // Why: land the tap as one atomic op — separate move/down/up CLI calls visibly hover and can miss small controls.
      // Why: mobile-emulated BrowserViews can ignore CDP mouse clicks, so the runtime may already have activated DOM controls.
      if (!point.handled) {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: cdpButton,
          buttons,
          modifiers: cdpModifiers,
          clickCount: 1
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: cdpButton,
          buttons: 0,
          modifiers: cdpModifiers,
          clickCount: 1
        })
      }
      return {
        clicked: {
          x: point.x,
          y: point.y,
          button: cdpButton,
          adjusted: point.adjusted,
          handled: point.handled
        }
      }
    } finally {
      lease.release()
    }
  }

  async reload(target: ResolvedBrowserCommandTarget): Promise<{ url: string; title: string }> {
    const wc = this.ports.getWebContents(target.webContentsId)
    if (!wc) {
      throw new BrowserError('browser_no_tab', 'Tab is no longer available')
    }
    wc.reload()
    await new Promise<void>((resolve) => {
      let settled = false
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        wc.removeListener('did-finish-load', onFinish)
        wc.removeListener('did-fail-load', onFail)
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = null
        }
        resolve()
      }
      const onFinish = (): void => finish()
      const onFail = (): void => finish()

      wc.on('did-finish-load', onFinish)
      wc.on('did-fail-load', onFail)
      // Why: clear the fallback timer on load; otherwise each reload leaks the webContents + listeners until the 10s timeout.
      fallbackTimer = setTimeout(finish, 10_000)
      if (typeof fallbackTimer.unref === 'function') {
        fallbackTimer.unref()
      }
    })
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  async screenshot(
    sessionName: string,
    commandArgs: string[],
    settleMs: number,
    format?: string
  ): Promise<unknown> {
    return this.ports.withSerializedScreenshotAccess(async () => {
      const session = this.ports.sessions.get(sessionName)
      const restore = session
        ? await this.ports.acquireAutomationVisibility(session.webContentsId)
        : () => {}
      try {
        // Why: let the compositor settle to a painted frame after the lease, inside the screenshot lock so another tab can't change lease state first.
        await new Promise((r) => setTimeout(r, settleMs))
        const raw = await this.ports.execAgentBrowser(sessionName, commandArgs)
        return this.readScreenshotFromResult(raw, format)
      } finally {
        restore()
      }
    })
  }

  async fullPageScreenshot(
    sessionName: string,
    webContentsId: number,
    settleMs: number,
    format: 'png' | 'jpeg'
  ): Promise<unknown> {
    return this.ports.withSerializedScreenshotAccess(async () => {
      const session = this.ports.sessions.get(sessionName)
      const restore = session
        ? await this.ports.acquireAutomationVisibility(session.webContentsId)
        : () => {}
      // Why: offscreen guests need a paint lease or the throttled compositor captures a stale surface.
      const releasePaint = this.ports.acquireOffscreenPaint(webContentsId)
      try {
        // Why: the guest compositor needs a beat to paint a fresh frame after becoming paintable, or CDP captures a stale surface.
        await new Promise((r) => setTimeout(r, settleMs))
        const wc = this.ports.getWebContents(webContentsId)
        if (!wc) {
          throw new BrowserError('browser_tab_not_found', 'Tab is no longer available')
        }
        return await captureFullPageScreenshot(wc, format)
      } catch (error) {
        throw new BrowserError('browser_error', (error as Error).message)
      } finally {
        releasePaint()
        restore()
      }
    })
  }

  private readScreenshotFromResult(raw: unknown, format?: string): unknown {
    const parsed = raw as { path?: string } | undefined
    if (!parsed?.path) {
      throw new BrowserError('browser_error', 'Screenshot returned no file path')
    }
    if (!existsSync(parsed.path)) {
      throw new BrowserError('browser_error', `Screenshot file not found: ${parsed.path}`)
    }
    const data = readFileSync(parsed.path).toString('base64')
    return { data, format: format === 'jpeg' ? 'jpeg' : 'png' }
  }

  async evaluate(
    expression: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget
  ): Promise<unknown> {
    const wc = this.ports.requireTargetWebContents(target)
    let releaseDebugger = (): void => {}
    try {
      releaseDebugger = acquireElectronDebugger(wc).release
      const { result, exceptionDetails } = (await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })) as {
        result: { value?: unknown; description?: string }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }
      if (exceptionDetails) {
        throw new BrowserError(
          'browser_eval_error',
          exceptionDetails.exception?.description ?? exceptionDetails.text
        )
      }

      const currentTarget = await this.ports.resolveCommandTarget(worktreeId, target.browserPageId)
      if (currentTarget.webContentsId !== target.webContentsId) {
        throw new BrowserError(
          'browser_tab_changed',
          `Browser page ${target.browserPageId} changed while evaluating; retry the command`
        )
      }
      return {
        result:
          result.value !== undefined
            ? typeof result.value === 'object' && result.value !== null
              ? JSON.stringify(result.value)
              : String(result.value)
            : (result.description ?? ''),
        origin: wc.getURL()
      }
    } catch (error) {
      if (error instanceof BrowserError) {
        throw error
      }
      if (!this.ports.getWebContents(target.webContentsId)) {
        throw this.ports.createPageUnavailableError(
          `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
        )
      }
      throw new BrowserError(
        'browser_error',
        `Failed to evaluate in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      releaseDebugger()
    }
  }

  async pdf(target: ResolvedBrowserCommandTarget): Promise<unknown> {
    const wc = this.ports.getWebContents(target.webContentsId)
    if (!wc) {
      throw new BrowserError('browser_no_tab', 'Tab is no longer available')
    }
    const buffer = await wc.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    return { data: buffer.toString('base64') }
  }

  async setViewport(
    target: ResolvedBrowserCommandTarget,
    width: number,
    height: number,
    scale: number,
    mobile: boolean
  ): Promise<unknown> {
    const wc = this.ports.getWebContents(target.webContentsId)
    if (!wc) {
      throw new BrowserError('browser_tab_not_found', 'Tab is no longer available')
    }
    const dbg = wc.debugger
    if (!dbg.isAttached()) {
      throw new BrowserError('browser_error', 'Debugger not attached')
    }

    // Why: agent-browser's `set viewport` has no `mobile` flag, so apply the emulation directly via CDP to honor Orca's --mobile.
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile
    })
    // Why: BrowserView's compositor can keep the old host size after a metrics-only resize, cropping remote screencast clients.
    await Promise.resolve(dbg.sendCommand('Emulation.setVisibleSize', { width, height })).catch(
      () => {}
    )

    return {
      width,
      height,
      deviceScaleFactor: scale,
      mobile
    }
  }

  waitForConditionTimeout(timeout?: number): { timeoutMs?: number; timeoutError?: Error } {
    // Why: agent-browser's selector wait lacks a per-command timeout — enforce it here so a missing selector fails as browser_timeout, not a hang.
    const hasTimeout = timeout != null
    return {
      timeoutMs: hasTimeout ? timeout + WAIT_PROCESS_TIMEOUT_GRACE_MS : undefined,
      timeoutError: hasTimeout
        ? new BrowserError(
            'browser_timeout',
            `Timed out waiting for browser condition after ${timeout}ms.`
          )
        : undefined
    }
  }

  async assertClipboardWriteLimit(text: string): Promise<void> {
    await assertClipboardTextWriteWithinLimitWithYield(text, {
      maxBytes: AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES
    })
  }
}
