import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { PAIRING_METHODS } from './pairing'
import type { PairingRpcContext } from '../core'

function dispatchPairing(
  method: string,
  params: unknown,
  pairing: NonNullable<Parameters<RpcDispatcher['dispatchStreaming']>[2]>['pairing']
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PAIRING_METHODS
    })
    void dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: '', method, params },
      (response) => resolve(JSON.parse(response) as Record<string, unknown>),
      { pairing }
    )
  })
}

describe('pairing RPC methods', () => {
  it('passes only phone-owned credential material to the server-bound provider', async () => {
    const provisionRelay = vi.fn().mockResolvedValue({
      v: 1,
      reqId: 'install-1',
      authorizationMode: 'authenticated-direct',
      currentVersion: 1,
      resumeExpiresAt: Date.now() + 60_000
    })
    const pairing = { getEndpoints: vi.fn(), provisionRelay }

    await expect(
      dispatchPairing(
        'pairing.provisionRelay',
        { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43) },
        pairing
      )
    ).resolves.toMatchObject({ ok: true })
    expect(provisionRelay).toHaveBeenCalledWith({
      reqId: 'install-1',
      newResumeTokenHash: 'A'.repeat(43)
    })
  })

  it('rejects caller-selected identity and authorization metadata', async () => {
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    for (const injected of [
      { relayDeviceId: 'attacker-device' },
      { authorization: { mode: 'relay-basis', basisConnId: 'attacker-basis' } },
      { directAuthId: 'attacker-direct' },
      { acceptedCredentialVersion: 99 }
    ]) {
      await expect(
        dispatchPairing(
          'pairing.provisionRelay',
          { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43), ...injected },
          pairing
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    await expect(
      dispatchPairing(
        'pairing.getEndpoints',
        { installReqId: 'status-1', basisConnId: 'injected' },
        pairing
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(pairing.provisionRelay).not.toHaveBeenCalled()
    expect(pairing.getEndpoints).not.toHaveBeenCalled()
  })

  it('mints a local-only direct offer with the advertised address and QR payload', async () => {
    const pairing: PairingRpcContext = {
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn(),
      ensureNetworkExposure: vi.fn().mockResolvedValue(undefined),
      createMobilePairingOffer: vi.fn().mockResolvedValue({
        available: true,
        pairingUrl: 'orca://pair?code=t',
        endpoint: 'ws://100.64.0.5:6768',
        deviceId: 'dev-1',
        connectionMode: 'local-only'
      }),
      createRuntimePairingOffer: vi.fn()
    }

    await expect(
      dispatchPairing(
        'pairing.mintOffer',
        { address: '100.64.0.5', connectionMode: 'local-only' },
        pairing
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        available: true,
        pairingUrl: 'orca://pair?code=t',
        endpoint: 'ws://100.64.0.5:6768',
        deviceId: 'dev-1',
        connectionMode: 'local-only'
      }
    })
    expect(pairing.createMobilePairingOffer).toHaveBeenCalledWith({
      address: '100.64.0.5',
      connectionMode: 'local-only',
      rotate: undefined,
      name: expect.stringContaining('Mobile')
    })
  })

  it('reports unavailable offers with reason and guidance', async () => {
    const pairing: PairingRpcContext = {
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn(),
      ensureNetworkExposure: vi.fn().mockResolvedValue(undefined),
      createMobilePairingOffer: vi.fn().mockResolvedValue({
        available: false,
        reason: 'websocket_unavailable',
        guidance: 'WebSocket pairing is unavailable.'
      }),
      createRuntimePairingOffer: vi.fn()
    }

    await expect(dispatchPairing('pairing.mintOffer', {}, pairing)).resolves.toMatchObject({
      ok: true,
      result: {
        available: false,
        reason: 'websocket_unavailable',
        guidance: 'WebSocket pairing is unavailable.'
      }
    })
  })

  it('rejects mintOffer with invalid arguments', async () => {
    const pairing: PairingRpcContext = {
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn(),
      ensureNetworkExposure: vi.fn(),
      createMobilePairingOffer: vi.fn(),
      createRuntimePairingOffer: vi.fn()
    }

    await expect(
      dispatchPairing('pairing.mintOffer', { connectionMode: 'relay-only' }, pairing)
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    await expect(
      dispatchPairing('pairing.mintOffer', { rotate: 'yes' }, pairing)
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(pairing.createMobilePairingOffer).not.toHaveBeenCalled()
  })

  it('lists network interfaces over the pure node:os enumeration', async () => {
    await expect(
      dispatchPairing('pairing.listNetworkInterfaces', {}, undefined)
    ).resolves.toMatchObject({ ok: true, result: { interfaces: expect.any(Array) } })
  })
})
