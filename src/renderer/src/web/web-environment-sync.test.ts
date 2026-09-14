import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

import {
  addEnvironmentOnServer,
  getServerPairingOfferCode,
  isServerBackedEnvironmentSync,
  markEnvironmentRemovedOnServer,
  mergeServerEnvironments,
  removeEnvironmentOnServer,
  resetEnvironmentSyncProbe,
  setEnvironmentStoreCaller,
  syncEnvironmentsFromServer,
  type EnvironmentStoreCaller
} from './web-environment-sync'
import { readStoredWebRuntimeEnvironments } from './web-runtime-environment'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

function serverEnvironment(id: string, name: string) {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket' as const,
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:1234',
        deviceToken: 'token',
        publicKeyB64: 'public-key'
      }
    ]
  }
}

function callerFromResponses(
  responses: Record<string, RuntimeRpcResponse<unknown>>
): EnvironmentStoreCaller {
  const calls: { method: string; params: unknown }[] = []
  const caller = (async <TResult>(method: string, params?: unknown) => {
    calls.push({ method, params })
    const response = responses[method]!
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as TResult
  }) as EnvironmentStoreCaller
  void calls
  return caller
}

function callerThrowing(message: string): EnvironmentStoreCaller {
  return (async () => {
    throw new Error(message)
  }) as EnvironmentStoreCaller
}

describe('web environment sync', () => {
  beforeEach(() => {
    vi.resetModules()
    resetEnvironmentSyncProbe()
    setEnvironmentStoreCaller(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('merges server environments into the local registry, keeping local-only entries', () => {
    installBrowserGlobals()
    writeStoredRuntimeEnvironment(globalThis.window.localStorage, 'web-env-1')

    const local = readStoredWebRuntimeEnvironments()
    const merged = mergeServerEnvironments(local, [
      serverEnvironment('srv-1', 'CLI server'),
      serverEnvironment('web-env-1', 'Test runtime')
    ])

    expect(merged.environments.map((entry) => entry.id)).toEqual(['srv-1', 'web-env-1'])
    expect(merged.activeEnvironmentId).toBe('web-env-1')
  })

  it('adopts the server list and persists it as the local cache', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    setEnvironmentStoreCaller(
      callerFromResponses({
        'environmentStore.list': {
          id: '1',
          ok: true,
          result: [serverEnvironment('srv-1', 'CLI server')],
          _meta: { runtimeId: 'rt' }
        }
      })
    )

    const synced = await syncEnvironmentsFromServer()

    expect(synced.environments.map((entry) => entry.id)).toEqual(['srv-1', 'web-env-1'])
    expect(isServerBackedEnvironmentSync()).toBe(true)
  })

  it('falls back to the localStorage registry when the server lacks the API', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    setEnvironmentStoreCaller(callerThrowing('Unknown method: environmentStore.list'))

    const synced = await syncEnvironmentsFromServer()

    expect(synced.environments.map((entry) => entry.id)).toEqual(['web-env-1'])
    expect(isServerBackedEnvironmentSync()).toBe(false)
    resetEnvironmentSyncProbe()
  })

  it('does not call the server store again while the probe said unsupported', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    const calls: string[] = []
    setEnvironmentStoreCaller((async (method: string) => {
      calls.push(method)
      throw new Error('method_not_found')
    }) as EnvironmentStoreCaller)
    await syncEnvironmentsFromServer()

    await syncEnvironmentsFromServer()

    expect(calls).toEqual(['environmentStore.list'])
  })

  it('pushes browser-paired environments to the server store under the server id', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage, 'srv-active')
    setEnvironmentStoreCaller(
      callerFromResponses({
        'environmentStore.list': {
          id: '1',
          ok: true,
          result: [serverEnvironment('srv-active', 'active')],
          _meta: { runtimeId: 'rt' }
        },
        'environmentStore.add': {
          id: '2',
          ok: true,
          result: { id: 'srv-new' },
          _meta: { runtimeId: 'rt' }
        }
      })
    )
    await syncEnvironmentsFromServer()

    const local = readStoredWebRuntimeEnvironments()
    const paired = { ...local.environments[0]!, id: 'local-draft', name: 'Browser host' }
    globals.storage.setItem(
      'orca.web.runtimeEnvironments.v2',
      JSON.stringify({
        environments: [...local.environments, paired],
        activeEnvironmentId: 'srv-active'
      })
    )
    await addEnvironmentOnServer({
      environment: paired,
      pairingCode: getServerPairingOfferCode({
        v: 2,
        endpoint: 'wss://server.example:443',
        deviceToken: 'server-token',
        publicKeyB64: 'server-key'
      })
    })

    const state = readStoredWebRuntimeEnvironments()
    expect(state.environments.map((entry) => entry.id)).toContain('srv-new')
    expect(state.environments.map((entry) => entry.id)).not.toContain('local-draft')
  })

  it('removes environments from the server store by id', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    const calls: { method: string; params: unknown }[] = []
    setEnvironmentStoreCaller((async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return method === 'environmentStore.list'
        ? [serverEnvironment('srv-active', 'active')]
        : { id: 'srv-gone' }
    }) as unknown as EnvironmentStoreCaller)
    await syncEnvironmentsFromServer()

    await removeEnvironmentOnServer('srv-gone')

    expect(calls[1]).toEqual({
      method: 'environmentStore.remove',
      params: { selector: 'srv-gone' }
    })
  })

  it('skips server mutations when the runtime does not expose the store API', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    setEnvironmentStoreCaller(callerThrowing('method_not_found'))
    await syncEnvironmentsFromServer()

    await expect(
      addEnvironmentOnServer({
        environment: {
          ...readStoredWebRuntimeEnvironments().environments[0]!,
          name: 'Browser host'
        },
        pairingCode: getServerPairingOfferCode({
          v: 2,
          endpoint: 'wss://server.example:443',
          deviceToken: 'server-token',
          publicKeyB64: 'server-key'
        })
      })
    ).resolves.toBeUndefined()
  })

  it('encodes a pairing code the server store can parse', () => {
    expect(
      getServerPairingOfferCode({
        v: 2,
        endpoint: 'wss://server.example:443',
        deviceToken: 'server-token',
        publicKeyB64: 'server-key'
      })
    ).toMatch(/^orca:\/\/pair\?code=/)
  })

  it('keeps scope in the encoded pairing code', () => {
    const code = getServerPairingOfferCode({
      v: 2,
      endpoint: 'wss://server.example:443',
      deviceToken: 'server-token',
      publicKeyB64: 'server-key',
      scope: 'runtime'
    })
    const encoded = new URL(code).searchParams.get('code')!
    const json = JSON.parse(
      atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((encoded.length + 3) % 4))
    ) as { scope?: string }
    expect(json.scope).toBe('runtime')
  })

  it('tombstones environments whose server-side remove failed and clears the tombstone once the server drops the id', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    let removeShouldFail = true
    let serverEnvironments = [
      serverEnvironment('srv-active', 'active'),
      serverEnvironment('srv-gone', 'stale')
    ]
    setEnvironmentStoreCaller((async (method: string, params?: unknown) => {
      if (method === 'environmentStore.list') {
        return serverEnvironments
      }
      if (method === 'environmentStore.remove') {
        if (removeShouldFail) {
          throw new Error('remove unavailable')
        }
        serverEnvironments = serverEnvironments.filter(
          (entry) => entry.id !== (params as { selector: string }).selector
        )
        return { id: (params as { selector: string }).selector }
      }
      throw new Error(`unexpected method: ${String(method)}`)
    }) as unknown as EnvironmentStoreCaller)
    await syncEnvironmentsFromServer()

    await expect(removeEnvironmentOnServer('srv-gone')).rejects.toThrow('remove unavailable')
    markEnvironmentRemovedOnServer('srv-gone')

    // The failed remove must not resurrect the entry on the next sync.
    const synced = await syncEnvironmentsFromServer()
    expect(synced.environments.map((entry) => entry.id)).toEqual(['srv-active', 'web-env-1'])
    expect(readStoredWebRuntimeEnvironments().environments.map((entry) => entry.id)).toEqual([
      'srv-active',
      'web-env-1'
    ])

    // Once the server stops listing the id, the tombstone clears so a future
    // re-add with the same id would survive a sync.
    const secondSync = await syncEnvironmentsFromServer()
    expect(secondSync.environments.map((entry) => entry.id)).toEqual(['srv-active', 'web-env-1'])

    // Once the server stops listing the id (remove succeeds on a later
    // attempt), the sync clears the tombstone.
    removeShouldFail = false
    await removeEnvironmentOnServer('srv-gone')
    const thirdSync = await syncEnvironmentsFromServer()
    expect(thirdSync.environments.map((entry) => entry.id)).toEqual(['srv-active', 'web-env-1'])

    // With the tombstone cleared, a re-added environment must survive merges.
    serverEnvironments = [...serverEnvironments, serverEnvironment('srv-gone', 're-added')]
    const fourthSync = await syncEnvironmentsFromServer()
    expect(fourthSync.environments.map((entry) => entry.id)).toEqual([
      'srv-active',
      'srv-gone',
      'web-env-1'
    ])
  })

  it('warns on server sync failures without changing the fallback behavior', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const globals = installBrowserGlobals()
      writeStoredRuntimeEnvironment(globals.storage)
      setEnvironmentStoreCaller(callerThrowing('method_not_found'))
      const synced = await syncEnvironmentsFromServer()
      expect(synced.environments.map((entry) => entry.id)).toEqual(['web-env-1'])
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('environmentStore.list failed:'),
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('returns the local registry untouched when nothing is paired', async () => {
    const globals = installBrowserGlobals()
    const synced = await syncEnvironmentsFromServer()
    expect(synced).toEqual({ environments: [], activeEnvironmentId: null })
    expect(globals.storage.getItem('orca.web.runtimeEnvironments.v2')).toBeNull()
  })

  it('does not mark the server unsupported while a probe is still pending', async () => {
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    let resolveProbe!: (value: unknown) => void
    let probePromise!: Promise<unknown>
    setEnvironmentStoreCaller((() => {
      probePromise = new Promise((resolve) => {
        resolveProbe = resolve
      })
      return probePromise
    }) as EnvironmentStoreCaller)
    const syncing = syncEnvironmentsFromServer()
    await expect(Promise.race([syncing, Promise.resolve('pending')])).resolves.toBe('pending')
    // The probe must stay un-armed (retriable) and must NOT flip to unsupported.
    expect(isServerBackedEnvironmentSync()).toBe(false)
    resolveProbe([serverEnvironment('srv-1', 'CLI server')])
    await expect(syncing).resolves.toMatchObject({
      environments: expect.arrayContaining([
        expect.objectContaining({ id: 'srv-1' }),
        expect.objectContaining({ id: 'web-env-1' })
      ])
    })
    expect(isServerBackedEnvironmentSync()).toBe(true)
  })
})
