import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents
} from './web-session-close-intent'
import {
  clearWebSessionFocusIntent,
  peekWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import {
  resolveWebAgentSessionHandoff,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed
} from './web-agent-session-handoff'
import {
  buildMirroredTerminalTabs,
  isMirroredTerminalSurfaceId,
  shouldReplaceTerminalTab
} from './web-session-tabs-mirrored-terminal-tabs'
import { toWebTerminalSurfaceTabId } from './web-runtime-session'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import { clearWebAgentSessionHandoff } from './web-agent-session-handoff'
import { buildHostGroupIdByTabId, chooseTargetGroupId } from './web-session-tabs-mirrored-groups'
import { isReadyTerminalTab, isTerminalSurfaceTab } from './web-session-tabs-surface-guards'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'

// Terminal + focus-intent stage of buildWebSessionTabsMirroredContext.
export function buildWebSessionTabsMirroredTerminalStage(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number,
  contentScope: string | undefined,
  terminalPtyMode: 'local' | 'remote' | undefined
) {
  const worktreeId = rawSnapshot.worktree
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const reconcilesNonAgentTabs = contentScope !== 'agent-session'
  // Why: an in-flight pre-close snapshot can flash a closing tab back, so drop tabs the client is closing until the host confirms removal.
  // Why: key close intents by host session tab id (terminal parentTabId else tab.id), not browserPageId, or browser closes never get suppressed.
  const snapshotHostTabId = (tab: RuntimeMobileSessionTabsResult['tabs'][number]): string =>
    tab.type === 'terminal' ? tab.parentTabId : tab.id
  reconcileWebSessionCloseIntents(
    { environmentId },
    worktreeId,
    new Set(rawSnapshot.tabs.map((tab) => snapshotHostTabId(tab)))
  )
  const snapshot: RuntimeMobileSessionTabsResult = rawSnapshot.tabs.some((tab) =>
    isWebSessionCloseIntentPending({ environmentId }, worktreeId, snapshotHostTabId(tab), now)
  )
    ? {
        ...rawSnapshot,
        tabs: rawSnapshot.tabs.filter(
          (tab) =>
            !isWebSessionCloseIntentPending(
              { environmentId },
              worktreeId,
              snapshotHostTabId(tab),
              now
            )
        )
      }
    : rawSnapshot
  // Why: only a caller-recorded create intent may focus its arriving tab; unsolicited server-active must not steal focus (#5435).
  const focusIntent = peekWebSessionFocusIntent({ environmentId }, worktreeId)
  const focusIntentHostTabId = focusIntent?.hostTabId ?? null
  const matchingFocusIntentTab =
    focusIntentHostTabId === null
      ? null
      : focusIntent?.leafId
        ? (snapshot.tabs.find(
            (tab) =>
              tab.type === 'terminal' &&
              tab.leafId === focusIntent.leafId &&
              (tab.id === focusIntentHostTabId || tab.parentTabId === focusIntentHostTabId)
          ) ?? null)
        : (snapshot.tabs.find(
            (tab) =>
              tab.id === focusIntentHostTabId ||
              (tab.type === 'terminal' && tab.parentTabId === focusIntentHostTabId) ||
              (tab.type === 'browser' && tab.browserPageId === focusIntentHostTabId)
          ) ?? null)
  const expectedCurrentLocalTabId = focusIntent?.expectedCurrentLocalTabId
  const currentVisibleLocalTabId = resolveWebSessionVisibleTabId(state, worktreeId)
  const callerFocusIntentTab =
    matchingFocusIntentTab &&
    (expectedCurrentLocalTabId === undefined ||
      expectedCurrentLocalTabId === currentVisibleLocalTabId)
      ? matchingFocusIntentTab
      : null
  const followIntentTab =
    snapshot.navigationIntent === 'follow'
      ? (snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null)
      : null
  const navigationIntentTab = callerFocusIntentTab ?? followIntentTab
  const honorSnapshotActiveFocus = navigationIntentTab !== null
  if (matchingFocusIntentTab) {
    clearWebSessionFocusIntent({ environmentId }, worktreeId)
  }
  const currentTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const existingTerminalById = new Map(currentTerminalTabs.map((tab) => [tab.id, tab]))
  const terminalSurfaceTabs = reconcilesNonAgentTabs
    ? snapshot.tabs.filter(isTerminalSurfaceTab)
    : []
  const readyTerminalTabs = terminalSurfaceTabs.filter(isReadyTerminalTab)
  const nextRemotePtyIds = new Set(
    readyTerminalTabs.map((tab) => toRemoteRuntimePtyId(tab.terminal, environmentId))
  )
  const nextMirroredTerminalIds = new Set(
    terminalSurfaceTabs.map((tab) => toWebTerminalSurfaceTabId(tab.parentTabId))
  )
  const nextHostTerminalTabIds = new Set(terminalSurfaceTabs.map((tab) => tab.parentTabId))
  const provisionalHandoffHostTabIds = new Map<string, string>()
  for (const tab of currentTerminalTabs) {
    if (isMirroredTerminalSurfaceId(tab.id)) {
      continue
    }
    if (nextHostTerminalTabIds.has(tab.id)) {
      provisionalHandoffHostTabIds.set(tab.id, tab.id)
      continue
    }
    const handoff = {
      environmentId,
      worktreeId,
      provisionalTabId: tab.id
    }
    const hostTabId = resolveWebAgentSessionHandoff(handoff)
    if (
      hostTabId !== null &&
      (nextHostTerminalTabIds.has(hostTabId) ||
        isWebAgentSessionHandoffPostCreateSnapshotConfirmed(handoff))
    ) {
      provisionalHandoffHostTabIds.set(tab.id, hostTabId)
    }
  }
  const exactProvisionalHandoffs = new Set(provisionalHandoffHostTabIds.keys())
  const retainedTerminalTabs = reconcilesNonAgentTabs
    ? currentTerminalTabs.filter(
        (tab) =>
          !shouldReplaceTerminalTab(
            tab,
            environmentId,
            nextRemotePtyIds,
            nextMirroredTerminalIds,
            exactProvisionalHandoffs
          )
      )
    : currentTerminalTabs
  const mirroredTerminalTabs = buildMirroredTerminalTabs(
    snapshot,
    environmentId,
    existingTerminalById,
    state.terminalLayoutsByTabId,
    retainedTerminalTabs.length,
    now,
    callerFocusIntentTab?.type === 'terminal'
      ? {
          parentTabId: callerFocusIntentTab.parentTabId,
          leafId: callerFocusIntentTab.leafId
        }
      : undefined,
    terminalPtyMode
  )
  const mirroredTerminalTabEntries = mirroredTerminalTabs.map((entry) => entry.tab)
  const retainedTerminalIds = new Set(retainedTerminalTabs.map((tab) => tab.id))
  const nextTerminalTabs =
    retainedTerminalTabs.length + mirroredTerminalTabEntries.length > 0
      ? [...retainedTerminalTabs, ...mirroredTerminalTabEntries]
      : null
  const mirroredTerminalIds = new Set(mirroredTerminalTabEntries.map((tab) => tab.id))
  const removedTerminalIds = new Set(
    currentTerminalTabs.filter((tab) => !retainedTerminalIds.has(tab.id)).map((tab) => tab.id)
  )
  const removedTerminalResourceIds = [...removedTerminalIds].filter(
    (tabId) => !mirroredTerminalIds.has(tabId)
  )
  for (const provisionalTabId of exactProvisionalHandoffs) {
    clearWebAgentSessionHandoff({ environmentId, worktreeId, provisionalTabId })
  }

  const targetGroupId = chooseTargetGroupId(state, snapshot)
  const hostGroupIdByTabId = buildHostGroupIdByTabId(snapshot.tabGroups)
  return {
    snapshotHostTabId,
    snapshot,
    focusIntent,
    focusIntentHostTabId,
    matchingFocusIntentTab,
    expectedCurrentLocalTabId,
    currentVisibleLocalTabId,
    callerFocusIntentTab,
    followIntentTab,
    navigationIntentTab,
    honorSnapshotActiveFocus,
    currentTerminalTabs,
    existingTerminalById,
    reconcilesNonAgentTabs,
    terminalSurfaceTabs,
    readyTerminalTabs,
    nextRemotePtyIds,
    nextMirroredTerminalIds,
    nextHostTerminalTabIds,
    provisionalHandoffHostTabIds,
    exactProvisionalHandoffs,
    retainedTerminalTabs,
    mirroredTerminalTabs,
    mirroredTerminalTabEntries,
    retainedTerminalIds,
    nextTerminalTabs,
    mirroredTerminalIds,
    removedTerminalIds,
    removedTerminalResourceIds,
    targetGroupId,
    hostGroupIdByTabId
  }
}
