import process from 'node:process'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runWithTimeout(label, action, timeoutMs) {
  const actionPromise = Promise.resolve().then(action)
  actionPromise.catch(() => undefined)
  // Why: Playwright protocol calls can remain pending when the Wayland GPU
  // path wedges, so direct renderer actions need an independent deadline.
  const result = await Promise.race([
    actionPromise.then((value) => ({ timedOut: false, value })),
    delay(timeoutMs).then(() => ({ timedOut: true, value: null }))
  ])
  if (result.timedOut) {
    throw new Error(`Timed out during ${label} after ${timeoutMs}ms.`)
  }
  return result.value
}

export function createPhaseLogger({ startedAt, onPhase }) {
  return (phase, details = '') => {
    onPhase(phase)
    const suffix = details ? ` ${details}` : ''
    console.log(`[wayland-gpu] phase=${phase} elapsedMs=${Date.now() - startedAt}${suffix}`)
  }
}

export function startValidationWatchdog({
  timeoutMs,
  onTimeout
}: {
  timeoutMs: number
  onTimeout: () =>
    | string
    | number
    | void
    | null
    | undefined
    | Promise<string | number | void | null | undefined>
}) {
  const timer = setTimeout(async () => {
    const exitCode = await onTimeout()
    process.exit(exitCode ?? 0)
  }, timeoutMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
