import { app, shell } from 'electron'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { MobileRelayStatusDetail } from '../../shared/mobile-relay-status'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { OrcaRuntimeRpcServer } from './runtime-rpc'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './network-exposure-guidance'
import {
  getDefaultPairingAddress,
  getPairingNetworkInterfaces,
  type DefaultRouteInterfaceLookup,
  type NetworkInterface
} from './pairing-network-interfaces'
import { resolveAdvertisedPairingHostname } from './pairing-endpoint'
import { encodeMobilePairingQr, type MobilePairingQrResult } from './mobile-pairing-qr'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'
import {
  getWebSocketPort,
  inspectWindowsMobileFirewall,
  repairWindowsMobileFirewall,
  type WindowsMobileFirewallEnvironment
} from './windows-mobile-firewall'

// Why: only an explicit "This computer only" pick skips the one-way widen, and only when the address it
// advertises really is loopback — a mismatch (a LAN address under a this-computer reach) would otherwise
// mint a link with no listener behind it. Every other reach, including a loopback-looking Custom address
// that fronts an SSH tunnel or reverse proxy, still opts in.
function servesThisComputerOnly(reach: RuntimePairingReach | undefined, address: string): boolean {
  if (reach !== 'this-computer') {
    return false
  }
  const hostname = resolveAdvertisedPairingHostname(address)
  return hostname !== null && classifyRemotePairingHostname(hostname) === 'loopback'
}

function toRuntimeAccessGrant(device: {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}

export type MobilePairingServiceDependencies = {
  firewallEnvironment?: WindowsMobileFirewallEnvironment
  openWindowsNetworkSettings?: () => Promise<void>
  getRelayStatus?: () => MobileRelayStatusDetail
  consumePendingUnpairedDeviceAuthFailure?: (webContentsId: number) => boolean
  encodePairingQr?: (pairingUrl: string) => Promise<MobilePairingQrResult>
  getDefaultRouteInterfaceNames?: DefaultRouteInterfaceLookup
}

// Why: mirrors the IPC `mobile:getPairingQR` payload — the renderer expects `qrError` when QR encoding
// fails, and `relayFailure` when the offer was rejected at mint time.
export type MobilePairingServiceQrResult =
  | {
      available: false
      reason: 'invalid_advertised_endpoint'
      guidance: string
    }
  | {
      available: false
      reason: string
      guidance: string
      relayFailure?: unknown
    }
  | {
      available: true
      qrDataUrl: string | null
      qrSize: number | null
      qrError?: string
      pairingUrl: string
      endpoint: string | null
      deviceId: string
      connectionMode: 'local-only' | 'automatic' | null
    }

// Why: the runtime pairing URL keeps a single reason/guidance string today, but widen failures get
// a tagged reason the renderer can branch on; both unavailable shapes share the `available: false`
// discriminator so the UI can fold them together.
export type MobileRuntimePairingUrlResult =
  | { available: false }
  | {
      available: false
      reason: 'network_exposure_failed'
      guidance: string
    }
  | {
      available: true
      pairingUrl: string
      webClientUrl: string | null
      endpoint: string
      deviceId: string
    }

export type MobilePairingService = {
  listNetworkInterfaces(): Promise<{ interfaces: NetworkInterface[] }>
  getPairingQR(args?: {
    address?: string
    connectionMode?: MobilePairingConnectionMode
    rotate?: boolean
  }): Promise<MobilePairingServiceQrResult>
  getRuntimePairingUrl(args?: {
    address?: string
    rotate?: boolean
    reach?: RuntimePairingReach
  }): Promise<MobileRuntimePairingUrlResult>
  listDevices(): {
    devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
  }
  listRuntimeAccessGrants(): { grants: RuntimeAccessGrant[] }
  revokeDevice(deviceId: string): Promise<{ revoked: boolean }>
  revokeRuntimeAccess(deviceId: string): { revoked: boolean }
  isWebSocketReady(): { ready: boolean; endpoint: string | null }
  getWindowsFirewallStatus(args?: {
    address?: string
  }): ReturnType<typeof inspectWindowsMobileFirewall>
  repairWindowsFirewall(): ReturnType<typeof repairWindowsMobileFirewall>
  openWindowsNetworkSettings(): Promise<boolean>
  getRelayStatus(): MobileRelayStatusDetail
  // Why: the IPC wrapper applies isWindowRenderer before delegating, so the service takes a
  // pre-resolved webContentsId (or null to short-circuit) — never an IpcMainInvokeEvent.
  consumePendingUnpairedDeviceAuthFailure(webContentsId: number | null): boolean
}

export function createMobilePairingService(
  rpcServer: OrcaRuntimeRpcServer,
  dependencies: MobilePairingServiceDependencies = {}
): MobilePairingService {
  const firewallEnvironment = dependencies.firewallEnvironment ?? {
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    systemRoot: process.env.SystemRoot
  }
  const getDefaultRouteInterfaceNames =
    dependencies.getDefaultRouteInterfaceNames ?? getWindowsDefaultRouteInterfaceNames

  const listNetworkInterfaces = async (): Promise<{ interfaces: NetworkInterface[] }> => ({
    interfaces: await getPairingNetworkInterfaces(getDefaultRouteInterfaceNames)
  })

  const getPairingQR = async (args?: {
    address?: string
    connectionMode?: MobilePairingConnectionMode
    rotate?: boolean
  }): Promise<MobilePairingServiceQrResult> => {
    // Why: allow the caller to specify which network interface address to
    // embed in the QR code. This supports overlay networks (Tailscale,
    // ZeroTier) where the default LAN IP isn't reachable from the phone.
    const ip = args?.address ?? (await getDefaultPairingAddress(getDefaultRouteInterfaceNames))
    // Why: the local address is optional under Relay — the QR carries the relay invite, so a host
    // with nothing auto-advertisable (only container bridges, or no interface at all) still pairs.
    // The offer's endpoint then falls back to loopback, which is the phone's own device: the direct
    // candidate loses the race by construction. LAN-only has no relay to fall back on, so it fails closed.
    if (!ip && args?.connectionMode === 'local-only') {
      return {
        available: false as const,
        reason: 'invalid_advertised_endpoint',
        guidance:
          'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
      }
    }

    // Why: coalesce repeated QR regenerations onto a single never-scanned
    // pending token so the copy-button flow doesn't accumulate orphaned
    // device credentials forever. The token graduates to a real entry when
    // a phone actually connects (lastSeenAt > 0). When the caller passes
    // `rotate: true` (explicit "Regenerate" intent because the prior token
    // may have been exposed), we discard any pending token and mint a fresh
    // one so the new QR carries a different credential.
    const offer = await rpcServer.createMobilePairingOffer({
      address: ip,
      connectionMode: args?.connectionMode,
      rotate: args?.rotate,
      name: `Mobile ${new Date().toLocaleDateString()}`
    })
    if (!offer.available) {
      // Why: surface Relay mint failures (and other pairing unavailability)
      // so the UI can refuse a silent LAN QR under the Relay label.
      return {
        available: false as const,
        reason: offer.reason,
        guidance: offer.guidance,
        ...(offer.relayFailure ? { relayFailure: offer.relayFailure } : {})
      }
    }

    const qr = await (dependencies.encodePairingQr ?? encodeMobilePairingQr)(offer.pairingUrl)

    return {
      available: true as const,
      qrDataUrl: qr.ok ? qr.qrDataUrl : null,
      qrSize: qr.ok ? qr.qrSize : null,
      ...(!qr.ok ? { qrError: qr.reason } : {}),
      pairingUrl: offer.pairingUrl,
      // Why: with nothing advertised the offer's endpoint is the loopback fallback, which points at
      // whichever device scans the QR — never this host. Report no endpoint so the UI omits it
      // instead of printing an address the phone can't reach.
      endpoint: ip ? offer.endpoint : null,
      deviceId: offer.deviceId,
      connectionMode: offer.connectionMode
    }
  }

  const getRuntimePairingUrl = async (args?: {
    address?: string
    rotate?: boolean
    reach?: RuntimePairingReach
  }): Promise<MobileRuntimePairingUrlResult> => {
    const ip = args?.address ?? (await getDefaultPairingAddress(getDefaultRouteInterfaceNames))
    if (!ip) {
      return { available: false as const }
    }

    // Why: STA-2370 — generating a runtime pairing offer is the user's explicit opt-in to remote
    // reach, so widen the loopback listener before advertising its LAN endpoint. If the widen fails the
    // listener stays on loopback, so report unavailable rather than advertise a dead LAN endpoint.
    // "This computer only" is the opposite opt-in: the loopback listener already serves it, and the widen
    // never narrows back, so that pick alone must not expose the runtime off-host.
    const thisComputerOnly = servesThisComputerOnly(args?.reach, ip)
    if (!thisComputerOnly) {
      try {
        await rpcServer.ensureNetworkExposure()
      } catch (error) {
        console.error(
          '[mobile] Network exposure failed while creating a runtime pairing offer:',
          error
        )
        // Why: STA-2370 — carry the specific reason/guidance to the renderer (mirrors the mobile-QR path) so
        // a widen failure is distinguishable from a missing address, not collapsed into a bare unavailable.
        return {
          available: false as const,
          reason: 'network_exposure_failed' as const,
          guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
        }
      }
    }

    // Why: web/desktop runtime clients need full runtime access, not the
    // mobile allowlist used by phone QR pairing.
    const offer = rpcServer.createPairingOffer({
      address: ip,
      rotate: args?.rotate,
      name: `Runtime ${new Date().toLocaleDateString()}`,
      scope: 'runtime',
      // Why: a grant that only ever pointed at loopback must not make the next launch bind every
      // interface when its local client reconnects (that would restore the exposure one restart later).
      reach: thisComputerOnly ? 'this-computer' : 'network'
    })
    if (!offer.available) {
      return { available: false as const }
    }

    return {
      available: true as const,
      pairingUrl: offer.pairingUrl,
      webClientUrl: offer.webClientUrl,
      endpoint: offer.endpoint,
      deviceId: offer.deviceId
    }
  }

  const listDevices = (): {
    devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
  } => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { devices: [] }
    }
    // Why: devices with lastSeenAt === 0 were created during QR generation
    // but never actually scanned/connected. Showing them as "paired" is
    // misleading, so we filter them out.
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

  const listRuntimeAccessGrants = (): { grants: RuntimeAccessGrant[] } => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { grants: [] }
    }
    // Why: generated web/runtime links are bearer credentials even before a
    // client first connects, so pending runtime grants must stay revocable.
    return {
      grants: registry
        .listDevices()
        .filter((d) => d.scope === 'runtime')
        .sort((a, b) => b.pairedAt - a.pairedAt)
        .map(toRuntimeAccessGrant)
    }
  }

  const revokeDevice = async (deviceId: string): Promise<{ revoked: boolean }> => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: await rpcServer.revokeMobileDevice(deviceId) }
  }

  const revokeRuntimeAccess = (deviceId: string): { revoked: boolean } => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: rpcServer.revokeRuntimeAccess(deviceId) }
  }

  const isWebSocketReady = () => ({
    ready: rpcServer.getWebSocketEndpoint() !== null,
    endpoint: rpcServer.getWebSocketEndpoint()
  })

  const getWindowsFirewallStatus: MobilePairingService['getWindowsFirewallStatus'] = (args) => {
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return inspectWindowsMobileFirewall(port, args?.address, firewallEnvironment)
  }

  const repairWindowsFirewall: MobilePairingService['repairWindowsFirewall'] = () => {
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return repairWindowsMobileFirewall(port, firewallEnvironment)
  }

  const openWindowsNetworkSettings = async (): Promise<boolean> => {
    if (firewallEnvironment.platform !== 'win32') {
      return false
    }
    const openSettings =
      dependencies.openWindowsNetworkSettings ??
      (() => shell.openExternal('ms-settings:network-status'))
    await openSettings()
    return true
  }

  const getRelayStatus = (): MobileRelayStatusDetail =>
    dependencies.getRelayStatus?.() ?? { status: 'offline' }

  const consumePendingUnpairedDeviceAuthFailure = (webContentsId: number | null): boolean => {
    if (webContentsId === null) {
      return false
    }
    return dependencies.consumePendingUnpairedDeviceAuthFailure?.(webContentsId) ?? false
  }

  return {
    listNetworkInterfaces,
    getPairingQR,
    getRuntimePairingUrl,
    listDevices,
    listRuntimeAccessGrants,
    revokeDevice,
    revokeRuntimeAccess,
    isWebSocketReady,
    getWindowsFirewallStatus,
    repairWindowsFirewall,
    openWindowsNetworkSettings,
    getRelayStatus,
    consumePendingUnpairedDeviceAuthFailure
  }
}
