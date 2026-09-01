import { ipcRenderer } from 'electron'

// Why: the sync checkpoint only stages; this joins its durable write so a
// navigating path can abort instead of losing the staged session.
export async function awaitBeforeUnloadCheckpoint(): Promise<void> {
  const result = (await ipcRenderer.invoke('app:await-before-unload-checkpoint')) as {
    ok?: unknown
  }
  if (result?.ok !== true) {
    throw new Error('Failed to persist renderer state before unload.')
  }
}
