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

// Why detached: native builds spawn swift/swiftc descendants; killing the pnpm
// process alone can leave them writing artifacts. Each build runs in its own
// process group so cleanup can signal the whole tree (POSIX only — this file
// returns early on win32).
const children = new Map()

process.on('SIGINT', () => terminateAll('SIGINT'))
process.on('SIGTERM', () => terminateAll('SIGTERM'))

const exitCodes = await Promise.all(
  ['build:computer-macos', 'build:keyboard-layout-macos', 'build:notification-status-macos'].map(
    (scriptName) => runPnpmScript(scriptName)
  )
)
process.exit(Math.max(...exitCodes))

function terminateAll(signal) {
  for (const [child, label] of children) {
    console.log(`[native-build] stopping ${label} (${signal})`)
    try {
      // negative pid signals the whole detached process group
      process.kill(-child.pid, signal)
    } catch {
      // group already gone
      try {
        child.kill(signal)
      } catch {}
    }
  }
}

function runPnpmScript(scriptName) {
  const label = scriptName.replace(/^build:|-macos$/g, '')
  const { command, prefixArgs, shell } = resolvePnpmCliInvocation()
  const child = spawn(command, [...prefixArgs, 'run', scriptName], {
    // Why detached: own process group, see terminateAll above.
    detached: true,
    shell,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.set(child, scriptName)
  pipePrefixed(child.stdout, label, process.stdout)
  pipePrefixed(child.stderr, label, process.stderr)

  return new Promise((resolve) => {
    let exitCode = null
    let exitSignal = null
    // Why settle only on close: 'error' (e.g. spawn ENOENT) can fire before/without
    // close; resolving early would let Promise.all exit while children still run.
    const settle = () => {
      if (exitCode === null && exitSignal === null) {
        return
      }
      children.delete(child)
      if (exitSignal) {
        // Why: restore default disposition so this process dies with the same
        // signal it received (our handlers would otherwise swallow it).
        for (const received of ['SIGINT', 'SIGTERM']) {
          process.removeListener(received, handlerFor(received))
        }
        process.kill(process.pid, exitSignal)
        return
      }
      if (exitCode !== 0) {
        // fail fast: stop sibling builds so they don't keep writing artifacts
        terminateAll('SIGTERM')
      }
      resolve(exitCode ?? 1)
    }
    child.on('error', () => {
      exitCode = 1
      settle()
    })
    child.on('close', (code, signal) => {
      exitCode = code
      exitSignal = signal
      settle()
    })
  })
}

const signalHandlers = new Map()
function handlerFor(signal) {
  if (!signalHandlers.has(signal)) {
    signalHandlers.set(signal, () => terminateAll(signal))
  }
  return signalHandlers.get(signal)
}

function pipePrefixed(stream, label, target) {
  stream.setEncoding('utf8')
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      target.write(`[${label}] ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0) {
      target.write(`[${label}] ${buffer}\n`)
    }
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
