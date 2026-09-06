/* eslint-disable max-lines -- Why: consolidated main-window open/tray/hook-listener controller exceeds the default cap after extraction */
import { app, dialog } from 'electron'
import type { BrowserWindow, Tray } from 'electron'
import {
  attachMainWindowServices,
  ensureAutoUpdaterConfigured
} from '../window/attach-main-window-services'
import { checkForUpdatesFromMenu, isQuittingForUpdate, resolveUpdateInstallMode } from '../updater'
import { createMainWindow, loadMainWindow } from '../window/createMainWindow'
import {
  createSystemTray,
  setMacMenuBarIconVisible,
  setTrayAttention,
  type SystemTrayOptions
} from '../tray/system-tray'
import { focusExistingMainWindow } from '../window/focus-existing-window'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { shouldRecoverRendererAfterProcessGone } from '../crash-reporting/process-gone-classification'
import { resolveConsent } from '../telemetry/consent'
import { trackAppOpenedOnce } from '../telemetry/client'
import { registerCoreHandlers } from '../ipc/register-core-handlers/register-core-handlers'
import { preserveAgentAuthBeforeRestart } from '../agent-auth-restart-preservation'
import { initTccPromptNotice } from '../macos-tcc-prompt-notice'
import { ensureWindowsUserDataAclGrant } from '../startup/windows-user-data-acl'
import { probeWindowsInstallDirAcl } from '../startup/windows-install-dir-acl-probe'
import { notifyMainWindowBecameVisible } from '../window/main-window-visibility'
import { logStartupMilestone } from '../startup/startup-diagnostics'
import { agentHookServer } from '../agent-hooks/server'
import { setMigrationUnsupportedPtyListener } from '../agent-hooks/migration-unsupported-pty-state'
import { isAskUserQuestionTool } from '../../shared/agent-question-answered-intent'

import type { CodexSessionResumePreparation } from '../codex/codex-session-resume-home'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
import type { CodexHomeLaunchContext } from '../ipc/pty'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import type { RateLimitService } from '../rate-limits/service'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { AutomationService } from '../automations/service'
import type { PluginService } from '../plugins/plugin-service'
import type { PluginMarketplaceService } from '../plugins/plugin-marketplace-service'
import type { PluginMarketplaceInstaller } from '../plugins/plugin-marketplace-installer'
import type { prepareCodexAiVaultSessionResume } from '../codex/codex-ai-vault-session-resume'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import type { CodexPaneHomeRoute } from '../codex/codex-pane-account-registry'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { SyntheticAgentTitleProfile } from '../../shared/synthetic-agent-title'
import type { AgentAwakeService } from '../agent-awake-service'
import type { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
import type { StatsCollector } from '../stats/collector'
import type { Store } from '../persistence'
import type { OrcaRuntimeService, RuntimeWorktreeLifecycleEvent } from '../runtime/orca-runtime'
import type { ExpectedTeardownScope } from '../crash-reporting/process-gone-classification'

export type MainWindowCreateDeps = {
  app: Electron.App
  isServeMode: boolean
  isDev: boolean
  windowTitle: string
  getStore: () => Store | null
  getRuntime: () => OrcaRuntimeService | null
  getStats: () => StatsCollector | null
  getClaudeUsage: () => ClaudeUsageStore | null
  getCodexUsage: () => CodexUsageStore | null
  getOpenCodeUsage: () => OpenCodeUsageStore | null
  getCodexAccounts: () => CodexAccountService | null
  getCodexRuntimeHome: () => CodexRuntimeHomeService | null
  getClaudeAccounts: () => ClaudeAccountService | null
  getClaudeRuntimeAuth: () => ClaudeRuntimeAuthService | null
  getRateLimits: () => RateLimitService | null
  getAutomations: () => AutomationService | null
  getKeybindings: () => KeybindingService | null
  getPluginService: () => PluginService | null
  getPluginMarketplaceService: () => PluginMarketplaceService | null
  getPluginMarketplaceInstaller: () => PluginMarketplaceInstaller | null
  getCrashReports: () => CrashReportStore | null
  getAgentAwakeService: () => AgentAwakeService | null
  getDesktopRelayService: () => DesktopRelayService | null
  isDevInstance: boolean
  devInstanceLabel: string
  onOpenSettingsPushed?: (webContentsId: number) => void
  onAgentStateObserved?: (agentType: string, state: string) => void
  getSyntheticAgentTitleProfile: (
    agentType: string | null | undefined
  ) => SyntheticAgentTitleProfile | null
  shouldDriveSyntheticAgentTitleFromHook: (
    agentType: string | null | undefined,
    state: string
  ) => boolean
  getMainWindow: () => BrowserWindow | null
  setMainWindow: (window: BrowserWindow | null) => void
  getIsQuitting: () => boolean
  setQuitting: () => void
  clearQuitting: () => void
  getLocalPtyStartupReady: () => Promise<void>
  getLocalPtyProviderStartupReady: () => Promise<void>
  markExpectedRendererReload: (webContentsId: number, durationMs?: number) => void
  clearExpectedRendererReload: (webContentsId?: number) => void
  markRecoveryReloadInFlight: (webContentsId: number, durationMs?: number) => void
  isRecoveryReloadInFlight: (webContentsId: number) => boolean
  getExpectedTeardownScope: (
    webContentsId?: number,
    includeSystemSessionEnd?: boolean
  ) => ExpectedTeardownScope
  prepareCodexRuntimeHomeForLaunch: (
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    launchContext?: CodexHomeLaunchContext
  ) => Promise<string | null>
  prepareCodexSessionResumeForLaunch: (args: {
    providerSession: AgentProviderSessionMetadata
    target: CodexAccountSelectionTarget
    launchEnv?: NodeJS.ProcessEnv
    workspacePath?: string
  }) => Promise<CodexSessionResumePreparation | null>
  prepareAiVaultSessionResume: (
    args: Parameters<typeof prepareCodexAiVaultSessionResume>[0]
  ) => ReturnType<typeof prepareCodexAiVaultSessionResume>
  handleCodexHomePtySpawned: (args: {
    id: string
    codexHomePath: string | null
    reattached?: boolean
    reattachedHomeRoute?: CodexPaneHomeRoute | null
    launchEnv?: NodeJS.ProcessEnv
    startedAt?: Date
    startedSequence?: number
  }) => void
  handlePtyExit: (id: string, exitSequence: number) => void
  emitPluginWorktreeLifecycle: (event: RuntimeWorktreeLifecycleEvent) => void
  maybeAutoRenameBranchOnFirstWorkFromHook: (event: {
    paneKey: string
    tabId: string | undefined
    worktreeId: string | undefined
    payload: { state: string; prompt?: string; lastAssistantMessage?: string }
    isReplay: boolean | undefined
  }) => void
  stopAllSyntheticTitleSpinners: () => void
  resumeSyntheticTitleSpinnerTimer: () => void
  stopSyntheticTitleSpinnerTimer: () => void
  driveSyntheticTitleFromHook: (
    paneKey: string,
    state: AgentStatusState,
    profile: SyntheticAgentTitleProfile
  ) => void
  shouldSuppressCodexAutoApprovalSyntheticTitleFromHook: (args: {
    agentType: string | null | undefined
    state: AgentStatusState
    launchConfig:
      | {
          agentArgs?: string | null
          agentEnv?: Record<string, string> | null
        }
      | null
      | undefined
  }) => boolean
  onSystemTrayOptionsNeeded: () => SystemTrayOptions | null
  recordProcessGoneCrash: (
    source: 'renderer' | 'child',
    processType: string,
    reason: string,
    exitCode: number | null,
    details: Record<string, unknown>,
    webContentsId?: number
  ) => void
  presentGpuFallbackRecoveredLaunchPrompt: (window: BrowserWindow) => Promise<void>
}

// Why: just past createMainWindow's 10s ready-to-show fallback, so a window revealed that way still gets its tray icon.
const TRAY_CREATE_FALLBACK_MS = 12_000

export function createMainWindowController(deps: MainWindowCreateDeps) {
  function focusExistingWindow(): void {
    focusExistingMainWindow({
      app: deps.app,
      getWindow: deps.getMainWindow,
      openWindow: openMainWindow,
      warn: console.warn
    })
  }

  // Why: restore the window the close handler may have hidden to tray, or reopen it (dock-reactivation style) if fully torn down.
  function showMainWindowFromTray(): void {
    const mainWindow = deps.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
      return
    }
    if (!isQuittingForUpdate()) {
      openMainWindow()
    }
  }

  function openSettingsFromSystemMenu(): void {
    showMainWindowFromTray()
    const targetWindow = deps.getMainWindow()
    const resolved = targetWindow && !targetWindow.isDestroyed() ? targetWindow : null
    if (!resolved) {
      return
    }
    recordCrashBreadcrumb('settings_opened')

    // Why: no signal proves the renderer listener is attached — push, and also leave a one-shot intent the unmounted renderer pulls at mount.
    resolved.webContents.send('ui:openSettings')
    deps.onOpenSettingsPushed?.(resolved.webContents.id)
  }

  function quitFromSystemTray(): void {
    const mainWindow = deps.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Why: a hidden session may veto shutdown with a save/discard prompt, so make the window visible.
      showMainWindowFromTray()
    }
    // Why: set the quit latch before app.quit() so the 'close' handler tears down instead of re-hiding to tray.
    deps.setQuitting()
    app.quit()
  }

  // Why: menu/tray are clickable before anything else configures the updater.
  function runUserInitiatedUpdateCheck(options?: UpdateCheckOptions): void {
    ensureAutoUpdaterConfigured()
    checkForUpdatesFromMenu(options)
  }

  function getSystemTrayOptions(): SystemTrayOptions | null {
    const store = deps.getStore()
    if (!store) {
      return null
    }
    return {
      appIcon: store.getSettings().appIcon,
      isDevInstance: deps.isDevInstance,
      devInstanceLabel: deps.devInstanceLabel,
      onOpen: showMainWindowFromTray,
      onOpenSettings: openSettingsFromSystemMenu,
      onCheckForUpdates: () => {
        // Why: updater status renders in the main window, so a bare check would complete invisibly.
        showMainWindowFromTray()
        runUserInitiatedUpdateCheck()
      },
      onQuit: quitFromSystemTray
    }
  }

  function syncMacMenuBarIcon(showMenuBarIcon: boolean): Tray | null {
    if (process.platform !== 'darwin' || deps.isServeMode) {
      return null
    }
    const options = getSystemTrayOptions()
    return options ? setMacMenuBarIconVisible(showMenuBarIcon, options) : null
  }

  function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
    logStartupMilestone('open-main-window-start')
    const store = deps.getStore()
    const runtime = deps.getRuntime()
    const stats = deps.getStats()
    const claudeUsage = deps.getClaudeUsage()
    const codexUsage = deps.getCodexUsage()
    const openCodeUsage = deps.getOpenCodeUsage()
    const rateLimits = deps.getRateLimits()
    const automations = deps.getAutomations()
    const codexAccounts = deps.getCodexAccounts()
    const codexRuntimeHome = deps.getCodexRuntimeHome()
    const claudeAccounts = deps.getClaudeAccounts()
    const claudeRuntimeAuth = deps.getClaudeRuntimeAuth()
    const keybindings = deps.getKeybindings()
    if (!store) {
      throw new Error('Store must be initialized before opening the main window')
    }
    if (!runtime) {
      throw new Error('Runtime must be initialized before opening the main window')
    }
    if (!stats) {
      throw new Error('Stats must be initialized before opening the main window')
    }
    if (!claudeUsage) {
      throw new Error('Claude usage store must be initialized before opening the main window')
    }
    if (!codexUsage) {
      throw new Error('Codex usage store must be initialized before opening the main window')
    }
    if (!openCodeUsage) {
      throw new Error('OpenCode usage store must be initialized before opening the main window')
    }
    if (!rateLimits) {
      throw new Error('Rate limit service must be initialized before opening the main window')
    }
    if (!automations) {
      throw new Error('Automation service must be initialized before opening the main window')
    }
    if (!codexAccounts) {
      throw new Error('Codex account service must be initialized before opening the main window')
    }
    if (!codexRuntimeHome) {
      throw new Error(
        'Codex runtime home service must be initialized before opening the main window'
      )
    }
    if (!claudeAccounts) {
      throw new Error('Claude account service must be initialized before opening the main window')
    }
    if (!claudeRuntimeAuth) {
      throw new Error(
        'Claude runtime auth service must be initialized before opening the main window'
      )
    }
    if (!keybindings) {
      throw new Error('Keybinding service must be initialized before opening the main window')
    }

    // Why: Chromium's BrowserWindow ctor resets userData to a Protected DACL, breaking writes; re-grant ACEs (marker-gated to avoid a ~60s startup stall).
    if (process.platform === 'win32') {
      logStartupMilestone('acl-grant-start')
      ensureWindowsUserDataAclGrant(app.getPath('userData'), {
        onDone: (result) => {
          logStartupMilestone('acl-grant-done', { mode: result.mode })
          if (result.mode === 'failed') {
            console.warn('[win32-acl] userData ACL grant failed:', result.reason)
          }
        }
      })
      // Why here: read-only, and the install DACL is the one thing a 0x80000003
      // child death cannot tell us about itself. See electron/electron#51761.
      probeWindowsInstallDirAcl({ isServeMode: deps.isServeMode })
    }

    const window = createMainWindow(store, {
      getIsQuitting: deps.getIsQuitting,
      onQuitAborted: () => {
        deps.clearQuitting()
        deps.clearExpectedRendererReload()
      },
      onRendererProcessGone: (details, webContentsId) => {
        deps.recordProcessGoneCrash(
          'renderer',
          'renderer',
          details.reason,
          details.exitCode ?? null,
          {
            processType: 'renderer'
          },
          webContentsId
        )
      },
      shouldRecoverRenderer: (details, webContentsId) =>
        shouldRecoverRendererAfterProcessGone({
          reason: details.reason,
          expectedTeardown: deps.getExpectedTeardownScope(webContentsId, false)
        }),
      onRendererRecoveryExhausted: ({ details, recentRecoveryCount }) => {
        recordDurableCrashBreadcrumb('renderer_recovery_circuit_breaker_open', {
          reason: details.reason,
          exitCode: details.exitCode ?? null,
          recentRecoveryCount
        })
        void presentRendererRecoveryPrompt(recentRecoveryCount)
      },
      deferLoad: true,
      ...(options.revealOnDidFinishLoad === true ? { revealOnDidFinishLoad: true } : {}),
      title: deps.windowTitle,
      getKeybindings: () => keybindings?.getOverrides(),
      onBeforeReload: ({ ignoreCache, webContentsId }) => {
        if (deps.getMainWindow()?.webContents.id === webContentsId) {
          deps.markExpectedRendererReload(webContentsId)
        }
        recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
      },
      // Why: the recovery reload re-fires did-finish-load; flag it so the local-PTY orphan sweep skips that reload (#5787).
      onBeforeRecoveryReload: (webContentsId) => {
        deps.markRecoveryReloadInFlight(webContentsId)
        recordDurableCrashBreadcrumb('renderer_recovery_reload')
      }
    })
    recordCrashBreadcrumb('main_window_created')
    logStartupMilestone('window-created')
    // Why: Windows Tray construction can block synchronously on Shell_NotifyIcon, so both platforms defer creation to after first paint.
    let trayCreated = false
    const createSystemTrayDeferred = (): void => {
      if (trayCreated || window.isDestroyed() || deps.getIsQuitting() || !deps.getStore()) {
        return
      }
      trayCreated = true
      if (process.platform === 'darwin') {
        // Why: route through syncMacMenuBarIcon so startup and the live toggle share one serve-mode/visibility policy.
        if (syncMacMenuBarIcon(deps.getStore()!.getSettings().showMenuBarIcon !== false)) {
          logStartupMilestone('tray-created')
        }
        return
      }
      const options = getSystemTrayOptions()
      if (options && createSystemTray(options)) {
        logStartupMilestone('tray-created')
      }
    }
    window.once('ready-to-show', () => {
      logStartupMilestone('ready-to-show')
      setImmediate(createSystemTrayDeferred)
    })
    window.once('show', () => {
      logStartupMilestone('window-shown')
      void deps.presentGpuFallbackRecoveredLaunchPrompt(window)
    })
    const trayCreateFallback = setTimeout(createSystemTrayDeferred, TRAY_CREATE_FALLBACK_MS)
    trayCreateFallback.unref?.()

    // Why: telemetry-plan.md anchors default-on app_opened to the first main-window load; this path fires only once consent is already enabled.
    const rendererWebContentsId = window.webContents.id
    const onFirstWindowLoad = (): void => {
      deps.clearExpectedRendererReload(rendererWebContentsId)
      recordCrashBreadcrumb('main_window_loaded')
      logStartupMilestone('did-finish-load')
      if (!deps.getStore()) {
        return
      }
      const consent = resolveConsent(deps.getStore()!.getSettings())
      if (consent.effective !== 'enabled') {
        return
      }
      trackAppOpenedOnce()
    }
    window.webContents.on('did-finish-load', onFirstWindowLoad)

    registerCoreHandlers(
      store,
      runtime,
      stats,
      claudeUsage,
      codexUsage,
      openCodeUsage,
      codexAccounts,
      claudeAccounts,
      rateLimits,
      rendererWebContentsId,
      automations,
      {
        prepareForCodexLaunch: deps.prepareCodexRuntimeHomeForLaunch,
        prepareForClaudeLaunch: (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target)
      },
      deps.getAgentAwakeService() ?? undefined,
      deps.getCrashReports() ?? undefined,
      keybindings,
      {
        getAdditionalAiVaultCodexHomePaths: () =>
          codexRuntimeHome ? codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery() : [],
        prepareAiVaultSessionResume: (args) => deps.prepareAiVaultSessionResume(args),
        onBeforeRelaunch: async () => {
          deps.setQuitting()
          deps.getDesktopRelayService()?.fenceAndCloseNow()
          await preserveAgentAuthBeforeRestart({
            codexRuntimeHome,
            claudeRuntimeAuth,
            store
          })
        },
        onOrcaProfileAuthMutation: () => deps.getDesktopRelayService()?.authMutated(),
        onBeforeOrcaProfileSignOut: () => deps.getDesktopRelayService()?.fenceAndCloseNow()
      },
      deps.getPluginService() ?? undefined,
      deps.getPluginMarketplaceService() && deps.getPluginMarketplaceInstaller()
        ? {
            marketplace: deps.getPluginMarketplaceService()!,
            installer: deps.getPluginMarketplaceInstaller()!
          }
        : undefined
    )
    automations.setWebContents(window.webContents)
    automations.start()
    attachMainWindowServices(
      window,
      store,
      runtime,
      deps.prepareCodexRuntimeHomeForLaunch,
      (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
      {
        prepareCodexSessionResume: deps.prepareCodexSessionResumeForLaunch,
        awaitLocalPtyStartup: deps.getLocalPtyStartupReady,
        awaitLocalPtyProviderStartup: deps.getLocalPtyProviderStartupReady,
        onBeforeRendererReload: ({ ignoreCache, webContentsId }) => {
          if (window.webContents.id === webContentsId) {
            deps.markExpectedRendererReload(webContentsId)
          }
          recordCrashBreadcrumb('renderer_reload_requested', { ignoreCache })
        },
        // Why: let the PTY layer skip its orphan sweep on the recovery reload that re-fires did-finish-load, so live local sessions survive (#5787).
        isRecoveryReloadInFlight: deps.isRecoveryReloadInFlight,
        onCodexHomePtySpawned: deps.handleCodexHomePtySpawned,
        onPtyExit: deps.handlePtyExit,
        onBeforeUpdateQuit: () =>
          preserveAgentAuthBeforeRestart({
            codexRuntimeHome,
            claudeRuntimeAuth,
            store
          }),
        updateInstallMode: resolveUpdateInstallMode(deps.isServeMode),
        onWorktreeLifecycle: deps.emitPluginWorktreeLifecycle
      }
    )
    // Why: attach the durable renderer pull now, but launch the diagnostic process after first paint.
    initTccPromptNotice(window, { deferWatchUntilReadyToShow: true })
    rateLimits.attach(window)
    // Why: quota probes spawn CLIs and hit network, so don't fetch immediately and compete with first paint; show/focus listeners refresh later.
    rateLimits.start({ fetchImmediately: false })
    window.on('closed', () => {
      if (deps.getMainWindow() === window) {
        deps.setMainWindow(null)
      }
      deps.clearExpectedRendererReload(rendererWebContentsId)
      automations?.setWebContents(null)
      // Why: detach the hook listener on close so the server never fires into destroyed webContents before reopen, and replay runs only on deliberate recreations.
      agentHookServer.setListener(null)
      agentHookServer.setPaneStatusClearListener(null)
      setMigrationUnsupportedPtyListener(null)
      // Why: stop the spinner timer here — it would fire into destroyed webContents, and per-pane teardown may never run for restored-but-untorn panes.
      deps.stopAllSyntheticTitleSpinners()
    })
    deps.setMainWindow(window)
    window.on('show', deps.resumeSyntheticTitleSpinnerTimer)
    window.on('restore', deps.resumeSyntheticTitleSpinnerTimer)
    window.on('hide', deps.stopSyntheticTitleSpinnerTimer)
    window.on('minimize', deps.stopSyntheticTitleSpinnerTimer)
    // Why: visibility-gated pollers (SSH port scanner) park while hidden and resume on this signal; re-wired per window since dock re-activation recreates it.
    window.on('show', notifyMainWindowBecameVisible)
    window.on('restore', notifyMainWindowBecameVisible)
    // Why: user is back on show/restore, so clear the tray attention dot set while hidden (see notifications.ts).
    window.on('show', () => setTrayAttention(false))
    window.on('restore', () => setTrayAttention(false))
    agentHookServer.setListener(
      ({
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        payload,
        receivedAt,
        stateStartedAt,
        launchToken,
        providerSession,
        providerSessionOnly,
        promptInteractionKey,
        restoredUnconfirmed,
        observation,
        isReplay
      }) => {
        const mainWindow = deps.getMainWindow()
        if (mainWindow?.isDestroyed()) {
          return
        }
        if (providerSessionOnly) {
          // Why: session_start just refreshes durable resume identity while Pi is idle; forward it without titles, telemetry, or status UI.
          mainWindow?.webContents.send('agentStatus:set', {
            ...payload,
            paneKey,
            ...(launchToken ? { launchToken } : {}),
            tabId,
            worktreeId,
            connectionId,
            receivedAt,
            stateStartedAt,
            ...(providerSession ? { providerSession } : {}),
            ...(observation ? { observation } : {}),
            providerSessionOnly: true
          })
          return
        }
        if (!restoredUnconfirmed) {
          deps.maybeAutoRenameBranchOnFirstWorkFromHook({
            paneKey,
            tabId,
            worktreeId,
            payload,
            isReplay
          })
        }
        const orchestration = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)
        const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
        const suppressSyntheticCodexAutoApprovalTitle =
          payload.agentType === 'codex' &&
          (payload.state === 'waiting' || payload.state === 'blocked')
            ? deps.shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
                agentType: payload.agentType,
                state: payload.state,
                launchConfig: runtime?.getAgentStatusLaunchConfigForPaneKey(paneKey, {
                  launchToken
                })
              })
            : false
        const statusEvent = {
          ...payload,
          paneKey,
          ...(launchToken ? { launchToken } : {}),
          ...(terminalHandle ? { terminalHandle } : {}),
          tabId,
          worktreeId,
          connectionId,
          receivedAt,
          stateStartedAt,
          ...(providerSession ? { providerSession } : {}),
          ...(promptInteractionKey ? { promptInteractionKey } : {}),
          ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
          ...(observation ? { observation } : {}),
          ...(orchestration ? { orchestration } : {})
        }
        mainWindow?.webContents.send('agentStatus:set', statusEvent)
        if (!suppressSyntheticCodexAutoApprovalTitle || isAskUserQuestionTool(payload.toolName)) {
          getDashboardPopoutWindow()?.webContents.send('agentStatus:set', statusEvent)
        }
        deps.onAgentStateObserved?.(payload.agentType ?? 'unknown', payload.state)
        // Why: native OSC titles miss some idle/permission frames, so inject hook-derived ones to keep the renderer title tracker in sync.
        const profile = deps.getSyntheticAgentTitleProfile(payload.agentType)
        if (
          profile &&
          deps.shouldDriveSyntheticAgentTitleFromHook(payload.agentType, payload.state) &&
          !suppressSyntheticCodexAutoApprovalTitle
        ) {
          deps.driveSyntheticTitleFromHook(paneKey, payload.state, profile)
        }
      }
    )
    agentHookServer.setPaneStatusClearListener((clear) => {
      const mainWindow = deps.getMainWindow()
      if (mainWindow?.isDestroyed()) {
        return
      }
      mainWindow?.webContents.send('agentStatus:clear', clear)
      getDashboardPopoutWindow()?.webContents.send('agentStatus:clear', clear)
    })
    setMigrationUnsupportedPtyListener((event) => {
      const mainWindow = deps.getMainWindow()
      if (mainWindow?.isDestroyed()) {
        return
      }
      if (event.type === 'set') {
        mainWindow?.webContents.send('agentStatus:migrationUnsupported', event.entry)
      } else {
        mainWindow?.webContents.send('agentStatus:migrationUnsupportedClear', {
          ptyId: event.ptyId
        })
      }
    })
    logStartupMilestone('load-start')
    loadMainWindow(window)
    return window
  }

  function sendOpenFeatureTour(targetWindow?: BrowserWindow | null): void {
    const webContents =
      targetWindow && !targetWindow.isDestroyed()
        ? targetWindow.webContents
        : deps.getMainWindow()?.webContents
    webContents?.send('ui:openFeatureTour')
  }

  function sendOpenSetupGuide(targetWindow?: BrowserWindow | null): void {
    const webContents =
      targetWindow && !targetWindow.isDestroyed()
        ? targetWindow.webContents
        : deps.getMainWindow()?.webContents
    webContents?.send('ui:openSetupGuide')
  }

  function sendOpenCrashReport(targetWindow?: BrowserWindow | null): void {
    const webContents =
      targetWindow && !targetWindow.isDestroyed()
        ? targetWindow.webContents
        : deps.getMainWindow()?.webContents
    webContents?.send('ui:openCrashReport')
  }

  // Why: on renderer crash-loop the breaker stops auto-reloading and the window goes blank, so a main-process dialog is the only retry/quit surface.
  async function presentRendererRecoveryPrompt(recentRecoveryCount: number): Promise<void> {
    if (deps.getIsQuitting()) {
      return
    }
    const mainWindow = deps.getMainWindow()
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const options = {
      type: 'error' as const,
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      title: 'Orca keeps failing to load',
      message: 'The app window crashed repeatedly and stopped reloading automatically.',
      detail: `Orca tried to recover ${recentRecoveryCount} times in a row without success. This is often a graphics-driver or installation problem. Reload to try again, or quit and relaunch Orca.`
    }
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    if (response === 0 && deps.getMainWindow() && !deps.getMainWindow()!.isDestroyed()) {
      recordDurableCrashBreadcrumb('renderer_recovery_manual_retry')
      loadMainWindow(deps.getMainWindow()!)
    } else if (response === 1) {
      deps.setQuitting()
      app.quit()
    }
  }

  return {
    focusExistingWindow,
    showMainWindowFromTray,
    openSettingsFromSystemMenu,
    quitFromSystemTray,
    runUserInitiatedUpdateCheck,
    getSystemTrayOptions,
    syncMacMenuBarIcon,
    openMainWindow,
    sendOpenFeatureTour,
    sendOpenSetupGuide,
    sendOpenCrashReport,
    presentRendererRecoveryPrompt
  }
}
