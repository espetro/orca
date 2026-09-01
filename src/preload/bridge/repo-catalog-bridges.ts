import { ipcRenderer } from 'electron'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../../shared/host-repo-catalog-contract'
import type { NestedRepoScanResult } from '../../shared/project-group-types'
import type { BaseRefDefaultResult, BaseRefSearchResult } from '../../shared/repo-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PreloadApi } from '../api-types'

export const reposBridge: PreloadApi['repos'] = {
  list: () => ipcRenderer.invoke('repos:list'),

  listForExecutionHost: (args: ListReposForExecutionHostArgs): Promise<HostRepoCatalogSnapshot> =>
    ipcRenderer.invoke('repos:listForExecutionHost', args),

  add: (args) => ipcRenderer.invoke('repos:add', args),

  addRemote: (args) => ipcRenderer.invoke('repos:addRemote', args),

  create: (args) => ipcRenderer.invoke('repos:create', args),

  isGitAvailable: (): Promise<boolean> => ipcRenderer.invoke('repos:isGitAvailable'),

  getDefaultCreateProjectParent: (): Promise<string> =>
    ipcRenderer.invoke('repos:getDefaultCreateProjectParent'),

  remove: (args) => ipcRenderer.invoke('repos:remove', args),

  removeForHost: (args) => ipcRenderer.invoke('repos:removeForHost', args),

  reorder: (args) => ipcRenderer.invoke('repos:reorder', args),

  reorderForHost: (args) => ipcRenderer.invoke('repos:reorderForHost', args),

  update: (args) => ipcRenderer.invoke('repos:update', args),

  pickFolder: () => ipcRenderer.invoke('repos:pickFolder'),

  pickFolders: () => ipcRenderer.invoke('repos:pickFolders'),

  pickDirectory: () => ipcRenderer.invoke('repos:pickDirectory'),

  clone: (args) => ipcRenderer.invoke('repos:clone', args),

  cloneRemote: (args) => ipcRenderer.invoke('repos:cloneRemote', args),

  createRemote: (args) => ipcRenderer.invoke('repos:createRemote', args),

  cloneAbort: () => ipcRenderer.invoke('repos:cloneAbort'),

  onCloneProgress: (callback: (data: { phase: string; percent: number }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { phase: string; percent: number }
    ) => callback(data)
    ipcRenderer.on('repos:clone-progress', listener)
    return () => ipcRenderer.removeListener('repos:clone-progress', listener)
  },

  getGitUsername: (args: { repoId: string }): Promise<string> =>
    ipcRenderer.invoke('repos:getGitUsername', args),

  getBaseRefDefault: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }): Promise<BaseRefDefaultResult> => ipcRenderer.invoke('repos:getBaseRefDefault', args),

  searchBaseRefs: (args: {
    repoId: string
    query: string
    limit?: number
    hostId?: ExecutionHostId
  }): Promise<string[]> => ipcRenderer.invoke('repos:searchBaseRefs', args),

  searchBaseRefDetails: (args: {
    repoId: string
    query: string
    limit?: number
    hostId?: ExecutionHostId
  }): Promise<BaseRefSearchResult[]> => ipcRenderer.invoke('repos:searchBaseRefDetails', args),

  onChanged: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('repos:changed', listener)
    return () => ipcRenderer.removeListener('repos:changed', listener)
  }
}

export const projectsBridge: PreloadApi['projects'] = {
  list: () => ipcRenderer.invoke('projects:list'),
  update: (args) => ipcRenderer.invoke('projects:update', args),
  listHostSetups: () => ipcRenderer.invoke('projectHostSetups:list'),
  createHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:create', args),
  setupExistingFolder: (args) => ipcRenderer.invoke('projectHostSetups:setupExistingFolder', args),
  updateHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:update', args),
  deleteHostSetup: (args) => ipcRenderer.invoke('projectHostSetups:delete', args)
}

export const projectGroupsBridge: PreloadApi['projectGroups'] = {
  list: () => ipcRenderer.invoke('projectGroups:list'),
  create: (args) => ipcRenderer.invoke('projectGroups:create', args),
  update: (args) => ipcRenderer.invoke('projectGroups:update', args),
  delete: (args) => ipcRenderer.invoke('projectGroups:delete', args),
  moveProject: (args) => ipcRenderer.invoke('projectGroups:moveProject', args),
  scanNested: (args) => ipcRenderer.invoke('projectGroups:scanNested', args),
  cancelNestedScan: (args) => ipcRenderer.invoke('projectGroups:cancelNestedScan', args),
  onNestedScanProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { scanId: string; scan: NestedRepoScanResult }
    ) => callback(data)
    ipcRenderer.on('projectGroups:scanNestedProgress', listener)
    return () => ipcRenderer.removeListener('projectGroups:scanNestedProgress', listener)
  },
  importNested: (args) => ipcRenderer.invoke('projectGroups:importNested', args)
}

export const folderWorkspacesBridge: PreloadApi['folderWorkspaces'] = {
  list: () => ipcRenderer.invoke('folderWorkspaces:list'),
  getPathStatus: (args) => ipcRenderer.invoke('folderWorkspaces:getPathStatus', args),
  create: (args) => ipcRenderer.invoke('folderWorkspaces:create', args),
  update: (args) => ipcRenderer.invoke('folderWorkspaces:update', args),
  delete: (args) => ipcRenderer.invoke('folderWorkspaces:delete', args)
}

export const sparsePresetsBridge: PreloadApi['sparsePresets'] = {
  list: (args) => ipcRenderer.invoke('sparsePresets:list', args),

  save: (args) => ipcRenderer.invoke('sparsePresets:save', args),

  remove: (args) => ipcRenderer.invoke('sparsePresets:remove', args),

  onChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) => callback(data)
    ipcRenderer.on('sparsePresets:changed', listener)
    return () => ipcRenderer.removeListener('sparsePresets:changed', listener)
  }
}
