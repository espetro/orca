import type { RuntimeMobileSessionTabGroup } from '../../../shared/runtime-types'
import type { TabGroup } from '../../../shared/tab-types'
import { isWebSessionBrowserPlacementGroupReserved } from './web-session-browser-placement'
import { resolveWebSessionReorderedOrder } from './web-session-reorder-intent'
import { toWebTerminalSurfaceTabId } from './web-runtime-session'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { MirroredAgentTab } from './web-session-tabs-mirrored-agent-tabs'
import type { MirroredBrowserTab } from './web-session-tabs-mirrored-browser-tabs'
import type { MirroredEditorTab } from './web-session-tabs-mirrored-editor-tabs'
import type { TerminalSurface } from './web-session-tabs-surface-guards'
export function mapHostRecentTabIds(
  recentTabIds: readonly string[] | undefined,
  hostToLocalTabId: ReadonlyMap<string, string>,
  tabOrder: readonly string[]
): string[] {
  if (!recentTabIds || recentTabIds.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  return sanitizeRecentTabIds(
    recentTabIds.map((tabId) => hostToLocalTabId.get(tabId) ?? '').filter(Boolean),
    [...valid]
  )
}

export function buildHostToLocalTabIdMap({
  terminalSurfaces,
  terminalTabs,
  browserTabs,
  editorTabs,
  agentTabs
}: {
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
  agentTabs: readonly MirroredAgentTab[]
}): Map<string, string> {
  const hostToLocal = new Map<string, string>()
  const terminalIds = new Set(terminalTabs.map((tab) => tab.id))
  for (const surface of terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (terminalIds.has(localId)) {
      hostToLocal.set(surface.parentTabId, localId)
      hostToLocal.set(surface.id, localId)
    }
  }
  for (const entry of browserTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
    hostToLocal.set(entry.unifiedTab.id, entry.unifiedTab.id)
  }
  for (const entry of editorTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  for (const entry of agentTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  return hostToLocal
}
export function retainClientPlacedMirroredTabs(args: {
  groups: readonly TabGroup[]
  mirroredUnifiedIds: ReadonlySet<string>
  validUnifiedTabIds: ReadonlySet<string>
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
  nextActiveUnifiedTabId: string | null
}): TabGroup[] {
  return args.groups.map((group) => {
    const retainedTabOrder = group.tabOrder.filter(
      (tabId) =>
        args.validUnifiedTabIds.has(tabId) &&
        (!args.mirroredUnifiedIds.has(tabId) ||
          args.clientGroupIdByLocalTabId.get(tabId) === group.id)
    )
    const placedTabIds = [...args.clientGroupIdByLocalTabId]
      .filter(
        ([tabId, groupId]) =>
          groupId === group.id &&
          args.validUnifiedTabIds.has(tabId) &&
          !retainedTabOrder.includes(tabId)
      )
      .map(([tabId]) => tabId)
    const tabOrder = [...retainedTabOrder, ...placedTabIds]
    const activeTabId =
      args.nextActiveUnifiedTabId && tabOrder.includes(args.nextActiveUnifiedTabId)
        ? args.nextActiveUnifiedTabId
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
    return {
      ...group,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, tabOrder), activeTabId)
        : []
    }
  })
}

export function buildMirroredHostGroups({
  currentGroups,
  hostGroups,
  hostToLocalTabId,
  mirroredUnifiedIds,
  nextActiveUnifiedTabId,
  now,
  validUnifiedTabIds,
  environmentId,
  worktreeId,
  clientGroupIdByLocalTabId
}: {
  currentGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
  hostToLocalTabId: ReadonlyMap<string, string>
  mirroredUnifiedIds: ReadonlySet<string>
  nextActiveUnifiedTabId: string | null
  now: number
  validUnifiedTabIds: ReadonlySet<string>
  environmentId: string
  worktreeId: string
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
}): TabGroup[] | null {
  const strippedGroups = retainClientPlacedMirroredTabs({
    groups: currentGroups,
    mirroredUnifiedIds,
    validUnifiedTabIds,
    clientGroupIdByLocalTabId,
    nextActiveUnifiedTabId
  })
  const groupsById = new Map(strippedGroups.map((group) => [group.id, group]))
  const orderedGroups: TabGroup[] = []
  const seen = new Set<string>()

  for (const hostGroup of hostGroups) {
    const existing = groupsById.get(hostGroup.id)
    const localHostOrder = hostGroup.tabOrder
      .map((tabId) => hostToLocalTabId.get(tabId))
      .filter(
        (tabId): tabId is string =>
          tabId !== undefined &&
          validUnifiedTabIds.has(tabId) &&
          !clientGroupIdByLocalTabId.has(tabId)
      )
    const localHostOrderIds = new Set(localHostOrder)
    const hostTabOrder = [
      ...(existing?.tabOrder.filter((tabId) => !localHostOrderIds.has(tabId)) ?? []),
      ...localHostOrder
    ]
    // Why: a pending client reorder wins over a stale pre-move host order until the host echoes the move (or membership changes).
    const tabOrder = resolveWebSessionReorderedOrder(
      { environmentId },
      worktreeId,
      hostGroup.id,
      hostTabOrder,
      now
    )
    if (tabOrder.length === 0) {
      continue
    }
    const activeFromHost =
      hostGroup.activeTabId !== null ? (hostToLocalTabId.get(hostGroup.activeTabId) ?? null) : null
    const activeTabId =
      nextActiveUnifiedTabId && tabOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : activeFromHost && tabOrder.includes(activeFromHost)
          ? activeFromHost
          : existing?.activeTabId && tabOrder.includes(existing.activeTabId)
            ? existing.activeTabId
            : (tabOrder[0] ?? null)
    orderedGroups.push({
      id: hostGroup.id,
      worktreeId,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(
            mapHostRecentTabIds(hostGroup.recentTabIds, hostToLocalTabId, tabOrder),
            activeTabId
          )
        : []
    })
    seen.add(hostGroup.id)
  }

  for (const group of strippedGroups) {
    if (
      !seen.has(group.id) &&
      (group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId: group.id }))
    ) {
      orderedGroups.push(group)
    }
  }

  return orderedGroups.length > 0 ? orderedGroups : null
}
export function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.toReversed()
}

export function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  return [...base.filter((id) => id !== tabId), tabId]
}
