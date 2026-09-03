import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../../shared/serve-update-handoff'
import { getDefaultUserDataPath } from './metadata'
import { getMacAppBundlePath } from './mac-app-update-bundle'
import {
  readServeUpdateHandoffSync,
  resumeInterruptedServeUpdate,
  superviseForegroundServe
} from './serve-update-supervisor'
import { waitForRecipeJson } from './serve-recipe-json'
import { RuntimeClientError } from './types'
import {
  getExecutableAppArgs,
  getExecutableSpawnOptions,
  resolveAppRoot,
  spawnDetached,
  stripElectronRunAsNode
} from './launch'

export function resolveOrcadEntry(): string | null {
  const override = process.env.ORCA_ORCAD_ENTRY
  if (typeof override === 'string' && override.trim().length > 0 && existsSync(override)) {
    return override
  }
  const appRoot = resolveAppRoot()
  const candidates = [
    join(appRoot, 'out', 'orcad', 'orcad.js'),
    join(__dirname, '../../orcad/orcad.js'),
    join(appRoot, 'orcad', 'orcad.js')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function openBrowserUrl(url: string): void {
  if (process.platform === 'darwin') {
    spawnDetached('open', [url], {})
  } else if (process.platform === 'win32') {
    spawnDetached('cmd.exe', ['/c', 'start', '', url], {})
  } else {
    spawnDetached('xdg-open', [url], {})
  }
}

export function serveOrcaApp(
  args: {
    json?: boolean
    port?: string | null
    pairingAddress?: string | null
    noPairing?: boolean
    noOpen?: boolean
    mobilePairing?: boolean
    recipeJson?: boolean
    projectRoot?: string | null
  } = {}
): Promise<number> {
  const orcadEntry = process.env.ORCA_SERVE_PREFER_ELECTRON === '1' ? null : resolveOrcadEntry()
  const useOrcad = orcadEntry !== null && !args.mobilePairing

  let executable: string
  let childArgs: string[]

  if (useOrcad) {
    executable = process.execPath
    childArgs = [orcadEntry]
    if (args.json) {
      childArgs.push('--json')
    }
    if (args.port) {
      childArgs.push('--port', args.port)
    }
    if (args.pairingAddress) {
      childArgs.push('--pairing-address', args.pairingAddress)
    }
    if (args.noPairing) {
      childArgs.push('--no-pairing')
    }
    if (args.recipeJson) {
      if (!args.projectRoot) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Recipe JSON output requires --project-root.'
        )
      }
      childArgs.push('--recipe-json', '--project-root', args.projectRoot)
    }
  } else {
    executable = resolveForegroundOrcaExecutable()
    childArgs = [...getExecutableAppArgs()]
    if (process.env.ORCA_APPIMAGE_NO_SANDBOX === '1') {
      childArgs.push('--no-sandbox')
    }
    childArgs.push('--serve')
    if (args.json) {
      childArgs.push('--serve-json')
    }
    if (args.port) {
      childArgs.push('--serve-port', args.port)
    }
    if (args.pairingAddress) {
      childArgs.push('--serve-pairing-address', args.pairingAddress)
    }
    if (args.noPairing) {
      childArgs.push('--serve-no-pairing')
    }
    if (args.noOpen) {
      childArgs.push('--serve-no-open')
    }
    if (args.mobilePairing) {
      childArgs.push('--serve-mobile-pairing')
    }
    if (args.recipeJson) {
      if (!args.projectRoot) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Recipe JSON output requires --project-root.'
        )
      }
      childArgs.push('--serve-recipe-json', '--serve-project-root', args.projectRoot)
    }
  }

  const handoffPath =
    args.recipeJson !== true && getMacAppBundlePath(executable)
      ? getServeUpdateHandoffPath(getDefaultUserDataPath())
      : null
  const childEnv = stripElectronRunAsNode(process.env)
  delete childEnv.ORCA_APPIMAGE_NO_SANDBOX
  if (childEnv.ORCA_USER_DATA_PATH && !childEnv.ORCA_USER_DATA_PATH_OVERRIDE) {
    childEnv.ORCA_USER_DATA_PATH_OVERRIDE = childEnv.ORCA_USER_DATA_PATH
  }
  if (handoffPath) {
    childEnv[SERVE_UPDATE_HANDOFF_PATH_ENV] = handoffPath
  }

  const shouldAutoOpen =
    !args.noOpen &&
    !args.json &&
    !args.recipeJson &&
    (Boolean(process.stdout.isTTY) || Boolean(process.stdin.isTTY))

  const spawnOptions: SpawnOptions = {
    detached: args.recipeJson === true,
    cwd: resolveAppRoot(),
    stdio:
      args.recipeJson === true
        ? ['ignore', 'pipe', 'inherit']
        : shouldAutoOpen
          ? ['inherit', 'pipe', 'inherit']
          : handoffPath
            ? ['inherit', 'inherit', 'inherit', 'ipc']
            : 'inherit',
    ...getExecutableSpawnOptions(executable),
    env: childEnv
  }
  const interruptedHandoff = handoffPath ? readServeUpdateHandoffSync(handoffPath) : null
  if (interruptedHandoff?.phase === 'install-requested') {
    return resumeInterruptedServeUpdate({
      executable,
      childArgs,
      spawnOptions,
      spawnChild: spawnProcess,
      handoffPath: handoffPath!,
      handoff: interruptedHandoff
    })
  }
  const child = spawnProcess(executable, childArgs, spawnOptions)

  if (shouldAutoOpen && child.stdout) {
    let opened = false
    let stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      process.stdout.write(chunk)
      if (opened) {
        return
      }
      stdoutBuffer += text
      const match =
        stdoutBuffer.match(/Web client URL:\s*(https?:\/\/[^\s]+)/i) ||
        stdoutBuffer.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s]*/i)
      if (match) {
        opened = true
        openBrowserUrl(match[1] ?? match[0])
      }
    })
  }

  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    executable,
    childArgs,
    spawnOptions,
    spawnChild: spawnProcess,
    child,
    handoffPath,
    expectedHandoff: null
  })
}

function resolveForegroundOrcaExecutable(): string {
  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    return overrideExecutable
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    return process.execPath
  }
  throw new RuntimeClientError(
    'runtime_serve_failed',
    'Could not determine how to start Orca server. Set ORCA_APP_EXECUTABLE to the Orca executable.'
  )
}
