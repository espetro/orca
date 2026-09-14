import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods } from '../core'
import { encodePairingOffer } from '../../../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath
} from '../../../../shared/runtime-environment-store'
import { ENVIRONMENT_STORE_METHODS } from './environment-store'

const { getUserDataPathMock } = vi.hoisted(() => ({ getUserDataPathMock: vi.fn() }))

vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: getUserDataPathMock })
}))

function pairingCode(endpoint = 'ws://192.0.2.10:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function method(name: string) {
  const declaration = eraseRpcMethods(ENVIRONMENT_STORE_METHODS).find(
    (candidate) => candidate.name === name
  )
  if (!declaration) {
    throw new Error(`Missing RPC method: ${name}`)
  }
  return declaration
}

describe('environmentStore RPC methods', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    getUserDataPathMock.mockReset()
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function withStore(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-store-rpc-'))
    tempDirs.push(userDataPath)
    getUserDataPathMock.mockReturnValue(userDataPath)
    return userDataPath
  }

  it('lists saved environments from the on-disk store', async () => {
    const userDataPath = withStore()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    const listed = (await method('environmentStore.list').handler(undefined, {} as never)) as
      | unknown[]
      | PromiseLike<unknown>
    expect(listed).toHaveLength(1)
  })

  it('adds an environment from a pairing code into the same store the CLI reads', async () => {
    const userDataPath = withStore()

    const result = (await method('environmentStore.add').handler(
      { name: 'dev box', pairingCode: pairingCode('ws://192.0.2.11:6768') },
      {} as never
    )) as { name: string; endpoints: { deviceToken: string }[] }

    expect(result.name).toBe('dev box')
    // Why: the web client needs the token and key to open its own socket, so these
    // methods intentionally return unredacted endpoints (unlike `orca environment list --json`).
    expect(result.endpoints[0]!.deviceToken).toBe('device-token')
    expect(addEnvironmentFromPairingCode.length).toBeGreaterThan(0)
    expect(getEnvironmentStorePath(userDataPath)).toContain('orca-environments.json')
  })

  it('rejects an invalid pairing code with invalid_argument', async () => {
    withStore()
    await expect(
      async () =>
        await method('environmentStore.add').handler(
          { name: 'dev box', pairingCode: 'not-a-pairing-code' },
          {} as never
        )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('surfaces duplicate names as invalid_argument instead of a generic failure', async () => {
    const userDataPath = withStore()
    addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode: pairingCode() })

    await expect(
      async () =>
        await method('environmentStore.add').handler(
          { name: 'dev box', pairingCode: pairingCode('ws://192.0.2.12:6768') },
          {} as never
        )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('removes by selector and keeps the store consistent for the CLI', async () => {
    const userDataPath = withStore()
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    const removed = (await method('environmentStore.remove').handler(
      { selector: 'dev box' },
      {} as never
    )) as { id: string; name: string }

    expect(removed.name).toBe('dev box')
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode: pairingCode() })
    ).not.toThrow()
  })
})
