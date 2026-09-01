import { ipcRenderer } from 'electron'
import type { Merged } from '../api-types'
import type { UiCommandEventApi } from '../api/ui-command-event-api'
import type { UiWindowApi } from '../api/ui-window-api'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../../shared/mobile-markdown-document'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'

// uiCommandTerminalBridge members of the ui merged contract.
export const uiCommandTerminalBridge: Pick<
  Merged<UiCommandEventApi & UiWindowApi>,
  | 'onRequestTerminalTabMount'
  | 'replyTerminalCreate'
  | 'onSplitTerminal'
  | 'onRenameTerminal'
  | 'onFocusTerminal'
  | 'onFocusEditorTab'
  | 'onCloseSessionTab'
  | 'onSessionTabCloseRequest'
  | 'respondSessionTabClose'
  | 'onMoveSessionTab'
  | 'onOpenFileFromMobile'
  | 'onOpenDiffFromMobile'
  | 'onMobileMarkdownRequest'
  | 'respondMobileMarkdownRequest'
  | 'onCloseTerminal'
  | 'onTerminalTabCloseRequest'
  | 'respondTerminalTabClose'
  | 'onSleepWorktree'
  | 'onResumeSleepingAgents'
  | 'onTerminalZoom'
  | 'onSystemResumed'
> = {
  onRequestTerminalTabMount: (
    callback: (data: { worktreeId: string; tabId?: string; ptyId?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId: string; tabId?: string; ptyId?: string }
    ) => callback(data)
    ipcRenderer.on('terminal:requestTabMount', listener)
    return () => ipcRenderer.removeListener('terminal:requestTabMount', listener)
  },
  replyTerminalCreate: (reply: TerminalTabCreateReply): void => {
    ipcRenderer.send('terminal:tabCreateReply', reply)
  },
  onSplitTerminal: (
    callback: (data: {
      tabId: string
      paneRuntimeId: number
      direction: 'horizontal' | 'vertical'
      command?: string
      telemetrySource?: TerminalPaneSplitSource
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string
        paneRuntimeId: number
        direction: 'horizontal' | 'vertical'
        command?: string
        telemetrySource?: TerminalPaneSplitSource
      }
    ) => callback(data)
    ipcRenderer.on('ui:splitTerminal', listener)
    return () => ipcRenderer.removeListener('ui:splitTerminal', listener)
  },
  onRenameTerminal: (
    callback: (data: { tabId: string; title: string | null }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; title: string | null }
    ) => callback(data)
    ipcRenderer.on('ui:renameTerminal', listener)
    return () => ipcRenderer.removeListener('ui:renameTerminal', listener)
  },
  onFocusTerminal: (
    callback: (data: {
      tabId: string
      worktreeId: string
      leafId?: string | null
      ackPaneKeyOnSuccess?: string
      flashFocusedPane?: boolean
      scrollToBottomIfOutputSinceLastView?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string
        worktreeId: string
        leafId?: string | null
        ackPaneKeyOnSuccess?: string
        flashFocusedPane?: boolean
        scrollToBottomIfOutputSinceLastView?: boolean
      }
    ) => callback(data)
    ipcRenderer.on('ui:focusTerminal', listener)
    return () => ipcRenderer.removeListener('ui:focusTerminal', listener)
  },
  onFocusEditorTab: (
    callback: (data: { tabId: string; worktreeId: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; worktreeId: string }
    ) => callback(data)
    ipcRenderer.on('ui:focusEditorTab', listener)
    return () => ipcRenderer.removeListener('ui:focusEditorTab', listener)
  },
  onCloseSessionTab: (
    callback: (data: { tabId: string; worktreeId: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; worktreeId: string }
    ) => callback(data)
    ipcRenderer.on('ui:closeSessionTab', listener)
    return () => ipcRenderer.removeListener('ui:closeSessionTab', listener)
  },
  onSessionTabCloseRequest: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: Parameters<typeof callback>[0]
    ) => callback(request)
    ipcRenderer.on('ui:sessionTabCloseRequest', listener)
    return () => ipcRenderer.removeListener('ui:sessionTabCloseRequest', listener)
  },
  respondSessionTabClose: (response) => {
    ipcRenderer.send('ui:sessionTabCloseResponse', response)
  },
  onMoveSessionTab: (
    callback: (data: { worktreeId: string } & RuntimeMobileSessionTabMove) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId: string } & RuntimeMobileSessionTabMove
    ) => callback(data)
    ipcRenderer.on('ui:moveSessionTab', listener)
    return () => ipcRenderer.removeListener('ui:moveSessionTab', listener)
  },
  onOpenFileFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      runtimeEnvironmentId?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        filePath: string
        relativePath: string
        runtimeEnvironmentId?: string
      }
    ) => callback(data)
    ipcRenderer.on('ui:openFileFromMobile', listener)
    return () => ipcRenderer.removeListener('ui:openFileFromMobile', listener)
  },
  onOpenDiffFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      staged: boolean
      runtimeEnvironmentId?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        filePath: string
        relativePath: string
        staged: boolean
        runtimeEnvironmentId?: string
      }
    ) => callback(data)
    ipcRenderer.on('ui:openDiffFromMobile', listener)
    return () => ipcRenderer.removeListener('ui:openDiffFromMobile', listener)
  },
  onMobileMarkdownRequest: (
    callback: (request: RuntimeMobileMarkdownRequest) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: RuntimeMobileMarkdownRequest) =>
      callback(request)
    ipcRenderer.on('ui:mobileMarkdownRequest', listener)
    return () => ipcRenderer.removeListener('ui:mobileMarkdownRequest', listener)
  },
  respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse): void => {
    ipcRenderer.send('ui:mobileMarkdownResponse', response)
  },
  onCloseTerminal: (
    callback: (data: { tabId: string; paneRuntimeId?: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; paneRuntimeId?: number }
    ) => callback(data)
    ipcRenderer.on('ui:closeTerminal', listener)
    return () => ipcRenderer.removeListener('ui:closeTerminal', listener)
  },
  onTerminalTabCloseRequest: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: Parameters<typeof callback>[0]
    ) => callback(request)
    ipcRenderer.on('ui:terminalTabCloseRequest', listener)
    return () => ipcRenderer.removeListener('ui:terminalTabCloseRequest', listener)
  },
  respondTerminalTabClose: (response) => {
    ipcRenderer.send('ui:terminalTabCloseResponse', response)
  },
  onSleepWorktree: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
      callback(data)
    ipcRenderer.on('ui:sleepWorktree', listener)
    return () => ipcRenderer.removeListener('ui:sleepWorktree', listener)
  },
  onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
      callback(data)
    ipcRenderer.on('ui:resumeSleepingAgents', listener)
    return () => ipcRenderer.removeListener('ui:resumeSleepingAgents', listener)
  },
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
      callback(direction)
    ipcRenderer.on('terminal:zoom', listener)
    return () => ipcRenderer.removeListener('terminal:zoom', listener)
  },
  onSystemResumed: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('system:resumed', listener)
    return () => ipcRenderer.removeListener('system:resumed', listener)
  },
  /** Desktop custom titlebar only: minimize via renderer-drawn window controls. */
}
