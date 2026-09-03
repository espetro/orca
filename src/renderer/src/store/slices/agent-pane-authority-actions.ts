import type { AppState } from '../types'
import { rendererAgentStatusObservations } from '../../lib/renderer-agent-status-observations'
import {
  resolveAgentPaneAuthorityKey,
  retireAgentPaneAuthorityAliases,
  transferAgentPaneAuthorityAlias
} from './agent-pane-authority'
import {
  boundRecentlyRetiredAgentStatusPaneKeys,
  isRecentlyClosedAgentStatusTab
} from './agent-status-retention'
import { getLeafIdFromPaneKey, getTabIdFromPaneKey } from './agent-status-pane-key'
import { movePaneKeyedRecord, removePaneKeys } from './agent-status-record-pruning'

export type RetireAgentPaneAuthorityOptions = {
  preserveSleepingAgentSession?: boolean
}

export function retireAgentPaneAuthorityReducer(
  state: AppState,
  paneKey: string,
  options?: RetireAgentPaneAuthorityOptions
): { patch: Partial<AppState>; hadLive: boolean; ownerPaneKey: string } {
  const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
  const retiredPaneKeys = retireAgentPaneAuthorityAliases(paneKey)
  const retiredPaneKeySet = new Set(retiredPaneKeys)
  for (const key of retiredPaneKeys) {
    rendererAgentStatusObservations.forget(key)
  }
  const retiredLivePaneKeys = retiredPaneKeys.filter((key) => key in state.agentStatusByPaneKey)
  const hadLive = retiredLivePaneKeys.length > 0
  let nextRetentionSuppressedPaneKeys = removePaneKeys(
    state.retentionSuppressedPaneKeys,
    retiredPaneKeySet
  )
  if (
    retiredLivePaneKeys.length > 0 &&
    nextRetentionSuppressedPaneKeys === state.retentionSuppressedPaneKeys
  ) {
    nextRetentionSuppressedPaneKeys = { ...nextRetentionSuppressedPaneKeys }
  }
  for (const key of retiredLivePaneKeys) {
    nextRetentionSuppressedPaneKeys[key] = true
  }
  const patch: Partial<AppState> = {
    agentStatusByPaneKey: removePaneKeys(state.agentStatusByPaneKey, retiredPaneKeySet),
    runtimeAgentOrchestrationByPaneKey: removePaneKeys(
      state.runtimeAgentOrchestrationByPaneKey,
      retiredPaneKeySet
    ),
    retainedAgentsByPaneKey: removePaneKeys(state.retainedAgentsByPaneKey, retiredPaneKeySet),
    sleepingAgentSessionsByPaneKey: options?.preserveSleepingAgentSession
      ? state.sleepingAgentSessionsByPaneKey
      : removePaneKeys(state.sleepingAgentSessionsByPaneKey, retiredPaneKeySet),
    agentLaunchConfigByPaneKey: removePaneKeys(state.agentLaunchConfigByPaneKey, retiredPaneKeySet),
    acknowledgedAgentsByPaneKey: removePaneKeys(
      state.acknowledgedAgentsByPaneKey,
      retiredPaneKeySet
    ),
    paneForegroundAgentByPaneKey: removePaneKeys(
      state.paneForegroundAgentByPaneKey,
      retiredPaneKeySet
    ),
    unreadTerminalPanes: removePaneKeys(state.unreadTerminalPanes, retiredPaneKeySet),
    unreadAgentCompletionPanes: removePaneKeys(state.unreadAgentCompletionPanes, retiredPaneKeySet),
    lastTerminalInputAtByPaneKey: removePaneKeys(
      state.lastTerminalInputAtByPaneKey,
      retiredPaneKeySet
    ),
    cacheTimerByKey: removePaneKeys(state.cacheTimerByKey, retiredPaneKeySet),
    retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
    recentlyRetiredAgentStatusPaneKeys: boundRecentlyRetiredAgentStatusPaneKeys(
      state.recentlyRetiredAgentStatusPaneKeys,
      retiredPaneKeys
    ),
    agentStatusEpoch: hadLive ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: hadLive ? state.sortEpoch + 1 : state.sortEpoch
  }
  return { patch, hadLive, ownerPaneKey }
}

export function restoreAgentPaneAuthorityReducer(
  state: AppState,
  paneKey: string
): { patch: Partial<AppState> | null; ownerPaneKey: string } {
  const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
  // Why: a closed tab is a stronger, separate claim — re-attach must not undo it.
  if (
    isRecentlyClosedAgentStatusTab(
      state.recentlyClosedAgentStatusTabIds,
      getTabIdFromPaneKey(ownerPaneKey)
    )
  ) {
    return { patch: null, ownerPaneKey }
  }
  const restorable = [paneKey, ownerPaneKey].filter(
    (key) => key in state.recentlyRetiredAgentStatusPaneKeys
  )
  if (restorable.length === 0) {
    return { patch: null, ownerPaneKey }
  }
  const next = { ...state.recentlyRetiredAgentStatusPaneKeys }
  for (const key of restorable) {
    delete next[key]
  }
  return { patch: { recentlyRetiredAgentStatusPaneKeys: next }, ownerPaneKey }
}

export function transferAgentPaneAuthorityReducer(
  state: AppState,
  args: { fromPaneKey: string; toPaneKey: string; ptyId?: string | null }
): { patch: Partial<AppState>; from: string; to: string; ptyId?: string | null } | null {
  const transfer = transferAgentPaneAuthorityAlias(args)
  if (!transfer || transfer.previousOwnerPaneKey === transfer.ownerPaneKey) {
    return null
  }
  const from = transfer.previousOwnerPaneKey
  const to = transfer.ownerPaneKey
  // Why: the moved row carries the observation stamped for its OLD key; renderer-authored
  // observations for the new key must sort after it, not race it.
  rendererAgentStatusObservations.forget(from)
  rendererAgentStatusObservations.rebind(to)
  const targetTabId = getTabIdFromPaneKey(to) ?? undefined
  const targetLeafId = getLeafIdFromPaneKey(to) ?? undefined
  const patch: Partial<AppState> = {
    agentStatusByPaneKey: movePaneKeyedRecord(state.agentStatusByPaneKey, from, to, (entry) => ({
      ...entry,
      paneKey: to,
      tabId: targetTabId
    })),
    // Why: retention/sidebar consumers gate on the epoch; a moved live row is a
    // pane-key change they must observe, not a silent remap.
    ...(from in state.agentStatusByPaneKey
      ? { agentStatusEpoch: state.agentStatusEpoch + 1, sortEpoch: state.sortEpoch + 1 }
      : {}),
    runtimeAgentOrchestrationByPaneKey: movePaneKeyedRecord(
      state.runtimeAgentOrchestrationByPaneKey,
      from,
      to
    ),
    retainedAgentsByPaneKey: movePaneKeyedRecord(
      state.retainedAgentsByPaneKey,
      from,
      to,
      (retained) => ({
        ...retained,
        entry: { ...retained.entry, paneKey: to, tabId: targetTabId },
        tab: targetTabId ? { ...retained.tab, id: targetTabId } : retained.tab
      })
    ),
    sleepingAgentSessionsByPaneKey: movePaneKeyedRecord(
      state.sleepingAgentSessionsByPaneKey,
      from,
      to,
      (record) => ({ ...record, paneKey: to, tabId: targetTabId })
    ),
    agentLaunchConfigByPaneKey: movePaneKeyedRecord(
      state.agentLaunchConfigByPaneKey,
      from,
      to,
      (entry) => ({
        ...entry,
        identity: { ...entry.identity, tabId: targetTabId, leafId: targetLeafId }
      })
    ),
    acknowledgedAgentsByPaneKey: movePaneKeyedRecord(state.acknowledgedAgentsByPaneKey, from, to),
    paneForegroundAgentByPaneKey: movePaneKeyedRecord(state.paneForegroundAgentByPaneKey, from, to),
    unreadTerminalPanes: movePaneKeyedRecord(state.unreadTerminalPanes, from, to),
    unreadAgentCompletionPanes: movePaneKeyedRecord(state.unreadAgentCompletionPanes, from, to),
    lastTerminalInputAtByPaneKey: movePaneKeyedRecord(state.lastTerminalInputAtByPaneKey, from, to),
    cacheTimerByKey: movePaneKeyedRecord(state.cacheTimerByKey, from, to),
    retentionSuppressedPaneKeys: movePaneKeyedRecord(state.retentionSuppressedPaneKeys, from, to)
  }
  return { patch, from, to, ...(transfer.ptyId ? { ptyId: transfer.ptyId } : {}) }
}
