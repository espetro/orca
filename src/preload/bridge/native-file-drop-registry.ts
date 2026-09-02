import { ipcRenderer } from 'electron'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'

type NativeFileDropCallback = (data: NativeFileDropPayload) => void

const nativeFileDropCallbacks: NativeFileDropCallback[] = []
let nativeFileDropListenerRegistered = false

const onNativeFileDrop = (_event: Electron.IpcRendererEvent, data: NativeFileDropPayload): void => {
  for (const callback of Array.from(nativeFileDropCallbacks)) {
    callback(data)
  }
}

export function subscribeNativeFileDrop(callback: NativeFileDropCallback): () => void {
  nativeFileDropCallbacks.push(callback)
  if (!nativeFileDropListenerRegistered) {
    // Why: keep one real IPC listener and fan out locally — panes subscribe per split group, which would otherwise trip listener warnings.
    ipcRenderer.on('terminal:file-drop', onNativeFileDrop)
    nativeFileDropListenerRegistered = true
  }
  return () => {
    const callbackIndex = nativeFileDropCallbacks.indexOf(callback)
    if (callbackIndex !== -1) {
      nativeFileDropCallbacks.splice(callbackIndex, 1)
    }
    if (nativeFileDropCallbacks.length === 0 && nativeFileDropListenerRegistered) {
      ipcRenderer.removeListener('terminal:file-drop', onNativeFileDrop)
      nativeFileDropListenerRegistered = false
    }
  }
}
