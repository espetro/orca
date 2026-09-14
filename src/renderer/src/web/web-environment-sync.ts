// Why: saved servers added from the CLI (orca environment add, stored in
// orca-environments.json) should appear in the web UI, and environments added
// in the browser should be usable by the CLI. This module syncs the browser's
// localStorage registry with the server-backed store over RPC. localStorage
// stays as the offline cache; the server store is the authority whenever the
// connected runtime exposes environmentStore.* methods.
import type { WebPairingOffer } from './web-pairing'
import {
  readStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironments,
  saveStoredWebRuntimeEnvironments,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'

type EnvironmentStoreMethods =
  | 'environmentStore.list'
  | 'environmentStore.add'
  | 'environmentStore.remove'

type StoredWebRuntimeEnvironments = ReturnType<typeof readStoredWebRuntimeEnvironments>

type EnvironmentStoreSyncState = {
  serverBacked: boolean | null
}

const syncState: EnvironmentStoreSyncState = { serverBacked: null }

// Why: when a server-side remove fails, the next successful sync would otherwise
// resurrect the environment in localStorage even though the user already removed
// it locally. Tombstones record ids the server was asked to remove so merges skip
// them until the server actually stops listing the id, then clear the way for a
// future re-add with the same id.
const ENVIRONMENT_TOMBSTONES_STORAGE_KEY = 'orca.web.environmentSync.removed.v1'

function readEnvironmentTombstones(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set()
  }
  try {
    const raw = window.localStorage.getItem(ENVIRONMENT_TOMBSTONES_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (!Array.isArray(parsed)) {
      return new Set()
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

function writeEnvironmentTombstones(ids: Set<string>): void {
  if (typeof window === 'undefined') {
    return
  }
  if (ids.size === 0) {
    window.localStorage.removeItem(ENVIRONMENT_TOMBSTONES_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(ENVIRONMENT_TOMBSTONES_STORAGE_KEY, JSON.stringify([...ids]))
}

export function markEnvironmentRemovedOnServer(id: string): void {
  const tombstones = readEnvironmentTombstones()
  if (tombstones.has(id)) {
    return
  }
  tombstones.add(id)
  writeEnvironmentTombstones(tombstones)
}

// Why: short enough that a hung runtime cannot stall UI list() calls, long
// enough to cover a normal RTT through the shared call queue.
const ENVIRONMENT_SYNC_PROBE_TIMEOUT_MS = 5_000

// Why: tests (and a reconnecting client) need to re-arm the probe; export the reset.
export function resetEnvironmentSyncProbe(): void {
  syncState.serverBacked = null
  lastProbedEnvironmentId = null
}

// Why: the browser may be talking to multiple orca instances across a session;
// re-probe whenever the active environment's identity changes.
let lastProbedEnvironmentId: string | null = null

export function isServerBackedEnvironmentSync(): boolean {
  return syncState.serverBacked === true
}

// Why: the caller is injected so the sync reuses the web app's shared runtime
// client pool (no extra sockets) and stays hermetic in unit tests.
export type EnvironmentStoreCaller = <TResult>(
  method: EnvironmentStoreMethods,
  params?: unknown
) => Promise<TResult>

let caller: EnvironmentStoreCaller | null = null

export function setEnvironmentStoreCaller(next: EnvironmentStoreCaller | null): void {
  caller = next
}

async function callEnvironmentStore<TResult>(
  method: EnvironmentStoreMethods,
  params?: unknown
): Promise<TResult> {
  if (!caller) {
    throw new Error('environment store caller not installed')
  }
  return await caller<TResult>(method, params)
}

export async function syncEnvironmentsFromServer(): Promise<StoredWebRuntimeEnvironments> {
  const active = readStoredWebRuntimeEnvironment()
  const local = readStoredWebRuntimeEnvironments()
  if (!active) {
    return local
  }
  if (lastProbedEnvironmentId !== active.id) {
    syncState.serverBacked = null
    lastProbedEnvironmentId = active.id
  }
  if (syncState.serverBacked === false) {
    return local
  }
  try {
    // Why: the probe rides the shared runtime queue, so an unreachable runtime
    // could stall every list() call for the full call timeout. Bound the probe
    // itself; a timeout leaves the probe un-armed so a later list retries.
    const probe = callEnvironmentStore<StoredWebRuntimeEnvironment[]>('environmentStore.list')
    const serverEnvironments = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ENVIRONMENT_SYNC_PROBE_TIMEOUT_MS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      })
    ])
    if (serverEnvironments === null) {
      return local
    }
    syncState.serverBacked = true
    return mergeServerEnvironments(local, serverEnvironments)
  } catch (error) {
    // Why: older orcad builds do not expose environmentStore.*; keep the
    // localStorage registry authoritative so nothing breaks.
    console.warn('[web-environment-sync] environmentStore.list failed:', describeSyncError(error))
    syncState.serverBacked = false
    return local
  }
}

// Why: field divergence (server-backed sync silently degrading) needs a trail;
// log only the shape of the error, never tokens or endpoints.
function describeSyncError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      return code
    }
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}

export function mergeServerEnvironments(
  local: StoredWebRuntimeEnvironments,
  serverEnvironments: StoredWebRuntimeEnvironment[]
): StoredWebRuntimeEnvironments {
  const byId = new Map<string, StoredWebRuntimeEnvironment>()
  // Why: ids the server failed to remove stay tombstoned so the merge does not
  // resurrect them; once the server list drops an id, the tombstone clears.
  const tombstones = readEnvironmentTombstones()
  const remainingTombstones = new Set<string>()
  for (const entry of serverEnvironments) {
    if (tombstones.has(entry.id)) {
      remainingTombstones.add(entry.id)
      continue
    }
    byId.set(entry.id, entry)
  }
  // Why: environments created locally but not yet pushed (offline pairing) survive a
  // refresh instead of being dropped by the server list.
  for (const entry of local.environments) {
    if (!byId.has(entry.id) && !tombstones.has(entry.id)) {
      byId.set(entry.id, entry)
    }
  }
  writeEnvironmentTombstones(remainingTombstones)
  const environments = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  const activeEnvironmentId =
    local.activeEnvironmentId && byId.has(local.activeEnvironmentId)
      ? local.activeEnvironmentId
      : (environments[0]?.id ?? null)
  const next = { environments, activeEnvironmentId }
  saveStoredWebRuntimeEnvironments(next)
  return next
}

export async function addEnvironmentOnServer(args: {
  environment: StoredWebRuntimeEnvironment
  pairingCode: string
}): Promise<void> {
  const active = readStoredWebRuntimeEnvironment()
  if (!active || syncState.serverBacked !== true) {
    return
  }
  // Why: the server mints its own id and re-derives endpoints from the pairing code,
  // so the local entry is replaced by the server's record under its stable id.
  try {
    const added = (await callEnvironmentStore<{ id: string }>('environmentStore.add', {
      name: args.environment.name,
      pairingCode: args.pairingCode
    })) as { id: string }
    replaceLocalEnvironment(args.environment.id, {
      ...args.environment,
      id: added.id
    })
  } catch (error) {
    console.warn('[web-environment-sync] environmentStore.add failed:', describeSyncError(error))
    throw error
  }
}

function replaceLocalEnvironment(previousId: string, next: StoredWebRuntimeEnvironment): void {
  const state = readStoredWebRuntimeEnvironments()
  const environments = state.environments.map((entry) => (entry.id === previousId ? next : entry))
  const activeEnvironmentId =
    state.activeEnvironmentId === previousId ? next.id : state.activeEnvironmentId
  saveStoredWebRuntimeEnvironments({ environments, activeEnvironmentId })
}

export async function removeEnvironmentOnServer(selector: string): Promise<void> {
  const active = readStoredWebRuntimeEnvironment()
  if (!active || syncState.serverBacked !== true) {
    return
  }
  try {
    await callEnvironmentStore<{ id: string }>('environmentStore.remove', { selector })
  } catch (error) {
    console.warn('[web-environment-sync] environmentStore.remove failed:', describeSyncError(error))
    throw error
  }
}

export function getServerPairingOfferCode(offer: WebPairingOffer): string {
  // Why: the server store parses orca://pair URLs; reuse that exact encoding so
  // both sides share one format.
  const json = JSON.stringify({
    v: offer.v,
    endpoint: offer.endpoint,
    deviceToken: offer.deviceToken,
    publicKeyB64: offer.publicKeyB64,
    ...(offer.pairedDeviceId ? { pairedDeviceId: offer.pairedDeviceId } : {}),
    // Why: the relay pairing schema gates relay fields on scope; a dropped scope
    // field would make the server parse the offer as unscoped.
    ...(offer.scope ? { scope: offer.scope } : {})
  })
  const base64url = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `orca://pair?code=${base64url}`
}
