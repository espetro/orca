import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { DeviceEntry } from '../runtime/device-registry'
import type { NetworkInterface } from '../runtime/pairing-network-interfaces'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  createMobilePairingService,
  type MobilePairingService,
  type MobilePairingServiceDependencies
} from '../runtime/mobile-pairing-service'

// Why: the mobile IPC handlers provide the renderer with QR code pairing data,
// device management, and WebSocket readiness status. They depend on the
// OrcaRuntimeRpcServer because it owns the device registry and TLS state.

// Why: `toRuntimeAccessGrant` only feeds the runtime-grant IPC handlers (listRuntimeAccessGrants,
// revokeRuntimeAccess) — those two stay in the IPC module because they share no state with the
// mobile-pairing service (both just call `rpcServer.getDeviceRegistry()` / `revokeRuntimeAccess`),
// so shipping them through the service would be a code-movement-only change.
function toRuntimeAccessGrant(device: DeviceEntry): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}

// Why: `isWindowRenderer` is an IPC-only concern — the service takes a pre-resolved webContentsId so
// it stays IPC-agnostic. The IPC wrappers below resolve `event.sender` into that id and pass null when
// the sender is not a window renderer.
function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return !event.sender.isDestroyed() && event.sender.getType() === 'window'
}

export function registerMobileHandlers(
  rpcServer: OrcaRuntimeRpcServer,
  dependencies: MobilePairingServiceDependencies = {}
): void {
  const service: MobilePairingService = createMobilePairingService(rpcServer, dependencies)

  ipcMain.handle(
    'mobile:listNetworkInterfaces',
    async (): Promise<{ interfaces: NetworkInterface[] }> => service.listNetworkInterfaces()
  )

  ipcMain.handle('mobile:getPairingQR', async (_event, args) => service.getPairingQR(args))

  ipcMain.handle('mobile:getRuntimePairingUrl', async (_event, args) =>
    service.getRuntimePairingUrl(args)
  )

  ipcMain.handle('mobile:listDevices', () => service.listDevices())

  // Why: kept in the IPC module rather than the service — only the renderer-facing surface owns this
  // mapping, and the service doesn't carry the runtime-grant shape (createdAt vs pairedAt).
  ipcMain.handle('mobile:listRuntimeAccessGrants', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { grants: [] }
    }
    return {
      grants: registry
        .listDevices()
        .filter((d) => d.scope === 'runtime')
        .sort((a, b) => b.pairedAt - a.pairedAt)
        .map(toRuntimeAccessGrant)
    }
  })

  ipcMain.handle('mobile:revokeDevice', async (_event, args: { deviceId: string }) =>
    service.revokeDevice(args.deviceId)
  )

  ipcMain.handle('mobile:revokeRuntimeAccess', (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: rpcServer.revokeRuntimeAccess(args.deviceId) }
  })

  ipcMain.handle('mobile:isWebSocketReady', () => service.isWebSocketReady())

  ipcMain.handle('mobile:getWindowsFirewallStatus', (_event, args?: { address?: string }) =>
    service.getWindowsFirewallStatus(args)
  )

  ipcMain.handle('mobile:repairWindowsFirewall', (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event)) {
      return { ok: false as const, reason: 'unsupported' as const }
    }
    // Why: elevated inputs come from the running runtime, never the renderer.
    return service.repairWindowsFirewall()
  })

  ipcMain.handle('mobile:openWindowsNetworkSettings', async (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event)) {
      return false
    }
    return service.openWindowsNetworkSettings()
  })

  ipcMain.handle('mobile:getRelayStatus', (): ReturnType<MobilePairingService['getRelayStatus']> =>
    service.getRelayStatus()
  )

  ipcMain.handle('mobile:consumePendingUnpairedDeviceAuthFailure', (event) => {
    if (!isWindowRenderer(event)) {
      return false
    }
    return service.consumePendingUnpairedDeviceAuthFailure(event.sender.id)
  })
}
