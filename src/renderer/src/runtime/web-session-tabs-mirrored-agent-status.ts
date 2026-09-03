import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { agentEntryCompletionAt } from '../../../shared/agent-completion-time'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../shared/agent-title-owner'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import { isClientAuthoritativeAgentStatusPane } from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { isWebTerminalSurfaceTabId, toWebTerminalSurfaceTabId } from './web-runtime-session'
import {
  agentStatusEntryEqual,
  isAgentStatusFresh,
  isMirroredCommandCodeTurnBump
} from './web-session-tabs-mirrored-equality'
import type { WebSessionTabsBatchContext } from './web-session-tabs-batch-records'
import { writableWebSessionTabsRecord } from './web-session-tabs-batch-records'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import {
  batchAgentPaneKeysForTabs,
  updateBatchAgentPaneKey
} from './web-session-tabs-agent-pane-key-index'
import type { MirroredTerminalTab } from './web-session-tabs-mirrored-terminal-tabs'
import { toMirroredPaneKey } from './web-session-tabs-mirrored-terminal-tabs'
import type { TerminalSurface } from './web-session-tabs-surface-guards'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

/** Normalises and mirrors agent status updates from the host payload, preserving ownership metadata. */
export function remapHostAgentStatus(
  surface: TerminalSurface,
  retainedSurface?: TerminalSurface
): AgentStatusEntry | null {
  if (!surface.agentStatus) {
    return null
  }
  const paneKey = toMirroredPaneKey(surface, retainedSurface?.leafId)
  if (!paneKey) {
    return null
  }
  const ownerAgent = resolvePaneAgentOwner({
    launchAgent: retainedSurface?.launchAgent ?? surface.launchAgent,
    hookAgent: surface.agentStatus.agentType
  })
  return {
    ...normalizeCompatibleAgentStatusEntryForOwner(surface.agentStatus, ownerAgent),
    paneKey,
    tabId: toWebTerminalSurfaceTabId(surface.parentTabId)
  }
}

export function isMirroredAgentPaneKeyForTabs(
  paneKey: string,
  tabIds: ReadonlySet<string>
): boolean {
  const parsed = parsePaneKey(paneKey)
  return parsed !== null && tabIds.has(parsed.tabId)
}

/** Host states the client's byte pipeline cannot observe: permission blocks and
 *  interactive question cards reach the host over its HTTP agent hook, never
 *  through PTY bytes, so they must pierce the client-authority fence. */
export function hostAgentStatusPiercesClientAuthority(entry: AgentStatusEntry): boolean {
  return entry.state === 'blocked' || entry.interactivePrompt != null
}

/** True while this renderer's own byte-derived status owns the pane: it claimed
 *  the pane at transport creation and wrote status from bytes. The claim is
 *  released on pane teardown, which is how the host takes the pane back. */
export function isClientOwnedAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined
): existing is AgentStatusEntry {
  return existing !== undefined && isClientAuthoritativeAgentStatusPane(paneKey)
}

/** Owned AND still fresh — the arbitration rule for a pane the host also has an
 *  opinion about: an OSC-silent dead agent hands that contest back to the host. */
export function isFencedClientAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined,
  now: number
): existing is AgentStatusEntry {
  return isClientOwnedAgentStatus(paneKey, existing) && isAgentStatusFresh(existing, now)
}
export function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly TerminalSurface[],
  mirroredTerminalTabs: readonly MirroredTerminalTab[],
  now: number,
  batchContext?: WebSessionTabsBatchContext
): Pick<WebSessionTabsSyncState, 'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'> | null {
  const mirroredTabIds = new Set<string>()
  for (const tab of currentTerminalTabs) {
    if (isWebTerminalSurfaceTabId(tab.id)) {
      mirroredTabIds.add(tab.id)
    }
  }
  for (const surface of terminalSurfaceTabs) {
    mirroredTabIds.add(toWebTerminalSurfaceTabId(surface.parentTabId))
  }

  if (mirroredTabIds.size === 0) {
    return null
  }

  let retainedSurfaceByHostTabAndPrunedLeafId:
    | Map<string, ReadonlyMap<string, TerminalSurface>>
    | undefined
  for (const entry of mirroredTerminalTabs) {
    if (entry.retainedSurfaceByPrunedLeafId) {
      retainedSurfaceByHostTabAndPrunedLeafId ??= new Map()
      retainedSurfaceByHostTabAndPrunedLeafId.set(
        entry.hostTabId,
        entry.retainedSurfaceByPrunedLeafId
      )
    }
  }
  const nextByPaneKey = new Map<string, AgentStatusEntry>()
  for (const surface of terminalSurfaceTabs) {
    const retainedSurface = retainedSurfaceByHostTabAndPrunedLeafId
      ?.get(surface.parentTabId)
      ?.get(surface.leafId)
    const entry = remapHostAgentStatus(surface, retainedSurface)
    if (!entry) {
      continue
    }
    const existing = nextByPaneKey.get(entry.paneKey) ?? state.agentStatusByPaneKey[entry.paneKey]
    // Why: keep fresher OSC state while taking remapped ownership metadata from the authoritative host snapshot.
    const hostIdentityPredatesCurrentTurn =
      existing !== undefined &&
      entry.state === 'done' &&
      existing.state !== 'done' &&
      existing.stateStartedAt > entry.stateStartedAt
    // Why: cross-machine wall clocks are not comparable, so the host frame could
    // outrank live client status forever; a proven client writer keeps its own
    // state (still adopting the host's identity fields below) unless the host
    // carries a state class the client's bytes can never see.
    const clientOwnsEntry =
      isFencedClientAgentStatus(entry.paneKey, existing, now) &&
      !hostAgentStatusPiercesClientAuthority(entry)
    const nextEntry =
      existing && (clientOwnsEntry || existing.updatedAt > entry.updatedAt)
        ? {
            ...normalizeCompatibleAgentStatusEntryForOwner(existing, entry.agentType),
            ...(clientOwnsEntry && existing.state === 'working' && entry.state === 'working'
              ? { workingMode: entry.workingMode }
              : {}),
            paneKey: entry.paneKey,
            worktreeId: entry.worktreeId ?? existing.worktreeId,
            tabId: entry.tabId,
            providerSession:
              existing.providerSession ??
              (hostIdentityPredatesCurrentTurn ? undefined : entry.providerSession),
            // Why: hook-only content the byte pipeline can never see, and every OSC
            // write blanks it, so a fenced pane's message line stayed empty forever
            // (#12906). Host-first unlike providerSession: only the host can mint one.
            lastAssistantMessage:
              (hostIdentityPredatesCurrentTurn ? undefined : entry.lastAssistantMessage) ??
              existing.lastAssistantMessage
          }
        : entry
    nextByPaneKey.set(entry.paneKey, nextEntry)
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let aggregateRelevantChange = false
  let sortRelevantChange = false

  for (const paneKey of batchAgentPaneKeysForTabs(state, mirroredTabIds, batchContext)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    // Why: the host surface carrying no status is not proof the agent stopped —
    // hook-only hosts publish nothing for OSC-driven panes. Keep a live entry
    // this renderer owns; it decays through the normal freshness boundary.
    // Ownership, not freshness, is the gate here: with no competing host value
    // there is nothing to arbitrate, and a client asleep past the stale
    // boundary would otherwise erase every pane it owns on the first snapshot
    // after wake (STA-3107) instead of decaying it like a local pane.
    if (isClientOwnedAgentStatus(paneKey, state.agentStatusByPaneKey[paneKey])) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    delete nextAgentStatusByPaneKey[paneKey]
    updateBatchAgentPaneKey(paneKey, false, batchContext)
    changed = true
    aggregateRelevantChange = true
    sortRelevantChange = true
  }

  for (const [paneKey, entry] of nextByPaneKey) {
    const existing = nextAgentStatusByPaneKey[paneKey]
    if (agentStatusEntryEqual(existing, entry)) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    nextAgentStatusByPaneKey[paneKey] = entry
    updateBatchAgentPaneKey(paneKey, true, batchContext)
    changed = true
    const entryAttributionChanged =
      existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
    const entryFreshnessChanged =
      !!existing && isAgentStatusFresh(existing, now) !== isAgentStatusFresh(entry, now)
    const doneAttentionChanged =
      existing?.state === 'done' &&
      entry.state === 'done' &&
      agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
    const workingModeChanged = existing?.workingMode !== entry.workingMode
    const entrySortRelevantChange =
      !existing ||
      existing.state !== entry.state ||
      !isAgentStatusFresh(existing, now) ||
      entryFreshnessChanged ||
      entryAttributionChanged ||
      doneAttentionChanged ||
      isMirroredCommandCodeTurnBump(existing, entry)
    aggregateRelevantChange =
      aggregateRelevantChange || entrySortRelevantChange || workingModeChanged
    sortRelevantChange = sortRelevantChange || entrySortRelevantChange
  }

  if (!changed) {
    return null
  }

  return {
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    agentStatusEpoch: aggregateRelevantChange ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: sortRelevantChange ? state.sortEpoch + 1 : state.sortEpoch
  }
}
