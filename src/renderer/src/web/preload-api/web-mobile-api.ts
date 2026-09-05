import type { PreloadApi } from '../../../../preload/api-types'
import { webRuntimeState } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import { callRuntimeResult } from './web-runtime-calls'

export function createWebMobileApi(): Partial<PreloadApi> {
  return {
    mobile: {
      // Why: routed over the runtime RPC channel (pairing.listNetworkInterfaces) so the web UI
      // can offer LAN/Tailscale address picking like the desktop app does.
      listNetworkInterfaces: () =>
        callRuntimeResult<{
          interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
        }>('pairing.listNetworkInterfaces').catch(() => ({ interfaces: [] })),
      getPairingQR: (args) => callRuntimeResult('pairing.mintOffer', args),
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: (args) => callRuntimeResult('pairing.getRuntimePairingUrl', args),
      // Why: device management needs a registry-backed RPC namespace; still desktop-only.
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () =>
        Promise.resolve({
          ready: Boolean(webRuntimeState.activeEnvironment),
          endpoint: webRuntimeState.activeEnvironment?.endpoints[0]?.endpoint ?? null
        }),
      getRelayStatus: () => Promise.resolve({ status: 'offline' as const }),
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
