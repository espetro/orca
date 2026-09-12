// Why: phone-scope callers receive `forbidden` automatically via the dispatch guard
// (runtime-rpc-websocket-dispatch.ts:76-86); this set is for runtime/desktop/CLI.
// The runtime exposes a `getMobilePairingRpcAccessors()` seam that the main process wires up to
// the live RPC server (so handlers can mint offers / manage devices without back-references).
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import type {
  MobileHostMode,
  MobileHostStatus,
  MobileHostStatusResult,
  MobileListDevicesResult,
  MobileNetworkInterfacesResult,
  MobilePairingQrResult,
  MobileRevokeDeviceResult,
  MobileRuntimePairingUrlResult
} from '../../../../shared/mobile-pairing-rpc-contract'
import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'

// Why: scope check defends against accidental future dispatch loosening; the dispatcher already
// rejects `mobile.*` for phone-scope tokens, but the handlers double-check on device-touching methods.
function ensureRuntimeScope(ctx: { clientKind?: 'mobile' | 'runtime' }): void {
  if (ctx.clientKind === 'mobile') {
    const err = new Error('mobile_scope_denied') as Error & { code?: string }
    err.code = 'forbidden'
    throw err
  }
}

const MobileGetPairingQrParamsSchema = z
  .object({
    address: z.string().optional(),
    connectionMode: z.union([z.literal('local-only'), z.literal('automatic')]).optional(),
    rotate: z.boolean().optional()
  })
  .optional()

const MobileRevokeDeviceParamsSchema = z.object({ deviceId: z.string().min(1) })

const MobileGetRuntimePairingUrlParamsSchema = z
  .object({
    address: z.string().optional(),
    rotate: z.boolean().optional(),
    reach: z.union([z.literal('this-computer'), z.literal('network')]).optional()
  })
  .optional()

export type MobilePairingRpcAccessors = {
  getWebSocketEndpoint(): string | null
  getPairingNetworkInterfaces(): Promise<
    { name: string; address: string; family: 'IPv4' | 'IPv6' }[]
  >
  getDefaultPairingAddress(): Promise<string | null>
  createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    rotate?: boolean
    name?: string
  }): Promise<
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        connectionMode: 'local-only' | 'automatic' | null
      }
    | {
        available: false
        reason: string
        guidance: string
        relayFailure?: unknown
      }
  >
  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: 'mobile' | 'runtime'
    reach?: RuntimePairingReach
  }):
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        webClientUrl: string | null
      }
    | { available: false; reason: string; guidance: string }
  getDeviceRegistry(): {
    listDevices(): readonly {
      deviceId: string
      name: string
      pairedAt: number
      lastSeenAt: number
      scope: 'mobile' | 'runtime'
    }[]
  } | null
  revokeMobileDevice(deviceId: string): Promise<boolean>
  isDesktopRelayProviderAttached(): boolean
  encodePairingQr(
    pairingUrl: string
  ): Promise<
    { ok: true; qrDataUrl: string; qrSize: number } | { ok: false; reason: 'encoding_failed' }
  >
}

type RuntimeWithMobilePairingAccessors = {
  getMobilePairingRpcAccessors?(): {
    getWebSocketEndpoint(): string | null
    isDesktopRelayProviderAttached(): boolean
  } | null
  getStatus(): {
    desktopWindowStatus?: string | null
    hostMode?: MobileHostMode
    relayAvailable?: boolean
    webSocketEndpoint?: string | null
  }
}

function resolveAccessors(
  runtime: RuntimeWithMobilePairingAccessors
): MobilePairingRpcAccessors | null {
  const accessors = runtime.getMobilePairingRpcAccessors?.() ?? null
  // Why: the runtime's typed accessor only promises the two methods getStatus uses; in practice
  // the rpc server hands the full surface (pairing offer, device registry) so a structural cast
  // is the bridge. If the cast target is missing methods, those branches fail at runtime.
  return accessors as unknown as MobilePairingRpcAccessors | null
}
// Why: derives the host mode without a dedicated accessor — the runtime's own getStatus already
// reports `desktopWindowStatus: 'available'` only when a live renderer is attached, so 'desktop' iff
// 'available', otherwise 'serve'.
function deriveHostMode(status: { desktopWindowStatus?: string | null }): MobileHostMode {
  return status.desktopWindowStatus === 'available' ? 'desktop' : 'serve'
}

export const MOBILE_PAIRING_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'mobile.hostStatus',
    params: null,
    handler: (_params, ctx): MobileHostStatusResult => {
      const status = ctx.runtime.getStatus()
      const accessors = resolveAccessors(ctx.runtime as RuntimeWithMobilePairingAccessors)
      const relayAvailable = accessors
        ? accessors.isDesktopRelayProviderAttached()
        : Boolean(status.relayAvailable)
      const webSocketEndpoint = accessors
        ? accessors.getWebSocketEndpoint()
        : (status.webSocketEndpoint ?? null)
      const result: MobileHostStatus = {
        desktopWindowStatus: (status.desktopWindowStatus ??
          null) as MobileHostStatus['desktopWindowStatus'],
        hostMode: status.hostMode ?? deriveHostMode(status),
        relayAvailable,
        webSocketEndpoint
      }
      return result
    }
  }),

  defineMethod({
    name: 'mobile.listNetworkInterfaces',
    params: null,
    handler: async (_params, ctx): Promise<MobileNetworkInterfacesResult> => {
      const accessors = resolveAccessors(ctx.runtime as RuntimeWithMobilePairingAccessors)
      if (!accessors) {
        return { interfaces: [] }
      }
      const interfaces = await accessors.getPairingNetworkInterfaces()
      return { interfaces }
    }
  }),

  defineMethod({
    name: 'mobile.getPairingQR',
    params: MobileGetPairingQrParamsSchema,
    handler: async (params, ctx): Promise<MobilePairingQrResult> => {
      const accessors = resolveAccessors(ctx.runtime as RuntimeWithMobilePairingAccessors)
      if (!accessors) {
        return {
          available: false,
          reason: 'rpc_accessors_unavailable',
          guidance: 'Mobile pairing RPC is not wired on this host.'
        }
      }
      // Why: mirrors the IPC path — local-only with no usable interface must fail closed before the
      // offer mints; Relay can fall back to loopback but LAN-only has nothing to fall back on.
      const ip = params?.address ?? (await accessors.getDefaultPairingAddress())
      if (!ip && params?.connectionMode === 'local-only') {
        return {
          available: false,
          reason: 'invalid_advertised_endpoint',
          guidance:
            'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
        }
      }
      const result = await accessors.createMobilePairingOffer({
        address: ip,
        connectionMode: params?.connectionMode,
        rotate: params?.rotate
      })
      if (!result.available) {
        return {
          available: false,
          reason: result.reason,
          guidance: result.guidance
        }
      }
      const qr = await accessors.encodePairingQr(result.pairingUrl)
      // Why: with no advertised IP the offer's endpoint is the loopback fallback (the scanning phone,
      // never this host); surface null so the UI omits it instead of printing an unreachable address.
      return {
        available: true,
        qrDataUrl: qr.ok ? qr.qrDataUrl : null,
        qrSize: qr.ok ? qr.qrSize : null,
        pairingUrl: result.pairingUrl,
        endpoint: ip ? result.endpoint : null,
        deviceId: result.deviceId,
        connectionMode: result.connectionMode
      }
    }
  }),

  defineMethod({
    name: 'mobile.listDevices',
    params: null,
    handler: (_params, ctx): MobileListDevicesResult => {
      // Why: defence-in-depth — phone-scope callers are already rejected at the dispatcher,
      // but device-touching handlers enforce scope independently.
      ensureRuntimeScope(ctx)
      const accessors = resolveAccessors(ctx.runtime as RuntimeWithMobilePairingAccessors)
      const registry = accessors?.getDeviceRegistry()
      if (!registry) {
        return { devices: [] }
      }
      // Why: mirrors the IPC filter — pending credentials with lastSeenAt === 0 were minted by
      // QR generation but never scanned, so they are not really paired.
      return {
        devices: registry
          .listDevices()
          .filter((d) => d.scope === 'mobile' && d.lastSeenAt > 0)
          .map((d) => ({
            deviceId: d.deviceId,
            name: d.name,
            pairedAt: d.pairedAt,
            lastSeenAt: d.lastSeenAt
          }))
      }
    }
  }),

  defineMethod({
    name: 'mobile.revokeDevice',
    params: MobileRevokeDeviceParamsSchema,
    handler: async (params, ctx): Promise<MobileRevokeDeviceResult> => {
      ensureRuntimeScope(ctx)
      const accessors = resolveAccessors(ctx.runtime as RuntimeWithMobilePairingAccessors)
      if (!accessors) {
        return { revoked: false }
      }
      return { revoked: await accessors.revokeMobileDevice(params.deviceId) }
    }
  }),

  defineMethod({
    name: 'mobile.getRuntimePairingUrl',
    params: MobileGetRuntimePairingUrlParamsSchema,
    handler: async (params, ctx): Promise<MobileRuntimePairingUrlResult> => {
      const accessors = resolveAccessors(ctx.runtime as RuntimeWithMobilePairingAccessors)
      if (!accessors) {
        return { available: false, reason: 'rpc_accessors_unavailable' }
      }
      const ip = params?.address ?? (await accessors.getDefaultPairingAddress())
      if (!ip) {
        return { available: false }
      }
      const offer = accessors.createPairingOffer({
        address: ip,
        rotate: params?.rotate,
        scope: 'runtime',
        reach: params?.reach ?? 'network'
      })
      if (!offer.available) {
        return { available: false, reason: offer.reason, guidance: offer.guidance }
      }
      return {
        available: true,
        pairingUrl: offer.pairingUrl,
        webClientUrl: offer.webClientUrl ?? '',
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  })
]
