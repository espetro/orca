import { ipcRenderer, webUtils } from 'electron'
import {
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createNativeFileDropPayload,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  NATIVE_FILE_DROP_MAX_PATHS,
  resolveNativeFileDropPath,
  type NativeDropResolution,
  type NativeFileDropPathEntry
} from '../shared/native-file-drop'

/**
 * Classify which UI surface the native OS drop landed on, and for file-explorer drops
 * extract the destination directory from `data-native-file-drop-dir`.
 *
 * Why: preload consumes the native `drop` before React can read paths, so it must capture
 * the destination dir now — otherwise the renderer can't tell "root" from "inside this folder".
 */
function resolveNativeFileDrop(event: DragEvent): NativeDropResolution | null {
  const pathEntries: NativeFileDropPathEntry[] = []
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement) {
      pathEntries.push({
        nativeFileDropTarget: entry.dataset.nativeFileDropTarget,
        nativeFileDropDir: entry.dataset.nativeFileDropDir,
        terminalTabId: entry.dataset.terminalTabId,
        terminalPaneLeafId: entry.dataset.terminalPaneLeafId ?? entry.dataset.leafId
      })
    }
  }
  return resolveNativeFileDropPath(pathEntries)
}

// File drag-and-drop lives in preload because webUtils (File→path) is only available in the preload/main world, not the renderer's isolated world.
export function registerNativeFileDropListeners(): void {
  document.addEventListener(
    'dragover',
    (e) => {
      // Let in-app drags through to React handlers (their own dropEffect); only override for native OS file drops.
      if (e.dataTransfer && !hasNativeFileDragTypes(e.dataTransfer.types)) {
        return
      }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    },
    true
  )

  document.addEventListener(
    'drop',
    (e) => {
      // Let in-app drags (e.g. file explorer → terminal) through to React handlers
      if (e.dataTransfer?.types.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)) {
        return
      }

      e.preventDefault()
      e.stopPropagation()
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) {
        return
      }
      const resolution = resolveNativeFileDrop(e)

      // Why: reject oversized gestures by count before resolving every File object (path resolution is synchronous here).
      if (files.length > NATIVE_FILE_DROP_MAX_PATHS) {
        ipcRenderer.send(
          'terminal:file-dropped-from-preload',
          createRejectedNativeFileDropPayload({
            byteLength: 0,
            pathCount: files.length,
            reason: 'too-many-paths',
            status: 'rejected'
          })
        )
        return
      }

      const paths: string[] = []
      for (let i = 0; i < files.length; i++) {
        // webUtils.getPathForFile is the Electron 28+ replacement for File.path
        const filePath = webUtils.getPathForFile(files[i])
        if (filePath) {
          paths.push(filePath)
        }
      }

      if (paths.length === 0) {
        return
      }

      // Why: explorer marker present but no destination dir resolved → reject entirely, no editor fallback (fail-closed, design §7.1).
      if (resolution?.target === 'rejected') {
        return
      }

      const payload = createNativeFileDropPayload(resolution, paths)
      if (!payload) {
        return
      }
      // Why: emit exactly one native-drop event per gesture (the shared planner rejects oversized payloads without leaking path contents).
      ipcRenderer.send('terminal:file-dropped-from-preload', payload)
    },
    true
  )
}
