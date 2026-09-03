import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { AppState } from '../types'
import type { RetainedAgentEntry } from './agent-status-types'
import { getTabIdFromPaneKey } from './agent-status-pane-key'

// Why: retained entries are heavy (~24KB) and grow unbounded on busy worktrees (dominant renderer OOM); cap, evicting oldest completions first.
const MAX_RETAINED_AGENTS = 500

export function capRetainedAgents(
  retained: Record<string, RetainedAgentEntry>,
  maxEntries = MAX_RETAINED_AGENTS
): Record<string, RetainedAgentEntry> {
  const keys = Object.keys(retained)
  if (keys.length <= maxEntries) {
    return retained
  }
  const capped: Record<string, RetainedAgentEntry> = {}
  for (const key of keys.slice(keys.length - maxEntries)) {
    capped[key] = retained[key]
  }
  return capped
}

// Why: missed pane teardown can leak heavy live rows in any state and amplify every status-map copy (#9872).
export const MAX_LIVE_AGENT_STATUSES = 500

export type PaneLiveness = 'live' | 'dead' | 'unprovable'

// Why: only a rooted tab proves which leaves are mounted; rootless and headless rows may still be live (#2962).
export function classifyPaneKeyLiveness(state: AppState): (paneKey: string) => PaneLiveness {
  const rootedLeafKeys = new Set<string>()
  const rootedTabIds = new Set<string>()
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (!layout?.root) {
      continue
    }
    rootedTabIds.add(tabId)
    const stack: TerminalPaneLayoutNode[] = [layout.root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.type === 'leaf') {
        rootedLeafKeys.add(`${tabId}:${node.leafId}`)
      } else {
        stack.push(node.first, node.second)
      }
    }
  }
  return (paneKey) => {
    if (rootedLeafKeys.has(paneKey)) {
      return 'live'
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    return tabId !== null && rootedTabIds.has(tabId) ? 'dead' : 'unprovable'
  }
}

// Why: mutate the caller-owned spread so eviction does not allocate another heavy-map copy.
export function capLiveAgentStatusesInPlace(
  freshLive: Record<string, AgentStatusEntry>,
  protectedPaneKey: string,
  buildClassifier: () => (paneKey: string) => PaneLiveness,
  now: number,
  maxEntries = MAX_LIVE_AGENT_STATUSES
): string[] {
  const keys = Object.keys(freshLive)
  let overflow = keys.length - maxEntries
  if (overflow <= 0) {
    return []
  }
  const classify = buildClassifier()
  const evictedPaneKeys: string[] = []
  const sweep = (canEvict: (liveness: PaneLiveness, entry: AgentStatusEntry) => boolean): void => {
    for (const key of keys) {
      if (overflow <= 0) {
        break
      }
      if (key === protectedPaneKey || !(key in freshLive)) {
        continue
      }
      const liveness = classify(key)
      if (liveness === 'live' || !canEvict(liveness, freshLive[key])) {
        continue
      }
      delete freshLive[key]
      overflow -= 1
      evictedPaneKeys.push(key)
    }
  }
  // Prefer rows that are provably dead or too stale to represent a live agent.
  sweep(
    (liveness, entry) => liveness === 'dead' || now - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
  // Shed fresh unprovable rows only when needed; rooted live panes make this a soft cap.
  if (overflow > 0) {
    sweep(() => true)
  }
  return evictedPaneKeys
}

// Why: renderer twin of main's #7561 FIFO-capped closedAgentStatusTabIds — suppresses late
// events for a just-closed tab, but was add-only and grew unbounded, hence this cap.
export const RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX = 1024

// delete-then-set for LRU recency, then evict oldest keys past the cap (Record iterates
// insertion order); safe because a status for a tab closed >MAX tabs ago cannot still arrive.
export function boundRecentlyClosedAgentStatusTabIds(
  existing: Record<string, true>,
  tabId: string
): Record<string, true> {
  const next: Record<string, true> = {}
  for (const key of Object.keys(existing)) {
    if (key !== tabId) {
      next[key] = true
    }
  }
  next[tabId] = true
  const keys = Object.keys(next)
  if (keys.length > RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX) {
    for (const stale of keys.slice(0, keys.length - RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX)) {
      delete next[stale]
    }
  }
  return next
}

export function boundRecentlyRetiredAgentStatusPaneKeys(
  existing: Record<string, true>,
  paneKeys: readonly string[]
): Record<string, true> {
  const additions = new Set(paneKeys)
  const next: Record<string, true> = {}
  for (const key of Object.keys(existing)) {
    if (!additions.has(key)) {
      next[key] = true
    }
  }
  for (const paneKey of additions) {
    next[paneKey] = true
  }
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, -RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX)) {
    delete next[stale]
  }
  return next
}
