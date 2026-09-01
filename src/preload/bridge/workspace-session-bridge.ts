import { ipcRenderer } from 'electron'
import type { RemoteWorkspaceChangedEvent } from '../../shared/remote-workspace-types'
import type { PreloadApi } from '../api-types'

export const cacheBridge: PreloadApi['cache'] = {
  getGitHub: () => ipcRenderer.invoke('cache:getGitHub'),
  setGitHub: (args) => ipcRenderer.invoke('cache:setGitHub', args)
}

export const sessionBridge: PreloadApi['session'] = {
  // hostId is optional; main defaults it to 'local' so existing omitting call sites keep the local session partition.
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:read-terminal-scrollback-sync', args),
  /** Synchronous session save for beforeunload — blocks until flushed to disk. */
  setSync: (args, hostId) => {
    ipcRenderer.sendSync('session:set-sync', args, hostId)
  }
}

export const remoteWorkspaceBridge: PreloadApi['remoteWorkspace'] = {
  get: (args) => ipcRenderer.invoke('remoteWorkspace:get', args),
  setForConnectedTargets: (args) =>
    ipcRenderer.invoke('remoteWorkspace:setForConnectedTargets', args),
  listEnabledConnectedTargets: () =>
    ipcRenderer.invoke('remoteWorkspace:listEnabledConnectedTargets'),
  listConnectedClients: (args) => ipcRenderer.invoke('remoteWorkspace:listConnectedClients', args),
  clientId: () => ipcRenderer.invoke('remoteWorkspace:clientId'),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: RemoteWorkspaceChangedEvent) =>
      callback(data)
    ipcRenderer.on('remoteWorkspace:changed', listener)
    return () => ipcRenderer.removeListener('remoteWorkspace:changed', listener)
  }
}
