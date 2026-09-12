import type { PreloadApi } from '../../../../preload/api-types'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import { callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

// Why inline the return shapes: the contract lives in /tmp/orca-baselines/contract.md
// and Subagent 1 owns the canonical `mobile-pairing-rpc-contract.ts`. The web preload
// mirrors the desktop `window.api.mobile.*` shape directly so callers don't branch.
type MobileHostStatus = {
  desktopWindowStatus: string | null
  hostMode: 'desktop' | 'serve'
  relayAvailable: boolean
  webSocketEndpoint: string | null
}

export function createWebMobileApi(): Partial<PreloadApi> {
  return {
    mobile: {
      // mobile.listNetworkInterfaces -> { interfaces: { name, address, hasDefaultRoute? }[] }
      listNetworkInterfaces: async () => {
        try {
          return await callRuntimeResult<{
            interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
          }>('mobile.listNetworkInterfaces')
        } catch {
          return { interfaces: [] }
        }
      },
      // mobile.getPairingQR -> MobilePairingQrResult (mirrors desktop MobileApi.getPairingQR)
      getPairingQR: async (args) => {
        try {
          return await callRuntimeResult<
            | {
                available: false
                reason?: string
                guidance?: string
                relayFailure?: MobileRelayMintFailure
              }
            | {
                available: true
                qrDataUrl: string | null
                qrSize: number | null
                qrError?: 'encoding_failed'
                pairingUrl: string
                endpoint: string | null
                deviceId: string
                connectionMode: 'automatic' | 'local-only'
              }
          >('mobile.getPairingQR', args ?? {})
        } catch {
          return { available: false as const }
        }
      },
      // Windows-only: no equivalent on the remote renderer over WS.
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () =>
        Promise.resolve({ ok: false as const, reason: 'unsupported' as const }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      // mobile.getRuntimePairingUrl -> MobileRuntimePairingUrlResult
      getRuntimePairingUrl: async (args) => {
        try {
          return await callRuntimeResult<
            | { available: false; reason?: 'network_exposure_failed'; guidance?: string }
            | {
                available: true
                pairingUrl: string
                webClientUrl: string | null
                endpoint: string
                deviceId: string
              }
          >('mobile.getRuntimePairingUrl', args ?? {})
        } catch {
          return { available: false as const }
        }
      },
      // mobile.listDevices -> MobileListDevicesResult
      listDevices: async () => {
        try {
          return await callRuntimeResult<{
            devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
          }>('mobile.listDevices')
        } catch {
          return { devices: [] }
        }
      },
      // mobile.revokeDevice -> MobileRevokeDeviceResult
      revokeDevice: async ({ deviceId }) => {
        try {
          return await callRuntimeResult<{ revoked: boolean }>('mobile.revokeDevice', { deviceId })
        } catch {
          return { revoked: false }
        }
      },
      // Desktop-only ops: runtime access grants are host-local, no remote RPC in v1.
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      // mobile.hostStatus -> derives { ready, endpoint } from webSocketEndpoint.
      isWebSocketReady: async () => {
        try {
          const result = await callRuntimeResult<MobileHostStatus>('mobile.hostStatus')
          return { ready: Boolean(result.webSocketEndpoint), endpoint: result.webSocketEndpoint }
        } catch {
          return { ready: false, endpoint: null }
        }
      },
      // mobile.hostStatus -> relayAvailable controls the relay detail shape.
      getRelayStatus: async () => {
        try {
          const result = await callRuntimeResult<MobileHostStatus>('mobile.hostStatus')
          if (!result.relayAvailable) {
            return { status: 'offline' as const }
          }
          // Why a registered shell instead of an offline one: relayAvailable=true is the host's
          // own signal that the relay is live; we have no per-cell detail over the WS transport.
          return { status: 'registered' as const }
        } catch {
          return { status: 'offline' as const }
        }
      },
      // Renderer-only event: cannot subscribe over WS RPC in v1.
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
