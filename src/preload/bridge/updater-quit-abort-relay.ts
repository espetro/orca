import { ipcRenderer } from 'electron'
import { ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT } from '../../shared/updater-renderer-events'
import { createUpdaterQuitAbortRelay } from '../../shared/renderer-restart-preparation'
import { registerRendererRestartIpcRelays } from '../renderer-restart-wiring'

export const updaterQuitAbortRelay = createUpdaterQuitAbortRelay(
  window,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
)

registerRendererRestartIpcRelays(ipcRenderer, window, updaterQuitAbortRelay)
