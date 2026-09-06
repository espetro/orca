import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { BrowserBackend, BrowserBackendCreateTab } from './browser-backend'
import type { BrowserManager } from './browser-manager'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { browserSessionRegistry } from './browser-session-registry'
import { resolveServeBrowserPaintMode } from './serve-browser-settings'
import { OffscreenTabSweeper } from './offscreen-tab-sweeper'

const DEFAULT_VIEWPORT_WIDTH = 1280
const DEFAULT_VIEWPORT_HEIGHT = 800
const LOAD_TIMEOUT_MS = 30_000
const OWNER_RETIREMENT_CONCURRENCY = 4

/** A page currently torn down to reclaim memory, restorable by page id. */
export type SleepingOffscreenPage = {
  url: string
  worktreeId?: string
  profileId?: string
  sleptAt: number
}

export type OffscreenPageInventoryEntry = {
  webContentsId: number
  url: string
  lastActivityAt: number
  hasActiveLease: boolean
}

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly windowsByPageId = new Map<string, BrowserWindow>()
  private readonly lastActivityByPageId = new Map<string, number>()
  private readonly sleepingByPageId = new Map<string, SleepingOffscreenPage>()
  private readonly sleepingHistoryByPageId = new Map<
    string,
    { entries: Electron.NavigationEntry[]; activeIndex: number }
  >()
  private readonly sweeper: OffscreenTabSweeper
  // Shutdown is terminal for this backend; rejecting creates closes the race
  // where destroyAll snapshots ownership and a new page appears afterward.
  private shutdownStarted = false
  private readonly pendingOwnerRetirements = new Set<Promise<void>>()

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: {
      getAgentBrowserBridge?: () => Pick<AgentBrowserBridge, 'onPageClosed'> | null
    } = {}
  ) {
    this.sweeper = new OffscreenTabSweeper({
      getInventory: () => this.listPageInventory(),
      sleepPage: (pageId) => this.sleepPage(pageId)
    })
  }

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    if (this.shutdownStarted) {
      throw new Error('Offscreen browser backend is shutting down')
    }
    const browserPageId = params.browserPageId ?? randomUUID()
    if (this.windowsByPageId.has(browserPageId)) {
      throw new Error(`Browser page ${browserPageId} already exists`)
    }
    // Why: profiles map to Electron partitions; using the profile's partition
    // makes cookies/storage persist in the same SQLite DB the desktop path uses.
    const profile = params.profileId
      ? browserSessionRegistry.getProfile(params.profileId)
      : browserSessionRegistry.getDefaultProfile()
    const partition = profile?.partition ?? ORCA_BROWSER_PARTITION

    const win = new BrowserWindow({
      show: false,
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
      webPreferences: {
        // Why: offscreen pages are the SSH/headless browser backend; keep their
        // HTML fullscreen behavior aligned with desktop <webview> guests.
        ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
        // Why: in auto mode the page starts throttled; a paint lease lifts it while
        // screencast/screenshot needs frames. 'always' keeps legacy painting.
        ...(resolveServeBrowserPaintMode() === 'auto' ? { paintWhenInitiallyHidden: false } : {}),
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.windowsByPageId.set(browserPageId, win)
    this.lastActivityByPageId.set(browserPageId, Date.now())
    // Why: createTab is the documented wake path for sleeping pages, so a stored record is consumed here.
    this.sleepingByPageId.delete(browserPageId)

    // Why: register the guest and return immediately so the new tab appears
    // without waiting for the page to finish loading. Previously createTab
    // awaited the full navigation, so clicking "New Browser Tab" did nothing for
    // up to a second on real URLs. The page loads asynchronously and streams
    // once it paints; a failed load leaves the (usable) tab open, matching how a
    // normal browser tab survives a failed navigation.
    const registered = this.browserManager.registerOffscreenGuest({
      browserPageId,
      worktreeId: params.worktreeId,
      sessionProfileId: profile?.id ?? null,
      userAgentMode: profile?.userAgentMode,
      webContentsId: win.webContents.id
    })
    if (!registered) {
      // Why destroy rather than carry on: the window already exists but carries none of the guest
      // policies registration installs, so leaving it would navigate an unvalidated URL with no
      // policy on it and hand back a page id nothing can drive. The renderer door aborts its mount
      // the same way; this is that abort.
      this.windowsByPageId.delete(browserPageId)
      win.destroy()
      throw new Error(`Browser page ${browserPageId} was refused`)
    }

    // Why only once registration took: this teardown unregisters the page id, and a refused id is
    // one the other authority may own — cancelling its work would be the confusion we just refused.
    // Why at all: if the window dies out from under us (crash, app teardown), drop the registry
    // entry so commands fail cleanly instead of resolving a dead WebContents.
    win.webContents.once('destroyed', () => {
      // Explicit close removes the page first and performs awaited cleanup;
      // only an unexpected destruction still owns the bridge retirement here.
      if (this.windowsByPageId.get(browserPageId) !== win) {
        return
      }
      void this.retirePageOwner(browserPageId)
      this.windowsByPageId.delete(browserPageId)
      this.browserManager.unregisterGuest(browserPageId)
    })

    const url = params.url || 'about:blank'
    void this.loadUrl(win, url).catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })

    return { browserPageId }
  }

  async closeTab(browserPageId: string): Promise<void> {
    const win = this.windowsByPageId.get(browserPageId)
    this.windowsByPageId.delete(browserPageId)
    this.lastActivityByPageId.delete(browserPageId)
    this.sleepingByPageId.delete(browserPageId)
    this.browserManager.unregisterGuest(browserPageId)
    try {
      if (win) {
        await this.retirePageOwner(browserPageId)
      }
    } finally {
      if (win && !win.isDestroyed()) {
        win.destroy()
      }
    }
  }

  getWebContentsId(browserPageId: string): number | null {
    const win = this.windowsByPageId.get(browserPageId)
    return win && !win.isDestroyed() ? win.webContents.id : null
  }

  /** True while the page's window is torn down but its id is restorable. */
  isPageSleeping(browserPageId: string): boolean {
    return this.sleepingByPageId.has(browserPageId)
  }

  /** Marks the page recently used so the idle sweep leaves it alone. */
  touchPage(browserPageId: string): void {
    if (this.windowsByPageId.has(browserPageId)) {
      this.lastActivityByPageId.set(browserPageId, Date.now())
    }
  }

  /**
   * Starts the periodic idle sweep. Explicit rather than createTab-driven so a
   * backend used without serve (tests, desktop) never arms a timer.
   */
  startIdleSweeper(): void {
    this.sweeper.start()
  }

  getSleepingPage(browserPageId: string): SleepingOffscreenPage | undefined {
    return this.sleepingByPageId.get(browserPageId)
  }

  listSleepingPageIds(): string[] {
    return [...this.sleepingByPageId.keys()]
  }

  /** Live offscreen pages for the idle sweeper; sleeping pages have no window so are absent. */
  listPageInventory(): Map<string, OffscreenPageInventoryEntry> {
    const inventory = new Map<string, OffscreenPageInventoryEntry>()
    for (const [pageId, win] of this.windowsByPageId) {
      if (win.isDestroyed()) {
        continue
      }
      inventory.set(pageId, {
        webContentsId: win.webContents.id,
        url: win.webContents.getURL?.() ?? '',
        lastActivityAt: this.lastActivityByPageId.get(pageId) ?? 0,
        hasActiveLease: this.browserManager.isPaintLeaseHeld(win.webContents.id)
      })
    }
    return inventory
  }

  async sleepPage(browserPageId: string): Promise<void> {
    const win = this.windowsByPageId.get(browserPageId)
    if (!win || win.isDestroyed() || this.sleepingByPageId.has(browserPageId)) {
      return
    }
    const wc = win.webContents
    let url = ''
    try {
      // Why navigationHistory over getURL(): keeps the tab's back stack across the sleep.
      const entries = wc.navigationHistory?.getAllEntries?.() ?? []
      if (entries.length > 0) {
        const activeIndex = wc.navigationHistory.getActiveIndex()
        url = entries[activeIndex]?.url ?? entries[0]?.url ?? ''
        this.sleepingHistoryByPageId.set(browserPageId, { entries, activeIndex })
      }
    } catch {
      // getURL fallback below
    }
    if (!url) {
      url = wc.getURL?.() ?? ''
    }
    const registrationWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    const profileId = this.browserManager.getSessionProfileIdForTab(browserPageId) ?? undefined
    this.sleepingByPageId.set(browserPageId, {
      url: url || 'about:blank',
      ...(registrationWorktreeId !== undefined ? { worktreeId: registrationWorktreeId } : {}),
      ...(profileId ? { profileId } : {}),
      sleptAt: Date.now()
    })
    // Close without consuming the sleeping record: a window death mid-sleep must not
    // drop the restore params, but the guest registration has to go with the window.
    this.windowsByPageId.delete(browserPageId)
    this.lastActivityByPageId.delete(browserPageId)
    this.browserManager.unregisterGuest(browserPageId)
    try {
      await this.retirePageOwner(browserPageId)
    } finally {
      win.destroy()
    }
  }

  /** Recreates a sleeping page's window in place; returns false when the id was not sleeping. */
  async wakePage(browserPageId: string): Promise<boolean> {
    const sleeping = this.sleepingByPageId.get(browserPageId)
    if (!sleeping) {
      return false
    }
    if (this.shutdownStarted) {
      throw new Error('Offscreen browser backend is shutting down')
    }
    await this.createTab({
      browserPageId,
      url: sleeping.url,
      worktreeId: sleeping.worktreeId,
      profileId: sleeping.profileId
    })
    const win = this.windowsByPageId.get(browserPageId)
    if (!win || win.isDestroyed()) {
      return true
    }
    try {
      const sourceEntries = this.sleepingHistoryByPageId.get(browserPageId)
      if (sourceEntries && sourceEntries.entries.length > 0) {
        await win.webContents.navigationHistory.restore({
          entries: sourceEntries.entries,
          index: sourceEntries.activeIndex
        })
      }
    } catch {
      // createTab already loaded lastUrl; restore is best-effort.
    }
    this.sleepingHistoryByPageId.delete(browserPageId)
    return true
  }

  async destroyAll(): Promise<void> {
    this.shutdownStarted = true
    this.sweeper.stop()
    const pageIds = [...this.windowsByPageId.keys()]
    await mapSettledWithConcurrency(pageIds, OWNER_RETIREMENT_CONCURRENCY, (pageId) =>
      this.closeTab(pageId)
    )
    await Promise.all(this.pendingOwnerRetirements)
  }

  private retirePageOwner(browserPageId: string): Promise<void> {
    const bridge = this.options.getAgentBrowserBridge?.()
    if (!bridge) {
      return Promise.resolve()
    }
    const retirement = bridge.onPageClosed(browserPageId).catch(() => {})
    this.pendingOwnerRetirements.add(retirement)
    void retirement.finally(() => this.pendingOwnerRetirements.delete(retirement))
    return retirement
  }

  private async loadUrl(win: BrowserWindow, url: string): Promise<void> {
    const wc = win.webContents
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        // Why: about:blank and slow pages can resolve via timeout without a
        // did-finish-load; treat that as success so the tab is still operable.
        resolve()
      }, LOAD_TIMEOUT_MS)

      const onFinish = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean
      ): void => {
        // Why: subframe/iframe (e.g. ad/tracker) load failures also fire
        // did-fail-load. Only the main frame failing means the page itself
        // failed; ignore the rest or an otherwise-usable page gets rejected.
        if (!isMainFrame) {
          return
        }
        if (settled) {
          return
        }
        settled = true
        cleanup()
        // Why: aborted loads (-3) happen on redirects/SPA navigations and are not
        // real failures; the page is still usable.
        if (errorCode === -3) {
          resolve()
          return
        }
        reject(new Error(`${errorDescription} (${errorCode})`))
      }
      const onDestroyed = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onFinish)
        wc.removeListener('did-fail-load', onFail)
        wc.removeListener('destroyed', onDestroyed)
      }

      wc.on('did-finish-load', onFinish)
      wc.on('did-fail-load', onFail)
      wc.once('destroyed', onDestroyed)
      void wc.loadURL(url).catch(() => {
        // loadURL rejects on aborted navigations; did-fail-load handles the rest.
      })
    })
  }
}
