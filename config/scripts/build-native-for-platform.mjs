#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

runPnpmScript('build:computer-macos')
runPnpmScript('build:keyboard-layout-macos')
runPnpmScript('build:notification-status-macos')
process.exit(0)

function runPnpmScript(scriptName) {
  // npm_execpath is a JS entry under npm but the @pnpm/exe Mach-O binary under
  // standalone pnpm; node cannot execute a binary, so exec it directly instead.
  const npmExecPath = process.env.npm_execpath
  const isBinaryEntry = Boolean(npmExecPath && !/\.[cm]?js$/.test(npmExecPath))
  let command
  let args
  if (!npmExecPath) {
    command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    args = ['run', scriptName]
  } else if (isBinaryEntry) {
    command = npmExecPath
    args = ['run', scriptName]
  } else {
    command = process.execPath
    args = [npmExecPath, 'run', scriptName]
  }
  const result = spawnSync(command, args, { stdio: 'inherit' })

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}
