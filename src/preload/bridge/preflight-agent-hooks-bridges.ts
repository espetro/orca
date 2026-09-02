import { ipcRenderer } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { PreflightRuntimeContext, RefreshAgentsResult, PreloadApi } from '../api-types'

export const preflightBridge: PreloadApi['preflight'] = {
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
}

export const agentHooksBridge: PreloadApi['agentHooks'] = {
  claudeStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:claudeStatus'),
  openClaudeStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:openClaudeStatus'),
  codexStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:codexStatus'),
  geminiStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:geminiStatus'),
  antigravityStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:antigravityStatus'),
  ampStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:ampStatus'),
  cursorStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:cursorStatus'),
  droidStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:droidStatus'),
  commandCodeStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:commandCodeStatus'),
  grokStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:grokStatus'),
  devinStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:devinStatus'),
  copilotStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:copilotStatus'),
  hermesStatus: (): Promise<AgentHookInstallStatus> =>
    ipcRenderer.invoke('agentHooks:hermesStatus'),
  kimiStatus: (): Promise<AgentHookInstallStatus> => ipcRenderer.invoke('agentHooks:kimiStatus')
}
