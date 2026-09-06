import { app } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { notifyServeSupervisorReady } from '../serve-update-handoff'
import { installLinuxBareOrcaDispatcher } from '../cli/linux-bare-orca-dispatcher'
import { CliInstaller } from '../cli/cli-installer'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { ServeReadinessPublisher } from '../server/serve-readiness'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

export type ServeOptions = {
  json: boolean
  wsPort?: number
  pairingAddress: string | null
  noPairing: boolean
  noOpen?: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null
}

export function getServeOptions(argv = process.argv): ServeOptions {
  const valueAfter = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    if (index === -1) {
      return null
    }
    const value = argv[index + 1]
    return value && !value.startsWith('--') ? value : null
  }
  const rawPort = valueAfter('--serve-port')
  let wsPort: number | undefined
  if (rawPort) {
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --serve-port value: ${rawPort}`)
    }
    wsPort = parsedPort
  }
  return {
    json: argv.includes('--serve-json'),
    ...(wsPort !== undefined ? { wsPort } : {}),
    pairingAddress: valueAfter('--serve-pairing-address'),
    noPairing: argv.includes('--serve-no-pairing'),
    noOpen: argv.includes('--serve-no-open'),
    mobilePairing: argv.includes('--serve-mobile-pairing'),
    recipeJson: argv.includes('--serve-recipe-json'),
    projectRoot: valueAfter('--serve-project-root')
  }
}

export function getBundledWebClientRoot(): string | undefined {
  const appPath = app.getAppPath()
  const roots = [
    join(appPath, 'out', 'web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the web bundle.
    join(appPath, '..', 'web')
  ]
  return roots.find((root) => existsSync(join(root, 'web-index.html')))
}

async function renderTerminalPairingQr(pairingUrl: string): Promise<string | null> {
  // Why dynamic: qrcode is only reachable from mobile pairing, so launch should
  // not parse it for the majority who never pair a device.
  const QRCode = await import('qrcode')
  try {
    return await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
  } catch {
    try {
      return await QRCode.toString(pairingUrl, { type: 'utf8' })
    } catch {
      return null
    }
  }
}

export type ServeStartupDeps = {
  getRuntime: () => OrcaRuntimeService | null
  getRuntimeRpc: () => OrcaRuntimeRpcServer | null
  getManagedWslCliReconciliationStatus: () => 'pending' | 'settled' | 'failed'
}

export function createServeStartup(deps: ServeStartupDeps) {
  const serveReadinessPublisher = new ServeReadinessPublisher()

  async function printServeReady(options: ServeOptions): Promise<void> {
    const runtime = deps.getRuntime()
    const runtimeRpc = deps.getRuntimeRpc()
    if (!runtime || !runtimeRpc) {
      throw new Error('Runtime server must be initialized before printing serve readiness')
    }
    if (options.recipeJson) {
      if (!options.projectRoot) {
        throw new Error('--serve-recipe-json requires --serve-project-root')
      }
      if (!isAbsolute(options.projectRoot)) {
        throw new Error(`--serve-project-root must be absolute: ${options.projectRoot}`)
      }
      const projectRootStats = statSync(options.projectRoot)
      if (!projectRootStats.isDirectory()) {
        throw new Error(`--serve-project-root must be a directory: ${options.projectRoot}`)
      }
    }
    const boundEndpoint = runtimeRpc.getWebSocketEndpoint()
    const advertised = boundEndpoint
      ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
      : null
    const pairing = options.noPairing
      ? ({
          available: false,
          reason: 'disabled_by_operator',
          guidance: 'Restart without --no-pairing to create a client pairing offer.'
        } as const)
      : runtimeRpc.createPairingOffer({
          address: options.pairingAddress,
          name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
          scope: options.mobilePairing ? 'mobile' : 'runtime'
        })
    const pairingQr =
      pairing.available && options.mobilePairing
        ? await renderTerminalPairingQr(pairing.pairingUrl)
        : null
    await serveReadinessPublisher.publish(
      {
        runtimeId: runtime.getRuntimeId(),
        boundEndpoint,
        advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
        // Why: the WSL reconciliation barrier fails open, so 'pending' warns a WSL PTY launch may still race a repair.
        managedWslCliReconciliation: deps.getManagedWslCliReconciliationStatus(),
        pairing: pairing.available
          ? {
              available: true,
              url: pairing.pairingUrl,
              endpoint: pairing.endpoint,
              deviceId: pairing.deviceId,
              webClientUrl: pairing.webClientUrl,
              scope: options.mobilePairing ? 'mobile' : 'runtime',
              qr: pairingQr
            }
          : pairing
      },
      options.recipeJson
        ? { mode: 'recipe-json', projectRoot: options.projectRoot! }
        : { mode: options.json ? 'json' : 'human' }
    )
    notifyServeSupervisorReady(runtime.getRuntimeId())
  }

  // Why: installs are best-effort tail work after the RPC transport is up; run them concurrently without blocking serve readiness.
  const installServeCliArtifacts = async (): Promise<void> => {
    // Why: headless serve has no renderer to run the normal cli:install flow; do it here for macOS/Linux only (Windows-excluded: install() only mutates registry PATH, not child terminals).
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
        const cliStatus = await new CliInstaller({
          privilegedRunner: async () => {
            throw new Error('serve CLI auto-install must not request administrator privileges')
          }
        }).install()
        console.log(
          `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
        )
      } catch (error) {
        console.warn(
          '[serve] orca CLI install skipped:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
    if (process.platform === 'linux' && app.isPackaged && process.resourcesPath) {
      try {
        const dispatcher = await installLinuxBareOrcaDispatcher({
          resourcesPath: process.resourcesPath
        })
        console.log(
          `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
            `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
        )
      } catch (error) {
        console.warn(
          '[serve] bare orca dispatcher install skipped:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  return {
    printServeReady,
    installServeCliArtifacts
  }
}
