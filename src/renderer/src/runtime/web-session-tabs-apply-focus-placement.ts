import { toWebTerminalSurfaceTabId } from './web-runtime-session'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import {
  peekWebSessionBrowserPlacementGroup,
  isWebSessionBrowserPlacementGroupReserved
} from './web-session-browser-placement'
import { peekWebSessionTerminalPlacementGroup } from './web-session-terminal-placement'
import { reconcileClientOwnedTabPlacement } from './web-session-client-owned-tab-placement'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import type { WebSessionTabsSnapshotApplyOptions } from './web-session-tabs-snapshot-options'
import type { WebSessionTabsMirroredContext } from './web-session-tabs-apply-context'

// Client-owned placement reconciliation (extracted from the focus stage IIFE).
export function buildWebSessionTabsClientOwnedPlacement(
  state: WebSessionTabsSyncState,
  mirrored: NonNullable<WebSessionTabsMirroredContext>,
  focus: {
    nextUnifiedTabs: unknown[] | null
    currentGroups: TabGroup[]
    mirroredUnifiedTabs: Tab[]
    validUnifiedTabIds: Set<string>
    intentUnifiedTabId: string | null
    reservedEmptyPreviewFallbackTabId: string | null
    honorSnapshotActiveFocus: boolean
    clientGroupIdByLocalTabId: Map<string, string>
    existingTabIndex: {
      getEditorUnifiedTab: (fileId: string, hostTabId: string) => { id: string } | null
    }
  },
  environmentId: string,
  worktreeId: string,
  options?: WebSessionTabsSnapshotApplyOptions
) {
  const {
    provisionalHandoffHostTabIds,
    mirroredEditorTabs,
    terminalSurfaceTabs,
    mirroredBrowserTabs
  } = mirrored
  const {
    nextUnifiedTabs,
    currentGroups,
    mirroredUnifiedTabs,
    validUnifiedTabIds,
    intentUnifiedTabId,
    reservedEmptyPreviewFallbackTabId,
    honorSnapshotActiveFocus,
    clientGroupIdByLocalTabId,
    existingTabIndex
  } = focus
  // Why: a preserveLocalLayout owner keeps the local layout authoritative, so placement
  // is client-owned even before any local group record exists — first adoption on an
  // empty worktree must repair a rendered-leaf-without-record or materialize a rendered
  // group instead of publishing the tab into a group no local leaf will ever show.
  if (!nextUnifiedTabs || (currentGroups.length === 0 && !options?.preserveLocalLayout)) {
    return null
  }
  // Why: an entity-identical replacement (provisional terminal → mirrored surface, local
  // editor → host editor tab) is a rename — its position and focus must carry over.
  const rekeyedTabIds = new Map<string, string>()
  for (const [provisionalTabId, hostTabId] of provisionalHandoffHostTabIds) {
    const mirroredId = toWebTerminalSurfaceTabId(hostTabId)
    if (mirroredId !== provisionalTabId) {
      rekeyedTabIds.set(provisionalTabId, mirroredId)
    }
  }
  for (const entry of mirroredEditorTabs) {
    const existing = existingTabIndex.getEditorUnifiedTab(entry.file.id, entry.hostTabId)
    if (existing && existing.id !== entry.unifiedTab.id) {
      rekeyedTabIds.set(existing.id, entry.unifiedTab.id)
    }
  }
  const knownGroupTabIds = new Set(
    currentGroups.flatMap((group) =>
      group.tabOrder.map((tabId) => rekeyedTabIds.get(tabId) ?? tabId)
    )
  )
  // Why: a pending record is this client's own create intent — authoritative even when the
  // provisional tab was provisionally adopted elsewhere or the target group record lags its leaf.
  // The entry's own clientGroupId comes first, so a group the user moved the row into after the
  // create was recorded wins over the group the create asked for.
  const placementMoves = mirroredBrowserTabs.flatMap((entry) => {
    const recordedGroupId = peekWebSessionBrowserPlacementGroup({
      environmentId,
      worktreeId,
      remotePageId: entry.remotePageId
    })
    if (!recordedGroupId) {
      return []
    }
    return [{ tabId: entry.unifiedTab.id, groupId: entry.clientGroupId ?? recordedGroupId }]
  })
  for (const parentTabId of new Set(terminalSurfaceTabs.map((tab) => tab.parentTabId))) {
    const recordedGroupId = peekWebSessionTerminalPlacementGroup({
      environmentId,
      worktreeId,
      hostTabId: parentTabId
    })
    if (recordedGroupId) {
      placementMoves.push({
        tabId: toWebTerminalSurfaceTabId(parentTabId),
        groupId: recordedGroupId
      })
    }
  }
  const adoptedTabs = mirroredUnifiedTabs
    .filter((tab) => !knownGroupTabIds.has(tab.id))
    .map((tab) => ({
      tabId: tab.id,
      groupId: clientGroupIdByLocalTabId.get(tab.id) ?? tab.groupId
    }))
  return reconcileClientOwnedTabPlacement({
    currentGroups,
    worktreeId,
    validUnifiedTabIds,
    adoptedTabs,
    placementMoves,
    rekeyedTabIds,
    intentTabId: honorSnapshotActiveFocus ? (intentUnifiedTabId ?? null) : null,
    reservedEmptyGroupFallbackTabId: reservedEmptyPreviewFallbackTabId,
    currentActiveGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
    currentLayout: state.layoutByWorktree[worktreeId] ?? null,
    isGroupReserved: (groupId) => isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId })
  })
}
