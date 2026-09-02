import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { PreloadApi } from './api-types'
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
import { ptyEventsBridge } from './bridge/pty-events-bridge'
import { registerNativeFileDropListeners } from './native-file-drop-listeners'
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

registerNativeFileDropListeners()

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
  pty: { ...ptyBridge, ...ptyEventsBridge, ...ptySerializerBridge } satisfies PreloadApi['pty'],

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
