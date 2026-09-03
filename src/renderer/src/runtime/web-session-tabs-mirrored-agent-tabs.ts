import type { Tab } from '../../../shared/tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { isAgentSessionTab } from './web-session-tabs-surface-guards'

export type MirroredAgentTab = {
  hostTabId: string
  unifiedTab: Tab
}
export function buildMirroredAgentTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  currentUnifiedTabs: readonly Tab[],
  now: number
): MirroredAgentTab[] {
  return snapshot.tabs.filter(isAgentSessionTab).map((tab, index) => {
    const localId = structuredAgentSessionTabId(tab.sessionId)
    const existing = currentUnifiedTabs.find(
      (candidate) => candidate.contentType === 'agent-session' && candidate.id === localId
    )
    return {
      hostTabId: tab.id,
      unifiedTab: {
        id: localId,
        entityId: tab.sessionId,
        groupId: hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId,
        worktreeId: snapshot.worktree,
        contentType: 'agent-session',
        agentSessionAgent: tab.agent,
        label: tab.title.trim() || 'Codex Chat',
        customLabel: null,
        color: tab.color !== undefined ? tab.color : (existing?.color ?? null),
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + sortOffset + index,
        isPinned: tab.isPinned !== undefined ? tab.isPinned : existing?.isPinned === true
      }
    }
  })
}
