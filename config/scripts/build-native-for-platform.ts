#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  runNodeScript('config/scripts/build-windows-cli-launcher.ts')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

const exitCodes = await Promise.all(
  ['build:computer-macos', 'build:keyboard-layout-macos', 'build:notification-status-macos'].map(
    (scriptName) => runPnpmScript(scriptName)
  )
)
process.exit(Math.max(...exitCodes))

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
  const child = spawn(command, args, { stdio: 'inherit' })

  return new Promise<number>((resolve) => {
    child.on('error', () => resolve(1))
    child.on('close', (code, signal) => {
      if (signal) {
        child.kill(signal)
        process.kill(process.pid, signal)
      }
      resolve(code ?? 1)
    })
  })
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
