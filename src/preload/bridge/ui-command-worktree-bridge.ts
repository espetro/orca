import { ipcRenderer } from 'electron'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { KeybindingActionId } from '../../shared/keybindings'
import { createBrowserFindSubscriptions } from '../browser-find-subscriptions'
import type { Merged } from '../api-types'
import type { UiCommandEventApi } from '../api/ui-command-event-api'
import type { UiWindowApi } from '../api/ui-window-api'

const browserFindSubscriptions = createBrowserFindSubscriptions()

// Command/event dispatch members of the ui merged contract.
export const uiCommandWorktreeBridge: Pick<
  Merged<UiCommandEventApi & UiWindowApi>,
  | 'get'
  | 'set'
  | 'setWithAck'
  | 'recordFeatureInteraction'
  | 'onStateChanged'
  | 'onOpenSettings'
  | 'consumePendingOpenSettings'
  | 'onOpenSkillShare'
  | 'consumePendingSkillShare'
  | 'onOpenSetupGuide'
  | 'onOpenFeatureTour'
  | 'onOpenCrashReport'
  | 'onToggleLeftSidebar'
  | 'onToggleRightSidebar'
  | 'onToggleWorktreePalette'
  | 'onToggleFloatingTerminal'
  | 'onTerminalShortcutCaptured'
  | 'onOpenQuickOpen'
  | 'onToggleQuickCommandsMenu'
  | 'onOpenNewWorkspace'
  | 'onDeleteCurrentWorkspace'
  | 'onOpenWorkspaceBoard'
  | 'onOpenTasks'
  | 'onToggleAgentDashboard'
  | 'onJumpToWorktreeIndex'
  | 'onJumpToTabIndex'
  | 'onWorktreeHistoryNavigate'
  | 'onNewBrowserTab'
  | 'onNewMarkdownTab'
  | 'onNewSimulatorTab'
  | 'onRequestTabCreate'
  | 'replyTabCreate'
  | 'onRequestTabSetProfile'
  | 'replyTabSetProfile'
  | 'onRequestTabClose'
  | 'replyTabClose'
  | 'onNewTerminalTab'
  | 'onFocusBrowserAddressBar'
  | 'onFindInBrowserPage'
  | 'onReloadBrowserPage'
  | 'onBrowserHistoryNavigate'
> = {
  get: () => ipcRenderer.invoke('ui:get'),
  set: (args) => ipcRenderer.invoke('ui:set', args),
  // Same channel: the local invoke already rejects when main fails to apply.
  setWithAck: (args) => ipcRenderer.invoke('ui:set', args),
  recordFeatureInteraction: (id) => ipcRenderer.invoke('ui:recordFeatureInteraction', id),
  onStateChanged: (callback: (ui: PersistedUIState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ui: PersistedUIState): void => callback(ui)
    ipcRenderer.on('ui:stateChanged', listener)
    return () => ipcRenderer.removeListener('ui:stateChanged', listener)
  },
  onOpenSettings: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openSettings', listener)
    return () => ipcRenderer.removeListener('ui:openSettings', listener)
  },
  consumePendingOpenSettings: (): Promise<boolean> =>
    ipcRenderer.invoke('ui:consumePendingOpenSettings'),
  onOpenSkillShare: (callback: (shareId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, shareId: string): void => callback(shareId)
    ipcRenderer.on('ui:openSkillShare', listener)
    return () => ipcRenderer.removeListener('ui:openSkillShare', listener)
  },
  consumePendingSkillShare: (): Promise<string | null> =>
    ipcRenderer.invoke('ui:consumePendingSkillShare'),
  onOpenSetupGuide: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openSetupGuide', listener)
    return () => ipcRenderer.removeListener('ui:openSetupGuide', listener)
  },
  onOpenFeatureTour: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openFeatureTour', listener)
    return () => ipcRenderer.removeListener('ui:openFeatureTour', listener)
  },
  onOpenCrashReport: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openCrashReport', listener)
    return () => ipcRenderer.removeListener('ui:openCrashReport', listener)
  },
  onToggleLeftSidebar: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleLeftSidebar', listener)
    return () => ipcRenderer.removeListener('ui:toggleLeftSidebar', listener)
  },
  onToggleRightSidebar: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleRightSidebar', listener)
    return () => ipcRenderer.removeListener('ui:toggleRightSidebar', listener)
  },
  onToggleWorktreePalette: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleWorktreePalette', listener)
    return () => ipcRenderer.removeListener('ui:toggleWorktreePalette', listener)
  },
  onToggleFloatingTerminal: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleFloatingTerminal', listener)
    return () => ipcRenderer.removeListener('ui:toggleFloatingTerminal', listener)
  },
  onTerminalShortcutCaptured: (
    callback: (data: { actionId: KeybindingActionId }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { actionId: KeybindingActionId }) =>
      callback(data)
    ipcRenderer.on('ui:terminalShortcutCaptured', listener)
    return () => ipcRenderer.removeListener('ui:terminalShortcutCaptured', listener)
  },
  onOpenQuickOpen: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openQuickOpen', listener)
    return () => ipcRenderer.removeListener('ui:openQuickOpen', listener)
  },
  onToggleQuickCommandsMenu: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleQuickCommandsMenu', listener)
    return () => ipcRenderer.removeListener('ui:toggleQuickCommandsMenu', listener)
  },
  onOpenNewWorkspace: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openNewWorkspace', listener)
    return () => ipcRenderer.removeListener('ui:openNewWorkspace', listener)
  },
  onDeleteCurrentWorkspace: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:deleteCurrentWorkspace', listener)
    return () => ipcRenderer.removeListener('ui:deleteCurrentWorkspace', listener)
  },
  onOpenWorkspaceBoard: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openWorkspaceBoard', listener)
    return () => ipcRenderer.removeListener('ui:openWorkspaceBoard', listener)
  },
  onOpenTasks: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:openTasks', listener)
    return () => ipcRenderer.removeListener('ui:openTasks', listener)
  },
  onToggleAgentDashboard: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleAgentDashboard', listener)
    return () => ipcRenderer.removeListener('ui:toggleAgentDashboard', listener)
  },
  onJumpToWorktreeIndex: (callback: (index: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, index: number) => callback(index)
    ipcRenderer.on('ui:jumpToWorktreeIndex', listener)
    return () => ipcRenderer.removeListener('ui:jumpToWorktreeIndex', listener)
  },
  onJumpToTabIndex: (callback: (index: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, index: number) => callback(index)
    ipcRenderer.on('ui:jumpToTabIndex', listener)
    return () => ipcRenderer.removeListener('ui:jumpToTabIndex', listener)
  },
  onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'back' | 'forward') =>
      callback(direction)
    ipcRenderer.on('ui:worktreeHistoryNavigate', listener)
    return () => ipcRenderer.removeListener('ui:worktreeHistoryNavigate', listener)
  },
  onNewBrowserTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:newBrowserTab', listener)
    return () => ipcRenderer.removeListener('ui:newBrowserTab', listener)
  },
  onNewMarkdownTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:newMarkdownTab', listener)
    return () => ipcRenderer.removeListener('ui:newMarkdownTab', listener)
  },
  onNewSimulatorTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:newSimulatorTab', listener)
    return () => ipcRenderer.removeListener('ui:newSimulatorTab', listener)
  },
  onRequestTabCreate: (
    callback: (data: {
      requestId: string
      url: string
      worktreeId?: string
      browserPageId?: string
      sessionProfileId?: string | null
      sessionPartition?: string
      activate?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        url: string
        worktreeId?: string
        browserPageId?: string
        sessionProfileId?: string | null
        sessionPartition?: string
        activate?: boolean
      }
    ) => callback(data)
    ipcRenderer.on('browser:requestTabCreate', listener)
    return () => ipcRenderer.removeListener('browser:requestTabCreate', listener)
  },
  replyTabCreate: (reply: { requestId: string; browserPageId?: string; error?: string }): void => {
    ipcRenderer.send('browser:tabCreateReply', reply)
  },
  onRequestTabSetProfile: (
    callback: (data: {
      requestId: string
      browserPageId: string
      profileId: string
      sessionPartition?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        browserPageId: string
        profileId: string
        sessionPartition?: string
      }
    ) => callback(data)
    ipcRenderer.on('browser:requestTabSetProfile', listener)
    return () => ipcRenderer.removeListener('browser:requestTabSetProfile', listener)
  },
  replyTabSetProfile: (reply: { requestId: string; error?: string }): void => {
    ipcRenderer.send('browser:tabSetProfileReply', reply)
  },
  onRequestTabClose: (
    callback: (data: { requestId: string; tabId: string | null; worktreeId?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { requestId: string; tabId: string | null; worktreeId?: string }
    ) => callback(data)
    ipcRenderer.on('browser:requestTabClose', listener)
    return () => ipcRenderer.removeListener('browser:requestTabClose', listener)
  },
  replyTabClose: (reply: {
    requestId: string
    error?: string
    code?: 'browser_tab_not_found'
  }): void => {
    ipcRenderer.send('browser:tabCloseReply', reply)
  },
  onNewTerminalTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:newTerminalTab', listener)
    return () => ipcRenderer.removeListener('ui:newTerminalTab', listener)
  },
  onFocusBrowserAddressBar: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:focusBrowserAddressBar', listener)
    return () => ipcRenderer.removeListener('ui:focusBrowserAddressBar', listener)
  },
  onFindInBrowserPage: browserFindSubscriptions.subscribe,
  onReloadBrowserPage: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:reloadBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:reloadBrowserPage', listener)
  },
  onBrowserHistoryNavigate: (callback: (direction: 'back' | 'forward') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'back' | 'forward'): void =>
      callback(direction)
    ipcRenderer.on('ui:browserHistoryNavigate', listener)
    return () => ipcRenderer.removeListener('ui:browserHistoryNavigate', listener)
  }
}
