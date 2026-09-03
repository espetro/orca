import type { TabGroup } from '../../../shared/tab-types'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import type { WebSessionTabsFocusContext } from './web-session-tabs-apply-focus'
import { isWebSessionBrowserPlacementGroupReserved } from './web-session-browser-placement'
import {
  buildMirroredHostGroups,
  pushRecentTabId,
  retainClientPlacedMirroredTabs,
  sanitizeRecentTabIds
} from './web-session-tabs-mirrored-groups'

export function buildWebSessionTabsGroupsAndTabBarOrder(
  state: WebSessionTabsSyncState,
  ctx: WebSessionTabsFocusContext,
  environmentId: string,
  worktreeId: string,
  now: number
) {
  if (!ctx) {
    return null
  }
  const {
    targetGroupId,
    retainedUnifiedTabs,
    mirroredUnifiedTabs,
    nextUnifiedTabs,
    validUnifiedTabIds,
    nextActiveUnifiedTabId,
    mirroredUnifiedIds,
    hostToLocalTabId,
    currentGroups,
    clientGroupIdByLocalTabId,
    clientOwnedPlacement
  } = ctx
  const { snapshot } = ctx

  const nextGroups = (() => {
    if (clientOwnedPlacement) {
      return clientOwnedPlacement.groups
    }
    if (!nextUnifiedTabs || nextUnifiedTabs.length === 0) {
      return null
    }
    if (snapshot.tabGroups && snapshot.tabGroups.length > 0) {
      return buildMirroredHostGroups({
        currentGroups,
        hostGroups: snapshot.tabGroups,
        hostToLocalTabId,
        mirroredUnifiedIds,
        nextActiveUnifiedTabId,
        now,
        validUnifiedTabIds,
        environmentId,
        worktreeId,
        clientGroupIdByLocalTabId
      })
    }
    const strippedGroups = retainClientPlacedMirroredTabs({
      groups: currentGroups,
      mirroredUnifiedIds,
      validUnifiedTabIds,
      clientGroupIdByLocalTabId,
      nextActiveUnifiedTabId
    })
    const target = strippedGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const targetOrder = [
      ...target.tabOrder.filter((tabId) => validUnifiedTabIds.has(tabId)),
      ...mirroredUnifiedTabs
        .filter((tab) => !clientGroupIdByLocalTabId.has(tab.id))
        .map((tab) => tab.id)
    ]
    const targetActiveTabId =
      nextActiveUnifiedTabId && targetOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : target.activeTabId && targetOrder.includes(target.activeTabId)
          ? target.activeTabId
          : (targetOrder[0] ?? null)
    const updatedTarget: TabGroup = {
      ...target,
      worktreeId,
      tabOrder: targetOrder,
      activeTabId: targetActiveTabId,
      recentTabIds: targetActiveTabId
        ? pushRecentTabId(sanitizeRecentTabIds(target.recentTabIds, targetOrder), targetActiveTabId)
        : []
    }
    const merged = strippedGroups.some((group) => group.id === targetGroupId)
      ? strippedGroups.map((group) => (group.id === targetGroupId ? updatedTarget : group))
      : [...strippedGroups, updatedTarget]
    return merged.filter(
      (group) =>
        group.id === targetGroupId ||
        group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({
          worktreeId,
          groupId: group.id
        })
    )
  })()

  const nextTabBarOrder = (() => {
    const current = state.tabBarOrderByWorktree[worktreeId] ?? []
    const validTabBarIds = new Set([
      ...retainedUnifiedTabs.map((tab) => tab.id),
      ...mirroredUnifiedTabs.map((tab) => tab.id)
    ])
    const hostTabBarOrder =
      snapshot.tabGroups?.flatMap((group) =>
        group.tabOrder
          .map((tabId) => hostToLocalTabId.get(tabId))
          .filter((tabId): tabId is string => tabId !== undefined && validTabBarIds.has(tabId))
      ) ?? []
    const next: string[] = []
    const seen = new Set<string>()
    const push = (tabId: string): void => {
      if (validTabBarIds.has(tabId) && !seen.has(tabId)) {
        seen.add(tabId)
        next.push(tabId)
      }
    }
    // Why: snapshots can arrive after the client staged local browser tabs, so preserve visible order and only append new host tabs.
    for (const tabId of current) {
      push(tabId)
    }
    const hostOrMirroredOrder =
      hostTabBarOrder.length > 0 ? hostTabBarOrder : mirroredUnifiedTabs.map((tab) => tab.id)
    for (const tabId of hostOrMirroredOrder) {
      push(tabId)
    }
    return next
  })()
  return {
    nextGroups,
    nextTabBarOrder
  }
}

export type WebSessionTabsGroupsAndTabBarOrder = ReturnType<
  typeof buildWebSessionTabsGroupsAndTabBarOrder
>
