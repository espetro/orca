import type { WebContents } from 'electron'

const AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS = 2_000

function resolveWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallbackValue: T
): Promise<{ value: T; timedOut: boolean }> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<{ value: T; timedOut: boolean }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ value: fallbackValue, timedOut: true }), timeoutMs)
  })
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false })),
    timeoutPromise
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}

function releaseAutomationVisibilityToken(renderer: WebContents, token: string): void {
  if (renderer.isDestroyed()) {
    return
  }
  renderer
    .executeJavaScript(
      `(function() {
        var bridge = window.__orcaBrowserAutomationVisibility;
        if (!bridge || typeof bridge.release !== 'function') return false;
        return bridge.release(${JSON.stringify(token)});
      })()`
    )
    .catch(() => {})
}

function cleanupLateAutomationVisibilityToken(
  renderer: WebContents,
  acquirePromise: Promise<unknown>
): void {
  acquirePromise
    .then((lateToken) => {
      if (typeof lateToken !== 'string' || lateToken.length === 0) {
        return
      }
      // Why: the lease is created before paint; if main's acquire timed out, release the late token so hidden webviews don't stay paintable.
      releaseAutomationVisibilityToken(renderer, lateToken)
    })
    .catch(() => {})
}

function createNoopRestoreForTimedOutAutomationAcquire(
  renderer: WebContents,
  acquirePromise: Promise<unknown>,
  timedOut: boolean
): () => void {
  if (timedOut) {
    cleanupLateAutomationVisibilityToken(renderer, acquirePromise)
  }
  return () => {}
}

function isAutomationVisibilityToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0
}

// Why: agent commands need a paintable webview for lazy-loading sites without stealing the user's visible tab.
export async function acquireAutomationVisibilityViaRenderer(
  renderer: WebContents,
  browserPageId: string
): Promise<() => void> {
  const acquirePromise = renderer
    .executeJavaScript(
      `(async function() {
            var bridge = window.__orcaBrowserAutomationVisibility;
            if (!bridge || typeof bridge.acquire !== 'function') return null;
            return await bridge.acquire(${JSON.stringify(browserPageId)});
          })()`
    )
    .catch(() => null)
  const { value: token, timedOut } = await resolveWithTimeout(
    acquirePromise,
    AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS,
    null
  )

  if (!isAutomationVisibilityToken(token)) {
    return createNoopRestoreForTimedOutAutomationAcquire(renderer, acquirePromise, timedOut)
  }

  return () => {
    releaseAutomationVisibilityToken(renderer, token)
  }
}
