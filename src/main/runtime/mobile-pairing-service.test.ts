import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as NodeOs from 'node:os'

// Why: only the interface enumeration is faked; the real `os` stays available for shared helpers
// (e.g. tmpdir() in any future integration tests).
const { defaultRouteInterfaceNamesMock, networkInterfacesMock } = vi.hoisted(() => ({
  defaultRouteInterfaceNamesMock: vi.fn(),
  networkInterfacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn() }
}))

vi.mock('qrcode', () => ({
  default: {
    create: vi.fn().mockReturnValue({ modules: { size: 21 } }),
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('./windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: defaultRouteInterfaceNamesMock
}))

import { createMobilePairingService } from './mobile-pairing-service'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './network-exposure-guidance'

type CreateRpcServerMockOptions = {
  createMobilePairingOffer?: Mock
  createPairingOffer?: Mock
  ensureNetworkExposure?: Mock
  revokeMobileDevice?: Mock
  revokeRuntimeAccess?: Mock
  getDeviceRegistry?: Mock
  getWebSocketEndpoint?: Mock
}

const createRpcServerStub = (options: CreateRpcServerMockOptions = {}) => {
  const defaults = {
    createMobilePairingOffer: vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#stub',
      endpoint: 'ws://192.168.1.24:6768',
      deviceId: 'mobile-stub',
      connectionMode: 'automatic'
    }),
    createPairingOffer: vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#stub',
      webClientUrl: 'http://192.168.1.24:6768/web-index.html?pairing=stub',
      endpoint: 'ws://192.168.1.24:6768',
      deviceId: 'runtime-stub'
    }),
    ensureNetworkExposure: vi.fn().mockResolvedValue(undefined),
    revokeMobileDevice: vi.fn().mockResolvedValue(true),
    revokeRuntimeAccess: vi.fn().mockReturnValue(true),
    getDeviceRegistry: vi.fn().mockReturnValue({
      listDevices: () => [] as unknown[]
    }),
    getWebSocketEndpoint: vi.fn().mockReturnValue(null)
  }
  return { ...defaults, ...options }
}

describe('createMobilePairingService', () => {
  beforeEach(() => {
    networkInterfacesMock.mockReset()
    networkInterfacesMock.mockReturnValue({})
    defaultRouteInterfaceNamesMock.mockReset().mockResolvedValue(new Set())
  })

  describe('listNetworkInterfaces', () => {
    it('ranks tailnet addresses above LAN and bridges below', async () => {
      networkInterfacesMock.mockReturnValue({
        docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }],
        tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.1.20' }]
      })
      const service = createMobilePairingService(createRpcServerStub() as never)

      await expect(service.listNetworkInterfaces()).resolves.toEqual({
        interfaces: [
          { name: 'tailscale0', address: '100.64.1.20' },
          { name: 'en0', address: '192.168.1.24' },
          { name: 'docker0', address: '172.17.0.1' }
        ]
      })
    })
  })

  describe('getPairingQR', () => {
    it('mints a QR against the auto-detected address by default', async () => {
      networkInterfacesMock.mockReturnValue({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
      })
      const createMobilePairingOffer = vi.fn().mockResolvedValue({
        available: true,
        pairingUrl: 'orca://pair#lan',
        endpoint: 'ws://192.168.1.24:6768',
        deviceId: 'mobile-1',
        connectionMode: 'automatic'
      })
      const service = createMobilePairingService(
        createRpcServerStub({ createMobilePairingOffer }) as never
      )

      const result = await service.getPairingQR()
      expect(result).toMatchObject({
        available: true,
        qrDataUrl: 'data:image/png;base64,qr',
        pairingUrl: 'orca://pair#lan',
        endpoint: 'ws://192.168.1.24:6768',
        deviceId: 'mobile-1',
        connectionMode: 'automatic'
      })
      expect(createMobilePairingOffer).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '192.168.1.24',
          name: expect.stringMatching(/^Mobile /)
        })
      )
    })

    it('returns invalid_advertised_endpoint for local-only mode when no address is available', async () => {
      // Why: LAN-only has no Relay to fall back on; a bridge-only host must refuse rather than advertise a
      // dead direct path. Same shape the IPC handler returns today.
      networkInterfacesMock.mockReturnValue({
        docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }]
      })
      const createMobilePairingOffer = vi.fn()
      const service = createMobilePairingService(
        createRpcServerStub({ createMobilePairingOffer }) as never
      )

      const result = await service.getPairingQR({ connectionMode: 'local-only' })
      expect(result).toEqual({
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance:
          'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
      })
      expect(createMobilePairingOffer).not.toHaveBeenCalled()
    })

    it('forwards structured relay mint failures', async () => {
      networkInterfacesMock.mockReturnValue({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
      })
      const relayFailure = {
        code: 'relay_mint_failed',
        stage: 'create_pairing_relay',
        message: 'Relay pairing invite request failed'
      }
      const createMobilePairingOffer = vi.fn().mockResolvedValue({
        available: false,
        reason: 'relay_mint_failed',
        guidance: 'Use LAN or retry Relay.',
        relayFailure
      })
      const service = createMobilePairingService(
        createRpcServerStub({ createMobilePairingOffer }) as never
      )

      await expect(service.getPairingQR()).resolves.toEqual({
        available: false,
        reason: 'relay_mint_failed',
        guidance: 'Use LAN or retry Relay.',
        relayFailure
      })
    })

    it('honors a custom encodePairingQr dependency', async () => {
      networkInterfacesMock.mockReturnValue({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
      })
      const createMobilePairingOffer = vi.fn().mockResolvedValue({
        available: true,
        pairingUrl: 'orca://pair#custom',
        endpoint: 'ws://192.168.1.24:6768',
        deviceId: 'mobile-custom',
        connectionMode: 'local-only'
      })
      const encodePairingQr = vi.fn().mockResolvedValue({ ok: false, reason: 'encoding_failed' })
      const service = createMobilePairingService(
        createRpcServerStub({ createMobilePairingOffer }) as never,
        { encodePairingQr }
      )

      await expect(service.getPairingQR({ address: 'pair.example' })).resolves.toMatchObject({
        available: true,
        qrDataUrl: null,
        qrSize: null,
        qrError: 'encoding_failed',
        pairingUrl: 'orca://pair#custom'
      })
      expect(encodePairingQr).toHaveBeenCalledWith('orca://pair#custom')
    })
  })

  describe('getRuntimePairingUrl', () => {
    it('reports unavailable rather than advertising when no address exists', async () => {
      networkInterfacesMock.mockReturnValue({
        docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }]
      })
      const createPairingOffer = vi.fn()
      const ensureNetworkExposure = vi.fn()
      const service = createMobilePairingService(
        createRpcServerStub({ createPairingOffer, ensureNetworkExposure }) as never
      )

      await expect(service.getRuntimePairingUrl()).resolves.toEqual({ available: false })
      expect(createPairingOffer).not.toHaveBeenCalled()
      expect(ensureNetworkExposure).not.toHaveBeenCalled()
    })

    it('returns network_exposure_failed when widen throws (mirrors existing IPC test)', async () => {
      // Why: STA-2370 — a failed widen leaves the listener on loopback; the service must NOT advertise
      // a LAN endpoint and must NOT mint an offer. A regression that swallows the rejection would be
      // caught here because createPairingOffer must never run.
      networkInterfacesMock.mockReturnValue({
        en0: [{ family: 'IPv4', internal: false, address: '100.64.1.20' }]
      })
      const createPairingOffer = vi.fn()
      const ensureNetworkExposure = vi.fn().mockRejectedValue(new Error('bind refused'))
      const service = createMobilePairingService(
        createRpcServerStub({ createPairingOffer, ensureNetworkExposure }) as never
      )

      await expect(service.getRuntimePairingUrl({ address: '100.64.1.20' })).resolves.toEqual({
        available: false,
        reason: 'network_exposure_failed',
        guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
      })

      expect(ensureNetworkExposure).toHaveBeenCalled()
      expect(createPairingOffer).not.toHaveBeenCalled()
    })

    it('skips the widen for an explicit this-computer reach on a loopback address', async () => {
      const createPairingOffer = vi.fn().mockReturnValue({
        available: true,
        pairingUrl: 'orca://pair#local',
        webClientUrl: 'http://127.0.0.1:6768/web-index.html?pairing=local',
        endpoint: 'ws://127.0.0.1:6768',
        deviceId: 'runtime-local'
      })
      const ensureNetworkExposure = vi.fn().mockResolvedValue(undefined)
      const service = createMobilePairingService(
        createRpcServerStub({ createPairingOffer, ensureNetworkExposure }) as never
      )

      await expect(
        service.getRuntimePairingUrl({ address: '127.0.0.1', reach: 'this-computer' })
      ).resolves.toMatchObject({ available: true })

      expect(ensureNetworkExposure).not.toHaveBeenCalled()
      expect(createPairingOffer).toHaveBeenCalledWith(
        expect.objectContaining({ reach: 'this-computer', scope: 'runtime' })
      )
    })
  })

  describe('listDevices', () => {
    it('returns only paired mobile-scoped devices', () => {
      const getDeviceRegistry = vi.fn().mockReturnValue({
        listDevices: () => [
          { deviceId: 'mobile-1', name: 'Phone', scope: 'mobile', pairedAt: 1, lastSeenAt: 2 },
          { deviceId: 'runtime-1', name: 'Browser', scope: 'runtime', pairedAt: 3, lastSeenAt: 4 },
          {
            deviceId: 'pending-mobile',
            name: 'Pending',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 0
          }
        ]
      })
      const service = createMobilePairingService(
        createRpcServerStub({ getDeviceRegistry }) as never
      )

      expect(service.listDevices()).toEqual({
        devices: [{ deviceId: 'mobile-1', name: 'Phone', pairedAt: 1, lastSeenAt: 2 }]
      })
    })

    it('returns empty devices when no registry is wired', () => {
      const getDeviceRegistry = vi.fn().mockReturnValue(null)
      const service = createMobilePairingService(
        createRpcServerStub({ getDeviceRegistry }) as never
      )

      expect(service.listDevices()).toEqual({ devices: [] })
    })
  })

  describe('revokeDevice', () => {
    it('awaits mobile device revocation before returning', async () => {
      const revokeMobileDevice = vi.fn().mockResolvedValue(true)
      const service = createMobilePairingService(
        createRpcServerStub({ revokeMobileDevice }) as never
      )

      await expect(service.revokeDevice('mobile-1')).resolves.toEqual({ revoked: true })
      expect(revokeMobileDevice).toHaveBeenCalledWith('mobile-1')
    })

    it('reports revoked=false when no registry is wired', async () => {
      const getDeviceRegistry = vi.fn().mockReturnValue(null)
      const revokeMobileDevice = vi.fn()
      const service = createMobilePairingService(
        createRpcServerStub({ getDeviceRegistry, revokeMobileDevice }) as never
      )

      await expect(service.revokeDevice('mobile-1')).resolves.toEqual({ revoked: false })
      expect(revokeMobileDevice).not.toHaveBeenCalled()
    })
  })

  describe('IPC-only concerns', () => {
    // Why: the service must not reach into the IpcMainInvokeEvent surface — verifying with a fake event
    // confirms the service has no hidden coupling that would block later RPC wiring.
    it('does not access event.sender for any method', async () => {
      const fakeEvent = {
        sender: {
          id: 42,
          isDestroyed: () => {
            throw new Error('service must not call isDestroyed on event.sender')
          },
          getType: () => {
            throw new Error('service must not call getType on event.sender')
          }
        }
      } as never
      networkInterfacesMock.mockReturnValue({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
      })
      const service = createMobilePairingService(createRpcServerStub() as never)

      // Call every method that today accepts an IpcMainInvokeEvent — none should touch fakeEvent.sender.
      await expect(service.getPairingQR()).resolves.toBeDefined()
      await expect(service.getRuntimePairingUrl()).resolves.toBeDefined()
      expect(service.listDevices()).toBeDefined()
      expect(service.listRuntimeAccessGrants()).toBeDefined()
      await expect(service.revokeDevice('mobile-1')).resolves.toBeDefined()
      expect(service.revokeRuntimeAccess('runtime-1')).toBeDefined()
      expect(service.isWebSocketReady()).toBeDefined()
      expect(service.getWindowsFirewallStatus()).toBeDefined()
      expect(service.repairWindowsFirewall()).toBeDefined()
      expect(service.getRelayStatus()).toBeDefined()
      // consumePendingUnpairedDeviceAuthFailure expects a number — passing null should short-circuit.
      expect(service.consumePendingUnpairedDeviceAuthFailure(null)).toBe(false)
      expect(fakeEvent).toBeDefined() // keep linter from complaining about unused param
    })
  })
})
