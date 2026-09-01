import { ipcRenderer } from 'electron'
import type { WorkspaceCleanupScanProgress } from '../../shared/workspace-cleanup'
import type { WorkspaceSpaceScanProgress } from '../../shared/workspace-space-types'
import type { WorkspacePortAdvertisedUrlChangedEvent } from '../../shared/workspace-ports'
import type { PreloadApi } from '../api-types'

export const workspaceCleanupBridge: PreloadApi['workspaceCleanup'] = {
  scan: (args, onProgress) => {
    if (!onProgress) {
      return ipcRenderer.invoke('workspaceCleanup:scan', args)
    }
    const scanId = args?.scanId ?? crypto.randomUUID()
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: WorkspaceCleanupScanProgress
    ): void => {
      if (progress.scanId === scanId) {
        onProgress(progress)
      }
    }
    ipcRenderer.on('workspaceCleanup:scanProgress', listener)
    return ipcRenderer
      .invoke('workspaceCleanup:scan', { ...args, scanId })
      .finally(() => ipcRenderer.removeListener('workspaceCleanup:scanProgress', listener))
  },
  cancelScan: (scanId) => ipcRenderer.invoke('workspaceCleanup:cancelScan', scanId),
  getCachedScan: () => ipcRenderer.invoke('workspaceCleanup:getCachedScan'),
  dismiss: (args) => ipcRenderer.invoke('workspaceCleanup:dismiss', args),
  clearDismissals: () => ipcRenderer.invoke('workspaceCleanup:clearDismissals'),
  hasKillableLocalProcesses: (args) =>
    ipcRenderer.invoke('workspaceCleanup:hasKillableLocalProcesses', args),
  beginRemovalSnapshotPruneBatch: (args) =>
    ipcRenderer.invoke('workspaceCleanup:beginRemovalSnapshotPruneBatch', args),
  recordRemovalSnapshotPrune: (args) =>
    ipcRenderer.invoke('workspaceCleanup:recordRemovalSnapshotPrune', args),
  finishRemovalSnapshotPruneBatch: (args) =>
    ipcRenderer.invoke('workspaceCleanup:finishRemovalSnapshotPruneBatch', args)
}

export const workspaceSpaceBridge: PreloadApi['workspaceSpace'] = {
  analyze: () => ipcRenderer.invoke('workspaceSpace:analyze'),
  getCachedAnalysis: () => ipcRenderer.invoke('workspaceSpace:getCachedAnalysis'),
  cancel: () => ipcRenderer.invoke('workspaceSpace:cancel'),
  onProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: WorkspaceSpaceScanProgress
    ): void => callback(progress)
    ipcRenderer.on('workspaceSpace:progress', listener)
    return () => ipcRenderer.removeListener('workspaceSpace:progress', listener)
  }
}

export const workspacePortsBridge: PreloadApi['workspacePorts'] = {
  scan: (args) => ipcRenderer.invoke('workspacePorts:scan', args),
  kill: (args) => ipcRenderer.invoke('workspacePorts:kill', args),
  onAdvertisedUrlChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      event: WorkspacePortAdvertisedUrlChangedEvent
    ): void => callback(event)
    ipcRenderer.on('workspacePorts:advertised-url-changed', listener)
    return () => ipcRenderer.removeListener('workspacePorts:advertised-url-changed', listener)
  }
}
