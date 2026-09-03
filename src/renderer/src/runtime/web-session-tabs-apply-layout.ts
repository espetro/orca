import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  pruneTabGroupLayout,
  collectLayoutGroupIds,
  appendTabGroupLayout,
  tabGroupLayoutEqual
} from './web-session-tabs-mirrored-groups'
import {
  withWorktreeEntry,
  type WebSessionTabsBatchContext
} from './web-session-tabs-batch-records'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'

// Layout reconciliation for the snapshot patch (extracted IIFE).
export function buildWebSessionTabsLayoutByWorktree(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  args: {
    nextGroups: { id: string }[] | null
    nextActiveGroupId: string | null | undefined
    targetGroupId: string
    clientOwnedPlacement: { layout?: TabGroupLayoutNode | null; groups?: unknown } | null
    options?: { preserveLocalLayout?: boolean }
    snapshot: RuntimeMobileSessionTabsResult
    batchContext?: WebSessionTabsBatchContext
  }
) {
  const {
    nextGroups,
    nextActiveGroupId,
    targetGroupId,
    clientOwnedPlacement,
    options,
    snapshot,
    batchContext
  } = args
  if (!nextGroups) {
    return state.layoutByWorktree
  }
  // Why: client-owned placement derives its layout from the local one (pruned, plus
  // repair leaves for surviving groups the layout lost), so a preserveLocalLayout owner
  // still applies it — the option only rejects host-authored layout below.
  if (clientOwnedPlacement) {
    const clientLayout =
      clientOwnedPlacement.layout ??
      (nextActiveGroupId ? { type: 'leaf' as const, groupId: nextActiveGroupId } : null)
    if (!clientLayout || tabGroupLayoutEqual(state.layoutByWorktree[worktreeId], clientLayout)) {
      return state.layoutByWorktree
    }
    return withWorktreeEntry(
      state,
      'layoutByWorktree',
      worktreeId,
      clientLayout,
      (current, next) => current === next,
      batchContext
    )
  }
  if (options?.preserveLocalLayout) {
    return state.layoutByWorktree
  }
  const validGroupIds = new Set(nextGroups.map((group) => group.id))
  const hostLayout = pruneTabGroupLayout(snapshot.tabGroupLayout, validGroupIds)
  const defaultLeafLayout = { type: 'leaf' as const, groupId: nextActiveGroupId ?? targetGroupId }
  const hostLayoutGroupIds = collectLayoutGroupIds(hostLayout ?? undefined)
  const hostGroupIds = new Set(snapshot.tabGroups?.map((group) => group.id) ?? [])
  const extraGroupIds = new Set(
    nextGroups
      .map((group) => group.id)
      .filter((groupId) =>
        hostLayout
          ? !hostLayoutGroupIds.has(groupId)
          : snapshot.tabGroups && snapshot.tabGroups.length > 0
            ? !hostGroupIds.has(groupId)
            : false
      )
  )
  const localExtraLayout = pruneTabGroupLayout(state.layoutByWorktree[worktreeId], extraGroupIds)
  const hostBaseLayout =
    hostLayout ?? (snapshot.tabGroups && snapshot.tabGroups.length > 0 ? defaultLeafLayout : null)
  const fallbackLayout =
    appendTabGroupLayout(hostBaseLayout, localExtraLayout) ??
    (snapshot.tabGroups && snapshot.tabGroups.length > 0
      ? defaultLeafLayout
      : state.layoutByWorktree[worktreeId]
        ? null
        : defaultLeafLayout)
  if (!fallbackLayout) {
    return state.layoutByWorktree
  }
  if (tabGroupLayoutEqual(state.layoutByWorktree[worktreeId], fallbackLayout)) {
    return state.layoutByWorktree
  }
  return withWorktreeEntry(
    state,
    'layoutByWorktree',
    worktreeId,
    fallbackLayout,
    (current, next) => current === next,
    batchContext
  )
}
