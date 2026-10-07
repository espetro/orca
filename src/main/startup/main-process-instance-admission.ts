import { app } from 'electron'
import { getCanonicalUserDataPath } from '../persistence'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'
import {
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock,
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
} from './single-instance-lock'
import { acquireDesktopProfileLockOrExplain } from './main-process-preflight-failure'
import { logStartupDiagnostic } from './startup-diagnostics'
import { mainProcessState as state } from './main-process-state'

export function admitDesktopInstance(options: {
  isDev: boolean
  isServeMode: boolean
  requestDesktopActivation: (argv?: readonly string[]) => void
}):
  | { proceed: false }
  | { proceed: true; profileStateAdmission: ProfileStateRuntimeAdmission | undefined } {
  // Why: acquire AFTER configureDevUserDataPath — Electron derives lock identity from `userData`, so dev/packaged lock in separate namespaces.
  // Why dev locks too: two processes on one profile corrupt its stores (PR #1326 / #1312); parallel `pnpm dev` needs ORCA_DEV_USER_DATA_PATH per copy.
  const bypass = shouldBypassSingleInstanceLock({
    isDev: options.isDev,
    isServeMode: options.isServeMode
  })
  const skip = shouldSkipSingleInstanceLock({
    isDev: options.isDev,
    isServeMode: options.isServeMode
  })
  if (bypass) {
    // Why: diagnostic escape hatch for macOS builds where Electron reports a false lock loss before any app logs exist.
    logSingleInstanceLockBypass()
  }
  const hasLock = skip || bypass || acquireSingleInstanceLock(app, options.requestDesktopActivation)
  if (state.startupDiagnosticsEnabled) {
    logStartupDiagnostic('single-instance-lock-result', {
      acquired: hasLock,
      bypassed: bypass,
      skippedForE2E: skip
    })
  }
  if (!hasLock) {
    // Why: a false-negative lock loss otherwise looks like a silent crash on packaged macOS; `open --stderr` can capture this line.
    // In dev it is the line `pnpm dev` prints before exiting.
    logSingleInstanceLockFailure({
      isDevDesktop: options.isDev && !options.isServeMode,
      userDataPath: app.getPath('userData')
    })
    // Why: a graceful quit is deferred pre-ready, so this launch would still walk into Linux display init and SIGSEGV (#11935).
    app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    return { proceed: false }
  }
  // Why after Electron's lock: that one fences other desktops; this one fences orcad `orca serve`.
  if (!skip && !bypass && !acquireDesktopProfileLockOrExplain(getCanonicalUserDataPath())) {
    return { proceed: false }
  }
  return {
    proceed: true,
    profileStateAdmission: acquireProfileStateRuntimeAdmission(getCanonicalUserDataPath())
  }
}
