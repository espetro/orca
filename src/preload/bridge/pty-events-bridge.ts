import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { PtyModelRestoreNeededEvent } from '../../shared/pty-model-restore-marker'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'

export const ptyEventsBridge: Pick<
  PreloadApi['pty'],
  | 'onData'
  | 'onReplay'
  | 'onModelRestoreNeeded'
  | 'onSideEffect'
  | 'getSideEffectSnapshot'
  | 'onExit'
  | 'onSpawned'
  | 'onSerializeBufferRequest'
  | 'onClearBufferRequest'
> = {
  onData: (
    callback: (data: {
      id: string
      data: string
      seq?: number
      rawLength?: number
      transformed?: boolean
      background?: boolean
      droppedOutput?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string
        data: string
        seq?: number
        rawLength?: number
        transformed?: boolean
        background?: boolean
        droppedOutput?: boolean
      }
    ) => callback(data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onReplay: (callback: (data: { id: string; data: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
      callback(data)
    ipcRenderer.on('pty:replay', listener)
    return () => ipcRenderer.removeListener('pty:replay', listener)
  },
  /** Out-of-band signal that main dropped renderer-bound bytes (hidden-gate / pending cap); pane restores from the model snapshot.
   *  NOT on pty:data — an in-band marker is ambiguous with chunks fully stripped by OSC-9999 cleaning. */
  onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: PtyModelRestoreNeededEvent) =>
      callback(event)
    ipcRenderer.on('pty:modelRestoreNeeded', listener)
    return () => ipcRenderer.removeListener('pty:modelRestoreNeeded', listener)
  },
  /** Batched side-effect facts (title/bell/agent transitions) for local-main PTYs.
   *  Per-PTY in-order; deliberately NOT synced with pty:data (terminal-side-effect-authority.md). */
  onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, batch: TerminalSideEffectBatch) =>
      callback(batch)
    ipcRenderer.on('pty:sideEffect', listener)
    return () => ipcRenderer.removeListener('pty:sideEffect', listener)
  },
  /** Title-only replay snapshot on (re)attach — attention facts (bells/completions) never replay. */
  getSideEffectSnapshot: (id: string): Promise<TerminalSideEffectBatch | null> =>
    ipcRenderer.invoke('pty:sideEffectSnapshot', { id }),
  onExit: (
    callback: (data: {
      id: string
      code: number
      preserveRendererBinding?: boolean
      /** Which lifetime of `id` died; absent when the execution host predates the field. */
      incarnationId?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string
        code: number
        preserveRendererBinding?: boolean
        incarnationId?: string
      }
    ) => callback(data)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },
  onSpawned: (callback: (data: { id: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data)
    ipcRenderer.on('pty:spawned', listener)
    return () => ipcRenderer.removeListener('pty:spawned', listener)
  },
  onSerializeBufferRequest: (
    callback: (data: {
      requestId: string
      ptyId: string
      opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      }
    ) => callback(data)
    ipcRenderer.on('pty:serializeBuffer:request', listener)
    return () => ipcRenderer.removeListener('pty:serializeBuffer:request', listener)
  },
  onClearBufferRequest: (callback: (data: { ptyId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) => callback(data)
    ipcRenderer.on('pty:clearBuffer:request', listener)
    return () => ipcRenderer.removeListener('pty:clearBuffer:request', listener)
  }
}
