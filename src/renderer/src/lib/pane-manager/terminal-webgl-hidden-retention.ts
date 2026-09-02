import type { ManagedPaneInternal } from './pane-manager-types'
import { disposeWebgl } from './pane-webgl-renderer'

export const DEFAULT_MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = 6
export const LOW_MEMORY_MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = 0

// Why: deviceMemory <= 8 or < 12 signals low-memory tier where GPU memory pressure aborts the renderer.
export function isLowMemoryTier(deviceMemory?: number): boolean {
  const memory =
    deviceMemory ??
    (typeof navigator !== 'undefined'
      ? (navigator as unknown as { deviceMemory?: number }).deviceMemory
      : undefined)
  return memory !== undefined && (memory <= 8 || memory < 12)
}

export function resolveDefaultHiddenWebglRetentionCap(deviceMemory?: number): number {
  return isLowMemoryTier(deviceMemory)
    ? LOW_MEMORY_MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS
    : DEFAULT_MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS
}

let configuredRetentionCap: number | null = null

export function setHiddenWebglRetentionCap(cap: number | null): void {
  configuredRetentionCap = cap
  MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = getHiddenWebglRetentionCap()
  if (MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS <= 0 && retainedEntries.length > 0) {
    while (retainedEntries.length > 0) {
      const evicted = retainedEntries.shift()!
      disposeEntryContexts(evicted)
    }
  }
}

export function getHiddenWebglRetentionCap(): number {
  if (configuredRetentionCap !== null) {
    return configuredRetentionCap
  }
  return resolveDefaultHiddenWebglRetentionCap()
}

export const setMaxRetainedHiddenWebglContexts = setHiddenWebglRetentionCap
export const getMaxRetainedHiddenWebglContexts = getHiddenWebglRetentionCap

// Orca raises Blink's active-context ceiling to 128, but retained contexts
// still consume GPU memory. Six keeps recent switch-backs on WebGL without
// letting hidden worktrees grow that cost with the mounted-pane population;
// low-memory tiers set this to 0 to dispose all hidden contexts immediately.
export let MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = resolveDefaultHiddenWebglRetentionCap()

type RetainedHiddenEntry = {
  owner: object
  livePanes: () => Iterable<ManagedPaneInternal>
}

// LRU: oldest suspend first.
const retainedEntries: RetainedHiddenEntry[] = []

function liveContextCount(entry: RetainedHiddenEntry): number {
  let count = 0
  for (const pane of entry.livePanes()) {
    if (pane.webglAddon) {
      count += 1
    }
  }
  return count
}

function disposeEntryContexts(entry: RetainedHiddenEntry): void {
  for (const pane of entry.livePanes()) {
    disposeWebgl(pane)
  }
}

function removeEntry(owner: object): void {
  const index = retainedEntries.findIndex((entry) => entry.owner === owner)
  if (index !== -1) {
    retainedEntries.splice(index, 1)
  }
}

/**
 * Try to keep the owner's live WebGL addons across a hide. Returns true when
 * retained — the caller must then skip its dispose pass. Evicts (disposes)
 * least-recently-hidden owners to stay under the context cap.
 */
export function tryRetainHiddenPanesWebgl(
  owner: object,
  livePanes: () => Iterable<ManagedPaneInternal>
): boolean {
  removeEntry(owner)
  const cap = getHiddenWebglRetentionCap()
  if (cap <= 0) {
    return false
  }
  const entry: RetainedHiddenEntry = { owner, livePanes }
  const ownCount = liveContextCount(entry)
  // Nothing to retain (GPU off / first-mount hidden), or a single tab too wide
  // for the cap — normal dispose keeps eviction from thrashing every other tab.
  if (ownCount === 0 || ownCount > cap) {
    return false
  }
  let total = ownCount
  for (const other of retainedEntries) {
    total += liveContextCount(other)
  }
  while (total > cap && retainedEntries.length > 0) {
    const evicted = retainedEntries.shift()!
    total -= liveContextCount(evicted)
    disposeEntryContexts(evicted)
  }
  retainedEntries.push(entry)
  return true
}

/** Drop retention bookkeeping on reveal/destroy; never disposes live addons. */
export function releaseHiddenWebglRetention(owner: object): void {
  removeEntry(owner)
}

export function retainedHiddenWebglOwnerCountForTest(): number {
  return retainedEntries.length
}

export function resetHiddenWebglRetentionForTest(): void {
  retainedEntries.length = 0
  configuredRetentionCap = null
  MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = getHiddenWebglRetentionCap()
}
