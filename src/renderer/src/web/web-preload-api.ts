import type { PreloadApi } from '../../../preload/api-types'
import type { StatsSummary } from '../../../shared/process-stats-types'
import { createWebE2EApi } from './preload-api/web-e2e-api'
import {
  createAccountsApi,
  createGrokAccountsApi,
  createMiniMaxCredentialsApi
} from './preload-api/web-agent-accounts-api'
import { createAgentHooksApi } from './preload-api/web-agent-hooks-api'
import { createWebAgentStatusApi } from './preload-api/web-agent-status-api'
import { createWebAiVaultApi } from './preload-api/web-ai-vault-api'
import { createWebAppApi } from './preload-api/web-app-api'
import { createBrowserApi, createEmulatorApi } from './preload-api/web-browser-api'
import { createCliApi } from './preload-api/web-cli-api'
import { createWebDiagnosticsApi } from './preload-api/web-diagnostics-api'
import { createFallbackProxy, withFallback } from './preload-api/web-fallback-api'
import { createFileApi } from './preload-api/web-filesystem-api'
import { createGitApi } from './preload-api/web-git-api'
import { createWebGithubCacheApi } from './preload-api/web-github-cache-api'
import { createGitHubApi } from './preload-api/web-github-api'
import { createGitLabApi } from './preload-api/web-gitlab-api'
import {
  createComputerUsePermissionsApi,
  createDeveloperPermissionsApi,
  createPreflightApi,
  createSkillsApi
} from './preload-api/web-host-capability-api'
import { createWebKeybindingsApi } from './preload-api/web-keybindings-api'
import { createMacosTccPromptsApi } from './preload-api/web-macos-tcc-api'
import { createEmptyMemorySnapshot } from './preload-api/web-memory-api'
import { createWebMobileApi } from './preload-api/web-mobile-api'
import { createWebNativeChatApi } from './preload-api/web-native-chat-api'
import { createNotificationsApi } from './preload-api/web-notifications-api'
import { createWebOnboardingApi } from './preload-api/web-onboarding-api'
import { createWebOrcaProfilesApi } from './preload-api/web-orca-profiles-api'
import { createWebPlatformApi } from './preload-api/web-platform-api'
import { createRateLimitsApi } from './preload-api/web-rate-limits-api'
import { createReposApi } from './preload-api/web-repositories-api'
import {
  createAgentAwakeDegradedApi,
  createAgentTrustDegradedApi,
  createAutomationsApi,
  createCrashReportsDegradedApi,
  createDashboardDegradedApi,
  createDocPreviewApi,
  createEphemeralVmDegradedApi,
  createExportDegradedApi,
  createFeedbackDegradedApi,
  createFolderWorkspacesApi,
  createLocalhostWorktreeLabelsDegradedApi,
  createNotebookDegradedApi,
  createPetDegradedApi,
  createPluginsApi,
  createProjectGroupsApi,
  createProjectsApi,
  createRemoteWorkspaceDegradedApi,
  createResourcesDegradedApi,
  createSparsePresetsApi,
  createSpeechDegradedApi,
  createTerminalPreviewDegradedApi,
  createUsageApi,
  createWorkspaceCleanupApi,
  createWorkspaceSpaceApi
} from './preload-api/web-projects-api'
import { createHooksApi, createRuntimeNamespaceApi } from './preload-api/web-review-api'
import { callRuntimeResult } from './preload-api/web-runtime-calls'
import { createWebRuntimeApi } from './preload-api/web-runtime-api'
import { createRuntimeEnvironmentsApi } from './preload-api/web-runtime-environments-api'
import { webRuntimeState } from './preload-api/web-runtime-session'
import { createWebSettingsApi } from './preload-api/web-settings-api'
import { createShellApi } from './preload-api/web-shell-api'
import { createWebStarNagApi } from './preload-api/web-star-nag-api'
import { createWebTelemetryApi } from './preload-api/web-telemetry-api'
import { createPtyApi, createSshApi } from './preload-api/web-terminal-api'
import { createWebUiApi } from './preload-api/web-ui-api'
import { createUpdaterApi } from './preload-api/web-updater-api'
import { createWebWorkspacePortsApi } from './preload-api/web-workspace-ports-api'
import { createWebWorkspaceSessionApi } from './preload-api/web-workspace-session-api'
import { createWorktreesApi } from './preload-api/web-worktrees-api'
import { readStoredWebRuntimeEnvironment } from './web-runtime-environment'

export function installWebPreloadApi(): void {
  webRuntimeState.activeEnvironment = readStoredWebRuntimeEnvironment()
  const webWindow = window as unknown as { __ORCA_WEB_CLIENT__?: boolean }
  webWindow.__ORCA_WEB_CLIENT__ = true
  window.electron = createFallbackProxy(['electron']) as Window['electron']
  window.api = withFallback(createWebPreloadApi(), []) as PreloadApi
}

export function createWebPreloadApi(): PreloadApi {
  const usageApi = createUsageApi()
  const telemetry = createWebTelemetryApi()
  return {
    app: createWebAppApi().app!,
    starNag: createWebStarNagApi().starNag!,
    platform: createWebPlatformApi().platform!,
    workspacePorts: createWebWorkspacePortsApi().workspacePorts!,
    orcaProfiles: createWebOrcaProfilesApi().orcaProfiles!,
    e2e: createWebE2EApi().e2e!,
    settings: createWebSettingsApi().settings!,
    resources: createResourcesDegradedApi(),
    projects: createProjectsApi(),
    projectGroups: createProjectGroupsApi(),
    folderWorkspaces: createFolderWorkspacesApi(),
    sparsePresets: createSparsePresetsApi(),
    workspaceCleanup: createWorkspaceCleanupApi(),
    workspaceSpace: createWorkspaceSpaceApi(),
    feedback: createFeedbackDegradedApi(),
    crashReports: createCrashReportsDegradedApi(),
    export: createExportDegradedApi(),
    agentAwake: createAgentAwakeDegradedApi(),
    localhostWorktreeLabels: createLocalhostWorktreeLabelsDegradedApi(),
    agentTrust: createAgentTrustDegradedApi(),
    dashboard: createDashboardDegradedApi(),
    terminalPreview: createTerminalPreviewDegradedApi(),
    pet: createPetDegradedApi(),
    ephemeralVm: createEphemeralVmDegradedApi(),
    remoteWorkspace: createRemoteWorkspaceDegradedApi(),
    notebook: createNotebookDegradedApi(),
    docPreview: createDocPreviewApi(),
    claudeUsage: usageApi,
    codexUsage: usageApi,
    openCodeUsage: usageApi,
    automations: createAutomationsApi(),
    plugins: createPluginsApi(),
    speech: createSpeechDegradedApi(),
    keybindings: createWebKeybindingsApi(),
    ui: createWebUiApi(),
    diagnostics: createWebDiagnosticsApi().diagnostics!,
    session: createWebWorkspaceSessionApi().session!,
    onboarding: createWebOnboardingApi().onboarding!,
    cache: createWebGithubCacheApi().cache!,
    runtime: createWebRuntimeApi(),
    nativeChat: createWebNativeChatApi(),
    runtimeEnvironments: createRuntimeEnvironmentsApi(),
    repos: createReposApi(),
    worktrees: createWorktreesApi(),
    fs: createFileApi(),
    git: createGitApi(),
    browser: createBrowserApi(),
    emulator: createEmulatorApi(),
    gh: createGitHubApi(),
    gl: createGitLabApi(),
    hostedReview: createRuntimeNamespaceApi('hostedReview'),
    bitbucket: createRuntimeNamespaceApi('bitbucket'),
    linear: createRuntimeNamespaceApi('linear'),
    jira: createRuntimeNamespaceApi('jira'),
    hooks: createHooksApi(),
    stats: {
      getSummary: async () =>
        callRuntimeResult<StatsSummary>('stats.summary').catch(() => ({
          totalAgentsSpawned: 0,
          totalPRsCreated: 0,
          totalAgentTimeMs: 0,
          firstEventAt: null
        }))
    },
    memory: {
      getSnapshot: () => Promise.resolve(createEmptyMemorySnapshot())
    },
    aiVault: createWebAiVaultApi(),
    preflight: createPreflightApi(),
    notifications: createNotificationsApi(),
    rateLimits: createRateLimitsApi(),
    minimaxCredentials: createMiniMaxCredentialsApi(),
    grokAccounts: createGrokAccountsApi(),
    codexAccounts: createAccountsApi(),
    claudeAccounts: createAccountsApi(),
    cli: createCliApi(),
    agentHooks: createAgentHooksApi(),
    macosTccPrompts: createMacosTccPromptsApi(),
    codexConfigSync: {
      status: () =>
        Promise.resolve({ state: 'synced', reason: null, systemConfigPath: '' } as const)
    },
    developerPermissions: createDeveloperPermissionsApi(),
    computerUsePermissions: createComputerUsePermissionsApi(),
    updater: createUpdaterApi(),
    shell: createShellApi(),
    skills: createSkillsApi(),
    pty: createPtyApi(),
    ssh: createSshApi(),
    wsl: {
      isAvailable: () => callRuntimeResult<boolean>('host.wsl.isAvailable').catch(() => false),
      listDistros: () => callRuntimeResult<string[]>('host.wsl.listDistros').catch(() => [])
    },
    pwsh: {
      isAvailable: () => callRuntimeResult<boolean>('host.pwsh.isAvailable').catch(() => false)
    },
    gitBash: {
      isAvailable: () => callRuntimeResult<boolean>('host.gitBash.isAvailable').catch(() => false)
    },
    agentStatus: createWebAgentStatusApi().agentStatus!,
    mobile: createWebMobileApi().mobile!,
    telemetryTrack: telemetry.telemetryTrack!,
    telemetrySetOptIn: telemetry.telemetrySetOptIn!,
    telemetryGetConsentState: telemetry.telemetryGetConsentState!,
    telemetryAcknowledgeBanner: telemetry.telemetryAcknowledgeBanner!
  }
}
