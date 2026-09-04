import type { RuntimeBrowserScreencastCommandsDeps } from './runtime-browser-screencast-commands-deps'
import type { RuntimeBrowserCommands } from './orca-runtime-browser'
import { BrowserError } from '../browser/browser-error'
import {
  resolveBrowserDriverAfterMobileRelease,
  screencastSubscriberDrivesAsMobile,
  type BrowserScreencastSubscriber
} from './browser-screencast-driver-scope'
import type { BrowserScreencastResult } from '../../shared/runtime-types'

export class RuntimeBrowserScreencastCommands {
  constructor(private deps: RuntimeBrowserScreencastCommandsDeps) {}

  browserSnapshot: RuntimeBrowserCommands['browserSnapshot'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSnapshot']>
  ) => this.deps.browserCommands.browserSnapshot(...args)

  browserClick: RuntimeBrowserCommands['browserClick'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserClick']>
  ) => this.deps.browserCommands.browserClick(...args)

  browserGoto: RuntimeBrowserCommands['browserGoto'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserGoto']>
  ) => this.deps.browserCommands.browserGoto(...args)

  browserFill: RuntimeBrowserCommands['browserFill'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserFill']>
  ) => this.deps.browserCommands.browserFill(...args)

  browserType: RuntimeBrowserCommands['browserType'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserType']>
  ) => this.deps.browserCommands.browserType(...args)

  browserSelect: RuntimeBrowserCommands['browserSelect'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSelect']>
  ) => this.deps.browserCommands.browserSelect(...args)

  browserScroll: RuntimeBrowserCommands['browserScroll'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserScroll']>
  ) => this.deps.browserCommands.browserScroll(...args)

  browserBack: RuntimeBrowserCommands['browserBack'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserBack']>
  ) => this.deps.browserCommands.browserBack(...args)

  browserReload: RuntimeBrowserCommands['browserReload'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserReload']>
  ) => this.deps.browserCommands.browserReload(...args)

  browserScreenshot: RuntimeBrowserCommands['browserScreenshot'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserScreenshot']>
  ) => this.deps.browserCommands.browserScreenshot(...args)

  async browserScreencast(
    params: Parameters<RuntimeBrowserCommands['browserScreencast']>[0],
    options: {
      connectionId?: string
      pairedDeviceId?: string
      clientKind?: 'mobile' | 'runtime'
      sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      signal?: AbortSignal
      emit: (result: BrowserScreencastResult) => void
    }
  ): Promise<void> {
    if (!options.sendBinary) {
      throw new BrowserError(
        'browser_error',
        'Browser screencast requires a binary streaming transport.'
      )
    }

    const connectionKey = options.connectionId ?? 'local'
    const drivesAsMobile = screencastSubscriberDrivesAsMobile(options.clientKind)
    let existingStream = this.deps.activeBrowserScreencastsByConnection.get(connectionKey)
    while (existingStream) {
      existingStream.cancel()
      await existingStream.done
      existingStream = this.deps.activeBrowserScreencastsByConnection.get(connectionKey)
    }
    if (options.signal?.aborted) {
      throw new BrowserError('browser_error', 'Browser screencast was cancelled.')
    }

    let screencast: Awaited<ReturnType<RuntimeBrowserCommands['browserScreencast']>> | null = null
    let registeredSubscriptionId: string | null = null
    let activeBrowserPageId: string | null = null
    let activePageStream: BrowserScreencastSubscriber | null = null
    let ended = false
    let cancelledBeforeStart = false
    let readyEmitted = false
    let resolveActiveDone!: () => void
    const activeDone = new Promise<void>((resolve) => {
      resolveActiveDone = resolve
    })
    const end = (emitEnd: boolean): void => {
      if (ended) {
        return
      }
      ended = true
      screencast?.session.stop()
      if (emitEnd && screencast) {
        options.emit({ type: 'end', subscriptionId: screencast.subscriptionId })
      }
    }
    const cancel = (emitEnd = false): void => {
      if (!screencast) {
        cancelledBeforeStart = true
        return
      }
      end(emitEnd)
    }
    const abortScreencast = (): void => cancel()
    const sendBinaryAfterReady = (bytes: Uint8Array<ArrayBufferLike>): boolean | void => {
      if (!readyEmitted) {
        // Why: clients learn the owning subscription from ready, so CDP frames must stay unacked until the JSON ready event is delivered.
        return false
      }
      return options.sendBinary?.(bytes)
    }

    // Why: a phone can rotate before the first stream reaches ready (no subscriptionId yet), so a same-socket replacement cancels and waits here instead of racing.
    this.deps.activeBrowserScreencastsByConnection.set(connectionKey, {
      cancel,
      done: activeDone,
      connectionKey
    })
    options.signal?.addEventListener('abort', abortScreencast, { once: true })
    try {
      screencast = await this.deps.browserCommands.browserScreencast(params, {
        sendBinary: sendBinaryAfterReady,
        emit: options.emit,
        pairedDeviceId: options.pairedDeviceId
      })
      if (cancelledBeforeStart || options.signal?.aborted) {
        end(false)
        await screencast.session.done
        return
      }
      activeBrowserPageId = screencast.ready.browserPageId
      activePageStream = {
        cancel,
        done: activeDone,
        connectionKey,
        drivesAsMobile
      }
      const pageStreams =
        this.deps.activeBrowserScreencastsByPage.get(activeBrowserPageId) ??
        new Set<BrowserScreencastSubscriber>()
      pageStreams.add(activePageStream)
      this.deps.activeBrowserScreencastsByPage.set(activeBrowserPageId, pageStreams)
      this.deps.publishBrowserRemoteViewers(activeBrowserPageId)
      if (drivesAsMobile) {
        this.deps.setBrowserDriver(activeBrowserPageId, { kind: 'mobile', clientId: connectionKey })
      }

      // Why: screencast frames are connection-scoped; tie Page.stopScreencast to the exact socket so dropped connections don't leave Chromium streaming.
      this.deps.registerSubscriptionCleanup(
        screencast.subscriptionId,
        () => end(true),
        options.connectionId
      )
      registeredSubscriptionId = screencast.subscriptionId
      options.emit(screencast.ready)
      readyEmitted = true
      // Why: a joining subscriber's viewport snapshot is captured before this gate opens, and
      // on a static page Chromium emits nothing after it — without the replay the pane stays blank.
      screencast.flushPendingFrame()
      await screencast.session.done
      end(true)
      this.deps.cleanupSubscription(screencast.subscriptionId)
    } finally {
      options.signal?.removeEventListener('abort', abortScreencast)
      if (!ended) {
        end(false)
      }
      if (registeredSubscriptionId) {
        this.deps.cleanupSubscription(registeredSubscriptionId)
      }
      const active = this.deps.activeBrowserScreencastsByConnection.get(connectionKey)
      if (active?.done === activeDone) {
        this.deps.activeBrowserScreencastsByConnection.delete(connectionKey)
      }
      if (activeBrowserPageId) {
        const pageStreams = this.deps.activeBrowserScreencastsByPage.get(activeBrowserPageId)
        if (activePageStream && pageStreams) {
          pageStreams.delete(activePageStream)
          if (pageStreams.size === 0) {
            this.deps.activeBrowserScreencastsByPage.delete(activeBrowserPageId)
          }
        }
        this.deps.publishBrowserRemoteViewers(activeBrowserPageId)
        const driver = this.deps.getBrowserDriver(activeBrowserPageId)
        if (driver.kind === 'mobile' && driver.clientId === connectionKey) {
          this.deps.setBrowserDriver(
            activeBrowserPageId,
            resolveBrowserDriverAfterMobileRelease(pageStreams ?? [])
          )
        }
      }
      resolveActiveDone()
    }
  }

  browserEval: RuntimeBrowserCommands['browserEval'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserEval']>
  ) => this.deps.browserCommands.browserEval(...args)

  browserTabList: RuntimeBrowserCommands['browserTabList'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabList']>
  ) => this.deps.browserCommands.browserTabList(...args)

  browserProceedCertificate: RuntimeBrowserCommands['browserProceedCertificate'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserProceedCertificate']>
  ) => this.deps.browserCommands.browserProceedCertificate(...args)

  browserTabShow: RuntimeBrowserCommands['browserTabShow'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabShow']>
  ) => this.deps.browserCommands.browserTabShow(...args)

  browserTabCurrent: RuntimeBrowserCommands['browserTabCurrent'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabCurrent']>
  ) => this.deps.browserCommands.browserTabCurrent(...args)

  browserTabSwitch: RuntimeBrowserCommands['browserTabSwitch'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabSwitch']>
  ) => this.deps.browserCommands.browserTabSwitch(...args)

  browserHover: RuntimeBrowserCommands['browserHover'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserHover']>
  ) => this.deps.browserCommands.browserHover(...args)

  browserDrag: RuntimeBrowserCommands['browserDrag'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserDrag']>
  ) => this.deps.browserCommands.browserDrag(...args)

  browserUpload: RuntimeBrowserCommands['browserUpload'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserUpload']>
  ) => this.deps.browserCommands.browserUpload(...args)

  browserWait: RuntimeBrowserCommands['browserWait'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserWait']>
  ) => this.deps.browserCommands.browserWait(...args)

  browserCheck: RuntimeBrowserCommands['browserCheck'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserCheck']>
  ) => this.deps.browserCommands.browserCheck(...args)

  browserFocus: RuntimeBrowserCommands['browserFocus'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserFocus']>
  ) => this.deps.browserCommands.browserFocus(...args)

  browserClear: RuntimeBrowserCommands['browserClear'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserClear']>
  ) => this.deps.browserCommands.browserClear(...args)

  browserSelectAll: RuntimeBrowserCommands['browserSelectAll'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSelectAll']>
  ) => this.deps.browserCommands.browserSelectAll(...args)

  browserKeypress: RuntimeBrowserCommands['browserKeypress'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserKeypress']>
  ) => this.deps.browserCommands.browserKeypress(...args)

  browserPdf: RuntimeBrowserCommands['browserPdf'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserPdf']>
  ) => this.deps.browserCommands.browserPdf(...args)

  browserFullScreenshot: RuntimeBrowserCommands['browserFullScreenshot'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserFullScreenshot']>
  ) => this.deps.browserCommands.browserFullScreenshot(...args)

  browserCookieGet: RuntimeBrowserCommands['browserCookieGet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserCookieGet']>
  ) => this.deps.browserCommands.browserCookieGet(...args)

  browserCookieSet: RuntimeBrowserCommands['browserCookieSet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserCookieSet']>
  ) => this.deps.browserCommands.browserCookieSet(...args)

  browserCookieDelete: RuntimeBrowserCommands['browserCookieDelete'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserCookieDelete']>
  ) => this.deps.browserCommands.browserCookieDelete(...args)

  browserSetViewport: RuntimeBrowserCommands['browserSetViewport'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetViewport']>
  ) => this.deps.browserCommands.browserSetViewport(...args)

  browserSetGeolocation: RuntimeBrowserCommands['browserSetGeolocation'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetGeolocation']>
  ) => this.deps.browserCommands.browserSetGeolocation(...args)

  browserInterceptEnable: RuntimeBrowserCommands['browserInterceptEnable'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserInterceptEnable']>
  ) => this.deps.browserCommands.browserInterceptEnable(...args)

  browserInterceptDisable: RuntimeBrowserCommands['browserInterceptDisable'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserInterceptDisable']>
  ) => this.deps.browserCommands.browserInterceptDisable(...args)

  browserInterceptList: RuntimeBrowserCommands['browserInterceptList'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserInterceptList']>
  ) => this.deps.browserCommands.browserInterceptList(...args)

  browserCaptureStart: RuntimeBrowserCommands['browserCaptureStart'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserCaptureStart']>
  ) => this.deps.browserCommands.browserCaptureStart(...args)

  browserCaptureStop: RuntimeBrowserCommands['browserCaptureStop'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserCaptureStop']>
  ) => this.deps.browserCommands.browserCaptureStop(...args)

  browserConsoleLog: RuntimeBrowserCommands['browserConsoleLog'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserConsoleLog']>
  ) => this.deps.browserCommands.browserConsoleLog(...args)

  browserNetworkLog: RuntimeBrowserCommands['browserNetworkLog'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserNetworkLog']>
  ) => this.deps.browserCommands.browserNetworkLog(...args)

  browserDblclick: RuntimeBrowserCommands['browserDblclick'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserDblclick']>
  ) => this.deps.browserCommands.browserDblclick(...args)

  browserForward: RuntimeBrowserCommands['browserForward'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserForward']>
  ) => this.deps.browserCommands.browserForward(...args)

  browserScrollIntoView: RuntimeBrowserCommands['browserScrollIntoView'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserScrollIntoView']>
  ) => this.deps.browserCommands.browserScrollIntoView(...args)

  browserGet: RuntimeBrowserCommands['browserGet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserGet']>
  ) => this.deps.browserCommands.browserGet(...args)

  browserIs: RuntimeBrowserCommands['browserIs'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserIs']>
  ) => this.deps.browserCommands.browserIs(...args)

  browserKeyboardInsertText: RuntimeBrowserCommands['browserKeyboardInsertText'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserKeyboardInsertText']>
  ) => this.deps.browserCommands.browserKeyboardInsertText(...args)

  browserMouseMove: RuntimeBrowserCommands['browserMouseMove'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserMouseMove']>
  ) => this.deps.browserCommands.browserMouseMove(...args)

  browserMouseDown: RuntimeBrowserCommands['browserMouseDown'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserMouseDown']>
  ) => this.deps.browserCommands.browserMouseDown(...args)

  browserMouseClick: RuntimeBrowserCommands['browserMouseClick'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserMouseClick']>
  ) => this.deps.browserCommands.browserMouseClick(...args)

  browserMouseUp: RuntimeBrowserCommands['browserMouseUp'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserMouseUp']>
  ) => this.deps.browserCommands.browserMouseUp(...args)

  browserMouseWheel: RuntimeBrowserCommands['browserMouseWheel'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserMouseWheel']>
  ) => this.deps.browserCommands.browserMouseWheel(...args)

  browserFind: RuntimeBrowserCommands['browserFind'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserFind']>
  ) => this.deps.browserCommands.browserFind(...args)

  browserSetDevice: RuntimeBrowserCommands['browserSetDevice'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetDevice']>
  ) => this.deps.browserCommands.browserSetDevice(...args)

  browserSetOffline: RuntimeBrowserCommands['browserSetOffline'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetOffline']>
  ) => this.deps.browserCommands.browserSetOffline(...args)

  browserSetHeaders: RuntimeBrowserCommands['browserSetHeaders'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetHeaders']>
  ) => this.deps.browserCommands.browserSetHeaders(...args)

  browserSetCredentials: RuntimeBrowserCommands['browserSetCredentials'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetCredentials']>
  ) => this.deps.browserCommands.browserSetCredentials(...args)

  browserSetMedia: RuntimeBrowserCommands['browserSetMedia'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserSetMedia']>
  ) => this.deps.browserCommands.browserSetMedia(...args)

  browserClipboardRead: RuntimeBrowserCommands['browserClipboardRead'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserClipboardRead']>
  ) => this.deps.browserCommands.browserClipboardRead(...args)

  browserClipboardWrite: RuntimeBrowserCommands['browserClipboardWrite'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserClipboardWrite']>
  ) => this.deps.browserCommands.browserClipboardWrite(...args)

  browserDialogAccept: RuntimeBrowserCommands['browserDialogAccept'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserDialogAccept']>
  ) => this.deps.browserCommands.browserDialogAccept(...args)

  browserDialogDismiss: RuntimeBrowserCommands['browserDialogDismiss'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserDialogDismiss']>
  ) => this.deps.browserCommands.browserDialogDismiss(...args)

  browserStorageLocalGet: RuntimeBrowserCommands['browserStorageLocalGet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserStorageLocalGet']>
  ) => this.deps.browserCommands.browserStorageLocalGet(...args)

  browserStorageLocalSet: RuntimeBrowserCommands['browserStorageLocalSet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserStorageLocalSet']>
  ) => this.deps.browserCommands.browserStorageLocalSet(...args)

  browserStorageLocalClear: RuntimeBrowserCommands['browserStorageLocalClear'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserStorageLocalClear']>
  ) => this.deps.browserCommands.browserStorageLocalClear(...args)

  browserStorageSessionGet: RuntimeBrowserCommands['browserStorageSessionGet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserStorageSessionGet']>
  ) => this.deps.browserCommands.browserStorageSessionGet(...args)

  browserStorageSessionSet: RuntimeBrowserCommands['browserStorageSessionSet'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserStorageSessionSet']>
  ) => this.deps.browserCommands.browserStorageSessionSet(...args)

  browserStorageSessionClear: RuntimeBrowserCommands['browserStorageSessionClear'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserStorageSessionClear']>
  ) => this.deps.browserCommands.browserStorageSessionClear(...args)

  browserDownload: RuntimeBrowserCommands['browserDownload'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserDownload']>
  ) => this.deps.browserCommands.browserDownload(...args)

  browserHighlight: RuntimeBrowserCommands['browserHighlight'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserHighlight']>
  ) => this.deps.browserCommands.browserHighlight(...args)

  browserExec: RuntimeBrowserCommands['browserExec'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserExec']>
  ) => this.deps.browserCommands.browserExec(...args)

  browserTabCreate: RuntimeBrowserCommands['browserTabCreate'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabCreate']>
  ) => this.deps.browserCommands.browserTabCreate(...args)

  browserTabSetProfile: RuntimeBrowserCommands['browserTabSetProfile'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabSetProfile']>
  ) => this.deps.browserCommands.browserTabSetProfile(...args)

  browserTabProfileShow: RuntimeBrowserCommands['browserTabProfileShow'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabProfileShow']>
  ) => this.deps.browserCommands.browserTabProfileShow(...args)

  browserTabProfileClone: RuntimeBrowserCommands['browserTabProfileClone'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserTabProfileClone']>
  ) => this.deps.browserCommands.browserTabProfileClone(...args)

  browserProfileCreate: RuntimeBrowserCommands['browserProfileCreate'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserProfileCreate']>
  ) => this.deps.browserCommands.browserProfileCreate(...args)

  browserProfileDelete: RuntimeBrowserCommands['browserProfileDelete'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserProfileDelete']>
  ) => this.deps.browserCommands.browserProfileDelete(...args)

  browserProfileList: RuntimeBrowserCommands['browserProfileList'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserProfileList']>
  ) => this.deps.browserCommands.browserProfileList(...args)

  browserProfileClearDefaultCookies: RuntimeBrowserCommands['browserProfileClearDefaultCookies'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserProfileClearDefaultCookies']>
  ) => this.deps.browserCommands.browserProfileClearDefaultCookies(...args)

  browserProfileImportFromBrowser: RuntimeBrowserCommands['browserProfileImportFromBrowser'] = (
    ...args: Parameters<RuntimeBrowserCommands['browserProfileImportFromBrowser']>
  ) => this.deps.browserCommands.browserProfileImportFromBrowser(...args)
}
