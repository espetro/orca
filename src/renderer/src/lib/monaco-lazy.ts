import type * as MonacoNS from 'monaco-editor'

export type MonacoModule = typeof MonacoNS

let monacoPromise: Promise<MonacoModule> | null = null
let loadedMonaco: MonacoModule | null = null

// Why: Monaco (~30-60MB heap) is only needed once an editor pane actually
// mounts. This promise singleton runs the one-time setup (workers, languages,
// loader.config) on first await and resolves to the shared module afterwards.
export function ensureMonaco(): Promise<MonacoModule> {
  monacoPromise ??= import('./monaco-setup').then((module) => {
    loadedMonaco = module.monaco
    return module.monaco
  })
  return monacoPromise
}

export function getLoadedMonaco(): MonacoModule | null {
  return loadedMonaco
}

// Why: diff components read EditorOption enums inside mount-time callbacks;
// by then ensureMonaco() has resolved (their editor only mounts afterwards).
export function requireLoadedMonaco(): MonacoModule {
  const m = loadedMonaco
  if (!m) {
    throw new Error('monaco accessed before ensureMonaco() resolved')
  }
  return m
}
