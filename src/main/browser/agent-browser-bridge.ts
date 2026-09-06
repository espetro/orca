/* eslint-disable max-lines -- Why: thin facade over session-target/interaction command modules; splitting the public command surface further would fragment one contract. */
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserCookie
} from '../../shared/runtime-types'
import type { BrowserManager } from './browser-manager'
import {
  ORCA_TAB_SESSION_PREFIX,
  sweepOrphanedAgentBrowserSessions
} from './agent-browser-orphan-sweep'
import { BrowserError } from './cdp-bridge'
import { CdpWsProxy } from './cdp-ws-proxy'
import { app, type WebContents } from 'electron'
import { createAgentBrowserProcessEnvironment } from './agent-browser-process-environment'
import { execFile, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import { platform, arch } from 'node:os'
import { existsSync, accessSync, chmodSync, constants } from 'node:fs'
import {
  parseShellArgs,
  stripAgentBrowserTargetArgs,
  type BrowserMouseModifier
} from './agent-browser-command-expressions'
import {
  WAIT_PROCESS_TIMEOUT_GRACE_MS,
  AGENT_BROWSER_CLEANUP_TIMEOUT_MS,
  AGENT_BROWSER_CLEANUP_CONCURRENCY
} from './agent-browser-command-constants'
import { AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES } from './agent-browser-bridge-constants'
import {
  AgentBrowserSessionTargets,
  type AgentBrowserCleanupOptions,
  type AgentBrowserExecOptions,
  type SessionState
} from './agent-browser-session-targets'
import {
  AgentBrowserInteractionCommands,
  type ResolvedBrowserCommandTarget
} from './agent-browser-interaction-commands'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { iterateBrowserTextInsertionChunks } from './browser-text-insertion'

export type { AgentBrowserCleanupOptions } from './agent-browser-session-targets'
export {
  AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES,
  AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES
} from './agent-browser-bridge-constants'

type EnqueueTargetedCommandOptions = {
  ensureSession?: boolean
  ensureVisible?: boolean
  // Why: text-mutating commands must never fall back to the global tab (may be a worktree the user is viewing).
  requireScopedTarget?: boolean
}

export type AgentBrowserBridgeOptions = {
  onTabsChanged?: (worktreeId?: string) => void
}

function agentBrowserNativeName(): string {
  const base = 'agent-browser'
  if (process.env.ORCA_AGENT_BROWSER_BIN) {
    return process.env.ORCA_AGENT_BROWSER_BIN
  }
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `${base}-${process.platform}-${process.arch}${ext}`
}

function resolveAgentBrowserBinary(): string {
  const override = process.env.ORCA_AGENT_BROWSER_BIN
  if (override) {
    return override
  }
  const ext = platform() === 'win32' ? '.exe' : ''
  const packed = join(
    process.resourcesPath ?? '',
    'agent-browser',
    `agent-browser-${platform()}-${arch()}${ext}`
  )
  if (existsSync(packed)) {
    try {
      accessSync(packed, constants.X_OK)
      return packed
    } catch {
      try {
        chmodSync(packed, 0o755)
        return packed
      } catch {
        // fall through to the dev-tree path below
      }
    }
  }
  return join(process.cwd(), 'node_modules', '.bin', agentBrowserNativeName())
}

export class AgentBrowserBridge {
  // Why: per-worktree active tab so one worktree's tab switch can't affect another's command targeting.
  private readonly activeWebContentsPerWorktree = new Map<string, number>()
  private activeWebContentsId: number | null = null
  private readonly sessions = new Map<string, SessionState>()
  private readonly commandQueues = new Map<
    string,
    {
      execute: () => Promise<unknown>
      resolve: (value: unknown) => void
      reject: (reason: unknown) => void
    }[]
  >()
  private readonly processingQueues = new Set<string>()
  // Why: screenshot prep mutates shared paintability across tabs; serialize globally so concurrent captures don't blank each other.
  private screenshotTurn: Promise<void> = Promise.resolve()
  private readonly agentBrowserBin: string
  private readonly agentBrowserEnv: NodeJS.ProcessEnv
  private readonly ownsAgentBrowserSocketDirectory: boolean
  // Why: null when nothing bounds the daemon, so the bridge never guesses that one was replaced.
  private readonly agentBrowserIdleTimeoutMs: number | null
  // Why: stash intercept patterns from a swap-destroyed session, keyed by name, so the next session restores them.
  private readonly pendingInterceptRestore = new Map<string, string[]>()
  private readonly cancelledProcesses = new WeakSet<ChildProcess>()
  private shutdownStarted = false
  private readonly sessionTargets: AgentBrowserSessionTargets
  private readonly interaction: AgentBrowserInteractionCommands

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: AgentBrowserBridgeOptions = {}
  ) {
    this.agentBrowserBin = resolveAgentBrowserBinary()
    const processEnvironment = createAgentBrowserProcessEnvironment({
      inheritedEnv: process.env,
      platform: process.platform,
      userDataPath: app.getPath('userData')
    })
    this.agentBrowserEnv = processEnvironment.env
    this.ownsAgentBrowserSocketDirectory = processEnvironment.ownsSocketDirectory
    const idleTimeoutMs = Number(this.agentBrowserEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS)
    this.agentBrowserIdleTimeoutMs = idleTimeoutMs > 0 ? idleTimeoutMs : null
    this.sessionTargets = new AgentBrowserSessionTargets({
      sessions: this.sessions,
      commandQueues: this.commandQueues,
      processingQueues: this.processingQueues,
      cancelledProcesses: this.cancelledProcesses,
      agentBrowserBin: this.agentBrowserBin,
      agentBrowserEnv: this.agentBrowserEnv,
      agentBrowserIdleTimeoutMs: this.agentBrowserIdleTimeoutMs,
      pendingInterceptRestore: this.pendingInterceptRestore,
      isShutdownStarted: () => this.shutdownStarted,
      getWebContents: (id) => this.getWebContents(id),
      execFile,
      CdpWsProxy
    })
    this.interaction = new AgentBrowserInteractionCommands({
      sessions: this.sessions,
      getWebContents: (id) => this.getWebContents(id),
      requireTargetWebContents: (target) => this.requireTargetWebContents(target),
      resolveCommandTarget: (worktreeId, browserPageId, requireScopedTarget) =>
        this.resolveCommandTarget(worktreeId, browserPageId, requireScopedTarget),
      acquireAutomationVisibility: (id) => this.browserManager.acquireAutomationVisibility(id),
      acquireOffscreenPaint: (id) => this.browserManager.acquireOffscreenPaint(id),
      getBrowserPageLoadError: (pageId) => this.browserManager.getBrowserPageLoadError(pageId),
      execAgentBrowser: (sessionName, args, execOptions) =>
        this.sessionTargets.execAgentBrowser(sessionName, args, execOptions),
      createPageUnavailableError: (sessionName) =>
        this.sessionTargets.createPageUnavailableError(sessionName),
      withSerializedScreenshotAccess: (execute) => this.withSerializedScreenshotAccess(execute),
      enqueueTargetedCommand: (worktreeId, browserPageId, execute, opts) =>
        this.enqueueTargetedCommand(worktreeId, browserPageId, execute, opts)
    })
  }

  // ── Tab tracking ──

  setActiveTab(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
    this.options.onTabsChanged?.(worktreeId)
  }

  private selectFallbackActiveWebContents(
    worktreeId: string,
    excludedWebContentsId?: number
  ): number | null {
    for (const [, wcId] of this.getRegisteredTabs(worktreeId)) {
      if (wcId === excludedWebContentsId) {
        continue
      }
      if (this.getWebContents(wcId)) {
        this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        return wcId
      }
    }
    this.activeWebContentsPerWorktree.delete(worktreeId)
    return null
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  getPageInfo(
    worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    try {
      const target = this.resolveCommandTarget(worktreeId, browserPageId)
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        return null
      }
      return {
        browserPageId: target.browserPageId,
        url: wc.getURL() ?? '',
        title: wc.getTitle() ?? ''
      }
    } catch {
      return null
    }
  }

  onTabChanged(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
    this.options.onTabsChanged?.(worktreeId)
  }

  async onTabClosed(webContentsId: number): Promise<void> {
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    const owningWorktreeId = browserPageId
      ? this.browserManager.getWorktreeIdForTab(browserPageId)
      : undefined
    let nextWorktreeActiveWebContentsId: number | null = null
    if (
      owningWorktreeId &&
      this.activeWebContentsPerWorktree.get(owningWorktreeId) === webContentsId
    ) {
      nextWorktreeActiveWebContentsId = this.selectFallbackActiveWebContents(
        owningWorktreeId,
        webContentsId
      )
    }
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = nextWorktreeActiveWebContentsId
    }
    if (browserPageId) {
      await this.onPageClosed(browserPageId)
    }
    this.options.onTabsChanged?.(owningWorktreeId)
  }

  /**
   * Retire a page's daemon by page id.
   *
   * The headless offscreen backend owns pages by id and unregisters the guest
   * itself, so `onTabClosed`'s webContentsId lookup can never resolve one — it
   * has to say which page closed (#16367).
   */
  async onPageClosed(browserPageId: string): Promise<void> {
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    await this.sessionTargets.destroySession(sessionName)
    this.pendingInterceptRestore.delete(sessionName)
  }

  async onProcessSwap(
    browserPageId: string,
    newWebContentsId: number,
    previousWebContentsId?: number
  ): Promise<void> {
    // Why: an Electron process swap keeps browserPageId but gives a new webContentsId — destroy the session so the next command recreates it.
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    const session = this.sessions.get(sessionName)
    const oldWebContentsId = previousWebContentsId ?? session?.webContentsId
    const owningWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    // Why: save intercept patterns before destroy so the new session can restore them after init.
    if (session && session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
    await this.sessionTargets.destroySession(sessionName)
    if (oldWebContentsId != null && this.activeWebContentsId === oldWebContentsId) {
      this.activeWebContentsId = newWebContentsId
    }
    if (
      owningWorktreeId &&
      oldWebContentsId != null &&
      this.activeWebContentsPerWorktree.get(owningWorktreeId) === oldWebContentsId
    ) {
      this.activeWebContentsPerWorktree.set(owningWorktreeId, newWebContentsId)
    }
    this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
  }

  // ── Worktree-scoped tab queries ──

  getRegisteredTabs(worktreeId?: string): Map<string, number> {
    const all = this.browserManager.getWebContentsIdByTabId()
    if (!worktreeId) {
      return all
    }

    const filtered = new Map<string, number>()
    for (const [tabId, wcId] of all) {
      if (this.browserManager.getWorktreeIdForTab(tabId) === worktreeId) {
        filtered.set(tabId, wcId)
      }
    }
    return filtered
  }

  // ── Tab management ──

  tabList(worktreeId?: string): BrowserTabListResult {
    const tabs = this.getRegisteredTabs(worktreeId)
    // Why: use the per-worktree active tab so listing matches command routing, but read-only — discovery must not mutate active-tab state.
    let activeWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId
    const result: BrowserTabInfo[] = []
    let index = 0
    let firstLiveWcId: number | null = null
    for (const [tabId, wcId] of tabs) {
      const wc = this.getWebContents(wcId)
      if (!wc) {
        this.browserManager.unregisterGuest(tabId)
        continue
      }
      if (firstLiveWcId === null) {
        firstLiveWcId = wcId
      }
      const loadError = this.browserManager.getBrowserPageLoadError(tabId)
      const certificateFailure = this.browserManager.getBrowserPageCertificateFailure(tabId)
      result.push({
        browserPageId: tabId,
        index: index++,
        // Why: failed WebContents report chrome-error://, not the address the user asked to load.
        url: loadError?.validatedUrl ?? wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: wcId === activeWcId,
        loadError,
        certificateFailure
      })
    }
    // Why: with no active tab yet, show the first live tab as active without mutating state — keeps `tab list` side-effect free.
    if (activeWcId == null && firstLiveWcId !== null) {
      activeWcId = firstLiveWcId
      if (result.length > 0) {
        result[0].active = true
      }
    }
    return { tabs: result }
  }

  // Why: route tab switch through the command queue so it can't race in-flight commands targeting the old tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // Why: queue delay can change the tab list before execution — recompute against live webContents so no vanished index is activated.
      const liveEntries = [...tabs.entries()].filter(([, wcId]) => this.getWebContents(wcId))
      let switchedIndex = index ?? -1
      let resolvedPageId = browserPageId
      if (resolvedPageId) {
        switchedIndex = liveEntries.findIndex(([tabId]) => tabId === resolvedPageId)
      }
      if (switchedIndex < 0 || switchedIndex >= liveEntries.length) {
        const targetLabel =
          resolvedPageId != null ? `Browser page ${resolvedPageId}` : `Tab index ${index}`
        throw new BrowserError(
          'browser_tab_not_found',
          `${targetLabel} out of range (0-${liveEntries.length - 1})`
        )
      }
      const [tabId, wcId] = liveEntries[switchedIndex]
      this.activeWebContentsId = wcId
      // Why: resolveActiveTab prefers the per-worktree map, so update it or later commands keep routing to the old tab.
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Why: `tab switch --page` may omit --worktree, so still update the owning worktree's active slot for later scoped commands.
      if (owningWorktreeId) {
        this.activeWebContentsPerWorktree.set(owningWorktreeId, wcId)
      }
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }

  // ── Core commands (typed) ──

  async snapshot(worktreeId?: string, browserPageId?: string): Promise<BrowserSnapshotResult> {
    // Why: snapshot creates fresh refs so it must bypass the stale-ref guard
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName, target) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'snapshot'
      ])) as BrowserSnapshotResult
      return {
        ...result,
        browserPageId: target.browserPageId
      }
    })
  }

  async click(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['click', element])) as BrowserClickResult
    })
  }

  async dblclick(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['dblclick', element])) as BrowserClickResult
    })
  }

  async goto(url: string, worktreeId?: string, browserPageId?: string): Promise<BrowserGotoResult> {
    return this.interaction.goto(url, worktreeId, browserPageId) as Promise<BrowserGotoResult>
  }

  async fill(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFillResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) =>
        (await this.interaction.fill(sessionName, element, value)) as BrowserFillResult,
      { requireScopedTarget: true }
    )
  }

  async type(
    input: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTypeResult> {
    await assertClipboardTextWriteWithinLimitWithYield(input)
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        for (const chunk of iterateBrowserTextInsertionChunks(
          input,
          AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
        )) {
          await this.execAgentBrowser(sessionName, ['keyboard', 'type', chunk])
        }
        return { typed: true } as BrowserTypeResult
      },
      { requireScopedTarget: true }
    )
  }

  async select(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'select',
        element,
        value
      ])) as BrowserSelectResult
    })
  }

  async scroll(
    direction: string,
    amount?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScrollResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['scroll', direction]
      if (amount != null) {
        args.push(String(amount))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserScrollResult
    })
  }

  async scrollIntoView(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['scrollintoview', element])
    })
  }

  async get(
    what: string,
    selector?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['get', what]
      if (selector) {
        args.push(selector)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async is(
    what: string,
    selector: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['is', what, selector])
    })
  }

  // ── Keyboard commands ──

  async keyboardInsertText(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    await assertClipboardTextWriteWithinLimitWithYield(text)
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        let result: unknown = { inserted: true }
        for (const chunk of iterateBrowserTextInsertionChunks(
          text,
          AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
        )) {
          result = await this.execAgentBrowser(sessionName, ['keyboard', 'inserttext', chunk])
        }
        return result
      },
      { requireScopedTarget: true }
    )
  }

  // ── Mouse commands ──

  async mouseMove(
    x: number,
    y: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['mouse', 'move', String(x), String(y)])
    })
  }

  async mouseDown(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'down']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseClick(
    x: number,
    y: number,
    button?: string,
    worktreeId?: string,
    browserPageId?: string,
    radius?: number,
    modifiers?: BrowserMouseModifier[]
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) =>
        this.interaction.mouseClick(target, x, y, button, radius, modifiers),
      { ensureSession: false }
    )
  }

  async mouseUp(button?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'up']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseWheel(
    dy: number,
    dx?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['mouse', 'wheel', String(dy)]
      if (dx != null) {
        args.push(String(dx))
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Find (semantic locators) ──

  async find(
    locator: string,
    value: string,
    action: string,
    text?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['find', locator, value, action]
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Set commands ──

  async setDevice(name: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'device', name])
    })
  }

  async setOffline(state?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['set', 'offline']
      if (state) {
        args.push(state)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async setHeaders(
    headersJson: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'headers', headersJson])
    })
  }

  async setCredentials(
    user: string,
    pass: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'credentials', user, pass])
    })
  }

  async setMedia(
    colorScheme?: string,
    reducedMotion?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['set', 'media']
      if (colorScheme) {
        args.push(colorScheme)
      }
      if (reducedMotion) {
        args.push(reducedMotion)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Clipboard commands ──

  async clipboardRead(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'read'])
    })
  }

  async clipboardWrite(
    text: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    await this.interaction.assertClipboardWriteLimit(text)
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'write', text])
    })
  }

  // ── Dialog commands ──

  async dialogAccept(text?: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['dialog', 'accept']
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async dialogDismiss(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['dialog', 'dismiss'])
    })
  }

  // ── Storage commands ──

  async storageLocalGet(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'get', key])
    })
  }

  async storageLocalSet(
    key: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'set', key, value])
    })
  }

  async storageLocalClear(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'clear'])
    })
  }

  async storageSessionGet(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'get', key])
    })
  }

  async storageSessionSet(
    key: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'set', key, value])
    })
  }

  async storageSessionClear(worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'clear'])
    })
  }

  // ── Download command ──

  async download(
    selector: string,
    path: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['download', selector, path])
    })
  }

  // ── Highlight command ──

  async highlight(selector: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['highlight', selector])
    })
  }

  async back(worktreeId?: string, browserPageId?: string): Promise<BrowserBackResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['back'])) as BrowserBackResult
    })
  }

  async forward(worktreeId?: string, browserPageId?: string): Promise<BrowserBackResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['forward'])) as BrowserBackResult
    })
  }

  async reload(worktreeId?: string, browserPageId?: string): Promise<BrowserReloadResult> {
    // Why: reload can trigger an Electron process swap that destroys the session mid-command — reload via webContents directly instead.
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      return await this.interaction.reload(target)
    })
  }

  async screenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    // Why: agent-browser writes the screenshot to a temp file and returns its path; read it and return base64.
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return (await this.interaction.screenshot(
          sessionName,
          ['screenshot'],
          300,
          format
        )) as BrowserScreenshotResult
      },
      { ensureVisible: false }
    )
  }

  async fullPageScreenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        return (await this.interaction.fullPageScreenshot(
          sessionName,
          target.webContentsId,
          500,
          format === 'jpeg' ? 'jpeg' : 'png'
        )) as BrowserScreenshotResult
      },
      { ensureVisible: false }
    )
  }

  private async withSerializedScreenshotAccess<T>(execute: () => Promise<T>): Promise<T> {
    const previousTurn = this.screenshotTurn.catch(() => {})
    let releaseTurn!: () => void
    this.screenshotTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    await previousTurn
    try {
      return await execute()
    } finally {
      releaseTurn()
    }
  }

  async evaluate(
    expression: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserEvalResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) =>
        (await this.interaction.evaluate(expression, worktreeId, target)) as BrowserEvalResult,
      { ensureSession: false }
    )
  }

  async hover(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserHoverResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['hover', element])) as BrowserHoverResult
    })
  }

  async drag(
    from: string,
    to: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserDragResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['drag', from, to])) as BrowserDragResult
    })
  }

  async upload(
    element: string,
    filePaths: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserUploadResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'upload',
        element,
        ...filePaths
      ])) as BrowserUploadResult
    })
  }

  async wait(
    options?: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    },
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserWaitResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['wait']
      const hasCondition =
        !!options?.selector || !!options?.text || !!options?.url || !!options?.load || !!options?.fn
      if (options?.selector) {
        args.push(options.selector)
      } else if (options?.timeout != null && !hasCondition) {
        args.push(String(options.timeout))
      }
      if (options?.text) {
        args.push('--text', options.text)
      }
      if (options?.url) {
        args.push('--url', options.url)
      }
      if (options?.load) {
        args.push('--load', options.load)
      }
      if (options?.fn) {
        args.push('--fn', options.fn)
      }
      const normalizedState = options?.state === 'visible' ? undefined : options?.state
      if (normalizedState) {
        args.push('--state', normalizedState)
      }
      // Why: agent-browser's selector wait lacks a per-command timeout — enforce it here so a missing selector fails as browser_timeout, not a hang.
      return (await this.execAgentBrowser(sessionName, args, {
        timeoutMs:
          options?.timeout != null && hasCondition
            ? options.timeout + WAIT_PROCESS_TIMEOUT_GRACE_MS
            : undefined,
        timeoutError:
          options?.timeout != null && hasCondition
            ? new BrowserError(
                'browser_timeout',
                `Timed out waiting for browser condition after ${options.timeout}ms.`
              )
            : undefined
      })) as BrowserWaitResult
    })
  }

  async check(
    element: string,
    checked: boolean,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCheckResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = checked ? ['check', element] : ['uncheck', element]
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCheckResult
    })
  }

  async focus(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFocusResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['focus', element])) as BrowserFocusResult
    })
  }

  async clear(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClearResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) =>
        (await this.interaction.clear(sessionName, element)) as BrowserClearResult,
      { requireScopedTarget: true }
    )
  }

  async selectAll(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserSelectAllResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser has no select-all command — implement as focus + Ctrl+A
      await this.execAgentBrowser(sessionName, ['focus', element])
      return (await this.execAgentBrowser(sessionName, [
        'press',
        'Control+a'
      ])) as BrowserSelectAllResult
    })
  }

  async keypress(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserKeypressResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['press', key])) as BrowserKeypressResult
    })
  }

  async pdf(worktreeId?: string, browserPageId?: string): Promise<BrowserPdfResult> {
    // Why: agent-browser's CDP printToPDF hangs in Electron webviews — use the native webContents.printToPDF().
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      return (await this.interaction.pdf(target)) as BrowserPdfResult
    })
  }

  // ── Cookie commands ──

  async cookieGet(
    _url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieGetResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'cookies',
        'get'
      ])) as BrowserCookieGetResult
    })
  }

  async cookieSet(
    cookie: Partial<BrowserCookie>,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieSetResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['cookies', 'set', cookie.name ?? '', cookie.value ?? '']
      if (cookie.domain) {
        args.push('--domain', cookie.domain)
      }
      if (cookie.path) {
        args.push('--path', cookie.path)
      }
      if (cookie.secure) {
        args.push('--secure')
      }
      if (cookie.httpOnly) {
        args.push('--httpOnly')
      }
      if (cookie.sameSite) {
        args.push('--sameSite', cookie.sameSite)
      }
      if (cookie.expires != null) {
        args.push('--expires', String(cookie.expires))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieSetResult
    })
  }

  async cookieDelete(
    name?: string,
    domain?: string,
    _url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieDeleteResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['cookies', 'clear']
      if (name) {
        args.push('--name', name)
      }
      if (domain) {
        args.push('--domain', domain)
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieDeleteResult
    })
  }

  // ── Viewport / emulation commands ──

  async setViewport(
    width: number,
    height: number,
    scale = 1,
    mobile = false,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserViewportResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      return (await this.interaction.setViewport(
        target,
        width,
        height,
        scale,
        mobile
      )) as BrowserViewportResult
    })
  }

  async setGeolocation(
    lat: number,
    lon: number,
    _accuracy?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserGeolocationResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'set',
        'geo',
        String(lat),
        String(lon)
      ])) as BrowserGeolocationResult
    })
  }

  // ── Network interception commands ──

  async interceptEnable(
    patterns?: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptEnableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser uses "network route <url>" to intercept. Route each pattern individually.
      const urlPattern = patterns?.[0] ?? '**/*'
      const args = ['network', 'route', urlPattern]
      const result = (await this.execAgentBrowser(
        sessionName,
        args
      )) as BrowserInterceptEnableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = patterns ?? ['*']
      }
      return result
    })
  }

  async interceptDisable(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptDisableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'unroute'
      ])) as BrowserInterceptDisableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = []
      }
      return result
    })
  }

  async interceptList(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<{ requests: unknown[] }> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['network', 'requests'])) as {
        requests: unknown[]
      }
    })
  }

  // TODO: Add interceptContinue/interceptBlock once agent-browser supports per-request decisions, not just URL-pattern routing.

  // ── Capture commands ──

  async captureStart(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCaptureStartResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'start'
      ])) as BrowserCaptureStartResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = true
      }
      return result
    })
  }

  async captureStop(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCaptureStopResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'stop'
      ])) as BrowserCaptureStopResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = false
      }
      return result
    })
  }

  async consoleLog(
    _limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserConsoleResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['console'])) as BrowserConsoleResult
    })
  }

  async networkLog(
    _limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserNetworkLogResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'network',
        'requests'
      ])) as BrowserNetworkLogResult
    })
  }

  // ── Generic passthrough ──

  async exec(command: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: strip target/session flags from passthrough so a caller can't override Orca's selected page or CDP proxy.
      const args = stripAgentBrowserTargetArgs(parseShellArgs(command.trim()))
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Session lifecycle ──

  // Why: a previous run that crashed or was SIGKILL'd left one daemon per open tab with
  // nobody holding its name — closeStaleAgentBrowserSession only resets a name being reused.
  async sweepOrphanedSessions(): Promise<string[]> {
    return sweepOrphanedAgentBrowserSessions({
      binaryPath: this.agentBrowserBin,
      env: this.agentBrowserEnv,
      ownsSocketDirectory: this.ownsAgentBrowserSocketDirectory,
      isSessionLive: (sessionName) =>
        this.sessions.has(sessionName) ||
        this.sessionTargets.pendingSessionCreation.has(sessionName)
    })
  }

  async destroyAllSessions(options?: AgentBrowserCleanupOptions): Promise<void> {
    this.shutdownStarted = true
    // Why the union: a session still being created has already spawned its daemon but is not in
    // `sessions` yet, so closing only `sessions` lets that daemon outlive the quit (#16367).
    const sessionNames = new Set([
      ...this.sessions.keys(),
      ...this.sessionTargets.pendingSessionCreation.keys(),
      ...this.sessionTargets.pendingSessionDestruction.keys()
    ])
    await mapSettledWithConcurrency(
      [...sessionNames],
      AGENT_BROWSER_CLEANUP_CONCURRENCY,
      (sessionName) => this.destroySession(sessionName, options)
    )
    this.pendingInterceptRestore.clear()
  }

  // ── Internal ──

  private async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(
      worktreeId,
      undefined,
      async (sessionName) => execute(sessionName),
      { ensureVisible: false }
    )
  }

  private async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    this.assertCommandAdmission()
    const target = this.resolveCommandTarget(worktreeId, browserPageId, options.requireScopedTarget)
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`

    if (options.ensureSession !== false) {
      await this.ensureSession(sessionName, target.browserPageId, target.webContentsId)
    }
    this.assertCommandAdmission()

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: (() =>
          this.executeWithVisibleTarget(
            sessionName,
            worktreeId,
            target,
            execute,
            options
          )) as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    })
  }

  private async executeWithVisibleTarget<T>(
    sessionName: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    if (options.ensureVisible === false) {
      return execute(sessionName, target)
    }

    // Why: inactive panes are display:none; the automation lease makes only this target paintable without selecting it.
    const restore = await this.browserManager.acquireAutomationVisibility(target.webContentsId)
    try {
      const visibleTarget = await this.refreshTargetAfterAutomationVisibility(
        sessionName,
        worktreeId,
        target,
        options
      )
      return await execute(sessionName, visibleTarget)
    } finally {
      restore()
    }
  }

  private async refreshTargetAfterAutomationVisibility(
    sessionName: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget,
    options: EnqueueTargetedCommandOptions
  ): Promise<ResolvedBrowserCommandTarget> {
    const visibleTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
    if (visibleTarget.webContentsId === target.webContentsId) {
      return visibleTarget
    }

    if (this.activeWebContentsId === target.webContentsId) {
      this.activeWebContentsId = visibleTarget.webContentsId
    }
    if (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId) === target.webContentsId) {
      this.activeWebContentsPerWorktree.set(worktreeId, visibleTarget.webContentsId)
    }

    // Why: making a parked webview paintable can re-register the page with a new guest webContents; tear down the stale session.
    await this.sessionTargets.restartSessionForTarget(
      sessionName,
      visibleTarget.browserPageId,
      visibleTarget.webContentsId,
      { recreate: options.ensureSession !== false }
    )

    return visibleTarget
  }

  private async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    if (queue && queue.length === 0 && this.commandQueues.get(sessionName) === queue) {
      this.commandQueues.delete(sessionName)
    }
    this.processingQueues.delete(sessionName)
  }

  getActivePageId(worktreeId?: string, browserPageId?: string): string | null {
    try {
      return this.resolveCommandTarget(worktreeId, browserPageId).browserPageId
    } catch {
      return null
    }
  }

  private resolveCommandTarget(
    worktreeId?: string,
    browserPageId?: string,
    requireScopedTarget = false
  ): ResolvedBrowserCommandTarget {
    if (!browserPageId) {
      return requireScopedTarget
        ? this.resolveScopedActiveTab(worktreeId)
        : this.resolveActiveTab(worktreeId)
    }

    const tabs = this.getRegisteredTabs(worktreeId)
    const webContentsId = tabs.get(browserPageId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }

    if (!this.getWebContents(webContentsId)) {
      this.browserManager.unregisterGuest(browserPageId)
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} is no longer available`
      )
    }

    return { browserPageId, webContentsId }
  }

  private resolveActiveTab(worktreeId?: string): ResolvedBrowserCommandTarget {
    const tabs = this.getRegisteredTabs(worktreeId)

    if (tabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }

    // Why: prefer per-worktree active tab to avoid cross-worktree interference; fall back to global for callers without worktreeId.
    const preferredWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId

    if (preferredWcId != null) {
      for (const [tabId, wcId] of tabs) {
        if (wcId === preferredWcId && this.getWebContents(wcId)) {
          return { browserPageId: tabId, webContentsId: wcId }
        }
        if (wcId === preferredWcId) {
          this.browserManager.unregisterGuest(tabId)
          if (this.activeWebContentsId === wcId) {
            this.activeWebContentsId = null
          }
          if (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId) === wcId) {
            this.activeWebContentsPerWorktree.delete(worktreeId)
          }
        }
      }
    }

    // Why: persisted state can leave ghost tabs (dead webContents); skip them and activate the first live tab for consistency.
    for (const [tabId, wcId] of tabs) {
      if (this.getWebContents(wcId)) {
        this.activeWebContentsId = wcId
        if (worktreeId) {
          this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        }
        return { browserPageId: tabId, webContentsId: wcId }
      }
      this.browserManager.unregisterGuest(tabId)
    }

    throw new BrowserError(
      'browser_no_tab',
      'No live browser tab available — all registered tabs have been destroyed'
    )
  }

  // Why: don't fall back to the global tab for text mutation — it could inject into another worktree's foreground webview and steal focus.
  private resolveScopedActiveTab(worktreeId?: string): ResolvedBrowserCommandTarget {
    if (worktreeId) {
      return this.resolveActiveTab(worktreeId)
    }

    const worktreesWithLiveTabs = new Set<string | undefined>()
    for (const [tabId, wcId] of this.getRegisteredTabs(undefined)) {
      if (this.getWebContents(wcId)) {
        worktreesWithLiveTabs.add(this.browserManager.getWorktreeIdForTab(tabId))
      }
    }

    if (worktreesWithLiveTabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    if (worktreesWithLiveTabs.size > 1) {
      throw new BrowserError(
        'browser_target_ambiguous',
        'Multiple worktrees have browser tabs open; pass --worktree to target text insertion safely'
      )
    }

    const [onlyWorktreeId] = worktreesWithLiveTabs
    return this.resolveActiveTab(onlyWorktreeId)
  }

  private async ensureSession(
    sessionName: string,
    browserPageId: string,
    webContentsId: number
  ): Promise<void> {
    return this.sessionTargets.ensureSession(sessionName, browserPageId, webContentsId)
  }

  private async destroySession(
    sessionName: string,
    options: AgentBrowserCleanupOptions = { closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS }
  ): Promise<void> {
    return this.sessionTargets.destroySession(sessionName, options)
  }

  private assertCommandAdmission(): void {
    this.sessionTargets.assertCommandAdmission()
  }

  private async execAgentBrowser(
    sessionName: string,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<unknown> {
    return this.sessionTargets.execAgentBrowser(sessionName, commandArgs, execOptions)
  }

  private createPageUnavailableError(sessionName: string): BrowserError {
    return this.sessionTargets.createPageUnavailableError(sessionName)
  }

  private resolveTabIdSafe(webContentsId: number): string | null {
    const tabs = this.browserManager.getWebContentsIdByTabId()
    for (const [tabId, wcId] of tabs) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    return null
  }

  private requireTargetWebContents(target: ResolvedBrowserCommandTarget): WebContents {
    const wc = this.getWebContents(target.webContentsId)
    if (!wc || wc.isDestroyed()) {
      throw this.createPageUnavailableError(`${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`)
    }
    return wc
  }

  private getWebContents(webContentsId: number): Electron.WebContents | null {
    try {
      const { webContents } = require('electron')
      const target = webContents.fromId(webContentsId)
      return target && !target.isDestroyed() ? target : null
    } catch {
      return null
    }
  }
}
