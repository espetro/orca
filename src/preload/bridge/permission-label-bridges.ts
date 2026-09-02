import { ipcRenderer } from 'electron'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../../shared/localhost-worktree-labels'
import type { PreloadApi } from '../api-types'

export const localhostWorktreeLabelsBridge: PreloadApi['localhostWorktreeLabels'] = {
  register: (args: LocalhostWorktreeLabelRoute): Promise<LocalhostWorktreeLabelResult> =>
    ipcRenderer.invoke('localhostWorktreeLabels:register', args)
}

export const agentTrustBridge: PreloadApi['agentTrust'] = {
  markTrusted: (args: {
    preset: 'cursor' | 'copilot' | 'codex'
    workspacePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
}

export const macosTccPromptsBridge: PreloadApi['macosTccPrompts'] = {
  onThreshold: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { promptCount: number }): void =>
      callback(payload)
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
}

export const developerPermissionsBridge: PreloadApi['developerPermissions'] = {
  getStatus: () => ipcRenderer.invoke('developerPermissions:getStatus'),
  request: (args: { id: string }) => ipcRenderer.invoke('developerPermissions:request', args),
  openSettings: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke('developerPermissions:openSettings', args),
  testLocalNetworkConnection: (args: { host: string; port: number }) =>
    ipcRenderer.invoke('developerPermissions:testLocalNetworkConnection', args)
}

export const computerUsePermissionsBridge: PreloadApi['computerUsePermissions'] = {
  getStatus: () => ipcRenderer.invoke('computerUsePermissions:getStatus'),
  openSetup: (args?: { id?: string }) =>
    ipcRenderer.invoke('computerUsePermissions:openSetup', args),
  reset: () => ipcRenderer.invoke('computerUsePermissions:reset')
}
