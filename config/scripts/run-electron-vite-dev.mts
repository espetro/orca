import { createRequire } from 'node:module'
import path from 'node:path'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mts'
import { seedDevInstanceIdentityEnv } from './dev-instance-identity-env.mts'
import { prepareMacDevElectronApp } from './dev-electron-macos-app-prepare.mts'
import {
  prepareDevWebClient,
  resolveRemoteDebuggingPort
} from './dev-web-client-and-debug-port.mts'
import { spawnElectronViteDev, wireDevRunnerChildLifecycle } from './dev-runner-child-lifecycle.mts'

// Why: Electron-based hosts (e.g. Claude Code, VS Code) set
// ELECTRON_RUN_AS_NODE=1 in their terminal environment. If this leaks into
// the electron-vite spawn, the Electron binary boots as plain Node and
// require('electron') returns the npm stub instead of the built-in API.
delete process.env.ELECTRON_RUN_AS_NODE

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '../..')
const STABLE_NAME_FLAG = '--stable-name'
const rawForwardedArgs = process.argv.slice(2)
// Why: keep an escape hatch for tools that key off Electron's stock app name.
// The flag is runner-only and must not leak into Chromium/electron-vite.
const useStableElectronName =
  process.env.ORCA_DEV_STABLE_NAME === '1' || rawForwardedArgs.includes(STABLE_NAME_FLAG)
const forwardedRaw = rawForwardedArgs.filter((arg) => arg !== STABLE_NAME_FLAG)
if (useStableElectronName) {
  process.env.ORCA_DEV_STABLE_NAME = '1'
}

function getDevUserDataPath(): string {
  if (process.env.ORCA_DEV_USER_DATA_PATH) {
    return process.env.ORCA_DEV_USER_DATA_PATH
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'orca-dev')
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
      'orca-dev'
    )
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'),
    'orca-dev'
  )
}

function getElectronExecutable(): string {
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  return path.join(repoRoot, 'node_modules', '.bin', 'electron')
}

function prepareDevCliWrapper(): void {
  const userDataPath = getDevUserDataPath()
  const { binDir } = prepareDevCliTerminalWrappers({
    repoRoot,
    userDataPath,
    electronExecutable: getElectronExecutable()
  })

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  console.log(`[orca-dev] Prepared wrapper in ${binDir}`)
}

if (process.env.ORCA_SKIP_DEV_CLI_PREPARE !== '1') {
  prepareDevCliWrapper()
}

seedDevInstanceIdentityEnv(repoRoot)
if (!useStableElectronName && process.env.ORCA_SKIP_DEV_ELECTRON_APP_PREPARE !== '1') {
  prepareMacDevElectronApp(repoRoot)
}

// Why: tests inject a tiny fake CLI here so they can verify Ctrl+C tears down
// the full child tree without depending on a real electron-vite install.
const electronViteCli =
  process.env.ORCA_ELECTRON_VITE_CLI ||
  path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const viteCli =
  process.env.ORCA_VITE_CLI ||
  path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')

// Why: --help/--version exit immediately; skip every prepare that prints or binds.
const isHelpOrVersion = forwardedRaw.some(
  (arg) => arg === '--help' || arg === '-h' || arg === '--version'
)

const forwardedExtras = await resolveRemoteDebuggingPort(repoRoot, forwardedRaw)
prepareDevWebClient(repoRoot, viteCli, { isHelpOrVersion })
const forwardedArgs = ['dev', ...forwardedRaw, ...forwardedExtras]
const child = spawnElectronViteDev(electronViteCli, forwardedArgs)
wireDevRunnerChildLifecycle(child)
