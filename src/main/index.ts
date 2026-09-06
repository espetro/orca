/* eslint-disable max-lines -- main-process entry point; owns app lifecycle, service wiring, window creation, and hook/daemon startup with no cleaner split seam. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import os from 'node:os'
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  powerMonitor,
  type Tray,
  session
} from 'electron'
import { applyMacPressAndHoldDefaultAtStartup } from './macos-press-and-hold-default'
import { getBenchStartupSwitches } from './bench-startup-switches'
import { stopTccPromptNotice } from './macos-tcc-prompt-notice'
import { electronApp, is } from '@electron-toolkit/utils'
import {
  Store,
  initDataPath,
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from './persistence'
import { setAppEnvironment } from '../shared/app-environment'
import { ElectronAppEnvironment } from './host/electron-app-environment'
import { setPtyHostBindings } from './ipc/pty-host-bindings'
import { electronRuntimeDesktopSurface } from './host/electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from './runtime/runtime-desktop-surface'
import { electronRuntimeBrowserCommandsFactory } from './host/electron-browser-commands'
import { setRuntimeBrowserCommandsFactory } from './runtime/runtime-browser-commands-factory'
import { electronHttpClient } from './host/electron-http-client'
import { setMainHttpClient } from './network/http-client'
import { electronSpeechServiceFactories } from './host/electron-speech-services'
import { setSpeechServiceFactories } from './speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from './ipc/worktree-watcher-removal'
import { setSecretStore } from '../shared/secret-store'
import { ElectronSecretStore } from './host/electron-secret-store'
import { scheduleSecretProtectionGapReport } from './host/deferred-secret-protection-report'
import { initSessionParseCachePersistence } from './ai-vault/session-parse-cache-persistence'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from './orca-profiles/profile-index-store'
import { getOrcaCloudAuthConfig } from './orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from './orca-profiles/profile-storage-paths'
import { applyAppIcon } from './app-icon'
import { StatsCollector, initStatsPath } from './stats/collector'
import { initSshHostKeyStoreFile } from './ssh/ssh-host-key-store'
import { AgentSessionTransitionRecorder } from './stats/agent-session-transition-recorder'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from './opencode-usage/store'
import {
  killAllPty,
  clearProviderPtyState,
  getPtyIdForPaneKey,
  registerPaneKeyTeardownListener,
  getLocalPtyProvider,
  getSshPtyProvider,
  registerHeadlessPtyRuntime
} from './ipc/pty'
import {
  initDaemonPtyProvider,
  disconnectDaemon,
  getDaemonProvider,
  listLiveDaemonPtyIds,
  shutdownDaemon
} from './daemon/daemon-init'
import {
  type CodexPaneHomeRoute,
  getCodexPaneAccount,
  hasRecordedManagedHostCodexPane,
  isCodexPaneHomeRouteProvenAwayFromSharedHome,
  reconcileCodexPaneAccountsWithLivePtys
} from './codex/codex-pane-account-registry'
import { closeAllWatchers, desktopWorktreeWatcherRemoval } from './ipc/filesystem-watcher'
import { disposeWorktreeBaseDirectoryWatchers } from './ipc/worktree-base-directory-watcher'
import { stopFolderRepoGitUpgradeWatch } from './ipc/folder-repo-git-upgrade'
import { initObservability, shutdownObservability } from './observability'
import { registerMobileHandlers } from './ipc/mobile'
import { initTelemetry, shutdownTelemetry, track } from './telemetry/client'
import { classifyError } from './telemetry/classify-error'
import { recordManagedHookInstallFailure } from './agent-hooks/install-telemetry'
import {
  indexPersistedPaneKeyPtyIds,
  isLocalExecutionHost,
  resolveAgentWorkspaceExecutionHostId,
  sweepRestoredSubagentsWithoutLiveAgent
} from './agent-hooks/restored-subagent-liveness-sweep'
import {
  installManagedAgentHooks,
  isAgentStatusHooksEnabled,
  removeManagedAgentHooksAsync,
  resolveStartupManagedHookAction,
  shouldInstallStartupManagedAgentHook,
  shouldContinueManagedHookStartup
} from './agent-hooks/managed-agent-hook-controls'
import { initCohortClassifier } from './telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from './telemetry/onboarding-cohort-classifier'
import { triggerStartupNotificationRegistration } from './ipc/startup-notification-registration'
import { OrcaRuntimeService, type RuntimeWorktreeLifecycleEvent } from './runtime/orca-runtime'
import { ArtifactCloudService } from './artifacts/artifact-cloud-service'
import { SkillCloudService } from './skills/skill-cloud-service'
import { recoverPendingSkillTransactions } from './skills/skill-transaction-startup-recovery'
import { isArtifactSharingEnabled } from '../shared/artifact-sharing-gate'
import { loadAgentSessionClaimSigner } from './runtime/agent-session-claim-identity'
import {
  fingerprintOrchestrationPeer,
  type OrchestrationEnvironmentTransport
} from './runtime/orchestration/environment-transport'
import { callRuntimeEnvironment } from './ipc/runtime-environment-transport-routing'
import { resolveEnvironment } from '../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../shared/runtime-environments'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import {
  recordRuntimeRpcStartFailure,
  showRuntimeRpcStartupFailureDialog
} from './runtime/runtime-rpc-startup-failure'
import { reserveServeStdoutForReadiness } from './server/serve-stdout-boundary'
import { DesktopRelayService } from './runtime/relay/desktop-relay-service'
import type { RelayBrokerStatus } from './runtime/relay/relay-session-broker'
import { awaitRuntimeFileWatcherUnsubscribes } from './runtime/orca-runtime-files'
import { clearRuntimeMetadataIfOwned } from './runtime/runtime-metadata'
import { scheduleAllPendingHistoryTreeRemovals } from './terminal-history-deletion'
import { ensureMainI18n, setMainPluginLanguagePacks, setMainUiLanguage } from './i18n/main-i18n'
import {
  getNextDefaultOnAppearanceSettingValue,
  registerAppMenu,
  rebuildAppMenu
} from './menu/register-app-menu'
import {
  checkForRemoteServerUpdate,
  downloadRemoteServerUpdate,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdate,
  isQuittingForUpdate
} from './updater'
import { configureRemoteServerUpdater } from './runtime/remote-server-updater'
import type { UpdateCheckOptions } from '../shared/update-status-types'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import { installServeSupervisorDisconnectQuit } from './serve-update-handoff'
import {
  configureElectronNetworkCompatibility,
  configureDevUserDataPath,
  configureOrcaUserDataPathEnv,
  disableUnsupportedChromiumFeatures,
  optOutOfHiddenPageWakeUpThrottling,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentSignalQuit,
  installDevParentWatchdog,
  isDevParentShutdownRequested,
  patchPackagedProcessPath,
  shouldInstallManagedHooks
} from './startup/configure-process'
import {
  installUncaughtPipeErrorGuard,
  installUnhandledRejectionLogging
} from './startup/main-process-error-guards'
import { enableRendererHeapHeadroom } from './startup/renderer-heap-headroom'
import {
  configureSessionCodeCache,
  enableMainProcessCompileCache
} from './startup/native-code-cache'
import { argvRequestsServeMode, normalizeServeModeArgv } from './startup/serve-mode-argv'
import { ensureVirtualDisplayForHeadlessServe } from './startup/ensure-virtual-display'
import {
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './startup/dev-education-suppression'
import { maybeRedirectAppImageCliLaunch } from './startup/appimage-cli-redirect'
import { maybeRedirectPackagedCliEntryLaunch } from './startup/packaged-cli-entry-redirect'
import { startFirstWindowStartupServices } from './startup/first-window-startup-services'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './startup/legacy-worker-renderer-recovery'
import { createWslCliReconciliationStartupBarrier } from './startup/wsl-cli-reconciliation-startup-barrier'
import { getDevInstanceIdentity, shouldApplyPreReadyAppName } from './startup/dev-instance-identity'
import { hydrateShellPath, mergePathSegments } from './startup/hydrate-shell-path'
import { createWindowsShellPathHydration } from './startup/windows-shell-path-hydration'
import {
  startWindowsDesktopBeforeShellPathReady,
  type WindowsDesktopStartupServices
} from './startup/windows-desktop-shell-path-startup'
import {
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  shouldActivateDesktopForSecondInstance,
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
} from './startup/single-instance-lock'
import { startEventLoopStallProbe } from './startup/event-loop-stall-probe'
import { startMainThreadChurnProbe } from './diagnostics/main-thread-churn-probe'
import { settledDiffCache } from './git/source-control/git-read-cache-invalidation'
import { parseSkillShareId } from '../shared/skill-share-link'
import { SkillShareDeepLinkState } from './startup/skill-share-deep-link-state'
import {
  isStartupDiagnosticsEnabled,
  logStartupDiagnostic,
  logStartupMilestone
} from './startup/startup-diagnostics'
import { neutralizeLegacyTerminalShimDir } from './pty/legacy-terminal-shim-dir'
import { shouldQuitWhenAllWindowsClosed } from './startup/window-all-closed-quit-policy'
import { registerServeSignalHandlers } from './startup/serve-signal-handlers'
import {
  createServeDesktopActivationGate,
  settleServeDesktopActivation as settleServeDesktopActivationGate
} from './startup/serve-desktop-activation'
import { RateLimitService } from './rate-limits/service'
import { readMiniMaxSessionCookie } from './minimax/minimax-cookie-store'
import { getInitialClaudeRateLimitTarget } from './rate-limits/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from './rate-limits/codex-rate-limit-target'
import { getKimiRuntimeTarget, resolveKimiHome } from './kimi/kimi-runtime-home'
import { createAccountRuntimeTargetSettingsSync } from './rate-limits/account-runtime-target-sync'
import { shutdownPairedRuntimeBrowserClientHosts } from './browser/paired-runtime-browser-client-host-runtime'
import { zoomDashboardPopoutIfFocused } from './window/dashboard-popout-window'
import { destroySystemTray, type SystemTrayOptions } from './tray/system-tray'
import { createMacAppActivationHandler } from './window/macos-app-activation'
import { CodexAccountService } from './codex-accounts/service'
import { CodexRuntimeHomeService } from './codex-accounts/runtime-home-service'
import { normalizeCodexRuntimeSelection } from './codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from './claude-accounts/runtime-selection'
import { codexHookService, setSystemCodexHomeHookSweepSuppressed } from './codex/hook-service'
import { reconcileRetainedCodexHookHomes } from './codex/retained-codex-hook-state'
import { isRealHomeCodexHookLaneUsable } from './codex/codex-real-home-hook-install'
import { setCodexTrustGrantTelemetry } from './codex/codex-trust-grant-telemetry'
import { startCodexSessionBackfillInBackground } from './codex/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from './codex/codex-session-index-heal'
import {
  startCodexStateDbBackfillRecoveryInBackground,
  stopCodexStateDbBackfillRecoveries
} from './codex/codex-state-db-backfill-recovery'
import { createCodexSessionMigrationScheduler } from './codex/codex-session-migration-scheduler'
import { getOrcaManagedCodexHomePath } from './codex/codex-home-paths'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from './worktree-trash'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import {
  attachClaudeLivePtyPersistence,
  onLiveClaudePtysDrained,
  seedLiveClaudePtysFromPersistence
} from './claude-accounts/live-pty-gate'
import { StarNagService } from './star-nag/service'
import { agentHookServer, type AgentHookProviderSessionIdentity } from './agent-hooks/server'
import { createHookProviderSessionInvalidator } from './agent-hooks/hook-provider-session-invalidation'
import { createHookStatusSessionTabsInvalidator } from './agent-hooks/hook-status-session-tabs-invalidation'
import { wslHookRelayManager } from './agent-hooks/wsl-hook-relay-manager'
import {
  configureWindowsHostGitEnvironmentReadiness,
  setDefaultWslDistroOverride
} from './git/runner'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { configureBrowserClientPageAutomationRuntime } from './browser/browser-client-page-automation-runtime'
import { BrowserClientPageCommandError } from './browser/browser-client-page-command-failure'
import { EmulatorBridge } from './emulator/emulator-bridge'
import { browserCertificateTrustController, browserManager } from './browser/browser-manager'
import { setServeBrowserSettingsResolver } from './browser/serve-browser-settings'
import { RpcDispatcher } from './runtime/rpc/dispatcher'
import { OffscreenBrowserBackend } from './browser/offscreen-browser-backend'
import { initializeBrowserSessionsForApp } from './browser/browser-session-startup'
import {
  installDocPreviewProtocolHandler,
  registerDocPreviewSchemePrivileges
} from './browser/doc-preview-protocol'
import { registerDocPreviewGrantHandlers } from './ipc/doc-preview-grant-ipc'
import { initializeBrowserClientHostId } from './browser/browser-client-host-id'
import { AutomationService } from './automations/service'
import { createHeadlessAutomationOutputSnapshotBuffer } from './automations/headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from './automations/headless-workspace-create'
import { createRuntimeAutomationRunTerminalObserver } from './automations/runtime-terminal-run-observer'
import { AgentAwakeService } from './agent-awake-service'
import { normalizeComputerAwakeMode } from '../shared/computer-awake-mode'
import { registerSystemResumeBroadcast } from './system-resume-broadcast'
import { settleTeardownWithinDeadline, settleWithinMs } from './quit-teardown-deadline'
import { stopStructuredAgentSessionRuntime } from './runtime/structured-agent-session-runtime'
import { quitTeardownStartGate } from './quit-teardown-start-gate'
import { beginSshShutdown } from './ipc/ssh-shutdown-drain'
import { PluginService } from './plugins/plugin-service'
import { PluginKillListService } from './plugins/plugin-kill-list-service'
import { getPluginsDataDir } from './plugins/plugin-discovery'
import { PluginMarketplaceService } from './plugins/plugin-marketplace-service'
import { PluginMarketplaceInstaller } from './plugins/plugin-marketplace-installer'
import { PluginBundledBootstrapCoordinator } from './plugins/plugin-bundled-bootstrap-coordinator'
import { resolveBundledPluginRoot } from './plugins/plugin-bundled-bootstrap'
import { resolvePluginHostEntryPath } from './plugins/plugin-host-process'
import { applyPluginConsent, applyPluginEnablement } from './plugins/plugin-enablement'
import { setPluginServiceForRpc } from './runtime/rpc/methods/plugins'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../shared/plugins/plugin-consent-state'
import {
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { installMainThreadHangWatchdog } from './hang-watchdog/main-thread-hang-watchdog'
import { installResourceRecorderIpcHandlers } from './metrics/resource-recorder-ipc'
import { startResourceRecorderIfEnabled } from './metrics/resource-recorder'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath
} from './hang-watchdog/hang-detection-marker'
import { getMainProcessLifecycleIdentity } from './crash-reporting/main-process-lifecycle-identity'
import { CrashReportStore } from './crash-reporting/crash-report-store'
import { recordProcessGoneCrash as recordProcessGoneCrashEvent } from './crash-reporting/process-gone-recorder'
import { startCrashpadCapture } from './crash-reporting/crashpad-capture'
import { startPreGoneProcessMetricsSampling } from './crash-reporting/process-gone-diagnostics'
import {
  createSyntheticTitleSpinnerController,
  shouldSuppressCodexAutoApprovalSyntheticTitleFromHook
} from './windows/synthetic-title-spinner'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook
} from '../shared/synthetic-agent-title'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeDesktopWindowStatus
} from '../shared/runtime-types'
import { LocalPtyProvider } from './providers/local-pty-provider'
import { KeybindingService } from './keybindings/keybinding-service'
import {
  applyElectronProxySettings,
  setDefaultProxySessionResolver
} from './network/proxy-settings'
import { reconcileManagedWslCliRegistrations } from './cli/wsl-cli-registration-reconciliation'
import { createFirstWorkRenameHookAdapter } from './agent-hooks/first-work-rename-hook-adapter'
import {
  createWebContentsReloadFlags,
  createWebContentsTimedFlag
} from './windows/webcontents-reload-flags'
import { createGpuFallbackLaunchController } from './windows/gpu-fallback-launch'
import { createMainWindowController } from './windows/main-window-create'
import { createCodexLaunchPreparation } from './runtime/codex-launch-preparation'
import { ensureRealHomeCodexHookState } from './codex/codex-real-home-hook-install'
import { prepareCodexAiVaultSessionResume } from './codex/codex-ai-vault-session-resume'
import { resolveHostCodexSessionSourceHome } from './codex/codex-session-source-home'
import { setUnreadDockBadgeCount } from './dock/unread-badge'
import type { ServeOptions } from './serve/serve-startup'
import { createServeStartup, getBundledWebClientRoot, getServeOptions } from './serve/serve-startup'

let mainWindow: BrowserWindow | null = null
/** Whether a manual app.quit() (Cmd+Q) is in progress; lets the close handler skip the running-process confirmation and go straight to close. */
let isQuitting = false
let store: Store | null = null
let stats: StatsCollector | null = null
let claudeUsage: ClaudeUsageStore | null = null
let codexUsage: CodexUsageStore | null = null
let openCodeUsage: OpenCodeUsageStore | null = null
let codexAccounts: CodexAccountService | null = null
let codexRuntimeHome: CodexRuntimeHomeService | null = null
let codexSessionMigration: ReturnType<typeof createCodexSessionMigrationScheduler> | null = null
let claudeAccounts: ClaudeAccountService | null = null
let claudeRuntimeAuth: ClaudeRuntimeAuthService | null = null
let runtime: OrcaRuntimeService | null = null
let rateLimits: RateLimitService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null
let desktopRelayService: DesktopRelayService | null = null
let desktopRelayStatus: RelayBrokerStatus = 'offline'
let pendingUnpairedDeviceAuthFailure = false
// Why: gates whether headless serve installs the offscreen browser backend (and advertises browser pane support).
let headlessBrowserDisplayAvailable = false

let starNag: StarNagService | null = null
let agentAwakeService: AgentAwakeService | null = null
let crashReports: CrashReportStore | null = null
let unsubscribeAgentAwakeStatusChanges: (() => void) | null = null
let unsubscribeSystemResumeBroadcast: (() => void) | null = null
let watcherShutdownPromise: Promise<void> | null = null
let watcherShutdownDone = false
let automations: AutomationService | null = null
let pluginService: PluginService | null = null
let pluginKillListService: PluginKillListService | null = null
let pluginMarketplaceService: PluginMarketplaceService | null = null
let pluginMarketplaceInstaller: PluginMarketplaceInstaller | null = null
let keybindings: KeybindingService | null = null

function emitPluginWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
  pluginService?.emitEvent(
    event.kind === 'created' ? 'worktree.created' : 'worktree.removed',
    event.kind === 'created'
      ? { worktreeId: event.worktreeId, path: event.path, branch: event.branch }
      : { worktreeId: event.worktreeId, path: event.path }
  )
}
// Why: a tray "Settings…" click can precede the renderer's ui:openSettings listener; it pulls this one-shot on mount.
const pendingOpenSettings = createWebContentsTimedFlag()
const skillShareDeepLinks = new SkillShareDeepLinkState()
let firstWindowStartupServicesReady: Promise<void> = Promise.resolve()
let managedWslCliReconciliationReady: Promise<void> = Promise.resolve()
let managedWslCliStartupBarrierReady: Promise<void> = Promise.resolve()
// Why: the serve barrier fails open, so this state tells headless clients a WSL PTY launch may still race an un-migrated registration ('settled' = off-Windows no-op).
let managedWslCliReconciliationStatus: 'pending' | 'settled' | 'failed' = 'settled'
let localPtyStartupReady: Promise<void> = Promise.resolve()
let localPtyProviderStartupReady: Promise<void> = Promise.resolve()
const AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS = 30_000

function handleCodexHomePtySpawned(args: {
  id: string
  codexHomePath: string | null
  reattached?: boolean
  reattachedHomeRoute?: CodexPaneHomeRoute | null
  launchEnv?: NodeJS.ProcessEnv
  startedAt?: Date
  startedSequence?: number
}): void {
  // Why: only shared or ambiguous retained shells can create rollout logs that still need publication.
  if (args.reattached && args.startedSequence !== undefined) {
    const paneAccount = getCodexPaneAccount(args.id)
    const homeRoute =
      args.reattachedHomeRoute !== undefined
        ? (args.reattachedHomeRoute ?? undefined)
        : paneAccount?.homeRoute
    if (codexSessionMigration && isCodexPaneHomeRouteProvenAwayFromSharedHome(homeRoute)) {
      codexSessionMigration.ignoreLaunch(args.id, args.startedSequence)
      return
    }
  }
  const fullScanRequired =
    codexRuntimeHome?.beginHostSystemDefaultSessionMigrationLaunch(args.codexHomePath, {
      reattached: args.reattached,
      launchEnv: args.launchEnv
    }) ?? null
  if (fullScanRequired !== null) {
    codexSessionMigration?.beginLaunch(
      args.id,
      args.reattached === true || fullScanRequired,
      args.startedAt,
      args.startedSequence
    )
  }
}

function handlePtyExit(id: string, exitSequence: number): void {
  codexSessionMigration?.finishLaunch(id, exitSequence)
}
// Why: on Windows a CLI launch that lost ELECTRON_RUN_AS_NODE would boot the GUI and exit silently; redirect to node mode before the lock gate below.
// Both redirects run before the serve-argv rewrite so they still match on the launch argv verbatim.
// It is load-bearing for the AppImage one: rewriting first replaces the `serve` positional, so its
// command-name lookup finds a port number and strands the launch in an in-process serve. The
// packaged-CLI one matches on the entry path instead, so order cannot affect it either way.
const packagedCliEntryRedirect = maybeRedirectPackagedCliEntryLaunch({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath
})
if (packagedCliEntryRedirect.redirected) {
  app.exit(packagedCliEntryRedirect.status)
}
const appImageCliRedirect = maybeRedirectAppImageCliLaunch({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath
})
if (appImageCliRedirect.redirected) {
  app.exit(appImageCliRedirect.status)
}
// Why: extracted AppRun / binary launches can land CLI-form `serve` args on the
// Electron process without the CLI rewrite that injects `--serve` (#12677).
// Guarded so a normal GUI launch keeps its original argv array identity.
if (argvRequestsServeMode(process.argv)) {
  process.argv = normalizeServeModeArgv(process.argv)
}
const isServeMode = process.argv.includes('--serve')

app.on('gpu-info-update', () => {
  gpuFallbackLaunch.trackGpuInfoUpdate()
})

if (isServeMode) {
  reserveServeStdoutForReadiness()
}
const desktopActivationGate = createServeDesktopActivationGate({
  initialState: isServeMode ? 'initializing' : 'ready',
  activateWindow: () => {
    // Why: an updater replacement must not resurrect the old app bundle.
    if (!isQuittingForUpdate()) {
      focusExistingWindow()
    }
  },
  onBlocked: (reason) => console.error(`[serve] Desktop activation blocked: ${reason}`)
})

const devInstanceIdentity = getDevInstanceIdentity(is.dev)
const devAgentHookEndpointNamespace = devInstanceIdentity.isDev
  ? devInstanceIdentity.appUserModelId
  : undefined

// Extraction delegates (function declarations: hoisted, so pre-ready closures like desktopActivationGate can capture them regardless of declaration order).
const reloadFlags = createWebContentsReloadFlags({ getIsQuitting: () => isQuitting })
const {
  markExpectedRendererReload,
  clearExpectedRendererReload,
  getExpectedTeardownScope,
  markRecoveryReloadInFlight,
  isRecoveryReloadInFlight
} = reloadFlags

const codexLaunchPreparation = createCodexLaunchPreparation({
  app,
  getStore: () => store,
  getCodexRuntimeHome: () => codexRuntimeHome,
  getCodexSessionMigration: () => codexSessionMigration
})
const {
  prepareCodexRuntimeHomeForLaunch,
  prepareCodexSessionResumeForLaunch,
  prepareAiVaultSessionResume: prepareCodexAiVaultSessionResumeForLaunch
} = codexLaunchPreparation

const maybeAutoRenameBranchOnFirstWorkFromHook = createFirstWorkRenameHookAdapter({
  getStore: () => store,
  getRuntime: () => runtime
})

const syntheticTitles = createSyntheticTitleSpinnerController({
  getWindow: () => mainWindow,
  getRuntime: () => runtime,
  getStore: () => store,
  getPtyIdForPaneKey
})

const serveStartup = createServeStartup({
  getRuntime: () => runtime,
  getRuntimeRpc: () => runtimeRpc,
  getManagedWslCliReconciliationStatus: () => managedWslCliReconciliationStatus
})

const gpuFallbackLaunch = createGpuFallbackLaunchController({
  isServeMode,
  getIsQuitting: () => isQuitting,
  setQuitting: () => {
    isQuitting = true
  },
  getMainWindow: () => mainWindow
})

function focusExistingWindow(): void {
  mainWindowController.focusExistingWindow()
}

function getSystemTrayOptions(): SystemTrayOptions | null {
  const currentStore = store
  if (!currentStore) {
    return null
  }
  return {
    appIcon: currentStore.getSettings().appIcon,
    isDevInstance: devInstanceIdentity.isDev,
    devInstanceLabel: devInstanceIdentity.devLabel,
    onOpen: () => mainWindowController.showMainWindowFromTray(),
    onOpenSettings: openSettingsFromSystemMenu,
    onCheckForUpdates: () => {
      // Why: updater status renders in the main window, so a bare check would complete invisibly.
      mainWindowController.showMainWindowFromTray()
      runUserInitiatedUpdateCheck()
    },
    onQuit: () => mainWindowController.quitFromSystemTray()
  }
}

function openSettingsFromSystemMenu(): void {
  mainWindowController.openSettingsFromSystemMenu()
}

function runUserInitiatedUpdateCheck(options?: UpdateCheckOptions): void {
  mainWindowController.runUserInitiatedUpdateCheck(options)
}

function syncMacMenuBarIcon(showMenuBarIcon: boolean): Tray | null {
  return mainWindowController.syncMacMenuBarIcon(showMenuBarIcon)
}

function sendOpenFeatureTour(targetWindow?: BrowserWindow | null): void {
  mainWindowController.sendOpenFeatureTour(targetWindow)
}

function sendOpenSetupGuide(targetWindow?: BrowserWindow | null): void {
  mainWindowController.sendOpenSetupGuide(targetWindow)
}

function sendOpenCrashReport(targetWindow?: BrowserWindow | null): void {
  mainWindowController.sendOpenCrashReport(targetWindow)
}

function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
  return mainWindowController.openMainWindow(options)
}

function presentGpuFallbackRecoveredLaunchPrompt(window: BrowserWindow): Promise<void> {
  return gpuFallbackLaunch.presentGpuFallbackRecoveredLaunchPrompt(window)
}

function recordProcessGoneCrash(
  source: 'renderer' | 'child',
  processType: string,
  reason: string,
  exitCode: number | null,
  details: Record<string, unknown>,
  webContentsId?: number
): void {
  recordProcessGoneCrashEvent(crashReports, {
    source,
    processType,
    reason,
    exitCode,
    expectedTeardown: getExpectedTeardownScope(webContentsId),
    details,
    ...(webContentsId !== undefined ? { webContentsId } : {})
  })
}

const mainWindowController = createMainWindowController({
  app,
  isServeMode,
  isDev: is.dev,
  windowTitle: devInstanceIdentity.name,
  isDevInstance: devInstanceIdentity.isDev,
  devInstanceLabel: devInstanceIdentity.devLabel ?? '',
  getStore: () => store,
  getRuntime: () => runtime,
  getStats: () => stats,
  getClaudeUsage: () => claudeUsage,
  getCodexUsage: () => codexUsage,
  getOpenCodeUsage: () => openCodeUsage,
  getCodexAccounts: () => codexAccounts,
  getCodexRuntimeHome: () => codexRuntimeHome,
  getClaudeAccounts: () => claudeAccounts,
  getClaudeRuntimeAuth: () => claudeRuntimeAuth,
  getRateLimits: () => rateLimits,
  getAutomations: () => automations,
  getKeybindings: () => keybindings,
  getPluginService: () => pluginService,
  getPluginMarketplaceService: () => pluginMarketplaceService,
  getPluginMarketplaceInstaller: () => pluginMarketplaceInstaller,
  getCrashReports: () => crashReports,
  getAgentAwakeService: () => agentAwakeService,
  getDesktopRelayService: () => desktopRelayService,
  getMainWindow: () => mainWindow,
  setMainWindow: (window) => {
    mainWindow = window
  },
  getIsQuitting: () => isQuitting,
  setQuitting: () => {
    isQuitting = true
  },
  clearQuitting: () => {
    isQuitting = false
  },
  getLocalPtyStartupReady: () => localPtyStartupReady,
  getLocalPtyProviderStartupReady: () => localPtyProviderStartupReady,
  markExpectedRendererReload,
  clearExpectedRendererReload,
  markRecoveryReloadInFlight,
  isRecoveryReloadInFlight,
  getExpectedTeardownScope,
  prepareCodexRuntimeHomeForLaunch,
  prepareCodexSessionResumeForLaunch,
  prepareAiVaultSessionResume: prepareCodexAiVaultSessionResumeForLaunch,
  handleCodexHomePtySpawned,
  handlePtyExit,
  emitPluginWorktreeLifecycle,
  maybeAutoRenameBranchOnFirstWorkFromHook,
  stopAllSyntheticTitleSpinners: syntheticTitles.stopAllSyntheticTitleSpinners,
  resumeSyntheticTitleSpinnerTimer: syntheticTitles.resumeSyntheticTitleSpinnerTimer,
  stopSyntheticTitleSpinnerTimer: syntheticTitles.stopSyntheticTitleSpinnerTimer,
  driveSyntheticTitleFromHook: syntheticTitles.driveSyntheticTitleFromHook,
  shouldSuppressCodexAutoApprovalSyntheticTitleFromHook,
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  onOpenSettingsPushed: (webContentsId) => {
    // Why: untimed — any TTL can be outrun by a slow cold start; id-scoping + consume-on-read still prevent leaking to a later renderer.
    pendingOpenSettings.mark(webContentsId, Number.POSITIVE_INFINITY)
  },
  onAgentStateObserved: recordAgentStateCrashBreadcrumb,
  onSystemTrayOptionsNeeded: getSystemTrayOptions,
  recordProcessGoneCrash,
  presentGpuFallbackRecoveredLaunchPrompt
})

installUncaughtPipeErrorGuard()
// Why (issue #9441): without this, one rejected background promise during startup restore kills main silently (exit 1, no crash report).
installUnhandledRejectionLogging()
// Why: expose the app version via process.env so main and the forked daemon can set TERM_PROGRAM_VERSION without importing electron.
process.env.ORCA_APP_VERSION = app.getVersion()
configureRemoteServerUpdater({
  getSnapshot: getRemoteServerUpdaterSnapshot,
  check: checkForRemoteServerUpdate,
  download: downloadRemoteServerUpdate,
  install: installRemoteServerUpdate
})
patchPackagedProcessPath()
// Why: the sync seed above covers early IPC (homebrew/nix); the async login-shell probe below (packaged only) then adds the user's rc PATH.
if (app.isPackaged && process.platform !== 'win32') {
  void hydrateShellPath().then((result) => {
    if (result.ok) {
      mergePathSegments(result.segments)
      return
    }
    // Why: on failure the seeded fallbacks stay in front. For an nvm user that is
    // now their `default` version rather than the newest install, so it is usually
    // survivable — but it is still not what their shell would have resolved. Name
    // the reason so it shows up in a log bundle instead of as a missing CLI.
    console.warn(
      `[shell-path] login-shell probe failed (${result.failureReason}); using seeded PATH`
    )
  })
}
configureDevUserDataPath(is.dev)
configureOrcaUserDataPathEnv()
setAppEnvironment(new ElectronAppEnvironment())
installServeSupervisorDisconnectQuit(isServeMode)

const startupDiagnosticsEnabled = isStartupDiagnosticsEnabled()
if (startupDiagnosticsEnabled) {
  logStartupDiagnostic('before-single-instance-lock', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    osRelease: os.release(),
    userData: app.getPath('userData'),
    e2eUserData: Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  })
  startEventLoopStallProbe()
}
// Self-gated on ORCA_MAIN_THREAD_DIAGNOSTICS; runs the whole session to catch steady-state churn (issue #7576).
// Why the diff-cache counters ride along: a stamp the filesystem reports unstably makes the cache
// look exactly like a cold start, and only the hit/miss/unprovable split tells the two apart.
startMainThreadChurnProbe({ extraStats: () => ({ diffCache: settledDiffCache.stats() }) })

function requestDesktopActivation(argv: readonly string[] = []): void {
  skillShareDeepLinks.capture(argv, (shareId) => {
    mainWindow?.webContents.send('ui:openSkillShare', shareId)
  })
  // Why: a duplicate `orca serve` must not drag a headless server into opening a desktop window (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  desktopActivationGate.requestActivation()
}

app.on('open-url', (event, url) => {
  if (!parseSkillShareId(url)) {
    return
  }
  event.preventDefault()
  requestDesktopActivation([url])
})

skillShareDeepLinks.capture(process.argv)

const handleMacAppActivation = createMacAppActivationHandler({
  getWindow: () => mainWindow,
  requestActivation: requestDesktopActivation
})

function getDesktopWindowStatus(): RuntimeDesktopWindowStatus {
  const state = desktopActivationGate.getState()
  return state === 'ready' ? 'openable' : state
}

function settleServeDesktopActivation(): void {
  settleServeDesktopActivationGate(desktopActivationGate, {
    hasPersistentPtyProvider: !(getLocalPtyProvider() instanceof LocalPtyProvider)
  })
}

function recordAgentStateCrashBreadcrumb(agentType: string, state: string): void {
  // Why: hook pings arrive many times/sec; coalesce so identical state pings don't fill all 30 breadcrumbs, leaving room for renderer errors.
  recordCoalescedCrashBreadcrumb({
    name: 'agent_state_changed',
    data: { agentType, state },
    coalesceKey: `agent:${agentType}:${state}`,
    minIntervalMs: AGENT_STATE_CRASH_BREADCRUMB_MIN_INTERVAL_MS
  })
}

// Why: acquire AFTER configureDevUserDataPath — Electron derives lock identity from `userData`, so dev/packaged lock in separate namespaces.
// Why skip in dev: parallel `pnpm dev` from multiple worktrees would make the second exit silently; packaged keeps the lock (corruption PR #1326 / #1312).
const bypassSingleInstanceLock = shouldBypassSingleInstanceLock({
  isDev: is.dev,
  isServeMode
})
const skipSingleInstanceLock = shouldSkipSingleInstanceLock({
  isDev: is.dev,
  isServeMode
})
if (bypassSingleInstanceLock) {
  // Why: diagnostic escape hatch for macOS builds where Electron reports a false lock loss before any app logs exist.
  logSingleInstanceLockBypass()
}
const hasSingleInstanceLock = skipSingleInstanceLock
  ? true
  : bypassSingleInstanceLock
    ? true
    : acquireSingleInstanceLock(app, requestDesktopActivation)
if (startupDiagnosticsEnabled) {
  logStartupDiagnostic('single-instance-lock-result', {
    acquired: hasSingleInstanceLock,
    bypassed: bypassSingleInstanceLock,
    skippedForDev: skipSingleInstanceLock
  })
}
if (!hasSingleInstanceLock) {
  // Why: a false-negative lock loss otherwise looks like a silent crash on packaged macOS; `open --stderr` can capture this line.
  logSingleInstanceLockFailure()
  // Why: a graceful quit is deferred pre-ready, so this launch would still walk into Linux display init and SIGSEGV (#11935).
  app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
}

// Why: when another process holds the lock we've already exited; skip file-writing side effects so this transient process never touches userData.
if (hasSingleInstanceLock) {
  // Why first: both accessors throw until installed, and everything below this line
  // may resolve a path or read a credential. Neither constructor touches `app` or
  // `safeStorage` — they resolve lazily per call — so installing here changes no
  // timing, in particular not the pre-ready Keychain service-name resolution and
  setSecretStore(new ElectronSecretStore())
  // Why at process level, not per-window: pty.ts registers against injected surfaces so
  // it can load without electron, and an Electron main process always has ipcMain —
  // whether a window exists is irrelevant. Installing this in attachMainWindowServices
  // meant `orca serve` registered its PTY handlers against no-ops before any window
  // attached, so a paired desktop owner never received them.
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  // Why also at process level: the runtime's notification, window-lookup and
  // tab-create-reply channel are desktop-only. A Node host installs none and the
  // runtime routes notifications to paired clients instead.
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  // Why here: constructing RuntimeBrowserCommands is what pulls the Chromium browser
  // cluster into the graph. The desktop installs it; a Node host installs none and every
  // browser RPC rejects, which capability filtering already tells clients about.
  setRuntimeBrowserCommandsFactory(electronRuntimeBrowserCommandsFactory)
  // Why here: proxy-settings only needed electron for `session.defaultSession`. The
  // desktop supplies it; a Node host has no Chromium proxy config to consult, so the
  // environment variables are the whole answer there.
  setDefaultProxySessionResolver(() => session.defaultSession)
  // Why here: integrations use Chromium's network stack on the desktop. A Node host
  // falls back to the platform default, which is a real behavioural difference (proxy
  // read from the environment, Node's user agent) rather than a transparent swap.
  setMainHttpClient(electronHttpClient)
  // Why here: constructing the speech services is what pulls Electron's streaming net
  // request in. A host without them rejects speech calls rather than pretending.
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
  // Why: couple to dev-parent only for electron-vite desktop runs; `orca serve`'s parent (CLI shim/background shell) isn't the intended server lifetime.
  const shouldCoupleToDevParent = is.dev && !isServeMode
  installDevParentDisconnectQuit(shouldCoupleToDevParent)
  installDevParentWatchdog(shouldCoupleToDevParent)
  installDevParentSignalQuit(shouldCoupleToDevParent)
  // Why: run after configureDevUserDataPath but before app.setName('Orca') (whenReady), which changes the resolved path on case-sensitive filesystems.
  initDataPath()
  // Why here: initDataPath above gives the canonical userData path for the record file; the write
  // itself lands for the next launch (see macos-press-and-hold-default.ts).
  applyMacPressAndHoldDefaultAtStartup(getCanonicalUserDataPath())
  // Why: use the canonical userData path — late app.getPath('userData') can resolve differently across restarts, defeating persistence.
  initSessionParseCachePersistence({
    filePath: join(getCanonicalUserDataPath(), 'ai-vault', 'session-parse-cache.json'),
    appVersion: app.getVersion()
  })
  initOrcaProfilePaths()
  // Why: same timing as initDataPath — capture userData before app.setName changes it. See persistence.ts:20-28.
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  // Why: Electron resolves the macOS safeStorage Keychain service name
  // ("<app name> Safe Storage") before `ready`, so the setName in whenReady is
  // too late to move it — dev otherwise lands on the package.json name. Dev-only
  // so a packaged build keeps deriving the key from its own CFBundleName.
  // Safe here: dev always pins userData via app.setPath (configure-process.ts),
  // so setName cannot shift the paths captured just above.
  if (shouldApplyPreReadyAppName(devInstanceIdentity)) {
    app.setName(devInstanceIdentity.appName)
  }
  // Why: Electron freezes the privileged scheme table at ready, so the doc-preview
  // scheme must be declared here or its webview loses fetch/secure-origin privileges.
  registerDocPreviewSchemePrivileges()
  // Why: must precede app.whenReady() so Crashpad is installed before the
  // first renderer spawns; a CHECK before this point is still exit-code-only.
  startCrashpadCapture()
  crashReports = CrashReportStore.fromUserData()
  recordCrashBreadcrumb('app_started', {
    packaged: app.isPackaged,
    platform: process.platform,
    ...getMainProcessLifecycleIdentity()
  })
  enableMainProcessCompileCache()
  disableUnsupportedChromiumFeatures()
  // Why: unconditional — a GPU-fallback launch skips enableMainProcessGpuFeatures() below.
  optOutOfHiddenPageWakeUpThrottling()
  configureElectronNetworkCompatibility()
  enableRendererHeapHeadroom()
  gpuFallbackLaunch.maybeApplyGpuFallbackForThisLaunch()
  if (!gpuFallbackLaunch.isGpuFallbackActiveThisLaunch()) {
    enableMainProcessGpuFeatures(undefined, { isServeMode })
  }
  // Why: headless serve's offscreen BrowserWindows need an X display (Xvfb) on Linux; the result gates whether the offscreen backend is installed.
  headlessBrowserDisplayAvailable = ensureVirtualDisplayForHeadlessServe({ isServeMode })
}

ipcMain.handle('app:awaitFirstWindowStartupServices', async () => {
  await Promise.all([firstWindowStartupServicesReady, managedWslCliStartupBarrierReady])
})

ipcMain.handle('app:prepareTerminalStartupRestoration', async () => {
  await Promise.all([firstWindowStartupServicesReady, managedWslCliStartupBarrierReady])
  await runtime?.prepareStructuredAgentSessionStartupRestoration()
})

ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup', () =>
  recoverLegacyWorkerTerminalsForRendererStartup({
    firstWindowStartupServicesReady,
    managedWslCliStartupBarrierReady,
    localPtyProviderStartupReady,
    reconcile: async () => {
      await runtime?.refreshRestoredOrchestrationAuthority()
      return runtime?.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    },
    onDeferredRecoveryError: (error) => {
      console.warn('[orchestration] legacy worker provider-ready recovery failed', error)
    }
  })
)

// Why: the renderer pulls this once its ui:openSettings listener attaches, so a Settings request queued before mount isn't lost.
ipcMain.handle('ui:consumePendingOpenSettings', (event) =>
  pendingOpenSettings.matches(event.sender.id, { consume: true })
)

ipcMain.handle('ui:consumePendingSkillShare', () => {
  return skillShareDeepLinks.consume()
})

ipcMain.handle(
  'app:startupDiagnostic',
  (_event, event: string, details?: Record<string, unknown>) => {
    if (!startupDiagnosticsEnabled || !event.startsWith('renderer-')) {
      return
    }
    logStartupMilestone(event, details && typeof details === 'object' ? details : {})
  }
)

/** A PTY that dies while Orca is down never runs the teardown that clears pane
 *  state, so hydrate can rebuild a Claude subagent roster that no later hook can
 *  retire — pinning the pane 'working' and locking its agent out of hibernation
 *  for good. Once provider and hook hydration settle, targeted PTY liveness can
 *  retire only rows whose local owner is proven gone. */
async function reapRestoredSubagentsWithoutLiveAgent(): Promise<void> {
  const currentStore = store
  if (!currentStore) {
    return
  }
  const provider = getDaemonProvider()
  if (!provider) {
    return
  }
  const persistedPtyIdByPaneKey = indexPersistedPaneKeyPtyIds(
    currentStore.getWorkspaceSession().terminalLayoutsByTabId ?? {}
  )
  await sweepRestoredSubagentsWithoutLiveAgent({
    probeLiveLocalPty: (ptyId) => provider.probePtyLiveness(ptyId),
    isLocalExecutionHost: (worktreeId) =>
      isLocalExecutionHost(
        resolveAgentWorkspaceExecutionHostId(worktreeId, {
          getRepo: (repoId) => currentStore.getRepo(repoId),
          getWorktreeMeta: (resolvedWorktreeId) => currentStore.getWorktreeMeta(resolvedWorktreeId),
          getFolderWorkspace: (folderWorkspaceId) =>
            currentStore.getFolderWorkspace(folderWorkspaceId),
          getProjectGroups: () => currentStore.getProjectGroups()
        })
      ),
    getBoundPtyIdForPaneKey: getPtyIdForPaneKey,
    getPersistedPtyIdForPaneKey: (paneKey) => persistedPtyIdByPaneKey.get(paneKey),
    reap: (isLocalHost, isLocalPaneAgentLive, isLocalPaneLivenessEvidenceCurrent) =>
      agentHookServer.reapRestoredClaudeSubagentsWithoutLiveAgent(
        isLocalHost,
        isLocalPaneAgentLive,
        isLocalPaneLivenessEvidenceCurrent
      )
  })
}

function startTerminalRuntimeStartupServices(): WindowsDesktopStartupServices {
  logStartupMilestone('first-window-startup-services-start')
  const startupServices = startFirstWindowStartupServices({
    // Why: both desktop and headless serve must adopt the same persistent provider before creating terminals or a renderer.
    startDaemonPtyProvider: async (signal) => {
      logStartupMilestone('startup-service-start', { service: 'daemon-pty-provider' })
      // Why: only GUI-spawned macOS daemons watch for login-session death; a headless
      // serve daemon must survive its spawning session ending (SSH disconnect).
      await initDaemonPtyProvider(signal, {
        macosLoginSessionWatch: process.platform === 'darwin' && !isServeMode
      })
      // Why: a retained shell keeps its launch-time Codex home even when the current routing lane changes.
      if (codexRuntimeHome && hasRecordedManagedHostCodexPane()) {
        const livePtyIds = await listLiveDaemonPtyIds()
        if (livePtyIds) {
          reconcileCodexPaneAccountsWithLivePtys(livePtyIds)
          const settings = store?.getSettings()
          // Why (#16441): each retained home can run a codex app-server grant
          // session. Awaiting them here delayed the first window by N sessions;
          // a retained shell cannot invoke Codex before this provider serves.
          void reconcileRetainedCodexHookHomes({
            hookService: codexHookService,
            hooksEnabled:
              isAgentStatusHooksEnabled(settings) &&
              settings?.disabledTuiAgents.includes('codex') !== true,
            runtimeHomePaths: codexRuntimeHome.getRetainedHostCodexHookHomePaths(livePtyIds)
          }).catch((error: unknown) => {
            console.warn('[codex-hook-service] retained Codex home reconcile failed:', error)
          })
        }
      }
      // Why: retained shells can invoke Codex immediately after the startup gate.
      codexRuntimeHome?.reconcileLegacySharedHomeForRetainedPanes()
      logStartupMilestone('startup-service-done', { service: 'daemon-pty-provider' })
    },
    // Why: PTY spawn env reads ORCA_AGENT_HOOK_* from live server state, so the renderer awaits this before restored terminals reconnect.
    startAgentHookServer: async () => {
      if (!isAgentStatusHooksEnabled(store?.getSettings())) {
        return
      }
      logStartupMilestone('startup-service-start', { service: 'agent-hook-server' })
      // Why (#11217): the hook listener fails open on every request error, so an IDS resetting
      // loopback POSTs mid-body stops agent status for every runtime with no symptom but staleness.
      // Log + telemetry (the daemon_start_failed pattern) so it is diagnosable without a packet capture.
      agentHookServer.setTransportInterferenceListener((report) => {
        track('agent_hook_transport_blocked', { count: report.count })
      })
      await agentHookServer.start({
        env: app.isPackaged ? 'production' : 'development',
        // Why: hooks source this endpoint file at invocation time so old PTY env reaches the current process after restart; dev namespaces it (worktrees share `orca-dev`).
        userDataPath: app.getPath('userData'),
        endpointNamespace: devAgentHookEndpointNamespace
      })
      logStartupMilestone('startup-service-done', { service: 'agent-hook-server' })
    },
    onDaemonError: (error) => {
      // Why: daemon failure silently falls back to non-persistent local PTYs; log + telemetry so a fleet-wide outage is observable (was invisible in v1.4.129-rc.1).
      const reason = error instanceof Error ? error.message : String(error)
      console.error(
        `[daemon] STARTUP FAILED — falling back to local PTYs; terminals will not persist across quit. Reason: ${reason}`
      )
      track('daemon_start_failed', classifyError(error))
    },
    onAgentHookServerError: (error) => {
      // Why: hook callbacks are sidebar enrichment only; Orca must still boot if the loopback receiver fails.
      console.error('[agent-hooks] Failed to start local hook server:', error)
    }
  })
  void startupServices.firstWindowReady.then(() => {
    logStartupMilestone('first-window-startup-services-ready')
  })
  void startupServices.localPtyReady.then(() => {
    logStartupMilestone('local-pty-startup-ready')
    void reapRestoredSubagentsWithoutLiveAgent().catch((error) => {
      console.warn('[agent-hooks] restored-subagent liveness probe failed:', error)
    })
  })
  return startupServices
}

function bindTerminalRuntimeStartupServices(
  services: Promise<WindowsDesktopStartupServices>
): void {
  firstWindowStartupServicesReady = services.then((value) => value.firstWindowReady)
  localPtyStartupReady = services.then((value) => value.localPtyReady)
  localPtyProviderStartupReady = services.then((value) => value.localPtyProviderReady)
}

function shutdownWatchersOnce(): Promise<void> {
  if (watcherShutdownDone) {
    return Promise.resolve()
  }
  if (!watcherShutdownPromise) {
    // Why: @parcel/watcher tears down native async work on unsubscribe; Electron must await it before Node's environment exits.
    stopFolderRepoGitUpgradeWatch()
    watcherShutdownPromise = Promise.allSettled([
      closeAllWatchers(),
      disposeWorktreeBaseDirectoryWatchers()
    ])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[filesystem-watcher] shutdown failed:', result.reason)
          }
        }
      })
      .then(() => {
        watcherShutdownDone = true
      })
  }
  return watcherShutdownPromise
}

// Why: on PTY teardown drop the spinner entry explicitly, else the shared timer keeps ticking with sendSyntheticTitle no-oping forever.
registerPaneKeyTeardownListener((paneKey) => {
  syntheticTitles.stopSyntheticTitleSpinner(paneKey)
})

void app.whenReady().then(async () => {
  logStartupMilestone('app-ready')
  configureSessionCodeCache(session.defaultSession)
  startResourceRecorderIfEnabled()
  installResourceRecorderIpcHandlers()
  installMainThreadHangWatchdog({ userDataPath: getCanonicalUserDataPath() })
  const hangDetection = consumeHangDetectionMarker(
    hangDetectionMarkerPath(getCanonicalUserDataPath())
  )
  if (hangDetection) {
    recordDurableCrashBreadcrumb('main_thread_hang_detected', {
      unresponsiveMs: hangDetection.unresponsiveMs,
      previousPid: hangDetection.parentPid,
      selfRecovered: hangDetection.selfRecovered
    })
  }
  // Why: install certificate decisions before any webview or headless window issues its first TLS request.
  app.on(
    'certificate-error',
    (event, webContents, url, error, certificate, callback, isMainFrame) => {
      browserCertificateTrustController.handleCertificateError({
        event,
        webContents,
        url,
        error,
        certificate,
        callback,
        isMainFrame
      })
    }
  )
  electronApp.setAppUserModelId(devInstanceIdentity.appUserModelId)
  // Why: names the app menu/About panel. Dev already applied this pre-ready (see the
  // safeStorage note above); this call stays unconditional so packaged builds keep their
  // existing post-ready rename, which lands after the Keychain name is already resolved.
  app.setName(devInstanceIdentity.appName)
  gpuFallbackLaunch.updateGpuAccelerationAboutPanel()

  // Why: managed WSL launchers live outside the Windows app bundle, so keep their launcher/bridge contract synced across app updates.
  managedWslCliReconciliationStatus = 'pending'
  managedWslCliReconciliationReady = reconcileManagedWslCliRegistrations({
    isPackaged: app.isPackaged,
    userDataPath: getCanonicalUserDataPath(),
    appVersion: app.getVersion()
  })
    .then((results) => {
      for (const result of results) {
        if (result.outcome === 'failed') {
          console.warn(
            `[wsl-cli] ${result.distro} managed registration reconciliation failed: ${result.error}`
          )
        } else if (result.outcome === 'repaired') {
          console.log(`[wsl-cli] Repaired managed registration in ${result.distro}.`)
        }
      }
      managedWslCliReconciliationStatus = 'settled'
    })
    .catch((error) => {
      managedWslCliReconciliationStatus = 'failed'
      console.warn(
        '[wsl-cli] Managed registration reconciliation discovery failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
  managedWslCliStartupBarrierReady = createWslCliReconciliationStartupBarrier(
    managedWslCliReconciliationReady
  )

  const benchSwitches = getBenchStartupSwitches()
  const activeOrcaProfile = ensureActiveOrcaProfile()
  // Why this early: the first window stamps the hosting id into its renderer's argv, so the durable
  // read has to have happened by then or the renderer and the browser-host lease disagree.
  initializeBrowserClientHostId(activeOrcaProfile.profileDirectory)
  store = new Store({
    dataFile: activeOrcaProfile.dataFile,
    storageAuthority: isServeMode ? 'runtime' : 'desktop'
  })
  // Why armed here and not at install time: the report remembers what it last said, and
  // that state lives beside the profile data file, which does not exist until now.
  // Why scheduled and not called: the report probes the OS keyring, which blocks on Linux
  // and must not gate the first window (STA-5765).
  scheduleSecretProtectionGapReport({
    dataFile: activeOrcaProfile.dataFile,
    force: process.env.ORCA_ALWAYS_REPORT_SECRET_PROTECTION === '1',
    deferUntilFirstWindow: !isServeMode
  })
  // Why here: the host key store is a sidecar of the same profile, and every SSH connect consults
  // it. Left unbound it reports nothing trusted, which is safe but silently discards our own
  // accept records on every launch.
  initSshHostKeyStoreFile(activeOrcaProfile.dataFile)
  // Why: must precede PTY handler registration and run in headless serve too, which returns before openMainWindow.
  neutralizeLegacyTerminalShimDir(app.getPath('userData'))
  const windowsShellPathHydration = createWindowsShellPathHydration()
  configureWindowsHostGitEnvironmentReadiness(
    process.platform === 'win32' ? windowsShellPathHydration.whenReady : null
  )
  if (process.platform === 'win32') {
    const settings = store.getSettings()
    if (app.isPackaged) {
      void windowsShellPathHydration.hydrate(
        settings.terminalWindowsShell,
        settings.terminalWindowsPowerShellImplementation
      )
    } else {
      windowsShellPathHydration.configure(
        settings.terminalWindowsShell,
        settings.terminalWindowsPowerShellImplementation
      )
    }
  }
  wslHookRelayManager.setManagedHookSettingsResolver(() => store?.getSettings() ?? null)
  logStartupMilestone('store-loaded')
  // Why: apply initial fallback WSL distro from store settings for global git/CLI calls.
  setDefaultWslDistroOverride(store.getSettings().terminalWindowsWslDistro ?? null)
  store.onSettingsChanged((updates, settings) => {
    if ('terminalWindowsWslDistro' in updates) {
      // Why: synchronize fallback WSL distro updates to runner.
      setDefaultWslDistroOverride(settings.terminalWindowsWslDistro ?? null)
    }
    if (
      ('terminalWindowsShell' in updates || 'terminalWindowsPowerShellImplementation' in updates) &&
      process.platform === 'win32'
    ) {
      if (app.isPackaged) {
        void windowsShellPathHydration.hydrate(
          settings.terminalWindowsShell,
          settings.terminalWindowsPowerShellImplementation
        )
      } else {
        windowsShellPathHydration.configure(
          settings.terminalWindowsShell,
          settings.terminalWindowsPowerShellImplementation
        )
      }
    }
    if ('showMenuBarIcon' in updates) {
      // Why: Store is the mutation authority for all settings writes, so every macOS toggle updates the native item live.
      syncMacMenuBarIcon(settings.showMenuBarIcon !== false)
    }
    if ('agentStatusHooksEnabled' in updates) {
      // Why both directions: the ensure gate only blocks NEW relays, so off must stop the running
      // guest process and timers, and on must restart them — otherwise open WSL panes report no
      // status until their next spawn.
      if (isAgentStatusHooksEnabled(settings)) {
        wslHookRelayManager.resumeStoppedRelays()
      } else {
        wslHookRelayManager.disposeAll({ permanent: false })
      }
    }
  })
  // Why: run before ClaudeRuntimeAuthService's constructor sync — a surviving daemon Claude CLI holds the single-use refresh token; early refresh rotates it out mid-session.
  attachClaudeLivePtyPersistence(store)
  // Why: while a live claude defers the managed OAuth refresh, usage shows
  // "Waiting for Claude session"; refetch when the last live PTY exits so the
  // error clears immediately instead of after the failure backoff.
  onLiveClaudePtysDrained(() => {
    void rateLimits?.refreshAfterClaudeLivePtysDrained()
  })
  const persistedClaudePtyIds = store.getClaudeLivePtySessionIds()
  seedLiveClaudePtysFromPersistence(persistedClaudePtyIds)
  if (persistedClaudePtyIds.length > 0) {
    console.log(
      `[claude-live-pty] Seeded ${persistedClaudePtyIds.length} persisted Claude session id(s) into the refresh gate`
    )
  }
  applyAppIcon(store.getSettings().appIcon)
  if (shouldSuppressDevEducation({ isDev: is.dev })) {
    suppressDevEducationForStore(store)
  }
  try {
    // Why: Dock/Launchpad launches don't inherit shell proxy env vars, so apply the persisted proxy before any app-owned network fetchers run.
    const proxyApplyResult = await applyElectronProxySettings(store.getSettings())
    if (proxyApplyResult.source === 'invalid-settings') {
      // Why (STA-3442): a silent DIRECT fallback made a dead configured proxy undiagnosable.
      console.warn('[proxy] persisted proxy settings are invalid; using direct networking')
    }
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings')
  }
  // Why: the preview session is protocol-scoped, so the handler must exist before any preview webview attaches.
  installDocPreviewProtocolHandler()
  registerDocPreviewGrantHandlers()
  // Why: browser sessions serve desktop webviews and runtime profile commands, so init at app startup rather than via a renderer IPC path.
  if (!benchSwitches.disabled.includes('browser')) {
    initializeBrowserSessionsForApp({
      orcaProfileId: activeOrcaProfile.profile.id,
      profileDirectory: activeOrcaProfile.profileDirectory,
      // Why: local direct-SSH partitions are scoped to targets, and the orphan
      // sweep must see the live target list or it would clear their cookie jars.
      listLocalSshTargetIds: () => {
        if (!store) {
          // Why: an empty list would read as "every SSH jar is an orphan"; throwing skips the sweep.
          throw new Error('ssh target store unavailable at partition sweep')
        }
        return store.getSshTargets().map((target) => target.id)
      }
    })
  }
  unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  agentAwakeService = new AgentAwakeService()
  agentAwakeService.setMode(
    normalizeComputerAwakeMode(
      store.getSettings().computerAwakeMode,
      store.getSettings().keepComputerAwakeWhileAgentsRun
    )
  )
  // Why: start from empty — disk-hydrated status rows are UI continuity only; only this runtime's hook events keep the computer awake.
  agentAwakeService.setStatuses([])
  const collectChangedProviderSessionWorktrees = createHookProviderSessionInvalidator()
  const publishProviderSessionChanges = (identities: AgentHookProviderSessionIdentity[]): void => {
    const ownedIdentities = identities.map((identity) => ({
      ...identity,
      worktreeId:
        identity.worktreeId ??
        runtime?.getTerminalWorktreeIdForPaneKey(identity.paneKey) ??
        undefined
    }))
    for (const worktreeId of collectChangedProviderSessionWorktrees(ownedIdentities)) {
      // Why not `notifyMobileSessionTabsChanged` alone: it re-emits at the unchanged
      // `snapshotVersion`, which every client drops on its monotonic gate.
      runtime?.touchMobileSessionTabsForWorktree(worktreeId, { immediate: true })
    }
  }
  const unsubscribeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    agentAwakeService?.setStatuses(statuses)
  })
  const unsubscribeProviderSessionChanges = agentHookServer.subscribeProviderSessionChanges(
    (sessions) => {
      // Healthy session.tabs streams need a push when transcript identity changes.
      publishProviderSessionChanges(sessions)
    }
  )
  // Why: hook rows are the only carrier of live agent state on a headless host, and
  // nothing else republishes `session.tabs` when one changes — so a paired client
  // would keep the pane's last projection until an unrelated PTY touch came along.
  const hookStatusChangedSessionTabs = createHookStatusSessionTabsInvalidator()
  const unsubscribeHookStatusSessionTabs = agentHookServer.subscribeEnrichedStatus((enriched) => {
    if (hookStatusChangedSessionTabs(enriched)) {
      runtime?.touchMobileSessionTabsForPane(enriched.paneKey, enriched.worktreeId ?? null)
    }
  })
  // Teardown: agent exit, pane close, and the SSH transient-disconnect batch all land
  // here. Without it the live state published above becomes a zombie question card.
  const unsubscribeHookStatusClear = agentHookServer.subscribePaneStatusClear((clear) => {
    const clearedPaneKeys =
      'paneKey' in clear
        ? [clear.paneKey]
        : hookStatusChangedSessionTabs.forgetConnection(clear.connectionId)
    for (const paneKey of clearedPaneKeys) {
      hookStatusChangedSessionTabs.forgetPane(paneKey)
      runtime?.touchMobileSessionTabsForPane(paneKey)
    }
  })
  unsubscribeAgentAwakeStatusChanges = () => {
    unsubscribeStatusChanges()
    unsubscribeProviderSessionChanges()
    unsubscribeHookStatusSessionTabs()
    unsubscribeHookStatusClear()
  }
  // Why: telemetry must init before any IPC handler/renderer can call track(); it's a no-op in dev and while TELEMETRY_ENABLED is false, so it's safe early.
  if (!benchSwitches.benchMode) {
    initTelemetry(store)
  }
  // Why: the breadcrumb alone never leaves the machine — it rides crash reports, and a hang is not
  // a crash (the app is force-quit, so no report is ever generated). Without this the incidence
  // number the watchdog exists to produce would sit unread on the user's disk. Must run after
  // initTelemetry: track() drops silently until the client and store are wired.
  if (hangDetection) {
    track('main_thread_hang_detected', {
      unresponsive_ms: Math.round(hangDetection.unresponsiveMs),
      self_recovered: hangDetection.selfRecovered
    })
  }
  // Why: the trust-grant module is bundled into plain-node CLI entries where
  // the telemetry client cannot load, so the tracker is injected here instead
  // of imported there.
  setCodexTrustGrantTelemetry(({ outcome, hostKind, lane, reason, errorClass, verifyClass }) => {
    track('codex_trust_grant', {
      outcome,
      host_kind: hostKind,
      lane,
      ...(reason !== undefined ? { fallback_reason: reason } : {}),
      ...(errorClass !== undefined ? { error_class: errorClass } : {}),
      ...(verifyClass !== undefined ? { verify_class: verifyClass } : {})
    })
  })
  // Why: the error-tracking lane (telemetry-error-tracking.md) is its own
  // composition root — independent of product telemetry — and must
  // initialize before any IPC handler / runtime span is created so the
  // tracer's active sink is populated at the moment the first span fires.
  // Honors DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / ORCA_DIAGNOSTICS_DISABLED
  // / CI internally; those gates do not need to be re-checked here.
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  const skillTransactionRecovery = benchSwitches.benchMode
    ? Promise.resolve({ scanned: 0, recovered: 0, failures: [], truncated: false })
    : recoverPendingSkillTransactions(join(app.getPath('userData'), 'skill-installs'))
  void skillTransactionRecovery
    .then((report) => {
      if (report.scanned || report.failures.length || report.truncated) {
        console.info('[skills] startup transaction recovery:', {
          scanned: report.scanned,
          recovered: report.recovered,
          failures: report.failures.map((failure) => failure.code),
          truncated: report.truncated
        })
      }
    })
    .catch((error) => console.warn('[skills] startup transaction recovery failed:', error))
  // Why: cohort-classifier reads repo count synchronously at every emit, so hydrate it here — before any IPC handler or window can trigger track().
  if (!benchSwitches.benchMode) {
    initCohortClassifier(store)
    initOnboardingCohortClassifier(store)
  }
  stats = new StatsCollector()
  // Agent-session stats come from hook status transitions, the same truth the
  // sidebar and dashboard read — never from OSC terminal titles, which miss
  // hook-only agents and count any spinner TUI as an agent (#10201).
  const agentSessionRecorder = new AgentSessionTransitionRecorder(stats)
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    agentSessionRecorder.onStatus(enriched)
  })
  agentHookServer.subscribePaneStatusClear((clear) => {
    agentSessionRecorder.onCleared(clear)
  })
  claudeUsage = new ClaudeUsageStore(store)
  codexUsage = new CodexUsageStore(store)
  openCodeUsage = new OpenCodeUsageStore(store)
  rateLimits = new RateLimitService()
  codexRuntimeHome = new CodexRuntimeHomeService(store)
  void startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  // Why: an incapable trust-grant host must fall back to the managed home for
  // every consumer (PTY env, rate limits, commit messages) in one place.
  codexRuntimeHome.setRealHomeLaneGate(() => isRealHomeCodexHookLaneUsable())
  // Why: while the real-home lane owns ~/.codex/hooks.json, the legacy
  // system-home sweep inside managed installs would delete the entry the
  // real-home installer just appended. Flag OFF, hooks off, or an incapable
  // trust lane re-arms the sweep so downgrade, opt-out, and rollback converge.
  setSystemCodexHomeHookSweepSuppressed(
    () =>
      codexRuntimeHome !== null &&
      codexRuntimeHome.isHostSystemDefaultRealHome() &&
      isAgentStatusHooksEnabled(store?.getSettings())
  )
  codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () => codexRuntimeHome?.isHostSystemDefaultSessionMigrationEligible() === true,
    isQuitting: () => isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store!.getSettings()),
    prepareScheduledRun: (scanDates) =>
      codexRuntimeHome?.prepareHostSystemDefaultSessionMigrationPass(scanDates),
    finishScheduledRun: () => codexRuntimeHome?.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome, {
    onHostSystemDefaultSelected: codexSessionMigration.requestRun
  })
  // Why: migrate historical shared-home sessions after startup; compatibility
  // launches re-arm the non-destructive pass for new rollouts (#4444, #8612, #12480).
  codexSessionMigration.scheduleInitialRun()
  claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver((target) =>
    codexRuntimeHome!.prepareForRateLimitFetch(target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Why: Kimi's CLI refreshes its OAuth token in whichever runtime it runs in, so the
  // usage fetch must read the WSL-side credentials when that's the configured runtime (#12370).
  rateLimits.setKimiHomeResolver(() => resolveKimiHome(getKimiRuntimeTarget(store!.getSettings())))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    // Why: auto is a live policy; retarget only providers whose settings-derived runtime changed.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
  })
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth!.prepareForRateLimitFetch(target)
  )
  // Why: live Claude sessions stream usage windows through their statusLine command; feeding them here avoids OAuth usage-endpoint polling (and its 429s).
  agentHookServer.setClaudeStatusLineListener((event) => {
    rateLimits?.ingestLiveClaudeRateLimits(event)
  })
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store!.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  })
  rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store!.getSettings()
    return {
      sessionCookie: readMiniMaxSessionCookie() ?? '',
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels
    }
  })
  rateLimits.setGeminiCliOAuthEnabledResolver(() => store!.getSettings().geminiCliOAuthEnabled)
  rateLimits.setNetworkProxySettingsResolver(() => store!.getSettings())
  keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store!.getSettings().keybindings,
    legacyTabSwitchSeed: {
      isPending: () => store!.getSettings().tabSwitchKeybindingSeed === 'pending',
      markSeeded: () => {
        store!.updateSettings({ tabSwitchKeybindingSeed: 'done' })
      }
    }
  })
  browserManager.setSettingsResolver(() => ({ keybindings: keybindings?.getOverrides() }))
  setServeBrowserSettingsResolver(() => store?.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store!.getSettings()
    const activeIds = new Set(
      [
        normalizeClaudeRuntimeSelection(settings).host,
        ...Object.values(normalizeClaudeRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthPath: account.managedAuthPath,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store!.getSettings()
    const activeIds = new Set(
      [
        normalizeCodexRuntimeSelection(settings).host,
        ...Object.values(normalizeCodexRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        resolveHome: () => {
          const resolved = codexRuntimeHome!.resolveCodexManagedAccountHomeForInactiveFetch(account)
          return resolved.kind === 'ready'
            ? { kind: 'ready' as const, managedHomePath: resolved.homePath }
            : { kind: 'skip' as const }
        }
      }))
  })
  const orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport = {
    resolve: (selector) => {
      const environment = resolveEnvironment(app.getPath('userData'), selector)
      const pairing = getPreferredPairingOffer(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(pairing.publicKeyB64)
      }
    },
    call: (selector, method, params, timeoutMs, envelope) =>
      callRuntimeEnvironment(
        app.getPath('userData'),
        selector,
        method,
        params,
        timeoutMs,
        undefined,
        envelope
      )
  }
  const runtimeService = new OrcaRuntimeService(store, stats, {
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Why: resolve the PTY provider lazily — a daemon swap happens later, so an eager reference would freeze the pre-daemon provider (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: SSH relay providers register after construction and may reconnect, so destructive cleanup must resolve the current generation.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    onPtyStopped: clearProviderPtyState,
    onTerminalAgentStatus: (event) => {
      agentHookServer.ingestTerminalStatus(event)
    },
    // Why: serve can be promoted in place, so wire the listener from startup; runtime enables desktop-only scanners only for a ready renderer.
    onTerminalSideEffects: (batch: TerminalSideEffectBatch) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    getDesktopWindowStatus: getDesktopWindowStatus,
    // Why: worktree.ps pulls hook-reported agent status (same source as the desktop sidebar) at query time so mobile shows the same agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    // Why: the filter above hides resume-identity rows from the live-agent views, but
    // those rows carry the provider session mobile native chat addresses transcripts
    // by — Pi publishes identity that way and would otherwise be unreachable.
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    reconcileAgentStatusForEndedProcess: (paneKeys) => {
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys)
    },
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    // Why: evaluated per call, not captured — the RPC server that owns the device registry is
    // constructed with this runtime and does not exist yet at this point.
    getPairedDeviceName: (pairedDeviceId) =>
      runtimeRpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
    // Why: source codex-home here (runs in window AND serve) so aiVault.listSessions includes managed-Codex sessions; registerCoreHandlers is window-only.
    getAdditionalAiVaultCodexHomePaths: () =>
      codexRuntimeHome ? codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery() : [],
    prepareAiVaultSessionResume: (args) =>
      prepareCodexAiVaultSessionResume(args, {
        runtimeHome: codexRuntimeHome,
        systemCodexHomePath: resolveHostCodexSessionSourceHome(store!.getSettings())
      }),
    prepareCodexStructuredLaunch: ({ workspacePath, launchEnv }) =>
      prepareCodexRuntimeHomeForLaunch(undefined, launchEnv, {
        launchAgent: 'codex',
        workspacePath
      }),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store?.getSettings()) ? agentHookServer.buildPtyEnv() : {},
    orchestrationEnvironmentTransport,
    skillTransactionRecovery
  })
  runtime = runtimeService
  runtimeService.prepareLegacyWorkerTerminalRecovery()
  // Why before anything can attach: a client host that reattaches to a restarted runtime is only
  // handed its pages back if the runtime found them first.
  runtimeService.rehydrateClientHostedBrowserPages()
  publishProviderSessionChanges(agentHookServer.getProviderSessionIdentities())
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtimeService.notifyMobileSessionTabsChanged(worktreeId)
  })
  const automationsGatedOff =
    benchSwitches.only.length > 0 && !benchSwitches.only.includes('automations')
  automations = automationsGatedOff
    ? null
    : new AutomationService(store, {
        claudeUsage,
        codexUsage,
        terminalObserver: createRuntimeAutomationRunTerminalObserver(runtimeService),
        onAutomationsChanged: (payload) => runtimeService.notifyAutomationsChanged(payload),
        // Why: desktop clients mirror remote-host automations, but only a server process should execute remote_host_service-owned schedules.
        allowRemoteHostScheduling: isServeMode,
        headlessDispatcher: isServeMode
          ? async ({ automation, run, target }) => {
              const terminalSnapshotLimit = 2_000
              let terminalHandle: string
              let terminalSessionId: string | null = null
              let terminalPaneKey: string | null = null
              let terminalPtyId: string | null = null
              let workspaceId: string
              let workspaceDisplayName: string | null = null

              if (automation.workspaceMode === 'new_per_run') {
                const created = await runtimeService.createManagedWorktree({
                  ...buildHeadlessAutomationWorktreeCreateArgs({
                    automation,
                    run,
                    repo: target.repo
                  })
                })
                terminalHandle = created.startupTerminal?.handle ?? ''
                terminalSessionId = created.startupTerminal?.tabId ?? null
                terminalPaneKey = created.startupTerminal?.paneKey ?? null
                terminalPtyId = created.startupTerminal?.ptyId ?? null
                workspaceId = created.worktree.id
                workspaceDisplayName = created.worktree.displayName ?? null
                if (!terminalHandle) {
                  throw new Error(
                    created.warning ||
                      'Automation workspace was created, but no agent terminal started.'
                  )
                }
              } else {
                if (!automation.workspaceId) {
                  throw new Error('The target workspace is no longer available.')
                }
                const terminal = await runtimeService.launchAgentTerminal(
                  `id:${automation.workspaceId}`,
                  {
                    agent: automation.agentId,
                    prompt: automation.prompt,
                    title: run.title
                  }
                )
                terminalHandle = terminal.handle
                terminalSessionId = terminal.tabId ?? null
                terminalPaneKey = terminal.paneKey ?? null
                terminalPtyId = terminal.ptyId ?? null
                workspaceId = terminal.worktreeId
                const worktree = await runtimeService.showManagedWorktree(`id:${workspaceId}`)
                workspaceDisplayName = worktree.displayName ?? null
              }

              const completion = (async () => {
                const wait = await runtimeService.waitForTerminal(terminalHandle, {
                  condition: 'tui-idle'
                })
                const read = await runtimeService.readTerminal(terminalHandle, {
                  limit: terminalSnapshotLimit
                })
                const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
                snapshotBuffer.append(read.tail.join('\n'))
                if (wait.satisfied) {
                  return {
                    status: 'completed' as const,
                    outputSnapshot: snapshotBuffer.snapshot(),
                    error: null
                  }
                }
                return {
                  status: 'dispatch_failed' as const,
                  outputSnapshot: snapshotBuffer.snapshot(),
                  error: wait.blockedReason
                    ? `Automation agent is blocked: ${wait.blockedReason}.`
                    : 'Automation agent did not report completion.'
                }
              })()

              return {
                workspaceId,
                workspaceDisplayName,
                terminalSessionId,
                terminalPaneKey,
                terminalPtyId,
                completion
              }
            }
          : undefined
      })
  if (automations) {
    runtimeService.setAutomationService(automations)
  }
  if (!benchSwitches.only.length) {
    runtimeService.setArtifactService(
      new ArtifactCloudService(app.getPath('userData'), () =>
        isArtifactSharingEnabled(store?.getSettings())
      )
    )
    runtimeService.setSkillCloudService(new SkillCloudService(app.getPath('userData')))
  }
  runtimeService.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtimeService.setCommitMessageAgentEnvironmentResolvers({
    // Why: Codex hooks/auth live in Orca's managed runtime home even for the default path, so every launch must resolve CODEX_HOME via runtime-home.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target)
  })
  // Bench gate: skip plugin system when --only names a subset that excludes plugins.
  const pluginsGatedOff = benchSwitches.only.length > 0 && !benchSwitches.only.includes('plugins')
  const pluginSystemStartupStartedAt = performance.now()
  pluginKillListService = pluginsGatedOff
    ? null
    : new PluginKillListService({
        pluginsDataDir: getPluginsDataDir(app.getPath('userData'))
      })
  if (pluginKillListService) {
    await pluginKillListService.initialize()
  }
  pluginMarketplaceService = new PluginMarketplaceService({
    pluginsDataDir: getPluginsDataDir(app.getPath('userData')),
    getKillListEntry: (pluginKey) => pluginKillListService?.find(pluginKey) ?? null
  })
  const requestOfficialMarketplaceSeed = (): void => {
    if (store?.getSettings().pluginSystemEnabled !== true) {
      return
    }
    void pluginMarketplaceService?.seedOfficialSource().catch((error) => {
      console.warn('[plugins] failed to configure the official marketplace:', error)
    })
  }
  pluginMarketplaceInstaller = new PluginMarketplaceInstaller({
    marketplace: pluginMarketplaceService,
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    blockedPluginReason: (pluginKey) => pluginKillListService?.reason(pluginKey) ?? null
  })
  pluginService = new PluginService({
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    // Feature flag: with the setting off, discovery returns nothing and no
    // plugin code path runs at all.
    isPluginSystemEnabled: () => store?.getSettings().pluginSystemEnabled === true,
    getDisabledPlugins: () => normalizePluginIdList(store?.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(store?.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(store?.getSettings().devPluginPaths),
    getKeybindings: () => keybindings?.getOverrides() ?? {},
    getPluginKillListEntry: (pluginKey) => pluginKillListService?.find(pluginKey) ?? null,
    hostEntryPath: resolvePluginHostEntryPath(app.getAppPath(), app.isPackaged)
  })
  const bundledPluginBootstrap = new PluginBundledBootstrapCoordinator({
    root: resolveBundledPluginRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    isEnabled: () => store?.getSettings().pluginSystemEnabled === true,
    blockedPluginReason: (pluginKey) => pluginKillListService?.reason(pluginKey) ?? null,
    refreshPlugins: () => pluginService?.refresh() ?? Promise.resolve()
  })
  const requestBundledPluginBootstrap = (): void => {
    void bundledPluginBootstrap
      .request()
      .then((result) => {
        for (const failure of result?.errors ?? []) {
          console.warn(`[plugins] failed to publish bundled ${failure.pluginKey}:`, failure.error)
        }
      })
      .catch((error) => {
        console.warn('[plugins] failed to bootstrap bundled plugins:', error)
      })
  }
  pluginKillListService?.onChanged(() => {
    void pluginService?.reconcileActivationState().catch((error) => {
      console.warn('[plugins] failed to apply plugin safety-list refresh:', error)
    })
  })
  store.onSettingsChanged((updates) => {
    if (updates.pluginSystemEnabled === true) {
      requestBundledPluginBootstrap()
      requestOfficialMarketplaceSeed()
    }
    if (app.isPackaged && updates.pluginSystemEnabled === true) {
      void pluginKillListService?.refresh().catch((error) => {
        console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
      })
    }
  })
  // Why: headless `orca serve` clients reach plugins through the runtime RPC
  // methods, which resolve the service via this module-level setter. Consent
  // over RPC uses the same hash-keyed write path as the desktop dialog.
  setPluginServiceForRpc(pluginService, {
    applyConsent: (request) =>
      applyPluginConsent({ store: store!, pluginService: pluginService!, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store: store!, pluginService: pluginService!, pluginKey, enabled })
  })
  // Lazy kernel: initialize() only discovers manifests — no worker forks, no
  // panel reads. Zero plugin code runs before an explicit trigger.
  if (!pluginsGatedOff) {
    void pluginService
      .initialize()
      .then(() => {
        logStartupMilestone('plugin-system-initialized', {
          durationMs: Number((performance.now() - pluginSystemStartupStartedAt).toFixed(2)),
          installedPlugins: pluginService?.getDiscovered().length ?? 0
        })
      })
      .catch((error) => {
        console.warn('[plugins] failed to initialize plugin service:', error)
      })
    if (app.isPackaged && store?.getSettings().pluginSystemEnabled === true) {
      void pluginKillListService?.refresh().catch((error) => {
        console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
      })
    }
  }
  pluginService.onChanged((event) => {
    if (
      event.contentPacksChanged &&
      setMainPluginLanguagePacks(pluginService?.contentPacks.languagePacks.list() ?? [])
    ) {
      void setMainUiLanguage(store!.getSettings().uiLanguage).then(() => rebuildAppMenu())
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('plugins:changed', event)
      }
    }
  })
  requestBundledPluginBootstrap()
  requestOfficialMarketplaceSeed()
  // v0 plugin event seams: agent status (hook pipeline tap) + worktree
  // lifecycle (runtime tap). Server-side filtered per plugin subscription.
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    // Why: plugins may automate on `working`; restored rows are historical claims, not fresh activity.
    if (enriched.restoredUnconfirmed) {
      return
    }
    pluginService?.emitEvent('agent.status.changed', {
      worktreeId: enriched.worktreeId ?? null,
      paneKey: enriched.paneKey,
      state: enriched.payload.state,
      receivedAt: enriched.receivedAt
    })
  })
  runtimeService.onWorktreeLifecycle((event) => {
    emitPluginWorktreeLifecycle(event)
  })
  starNag = new StarNagService(store, stats)
  starNag.start()
  starNag.registerIpcHandlers()
  // Why: the offscreen backend doesn't exist on desktop; the hooks only fire when it does (headless serve).
  let offscreenBackendRef: OffscreenBrowserBackend | null = null
  const agentBrowserBridge = new AgentBrowserBridge(browserManager, {
    onTabsChanged: (worktreeId) => runtimeService.notifyMobileSessionTabsChanged(worktreeId),
    resolveSleepingPage: (browserPageId) => {
      const backend = offscreenBackendRef
      if (!backend || !backend.isPageSleeping(browserPageId)) {
        return null
      }
      return backend.wakePage(browserPageId).then(() => ({
        // Wake registered the guest synchronously, so the id must exist here.
        webContentsId: backend.getWebContentsId(browserPageId)!
      }))
    },
    touchOffscreenPage: (browserPageId) => offscreenBackendRef?.touchPage(browserPageId),
    isOffscreenPageSleeping: (browserPageId) =>
      offscreenBackendRef?.isPageSleeping(browserPageId) ?? false,
    getSleepingPageUrl: (browserPageId) =>
      offscreenBackendRef?.getSleepingPage(browserPageId)?.url ?? '',
    listSleepingPageIds: () => offscreenBackendRef?.listSleepingPageIds() ?? []
  })
  runtimeService.setAgentBrowserBridge(agentBrowserBridge)
  // Why: daemons a crashed or SIGKILL'd previous run left behind answer to nobody; nothing else reclaims them.
  void agentBrowserBridge.sweepOrphanedSessions()
  const browserClientAutomationDispatcher = new RpcDispatcher({ runtime: runtimeService })
  configureBrowserClientPageAutomationRuntime({
    browserManager,
    getAgentBrowserBridge: () => agentBrowserBridge,
    executeRpc: async (method, params, signal) => {
      const response = await browserClientAutomationDispatcher.dispatch(
        {
          id: randomUUID(),
          authToken: 'local-browser-client-automation',
          method,
          params
        },
        { signal }
      )
      if (!response.ok) {
        throw new BrowserClientPageCommandError(response.error.code)
      }
      return response.result
    }
  })

  // Emulator bridge (serve-sim). macOS-only feature (gated in CLI/runtime); always ship like agent-browser.
  // Why: externally started serve-sim processes must stay independent — only Orca-managed/attached helpers belong to a workspace.
  const emulatorBridge = new EmulatorBridge()
  runtimeService.setEmulatorBridge(emulatorBridge)
  // Why: worktree deletion renames the checkout aside and deletes it in the background, so a quit or
  // crash mid-delete can leave the moved directory on disk.
  void sweepStaleWorktreeTrash(
    collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
  ).catch((error) => {
    console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
  })
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why (#16441): the real-home grant runs a codex app-server session. It stays
  // ordered before managed-hook reconciliation — an incapable host must re-arm
  // and complete the legacy real-home sweep first — but awaiting it inline
  // stalled app init behind that session, so chain instead of blocking.
  const startupManagedHookSettings = store.getSettings()
  const shouldReconcileStartupManagedHooks =
    shouldInstallManagedHooks(is.dev) &&
    resolveStartupManagedHookAction(startupManagedHookSettings) === 'install'
  const realHomeCodexHookState =
    shouldReconcileStartupManagedHooks &&
    shouldInstallStartupManagedAgentHook(startupManagedHookSettings, 'codex') &&
    codexRuntimeHome.isHostSystemDefaultRealHomeSelected()
      ? ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: app.getPath('userData')
        }).catch((error: unknown) => {
          console.warn('[codex-real-home-hooks] startup ensure failed:', error)
        })
      : Promise.resolve()
  // Why skip rather than remove when the off switch is set: the hook files are user-global but this
  // decision reads only THIS profile's settings, so removing here deletes the hooks every other Orca
  // instance depends on (STA-5679). Skipping already keeps removed hooks from reappearing on launch.
  if (shouldReconcileStartupManagedHooks) {
    const managedHookStore = store
    void realHomeCodexHookState
      .then(() =>
        installManagedAgentHooks(managedHookStore.getSettings(), {
          shouldHydrateShellPath: app.isPackaged,
          onInstallError: recordManagedHookInstallFailure,
          shouldContinue: (agent) => {
            const settings = managedHookStore.getSettings()
            return shouldContinueManagedHookStartup(isQuitting, settings, agent)
          }
        })
      )
      .catch((error: unknown) => {
        console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
      })
  }
  // Why: process-gone metrics only see survivors; retain a recent whole-app
  // snapshot for comparison in crash reports.
  startPreGoneProcessMetricsSampling()
  app.on('child-process-gone', (_event, details) => {
    recordProcessGoneCrash('child', details.type, details.reason, details.exitCode ?? null, {
      name: details.name,
      serviceName: details.serviceName,
      type: details.type
    })
    if (gpuFallbackLaunch.isGpuFallbackChildCrashCandidate(details)) {
      const crashedAt = performance.now()
      void gpuFallbackLaunch.getGpuCrashDiagnostics()?.record()
      void gpuFallbackLaunch.handleGpuChildCrash(
        details.reason,
        details.exitCode ?? null,
        crashedAt
      )
    }
  })

  logStartupMilestone('services-initialized')
  await ensureMainI18n()
  await setMainUiLanguage(store.getSettings().uiLanguage)
  logStartupMilestone('i18n-ready')

  registerAppMenu({
    appMenuLabel: devInstanceIdentity.name,
    onCheckForUpdates: (options) => runUserInitiatedUpdateCheck(options),
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (mainWindow?.webContents.id === webContentsId) {
        markExpectedRendererReload(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    },
    onOpenSettings: openSettingsFromSystemMenu,
    onOpenSetupGuide: (targetWindow) => {
      recordCrashBreadcrumb('setup_guide_opened')
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenSetupGuide(targetBrowserWindow)
    },
    onOpenCrashReport: (targetWindow) => {
      recordCrashBreadcrumb('crash_report_opened')
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenCrashReport(targetBrowserWindow)
    },
    onOpenFeatureTour: (targetWindow) => {
      recordCrashBreadcrumb('feature_tour_opened')
      // Why: use the invoking BrowserWindow so hidden/E2E and multi-window flows route to the right renderer, not global focus.
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenFeatureTour(targetBrowserWindow)
    },
    // Why: menu zoom must act on the window the user is looking at — routing to
    // the main window while the dashboard pop-out is focused zooms behind it.
    onZoomIn: () => {
      if (!zoomDashboardPopoutIfFocused('in')) {
        mainWindow?.webContents.send('terminal:zoom', 'in')
      }
    },
    onZoomOut: () => {
      if (!zoomDashboardPopoutIfFocused('out')) {
        mainWindow?.webContents.send('terminal:zoom', 'out')
      }
    },
    onZoomReset: () => {
      if (!zoomDashboardPopoutIfFocused('reset')) {
        mainWindow?.webContents.send('terminal:zoom', 'reset')
      }
    },
    onToggleLeftSidebar: () => {
      mainWindow?.webContents.send('ui:toggleLeftSidebar')
    },
    onToggleRightSidebar: () => {
      mainWindow?.webContents.send('ui:toggleRightSidebar')
    },
    onToggleAppearance: (key) => {
      if (!store) {
        return
      }
      if (key === 'statusBarVisible') {
        // Why: status bar visibility lives in persisted UI state (not settings) and the renderer owns the toggle — forward the event, let it flip + store.
        mainWindow?.webContents.send('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      // Why: these appearance settings are default-on, so a missing persisted value must toggle from visible -> hidden.
      const next = getNextDefaultOnAppearanceSettingValue(current[key])
      store.updateSettings({ [key]: next }, { notifyListeners: true })
      rebuildAppMenu()
    },
    getAppearanceState: () => {
      const settings = store?.getSettings()
      const ui = store?.getUI()
      return {
        showTasksButton: settings?.showTasksButton !== false,
        showAutomationsButton: settings?.showAutomationsButton !== false,
        showMobileButton: settings?.showMobileButton !== false,
        showTitlebarAppName: settings?.showTitlebarAppName !== false,
        statusBarVisible: ui?.statusBarVisible !== false
      }
    },
    getKeybindings: () => keybindings?.getOverrides()
  })
  // Why: parallel E2E Electron instances would race the fixed port (EADDRINUSE); port 0 gives each a random OS-assigned port.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  const requestedE2EWsPort = process.env.ORCA_E2E_RUNTIME_WS_PORT
  const e2eWsPort = requestedE2EWsPort === undefined ? 0 : Number(requestedE2EWsPort)
  if (isE2E && (!Number.isInteger(e2eWsPort) || e2eWsPort < 0 || e2eWsPort > 65_535)) {
    throw new Error(`Invalid ORCA_E2E_RUNTIME_WS_PORT value: ${requestedE2EWsPort}`)
  }
  // Why: pin dev to 6769 so `pnpm dev` doesn't race packaged Orca on 6768 and fall back to a random port, breaking deterministic mobile pairing/repro (STA-1511).
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  let serveOptions: ServeOptions | null = null
  try {
    serveOptions = isServeMode ? getServeOptions() : null
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  // Why: existing installs may have pairing creds under the late app.getPath('userData'); copy them forward before switching to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Why: mobile pairing needs the stable pre-setName() path (getCanonicalUserDataPath), not a late app.getPath('userData') that drops paired devices across restarts.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    // Why: STA-2370 — the desktop app binds the WS listener to loopback until the user pairs a device;
    // `orca serve` is an explicit remote opt-in, and E2E keeps the wide bind its harness connects over.
    exposeNetworkByDefault: Boolean(serveOptions) || isE2E,
    ...(isE2E ? { wsPort: e2eWsPort } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined
      ? {
          wsPort: serveOptions.wsPort,
          // Why: only explicit `orca serve --port` overrides a stale STA-1511 fallback (issue #8535); default/dev stay fallback-first for pairing stability.
          preferPinnedWsPort: true
        }
      : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  registerMobileHandlers(runtimeRpc, {
    getRelayStatus: () => desktopRelayStatus,
    consumePendingUnpairedDeviceAuthFailure: (webContentsId) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.webContents.id !== webContentsId ||
        !pendingUnpairedDeviceAuthFailure
      ) {
        return false
      }
      pendingUnpairedDeviceAuthFailure = false
      return true
    }
  })
  // Why: repeated direct auth failures otherwise look like a client that never connects; point users to re-pairing.
  runtimeRpc.setOnUnpairedDeviceAuthFailure(() => {
    // Why: runtime startup races renderer mount; retain the one-shot until the listener consumes it.
    pendingUnpairedDeviceAuthFailure = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mobile:unpairedDeviceAuthFailure')
    }
  })

  const shellPathReady = windowsShellPathHydration.whenReady()
  let desktopWindow: BrowserWindow | null = null
  if (process.platform === 'win32' && app.isPackaged && !serveOptions) {
    const desktopStartup = startWindowsDesktopBeforeShellPathReady({
      openWindow: () => openMainWindow({ revealOnDidFinishLoad: true }),
      shellPathReady,
      startServices: startTerminalRuntimeStartupServices
    })
    desktopWindow = desktopStartup.window
    bindTerminalRuntimeStartupServices(desktopStartup.services)
  } else {
    await shellPathReady
    bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))
  }
  app.on('activate', handleMacAppActivation)

  if (serveOptions) {
    // Why: give managed WSL launchers a brief chance to migrate before headless PTYs go live, without slow repairs withholding all RPC readiness.
    logStartupMilestone('wsl-cli-barrier-start')
    await managedWslCliStartupBarrierReady
    logStartupMilestone('wsl-cli-barrier-resolved', {
      reconciliation: managedWslCliReconciliationStatus
    })
    // Why: headless PTYs must not start on the fallback provider, then get swept when an activated renderer registers desktop lifecycle handlers.
    await localPtyStartupReady
    registerHeadlessPtyRuntime(
      runtime,
      prepareCodexRuntimeHomeForLaunch,
      () => store!.getSettings(),
      (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
      store,
      prepareCodexSessionResumeForLaunch,
      {
        onCodexHomePtySpawned: handleCodexHomePtySpawned,
        onPtyExit: handlePtyExit
      }
    )
    await runtime.refreshRestoredOrchestrationAuthority()
    await runtime.reconcileLegacyWorkerTerminals()
    // Why: headless servers can't mount <webview> panes; use offscreen WebContents, gated on a real display so browser.headless.v1 stays honest.
    if (headlessBrowserDisplayAvailable) {
      offscreenBackendRef = new OffscreenBrowserBackend(browserManager, {
        getAgentBrowserBridge: () => agentBrowserBridge
      })
      offscreenBackendRef.startIdleSweeper()
      runtime.setOffscreenBrowserBackend(offscreenBackendRef)
    }
    // Why: headless servers have no renderer graph publisher; publish an explicit empty graph so status clients see a ready server.
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start headless RPC transport:', error)
      throw error
    })
    settleServeDesktopActivation()
    // Why: every attempt must reach app.quit(); a page beforeunload can veto an earlier signal.
    registerServeSignalHandlers(process, () => app.quit())
    // Why: installs are best-effort tail work after the RPC transport is up; run them concurrently without blocking serve readiness.
    void serveStartup.installServeCliArtifacts()
    // Why: headless serve never opens a renderer, so arm scheduled automation dispatch here.
    automations?.start()
    // Why: serve deletes worktrees too, and the history GC that normally drains delete tombstones is
    // armed from the main window — without this, a quit mid-removal leaks the tree until a desktop launch.
    scheduleAllPendingHistoryTreeRemovals()
    await serveStartup.printServeReady(serveOptions)
    return
  }

  // Why: window and RPC startup run in parallel; registerPtyHandlers gates PTY spawns so RPC binds without racing the daemon provider swap.
  const desktopRuntimeRpc = runtimeRpc
  if (!desktopRuntimeRpc) {
    throw new Error('runtime_rpc_unavailable')
  }
  const [win, runtimeRpcStartResult] = await Promise.all([
    Promise.resolve(desktopWindow ?? openMainWindow()),
    shellPathReady
      .then(() => desktopRuntimeRpc.start())
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => {
          recordRuntimeRpcStartFailure(error)
          return { ok: false as const, error }
        }
      )
  ])
  if (!runtimeRpcStartResult.ok) {
    void showRuntimeRpcStartupFailureDialog(win, runtimeRpcStartResult.error)
  }

  const cloudAuth = getOrcaCloudAuthConfig()
  if (cloudAuth.configured) {
    try {
      const relayService = new DesktopRelayService({
        authConfig: cloudAuth.config,
        userDataPath: getProfileUserDataPath(),
        appVersion: app.getVersion(),
        runtimeRpc,
        onStatus: (status) => {
          desktopRelayStatus = status
          mainWindow?.webContents.send('mobile:relayStatusChanged', status)
        }
      })
      desktopRelayService = relayService
      runtimeRpc.setMobileRelayPairingProvider({
        createPairingRelay: (relayDeviceId) => relayService.createPairingRelay(relayDeviceId),
        onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
        onDemandStateChanged: () => relayService.demandStateChanged(),
        getEndpoints: (context, params) => relayService.getEndpoints(context, params),
        provisionRelay: (context, params) => relayService.provisionRelay(context, params)
      })
      relayService.start()
      // Why: sleeping past relay-token expiry kills the broker with no retry
      // timer; resume is the moment that state becomes recoverable.
      powerMonitor.on('resume', () => desktopRelayService?.ensureLive())
    } catch (error) {
      console.warn(
        '[relay] Desktop relay startup unavailable:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // Why: macOS notification permission dialog must fire after the window is shown, else it's hidden behind the maximized window.
  win.once('show', () => {
    // Why: store can be null if init failed earlier; bail rather than throw inside an Electron event listener.
    if (!store) {
      return
    }
    const onboarding = store.getOnboarding()
    if (onboarding.closedAt !== null) {
      triggerStartupNotificationRegistration(store)
    }
  })
})

// Why: app.exit() skips Electron quit events, so keep its log child from surviving forced exits.
process.once('exit', stopTccPromptNotice)

app.on('before-quit', () => {
  if (isQuittingForUpdate()) {
    recordUpdaterLifecycle('before_quit_allowed', undefined, {
      message: 'before-quit allowed for update install'
    })
  }
  isQuitting = true
  desktopRelayService?.fenceAndCloseNow()
  runtimeRpc?.setMobileRelayPairingProvider(null)
  unsubscribeAgentAwakeStatusChanges?.()
  unsubscribeAgentAwakeStatusChanges = null
  agentAwakeService?.dispose()
  agentAwakeService = null
  // Why: defer PTY cleanup to will-quit so the renderer captures scrollback before PTY-exit events unmount TerminalPane (dropping its capture callbacks).
  rateLimits?.stop()
})

// Why: will-quit fires twice — first pass preventDefaults and runs teardown; second pass exits.
let daemonDisconnectDone = false
// Why 2s: a config delete is best-effort, not durable state.
const GROK_HOOK_CLEANUP_DEADLINE_MS = 2_000

app.on('will-quit', (e) => {
  // Why return instead of re-running teardown: the second pass is Electron re-firing after
  // our own app.quit(), so every step below already ran and every durable write already
  // landed. Re-entering would start a fresh unawaited write that the exit then tears down.
  if (daemonDisconnectDone) {
    return
  }
  // Why preventDefault before any work: everything below must be free to await, and a
  // synchronous durable write here parks the main thread — uninterruptibly, on a stalled
  // network profile mount. The teardown deadline cannot rescue that, because its timer
  // lives on the same thread it would need to bound (#9447 covers the wedged-transport
  // half; this covers the blocked-syscall half).
  if (!quitTeardownStartGate.tryStart(e)) {
    return
  }
  unsubscribeSystemResumeBroadcast?.()
  unsubscribeSystemResumeBroadcast = null
  // Why: renderer guards can still cancel before this committed phase; `log stream` must survive those vetoes.
  stopTccPromptNotice()
  const updateQuitInProgress = isQuittingForUpdate()
  if (updateQuitInProgress) {
    recordUpdaterLifecycle(
      'will_quit_cleanup_started',
      { daemonTeardown: 'disconnect' },
      { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
    )
  }
  // Why: before-quit can still be aborted by renderer beforeunload; only remove the Windows tray icon on the committed quit path.
  destroySystemTray()
  // Why: an agent still working at quit gets no terminating hook, so stats.flushAsync() closes those sessions out synchronously (only the write is deferred) — otherwise their duration is lost.
  starNag?.stop()
  automations?.stop()
  // Why: plugin hosts are forked children; dispose sends shutdown and
  // escalates to SIGKILL so they cannot outlive the app. The promise joins
  // the teardown barrier below — quitting before it resolves would let
  // Electron exit first and orphan the hosts.
  setPluginServiceForRpc(null)
  pluginKillListService = null
  pluginMarketplaceService = null
  pluginMarketplaceInstaller = null
  const pluginHostShutdown = pluginService?.dispose() ?? Promise.resolve()
  const codexBackfillRecoveryShutdown = stopCodexStateDbBackfillRecoveries()
  const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()
  pluginService = null
  setUnreadDockBadgeCount(0)
  agentHookServer.stop()
  // Why Windows only: POSIX hooks short-circuit on ORCA_PANE_KEY, while Windows must register a
  // bare script path that cannot express the guard and would otherwise keep spawning after quit.
  // Why bounded here: every other teardown member carries its own ceiling, and this one reaches
  // $GROK_HOME -- which can be a stalled network mount, where the fs calls never settle and the
  // shared 20s deadline becomes the only thing ending the quit.
  const grokHookCleanup =
    process.platform === 'win32'
      ? settleWithinMs(
          removeManagedAgentHooksAsync({ agents: ['grok'] }),
          GROK_HOOK_CLEANUP_DEADLINE_MS
        ).then((settled) => {
          if (settled.outcome === 'timed-out') {
            console.warn('[agent-hooks] Grok hook cleanup on quit timed out')
            return
          }
          if (settled.outcome === 'failed') {
            console.warn('[agent-hooks] Grok hook cleanup on quit failed:', settled.error)
            return
          }
          // Why: removers report failures as statuses, so inspect details even after fulfillment.
          for (const status of settled.value.filter((entry) => entry.detail)) {
            console.warn(`[agent-hooks] ${status.agent} hook cleanup on quit: ${status.detail}`)
          }
        })
      : Promise.resolve()
  // Why: cancels relay restart/reinstall timers and kills wsl.exe children deterministically, not via stdio-pipe teardown.
  wslHookRelayManager.disposeAll()
  const statsFlush = stats?.flushAsync() ?? Promise.resolve()
  // Why: agent-browser daemon processes would otherwise linger after quit, holding ports and stale session state on disk.
  // Why the barrier below: each session's close is its own agent-browser child taking hundreds of ms,
  // so an unawaited call reaches app.quit() first and every open tab's daemon survives the quit (#16367).
  // Why retire headless page owners first: it closes those helpers without a duplicate close fanout.
  const browserShutdown = (async (): Promise<void> => {
    await runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
    await runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  })()
  // Why (review P2-4): local SSH browser routes own loopback listeners and, on the
  // system-ssh path, `ssh -N -D` children that would otherwise outlive the app.
  const localSshRouteShutdown = import('./browser/local-ssh-browser-route')
    .then((routes) => routes.closeAllLocalSshBrowserRoutes())
    .catch(() => {})
  browserManager.setBrowserGuestStateChangedListener(null)
  const emulatorShutdown = runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
  // Why immediately before store.flushAsync() with no await in between: beginSshShutdown() marks every
  // active SSH lease detached in memory synchronously, and that flush is what persists it.
  const sshShutdown = beginSshShutdown()
  killAllPty()
  const watcherShutdown = shutdownWatchersOnce()
  const storeFlush = store?.flushAsync() ?? Promise.resolve()
  // Why: usage-cache writes are queued off the main thread, so a quit right after setEnabled or a
  // scan completion would drop the final snapshot. Captured before any await; joins the barrier below.
  const usageCacheFlush = Promise.all([
    claudeUsage?.flush(),
    codexUsage?.flush(),
    openCodeUsage?.flush()
  ]).then(() => {})
  const browserClientHostShutdown = shutdownPairedRuntimeBrowserClientHosts()
  const skillUploadShutdown = runtime?.disposeSkillUploadSessions() ?? Promise.resolve()

  // Why: capture pid/runtimeId synchronously (before any await) so a later teardown path can't null them out mid-chain.
  const ownedPid = process.pid
  const ownedRuntimeId = runtime?.getRuntimeId()
  const rpcStopAndClear = runtimeRpc
    ? runtimeRpc
        .stop()
        .then(() => awaitRuntimeFileWatcherUnsubscribes())
        .then(() => {
          if (ownedRuntimeId) {
            // Why: must match the path the runtime server wrote metadata to (getCanonicalUserDataPath), not late app.getPath('userData').
            clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
          }
        })
        .catch((error) => {
          console.error('[runtime] Failed to stop local RPC transport:', error)
        })
    : Promise.resolve()
  // Why: allSettled (not all) keeps fail-open — a daemon-disconnect rejection still quits instead of hanging.
  // Why: telemetry flush folds in before app.quit() (bounded 2s); catch defensively so a flush failure can't cancel the quit chain.
  // Why: normal quits keep the detached daemon for warm reattach, but a dead dev parent leaves the temp/dev profile ownerless.
  const daemonTeardown = isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()
  // Why: a wedged transport (half-open post-sleep socket) can leave one
  // member unsettled forever and block app.quit() until Force Quit (#9447).
  // Why stats/state join here: their writes are durable but not worth hanging the app for.
  // Losing at most the last debounce interval beats a quit that never completes, and the
  // temp+rename swap means a write cut short by the deadline leaves the old file intact.
  settleTeardownWithinDeadline([
    { name: 'daemon', promise: daemonTeardown },
    { name: 'browser', promise: browserShutdown },
    { name: 'runtime-rpc', promise: rpcStopAndClear },
    { name: 'watchers', promise: watcherShutdown },
    { name: 'emulator', promise: emulatorShutdown },
    { name: 'browser-client-hosts', promise: browserClientHostShutdown },
    { name: 'local-ssh-browser-routes', promise: localSshRouteShutdown },
    { name: 'ssh', promise: sshShutdown },
    { name: 'plugin-hosts', promise: pluginHostShutdown },
    { name: 'skill-uploads', promise: skillUploadShutdown },
    { name: 'grok-hooks', promise: grokHookCleanup },
    { name: 'codex-backfill-recovery', promise: codexBackfillRecoveryShutdown },
    { name: 'structured-agent-session', promise: structuredAgentSessionShutdown },
    { name: 'usage-cache', promise: usageCacheFlush },
    { name: 'stats', promise: statsFlush },
    { name: 'state', promise: storeFlush }
  ])
    .then((pendingTeardowns) => {
      if (pendingTeardowns.length > 0) {
        console.warn('[shutdown] Quit teardown deadline reached', { pendingTeardowns })
      }
    })
    .then(() => shutdownTelemetry())
    .then(() => shutdownObservability())
    .catch(() => {
      /* swallow — telemetry must never prevent app.quit() */
    })
    .then(() => {
      daemonDisconnectDone = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  // Why: serve mode / disposable offscreen browser windows must not take down runtime RPC — the policy fn keeps the app alive.
  // Why: on macOS a quit-in-progress (Cmd+Q) is canceled by the renderer buffer-capture deferral; re-trigger quit so it actually exits.
  if (
    shouldQuitWhenAllWindowsClosed({
      platform: process.platform,
      isQuitting,
      isServeMode
    })
  ) {
    app.quit()
  }
})
