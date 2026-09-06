import type { RecentWorkspaceTabRow } from '@/lib/recent-workspace-tab-rows'
import type { TabPaneInputSources } from '@/components/sidebar/smart-attention'
import {
  resolveTerminalTabAttentionBadge,
  terminalTabHasUnreadActivity
} from '@/components/tab-bar/terminal-tab-activity-status'
import { resolveRecentWorkspaceTabStatus } from '@/lib/recent-workspace-tab-rows'
import type { Worktree } from '../../../shared/worktree/types'
import type { OpenTabPaletteItem } from './worktree/types'

function isCurrentOpenTabItem(item: OpenTabPaletteItem): boolean {
  return item.type === 'browser-page' ? item.result.isCurrentPage : item.result.isCurrentTab
}

/** Not the command id: two hosts — or a duplicate snapshot — can publish the same tab id. */
function getRecentTabOccurrenceBase(item: OpenTabPaletteItem): string {
  if (item.type === 'browser-page') {
    const result = item.result
    return JSON.stringify([
      item.type,
      item.id,
      result.executionHostId ?? '',
      result.worktreeId,
      result.workspaceId,
      result.pageId
    ])
  }
  if (item.type === 'simulator-tab') {
    const result = item.result
    // Why no groupId: it changes when a tab is regrouped mid-open, and the frozen
    // order must keep resolving the row; tabId already identifies it within a host.
    return JSON.stringify([
      item.type,
      item.id,
      result.executionHostId ?? '',
      result.worktreeId,
      result.tabId
    ])
  }
  const result = item.result
  return JSON.stringify([
    item.type,
    item.id,
    result.executionHostId ?? '',
    result.worktreeId,
    result.tabId,
    result.entityId
  ])
}

export function buildRecentTabOccurrenceIds(items: readonly OpenTabPaletteItem[]): string[] {
  const nextOrdinalByBase = new Map<string, number>()
  return items.map((item) => {
    const base = getRecentTabOccurrenceBase(item)
    const ordinal = nextOrdinalByBase.get(base) ?? 0
    nextOrdinalByBase.set(base, ordinal + 1)
    return `recent-tab:${base}:${ordinal}`
  })
}

/** An open tab's recent-section row plus the inputs inclusion needs. */
export type OpenTabRecentRow = {
  item: OpenTabPaletteItem
  occurrenceId: string
  worktree: Worktree
  row: RecentWorkspaceTabRow
}

/**
 * Empty-query recent section: skip idle "where you already are" rows, but keep the current tab when
 * it still wants something from you (working, permission, unread). Decided from the open-time status
 * snapshot, so membership matches the frozen row order for the whole session — a current tab that
 * goes high-signal mid-open joins Recent on the next open, not under the cursor.
 */
export function shouldIncludeOpenTabInRecentSection({
  item,
  worktree,
  row,
  paneSources,
  unreadTerminalTabs,
  unreadAgentCompletionPanes,
  now
}: {
  item: OpenTabPaletteItem
  worktree: Worktree
  row: RecentWorkspaceTabRow
  paneSources: TabPaneInputSources
  unreadTerminalTabs: Record<string, boolean | undefined>
  unreadAgentCompletionPanes: Record<string, boolean | undefined>
  now: number
}): boolean {
  if (worktree.isArchived) {
    return false
  }
  if (!isCurrentOpenTabItem(item)) {
    return true
  }
  // Current browser/editor rows have no attention ladder to escape "you're already here".
  if (!row.terminalTab) {
    return false
  }
  // Why the ladder minus `done`: the badge rungs decide entry, but a completion you watched land on
  // screen (unread auto-acks on the focused tab) is news to nobody, and `done` lingers for the full
  // 30m staleness window — that slot belongs to a workspace you can't already see. Rows admitted
  // while working keep their frozen slot and flip to the check.
  const badge = resolveTerminalTabAttentionBadge({
    status: resolveRecentWorkspaceTabStatus(row, paneSources, now),
    hasUnread: terminalTabHasUnreadActivity({
      terminalTabId: row.terminalTab.id,
      unreadTerminalTabs,
      unreadAgentCompletionPanes
    })
  })
  return badge != null && badge !== 'done' && badge !== 'interrupted'
}
