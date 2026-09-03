import { capRetainedAgents } from './agent-status-retention'
import { mergeCurrentOrchestrationContext } from './agent-status-orchestration'
import type { RetainedAgentEntry } from './agent-status-types'
import type { AgentStatusGetFn, AgentStatusSetFn } from './agent-status-action-context'

export function retainAgentsAction(
  entries: RetainedAgentEntry[],
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  // Why: retained entries are a pure read-overlay (no epoch bump needed); batch into one set so multi-agent disappearance is atomic.
  if (entries.length === 0) {
    return
  }
  set((s) => {
    // Why: skip reallocation when every entry is already present by reference — consumers select on map identity, so a spurious realloc forces re-renders.
    let changed = false
    for (const retained of entries) {
      if (s.retainedAgentsByPaneKey[retained.entry.paneKey] !== retained) {
        changed = true
        break
      }
    }
    if (!changed) {
      return s
    }
    const next = { ...s.retainedAgentsByPaneKey }
    for (const retained of entries) {
      const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[retained.entry.paneKey]
      const mergedOrchestration = runtimeOrchestration
        ? mergeCurrentOrchestrationContext(retained.entry.orchestration, runtimeOrchestration)
        : retained.entry.orchestration
      const entry =
        mergedOrchestration !== retained.entry.orchestration
          ? { ...retained.entry, orchestration: mergedOrchestration }
          : retained.entry
      // INVARIANT: map key equals retained.entry.paneKey, so callers look up retained rows by the same paneKey as agentStatusByPaneKey.
      next[retained.entry.paneKey] = entry === retained.entry ? retained : { ...retained, entry }
    }
    // Why: cap the map so a long multi-agent session can't leak the renderer heap (retainAgents is the only growth path); evicts oldest-retained first.
    return { retainedAgentsByPaneKey: capRetainedAgents(next) }
  })
}

export function dismissRetainedAgentAction(
  paneKey: string,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  // Why: no epoch bump (mirrors retainAgents) — retained rows are a pure read-overlay that don't affect smart-sort; selectors re-render on map identity.
  set((s) => {
    if (!(paneKey in s.retainedAgentsByPaneKey)) {
      return s
    }
    const next = { ...s.retainedAgentsByPaneKey }
    delete next[paneKey]
    // Why: mirror dropAgentStatus — plant a one-shot suppressor only when a live entry coexists, so the retention sync doesn't resurrect this dismissed row (gate on hasLive, else it leaks).
    const hasLive = paneKey in s.agentStatusByPaneKey
    if (!hasLive || paneKey in s.retentionSuppressedPaneKeys) {
      return { retainedAgentsByPaneKey: next }
    }
    return {
      retainedAgentsByPaneKey: next,
      retentionSuppressedPaneKeys: {
        ...s.retentionSuppressedPaneKeys,
        [paneKey]: true
      }
    }
  })
}

export function dismissRetainedAgentsByWorktreeAction(
  worktreeId: string,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  // Why: collect removed paneKeys inside set, then fan out window.api drop so the on-disk cache doesn't resurrect the dismissed rows on next launch.
  const dismissedPaneKeys: string[] = []
  set((s) => {
    let changed = false
    const next: Record<string, RetainedAgentEntry> = {}
    // Why: mirror dismissRetainedAgent — plant a suppressor only for dismissed paneKeys that also have a live entry, else the next live→gone transition re-retains the row (a retained-only suppressor leaks).
    const toSuppress: string[] = []
    for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
      if (ra.worktreeId === worktreeId) {
        changed = true
        dismissedPaneKeys.push(key)
        if (key in s.agentStatusByPaneKey && !(key in s.retentionSuppressedPaneKeys)) {
          toSuppress.push(key)
        }
        continue
      }
      next[key] = ra
    }
    if (!changed) {
      return s
    }
    if (toSuppress.length === 0) {
      return { retainedAgentsByPaneKey: next }
    }
    const nextSuppressed = { ...s.retentionSuppressedPaneKeys }
    for (const key of toSuppress) {
      nextSuppressed[key] = true
    }
    return {
      retainedAgentsByPaneKey: next,
      retentionSuppressedPaneKeys: nextSuppressed
    }
  })
  if (typeof window !== 'undefined') {
    for (const paneKey of dismissedPaneKeys) {
      window.api?.agentStatus?.drop?.(paneKey)
    }
  }
}

export function pruneRetainedAgentsAction(
  validWorktreeIds: Set<string>,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  // Why: intentionally leaves retentionSuppressedPaneKeys — paneKeys are minted fresh on worktree re-create, so stale suppressors can never match a future live entry.
  set((s) => {
    let changed = false
    const next: Record<string, RetainedAgentEntry> = {}
    for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
      if (!validWorktreeIds.has(ra.worktreeId)) {
        changed = true
        continue
      }
      next[key] = ra
    }
    return changed ? { retainedAgentsByPaneKey: next } : s
  })
}

export function clearRetentionSuppressedPaneKeysAction(
  paneKeys: string[],
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    let changed = false
    const next = { ...s.retentionSuppressedPaneKeys }
    for (const paneKey of paneKeys) {
      if (!(paneKey in next)) {
        continue
      }
      delete next[paneKey]
      changed = true
    }
    return changed ? { retentionSuppressedPaneKeys: next } : s
  })
}
