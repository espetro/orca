/* eslint-disable max-lines -- Why: preload is the audited renderer/Electron IPC contract; co-locating the surface eases security and type-drift review. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { PreloadApi } from './api-types'
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
import { ptyBridge } from './bridge/pty-bridge'
import { ptySerializerBridge } from './bridge/pty-serializer-bridge'
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
  pty: { ...ptyBridge, ...ptySerializerBridge } satisfies PreloadApi['pty'],

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
