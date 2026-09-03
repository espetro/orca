import { buildWebSessionTabsLayoutByWorktree } from './web-session-tabs-apply-layout'
import { buildWebSessionTabsVisibleFocusTypes } from './web-session-tabs-apply-patch-focus-type'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import type { WebSessionTabsBatchContext } from './web-session-tabs-batch-records'
import { withWorktreeEntry } from './web-session-tabs-batch-records'
import type { WebSessionTabsSnapshotApplyOptions } from './web-session-tabs-snapshot-options'
import type { WebSessionTabsFocusContext } from './web-session-tabs-apply-focus'
import type { WebSessionTabsGroupsAndTabBarOrder } from './web-session-tabs-apply-groups'
import type { WebSessionTabsPatchRecords } from './web-session-tabs-apply-records'
import {
  sameStringArray,
  sameGroups,
  sameTerminalTabs,
  sameBrowserTabs,
  sameUnifiedTabs
} from './web-session-tabs-mirrored-equality'
import { isWebSessionTabsWorktreeRemovalFrame } from './web-session-tabs-tracking'
import { buildMirroredAgentStatusPatch } from './web-session-tabs-mirrored-agent-status'
import {
  buildRemirroredClosedTabMarkerLiftPatch,
  buildRetractedMirroredTabSweepPatch
} from './web-session-tabs-retracted-tab-sweep'

export function buildWebSessionTabsSnapshotPatch(
  state: WebSessionTabsSyncState,
  ctx: WebSessionTabsFocusContext,
  groups: WebSessionTabsGroupsAndTabBarOrder,
  records: WebSessionTabsPatchRecords,
  now: number,
  batchContext?: WebSessionTabsBatchContext,
  options?: WebSessionTabsSnapshotApplyOptions
): Partial<WebSessionTabsSyncState> | null {
  if (!ctx || !groups || !records) {
    return null
  }
  const {
    snapshot,
    worktreeId,
    honorSnapshotActiveFocus,
    terminalSurfaceTabs,
    mirroredTerminalTabs,
    nextTerminalTabs,
    mirroredTerminalIds,
    removedTerminalResourceIds,
    targetGroupId,
    nextBrowserTabs,
    nextOpenFiles,
    nextUnifiedTabs,
    intentMirroredAgent,
    nextActiveTerminalId,
    nextActiveBrowserWorkspaceId,
    nextActiveEditorFileId,
    currentVisibleStructuredTabId,
    nextActiveUnifiedTabId,
    clientOwnedPlacement
  } = ctx
  const { nextGroups, nextTabBarOrder } = groups ?? { nextGroups: null, nextTabBarOrder: [] }
  const {
    nextPtyIdsByTabId,
    nextTerminalLayoutsByTabId,
    nextUnreadTerminalTabs,
    nextPendingStartupByTabId,
    nextAutomaticAgentResumeClaimsByTabId,
    nextBrowserPagesByWorkspace,
    nextRemoteBrowserPageHandlesByPageId,
    nextBrowserCertificateFailuresByPageId,
    pendingStartupByTabId,
    automaticAgentResumeClaimsByTabId
  } = records

  const nextTabsByWorktree = withWorktreeEntry(
    state,
    'tabsByWorktree',
    worktreeId,
    nextTerminalTabs,
    sameTerminalTabs,
    batchContext
  )
  const nextBrowserTabsByWorktree = withWorktreeEntry(
    state,
    'browserTabsByWorktree',
    worktreeId,
    nextBrowserTabs,
    sameBrowserTabs,
    batchContext
  )
  // Why: under client-owned placement the reconciled groups are the membership truth;
  // the unified tabs' groupId field must agree or TabBar filters them out of their strip.
  const placedUnifiedTabs = (() => {
    if (!clientOwnedPlacement?.groups || !nextUnifiedTabs) {
      return nextUnifiedTabs
    }
    const groupIdByTabId = new Map(
      clientOwnedPlacement.groups.flatMap((group) =>
        group.tabOrder.map((tabId) => [tabId, group.id] as const)
      )
    )
    let changed = false
    const placed = nextUnifiedTabs.map((tab) => {
      const groupId = groupIdByTabId.get(tab.id)
      if (!groupId || groupId === tab.groupId) {
        return tab
      }
      changed = true
      return { ...tab, groupId }
    })
    return changed ? placed : nextUnifiedTabs
  })()
  const nextUnifiedTabsByWorktree = withWorktreeEntry(
    state,
    'unifiedTabsByWorktree',
    worktreeId,
    placedUnifiedTabs,
    sameUnifiedTabs,
    batchContext
  )
  const nextGroupsByWorktree = withWorktreeEntry(
    state,
    'groupsByWorktree',
    worktreeId,
    nextGroups,
    sameGroups,
    batchContext
  )
  const nextActiveGroupId = clientOwnedPlacement
    ? clientOwnedPlacement.activeGroupId
    : // Why: status/title snapshots carry the host's last active tab; a client that already switched panes keeps its local group focus.
      (nextGroups?.find((group) => group.activeTabId === nextActiveUnifiedTabId)?.id ??
      nextGroups?.find((group) => group.id === snapshot.activeGroupId)?.id ??
      nextGroups?.[0]?.id ??
      null)
  const nextActiveGroupIdByWorktree =
    nextGroups && state.activeGroupIdByWorktree[worktreeId] !== nextActiveGroupId
      ? withWorktreeEntry(
          state,
          'activeGroupIdByWorktree',
          worktreeId,
          nextActiveGroupId ?? targetGroupId,
          (current, next) => current === next,
          batchContext
        )
      : state.activeGroupIdByWorktree
  const nextLayoutByWorktree = buildWebSessionTabsLayoutByWorktree(state, worktreeId, {
    nextGroups,
    nextActiveGroupId,
    targetGroupId,
    clientOwnedPlacement,
    options,
    snapshot
  })
  const nextTabBarOrderByWorktree = withWorktreeEntry(
    state,
    'tabBarOrderByWorktree',
    worktreeId,
    nextTabBarOrder.length > 0 ? nextTabBarOrder : null,
    (a, b) => sameStringArray(a ?? [], b ?? []),
    batchContext
  )
  const nextActiveTabIdByWorktree =
    (state.activeTabIdByWorktree[worktreeId] ?? null) !==
    (intentMirroredAgent?.unifiedTab.id ?? currentVisibleStructuredTabId ?? nextActiveTerminalId)
      ? withWorktreeEntry(
          state,
          'activeTabIdByWorktree',
          worktreeId,
          intentMirroredAgent?.unifiedTab.id ??
            currentVisibleStructuredTabId ??
            nextActiveTerminalId,
          (current, next) => (current ?? null) === next,
          batchContext,
          false
        )
      : state.activeTabIdByWorktree
  const nextActiveBrowserTabIdByWorktree =
    (state.activeBrowserTabIdByWorktree[worktreeId] ?? null) !== nextActiveBrowserWorkspaceId
      ? withWorktreeEntry(
          state,
          'activeBrowserTabIdByWorktree',
          worktreeId,
          nextActiveBrowserWorkspaceId,
          (current, next) => (current ?? null) === next,
          batchContext,
          false
        )
      : state.activeBrowserTabIdByWorktree
  const nextActiveFileIdByWorktree =
    (state.activeFileIdByWorktree[worktreeId] ?? null) !== nextActiveEditorFileId
      ? withWorktreeEntry(
          state,
          'activeFileIdByWorktree',
          worktreeId,
          nextActiveEditorFileId,
          (current, next) => (current ?? null) === next,
          batchContext,
          false
        )
      : state.activeFileIdByWorktree
  const isActiveWorktree = state.activeWorktreeId === worktreeId
  const {
    focusIntentVisibleTabType,
    snapshotVisibleTabType,
    currentVisibleTabTypeStillValid,
    fallbackVisibleTabType,
    currentActiveTerminalStillValid,
    currentActiveEditorStillValid
  } = buildWebSessionTabsVisibleFocusTypes(ctx, state, isActiveWorktree)
  // Why: don't keep pointing shortcuts at a removed browser/editor; a client-initiated activation lets the snapshot's type switch the visible pane.
  const nextVisibleTabType = honorSnapshotActiveFocus
    ? (focusIntentVisibleTabType ??
      currentVisibleTabTypeStillValid ??
      snapshotVisibleTabType ??
      fallbackVisibleTabType)
    : (currentVisibleTabTypeStillValid ?? snapshotVisibleTabType ?? fallbackVisibleTabType)
  const nextActiveTabId = isActiveWorktree
    ? (intentMirroredAgent?.unifiedTab.id ??
      (snapshot.activeTabType === 'terminal'
        ? nextActiveTerminalId
        : (currentActiveTerminalStillValid ?? nextActiveTerminalId)))
    : state.activeTabId
  const nextActiveBrowserTabId = isActiveWorktree
    ? nextActiveBrowserWorkspaceId
    : state.activeBrowserTabId
  const nextActiveFileId = isActiveWorktree
    ? snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? nextActiveEditorFileId
      : (currentActiveEditorStillValid ?? nextActiveEditorFileId)
    : state.activeFileId
  const nextActiveTabType = isActiveWorktree ? nextVisibleTabType : state.activeTabType
  const nextActiveTabTypeByWorktree =
    state.activeTabTypeByWorktree[worktreeId] !== nextVisibleTabType
      ? withWorktreeEntry(
          state,
          'activeTabTypeByWorktree',
          worktreeId,
          nextVisibleTabType,
          (current, next) => current === next,
          batchContext
        )
      : state.activeTabTypeByWorktree
  const agentStatusPatch = buildMirroredAgentStatusPatch(
    state,
    ctx.currentTerminalTabs,
    terminalSurfaceTabs,
    mirroredTerminalTabs,
    now,
    batchContext
  )
  // Why: only a host snapshot that omits a tab is a retraction; a tombstone clears the mirror
  // for every environment at once, and sweeping there erases rows a live sibling still owns.
  const retractedTabSweepPatch = isWebSessionTabsWorktreeRemovalFrame(snapshot)
    ? null
    : buildRetractedMirroredTabSweepPatch(
        state,
        worktreeId,
        nextTabsByWorktree,
        agentStatusPatch,
        removedTerminalResourceIds,
        batchContext
      )
  // Why: mirrored ids are stable, so a published-again id proves the tab is not closed —
  // a lingering closed-tab marker would blackhole its byte-derived status for the whole
  // session (host-restart subset frames, cross-host collision replays). The close-intent
  // filter already holds genuinely closing tabs out of the snapshot.
  const remirroredClosedTabLiftPatch = buildRemirroredClosedTabMarkerLiftPatch(
    retractedTabSweepPatch?.recentlyClosedAgentStatusTabIds ??
      state.recentlyClosedAgentStatusTabIds,
    mirroredTerminalIds
  )

  const patch: Partial<WebSessionTabsSyncState> = {
    ...agentStatusPatch,
    ...retractedTabSweepPatch,
    ...remirroredClosedTabLiftPatch,
    ...(nextOpenFiles !== state.openFiles ? { openFiles: nextOpenFiles } : {}),
    ...(nextTabsByWorktree !== state.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
    ...(nextBrowserTabsByWorktree !== state.browserTabsByWorktree
      ? { browserTabsByWorktree: nextBrowserTabsByWorktree }
      : {}),
    ...(nextUnifiedTabsByWorktree !== state.unifiedTabsByWorktree
      ? { unifiedTabsByWorktree: nextUnifiedTabsByWorktree }
      : {}),
    ...(nextGroupsByWorktree !== state.groupsByWorktree
      ? { groupsByWorktree: nextGroupsByWorktree }
      : {}),
    ...(nextActiveGroupIdByWorktree !== state.activeGroupIdByWorktree
      ? { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }
      : {}),
    ...(nextLayoutByWorktree !== state.layoutByWorktree
      ? { layoutByWorktree: nextLayoutByWorktree }
      : {}),
    ...(nextTabBarOrderByWorktree !== state.tabBarOrderByWorktree
      ? { tabBarOrderByWorktree: nextTabBarOrderByWorktree }
      : {}),
    ...(nextPtyIdsByTabId !== state.ptyIdsByTabId ? { ptyIdsByTabId: nextPtyIdsByTabId } : {}),
    ...(nextTerminalLayoutsByTabId !== state.terminalLayoutsByTabId
      ? { terminalLayoutsByTabId: nextTerminalLayoutsByTabId }
      : {}),
    ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
      ? { unreadTerminalTabs: nextUnreadTerminalTabs }
      : {}),
    ...(nextPendingStartupByTabId !== pendingStartupByTabId
      ? { pendingStartupByTabId: nextPendingStartupByTabId }
      : {}),
    ...(nextAutomaticAgentResumeClaimsByTabId !== automaticAgentResumeClaimsByTabId
      ? { automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId }
      : {}),
    ...(nextBrowserPagesByWorkspace !== state.browserPagesByWorkspace
      ? { browserPagesByWorkspace: nextBrowserPagesByWorkspace }
      : {}),
    ...(nextRemoteBrowserPageHandlesByPageId !== state.remoteBrowserPageHandlesByPageId
      ? { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
      : {}),
    ...(nextBrowserCertificateFailuresByPageId !== state.browserCertificateFailuresByPageId
      ? { browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId }
      : {}),
    ...(nextActiveTabIdByWorktree !== state.activeTabIdByWorktree
      ? { activeTabIdByWorktree: nextActiveTabIdByWorktree }
      : {}),
    ...(nextActiveBrowserTabIdByWorktree !== state.activeBrowserTabIdByWorktree
      ? { activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree }
      : {}),
    ...(nextActiveFileIdByWorktree !== state.activeFileIdByWorktree
      ? { activeFileIdByWorktree: nextActiveFileIdByWorktree }
      : {}),
    ...(nextActiveTabId !== state.activeTabId ? { activeTabId: nextActiveTabId } : {}),
    ...(nextActiveBrowserTabId !== state.activeBrowserTabId
      ? { activeBrowserTabId: nextActiveBrowserTabId }
      : {}),
    ...(nextActiveFileId !== state.activeFileId ? { activeFileId: nextActiveFileId } : {}),
    ...(nextActiveTabType !== state.activeTabType ? { activeTabType: nextActiveTabType } : {}),
    ...(nextActiveTabTypeByWorktree !== state.activeTabTypeByWorktree
      ? { activeTabTypeByWorktree: nextActiveTabTypeByWorktree }
      : {})
  }

  return Object.keys(patch).length === 0 ? null : patch
}
