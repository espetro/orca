/* eslint-disable max-lines -- Why: preload is the audited renderer/Electron IPC contract; co-locating the surface eases security and type-drift review. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { glApi } from './gitlab'
import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../shared/skill-delete-contract'
import type { AppIdentity } from '../shared/app-identity'
import type { MacCapturedDigitRowChord } from '../shared/macos-symbolic-hotkeys'
import type { ComputerAwakeStatus } from '../shared/computer-awake-mode'
import type {
  DashboardRevealAgentArgs,
  DashboardSleepWorkspaceArgs,
  DashboardSnapshot,
  DashboardSpawnAgentArgs
} from '../shared/dashboard-snapshot'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../shared/terminal-preview'
import type { CliInstallStatus } from '../shared/cli-install-types'
import type { AgentHookInstallStatus } from '../shared/agent-hook-types'
import type { CodexConfigSyncStatus } from '../shared/codex-config-sync-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { AgentSessionPtyWriteRefusal } from '../shared/agent-session-pty-write-admission'
import type { StartupCommandDelivery } from '../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../shared/agent-session-resume'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../shared/remote-pairing-verification'
import type {
  SshMutationExpectation,
  SshConnectionState,
  SshConfigHostListArgs,
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConfigImportResult,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTarget,
  SshTargetUpdateInput,
  PortForwardEntry,
  EnrichedDetectedPort
} from '../shared/ssh-types'
import {
  admitSshConnectionStateForAuthorityReconciliation,
  admitSshDetectedPorts
} from '../shared/ssh-retained-payload-admission'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../shared/host-repo-catalog-contract'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../shared/plugins/plugin-consent-request'
import type { PluginChangeEvent } from '../shared/plugins/plugin-change-event'
import type {
  BrowserCaptureSelectionScreenshotArgs,
  BrowserExtractHoverArgs,
  BrowserSetGrabModeArgs
} from '../shared/browser-grab-types'
import type { BrowserViewportOverride } from '../shared/browser-workspace-types'
import type {
  BrowserWebAuthnAccountRequest,
  BrowserWebAuthnAccountResponse
} from '../shared/browser-webauthn-account'
import type { SearchResult } from '../shared/code-search-types'
import type {
  FilesystemPathFlavor,
  FsChangedPayload,
  MarkdownDocument
} from '../shared/filesystem-entry-types'
import type { JiraProjectStatusOrder } from '../shared/jira-types'
import type { LinearProjectDetail } from '../shared/linear/project-types'
import type {
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundDataResult,
  NotificationSoundPathResult,
  NotificationSoundResult
} from '../shared/notification-settings-types'
import type { OnboardingState } from '../shared/onboarding-state-types'
import type { NestedRepoScanResult } from '../shared/project-group-types'
import type { BaseRefDefaultResult, BaseRefSearchResult } from '../shared/repo-types'
import type { TuiAgent } from '../shared/tui-agent'
import type { FloatingTerminalCwdRequest } from '../shared/ui-chrome-types'
import type { WorktreeSetupLaunch } from '../shared/worktree/launch-types'
import type { PtyModelRestoreNeededEvent } from '../shared/pty-model-restore-marker'
import type { PtyListedSession } from '../shared/pty-listed-session'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../shared/terminal-view-attributes'
import type { WriteTerminalRenderDesyncEvidenceArgs } from '../shared/terminal-render-desync-evidence'
import type { PtyMainDeliveryDiagnostics } from '../shared/pty-delivery-diagnostics'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../shared/shell-open-types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../shared/skills'
import type {
  SkillCloudOwnedShare,
  SkillCloudOperation,
  SkillCloudPackageDetails
} from '../shared/skill-cloud-contract'
import type {
  SkillBundleInstallPreviewInput,
  SkillBundleInstallPreviewOperation,
  SkillBundlePackageVersionInstallInput,
  SkillBundleShareInstallInput,
  SkillBundleShareInstallOperation,
  SkillInstallPreviewInput,
  SkillInstallPreviewOperation,
  ManagedSkillInstallListOperation,
  SkillPackageVersionInstallInput,
  SkillRemoveInput,
  SkillRemoveOperation,
  SkillShareInstallInput,
  SkillShareInstallOperation,
  SkillInstallCancelInput,
  SkillInstallProgress,
  SkillSharePreview,
  SkillShareProgress,
  SkillSharePublishInput,
  SkillSharePublishOperation,
  SkillShareResolvedOperation
} from '../shared/skill-sharing-contract'
import type {
  SkillFreshnessInventory,
  SkillUpdateRun,
  SkillUpdateStartResult
} from '../shared/skill-freshness'
import type { ClientHostedBrowserRowsEvent } from '../shared/client-hosted-browser-rows'
import type {
  RuntimeBrowserDriverState,
  RuntimeRendererSyncWindowGraph,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../shared/runtime-types'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../shared/runtime-environments'
import type {
  CodexRateLimitResetResult,
  GrokAccountStatus,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../shared/rate-limit-types'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../shared/agent-question-answered-intent'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import type {
  PreflightRuntimeContext,
  RefreshAgentsResult,
  NativeChatAppendedPayload,
  NativeChatReadSessionResult,
  NativeChatSubscriptionFrame,
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  ExternalAutomationManagerResult,
  PreloadApi
} from './api-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'
import {
  KEYBOARD_LAYOUT_CHANGED_CHANNEL,
  type KeyboardLayoutChangeEvent
} from '../shared/keyboard-layout-events'
import { createBrowserFindSubscriptions } from './browser-find-subscriptions'
import { createBrowserClientPageRendererRequests } from './browser-client-page-renderer-requests'
import { readBrowserClientHostIdArgument } from '../shared/browser-client-host-id-argument'
import type { ExecutionHostId } from '../shared/execution-host'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationRunsPage,
  AutomationRun,
  AutomationPrecheckResult
} from '../shared/automations-types'
import type { AutomationOwnerRef } from '../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
} from '../shared/external-automation-scope'
import type { AutomationsChangedPayload } from '../shared/runtime-client-events'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../shared/ai-vault-session-deletion'
import type {
  AiVaultFirstUserPromptArgs,
  AiVaultListArgs,
  AiVaultSubagentListArgs
} from '../shared/ai-vault-types'
import type { AiVaultSessionTitlesArgs } from '../shared/ai-vault-session-title'
import type { AiVaultPrepareSessionResumeArgs } from '../shared/ai-vault-resume-preparation'
import type { AgentType } from '../shared/native-chat-types'
import {
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createNativeFileDropPayload,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  NATIVE_FILE_DROP_MAX_PATHS,
  resolveNativeFileDropPath,
  type NativeDropResolution,
  type NativeFileDropPathEntry
} from '../shared/native-file-drop'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../shared/local-log-tail-types'
import { subscribeRuntimeEnvironmentFromPreload } from './runtime-environment-subscriptions'
import type { RuntimeEnvironmentSubscriptionHandle } from './runtime-environment-subscriptions'
import type { HostedReviewForBranchArgs } from '../shared/hosted-review'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../shared/localhost-worktree-labels'
import { prepareAndInvokeAppRestart } from './renderer-restart-wiring'
import { speechBridge } from './bridge/speech-bridge'
import { mobileBridge } from './bridge/mobile-bridge'
import { feedbackBridge } from './bridge/feedback-bridge'
import { crashReportsBridge } from './bridge/crash-reports-bridge'
import { starNagBridge } from './bridge/star-nag-bridge'
import { petBridge } from './bridge/pet-bridge'
import { e2eBridge, e2eResourcesBridge } from './bridge/e2e-bridge'
import { updaterBridge } from './bridge/updater-bridge'
import { docPreviewBridge } from './bridge/doc-preview-bridge'
import { uiCommandWorktreeBridge } from './bridge/ui-command-worktree-bridge'
import { uiCommandBrowserBridge } from './bridge/ui-command-browser-bridge'
import { uiCommandTerminalBridge } from './bridge/ui-command-terminal-bridge'
import { uiWindowBridge } from './bridge/ui-window-bridge'
import { cacheBridge, sessionBridge, remoteWorkspaceBridge } from './bridge/workspace-session-bridge'
import { worktreesBridge } from './bridge/worktrees-bridge'
import {
  workspaceCleanupBridge,
  workspaceSpaceBridge,
  workspacePortsBridge
} from './bridge/workspace-cleanup-space-ports-bridge'
import { gitBridge } from './bridge/git-bridge'
import { ghBridge } from './bridge/github-bridge'
import { ghProjectsBridge } from './bridge/github-projects-bridge'
import { platformBridge, wslBridge, pwshBridge, gitBashBridge } from './bridge/platform-bridge'
import {
  telemetryBridge,
  diagnosticsBridge,
  statsBridge,
  memoryBridge
} from './bridge/telemetry-diagnostics-bridge'
import { settingsBridge } from './bridge/settings-bridge'
import { keybindingsBridge } from './bridge/keybindings-bridge'
import {
  claudeUsageBridge,
  codexUsageBridge,
  openCodeUsageBridge
} from './bridge/usage-provider-bridges'
import { awaitBeforeUnloadCheckpoint } from './bridge/before-unload-checkpoint'


// Why: cache one shared Audio + blob URL per sound path so we don't re-read 10MB from disk and re-transfer over IPC on every notification.
let cachedNotificationSound: {
  path: string
  blobUrl: string
  audio: HTMLAudioElement
} | null = null
let isNotificationSoundPlaying = false
// Why: audio.play() can reject before ended/error fires — cleanup hook prevents leaked listeners on the cached Audio.
let cleanupNotificationSoundPlayback: (() => void) | null = null

function clearNotificationSoundPlaybackState(): void {
  cleanupNotificationSoundPlayback?.()
  cleanupNotificationSoundPlayback = null
  isNotificationSoundPlaying = false
}

function disposeCachedNotificationSound(): void {
  if (cachedNotificationSound) {
    clearNotificationSoundPlaybackState()
    cachedNotificationSound.audio.pause()
    cachedNotificationSound.audio.src = ''
    URL.revokeObjectURL(cachedNotificationSound.blobUrl)
    cachedNotificationSound = null
  }
}

/**
 * Classify which UI surface the native OS drop landed on, and for file-explorer drops
 * extract the destination directory from `data-native-file-drop-dir`.
 *
 * Why: preload consumes the native `drop` before React can read paths, so it must capture
 * the destination dir now — otherwise the renderer can't tell "root" from "inside this folder".
 */
function resolveNativeFileDrop(event: DragEvent): NativeDropResolution | null {
  const pathEntries: NativeFileDropPathEntry[] = []
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement) {
      pathEntries.push({
        nativeFileDropTarget: entry.dataset.nativeFileDropTarget,
        nativeFileDropDir: entry.dataset.nativeFileDropDir,
        terminalTabId: entry.dataset.terminalTabId,
        terminalPaneLeafId: entry.dataset.terminalPaneLeafId ?? entry.dataset.leafId
      })
    }
  }
  return resolveNativeFileDropPath(pathEntries)
}

// File drag-and-drop lives in preload because webUtils (File→path) is only available in the preload/main world, not the renderer's isolated world.
document.addEventListener(
  'dragover',
  (e) => {
    // Let in-app drags through to React handlers (their own dropEffect); only override for native OS file drops.
    if (e.dataTransfer && !hasNativeFileDragTypes(e.dataTransfer.types)) {
      return
    }
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  },
  true
)

document.addEventListener(
  'drop',
  (e) => {
    // Let in-app drags (e.g. file explorer → terminal) through to React handlers
    if (e.dataTransfer?.types.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)) {
      return
    }

    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }
    const resolution = resolveNativeFileDrop(e)

    // Why: reject oversized gestures by count before resolving every File object (path resolution is synchronous here).
    if (files.length > NATIVE_FILE_DROP_MAX_PATHS) {
      ipcRenderer.send(
        'terminal:file-dropped-from-preload',
        createRejectedNativeFileDropPayload({
          byteLength: 0,
          pathCount: files.length,
          reason: 'too-many-paths',
          status: 'rejected'
        })
      )
      return
    }

    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      // webUtils.getPathForFile is the Electron 28+ replacement for File.path
      const filePath = webUtils.getPathForFile(files[i])
      if (filePath) {
        paths.push(filePath)
      }
    }

    if (paths.length === 0) {
      return
    }

    // Why: explorer marker present but no destination dir resolved → reject entirely, no editor fallback (fail-closed, design §7.1).
    if (resolution?.target === 'rejected') {
      return
    }

    const payload = createNativeFileDropPayload(resolution, paths)
    if (!payload) {
      return
    }
    // Why: emit exactly one native-drop event per gesture (the shared planner rejects oversized payloads without leaking path contents).
    ipcRenderer.send('terminal:file-dropped-from-preload', payload)
  },
  true
)

const startupDiagnosticsEnabled = process.env.ORCA_STARTUP_DIAGNOSTICS === '1'
const browserFindSubscriptions = createBrowserFindSubscriptions()
const browserClientPageRendererRequests = createBrowserClientPageRendererRequests({
  ipc: ipcRenderer,
  isTopFrame: () => window.top === window
})

ipcRenderer.on('ui:findInBrowserPage', (_event, source: unknown) => {
  browserFindSubscriptions.dispatch(source)
})

// Custom APIs for renderer
const api: PreloadApi = {
  app: {
    awaitBeforeUnloadCheckpoint: () => awaitBeforeUnloadCheckpoint(),
    getIdentity: (): Promise<AppIdentity> => ipcRenderer.invoke('app:getIdentity'),
    getFeatureWallAssetBaseUrl: (): Promise<string> =>
      ipcRenderer.invoke('app:getFeatureWallAssetBaseUrl'),
    relaunch: (): Promise<void> =>
      prepareAndInvokeAppRestart(
        window,
        () => ipcRenderer.invoke('app:relaunch'),
        awaitBeforeUnloadCheckpoint
      ),
    restart: (): Promise<void> =>
      prepareAndInvokeAppRestart(
        window,
        () => ipcRenderer.invoke('app:restart'),
        awaitBeforeUnloadCheckpoint
      ),
    reload: (): Promise<void> =>
      prepareAndInvokeAppRestart(
        window,
        () => ipcRenderer.invoke('app:reload'),
        awaitBeforeUnloadCheckpoint
      ),
    stageBeforeUnloadSync: (args: Parameters<PreloadApi['app']['stageBeforeUnloadSync']>[0]) => {
      const result = ipcRenderer.sendSync('app:stage-before-unload-sync', args) as {
        ok?: unknown
      }
      if (result?.ok !== true) {
        throw new Error('Failed to stage renderer state before unload.')
      }
    },
    awaitFirstWindowStartupServices: (): Promise<void> =>
      ipcRenderer.invoke('app:awaitFirstWindowStartupServices'),
    prepareTerminalStartupRestoration: (): Promise<void> =>
      ipcRenderer.invoke('app:prepareTerminalStartupRestoration'),
    recoverLegacyWorkerTerminalsForRendererStartup: (): Promise<void> =>
      ipcRenderer.invoke('app:recoverLegacyWorkerTerminalsForRendererStartup'),
    startupDiagnostic: (event: string, details?: Record<string, unknown>): Promise<void> =>
      startupDiagnosticsEnabled
        ? ipcRenderer.invoke('app:startupDiagnostic', event, details)
        : Promise.resolve(),
    // Why: macOS input mode (or layout ID) so keyboard workarounds can tell CJK/compose layouts from US QWERTY (issue #1205); null on non-Darwin or read failure.
    getKeyboardInputSourceId: (): Promise<string | null> =>
      ipcRenderer.invoke('app:getKeyboardInputSourceId'),
    getMacCapturedDigitRowChords: (): Promise<MacCapturedDigitRowChord[]> =>
      ipcRenderer.invoke('app:getMacCapturedDigitRowChords'),
    getKeyboardLayoutSnapshot: () => ipcRenderer.invoke('app:getKeyboardLayoutSnapshot'),
    onKeyboardLayoutChanged: (
      callback: (event: KeyboardLayoutChangeEvent) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        event: KeyboardLayoutChangeEvent
      ): void => callback(event)
      ipcRenderer.on(KEYBOARD_LAYOUT_CHANGED_CHANNEL, listener)
      return () => ipcRenderer.removeListener(KEYBOARD_LAYOUT_CHANGED_CHANNEL, listener)
    },
    setUnreadDockBadgeCount: (count: number): Promise<void> =>
      ipcRenderer.invoke('app:setUnreadDockBadgeCount', count),
    getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest): Promise<string> =>
      ipcRenderer.invoke('app:getFloatingTerminalCwd', args),
    getFloatingMarkdownDirectory: (): Promise<string> =>
      ipcRenderer.invoke('app:getFloatingMarkdownDirectory'),
    pickFloatingMarkdownDocument: (): Promise<MarkdownDocument | null> =>
      ipcRenderer.invoke('app:pickFloatingMarkdownDocument'),
    pickFloatingWorkspaceDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('app:pickFloatingWorkspaceDirectory'),
    writeTerminalRenderDesyncEvidence: (args: WriteTerminalRenderDesyncEvidenceArgs) =>
      ipcRenderer.invoke('terminal:writeRenderDesyncEvidence', args)
  },

  orcaProfiles: {
    list: () => ipcRenderer.invoke('orcaProfiles:list'),
    authStatus: () => ipcRenderer.invoke('orcaProfiles:authStatus'),
    createLocal: (args) => ipcRenderer.invoke('orcaProfiles:createLocal', args),
    createCloudLinked: (args) => ipcRenderer.invoke('orcaProfiles:createCloudLinked', args),
    switchProfile: (args) => ipcRenderer.invoke('orcaProfiles:switch', args),
    transferProject: (args) => ipcRenderer.invoke('orcaProfiles:transferProject', args),
    findProjectProfiles: (args) => ipcRenderer.invoke('orcaProfiles:findProjectProfiles', args),
    connectCurrent: () => ipcRenderer.invoke('orcaProfiles:connectCurrent'),
    refreshAuth: () => ipcRenderer.invoke('orcaProfiles:refreshAuth'),
    signOutCurrent: () => ipcRenderer.invoke('orcaProfiles:signOutCurrent'),
    selectOrg: (args) => ipcRenderer.invoke('orcaProfiles:selectOrg', args),
    orgMembersList: (args) => ipcRenderer.invoke('orcaProfiles:orgMembersList', args),
    orgMemberInvite: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberInvite', args),
    orgInviteRevoke: (args) => ipcRenderer.invoke('orcaProfiles:orgInviteRevoke', args),
    orgMemberChangeRole: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberChangeRole', args),
    orgMemberRemove: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberRemove', args)
  } satisfies PreloadApi['orcaProfiles'],





  plugins: {
    list: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:list'),
    listLanguagePacks: () => ipcRenderer.invoke('plugins:listLanguagePacks'),
    consent: (args: PluginConsentRequest): Promise<PluginHostListEntry[]> =>
      ipcRenderer.invoke('plugins:consent', args),
    setEnabled: (args: { pluginKey: string; enabled: boolean }): Promise<PluginHostListEntry[]> =>
      ipcRenderer.invoke('plugins:setEnabled', args),
    readPanelEntry: (args: {
      pluginKey: string
      panelId: string
    }): Promise<PluginPanelEntry | null> => ipcRenderer.invoke('plugins:readPanelEntry', args),
    invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
      ipcRenderer.invoke('plugins:invokeCommand', args),
    panelAction: (args: {
      sessionToken: string
      action: string
      params?: unknown
    }): Promise<PluginPanelActionOutcome> => ipcRenderer.invoke('plugins:panelAction', args),
    install: (source: PluginHostInstallSource): Promise<PluginHostInstallResult> =>
      ipcRenderer.invoke('plugins:install', source),
    listMarketplaces: () => ipcRenderer.invoke('plugins:listMarketplaces'),
    addMarketplace: (source) => ipcRenderer.invoke('plugins:addMarketplace', source),
    removeMarketplace: (args) => ipcRenderer.invoke('plugins:removeMarketplace', args),
    refreshMarketplaces: (args = {}) => ipcRenderer.invoke('plugins:refreshMarketplaces', args),
    listMarketplacePlugins: () => ipcRenderer.invoke('plugins:listMarketplacePlugins'),
    previewMarketplacePlugin: (args) =>
      ipcRenderer.invoke('plugins:previewMarketplacePlugin', args),
    installMarketplacePlugin: (preview) =>
      ipcRenderer.invoke('plugins:installMarketplacePlugin', preview),
    previewMarketplaceUpdate: (args) =>
      ipcRenderer.invoke('plugins:previewMarketplaceUpdate', args),
    rollbackMarketplacePlugin: (args) =>
      ipcRenderer.invoke('plugins:rollbackMarketplacePlugin', args),
    remove: (args: { pluginKey: string }): Promise<PluginHostListEntry[]> =>
      ipcRenderer.invoke('plugins:remove', args),
    getLogs: (args: { pluginKey: string }): Promise<PluginHostLogLine[]> =>
      ipcRenderer.invoke('plugins:getLogs', args),
    refresh: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:refresh'),
    onChanged: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, change: PluginChangeEvent): void =>
        callback(change)
      ipcRenderer.on('plugins:changed', listener)
      return () => {
        ipcRenderer.removeListener('plugins:changed', listener)
      }
    }
  } satisfies PreloadApi['plugins'],

  repos: {
    list: () => ipcRenderer.invoke('repos:list'),

    listForExecutionHost: (args: ListReposForExecutionHostArgs): Promise<HostRepoCatalogSnapshot> =>
      ipcRenderer.invoke('repos:listForExecutionHost', args),

    add: (args) => ipcRenderer.invoke('repos:add', args),

    addRemote: (args) => ipcRenderer.invoke('repos:addRemote', args),

    create: (args) => ipcRenderer.invoke('repos:create', args),

    isGitAvailable: (): Promise<boolean> => ipcRenderer.invoke('repos:isGitAvailable'),

    getDefaultCreateProjectParent: (): Promise<string> =>
      ipcRenderer.invoke('repos:getDefaultCreateProjectParent'),

    remove: (args) => ipcRenderer.invoke('repos:remove', args),

    removeForHost: (args) => ipcRenderer.invoke('repos:removeForHost', args),

    reorder: (args) => ipcRenderer.invoke('repos:reorder', args),

    reorderForHost: (args) => ipcRenderer.invoke('repos:reorderForHost', args),

    update: (args) => ipcRenderer.invoke('repos:update', args),

    pickFolder: () => ipcRenderer.invoke('repos:pickFolder'),

    pickFolders: () => ipcRenderer.invoke('repos:pickFolders'),

    pickDirectory: () => ipcRenderer.invoke('repos:pickDirectory'),

    clone: (args) => ipcRenderer.invoke('repos:clone', args),

    cloneRemote: (args) => ipcRenderer.invoke('repos:cloneRemote', args),

    createRemote: (args) => ipcRenderer.invoke('repos:createRemote', args),

    cloneAbort: () => ipcRenderer.invoke('repos:cloneAbort'),

    onCloneProgress: (
      callback: (data: { phase: string; percent: number }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { phase: string; percent: number }
      ) => callback(data)
      ipcRenderer.on('repos:clone-progress', listener)
      return () => ipcRenderer.removeListener('repos:clone-progress', listener)
    },

    getGitUsername: (args: { repoId: string }): Promise<string> =>
      ipcRenderer.invoke('repos:getGitUsername', args),

    getBaseRefDefault: (args: {
      repoId: string
      hostId?: ExecutionHostId
    }): Promise<BaseRefDefaultResult> => ipcRenderer.invoke('repos:getBaseRefDefault', args),

    searchBaseRefs: (args: {
      repoId: string
      query: string
      limit?: number
      hostId?: ExecutionHostId
    }): Promise<string[]> => ipcRenderer.invoke('repos:searchBaseRefs', args),

    searchBaseRefDetails: (args: {
      repoId: string
      query: string
      limit?: number
      hostId?: ExecutionHostId
    }): Promise<BaseRefSearchResult[]> => ipcRenderer.invoke('repos:searchBaseRefDetails', args),

    onChanged: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('repos:changed', listener)
      return () => ipcRenderer.removeListener('repos:changed', listener)
    }
  } satisfies PreloadApi['repos'],

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    update: (args) => ipcRenderer.invoke('projects:update', args),
    listHostSetups: () => ipcRenderer.invoke('projectHostSetups:list'),
    createHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:create', args),
    setupExistingFolder: (args) =>
      ipcRenderer.invoke('projectHostSetups:setupExistingFolder', args),
    updateHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:update', args),
    deleteHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:delete', args)
  } satisfies PreloadApi['projects'],

  projectGroups: {
    list: () => ipcRenderer.invoke('projectGroups:list'),
    create: (args) => ipcRenderer.invoke('projectGroups:create', args),
    update: (args) => ipcRenderer.invoke('projectGroups:update', args),
    delete: (args) => ipcRenderer.invoke('projectGroups:delete', args),
    moveProject: (args) => ipcRenderer.invoke('projectGroups:moveProject', args),
    scanNested: (args) => ipcRenderer.invoke('projectGroups:scanNested', args),
    cancelNestedScan: (args) => ipcRenderer.invoke('projectGroups:cancelNestedScan', args),
    onNestedScanProgress: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { scanId: string; scan: NestedRepoScanResult }
      ) => callback(data)
      ipcRenderer.on('projectGroups:scanNestedProgress', listener)
      return () => ipcRenderer.removeListener('projectGroups:scanNestedProgress', listener)
    },
    importNested: (args) => ipcRenderer.invoke('projectGroups:importNested', args)
  } satisfies PreloadApi['projectGroups'],

  folderWorkspaces: {
    list: () => ipcRenderer.invoke('folderWorkspaces:list'),
    getPathStatus: (args) => ipcRenderer.invoke('folderWorkspaces:getPathStatus', args),
    create: (args) => ipcRenderer.invoke('folderWorkspaces:create', args),
    update: (args) => ipcRenderer.invoke('folderWorkspaces:update', args),
    delete: (args) => ipcRenderer.invoke('folderWorkspaces:delete', args)
  } satisfies PreloadApi['folderWorkspaces'],

  sparsePresets: {
    list: (args) => ipcRenderer.invoke('sparsePresets:list', args),

    save: (args) => ipcRenderer.invoke('sparsePresets:save', args),

    remove: (args) => ipcRenderer.invoke('sparsePresets:remove', args),

    onChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) =>
        callback(data)
      ipcRenderer.on('sparsePresets:changed', listener)
      return () => ipcRenderer.removeListener('sparsePresets:changed', listener)
    }
  } satisfies PreloadApi['sparsePresets'],
  worktrees: worktreesBridge,
  workspaceCleanup: workspaceCleanupBridge,
  workspaceSpace: workspaceSpaceBridge,
  workspacePorts: workspacePortsBridge,
 pty: {
   spawn: (opts: {
     cols: number
     rows: number
     cwd?: string
     cwdFallback?: 'worktree'
     env?: Record<string, string>
     envToDelete?: string[]
     command?: string
     commandDelivery?: 'renderer' | 'provider'
     launchConfig?: SleepingAgentLaunchConfig
     resumeProviderSession?: AgentProviderSessionMetadata
     launchToken?: string
     launchAgent?: TuiAgent
     startupCommandDelivery?: StartupCommandDelivery
     connectionId?: string | null
     worktreeId?: string
     sessionId?: string
     shellOverride?: string
     projectRuntime?: ProjectExecutionRuntimeResolution
     terminalColorQueryReplies?: { foreground?: string; background?: string }
     // Why: marks the PTY hidden before its first byte so the delivery gate + model responder own spawn-time queries (terminal-query-authority.md §races).
     initiallyHidden?: boolean
     // Why: closes the SIGKILL race (INVESTIGATION.md) — main sync-flushes the (worktreeId, tabId, leafId → ptyId) binding before pty:spawn returns.
     tabId?: string
     leafId?: string
     // Why: loose typing on purpose — renderer owns launch metadata, main owns whether the launch happened and validates (telemetry-plan.md §Agent launch semantics).
     telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
   }): Promise<{
     id: string
     /** Which lifetime of `id` this reply named; absent when the execution host predates the field. */
     incarnationId?: string
     launchConfig?: SleepingAgentLaunchConfig
     snapshot?: string
     snapshotCols?: number
     snapshotRows?: number
     snapshotPrefixAnsi?: string
     snapshotFrameAnsi?: string
     snapshotFrameRestoreAnsi?: string
     snapshotKittyKeyboardFlags?: number
     snapshotTerminalOwner?: 'shell'
     snapshotSeq?: number
     isReattach?: boolean
     isAlternateScreen?: boolean
     replay?: string
     sessionExpired?: boolean
     coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
     startupCwdFallback?: { kind: 'worktree'; cwd: string }
     agentResumeUnavailable?: true
   }> => ipcRenderer.invoke('pty:spawn', opts),
   write: (id: string, data: string): void => {
     ipcRenderer.send('pty:write', { id, data })
   },
   writeAccepted: (id: string, data: string): Promise<boolean> =>
     ipcRenderer.invoke('pty:writeAccepted', { id, data }),
   onWriteUnavailable: (
     callback: (payload: {
       id: string
       /** Set only when a durable agent-session lease refused the write; absent otherwise. */
       agentSessionRefusal?: AgentSessionPtyWriteRefusal
     }) => void
   ): (() => void) => {
     const handler = (
       _event: Electron.IpcRendererEvent,
       payload: { id: string; agentSessionRefusal?: AgentSessionPtyWriteRefusal }
     ): void => callback(payload)
     ipcRenderer.on('pty:writeUnavailable', handler)
     return () => ipcRenderer.removeListener('pty:writeUnavailable', handler)
   },
   resize: (id: string, cols: number, rows: number): void => {
     ipcRenderer.send('pty:resize', { id, cols, rows })
   },
   claimViewport: (id: string, cols: number, rows: number): void => {
     ipcRenderer.send('pty:claimViewport', { id, cols, rows })
   },
   /** Why: measurement-only sibling of resize — keeps the runtime's restore-target baseline fresh while a mobile-fit override blocks pty:resize. Never resizes the PTY. See docs/mobile-fit-hold.md. */
   reportGeometry: (id: string, cols: number, rows: number): void => {
     ipcRenderer.send('pty:reportGeometry', { id, cols, rows })
   },
   signal: (id: string, signal: string): void => {
     ipcRenderer.send('pty:signal', { id, signal })
   },
   /** Why: Cmd/Ctrl+K clears the renderer xterm, but the PTY host keeps its own screen state and would repaint the next prompt at the stale cursor row. */
   clearBuffer: (id: string): void => {
     ipcRenderer.send('pty:clearBuffer', { id })
   },
   ackColdRestore: (id: string): void => {
     ipcRenderer.send('pty:ackColdRestore', { id })
   },
   /** charCount is the legacy per-chunk delta; processedChars is the cumulative per-pty total (self-heals under lost ACKs). */
   ackData: (id: string, charCount: number, processedChars?: number): void => {
     ipcRenderer.send('pty:ackData', {
       id,
       charCount,
       ...(typeof processedChars === 'number' ? { processedChars } : {})
     })
   },
   /** Main requests the renderer's cumulative processed totals when delivery looks stuck on lost ACKs. */
   onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void): (() => void) => {
     const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: number }) =>
       callback(payload)
     ipcRenderer.on('pty:requestDeliveryResync', listener)
     return () => ipcRenderer.removeListener('pty:requestDeliveryResync', listener)
   },
   respondDeliveryResync: (payload: {
     requestId: number
     processedCharsByPty: Record<string, number>
   }): void => {
     ipcRenderer.send('pty:deliveryResyncResponse', payload)
   },
   /** Renderer-initiated delivery health/heal lane — rides invoke because the field wedge (v1.4.121-rc.0) kills main→renderer push while invoke stays alive. */
   reportRendererDeliveryState: (
     report: PtyRendererDeliveryStateReport
   ): Promise<PtyRendererDeliveryHealthReply> =>
     ipcRenderer.invoke('pty:reportRendererDeliveryState', report),
   /** Live pty:data listener count — the watchdog's "listener detached" vs "channel dead" discriminator. */
   getPtyDataListenerCount: (): number => ipcRenderer.listenerCount('pty:data'),
   rendererDispatcherReady: (): void => {
     ipcRenderer.send('pty:rendererDispatcherReady')
   },
   setActiveRendererPty: (id: string, active: boolean): void => {
     ipcRenderer.send('pty:setActiveRendererPty', { id, active })
   },
   setRendererPtyVisible: (id: string, visible: boolean): void => {
     ipcRenderer.send('pty:setRendererPtyVisible', { id, visible })
   },
   /** Hidden-delivery gate: hidden=true lets main DROP renderer byte delivery after model ingestion; reveal restores from the model snapshot. Fire-and-forget. */
   setHiddenRendererPty: (id: string, hidden: boolean): void => {
     ipcRenderer.send('pty:setHiddenRendererPty', { id, hidden })
   },
   /** Delivery-interest signal: a renderer party needing raw bytes suppresses the hidden-delivery gate for that PTY while registered. */
   setPtyDeliveryInterest: (id: string, interested: boolean): void => {
     ipcRenderer.send('pty:setPtyDeliveryInterest', { id, interested })
   },
   /** Push composed terminal appearance so main's model responder can answer OSC 4/10/11/12 and DSR ?996n for hidden-gated PTYs with renderer-true values. */
   publishTerminalViewAttributes: (attributes: TerminalViewAttributes): void => {
     ipcRenderer.send('pty:terminalViewAttributes', attributes)
   },
   kill: (id: string, opts?: { keepHistory?: boolean }): Promise<void> =>
     ipcRenderer.invoke('pty:kill', { id, keepHistory: opts?.keepHistory ?? false }),
   listSessions: (): Promise<PtyListedSession[]> => ipcRenderer.invoke('pty:listSessions'),
   getAuthoritativeBufferSnapshotCapabilities: (
     ids: string[]
   ): Promise<{ id: string; authoritative: boolean | null }[]> =>
     ipcRenderer.invoke('pty:getAuthoritativeBufferSnapshotCapabilities', { ids }),
   hasPty: (id: string): Promise<boolean | null> => ipcRenderer.invoke('pty:hasPty', { id }),
   getMainBufferSnapshot: (
     id: string,
     opts?: { scrollbackRows?: number }
   ): Promise<{
     data: string
     frameRestoreAnsi?: string
     cols: number
     rows: number
     cwd?: string | null
     seq?: number
     pendingDeliveryStartSeq?: number
     source?: 'headless' | 'renderer'
     alternateScreen?: boolean
     scrollbackAnsi?: string
     pendingEscapeTailAnsi?: string
     kittyKeyboardFlags?: number
     terminalOwner?: 'shell'
   } | null> => ipcRenderer.invoke('pty:getMainBufferSnapshot', { id, opts }),
   getRendererDeliveryDebugSnapshot: (): Promise<{
     pendingPtyCount: number
     pendingChars: number
     maxPendingCharsByPty: number
     rendererInFlightPtyCount: number
     rendererInFlightChars: number
     maxRendererInFlightCharsByPty: number
     activeRendererPtyCount: number
     flushScheduled: boolean
     peakPendingChars: number
     peakMaxPendingCharsByPty: number
     peakRendererInFlightChars: number
     peakMaxRendererInFlightCharsByPty: number
     ackGatedFlushSkipCount: number
     hiddenDeliveryGatedPtyCount: number
     hiddenDeliveryGatedVisiblePtyCount: number
     hiddenDeliveryGatedActivePtyCount: number
     deliveryInterestPtyCount: number
     hiddenDeliveryDroppedChars: number
     hiddenDeliveryDroppedChunks: number
     pendingDroppedChars: number
     diagnostics: PtyMainDeliveryDiagnostics
     rendererLifecycleResetCount: number
     lastLifecycleResetClearedChars: number
     rendererPtyDispatcherReady: boolean
     rendererDispatcherReadyForcedCount: number
   }> => ipcRenderer.invoke('pty:getRendererDeliveryDebugSnapshot'),
   resetRendererDeliveryDebug: (): Promise<void> =>
     ipcRenderer.invoke('pty:resetRendererDeliveryDebug'),
   /** True if the PTY's shell has child processes (a running command); false at an idle prompt. */
   hasChildProcesses: (id: string): Promise<boolean> =>
     ipcRenderer.invoke('pty:hasChildProcesses', { id }),
   /** Return the PTY foreground process basename when available (e.g. "codex"). */
   getForegroundProcess: (id: string): Promise<string | null> =>
     ipcRenderer.invoke('pty:getForegroundProcess', { id }),
   inspectProcess: (
     id: string
   ): Promise<{
     foregroundProcess: string | null
     hasChildProcesses: boolean
     unavailable?: true
   }> => ipcRenderer.invoke('pty:inspectProcess', { id }),
   confirmForegroundProcess: (id: string): Promise<string | null> =>
     ipcRenderer.invoke('pty:confirmForegroundProcess', { id }),
   /** Resolve a PTY's live cwd via `/proc` (Linux) or `lsof` (macOS); `''` when unknown or unresolvable. */
   getCwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:getCwd', { id }),
   /** The PTY's last APPLIED size (real winsize), or null if unknown — lets the renderer detect drift after a dropped resize and re-assert. */
   getSize: (id: string): Promise<{ cols: number; rows: number } | null> =>
     ipcRenderer.invoke('pty:getSize', { id }),
   onData: (
     callback: (data: {
       id: string
       data: string
       seq?: number
       rawLength?: number
       transformed?: boolean
       background?: boolean
       droppedOutput?: boolean
     }) => void
   ): (() => void) => {
     const listener = (
       _event: Electron.IpcRendererEvent,
       data: {
         id: string
         data: string
         seq?: number
         rawLength?: number
         transformed?: boolean
         background?: boolean
         droppedOutput?: boolean
       }
     ) => callback(data)
     ipcRenderer.on('pty:data', listener)
     return () => ipcRenderer.removeListener('pty:data', listener)
   },
   onReplay: (callback: (data: { id: string; data: string }) => void): (() => void) => {
     const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
       callback(data)
     ipcRenderer.on('pty:replay', listener)
     return () => ipcRenderer.removeListener('pty:replay', listener)
   },
   /** Out-of-band signal that main dropped renderer-bound bytes (hidden-gate / pending cap); pane restores from the model snapshot.
    *  NOT on pty:data — an in-band marker is ambiguous with chunks fully stripped by OSC-9999 cleaning. */
   onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void): (() => void) => {
     const listener = (_event: Electron.IpcRendererEvent, event: PtyModelRestoreNeededEvent) =>
       callback(event)
     ipcRenderer.on('pty:modelRestoreNeeded', listener)
     return () => ipcRenderer.removeListener('pty:modelRestoreNeeded', listener)
   },
   /** Batched side-effect facts (title/bell/agent transitions) for local-main PTYs.
    *  Per-PTY in-order; deliberately NOT synced with pty:data (terminal-side-effect-authority.md). */
   onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void): (() => void) => {
     const listener = (_event: Electron.IpcRendererEvent, batch: TerminalSideEffectBatch) =>
       callback(batch)
     ipcRenderer.on('pty:sideEffect', listener)
     return () => ipcRenderer.removeListener('pty:sideEffect', listener)
   },
   /** Title-only replay snapshot on (re)attach — attention facts (bells/completions) never replay. */
   getSideEffectSnapshot: (id: string): Promise<TerminalSideEffectBatch | null> =>
     ipcRenderer.invoke('pty:sideEffectSnapshot', { id }),
   onExit: (
     callback: (data: {
       id: string
       code: number
       preserveRendererBinding?: boolean
       /** Which lifetime of `id` died; absent when the execution host predates the field. */
       incarnationId?: string
     }) => void
   ): (() => void) => {
     const listener = (
       _event: Electron.IpcRendererEvent,
       data: {
         id: string
         code: number
         preserveRendererBinding?: boolean
         incarnationId?: string
       }
     ) => callback(data)
     ipcRenderer.on('pty:exit', listener)
     return () => ipcRenderer.removeListener('pty:exit', listener)
   },
   onSpawned: (callback: (data: { id: string }) => void): (() => void) => {
     const listener = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data)
     ipcRenderer.on('pty:spawned', listener)
     return () => ipcRenderer.removeListener('pty:spawned', listener)
   },
   onSerializeBufferRequest: (
     callback: (data: {
       requestId: string
       ptyId: string
       opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
     }) => void
   ): (() => void) => {
     const listener = (
       _event: Electron.IpcRendererEvent,
       data: {
         requestId: string
         ptyId: string
         opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
       }
     ) => callback(data)
     ipcRenderer.on('pty:serializeBuffer:request', listener)
     return () => ipcRenderer.removeListener('pty:serializeBuffer:request', listener)
   },
   onClearBufferRequest: (callback: (data: { ptyId: string }) => void): (() => void) => {
     const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) =>
       callback(data)
     ipcRenderer.on('pty:clearBuffer:request', listener)
     return () => ipcRenderer.removeListener('pty:clearBuffer:request', listener)
   },
   sendSerializedBuffer: (
     requestId: string,
     snapshot: {
       data: string
       cols: number
       rows: number
       seq?: number
       lastTitle?: string
       kittyKeyboardFlags?: number
     } | null
   ): void => {
     ipcRenderer.send('pty:serializeBuffer:response', { requestId, snapshot })
   },
   // Claim serializer ownership before spawn; echo the generation token on settle/clear to prevent pane-key reuse races.
   declarePendingPaneSerializer: (paneKey: string): Promise<number> =>
     ipcRenderer.invoke('pty:declarePendingPaneSerializer', { paneKey }),
   settlePaneSerializer: (paneKey: string, gen: number): Promise<void> =>
     ipcRenderer.invoke('pty:settlePaneSerializer', { paneKey, gen }),
   clearPendingPaneSerializer: (paneKey: string, gen: number): Promise<void> =>
     ipcRenderer.invoke('pty:clearPendingPaneSerializer', { paneKey, gen }),
   reportRendererSerializerReady: (ptyId: string): Promise<void> =>
     ipcRenderer.invoke('pty:reportRendererSerializerReady', { ptyId }),
   management: {
     listSessions: () => ipcRenderer.invoke('pty:management:listSessions'),
     killAll: () => ipcRenderer.invoke('pty:management:killAll'),
     killOne: (args: { sessionId: string }) => ipcRenderer.invoke('pty:management:killOne', args),
     restart: () => ipcRenderer.invoke('pty:management:restart'),
     macTccAttribution: () => ipcRenderer.invoke('pty:management:macTccAttribution')
   }
 },

  export: {
    htmlToPdf: (args: {
      html: string
      title: string
    }): Promise<
      { success: true; filePath: string } | { success: false; cancelled?: boolean; error?: string }
    > => ipcRenderer.invoke('export:html-to-pdf', args)
  },

  gh: {
    ...ghBridge,
    ...ghProjectsBridge
  },

  hostedReview: {
    forBranch: (args: HostedReviewForBranchArgs) =>
      ipcRenderer.invoke('hostedReview:forBranch', args),
    getCreationEligibility: (args) =>
      ipcRenderer.invoke('hostedReview:getCreationEligibility', args),
    create: (args) => ipcRenderer.invoke('hostedReview:create', args),
    createStacked: (args) => ipcRenderer.invoke('hostedReview:createStacked', args)
  },

  // Why: GitLab bindings live in `./gitlab` so `gl.*` changes don't conflict on every upstream sync of this central file.
  gl: glApi,

  bitbucket: {
    connect: (args: {
      authMode: 'token' | 'basic'
      accessToken?: string | null
      email?: string | null
      apiToken?: string | null
      baseUrl?: string | null
    }): Promise<{ ok: true; account: string | null } | { ok: false; error: string }> =>
      ipcRenderer.invoke('bitbucket:connect', args),

    disconnect: (): Promise<void> => ipcRenderer.invoke('bitbucket:disconnect'),

    status: () => ipcRenderer.invoke('bitbucket:status')
  },

  linear: {
    connect: (args: { apiKey: string }) => ipcRenderer.invoke('linear:connect', args),

    disconnect: (args?: { workspaceId?: string }): Promise<void> =>
      ipcRenderer.invoke('linear:disconnect', args),

    selectWorkspace: (args: { workspaceId: string }) =>
      ipcRenderer.invoke('linear:selectWorkspace', args),

    status: () => ipcRenderer.invoke('linear:status'),

    testConnection: (args?: { workspaceId?: string }) =>
      ipcRenderer.invoke('linear:testConnection', args),

    searchIssues: (args: { query: string; limit?: number; workspaceId?: string }) =>
      ipcRenderer.invoke('linear:searchIssues', args),

    listIssues: (args?: {
      filter?: 'assigned' | 'created' | 'all' | 'completed'
      limit?: number
      workspaceId?: string
      attributeFilter?: unknown
    }) => ipcRenderer.invoke('linear:listIssues', args),

    createIssue: (args: {
      teamId: string
      title: string
      description?: string
      workspaceId?: string
      parentIssueId?: string
      projectId?: string | null
      stateId?: string
      priority?: number
      assigneeId?: string | null
      labelIds?: string[]
    }): Promise<
      | { ok: true; id: string; identifier: string; title: string; url: string }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('linear:createIssue', args),

    getIssue: (args: { id: string; workspaceId?: string }) =>
      ipcRenderer.invoke('linear:getIssue', args),

    updateIssue: (args: {
      id: string
      updates: unknown
      workspaceId?: string
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:updateIssue', args),

    addIssueComment: (args: {
      issueId: string
      body: string
      workspaceId?: string
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:addIssueComment', args),

    issueComments: (args: { issueId: string; workspaceId?: string }) =>
      ipcRenderer.invoke('linear:issueComments', args),

    listTeams: (args?: { workspaceId?: string }) => ipcRenderer.invoke('linear:listTeams', args),

    listProjects: (args?: {
      query?: string
      limit?: number
      workspaceId?: string
      force?: boolean
    }) => ipcRenderer.invoke('linear:listProjects', args),

    createProject: (args: {
      name: string
      description?: string
      content?: string
      teamIds: string[]
      workspaceId?: string
      leadId?: string | null
      memberIds?: string[]
      labelIds?: string[]
      priority?: number
      startDate?: string
      targetDate?: string
    }): Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }> =>
      ipcRenderer.invoke('linear:createProject', args),

    getProject: (args: { id: string; workspaceId: string; force?: boolean }) =>
      ipcRenderer.invoke('linear:getProject', args),

    listProjectIssues: (args: {
      projectId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }) => ipcRenderer.invoke('linear:listProjectIssues', args),

    listCustomViews: (args: {
      model: string
      limit?: number
      workspaceId?: string
      force?: boolean
    }) => ipcRenderer.invoke('linear:listCustomViews', args),

    getCustomView: (args: {
      viewId: string
      model: string
      workspaceId: string
      force?: boolean
    }) => ipcRenderer.invoke('linear:getCustomView', args),

    listCustomViewIssues: (args: {
      viewId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }) => ipcRenderer.invoke('linear:listCustomViewIssues', args),

    listCustomViewProjects: (args: {
      viewId: string
      limit?: number
      workspaceId: string
      force?: boolean
    }) => ipcRenderer.invoke('linear:listCustomViewProjects', args),

    teamStates: (args: { teamId: string; workspaceId?: string }) =>
      ipcRenderer.invoke('linear:teamStates', args),

    teamLabels: (args: { teamId: string; workspaceId?: string }) =>
      ipcRenderer.invoke('linear:teamLabels', args),

    teamMembers: (args: { teamId: string; workspaceId?: string }) =>
      ipcRenderer.invoke('linear:teamMembers', args)
  },

  jira: {
    connect: (args: {
      siteUrl: string
      email: string
      apiToken: string
      authType?: 'cloud' | 'server'
    }) => ipcRenderer.invoke('jira:connect', args),

    disconnect: (args?: { siteId?: string }): Promise<void> =>
      ipcRenderer.invoke('jira:disconnect', args),

    selectSite: (args: { siteId: string }) => ipcRenderer.invoke('jira:selectSite', args),

    status: () => ipcRenderer.invoke('jira:status'),

    readStatus: () => ipcRenderer.invoke('jira:readStatus'),

    testConnection: (args?: { siteId?: string }) => ipcRenderer.invoke('jira:testConnection', args),

    searchIssues: (args: { jql: string; limit?: number; siteId?: string; requestId?: string }) =>
      ipcRenderer.invoke('jira:searchIssues', args),
    cancelSearchIssues: (args: { requestId: string }): Promise<void> =>
      ipcRenderer.invoke('jira:cancelSearchIssues', args),

    listIssues: (args?: {
      filter?: 'assigned' | 'reported' | 'all' | 'done'
      limit?: number
      siteId?: string
    }) => ipcRenderer.invoke('jira:listIssues', args),

    getIssue: (args: { key: string; siteId?: string }) => ipcRenderer.invoke('jira:getIssue', args),

    lookupIssueSummary: (args: { key: string; siteId: string; requestId?: string }) =>
      ipcRenderer.invoke('jira:lookupIssueSummary', args),
    cancelIssueSummary: (args: { requestId: string }): Promise<void> =>
      ipcRenderer.invoke('jira:cancelIssueSummary', args),

    createIssue: (args: {
      siteId?: string
      projectId: string
      issueTypeId: string
      title: string
      description?: string
      customFields?: Record<string, unknown>
    }): Promise<
      { ok: true; id: string; key: string; url: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('jira:createIssue', args),

    updateIssue: (args: {
      key: string
      updates: unknown
      siteId?: string
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('jira:updateIssue', args),

    addIssueComment: (args: {
      key: string
      body: string
      siteId?: string
    }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('jira:addIssueComment', args),

    issueComments: (args: { key: string; siteId?: string }) =>
      ipcRenderer.invoke('jira:issueComments', args),

    listProjects: (args?: { siteId?: string }) => ipcRenderer.invoke('jira:listProjects', args),

    listIssueTypes: (args: { projectIdOrKey: string; siteId?: string }) =>
      ipcRenderer.invoke('jira:listIssueTypes', args),

    listCreateFields: (args: { projectIdOrKey: string; issueTypeId: string; siteId?: string }) =>
      ipcRenderer.invoke('jira:listCreateFields', args),

    listPriorities: (args?: { siteId?: string }) => ipcRenderer.invoke('jira:listPriorities', args),

    listAssignableUsers: (args: { key: string; query?: string; siteId?: string }) =>
      ipcRenderer.invoke('jira:listAssignableUsers', args),

    listTransitions: (args: { key: string; siteId?: string }) =>
      ipcRenderer.invoke('jira:listTransitions', args),
    getProjectStatusOrder: (args: {
      projectKey: string
      siteId?: string
    }): Promise<JiraProjectStatusOrder> => ipcRenderer.invoke('jira:getProjectStatusOrder', args)
  },


  // Why: main validates telemetry; renderer call sites use typed wrappers.

  agentAwake: {
    getStatus: (): Promise<ComputerAwakeStatus> => ipcRenderer.invoke('agentAwake:getStatus'),
    onChanged: (callback: (status: ComputerAwakeStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ComputerAwakeStatus): void =>
        callback(status)
      ipcRenderer.on('agentAwake:changed', listener)
      return () => ipcRenderer.removeListener('agentAwake:changed', listener)
    }
  } satisfies PreloadApi['agentAwake'],

  localhostWorktreeLabels: {
    register: (args: LocalhostWorktreeLabelRoute): Promise<LocalhostWorktreeLabelResult> =>
      ipcRenderer.invoke('localhostWorktreeLabels:register', args)
  } satisfies PreloadApi['localhostWorktreeLabels'],


  codexAccounts: {
    list: () => ipcRenderer.invoke('codexAccounts:list'),
    add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }) =>
      ipcRenderer.invoke('codexAccounts:add', args),
    reauthenticate: (args: { accountId: string; activateIfSelectionWasEmpty?: boolean }) =>
      ipcRenderer.invoke('codexAccounts:reauthenticate', args),
    remove: (args: { accountId: string }) => ipcRenderer.invoke('codexAccounts:remove', args),
    select: (args: {
      accountId: string | null
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }) => ipcRenderer.invoke('codexAccounts:select', args),
    listStalePanes: (args: {
      ptyIds: string[]
    }): Promise<
      {
        ptyId: string
        launchAccountId: string | null
        activeAccountId: string | null
        reason?: 'account-change' | 'home-route-change'
      }[]
    > => ipcRenderer.invoke('codexAccounts:listStalePanes', args),
    listRecordedPaneLanes: (args: { ptyIds: string[] }): Promise<Record<string, string>> =>
      ipcRenderer.invoke('codexAccounts:listRecordedPaneLanes', args),
    forgetStalePanes: (args: { ptyIds: string[] }): Promise<void> =>
      ipcRenderer.invoke('codexAccounts:forgetStalePanes', args)
  },

  claudeAccounts: {
    list: () => ipcRenderer.invoke('claudeAccounts:list'),
    add: (args?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }) =>
      ipcRenderer.invoke('claudeAccounts:add', args),
    cancelPendingLogin: (): Promise<boolean> =>
      ipcRenderer.invoke('claudeAccounts:cancelPendingLogin'),
    reauthenticate: (args: { accountId: string }) =>
      ipcRenderer.invoke('claudeAccounts:reauthenticate', args),
    remove: (args: { accountId: string }) => ipcRenderer.invoke('claudeAccounts:remove', args),
    select: (args: {
      accountId: string | null
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
    }) => ipcRenderer.invoke('claudeAccounts:select', args)
  },

  cli: {
    getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
    install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
    remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove'),
    getWslInstallStatus: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
      ipcRenderer.invoke('cli:getWslInstallStatus', args),
    installWsl: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
      ipcRenderer.invoke('cli:installWsl', args),
    removeWsl: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
      ipcRenderer.invoke('cli:removeWsl', args)
  },

  codexConfigSync: {
    status: (): Promise<CodexConfigSyncStatus> => ipcRenderer.invoke('codexConfigSync:status')
  },
  agentHooks: {
    claudeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:claudeStatus'),
    openClaudeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:openClaudeStatus'),
    codexStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:codexStatus'),
    geminiStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:geminiStatus'),
    antigravityStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:antigravityStatus'),
    ampStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:ampStatus'),
    cursorStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:cursorStatus'),
    droidStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:droidStatus'),
    commandCodeStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:commandCodeStatus'),
    grokStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:grokStatus'),
    devinStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:devinStatus'),
    copilotStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:copilotStatus'),
    hermesStatus: (): Promise<AgentHookInstallStatus> =>
      ipcRenderer.invoke('agentHooks:hermesStatus'),
    kimiStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:kimiStatus')
  },

  agentTrust: {
    markTrusted: (args: {
      preset: 'cursor' | 'copilot' | 'codex'
      workspacePath: string
      connectionId?: string
    }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
  },

  preflight: {
    check: (args?: {
      force?: boolean
    }): Promise<{
      git: { installed: boolean }
      gh: { installed: boolean; authenticated: boolean }
      glab?: { installed: boolean; authenticated: boolean }
      bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
      azureDevOps?: {
        configured: boolean
        authenticated: boolean
        account: string | null
        baseUrl: string | null
        tokenConfigured: boolean
      }
      gitea?: {
        configured: boolean
        authenticated: boolean
        account: string | null
        baseUrl: string | null
        tokenConfigured: boolean
      }
      linear: { connected: boolean }
    }> => ipcRenderer.invoke('preflight:check', args),
    detectAgents: (args?: PreflightRuntimeContext): Promise<string[]> =>
      ipcRenderer.invoke('preflight:detectAgents', args),
    refreshAgents: (args?: PreflightRuntimeContext): Promise<RefreshAgentsResult> =>
      ipcRenderer.invoke('preflight:refreshAgents', args),
    detectRemoteAgents: (args: { connectionId: string }): Promise<string[]> =>
      ipcRenderer.invoke('preflight:detectRemoteAgents', args),
    detectRemoteWindowsTerminalCapabilities: (args: {
      connectionId: string
    }): Promise<{
      wslAvailable: boolean
      wslDistros: string[]
      pwshAvailable: boolean
      gitBashAvailable: boolean
      hostPlatform: NodeJS.Platform | null
    }> => ipcRenderer.invoke('preflight:detectRemoteWindowsTerminalCapabilities', args)
  },

  notifications: {
    dispatch: (args: Record<string, unknown>): Promise<NotificationDispatchResult> =>
      ipcRenderer.invoke('notifications:dispatch', args),
    dismiss: (ids: string[]): Promise<NotificationDismissResult> =>
      ipcRenderer.invoke('notifications:dismiss', ids),
    openSystemSettings: (): Promise<void> => ipcRenderer.invoke('notifications:openSystemSettings'),
    getPermissionStatus: (): Promise<NotificationPermissionStatusResult> =>
      ipcRenderer.invoke('notifications:getPermissionStatus'),
    probeDelivery: (args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> =>
      ipcRenderer.invoke('notifications:probeDelivery', args),
    playSound: async (options?: {
      force?: boolean
      volume?: number
    }): Promise<NotificationSoundResult> => {
      try {
        // Why: drop replays while still ringing; the test button passes force to always confirm.
        if (!options?.force && isNotificationSoundPlaying) {
          return { played: false, reason: 'deduped' }
        }

        const resolved = (await ipcRenderer.invoke(
          'notifications:resolveSoundPath'
        )) as NotificationSoundPathResult
        if (!resolved.ok) {
          if (cachedNotificationSound) {
            disposeCachedNotificationSound()
          }
          return { played: false, reason: resolved.reason }
        }

        let entry = cachedNotificationSound
        if (!entry || entry.path !== resolved.path) {
          const sound = (await ipcRenderer.invoke(
            'notifications:loadSound'
          )) as NotificationSoundDataResult
          if (!sound.ok) {
            disposeCachedNotificationSound()
            return { played: false, reason: sound.reason }
          }
          const arrayBuffer = new ArrayBuffer(sound.data.byteLength)
          new Uint8Array(arrayBuffer).set(sound.data)
          const blob = new Blob([arrayBuffer], { type: sound.mimeType })
          disposeCachedNotificationSound()
          const blobUrl = URL.createObjectURL(blob)
          entry = { path: sound.path, blobUrl, audio: new Audio(blobUrl) }
          cachedNotificationSound = entry
        }

        const audio = entry.audio
        // Why: restart from zero on each play so bursts replay instead of stacking copies (GNOME canberra / VS Code signal service).
        audio.currentTime = 0
        if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
          audio.volume = Math.min(1, Math.max(0, options.volume / 100))
        }
        isNotificationSoundPlaying = true
        cleanupNotificationSoundPlayback?.()
        const release = (): void => {
          cleanup()
          if (cleanupNotificationSoundPlayback === cleanup) {
            cleanupNotificationSoundPlayback = null
          }
          isNotificationSoundPlaying = false
        }
        const cleanup = (): void => {
          audio.removeEventListener('ended', release)
          audio.removeEventListener('error', release)
        }
        cleanupNotificationSoundPlayback = cleanup
        audio.addEventListener('ended', release)
        audio.addEventListener('error', release)
        try {
          await audio.play()
        } catch {
          release()
          return { played: false, reason: 'playback-failed' }
        }
        return { played: true }
      } catch {
        clearNotificationSoundPlaybackState()
        return { played: false, reason: 'playback-failed' }
      }
    }
  },

  onboarding: {
    get: (): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:get'),
    update: (
      updates: Partial<Omit<OnboardingState, 'checklist'>> & {
        checklist?: Partial<OnboardingState['checklist']>
      }
    ): Promise<OnboardingState> => ipcRenderer.invoke('onboarding:update', updates)
  },

  dashboard: {
    // Open the pop-out dashboard window, or focus it if already open.
    openPopout: (view?: 'board' | 'map'): Promise<void> =>
      ipcRenderer.invoke('dashboardPopout:open', view),

    // ── Producer side (main window) ──────────────────────────────────────
    publishSnapshot: (snapshot: DashboardSnapshot): Promise<void> =>
      ipcRenderer.invoke('dashboard:publishSnapshot', snapshot),
    getPopoutOpen: (): Promise<boolean> => ipcRenderer.invoke('dashboard:getPopoutOpen'),
    onPopoutOpenChanged: (callback: (open: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
      ipcRenderer.on('dashboard:popoutOpenChanged', listener)
      return () => ipcRenderer.removeListener('dashboard:popoutOpenChanged', listener)
    },
    onSnapshotRequested: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('dashboard:snapshotRequested', listener)
      return () => ipcRenderer.removeListener('dashboard:snapshotRequested', listener)
    },
    onRevealAgent: (callback: (args: DashboardRevealAgentArgs) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, args: DashboardRevealAgentArgs): void =>
        callback(args)
      ipcRenderer.on('ui:revealDashboardAgent', listener)
      return () => ipcRenderer.removeListener('ui:revealDashboardAgent', listener)
    },
    onAckAgent: (callback: (paneKey: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, paneKey: string): void =>
        callback(paneKey)
      ipcRenderer.on('ui:ackDashboardAgent', listener)
      return () => ipcRenderer.removeListener('ui:ackDashboardAgent', listener)
    },
    onSpawnAgent: (callback: (args: DashboardSpawnAgentArgs) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, args: DashboardSpawnAgentArgs): void =>
        callback(args)
      ipcRenderer.on('ui:spawnDashboardAgent', listener)
      return () => ipcRenderer.removeListener('ui:spawnDashboardAgent', listener)
    },
    onSleepWorkspace: (callback: (args: DashboardSleepWorkspaceArgs) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        args: DashboardSleepWorkspaceArgs
      ): void => callback(args)
      ipcRenderer.on('ui:sleepDashboardWorkspace', listener)
      return () => ipcRenderer.removeListener('ui:sleepDashboardWorkspace', listener)
    },

    // ── Consumer side (pop-out window) ───────────────────────────────────
    requestSnapshot: (): Promise<void> => ipcRenderer.invoke('dashboard:requestSnapshot'),
    onSnapshot: (callback: (snapshot: DashboardSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot): void =>
        callback(snapshot)
      ipcRenderer.on('dashboard:snapshot', listener)
      return () => ipcRenderer.removeListener('dashboard:snapshot', listener)
    },
    onViewRequested: (callback: (view: 'board' | 'map') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, view: 'board' | 'map'): void =>
        callback(view)
      ipcRenderer.on('dashboard:viewRequested', listener)
      return () => ipcRenderer.removeListener('dashboard:viewRequested', listener)
    },
    revealAgent: (args: DashboardRevealAgentArgs): Promise<void> =>
      ipcRenderer.invoke('dashboardPopout:revealAgent', args),
    ackAgent: (paneKey: string): Promise<void> =>
      ipcRenderer.invoke('dashboardPopout:ackAgent', { paneKey }),
    spawnAgent: (args: DashboardSpawnAgentArgs): Promise<void> =>
      ipcRenderer.invoke('dashboardPopout:spawnAgent', args),
    sleepWorkspace: (args: DashboardSleepWorkspaceArgs): Promise<void> =>
      ipcRenderer.invoke('dashboardPopout:sleepWorkspace', args)
  },

  terminalPreview: {
    connect: (
      ptyId: string,
      opts?: { scrollbackRows?: number }
    ): Promise<TerminalPreviewConnectResult> =>
      ipcRenderer.invoke('terminalPreview:connect', { ptyId, opts }),
    input: (ptyId: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('terminalPreview:input', { ptyId, data }),
    fit: (
      ptyId: string,
      cols: number,
      rows: number
    ): Promise<{ cols: number; rows: number } | null> =>
      ipcRenderer.invoke('terminalPreview:fit', { ptyId, cols, rows }),
    ack: (ptyId: string, bytes: number): Promise<void> =>
      ipcRenderer.invoke('terminalPreview:ack', { ptyId, bytes }),
    unsubscribe: (ptyId: string): Promise<void> =>
      ipcRenderer.invoke('terminalPreview:unsubscribe', { ptyId }),
    onData: (callback: (payload: TerminalPreviewDataPayload) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalPreviewDataPayload
      ): void => callback(payload)
      ipcRenderer.on('terminalPreview:data', listener)
      return () => ipcRenderer.removeListener('terminalPreview:data', listener)
    }
  },

  macosTccPrompts: {
    onThreshold: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { promptCount: number }
      ): void => callback(payload)
      ipcRenderer.on('macosTccPrompts:threshold', listener)
      return () => ipcRenderer.removeListener('macosTccPrompts:threshold', listener)
    },
    consumePending: (): Promise<{ claimId: number; promptCount: number } | null> =>
      ipcRenderer.invoke('macosTccPrompts:consumePending'),
    acknowledgePending: (claimId: number): Promise<void> =>
      ipcRenderer.invoke('macosTccPrompts:acknowledgePending', claimId),
    releasePending: (claimId: number): Promise<void> =>
      ipcRenderer.invoke('macosTccPrompts:releasePending', claimId),
    dismiss: (): Promise<void> => ipcRenderer.invoke('macosTccPrompts:dismiss')
  },

  developerPermissions: {
    getStatus: () => ipcRenderer.invoke('developerPermissions:getStatus'),
    request: (args: { id: string }) => ipcRenderer.invoke('developerPermissions:request', args),
    openSettings: (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke('developerPermissions:openSettings', args),
    testLocalNetworkConnection: (args: { host: string; port: number }) =>
      ipcRenderer.invoke('developerPermissions:testLocalNetworkConnection', args)
  },

  computerUsePermissions: {
    getStatus: () => ipcRenderer.invoke('computerUsePermissions:getStatus'),
    openSetup: (args?: { id?: string }) =>
      ipcRenderer.invoke('computerUsePermissions:openSetup', args),
    reset: () => ipcRenderer.invoke('computerUsePermissions:reset')
  },

  shell: {
    openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

    openInFileManager: (path: string): Promise<ShellOpenLocalPathResult> =>
      ipcRenderer.invoke('shell:openInFileManager', path),

    openInExternalEditor: (
      request: ShellOpenExternalEditorRequest
    ): Promise<ShellOpenExternalEditorResult> =>
      ipcRenderer.invoke('shell:openInExternalEditor', request),

    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:openUrl', url),

    openFilePath: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('shell:openFilePath', path),

    openFileUri: (uri: string): Promise<void> => ipcRenderer.invoke('shell:openFileUri', uri),

    pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:pathExists', path),

    pickAttachment: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAttachment'),

    pickImage: (): Promise<string | null> => ipcRenderer.invoke('shell:pickImage'),

    pickRepoIconImage: (): Promise<{ dataUrl: string; fileName: string } | null> =>
      ipcRenderer.invoke('shell:pickRepoIconImage'),

    pickAudio: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAudio'),

    pickDirectory: (args: { defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('shell:pickDirectory', args),

    copyFile: (args: { srcPath: string; destPath: string }): Promise<void> =>
      ipcRenderer.invoke('shell:copyFile', args)
  },

  skills: {
    discover: (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> =>
      ipcRenderer.invoke('skills:discover', target),
    freshnessInventory: (): Promise<SkillFreshnessInventory> =>
      ipcRenderer.invoke('skills:freshnessInventory'),
    startUpdateRun: (names: string[]): Promise<SkillUpdateStartResult> =>
      ipcRenderer.invoke('skills:startUpdateRun', names),
    cancelUpdateRun: (): Promise<void> => ipcRenderer.invoke('skills:cancelUpdateRun'),
    acknowledgeUpdateRun: (): Promise<void> => ipcRenderer.invoke('skills:acknowledgeUpdateRun'),
    getUpdateRun: (): Promise<SkillUpdateRun> => ipcRenderer.invoke('skills:getUpdateRun'),
    prepareShare: (input: {
      skillIds: string[]
      bundleName: string
      target?: SkillDiscoveryTarget
      packageId?: string
    }): Promise<SkillSharePreview> => ipcRenderer.invoke('skills:prepareShare', input),
    publishShare: (input: SkillSharePublishInput): Promise<SkillSharePublishOperation> =>
      ipcRenderer.invoke('skills:publishShare', input),
    cancelShare: (preparationId: string): Promise<void> =>
      ipcRenderer.invoke('skills:cancelShare', preparationId),
    releaseShare: (preparationId: string): Promise<void> =>
      ipcRenderer.invoke('skills:releaseShare', preparationId),
    resolveShare: (shareId: string): Promise<SkillShareResolvedOperation> =>
      ipcRenderer.invoke('skills:resolveShare', shareId),
    installShare: (input: SkillShareInstallInput): Promise<SkillShareInstallOperation> =>
      ipcRenderer.invoke('skills:installShare', input),
    installBundleShare: (
      input: SkillBundleShareInstallInput
    ): Promise<SkillBundleShareInstallOperation> =>
      ipcRenderer.invoke('skills:installBundleShare', input),
    installBundlePackageVersion: (
      input: SkillBundlePackageVersionInstallInput
    ): Promise<SkillBundleShareInstallOperation> =>
      ipcRenderer.invoke('skills:installBundlePackageVersion', input),
    installPackageVersion: (
      input: SkillPackageVersionInstallInput
    ): Promise<SkillShareInstallOperation> =>
      ipcRenderer.invoke('skills:installPackageVersion', input),
    cancelInstall: (input: SkillInstallCancelInput): Promise<{ cancelled: boolean }> =>
      ipcRenderer.invoke('skills:cancelInstall', input),
    previewInstall: (input: SkillInstallPreviewInput): Promise<SkillInstallPreviewOperation> =>
      ipcRenderer.invoke('skills:previewInstall', input),
    previewBundleInstall: (
      input: SkillBundleInstallPreviewInput
    ): Promise<SkillBundleInstallPreviewOperation> =>
      ipcRenderer.invoke('skills:previewBundleInstall', input),
    removeInstall: (input: SkillRemoveInput): Promise<SkillRemoveOperation> =>
      ipcRenderer.invoke('skills:removeInstall', input),
    // Desktop always registers the delete IPC handlers in its own main process.
    deleteSupported: (): Promise<boolean> => Promise.resolve(true),
    previewDelete: (request: SkillDeleteRequest): Promise<SkillDeletePlan> =>
      ipcRenderer.invoke('skills:previewDelete', request),
    delete: (request: SkillDeleteRequest): Promise<SkillDeleteResult> =>
      ipcRenderer.invoke('skills:delete', request),
    listManagedInstalls: (environmentId?: string): Promise<ManagedSkillInstallListOperation> =>
      ipcRenderer.invoke('skills:listManagedInstalls', environmentId),
    getPackage: (packageId: string): Promise<SkillCloudOperation<SkillCloudPackageDetails>> =>
      ipcRenderer.invoke('skills:getPackage', packageId),
    listOwnedShares: (): Promise<SkillCloudOperation<SkillCloudOwnedShare[]>> =>
      ipcRenderer.invoke('skills:listOwnedShares'),
    revokeShare: (shareId: string): Promise<SkillCloudOperation<void>> =>
      ipcRenderer.invoke('skills:revokeShare', shareId),
    deletePackageVersion: (input: {
      packageId: string
      versionId: string
    }): Promise<SkillCloudOperation<void>> =>
      ipcRenderer.invoke('skills:deletePackageVersion', input),
    deletePackage: (packageId: string): Promise<SkillCloudOperation<void>> =>
      ipcRenderer.invoke('skills:deletePackage', packageId),
    listWslDistros: (environmentId?: string): Promise<string[]> =>
      ipcRenderer.invoke('skills:listWslDistros', environmentId),
    onInstallProgress: (callback: (progress: SkillInstallProgress) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: SkillInstallProgress): void =>
        callback(progress)
      ipcRenderer.on('skills:installProgress', listener)
      return () => ipcRenderer.removeListener('skills:installProgress', listener)
    },
    onShareProgress: (callback: (progress: SkillShareProgress) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: SkillShareProgress): void =>
        callback(progress)
      ipcRenderer.on('skills:shareProgress', listener)
      return () => ipcRenderer.removeListener('skills:shareProgress', listener)
    },
    onUpdateRun: (callback: (run: SkillUpdateRun) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, run: SkillUpdateRun): void =>
        callback(run)
      ipcRenderer.on('skills:updateRun', listener)
      return () => ipcRenderer.removeListener('skills:updateRun', listener)
    }
  },


  browser: {
    onClientPageRendererRequest: browserClientPageRendererRequests.subscribe,
    readClientHostId: (): string | null => readBrowserClientHostIdArgument(process.argv),
    registerGuest: (args: {
      browserPageId: string
      workspaceId: string
      worktreeId: string
      sessionProfileId?: string | null
      webContentsId: number
    }): Promise<boolean> => ipcRenderer.invoke('browser:registerGuest', args),

    isGuestRegistered: (args: { browserPageId: string; webContentsId: number }): Promise<boolean> =>
      ipcRenderer.invoke('browser:isGuestRegistered', args),

    repairGuestRegistration: (args: {
      browserPageId: string
      workspaceId: string
      worktreeId: string
      sessionProfileId?: string | null
      webContentsId: number
    }): Promise<boolean> => ipcRenderer.invoke('browser:repairGuestRegistration', args),

    unregisterGuest: (args: { browserPageId: string }): Promise<void> =>
      ipcRenderer.invoke('browser:unregisterGuest', args),

    onWebAuthnAccountRequest: (
      callback: (request: BrowserWebAuthnAccountRequest) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        request: BrowserWebAuthnAccountRequest
      ): void => callback(request)
      ipcRenderer.on('browser:webauthn-account-requested', listener)
      return () => ipcRenderer.removeListener('browser:webauthn-account-requested', listener)
    },

    onWebAuthnAccountRequestClosed: (
      callback: (event: { requestId: string }) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }): void =>
        callback(data)
      ipcRenderer.on('browser:webauthn-account-request-closed', listener)
      return () => ipcRenderer.removeListener('browser:webauthn-account-request-closed', listener)
    },

    respondWebAuthnAccount: (response: BrowserWebAuthnAccountResponse): Promise<boolean> =>
      ipcRenderer.invoke('browser:respondWebAuthnAccount', response),

    openDevTools: (args: { browserPageId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:openDevTools', args),

    setViewportOverride: (args: {
      browserPageId: string
      override: BrowserViewportOverride | null
    }): Promise<boolean> => ipcRenderer.invoke('browser:setViewportOverride', args),

    setAnnotationViewportBridge: (args): Promise<boolean> =>
      ipcRenderer.invoke('browser:setAnnotationViewportBridge', args),

    publishClientPageMetadata: (args) =>
      ipcRenderer.invoke('browser:publishClientPageMetadata', args),

    onGuestLoadFailed: (
      callback: (args: {
        browserPageId: string
        loadError: { code: number; description: string; validatedUrl: string }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          loadError: { code: number; description: string; validatedUrl: string }
        }
      ) => callback(data)
      ipcRenderer.on('browser:guest-load-failed', listener)
      return () => ipcRenderer.removeListener('browser:guest-load-failed', listener)
    },

    onCertificateFailureChanged: (callback): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: Parameters<typeof callback>[0]
      ): void => callback(data)
      ipcRenderer.on('browser:certificate-failure-changed', listener)
      return () => ipcRenderer.removeListener('browser:certificate-failure-changed', listener)
    },

    proceedCertificate: (args) => ipcRenderer.invoke('browser:proceedCertificate', args),

    onPermissionDenied: (
      callback: (event: { browserPageId: string; permission: string; origin: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; permission: string; origin: string }
      ) => callback(data)
      ipcRenderer.on('browser:permission-denied', listener)
      return () => ipcRenderer.removeListener('browser:permission-denied', listener)
    },

    onPopup: (
      callback: (event: {
        browserPageId: string
        origin: string
        action: 'opened-in-orca' | 'opened-external' | 'blocked'
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          origin: string
          action: 'opened-in-orca' | 'opened-external' | 'blocked'
        }
      ) => callback(data)
      ipcRenderer.on('browser:popup', listener)
      return () => ipcRenderer.removeListener('browser:popup', listener)
    },

    onDownloadRequested: (
      callback: (event: {
        browserPageId: string
        downloadId: string
        origin: string
        filename: string
        totalBytes: number | null
        mimeType: string | null
        savePath: string
        status: 'downloading'
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          downloadId: string
          origin: string
          filename: string
          totalBytes: number | null
          mimeType: string | null
          savePath: string
          status: 'downloading'
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-requested', listener)
      return () => ipcRenderer.removeListener('browser:download-requested', listener)
    },

    onDownloadProgress: (
      callback: (event: {
        browserPageId?: string
        downloadId: string
        receivedBytes: number
        totalBytes: number | null
        state: 'progressing' | 'interrupted' | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId?: string
          downloadId: string
          receivedBytes: number
          totalBytes: number | null
          state: 'progressing' | 'interrupted' | null
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-progress', listener)
      return () => ipcRenderer.removeListener('browser:download-progress', listener)
    },

    onDownloadFinished: (
      callback: (event: {
        browserPageId?: string
        downloadId: string
        status: 'completed' | 'canceled' | 'failed'
        savePath: string | null
        remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
        error: string | null
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId?: string
          downloadId: string
          status: 'completed' | 'canceled' | 'failed'
          savePath: string | null
          remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
          error: string | null
        }
      ) => callback(data)
      ipcRenderer.on('browser:download-finished', listener)
      return () => ipcRenderer.removeListener('browser:download-finished', listener)
    },

    onContextMenuRequested: (
      callback: (event: {
        browserPageId: string
        x: number
        y: number
        screenX: number
        screenY: number
        pageUrl: string
        linkUrl: string | null
        selectionText: string
        canGoBack: boolean
        canGoForward: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          x: number
          y: number
          screenX: number
          screenY: number
          pageUrl: string
          linkUrl: string | null
          selectionText: string
          canGoBack: boolean
          canGoForward: boolean
        }
      ) => callback(data)
      ipcRenderer.on('browser:context-menu-requested', listener)
      return () => ipcRenderer.removeListener('browser:context-menu-requested', listener)
    },

    onContextMenuDismissed: (
      callback: (event: { browserPageId: string }) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { browserPageId: string }) =>
        callback(data)
      ipcRenderer.on('browser:context-menu-dismissed', listener)
      return () => ipcRenderer.removeListener('browser:context-menu-dismissed', listener)
    },

    onNavigationUpdate: (
      callback: (event: { browserPageId: string; url: string; title: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; url: string; title: string }
      ) => callback(data)
      ipcRenderer.on('browser:navigation-update', listener)
      return () => ipcRenderer.removeListener('browser:navigation-update', listener)
    },

    onActivateView: (
      callback: (data: { worktreeId?: string; browserPageId?: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { worktreeId?: string; browserPageId?: string }
      ) => callback(data)
      ipcRenderer.on('browser:activateView', listener)
      return () => ipcRenderer.removeListener('browser:activateView', listener)
    },

    onPaneFocus: (
      callback: (data: { worktreeId: string | null; browserPageId: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { worktreeId: string | null; browserPageId: string }
      ) => callback(data)
      ipcRenderer.on('browser:pane-focus', listener)
      return () => ipcRenderer.removeListener('browser:pane-focus', listener)
    },

    onOpenLinkInOrcaTab: (
      callback: (event: { browserPageId: string; url: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; url: string }
      ) => callback(data)
      ipcRenderer.on('browser:open-link-in-orca-tab', listener)
      return () => ipcRenderer.removeListener('browser:open-link-in-orca-tab', listener)
    },

    cancelDownload: (args: { downloadId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:cancelDownload', args),

    setGrabMode: (args: BrowserSetGrabModeArgs) => ipcRenderer.invoke('browser:setGrabMode', args),

    awaitGrabSelection: (args: { browserPageId: string; opId: string }) =>
      ipcRenderer.invoke('browser:awaitGrabSelection', args),

    cancelGrab: (args: { browserPageId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:cancelGrab', args),

    captureSelectionScreenshot: (args: BrowserCaptureSelectionScreenshotArgs) =>
      ipcRenderer.invoke('browser:captureSelectionScreenshot', args),

    extractHoverPayload: (args: BrowserExtractHoverArgs) =>
      ipcRenderer.invoke('browser:extractHoverPayload', args),

    onGrabModeToggle: (callback: (browserPageId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, browserPageId: string) =>
        callback(browserPageId)
      ipcRenderer.on('browser:grabModeToggle', listener)
      return () => ipcRenderer.removeListener('browser:grabModeToggle', listener)
    },

    onGrabActionShortcut: (
      callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { browserPageId: string; key: 'c' | 's' }
      ) => callback(data)
      ipcRenderer.on('browser:grabActionShortcut', listener)
      return () => ipcRenderer.removeListener('browser:grabActionShortcut', listener)
    },

    sessionListProfiles: () => ipcRenderer.invoke('browser:session:listProfiles'),

    prepareSshWorkspacePartition: (args: {
      targetId: string
      browserProfileId?: string
      skipProbe?: boolean
    }): Promise<{ partition: string }> =>
      ipcRenderer.invoke('browser:prepareSshWorkspacePartition', args),

    sessionCreateProfile: (args: {
      scope: 'default' | 'isolated' | 'imported'
      label: string
      userAgentMode?: 'clean' | 'native'
    }) => ipcRenderer.invoke('browser:session:createProfile', args),

    sessionDeleteProfile: (args: { profileId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:session:deleteProfile', args),

    sessionImportCookies: (args: { profileId: string }) =>
      ipcRenderer.invoke('browser:session:importCookies', args),

    sessionResolvePartition: (args: { profileId: string | null }): Promise<string | null> =>
      ipcRenderer.invoke('browser:session:resolvePartition', args),

    sessionDetectBrowsers: () => ipcRenderer.invoke('browser:session:detectBrowsers'),

    sessionDetectBrowsersForClientHost: (args: { environmentId: string }) =>
      ipcRenderer.invoke('browser:session:detectBrowsersForClientHost', args),

    sessionImportFromBrowser: (args: { profileId: string; browserFamily: string }) =>
      ipcRenderer.invoke('browser:session:importFromBrowser', args),

    sessionImportFromBrowserForClientHost: (args: {
      environmentId: string
      profileId: string
      browserFamily: string
      browserProfile?: string
    }) => ipcRenderer.invoke('browser:session:importFromBrowserForClientHost', args),

    sessionClientRouteImportSources: (args: { environmentId: string }) =>
      ipcRenderer.invoke('browser:session:clientRouteImportSources', args),

    sessionClearDefaultCookies: (): Promise<boolean> =>
      ipcRenderer.invoke('browser:session:clearDefaultCookies'),

    notifyActiveTabChanged: (args: { browserPageId: string }): Promise<boolean> =>
      ipcRenderer.invoke('browser:activeTabChanged', args)
  },

  emulator: {
    startFrameStream: (args: {
      streamUrl: string
      streamKey?: string
    }): Promise<{
      streamId: string
    }> => ipcRenderer.invoke('emulator:frameStreamStart', args),
    stopFrameStream: (args: { streamId: string }): Promise<void> =>
      ipcRenderer.invoke('emulator:frameStreamStop', args),
    onFrameStreamFrame: (
      callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { streamId: string; bytes: ArrayBuffer }
      ) => callback(data)
      ipcRenderer.on('emulator:frameStreamFrame', listener)
      return () => ipcRenderer.removeListener('emulator:frameStreamFrame', listener)
    },
    onFrameStreamError: (
      callback: (data: { streamId: string; message: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { streamId: string; message: string }
      ) => callback(data)
      ipcRenderer.on('emulator:frameStreamError', listener)
      return () => ipcRenderer.removeListener('emulator:frameStreamError', listener)
    },
    startVideoStream: (args: {
      deviceId: string
      streamId: string
    }): Promise<{ streamId: string }> => ipcRenderer.invoke('emulator:videoStreamStart', args),
    stopVideoStream: (args: { streamId: string }): Promise<void> =>
      ipcRenderer.invoke('emulator:videoStreamStop', args),
    onVideoStreamMeta: (
      callback: (data: {
        streamId: string
        deviceId: string
        meta: { codecId: string; width: number; height: number }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          streamId: string
          deviceId: string
          meta: { codecId: string; width: number; height: number }
        }
      ) => callback(data)
      ipcRenderer.on('emulator:videoStreamMeta', listener)
      return () => ipcRenderer.removeListener('emulator:videoStreamMeta', listener)
    },
    onVideoStreamFrame: (
      callback: (data: {
        streamId: string
        deviceId: string
        config: boolean
        keyFrame: boolean
        bytes: ArrayBuffer
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          streamId: string
          deviceId: string
          config: boolean
          keyFrame: boolean
          bytes: ArrayBuffer
        }
      ) => callback(data)
      ipcRenderer.on('emulator:videoStreamFrame', listener)
      return () => ipcRenderer.removeListener('emulator:videoStreamFrame', listener)
    },
    onPaneFocus: (callback: (data: { worktreeId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
        callback(data)
      ipcRenderer.on('emulator:pane-focus', listener)
      return () => ipcRenderer.removeListener('emulator:pane-focus', listener)
    },
    onAutoAttach: (
      callback: (data: {
        worktreeId: string
        info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          worktreeId: string
          info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
        }
      ) => callback(data)
      ipcRenderer.on('ui:emulatorAutoAttach', listener)
      return () => ipcRenderer.removeListener('ui:emulatorAutoAttach', listener)
    }
  },

  hooks: {
    check: (args: { repoId: string; hostId?: ExecutionHostId }) =>
      ipcRenderer.invoke('hooks:check', args),

    inspectSetupScriptImports: (args: { repoId: string; hostId?: ExecutionHostId }) =>
      ipcRenderer.invoke('hooks:inspectSetupScriptImports', args),

    createIssueCommandRunner: (args: {
      repoId: string
      worktreePath: string
      command: string
    }): Promise<WorktreeSetupLaunch> => ipcRenderer.invoke('hooks:createIssueCommandRunner', args),

    readIssueCommand: (args: {
      repoId: string
      hostId?: ExecutionHostId
    }): Promise<{
      status?: 'ok' | 'error'
      localContent: string | null
      sharedContent: string | null
      effectiveContent: string | null
      localFilePath: string
      source: 'local' | 'shared' | 'none'
    }> => ipcRenderer.invoke('hooks:readIssueCommand', args),

    writeIssueCommand: (args: {
      repoId: string
      content: string
      hostId?: ExecutionHostId
    }): Promise<void> => ipcRenderer.invoke('hooks:writeIssueCommand', args)
  },

  cache: cacheBridge,
  session: sessionBridge,
  remoteWorkspace: remoteWorkspaceBridge,
  ephemeralVm: {
    listRecipes: (args) => ipcRenderer.invoke('ephemeralVm:listRecipes', args),
    listRecipeCatalog: () => ipcRenderer.invoke('ephemeralVm:listRecipeCatalog'),
    doctor: (args) => ipcRenderer.invoke('ephemeralVm:doctor', args),
    provision: (args) => ipcRenderer.invoke('ephemeralVm:provision', args),
    cancelProvision: (args) => ipcRenderer.invoke('ephemeralVm:cancelProvision', args),
    onProvisionEvent: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }
      ): void => callback(event)
      ipcRenderer.on('ephemeralVm:provisionEvent', listener)
      return () => ipcRenderer.removeListener('ephemeralVm:provisionEvent', listener)
    },
    listRuntimes: () => ipcRenderer.invoke('ephemeralVm:listRuntimes'),
    attachWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:attachWorkspace', args),
    suspendWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:suspendWorkspace', args),
    resumeWorkspace: (args) => ipcRenderer.invoke('ephemeralVm:resumeWorkspace', args),
    cleanup: (args) => ipcRenderer.invoke('ephemeralVm:cleanup', args),
    stopCleanup: (args) => ipcRenderer.invoke('ephemeralVm:stopCleanup', args),
    getCleanupCommand: (args) => ipcRenderer.invoke('ephemeralVm:getCleanupCommand', args)
  } satisfies PreloadApi['ephemeralVm'],





  notebook: {
    runPythonCell: (args: {
      filePath: string
      code: string
      preamble?: string
      connectionId?: string | null
    }): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> =>
      ipcRenderer.invoke('notebook:runPythonCell', args)
  },

  fs: {
    readDir: (args: {
      dirPath: string
      connectionId?: string
    }): Promise<{ name: string; isDirectory: boolean; isSymlink: boolean }[]> =>
      ipcRenderer.invoke('fs:readDir', args),
    readFile: (args: {
      filePath: string
      connectionId?: string
      includeLocalLogMetadata?: boolean
    }): Promise<{
      content: string
      isBinary: boolean
      isImage?: boolean
      mimeType?: string
      fileIdentity?: string
    }> => ipcRenderer.invoke('fs:readFile', args),
    readLocalLogTail: (args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> =>
      ipcRenderer.invoke('fs:readLocalLogTail', args),
    startLocalLogTail: (args: LocalLogTailWatchArgs): Promise<void> =>
      ipcRenderer.invoke('fs:startLocalLogTail', args),
    stopLocalLogTail: (args: { subscriptionId: string }): Promise<void> =>
      ipcRenderer.invoke('fs:stopLocalLogTail', args),
    onLocalLogTailChanged: (
      callback: (payload: LocalLogTailChangedPayload) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LocalLogTailChangedPayload
      ): void => callback(payload)
      ipcRenderer.on('fs:localLogTailChanged', listener)
      return () => ipcRenderer.removeListener('fs:localLogTailChanged', listener)
    },
    downloadFile: (args: {
      filePath: string
      connectionId: string
    }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:downloadFile', args),
    downloadFolder: (args: {
      dirPath: string
      connectionId: string
    }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:downloadFolder', args),
    saveDownloadedFile: (args: {
      suggestedName: string
      content: string
      encoding: 'utf8' | 'base64'
    }): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:saveDownloadedFile', args),
    startDownloadedFile: (args: {
      suggestedName: string
    }): Promise<
      { canceled: true } | { canceled: false; transferId: string; destinationPath: string }
    > => ipcRenderer.invoke('fs:startDownloadedFile', args),
    appendDownloadedFileChunk: (args: {
      transferId: string
      contentBase64: string
    }): Promise<{ ok: true }> => ipcRenderer.invoke('fs:appendDownloadedFileChunk', args),
    finishDownloadedFile: (args: {
      transferId: string
    }): Promise<{ canceled: false; destinationPath: string }> =>
      ipcRenderer.invoke('fs:finishDownloadedFile', args),
    cancelDownloadedFile: (args: { transferId: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('fs:cancelDownloadedFile', args),
    listMarkdownDocuments: (args: {
      rootPath: string
      connectionId?: string
    }): Promise<{ filePath: string; relativePath: string; basename: string; name: string }[]> =>
      ipcRenderer.invoke('fs:listMarkdownDocuments', args),
    writeFile: (
      args: {
        filePath: string
        content: string
        connectionId?: string
      } & SshMutationExpectation
    ): Promise<void> => ipcRenderer.invoke('fs:writeFile', args),
    createFile: (
      args: { filePath: string; connectionId?: string } & SshMutationExpectation
    ): Promise<void> => ipcRenderer.invoke('fs:createFile', args),
    createDir: (
      args: { dirPath: string; connectionId?: string } & SshMutationExpectation
    ): Promise<void> => ipcRenderer.invoke('fs:createDir', args),
    rename: (
      args: { oldPath: string; newPath: string; connectionId?: string } & SshMutationExpectation
    ): Promise<void> => ipcRenderer.invoke('fs:rename', args),
    copy: (
      args: {
        sourcePath: string
        destinationPath: string
        connectionId?: string
      } & SshMutationExpectation
    ): Promise<void> => ipcRenderer.invoke('fs:copy', args),
    deletePath: (
      args: {
        targetPath: string
        connectionId?: string
        recursive?: boolean
      } & SshMutationExpectation
    ): Promise<void> => ipcRenderer.invoke('fs:deletePath', args),
    authorizeExternalPath: (args: { targetPath: string }): Promise<void> =>
      ipcRenderer.invoke('fs:authorizeExternalPath', args),
    stat: (args: {
      filePath: string
      connectionId?: string
    }): Promise<{ size: number; isDirectory: boolean; mtime: number }> =>
      ipcRenderer.invoke('fs:stat', args),
    pathExists: (args: { filePath: string; connectionId?: string }): Promise<boolean> =>
      ipcRenderer.invoke('fs:pathExists', args),
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
      requestToken?: string
      maxResults?: number
      searchQuery?: string
    }): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', args),
    cancelListFiles: (args: { requestToken: string }): Promise<void> =>
      ipcRenderer.invoke('fs:cancelListFiles', args),
    search: (args: {
      query: string
      rootPath: string
      caseSensitive?: boolean
      wholeWord?: boolean
      useRegex?: boolean
      includePattern?: string
      excludePattern?: string
      maxResults?: number
      connectionId?: string
    }): Promise<SearchResult> => ipcRenderer.invoke('fs:search', args),
    importExternalPaths: (
      args: {
        sourcePaths: string[]
        destDir: string
        connectionId?: string
        ensureDir?: boolean
      } & SshMutationExpectation
    ): Promise<{
      results: (
        | {
            sourcePath: string
            status: 'imported'
            destPath: string
            kind: 'file' | 'directory'
            renamed: boolean
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }> => ipcRenderer.invoke('fs:importExternalPaths', args),
    stageExternalPathsForRuntimeUpload: (args: {
      sourcePaths: string[]
    }): Promise<{
      sources: (
        | {
            sourcePath: string
            status: 'staged'
            name: string
            kind: 'file' | 'directory'
            entries: (
              | { relativePath: string; kind: 'directory' }
              | { relativePath: string; kind: 'file'; contentBase64: string }
            )[]
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }> => ipcRenderer.invoke('fs:stageExternalPathsForRuntimeUpload', args),
    resolveDroppedPathsForAgent: (
      args: {
        paths: string[]
        worktreePath: string
        connectionId?: string
      } & SshMutationExpectation
    ): Promise<{
      resolvedPaths: string[]
      skipped: {
        sourcePath: string
        reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
      }[]
      failed: { sourcePath: string; reason: string }[]
    }> => ipcRenderer.invoke('fs:resolveDroppedPathsForAgent', args),
    watchWorktree: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:watchWorktree', args),
    unwatchWorktree: (args: { worktreePath: string; connectionId?: string }): Promise<void> =>
      ipcRenderer.invoke('fs:unwatchWorktree', args),
    onFsChanged: (callback: (payload: FsChangedPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FsChangedPayload) =>
        callback(payload)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.removeListener('fs:changed', listener)
    }
  },

  git: gitBridge,

  ui: { ...uiCommandWorktreeBridge, ...uiCommandBrowserBridge, ...uiCommandTerminalBridge, ...uiWindowBridge } satisfies PreloadApi['ui'],




  aiVault: {
    listSessions: (args?: AiVaultListArgs) => ipcRenderer.invoke('aiVault:listSessions', args),
    resolveSessionTitles: (args: AiVaultSessionTitlesArgs) =>
      ipcRenderer.invoke('aiVault:resolveSessionTitles', args),
    cancelListSessions: (args: { requestToken: string }): Promise<void> =>
      ipcRenderer.invoke('aiVault:cancelListSessions', args),
    prepareSessionResume: (args: AiVaultPrepareSessionResumeArgs) =>
      ipcRenderer.invoke('aiVault:prepareSessionResume', args),
    listSubagentSessions: (args: AiVaultSubagentListArgs) =>
      ipcRenderer.invoke('aiVault:listSubagentSessions', args),
    getFirstUserPrompt: (args: AiVaultFirstUserPromptArgs) =>
      ipcRenderer.invoke('aiVault:getFirstUserPrompt', args),
    deleteSession: (args: AiVaultDeleteSessionArgs): Promise<AiVaultDeleteSessionResult> =>
      ipcRenderer.invoke('aiVault:deleteSession', args),
    onWindowFocused: (callback: () => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent) => callback()
      ipcRenderer.on('aiVault:windowFocused', listener)
      return () => ipcRenderer.removeListener('aiVault:windowFocused', listener)
    }
  },

  nativeChat: {
    readSession: (
      agent: AgentType,
      sessionId: string,
      limit?: number,
      transcriptPath?: string
    ): Promise<NativeChatReadSessionResult> =>
      ipcRenderer.invoke('nativeChat:readSession', { agent, sessionId, limit, transcriptPath }),
    /** Start live tailing; onAppended fires with only newly-appended messages. Returns an unsubscribe fn that closes the watcher. */
    subscribe: (
      args: {
        subscriptionId: string
        agent: AgentType
        sessionId: string
        transcriptPath?: string
        limit?: number
      },
      onFrame: (frame: NativeChatSubscriptionFrame) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: NativeChatAppendedPayload) => {
        if (payload.subscriptionId === args.subscriptionId) {
          onFrame(payload.frame)
        }
      }
      ipcRenderer.on('nativeChat:appended', listener)
      ipcRenderer.send('nativeChat:subscribe', args)
      return () => {
        ipcRenderer.removeListener('nativeChat:appended', listener)
        ipcRenderer.send('nativeChat:unsubscribe', { subscriptionId: args.subscriptionId })
      }
    }
  },

  runtime: {
    syncWindowGraph: (
      graph: RuntimeRendererSyncWindowGraph
    ): Promise<RuntimeSyncWindowGraphResult> =>
      ipcRenderer.invoke('runtime:syncWindowGraph', graph),
    getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:getStatus'),
    call: (args: { method: string; params?: unknown }): Promise<RuntimeRpcResponse<unknown>> =>
      ipcRenderer.invoke('runtime:call', args),
    subscribe: async (
      args: { method: string; params?: unknown },
      callback: (response: RuntimeRpcResponse<unknown>) => void
    ): Promise<RuntimeEnvironmentSubscriptionHandle> => {
      const subscriptionId = `desktop-${crypto.randomUUID()}`
      const channel = `runtime:subscription:${subscriptionId}`
      const listener = (_event: Electron.IpcRendererEvent, response: RuntimeRpcResponse<unknown>) =>
        callback(response)
      ipcRenderer.on(channel, listener)
      try {
        await ipcRenderer.invoke('runtime:subscribe', { subscriptionId, ...args })
      } catch (error) {
        ipcRenderer.removeListener(channel, listener)
        throw error
      }
      return {
        unsubscribe: () => {
          ipcRenderer.removeListener(channel, listener)
          ipcRenderer.send('runtime:unsubscribe', { subscriptionId })
        },
        sendBinary: () => {
          throw new Error('Local runtime subscriptions do not accept binary input')
        }
      }
    },
    getTerminalFitOverrides: (): Promise<
      { ptyId: string; mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }[]
    > => ipcRenderer.invoke('runtime:getTerminalFitOverrides'),
    getTerminalDrivers: (): Promise<
      {
        ptyId: string
        driver: RuntimeTerminalDriverState
      }[]
    > => ipcRenderer.invoke('runtime:getTerminalDrivers'),
    getBrowserDrivers: (): Promise<
      {
        browserPageId: string
        driver: RuntimeBrowserDriverState
      }[]
    > => ipcRenderer.invoke('runtime:getBrowserDrivers'),
    getBrowserRemoteViewerPages: (): Promise<string[]> =>
      ipcRenderer.invoke('runtime:getBrowserRemoteViewerPages'),
    getClientHostedBrowserRows: (): Promise<ClientHostedBrowserRowsEvent[]> =>
      ipcRenderer.invoke('runtime:getClientHostedBrowserRows'),
    restoreTerminalFit: (ptyId: string): Promise<{ restored: boolean }> =>
      ipcRenderer.invoke('runtime:restoreTerminalFit', { ptyId }),
    reclaimBrowserForDesktop: (browserPageId: string): Promise<{ reclaimed: boolean }> =>
      ipcRenderer.invoke('runtime:reclaimBrowserForDesktop', { browserPageId }),
    onTerminalFitOverrideChanged: (
      callback: (event: {
        ptyId: string
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          ptyId: string
          mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
          cols: number
          rows: number
        }
      ) => callback(data)
      ipcRenderer.on('runtime:terminalFitOverrideChanged', listener)
      return () => ipcRenderer.removeListener('runtime:terminalFitOverrideChanged', listener)
    },
    onTerminalDriverChanged: (
      callback: (event: { ptyId: string; driver: RuntimeTerminalDriverState }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          ptyId: string
          driver: RuntimeTerminalDriverState
        }
      ) => callback(data)
      ipcRenderer.on('runtime:terminalDriverChanged', listener)
      return () => ipcRenderer.removeListener('runtime:terminalDriverChanged', listener)
    },
    onNativeChatLaunchDraftResolved: (
      callback: (event: { tabId: string; text: string; createdAt: number }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { tabId: string; text: string; createdAt: number }
      ) => callback(data)
      ipcRenderer.on('runtime:nativeChatLaunchDraftResolved', listener)
      return () => ipcRenderer.removeListener('runtime:nativeChatLaunchDraftResolved', listener)
    },
    onBrowserDriverChanged: (
      callback: (event: { browserPageId: string; driver: RuntimeBrowserDriverState }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          driver: RuntimeBrowserDriverState
        }
      ) => callback(data)
      ipcRenderer.on('runtime:browserDriverChanged', listener)
      return () => ipcRenderer.removeListener('runtime:browserDriverChanged', listener)
    },
    onBrowserRemoteViewersChanged: (
      callback: (event: { browserPageId: string; hasRemoteViewers: boolean }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserPageId: string
          hasRemoteViewers: boolean
        }
      ) => callback(data)
      ipcRenderer.on('runtime:browserRemoteViewersChanged', listener)
      return () => ipcRenderer.removeListener('runtime:browserRemoteViewersChanged', listener)
    },
    onClientHostedBrowserRowsChanged: (
      callback: (event: ClientHostedBrowserRowsEvent) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: ClientHostedBrowserRowsEvent) =>
        callback(data)
      ipcRenderer.on('runtime:clientHostedBrowserRowsChanged', listener)
      return () => ipcRenderer.removeListener('runtime:clientHostedBrowserRowsChanged', listener)
    }
  },

  runtimeEnvironments: {
    list: (): Promise<PublicKnownRuntimeEnvironment[]> =>
      ipcRenderer.invoke('runtimeEnvironments:list'),
    addFromPairingCode: (args: {
      name: string
      pairingCode: string
    }): Promise<{ environment: PublicKnownRuntimeEnvironment }> =>
      ipcRenderer.invoke('runtimeEnvironments:addFromPairingCode', args),
    verifyAndAddFromPairingCode: (args: {
      name: string
      pairingCode: string
      allowLoopback?: boolean
    }): Promise<VerifyAndAddRuntimeEnvironmentResult> =>
      ipcRenderer.invoke('runtimeEnvironments:verifyAndAddFromPairingCode', args),
    resolve: (args: { selector: string }): Promise<PublicKnownRuntimeEnvironment> =>
      ipcRenderer.invoke('runtimeEnvironments:resolve', args),
    remove: (args: { selector: string }): Promise<{ removed: PublicKnownRuntimeEnvironment }> =>
      ipcRenderer.invoke('runtimeEnvironments:remove', args),
    disconnect: (args: {
      selector: string
    }): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> =>
      ipcRenderer.invoke('runtimeEnvironments:disconnect', args),
    connect: (args: {
      selector: string
      timeoutMs?: number
    }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
      ipcRenderer.invoke('runtimeEnvironments:connect', args),
    getStatus: (args: {
      selector: string
      timeoutMs?: number
    }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
      ipcRenderer.invoke('runtimeEnvironments:getStatus', args),
    prepareBrowserClientHostPlacement: (args) =>
      ipcRenderer.invoke('runtimeEnvironments:prepareBrowserClientHostPlacement', args),
    retryConnectionsNow: (): Promise<void> =>
      ipcRenderer.invoke('runtimeEnvironments:retryConnectionsNow'),
    call: (args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
      expectedEnvironmentPairingRevision?: number
    }): Promise<RuntimeRpcResponse<unknown>> =>
      ipcRenderer.invoke('runtimeEnvironments:call', args),
    subscribe: async (
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onError?: (error: { code: string; message: string }) => void
        onClose?: () => void
      }
    ): Promise<RuntimeEnvironmentSubscriptionHandle> =>
      subscribeRuntimeEnvironmentFromPreload(ipcRenderer, args, callbacks)
  },

  rateLimits: {
    get: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:get'),
    refresh: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refresh'),
    refreshCodexForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
      ipcRenderer.invoke('rateLimits:refreshCodexForTarget', target),
    consumeCodexResetCredit: (): Promise<CodexRateLimitResetResult> =>
      ipcRenderer.invoke('rateLimits:consumeCodexResetCredit'),
    refreshClaudeForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
      ipcRenderer.invoke('rateLimits:refreshClaudeForTarget', target),
    setPollingInterval: (ms: number): Promise<void> =>
      ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
    fetchInactiveClaudeAccounts: (): Promise<void> =>
      ipcRenderer.invoke('rateLimits:fetchInactiveClaudeAccounts'),
    fetchInactiveCodexAccounts: (): Promise<void> =>
      ipcRenderer.invoke('rateLimits:fetchInactiveCodexAccounts'),
    refreshMiniMax: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshMiniMax'),
    refreshGrok: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshGrok'),
    onUpdate: (callback: (state: RateLimitState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: RateLimitState) => callback(state)
      ipcRenderer.on('rateLimits:update', listener)
      return () => ipcRenderer.removeListener('rateLimits:update', listener)
    }
  },

  minimaxCredentials: {
    getStatus: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('minimaxCredentials:getStatus'),
    saveCookie: (cookie: string): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
    clearCookie: (): Promise<{ configured: boolean }> =>
      ipcRenderer.invoke('minimaxCredentials:clearCookie')
  },

  grokAccounts: {
    getStatus: (): Promise<GrokAccountStatus> => ipcRenderer.invoke('grokAccounts:getStatus')
  },

  ssh: {
    listTargets: (): Promise<SshTarget[]> => ipcRenderer.invoke('ssh:listTargets'),

    listRemovedTargetLabels: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('ssh:listRemovedTargetLabels'),

    addTarget: (args: { target: SshTargetCreateInput }): Promise<SshTargetAddResult> =>
      ipcRenderer.invoke('ssh:addTarget', args),

    updateTarget: (args: { id: string; updates: SshTargetUpdateInput }): Promise<SshTarget> =>
      ipcRenderer.invoke('ssh:updateTarget', args),

    removeTarget: (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:removeTarget', args),

    importConfig: (args?: { reAdopt?: boolean }): Promise<SshConfigImportResult> =>
      ipcRenderer.invoke('ssh:importConfig', args),

    listConfigHosts: (args?: SshConfigHostListArgs): Promise<SshConfigHostListResult> =>
      ipcRenderer.invoke('ssh:listConfigHosts', args),

    resolveConfigHost: (args: { alias: string }): Promise<SshConfigHostResolution | null> =>
      ipcRenderer.invoke('ssh:resolveConfigHost', args),

    connect: async (args: { targetId: string }): Promise<SshConnectionState | null> => {
      const state: unknown = await ipcRenderer.invoke('ssh:connect', args)
      return state ? admitSshConnectionStateForAuthorityReconciliation(state, args.targetId) : null
    },

    disconnect: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:disconnect', args),

    terminateSessions: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:terminateSessions', args),

    resetRelay: (args: { targetId: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:resetRelay', args),

    getState: async (args: { targetId: string }): Promise<SshConnectionState | null> => {
      const state: unknown = await ipcRenderer.invoke('ssh:getState', args)
      return state ? admitSshConnectionStateForAuthorityReconciliation(state, args.targetId) : null
    },

    needsPassphrasePrompt: (args: { targetId: string }): Promise<boolean> =>
      ipcRenderer.invoke('ssh:needsPassphrasePrompt', args),

    testConnection: async (args: {
      targetId: string
    }): Promise<{ success: boolean; error?: string; state?: SshConnectionState }> => {
      const result: { success: boolean; error?: string; state?: unknown } =
        await ipcRenderer.invoke('ssh:testConnection', args)
      const state = result.state
        ? admitSshConnectionStateForAuthorityReconciliation(result.state, args.targetId)
        : null
      return { ...result, ...(state ? { state } : { state: undefined }) }
    },

    onStateChanged: (
      callback: (data: { targetId: string; state: SshConnectionState }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; state: unknown }
      ): void => {
        const state = admitSshConnectionStateForAuthorityReconciliation(data.state, data.targetId)
        if (state) {
          callback({ targetId: data.targetId, state })
        }
      }
      ipcRenderer.on('ssh:state-changed', listener)
      return () => ipcRenderer.removeListener('ssh:state-changed', listener)
    },

    addPortForward: (args: {
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }): Promise<PortForwardEntry> => ipcRenderer.invoke('ssh:addPortForward', args),

    updatePortForward: (args: {
      id: string
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }): Promise<PortForwardEntry> => ipcRenderer.invoke('ssh:updatePortForward', args),

    removePortForward: (args: { id: string }): Promise<PortForwardEntry | null> =>
      ipcRenderer.invoke('ssh:removePortForward', args),

    listPortForwards: (args?: { targetId?: string }): Promise<PortForwardEntry[]> =>
      ipcRenderer.invoke('ssh:listPortForwards', args),

    listDetectedPorts: async (args: { targetId: string }): Promise<EnrichedDetectedPort[]> =>
      admitSshDetectedPorts(await ipcRenderer.invoke('ssh:listDetectedPorts', args)),

    onPortForwardsChanged: (
      callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; forwards: PortForwardEntry[] }
      ) => callback(data)
      ipcRenderer.on('ssh:port-forwards-changed', handler)
      return () => ipcRenderer.removeListener('ssh:port-forwards-changed', handler)
    },

    onDetectedPortsChanged: (
      callback: (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { targetId: string; ports: unknown }
      ) => callback({ targetId: data.targetId, ports: admitSshDetectedPorts(data.ports) })
      ipcRenderer.on('ssh:detected-ports-changed', handler)
      return () => ipcRenderer.removeListener('ssh:detected-ports-changed', handler)
    },

    browseDir: (args: {
      targetId: string
      dirPath: string
    }): Promise<{
      entries: { name: string; isDirectory: boolean }[]
      resolvedPath: string
      pathFlavor: FilesystemPathFlavor
    }> => ipcRenderer.invoke('ssh:browseDir', args),

    onCredentialRequest: (
      callback: (data: {
        requestId: string
        targetId: string
        kind: 'passphrase' | 'password'
        detail: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          requestId: string
          targetId: string
          kind: 'passphrase' | 'password'
          detail: string
        }
      ) => callback(data)
      ipcRenderer.on('ssh:credential-request', listener)
      return () => ipcRenderer.removeListener('ssh:credential-request', listener)
    },

    onCredentialResolved: (callback: (data: { requestId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }) =>
        callback(data)
      ipcRenderer.on('ssh:credential-resolved', listener)
      return () => ipcRenderer.removeListener('ssh:credential-resolved', listener)
    },

    submitCredential: (args: { requestId: string; value: string | null }): Promise<void> =>
      ipcRenderer.invoke('ssh:submitCredential', args)
  },

  // Orca automation CRUD rides the local runtime RPC surface (`runtime:call`),
  // so only external-manager and dispatch-loop plumbing stays on IPC.
  automations: {
    listExternalManagerForOwner: (
      request: ScopedExternalManagerListRequest
    ): Promise<ExternalAutomationManagerResult> =>
      ipcRenderer.invoke('automations:listExternalManagerForOwner', request),
    listExternalRunsForOwner: (
      request: ScopedExternalManagerRunsRequest
    ): Promise<ExternalAutomationRunsPage> =>
      ipcRenderer.invoke('automations:listExternalRunsForOwner', request),
    createExternalForOwner: (request: ScopedExternalManagerCreateRequest): Promise<void> =>
      ipcRenderer.invoke('automations:createExternalForOwner', request),
    updateExternalForOwner: (request: ScopedExternalManagerUpdateRequest): Promise<void> =>
      ipcRenderer.invoke('automations:updateExternalForOwner', request),
    runExternalActionForOwner: (request: ScopedExternalManagerActionRequest): Promise<void> =>
      ipcRenderer.invoke('automations:runExternalActionForOwner', request),
    retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }): Promise<void> =>
      ipcRenderer.invoke('automations:retainExternalScopes', request),
    runPrecheck: (args: {
      automationId: string
      runId: string
    }): Promise<AutomationPrecheckResult | null> =>
      ipcRenderer.invoke('automations:runPrecheck', args),
    markDispatchResult: (result: AutomationDispatchResult): Promise<AutomationRun> =>
      ipcRenderer.invoke('automations:markDispatchResult', result),
    snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }): Promise<number> =>
      ipcRenderer.invoke('automations:snapshotWorkspaceName', args),
    rendererReady: (): Promise<void> => ipcRenderer.invoke('automations:rendererReady'),
    onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: AutomationDispatchRequest) =>
        callback(request)
      ipcRenderer.on('automations:dispatchRequested', listener)
      return () => ipcRenderer.removeListener('automations:dispatchRequested', listener)
    },
    onChanged: (callback: (payload: AutomationsChangedPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AutomationsChangedPayload) =>
        callback(payload)
      ipcRenderer.on('automations:changed', listener)
      return () => ipcRenderer.removeListener('automations:changed', listener)
    }
  },

  e2e: e2eBridge,
  resources: e2eResourcesBridge,


  agentStatus: {
    /** Listen for agent status updates forwarded from native hook receivers. */
    onSet: (callback: (data: AgentStatusIpcPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: AgentStatusIpcPayload) =>
        callback(data)
      ipcRenderer.on('agentStatus:set', listener)
      return () => ipcRenderer.removeListener('agentStatus:set', listener)
    },
    onClear: (callback: (data: AgentStatusClearIpcPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: AgentStatusClearIpcPayload) =>
        callback(data)
      ipcRenderer.on('agentStatus:clear', listener)
      return () => ipcRenderer.removeListener('agentStatus:clear', listener)
    },
    /** Pull cached hook statuses after renderer hydration, so startup replays aren't lost before tabs exist. */
    getSnapshot: (): Promise<AgentStatusIpcPayload[]> =>
      ipcRenderer.invoke('agentStatus:getSnapshot'),
    inferInterrupt: (request: AgentInterruptInferenceRequest): Promise<boolean> =>
      ipcRenderer.invoke('agentStatus:inferInterrupt', request),
    inferQuestionAnswered: (request: AgentQuestionAnsweredInferenceRequest): Promise<boolean> =>
      ipcRenderer.invoke('agentStatus:inferQuestionAnswered', request),
    onMigrationUnsupported: (
      callback: (entry: MigrationUnsupportedPtyEntry) => void
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, entry: MigrationUnsupportedPtyEntry) =>
        callback(entry)
      ipcRenderer.on('agentStatus:migrationUnsupported', listener)
      return () => ipcRenderer.removeListener('agentStatus:migrationUnsupported', listener)
    },
    onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) =>
        callback(data)
      ipcRenderer.on('agentStatus:migrationUnsupportedClear', listener)
      return () => ipcRenderer.removeListener('agentStatus:migrationUnsupportedClear', listener)
    },
    onLegacyWorkerTerminalRecovery: (
      callback: (data: {
        paneKey: string
        resolution: 'adopted' | 'exited' | 'rolled_back'
        ptyId?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: {
          paneKey: string
          resolution: 'adopted' | 'exited' | 'rolled_back'
          ptyId?: string
        }
      ) => callback(data)
      ipcRenderer.on('agentStatus:legacyWorkerTerminalRecovery', listener)
      return () => ipcRenderer.removeListener('agentStatus:legacyWorkerTerminalRecovery', listener)
    },
    getMigrationUnsupportedSnapshot: (): Promise<MigrationUnsupportedPtyEntry[]> =>
      ipcRenderer.invoke('agentStatus:getMigrationUnsupportedSnapshot'),
    /** Drop the cached hook status for a paneKey on both sides (memory + on-disk) so a relaunch can't resurrect a dismissed row. */
    drop: (paneKey: string): void => {
      ipcRenderer.send('agentStatus:drop', paneKey)
    },
    reconcileEndedProcess: (paneKey: string): void => {
      ipcRenderer.send('agentStatus:reconcileEndedProcess', paneKey)
    },
    /** Drop all cached hook statuses under one terminal tab prefix; fired on explicit tab close even without a local row. */
    dropByTabPrefix: (tabId: string): void => {
      ipcRenderer.send('agentStatus:dropByTabPrefix', tabId)
    },
    retirePaneAuthority: (paneKey: string): void => {
      ipcRenderer.send('agentStatus:retirePaneAuthority', paneKey)
    },
    restorePaneAuthority: (paneKey: string): void => {
      ipcRenderer.send('agentStatus:restorePaneAuthority', paneKey)
    },
    transferPaneAuthority: (args: {
      fromPaneKey: string
      toPaneKey: string
      ptyId?: string
    }): void => {
      ipcRenderer.send('agentStatus:transferPaneAuthority', args)
    }
  },
  speech: speechBridge,
  mobile: mobileBridge,
  feedback: feedbackBridge,
  crashReports: crashReportsBridge,
  starNag: starNagBridge,
  pet: petBridge,
  updater: updaterBridge,
  docPreview: docPreviewBridge,
  platform: platformBridge,
  wsl: wslBridge,
  pwsh: pwshBridge,
  gitBash: gitBashBridge,
  ...telemetryBridge,
  diagnostics: diagnosticsBridge,
  settings: settingsBridge,
  keybindings: keybindingsBridge,
  stats: statsBridge,
  memory: memoryBridge,
  claudeUsage: claudeUsageBridge,
  codexUsage: codexUsageBridge,
  openCodeUsage: openCodeUsageBridge
}

// Expose Electron APIs via contextBridge when context-isolated, otherwise attach to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
