import { ipcMain } from 'electron'
import { getResourceRecorder } from './resource-recorder'

export const RESOURCE_DUMP_CHANNEL = 'resources:dump'
export const RESOURCE_MARK_CHANNEL = 'resources:mark'

export function installResourceRecorderIpcHandlers(): void {
  ipcMain.handle(RESOURCE_DUMP_CHANNEL, () => {
    const recorder = getResourceRecorder()
    if (!recorder) {
      throw new Error('recorder-disabled')
    }
    return recorder.dump()
  })
  ipcMain.handle(RESOURCE_MARK_CHANNEL, (_event, name: string) => {
    const recorder = getResourceRecorder()
    if (!recorder) {
      throw new Error('recorder-disabled')
    }
    recorder.mark(name)
  })
}
