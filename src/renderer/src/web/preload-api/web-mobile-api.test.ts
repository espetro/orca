import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../../preload/api-types'
import { installBrowserGlobals } from '../web-preload-api-test-harness'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

describe('web mobile pairing API routing', () => {
  let createWebMobileApi: () => Partial<PreloadApi>

  beforeEach(async () => {
    vi.resetModules()
    installBrowserGlobals()
    callRuntimeResult.mockReset().mockResolvedValue(null)
    ;({ createWebMobileApi } = await import('./web-mobile-api'))
  })

  it('routes getPairingQR to the pairing.mintOffer RPC with the caller args', async () => {
    const offer = {
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      qrSize: 132,
      pairingUrl: 'orca://pair?code=t',
      endpoint: 'ws://100.64.0.5:6768',
      deviceId: 'dev-1',
      connectionMode: 'local-only'
    }
    callRuntimeResult.mockResolvedValue(offer)

    await expect(
      createWebMobileApi().mobile!.getPairingQR!({
        address: '100.64.0.5',
        connectionMode: 'local-only'
      })
    ).resolves.toEqual(offer)

    expect(callRuntimeResult).toHaveBeenCalledWith('pairing.mintOffer', {
      address: '100.64.0.5',
      connectionMode: 'local-only'
    })
  })

  it('routes listNetworkInterfaces to the pairing RPC and soft-fails to an empty list', async () => {
    callRuntimeResult.mockResolvedValueOnce({
      interfaces: [{ name: 'utun5', address: '100.64.0.5' }]
    })
    await expect(createWebMobileApi().mobile!.listNetworkInterfaces!()).resolves.toEqual({
      interfaces: [{ name: 'utun5', address: '100.64.0.5' }]
    })
    expect(callRuntimeResult).toHaveBeenCalledWith('pairing.listNetworkInterfaces')

    callRuntimeResult.mockRejectedValueOnce(new Error('transport down'))
    await expect(createWebMobileApi().mobile!.listNetworkInterfaces!()).resolves.toEqual({
      interfaces: []
    })
  })

  it('routes getRuntimePairingUrl to the pairing RPC', async () => {
    const offer = {
      available: true,
      pairingUrl: 'orca://pair?code=r',
      webClientUrl: null,
      endpoint: 'ws://192.168.1.10:6768',
      deviceId: 'dev-2'
    }
    callRuntimeResult.mockResolvedValue(offer)

    await expect(
      createWebMobileApi().mobile!.getRuntimePairingUrl!({ rotate: true })
    ).resolves.toEqual(offer)
    expect(callRuntimeResult).toHaveBeenCalledWith('pairing.getRuntimePairingUrl', { rotate: true })
  })
})
