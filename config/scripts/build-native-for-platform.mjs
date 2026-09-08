#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

if (process.platform === 'win32') {
  runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
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
  const { command, prefixArgs, shell } = resolvePnpmCliInvocation()
  const child = spawn(command, [...prefixArgs, 'run', scriptName], { stdio: 'inherit', shell })

  return new Promise((resolve) => {
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
