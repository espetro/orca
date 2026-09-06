import { resolveExpectedTeardownScope } from '../crash-reporting/expected-teardown-state'
import { isQuittingForUpdate } from '../updater'
import type { ExpectedTeardownScope } from '../crash-reporting/process-gone-classification'

// Why: webContents-scoped auto-expiring flag so an intent can't leak to a later renderer load; `consume` clears on match for one-shot signals.
export function createWebContentsTimedFlag(defaultDurationMs = 10_000): {
  mark: (webContentsId: number, durationMs?: number) => void
  clear: (webContentsId?: number) => void
  matches: (webContentsId: number, options?: { consume?: boolean }) => boolean
} {
  let state: { webContentsId: number; until: number } | null = null
  return {
    mark(webContentsId, durationMs = defaultDurationMs) {
      state = { webContentsId, until: Date.now() + durationMs }
    },
    clear(webContentsId) {
      if (webContentsId === undefined || state?.webContentsId === webContentsId) {
        state = null
      }
    },
    matches(webContentsId, options) {
      if (!state || Date.now() > state.until) {
        state = null
        return false
      }
      if (state.webContentsId !== webContentsId) {
        return false
      }
      if (options?.consume) {
        state = null
      }
      return true
    }
  }
}

export type WebContentsReloadFlagsDeps = {
  getIsQuitting: () => boolean
}

export function createWebContentsReloadFlags(deps: WebContentsReloadFlagsDeps) {
  // Why: a reload intent must not leak to a later load; the recovery reload re-fires did-finish-load, so its flag spares live PTYs from the orphan sweep (#5787).
  const expectedRendererReload = createWebContentsTimedFlag()
  const recoveryReloadInFlight = createWebContentsTimedFlag()

  function markExpectedRendererReload(webContentsId: number, durationMs = 10_000): void {
    expectedRendererReload.mark(webContentsId, durationMs)
  }

  function clearExpectedRendererReload(webContentsId?: number): void {
    expectedRendererReload.clear(webContentsId)
  }

  function getExpectedTeardownScope(
    webContentsId?: number,
    includeSystemSessionEnd = true
  ): ExpectedTeardownScope {
    return resolveExpectedTeardownScope({
      isQuitting: deps.getIsQuitting(),
      isQuittingForUpdate: isQuittingForUpdate(),
      isExpectedRendererReload:
        webContentsId !== undefined && expectedRendererReload.matches(webContentsId),
      includeSystemSessionEnd
    })
  }

  function markRecoveryReloadInFlight(webContentsId: number, durationMs = 10_000): void {
    recoveryReloadInFlight.mark(webContentsId, durationMs)
  }

  function isRecoveryReloadInFlight(webContentsId: number): boolean {
    // Why: consume on read — the recovery reload fires exactly one did-finish-load, so a later genuine reload still sweeps orphaned PTYs.
    return recoveryReloadInFlight.matches(webContentsId, { consume: true })
  }

  return {
    markExpectedRendererReload,
    clearExpectedRendererReload,
    getExpectedTeardownScope,
    markRecoveryReloadInFlight,
    isRecoveryReloadInFlight
  }
}
