import type { PreloadApi } from '../../../preload/api-types'
import type { StatsSummary } from '../../../shared/process-stats-types'
import { createWebE2EApi } from './preload-api/web-e2e-api'
import {
  createAccountsApi,
  createGrokAccountsApi,
  createMiniMaxCredentialsApi
} from './preload-api/web-agent-accounts-api'
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
import { createHooksApi, createRuntimeNamespaceApi } from './preload-api/web-review-api'
import { callRuntimeResult } from './preload-api/web-runtime-calls'
import { createWebRuntimeApi } from './preload-api/web-runtime-api'
import { createRuntimeEnvironmentsApi } from './preload-api/web-runtime-environments-api'
import { requireActiveEnvironmentOrNull, webRuntimeState } from './preload-api/web-runtime-session'
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
import { setEnvironmentStoreCaller } from './web-environment-sync'
import { callEnvironmentEnvelope } from './preload-api/web-runtime-calls'

export function installWebPreloadApi(): void {
  webRuntimeState.activeEnvironment = readStoredWebRuntimeEnvironment()
  // Why: the sync reuses the app's shared runtime client/queue through this
  // caller, so probes never open extra sockets or bypass manual disconnects.
  setEnvironmentStoreCaller(async <TResult>(method, params) => {
    // Why: callEnvironmentEnvelope treats its first argument as an environment
    // selector, so pass an environment id explicitly. The method name is never
    // a valid selector and would throw "Unknown Orca runtime environment"
    // before the RPC is ever queued.
    // Why: prefer the active environment, but fall back to the most recently
    // used known environment so server-scoped RPCs work before any environment
    // is activated (e.g. a fresh browser on the Connect screen).
    const environment =
      requireActiveEnvironmentOrNull() ??
      [...webRuntimeState.environments]
        .filter((entry) => typeof entry.lastUsedAt === 'number')
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
    if (!environment) {
      throw new Error('Pair this web client with an Orca server first.')
    }
    const response = await callEnvironmentEnvelope<TResult>(environment.id, method, params, 15_000)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  })
  const webWindow = window as unknown as { __ORCA_WEB_CLIENT__?: boolean }
  webWindow.__ORCA_WEB_CLIENT__ = true
  window.electron = createFallbackProxy(['electron']) as Window['electron']
  window.api = withFallback(createWebPreloadApi(), []) as PreloadApi
}

function createWebPreloadApi(): Partial<PreloadApi> {
  return {
    ...createWebAppApi(),
    ...createWebStarNagApi(),
    ...createWebPlatformApi(),
    ...createWebWorkspacePortsApi(),
    ...createWebOrcaProfilesApi(),
    ...createWebE2EApi(),
    ...createWebSettingsApi(),
    keybindings: createWebKeybindingsApi(),
    ui: createWebUiApi(),
    ...createWebDiagnosticsApi(),
    ...createWebWorkspaceSessionApi(),
    ...createWebOnboardingApi(),
    ...createWebGithubCacheApi(),
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
    linear: createRuntimeNamespaceApi('linear'),
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
    ...createWebAgentStatusApi(),
    ...createWebMobileApi(),
    ...createWebTelemetryApi()
  }
}
