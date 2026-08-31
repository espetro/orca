import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

let isShuttingDown = false
let forcedKillTimer: NodeJS.Timeout | null = null

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') {
    return 130
  }
  if (signal === 'SIGTERM') {
    return 143
  }
  return 1
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return
  }

  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    taskkill.unref()
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code !== 'ESRCH') {
      throw error
    }
  }
}

function beginShutdown(child: ChildProcess, signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return
  }
  isShuttingDown = true

  terminateChild(child, signal)
  forcedKillTimer = setTimeout(() => {
    terminateChild(child, 'SIGKILL')
  }, 5000)
}

/** Registers SIGINT/SIGTERM teardown and exit-code propagation for the electron-vite child. */
export function wireDevRunnerChildLifecycle(child: ChildProcess): void {
  process.on('SIGINT', () => {
    beginShutdown(child, 'SIGINT')
  })

  process.on('SIGTERM', () => {
    beginShutdown(child, 'SIGTERM')
  })

  child.on('error', (error) => {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer)
    }
    console.error(error)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer)
    }

    if (isShuttingDown) {
      process.exit(signalExitCode(signal ?? 'SIGINT'))
      return
    }

    if (signal) {
      process.exit(signalExitCode(signal))
      return
    }

    process.exit(code ?? 1)
  })
}

/** Spawns electron-vite detached (non-Windows) so Ctrl+C can kill the whole descendant tree. */
export function spawnElectronViteDev(
  electronViteCli: string,
  forwardedArgs: readonly string[]
): ChildProcess {
  return spawn(process.execPath, [electronViteCli, ...forwardedArgs], {
    stdio: 'inherit',
    env: process.env,
    // Why: electron-vite launches Electron as a descendant process. Giving the
    // dev runner its own process group lets Ctrl+C kill the whole tree on macOS
    // instead of leaving the Electron app alive after the terminal exits.
    detached: process.platform !== 'win32'
  })
}
