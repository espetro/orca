import { ipcRenderer } from 'electron'
import type { ComputerAwakeStatus } from '../../shared/computer-awake-mode'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'
import type { PreloadApi } from '../api-types'

export const agentAwakeBridge: PreloadApi['agentAwake'] = {
  getStatus: (): Promise<ComputerAwakeStatus> => ipcRenderer.invoke('agentAwake:getStatus'),
  onChanged: (callback: (status: ComputerAwakeStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ComputerAwakeStatus): void =>
      callback(status)
    ipcRenderer.on('agentAwake:changed', listener)
    return () => ipcRenderer.removeListener('agentAwake:changed', listener)
  }
}

export const codexAccountsBridge: PreloadApi['codexAccounts'] = {
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
}

export const claudeAccountsBridge: PreloadApi['claudeAccounts'] = {
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
}

export const cliBridge: PreloadApi['cli'] = {
  getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
  install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
  remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove'),
  getWslInstallStatus: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
    ipcRenderer.invoke('cli:getWslInstallStatus', args),
  installWsl: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
    ipcRenderer.invoke('cli:installWsl', args),
  removeWsl: (args?: { distro?: string | null }): Promise<CliInstallStatus> =>
    ipcRenderer.invoke('cli:removeWsl', args)
}

export const codexConfigSyncBridge: PreloadApi['codexConfigSync'] = {
  status: (): Promise<CodexConfigSyncStatus> => ipcRenderer.invoke('codexConfigSync:status')
}
