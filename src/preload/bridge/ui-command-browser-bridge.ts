import { ipcRenderer } from 'electron'
import type { Merged } from '../api-types'
import type { UiCommandEventApi } from '../api/ui-command-event-api'
import type { UiWindowApi } from '../api/ui-window-api'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../shared/worktree/launch-types'
import type {
  SleepingAgentLaunchConfig,
  AgentProviderSessionMetadata
} from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  RuntimeTerminalCreateRequestPayload,
  RuntimeTerminalPresentation
} from '../../shared/runtime-types'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'

// uiCommandBrowserBridge members of the ui merged contract.
export const uiCommandBrowserBridge: Pick<
  Merged<UiCommandEventApi & UiWindowApi>,
  | 'onZoomBrowserPage'
  | 'onHardReloadBrowserPage'
  | 'onCloseActiveTab'
  | 'onCloseFloatingItem'
  | 'onSelectFloatingIndex'
  | 'onSwitchTab'
  | 'onSwitchTabAcrossAllTypes'
  | 'onSwitchRecentTab'
  | 'onSwitchTerminalTab'
  | 'onCtrlTabKeyDown'
  | 'onCtrlTabKeyUp'
  | 'onToggleStatusBar'
  | 'onExportPdfRequested'
  | 'onAppMenuPaste'
  | 'onAppMenuSelectionAction'
  | 'onEditableContextPaste'
  | 'onDictationKeyDown'
  | 'onActivateWorktree'
  | 'onCreateTerminal'
  | 'onRequestTerminalCreate'
> = {
  onZoomBrowserPage: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
      callback(direction)
    ipcRenderer.on('ui:zoomBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:zoomBrowserPage', listener)
  },
  onHardReloadBrowserPage: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:hardReloadBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:hardReloadBrowserPage', listener)
  },
  onCloseActiveTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:closeActiveTab', listener)
    return () => ipcRenderer.removeListener('ui:closeActiveTab', listener)
  },
  onCloseFloatingItem: (callback: (payload: { sourceId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sourceId: string }) =>
      callback(payload)
    ipcRenderer.on('ui:closeFloatingItem', listener)
    return () => ipcRenderer.removeListener('ui:closeFloatingItem', listener)
  },
  onSelectFloatingIndex: (callback: (payload: { index: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { index: number }) =>
      callback(payload)
    ipcRenderer.on('ui:selectFloatingIndex', listener)
    return () => ipcRenderer.removeListener('ui:selectFloatingIndex', listener)
  },
  onSwitchTab: (callback: (direction: 1 | -1) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
    ipcRenderer.on('ui:switchTab', listener)
    return () => ipcRenderer.removeListener('ui:switchTab', listener)
  },
  onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
    ipcRenderer.on('ui:switchTabAcrossAllTypes', listener)
    return () => ipcRenderer.removeListener('ui:switchTabAcrossAllTypes', listener)
  },
  onSwitchRecentTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:switchRecentTab', listener)
    return () => ipcRenderer.removeListener('ui:switchRecentTab', listener)
  },
  onSwitchTerminalTab: (callback: (direction: 1 | -1) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
    ipcRenderer.on('ui:switchTerminalTab', listener)
    return () => ipcRenderer.removeListener('ui:switchTerminalTab', listener)
  },
  onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { shiftKey: boolean }) =>
      callback(data)
    ipcRenderer.on('ui:ctrlTabKeyDown', listener)
    return () => ipcRenderer.removeListener('ui:ctrlTabKeyDown', listener)
  },
  onCtrlTabKeyUp: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:ctrlTabKeyUp', listener)
    return () => ipcRenderer.removeListener('ui:ctrlTabKeyUp', listener)
  },
  onToggleStatusBar: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleStatusBar', listener)
    return () => ipcRenderer.removeListener('ui:toggleStatusBar', listener)
  },
  onExportPdfRequested: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('export:requestPdf', listener)
    return () => ipcRenderer.removeListener('export:requestPdf', listener)
  },
  onAppMenuPaste: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:appMenuPaste', listener)
    return () => ipcRenderer.removeListener('ui:appMenuPaste', listener)
  },
  onAppMenuSelectionAction: (callback: (action: 'copy' | 'select-all') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: 'copy' | 'select-all'): void =>
      callback(action)
    ipcRenderer.on('ui:appMenuSelectionAction', listener)
    return () => ipcRenderer.removeListener('ui:appMenuSelectionAction', listener)
  },
  onEditableContextPaste: (callback: (data: { plainTextOnly: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { plainTextOnly: boolean }): void =>
      callback({ plainTextOnly: data?.plainTextOnly === true })
    ipcRenderer.on('ui:editableContextPaste', listener)
    return () => ipcRenderer.removeListener('ui:editableContextPaste', listener)
  },
  onDictationKeyDown: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:dictationKeyDown', listener)
    return () => ipcRenderer.removeListener('ui:dictationKeyDown', listener)
  },
  onActivateWorktree: (
    callback: (data: {
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: { command: string; env?: Record<string, string> }
      defaultTabs?: WorktreeDefaultTabsLaunch
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        repoId: string
        worktreeId: string
        setup?: WorktreeSetupLaunch
        startup?: { command: string; env?: Record<string, string> }
        defaultTabs?: WorktreeDefaultTabsLaunch
      }
    ) => callback(data)
    ipcRenderer.on('ui:activateWorktree', listener)
    return () => ipcRenderer.removeListener('ui:activateWorktree', listener)
  },
  onCreateTerminal: (
    callback: (data: {
      requestId?: string
      worktreeId: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      title?: string
      ptyId?: string
      activate?: boolean
      focus?: boolean
      presentation?: RuntimeTerminalPresentation
      surfaceOwner?: false
      tabId?: string
      leafId?: string
      splitFromLeafId?: string
      splitDirection?: 'horizontal' | 'vertical'
      splitTelemetrySource?: TerminalPaneSplitSource
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId?: string
        worktreeId: string
        command?: string
        cwd?: string
        env?: Record<string, string>
        launchConfig?: SleepingAgentLaunchConfig
        resumeProviderSession?: AgentProviderSessionMetadata
        launchToken?: string
        launchAgent?: TuiAgent
        viewMode?: 'terminal' | 'chat'
        title?: string
        ptyId?: string
        activate?: boolean
        focus?: boolean
        presentation?: RuntimeTerminalPresentation
        surfaceOwner?: false
        tabId?: string
        leafId?: string
        splitFromLeafId?: string
        splitDirection?: 'horizontal' | 'vertical'
        splitTelemetrySource?: TerminalPaneSplitSource
      }
    ) => callback(data)
    ipcRenderer.on('ui:createTerminal', listener)
    return () => ipcRenderer.removeListener('ui:createTerminal', listener)
  },
  onRequestTerminalCreate: (
    callback: (data: RuntimeTerminalCreateRequestPayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: RuntimeTerminalCreateRequestPayload
    ) => callback(data)
    ipcRenderer.on('terminal:requestTabCreate', listener)
    return () => ipcRenderer.removeListener('terminal:requestTabCreate', listener)
  }
}
