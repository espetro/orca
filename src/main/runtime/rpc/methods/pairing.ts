import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import {
  getPairingNetworkInterfaces,
  getDefaultPairingAddress
} from '../../pairing-network-interfaces'
import { encodeMobilePairingQr, type MobilePairingQrResult } from '../../mobile-pairing-qr'
import type {
  MobilePairingOffer,
  PairingOfferUnavailable
} from '../../runtime-rpc/runtime-rpc-pairing-types'

const PairingMintOfferParams = z.object({
  // Why: optional override of the advertised endpoint address (Tailscale/ZeroTier overlay IPs),
  // mirroring the desktop `mobile:getPairingQR` `address` argument.
  address: z.string().min(1).optional(),
  connectionMode: z.enum(['automatic', 'local-only']).optional(),
  rotate: z.boolean().optional()
})

const PairingListNetworkInterfacesParams = z.object({}).optional()

const PairingGetRuntimePairingUrlParams = z.object({
  address: z.string().min(1).optional(),
  rotate: z.boolean().optional(),
  reach: z.enum(['this-computer', 'network']).optional()
})

export const PAIRING_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.getEndpoints(params)
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await ctx.pairing.provisionRelay(params)
    }
  }),
  defineMethod({
    name: 'pairing.mintOffer',
    params: PairingMintOfferParams,
    handler: async (params, ctx): Promise<ReturnType<typeof encodePairingOfferResult>> => {
      if (!ctx.pairing) {
        throw new Error('pairing_context_unavailable')
      }
      if (!ctx.pairing.ensureNetworkExposure || !ctx.pairing.createMobilePairingOffer) {
        throw new Error('pairing_context_unavailable')
      }
      if (params.connectionMode === 'local-only' && !params.address) {
        const interfaces = await getPairingNetworkInterfaces()
        if (interfaces.length === 0) {
          return {
            available: false as const,
            reason: 'invalid_advertised_endpoint' as const,
            guidance:
              'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
          }
        }
      }
      const offer = await ctx.pairing.createMobilePairingOffer({
        address: params.address ?? null,
        connectionMode: params.connectionMode,
        rotate: params.rotate,
        name: `Mobile ${new Date().toLocaleDateString()}`
      })
      return encodePairingOfferResult(offer)
    }
  }),
  defineMethod({
    name: 'pairing.listNetworkInterfaces',
    params: PairingListNetworkInterfacesParams,
    handler: async (): Promise<{
      interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
    }> => ({ interfaces: await getPairingNetworkInterfaces() })
  }),
  defineMethod({
    name: 'pairing.getRuntimePairingUrl',
    params: PairingGetRuntimePairingUrlParams,
    handler: async (params, ctx) => {
      if (
        !ctx.pairing ||
        !ctx.pairing.ensureNetworkExposure ||
        !ctx.pairing.createRuntimePairingOffer
      ) {
        throw new Error('pairing_context_unavailable')
      }
      const ip = params.address ?? (await getDefaultPairingAddress())
      if (!ip) {
        return { available: false as const }
      }
      // Why: mirrors the desktop handler — a widen failure must surface as guidance, not a dead QR.
      try {
        await ctx.pairing.ensureNetworkExposure()
      } catch {
        return { available: false as const, reason: 'network_exposure_failed' as const }
      }
      return ctx.pairing.createRuntimePairingOffer({
        address: ip,
        rotate: params.rotate,
        reach: params.reach ?? 'network'
      })
    }
  })
]

// Why: mirrors the desktop handler's QR encoding so web clients get the exact same
// dataURL + size payload; unavailable offers pass through with relay failure detail.
async function encodePairingOfferResult(offer: MobilePairingOffer): Promise<
  | PairingOfferUnavailable
  | {
      available: true
      qrDataUrl: string | null
      qrSize: number | null
      qrError?: 'encoding_failed'
      pairingUrl: string
      endpoint: string | null
      deviceId: string
      connectionMode: MobilePairingConnectionMode
    }
> {
  if (!offer.available) {
    return {
      available: false as const,
      reason: offer.reason,
      guidance: offer.guidance,
      ...(offer.relayFailure ? { relayFailure: offer.relayFailure } : {})
    }
  }
  const qr: MobilePairingQrResult = await encodeMobilePairingQr(offer.pairingUrl)
  return {
    available: true as const,
    qrDataUrl: qr.ok ? qr.qrDataUrl : null,
    qrSize: qr.ok ? qr.qrSize : null,
    ...(!qr.ok ? { qrError: qr.reason } : {}),
    pairingUrl: offer.pairingUrl,
    endpoint: offer.endpoint,
    deviceId: offer.deviceId,
    connectionMode: offer.connectionMode
  }
}
