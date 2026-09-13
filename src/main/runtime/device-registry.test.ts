import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

describe('DeviceRegistry pairing offer expiry', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-ttl-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const readRegistry = (): unknown[] =>
    JSON.parse(readFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), 'utf-8')) as unknown[]

  it('rejects a never-scanned token whose expiresAt has passed', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', { ttlMs: 60_000 })
    expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)

    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    expect(registry.validateToken(device.token)).toBeNull()
  })

  it('never expires a paired device even with an expiresAt in the past', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', { ttlMs: 60_000 })
    registry.updateLastSeen(device.deviceId)

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))
    expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
  })

  it('extends expiresAt on every repeat call with ttlMs', () => {
    const registry = new DeviceRegistry(userDataPath)
    const first = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', { ttlMs: 60_000 })
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    const second = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', { ttlMs: 60_000 })

    expect(second.deviceId).toBe(first.deviceId)
    expect(first.expiresAt).toBe(Date.parse('2026-01-01T00:01:00Z'))
    expect(second.expiresAt).toBe(Date.parse('2026-01-01T00:01:30Z'))
  })

  it('clears a stale expiresAt when the offer is re-minted without a ttlMs', () => {
    const registry = new DeviceRegistry(userDataPath)
    const first = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', { ttlMs: 60_000 })
    const second = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network')

    expect(second.deviceId).toBe(first.deviceId)
    expect(second.expiresAt).toBeUndefined()
    expect(registry.validateToken(first.token)?.deviceId).toBe(first.deviceId)
  })

  it('garbage-collects expired pending entries on the next write', () => {
    const registry = new DeviceRegistry(userDataPath)
    const expired = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', {
      ttlMs: 60_000
    })
    const paired = registry.addDevice('Phone', 'mobile')
    registry.updateLastSeen(paired.deviceId)

    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    // A write unrelated to the expired offer must drop it from memory and disk.
    registry.addDevice('Phone', 'mobile')

    expect(registry.getDevice(expired.deviceId)).toBeNull()
    expect(registry.getDevice(paired.deviceId)?.deviceId).toBe(paired.deviceId)
    expect(
      readRegistry().some((d) => (d as { deviceId: string }).deviceId === expired.deviceId)
    ).toBe(false)
  })

  it('rotatePendingDevice still invalidates the prior pending token', () => {
    const registry = new DeviceRegistry(userDataPath)
    const first = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', { ttlMs: 600_000 })
    const second = registry.rotatePendingDevice('CLI', 'runtime', 'network')

    expect(registry.validateToken(first.token)).toBeNull()
    expect(registry.validateToken(second.token)?.deviceId).toBe(second.deviceId)
  })

  it('treats old-registry entries without expiresAt as non-expiring', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network')
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))

    expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
    // A later write must not GC an entry with no expiry.
    registry.addDevice('Phone', 'mobile')
    expect(
      readRegistry().some((d) => (d as { deviceId: string }).deviceId === device.deviceId)
    ).toBe(true)
  })
})
