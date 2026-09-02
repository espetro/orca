import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
export const ptySerializerBridge: Pick<
  PreloadApi['pty'],
  | 'declarePendingPaneSerializer'
  | 'settlePaneSerializer'
  | 'clearPendingPaneSerializer'
  | 'reportRendererSerializerReady'
  | 'sendSerializedBuffer'
> = {
  declarePendingPaneSerializer: (paneKey: string): Promise<number> =>
    ipcRenderer.invoke('pty:declarePendingPaneSerializer', { paneKey }),
  settlePaneSerializer: (paneKey: string, gen: number): Promise<void> =>
    ipcRenderer.invoke('pty:settlePaneSerializer', { paneKey, gen }),
  clearPendingPaneSerializer: (paneKey: string, gen: number): Promise<void> =>
    ipcRenderer.invoke('pty:clearPendingPaneSerializer', { paneKey, gen }),
  reportRendererSerializerReady: (ptyId: string): Promise<void> =>
    ipcRenderer.invoke('pty:reportRendererSerializerReady', { ptyId }),
  sendSerializedBuffer: (
    requestId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      lastTitle?: string
      kittyKeyboardFlags?: number
    } | null
  ): void => {
    ipcRenderer.send('pty:serializeBuffer:response', { requestId, snapshot })
  }
}
