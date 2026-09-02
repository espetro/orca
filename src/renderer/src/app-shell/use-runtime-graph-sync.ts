import { useEffect } from 'react'
import { getSystemPrefersDarkSnapshot } from '../components/terminal-pane/use-system-prefers-dark'
import { useAppStore } from '../store'

/** Keeps the mobile runtime graph republished as the store's session-visible state changes. */
export function useRuntimeGraphSync(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)

  useEffect(() => {
    let cancelled = false
    void import('../runtime/sync-runtime-graph').then(({ setRuntimeGraphStoreStateGetter }) => {
      if (!cancelled) {
        setRuntimeGraphStoreStateGetter(useAppStore.getState)
      }
    })
    return () => {
      cancelled = true
      void import('../runtime/sync-runtime-graph').then(({ setRuntimeGraphStoreStateGetter }) => {
        setRuntimeGraphStoreStateGetter(null)
      })
    }
  }, [])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    void import('../runtime/sync-runtime-graph').then((sync) => {
      if (cancelled) {
        return
      }
      let previousKey = sync.getRuntimeMobileSessionSyncKey(useAppStore.getState())
      unsubscribe = useAppStore.subscribe((state, previousState) => {
        // Why: this fires on every store mutation; read the cached prefers-dark snapshot instead of allocating a throwaway MediaQueryList via matchMedia each tick.
        const systemPrefersDark = getSystemPrefersDarkSnapshot()
        // Why: skip the key build when every input is reference-unchanged; the gate mirrors every field getRuntimeMobileSessionSyncKey uses.
        if (
          sync.canSkipRuntimeMobileSessionSyncKeyBuild(
            state,
            previousState,
            systemPrefersDark,
            previousKey.systemPrefersDark
          )
        ) {
          return
        }
        const nextKey = sync.getRuntimeMobileSessionSyncKey(
          state,
          previousState,
          previousKey,
          systemPrefersDark
        )
        if (sync.runtimeMobileSessionSyncKeysEqual(nextKey, previousKey)) {
          return
        }
        previousKey = nextKey
        sync.scheduleRuntimeGraphSync()
      })
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void import('../runtime/sync-runtime-graph').then(({ setRuntimeGraphSyncEnabled }) => {
      if (!cancelled) {
        setRuntimeGraphSyncEnabled(workspaceSessionReady)
      }
    })
    return () => {
      cancelled = true
      void import('../runtime/sync-runtime-graph').then(({ setRuntimeGraphSyncEnabled }) => {
        setRuntimeGraphSyncEnabled(false)
      })
    }
  }, [workspaceSessionReady])
}
