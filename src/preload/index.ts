/* eslint-disable max-lines -- Why: preload is the audited renderer/Electron IPC contract; co-locating the surface eases security and type-drift review. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { AgentSessionPtyWriteRefusal } from '../shared/agent-session-pty-write-admission'
import type { StartupCommandDelivery } from '../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../shared/agent-session-resume'
import type { TuiAgent } from '../shared/tui-agent'
import type { PtyModelRestoreNeededEvent } from '../shared/pty-model-restore-marker'
import type { PtyListedSession } from '../shared/pty-listed-session'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../shared/terminal-view-attributes'
import type { PtyMainDeliveryDiagnostics } from '../shared/pty-delivery-diagnostics'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import type { PreloadApi } from './api-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'
import { createBrowserFindSubscriptions } from './browser-find-subscriptions'
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
import {
  agentAwakeBridge,
  codexAccountsBridge,
  claudeAccountsBridge,
  cliBridge,
  codexConfigSyncBridge
} from './bridge/agent-accounts-bridges'
import { preflightBridge, agentHooksBridge } from './bridge/preflight-agent-hooks-bridges'
import {
  orcaProfilesBridge,
  pluginsBridge,
  shellBridge
} from './bridge/profiles-plugins-shell-bridges'
import { skillsBridge } from './bridge/skills-bridge'
import { appBridge } from './bridge/app-bridge'
import { fsBridge } from './bridge/fs-bridge'
import { browserPageBridge } from './bridge/browser-page-bridge'
import { browserGrabBridge } from './bridge/browser-grab-bridge'
import { browserSessionBridge } from './bridge/browser-session-bridge'
import { runtimeBridge } from './bridge/runtime-bridge'
import { sshBridge } from './bridge/ssh-bridge'
import { agentStatusBridge } from './bridge/agent-status-bridge'
import {
  emulatorBridge,
  runtimeEnvironmentsBridge,
  automationsBridge
} from './bridge/emulator-runtime-env-automations-bridges'
import {
  exportBridge,
  hooksBridge,
  ephemeralVmBridge,
  notebookBridge,
  aiVaultBridge,
  nativeChatBridge,
  rateLimitsBridge,
  minimaxCredentialsBridge,
  grokAccountsBridge
} from './bridge/misc-domain-bridges'
import {
  localhostWorktreeLabelsBridge,
  agentTrustBridge,
  macosTccPromptsBridge,
  developerPermissionsBridge,
  computerUsePermissionsBridge
} from './bridge/permission-label-bridges'
import {
  notificationsBridge,
  onboardingBridge,
  dashboardBridge,
  terminalPreviewBridge
} from './bridge/notification-dashboard-bridges'
import {
  hostedReviewBridge,
  bitbucketBridge,
  linearBridge,
  jiraBridge
} from './bridge/provider-review-bridges'
import { glApi } from './gitlab'
import {
  reposBridge,
  projectsBridge,
  projectGroupsBridge,
  folderWorkspacesBridge,
  sparsePresetsBridge
} from './bridge/repo-catalog-bridges'
import {
  cacheBridge,
  sessionBridge,
  remoteWorkspaceBridge
} from './bridge/workspace-session-bridge'
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

const browserFindSubscriptions = createBrowserFindSubscriptions()

ipcRenderer.on('ui:findInBrowserPage', (_event, source: unknown) => {
  browserFindSubscriptions.dispatch(source)
})

// Custom APIs for renderer
const api: PreloadApi = {
  app: appBridge,

  repos: reposBridge,
  projects: projectsBridge,
  projectGroups: projectGroupsBridge,
  folderWorkspaces: folderWorkspacesBridge,
  sparsePresets: sparsePresetsBridge,
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

  hostedReview: hostedReviewBridge,
  bitbucket: bitbucketBridge,
  linear: linearBridge,
  jira: jiraBridge,
  orcaProfiles: orcaProfilesBridge,
  plugins: pluginsBridge,
  shell: shellBridge,
  skills: skillsBridge,
  gh: {
    ...ghBridge,
    ...ghProjectsBridge
  },

  // Why: GitLab bindings live in `./gitlab` so `gl.*` changes don't conflict on every upstream sync of this central file.
  gl: glApi,

  // Why: main validates telemetry; renderer call sites use typed wrappers.

  agentAwake: agentAwakeBridge,
  preflight: preflightBridge,
  agentHooks: agentHooksBridge,
  codexAccounts: codexAccountsBridge,
  claudeAccounts: claudeAccountsBridge,
  cli: cliBridge,
  codexConfigSync: codexConfigSyncBridge,

  notifications: notificationsBridge,
  onboarding: onboardingBridge,
  dashboard: dashboardBridge,
  terminalPreview: terminalPreviewBridge,

  localhostWorktreeLabels: localhostWorktreeLabelsBridge,
  agentTrust: agentTrustBridge,
  macosTccPrompts: macosTccPromptsBridge,
  developerPermissions: developerPermissionsBridge,
  computerUsePermissions: computerUsePermissionsBridge,

  browser: {
    ...browserPageBridge,
    ...browserGrabBridge,
    ...browserSessionBridge
  } satisfies PreloadApi['browser'],

  cache: cacheBridge,
  session: sessionBridge,
  remoteWorkspace: remoteWorkspaceBridge,

  fs: fsBridge,

  git: gitBridge,

  runtime: runtimeBridge,
  ssh: sshBridge,
  ui: {
    ...uiCommandWorktreeBridge,
    ...uiCommandBrowserBridge,
    ...uiCommandTerminalBridge,
    ...uiWindowBridge
  } satisfies PreloadApi['ui'],

  export: exportBridge,
  hooks: hooksBridge,
  ephemeralVm: ephemeralVmBridge,
  notebook: notebookBridge,
  aiVault: aiVaultBridge,
  nativeChat: nativeChatBridge,
  rateLimits: rateLimitsBridge,
  minimaxCredentials: minimaxCredentialsBridge,
  grokAccounts: grokAccountsBridge,
  emulator: emulatorBridge,
  runtimeEnvironments: runtimeEnvironmentsBridge,
  automations: automationsBridge,

  // Orca automation CRUD rides the local runtime RPC surface (`runtime:call`),
  // so only external-manager and dispatch-loop plumbing stays on IPC.

  e2e: e2eBridge,
  resources: e2eResourcesBridge,
  agentStatus: agentStatusBridge,

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
