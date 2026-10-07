import { app } from 'electron'

const DEV_PARENT_SHUTDOWN_GRACE_MS = 3000

let devParentShutdownRequested = false

function requestDevParentShutdown(): void {
  devParentShutdownRequested = true
  app.quit()

  const forceExitTimer = setTimeout(() => {
    // Why: app.quit() may stall on macOS quit handlers or window-close guards, so force-exit after a grace period to avoid a hung dev app.
    app.exit(0)
  }, DEV_PARENT_SHUTDOWN_GRACE_MS)

  forceExitTimer.unref()
}

export function isDevParentShutdownRequested(): boolean {
  return devParentShutdownRequested
}

export function resetDevParentShutdownRequestForTests(): void {
  devParentShutdownRequested = false
}

export function installDevParentDisconnectQuit(isDev: boolean): void {
  if (!isDev || typeof process.send !== 'function') {
    return
  }

  // Why: on macOS Ctrl+C can stop the electron-vite parent without closing the window, so quit when the IPC channel disconnects.
  process.once('disconnect', () => {
    requestDevParentShutdown()
  })
}

export function installDevParentWatchdog(isDev: boolean): void {
  if (!isDev) {
    return
  }

  const initialParentPid = process.ppid
  if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) {
    return
  }

  const timer = setInterval(() => {
    const parentPidChanged = process.ppid !== initialParentPid
    let parentMissing = false

    try {
      process.kill(initialParentPid, 0)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the 'code' in check directly left proves the errno field exists.
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      ) {
        parentMissing = true
      } else {
        throw error
      }
    }

    if (parentPidChanged || parentMissing) {
      clearInterval(timer)
      // Why: the dev runner spawns Electron without IPC, so on macOS Ctrl+C leaves Orca open; watch the parent PID to couple shutdown.
      requestDevParentShutdown()
    }
  }, 1000)

  timer.unref()
}

export function installDevParentSignalQuit(isDev: boolean): void {
  if (!isDev) {
    return
  }

  const onSignal = (): void => {
    // Why: run-electron-vite-dev forwards terminal shutdown signals here, so don't preserve the detached daemon for warm reattach.
    requestDevParentShutdown()
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}
