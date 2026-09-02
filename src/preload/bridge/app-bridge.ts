import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { AppIdentity } from '../../shared/app-identity'
import type { MacCapturedDigitRowChord } from '../../shared/macos-symbolic-hotkeys'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type { WriteTerminalRenderDesyncEvidenceArgs } from '../../shared/terminal-render-desync-evidence'
import {
  KEYBOARD_LAYOUT_CHANGED_CHANNEL,
  type KeyboardLayoutChangeEvent
} from '../../shared/keyboard-layout-events'
import { awaitBeforeUnloadCheckpoint } from './before-unload-checkpoint'
import { prepareAndInvokeAppRestart } from '../renderer-restart-wiring'

const startupDiagnosticsEnabled = process.env.ORCA_STARTUP_DIAGNOSTICS === '1'

export const appBridge: PreloadApi['app'] = {
  awaitBeforeUnloadCheckpoint: () => awaitBeforeUnloadCheckpoint(),
  getIdentity: (): Promise<AppIdentity> => ipcRenderer.invoke('app:getIdentity'),
  getFeatureWallAssetBaseUrl: (): Promise<string> =>
    ipcRenderer.invoke('app:getFeatureWallAssetBaseUrl'),
  relaunch: (): Promise<void> =>
    prepareAndInvokeAppRestart(
      window,
      () => ipcRenderer.invoke('app:relaunch'),
      awaitBeforeUnloadCheckpoint
    ),
  restart: (): Promise<void> =>
    prepareAndInvokeAppRestart(
      window,
      () => ipcRenderer.invoke('app:restart'),
      awaitBeforeUnloadCheckpoint
    ),
  reload: (): Promise<void> =>
    prepareAndInvokeAppRestart(
      window,
      () => ipcRenderer.invoke('app:reload'),
      awaitBeforeUnloadCheckpoint
    ),
  stageBeforeUnloadSync: (args: Parameters<PreloadApi['app']['stageBeforeUnloadSync']>[0]) => {
    const result = ipcRenderer.sendSync('app:stage-before-unload-sync', args) as {
      ok?: unknown
    }
    if (result?.ok !== true) {
      throw new Error('Failed to stage renderer state before unload.')
    }
  },

  awaitFirstWindowStartupServices: (): Promise<void> =>
    ipcRenderer.invoke('app:awaitFirstWindowStartupServices'),
  prepareTerminalStartupRestoration: (): Promise<void> =>
    ipcRenderer.invoke('app:prepareTerminalStartupRestoration'),
  recoverLegacyWorkerTerminalsForRendererStartup: (): Promise<void> =>
    ipcRenderer.invoke('app:recoverLegacyWorkerTerminalsForRendererStartup'),
  startupDiagnostic: (event: string, details?: Record<string, unknown>): Promise<void> =>
    startupDiagnosticsEnabled
      ? ipcRenderer.invoke('app:startupDiagnostic', event, details)
      : Promise.resolve(),
  // Why: macOS input mode (or layout ID) so keyboard workarounds can tell CJK/compose layouts from US QWERTY (issue #1205); null on non-Darwin or read failure.
  getKeyboardInputSourceId: (): Promise<string | null> =>
    ipcRenderer.invoke('app:getKeyboardInputSourceId'),
  getMacCapturedDigitRowChords: (): Promise<MacCapturedDigitRowChord[]> =>
    ipcRenderer.invoke('app:getMacCapturedDigitRowChords'),
  getKeyboardLayoutSnapshot: () => ipcRenderer.invoke('app:getKeyboardLayoutSnapshot'),
  onKeyboardLayoutChanged: (callback: (event: KeyboardLayoutChangeEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: KeyboardLayoutChangeEvent): void =>
      callback(event)
    ipcRenderer.on(KEYBOARD_LAYOUT_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(KEYBOARD_LAYOUT_CHANGED_CHANNEL, listener)
  },
  setUnreadDockBadgeCount: (count: number): Promise<void> =>
    ipcRenderer.invoke('app:setUnreadDockBadgeCount', count),
  getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest): Promise<string> =>
    ipcRenderer.invoke('app:getFloatingTerminalCwd', args),
  getFloatingMarkdownDirectory: (): Promise<string> =>
    ipcRenderer.invoke('app:getFloatingMarkdownDirectory'),
  pickFloatingMarkdownDocument: (): Promise<MarkdownDocument | null> =>
    ipcRenderer.invoke('app:pickFloatingMarkdownDocument'),
  pickFloatingWorkspaceDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('app:pickFloatingWorkspaceDirectory'),
  writeTerminalRenderDesyncEvidence: (args: WriteTerminalRenderDesyncEvidenceArgs) =>
    ipcRenderer.invoke('terminal:writeRenderDesyncEvidence', args)
}
