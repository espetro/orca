import { useCallback, useEffect, useRef } from 'react'
import { requireLoadedMonaco } from '@/lib/monaco-lazy'
import type { MonacoModule } from '@/lib/monaco-lazy'
import { disposeUnattachedMonacoModelPaths } from './diff-monaco-model-disposal'

// Why: model disposal runs only after diff editors have mounted (their models
// exist), so Monaco is guaranteed loaded; requireLoadedMonaco stays sync.
const monaco = (): MonacoModule => requireLoadedMonaco()

// Why: virtualized section rows own Monaco model paths for their lifetime;
// dispose on unmount/collapse so remounts do not leak detached models.
export function useDiffSectionModelLifecycle(params: {
  modelPathBase: string
  collapsed: boolean
}): {
  disposeDiffModels: () => void
  setSectionRootNode: (node: HTMLDivElement | null) => void
} {
  const disposeDiffModels = useCallback(() => {
    window.setTimeout(() => {
      disposeUnattachedMonacoModelPaths(monaco(), [
        `${params.modelPathBase}:original`,
        `${params.modelPathBase}:modified`
      ])
    }, 0)
  }, [params.modelPathBase])
  const disposeDiffModelsRef = useRef(disposeDiffModels)
  // Keep callback-ref dispose path on the latest disposer without render-time mutation.
  useEffect(() => {
    disposeDiffModelsRef.current = disposeDiffModels
  }, [disposeDiffModels])

  const setSectionRootNode = useCallback((node: HTMLDivElement | null): void => {
    if (node) {
      return
    }
    disposeDiffModelsRef.current()
  }, [])

  useEffect(() => {
    if (params.collapsed) {
      disposeDiffModels()
    }
  }, [disposeDiffModels, params.collapsed])

  return { disposeDiffModels, setSectionRootNode }
}
