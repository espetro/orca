import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

import { createWebMobileApi } from './web-mobile-api'

// Why: identical-shape checks for return values; host payload passes through untouched.
function hostPayload<T>(value: T): T {
  return value
}

describe('web mobile API routing', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  it('forwards listNetworkInterfaces and returns the host payload', async () => {
    const payload = { interfaces: [{ name: 'eth0', address: '10.0.0.1' }] }
    callRuntimeResult.mockResolvedValueOnce(hostPayload(payload))
    const api = createWebMobileApi().mobile!

    const result = await api.listNetworkInterfaces()

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.listNetworkInterfaces')
    expect(result).toBe(payload)
  })

  it('forwards getPairingQR with its args and returns the host payload', async () => {
    const payload = {
      available: true as const,
      qrDataUrl: 'data:image/png;base64,xxx',
      qrSize: 256,
      pairingUrl: 'https://example/pair',
      endpoint: 'ws://host:1',
      deviceId: 'dev-1',
      connectionMode: 'automatic' as const
    }
    callRuntimeResult.mockResolvedValueOnce(hostPayload(payload))
    const api = createWebMobileApi().mobile!

    const result = await api.getPairingQR({ address: '10.0.0.1', rotate: true })

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.getPairingQR', {
      address: '10.0.0.1',
      rotate: true
    })
    expect(result).toBe(payload)
  })

  it('forwards getRuntimePairingUrl with its args and returns the host payload', async () => {
    const payload = {
      available: true as const,
      pairingUrl: 'https://example/pair',
      webClientUrl: 'https://web.example',
      endpoint: 'ws://host:1',
      deviceId: 'dev-1'
    }
    callRuntimeResult.mockResolvedValueOnce(hostPayload(payload))
    const api = createWebMobileApi().mobile!

    const result = await api.getRuntimePairingUrl({ reach: 'network' })

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.getRuntimePairingUrl', {
      reach: 'network'
    })
    expect(result).toBe(payload)
  })

  it('forwards listDevices and returns the host payload', async () => {
    const payload = {
      devices: [
        { deviceId: 'd-1', name: 'Pixel', pairedAt: 1, lastSeenAt: 2 },
        { deviceId: 'd-2', name: 'iPhone', pairedAt: 3, lastSeenAt: 4 }
      ]
    }
    callRuntimeResult.mockResolvedValueOnce(hostPayload(payload))
    const api = createWebMobileApi().mobile!

    const result = await api.listDevices()

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.listDevices')
    expect(result).toBe(payload)
  })

  it('forwards revokeDevice with the deviceId and returns the host payload', async () => {
    const payload = { revoked: true }
    callRuntimeResult.mockResolvedValueOnce(hostPayload(payload))
    const api = createWebMobileApi().mobile!

    const result = await api.revokeDevice({ deviceId: 'd-1' })

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.revokeDevice', { deviceId: 'd-1' })
    expect(result).toBe(payload)
  })

  it('isWebSocketReady reflects webSocketEndpoint: string -> ready:true', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      desktopWindowStatus: null,
      hostMode: 'serve',
      relayAvailable: false,
      webSocketEndpoint: 'ws://host:1234'
    })
    const api = createWebMobileApi().mobile!

    const result = await api.isWebSocketReady()

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.hostStatus')
    expect(result).toEqual({ ready: true, endpoint: 'ws://host:1234' })
  })

  it('isWebSocketReady reflects webSocketEndpoint: null -> ready:false', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      desktopWindowStatus: null,
      hostMode: 'serve',
      relayAvailable: false,
      webSocketEndpoint: null
    })
    const api = createWebMobileApi().mobile!

    const result = await api.isWebSocketReady()

    expect(result).toEqual({ ready: false, endpoint: null })
  })

  it('getRelayStatus returns registered when mobile.hostStatus reports relayAvailable: true', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      desktopWindowStatus: null,
      hostMode: 'desktop',
      relayAvailable: true,
      webSocketEndpoint: 'ws://host:1'
    })
    const api = createWebMobileApi().mobile!

    const result = await api.getRelayStatus()

    expect(callRuntimeResult).toHaveBeenCalledWith('mobile.hostStatus')
    expect(result).toEqual({ status: 'registered' })
  })

  it('getRelayStatus returns { status: "offline" } when relayAvailable: false', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      desktopWindowStatus: null,
      hostMode: 'serve',
      relayAvailable: false,
      webSocketEndpoint: null
    })
    const api = createWebMobileApi().mobile!

    const result = await api.getRelayStatus()

    expect(result).toEqual({ status: 'offline' })
  })

  it('on RPC error, each call returns a graceful empty shape and does NOT throw', async () => {
    callRuntimeResult.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 'forbidden' })
    )
    const api = createWebMobileApi().mobile!

    await expect(api.listNetworkInterfaces()).resolves.toEqual({ interfaces: [] })
    await expect(api.getPairingQR()).resolves.toEqual({ available: false })
    await expect(api.getRuntimePairingUrl()).resolves.toEqual({ available: false })
    await expect(api.listDevices()).resolves.toEqual({ devices: [] })
    await expect(api.revokeDevice({ deviceId: 'd' })).resolves.toEqual({ revoked: false })
    await expect(api.isWebSocketReady()).resolves.toEqual({ ready: false, endpoint: null })
    await expect(api.getRelayStatus()).resolves.toEqual({ status: 'offline' })
  })

  it('Windows-firewall stubs return their existing disabled shells', () => {
    const api = createWebMobileApi().mobile!

    return Promise.all([
      expect(api.getWindowsFirewallStatus()).resolves.toEqual({ supported: false }),
      expect(api.repairWindowsFirewall()).resolves.toEqual({ ok: false, reason: 'unsupported' }),
      expect(api.openWindowsNetworkSettings()).resolves.toBe(false)
    ])
  })

  it('listRuntimeAccessGrants and revokeRuntimeAccess stay host-local shells', async () => {
    const api = createWebMobileApi().mobile!

    await expect(api.listRuntimeAccessGrants()).resolves.toEqual({ grants: [] })
    await expect(api.revokeRuntimeAccess({ deviceId: 'd' })).resolves.toEqual({ revoked: false })
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('subscribe handlers return a no-op unsubscribe function', () => {
    const api = createWebMobileApi().mobile!
    const onUnpairedDeviceAuthFailure = api.onUnpairedDeviceAuthFailure!
    const onRelayStatusChanged = api.onRelayStatusChanged!

    const relayUnsub = onRelayStatusChanged(() => {})
    const authUnsub = onUnpairedDeviceAuthFailure(() => {})

    expect(typeof relayUnsub).toBe('function')
    expect(typeof authUnsub).toBe('function')
    expect(() => relayUnsub()).not.toThrow()
    expect(() => authUnsub()).not.toThrow()
  })

  it('consumePendingUnpairedDeviceAuthFailure returns false (Windows-only stub)', async () => {
    const api = createWebMobileApi().mobile!
    const consume = api.consumePendingUnpairedDeviceAuthFailure!
    await expect(consume()).resolves.toBe(false)
  })
})
