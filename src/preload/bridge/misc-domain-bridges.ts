import { ipcRenderer } from 'electron'
import type { AiVaultDeleteSessionArgs, AiVaultDeleteSessionResult } from '../../shared/ai-vault-session-deletion'
import type {
  AiVaultFirstUserPromptArgs,
  AiVaultListArgs,
  AiVaultSubagentListArgs
} from '../../shared/ai-vault-types'
import type { AiVaultSessionTitlesArgs } from '../../shared/ai-vault-session-title'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import type { AgentType } from '../../shared/native-chat-types'
import type {
  NativeChatAppendedPayload,
  NativeChatReadSessionResult,
  NativeChatSubscriptionFrame
} from '../api/native-chat-api'
import type {
  CodexRateLimitResetResult,
  GrokAccountStatus,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../../shared/rate-limit-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import type { PreloadApi } from '../api-types'

export const exportBridge: PreloadApi['export'] = {
  htmlToPdf: (args: {
    html: string
    title: string
  }): Promise<
    { success: true; filePath: string } | { success: false; cancelled?: boolean; error?: string }
  > => ipcRenderer.invoke('export:html-to-pdf', args)
}

export const hooksBridge: PreloadApi['hooks'] = {
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
}

export const ephemeralVmBridge: PreloadApi['ephemeralVm'] = {
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
}

export const notebookBridge: PreloadApi['notebook'] = {
  runPythonCell: (args: {
    filePath: string
    code: string
    preamble?: string
    connectionId?: string | null
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> =>
    ipcRenderer.invoke('notebook:runPythonCell', args)
}

export const aiVaultBridge: PreloadApi['aiVault'] = {
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
}

export const nativeChatBridge: PreloadApi['nativeChat'] = {
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
}

export const rateLimitsBridge: PreloadApi['rateLimits'] = {
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
}

export const minimaxCredentialsBridge: PreloadApi['minimaxCredentials'] = {
  getStatus: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:getStatus'),
  saveCookie: (cookie: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:saveCookie', cookie),
  clearCookie: (): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke('minimaxCredentials:clearCookie')
}

export const grokAccountsBridge: PreloadApi['grokAccounts'] = {
  getStatus: (): Promise<GrokAccountStatus> => ipcRenderer.invoke('grokAccounts:getStatus')
}
