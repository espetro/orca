import { buildWebSessionTabsActiveIntentStage } from './web-session-tabs-apply-focus-active-intent'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import type { WebSessionTabsSnapshotApplyOptions } from './web-session-tabs-snapshot-options'
import type { WebSessionTabsMirroredContext } from './web-session-tabs-apply-context'
import { buildWebSessionTabsClientOwnedPlacement } from './web-session-tabs-apply-focus-placement'
import { buildTerminalUnifiedTab } from './web-session-tabs-mirrored-unified-tabs'

export function buildWebSessionTabsFocusContext(
  state: WebSessionTabsSyncState,
  mirrored: WebSessionTabsMirroredContext,
  environmentId: string,
  worktreeId: string,
  options?: WebSessionTabsSnapshotApplyOptions
) {
  if (!mirrored) {
    return null
  }
  const {
    mirroredTerminalTabs,
    removedTerminalIds,
    targetGroupId,
    hostGroupIdByTabId,
    currentUnifiedTabs,
    existingTabIndex,
    mirroredBrowserTabs,
    mirroredBrowserWorkspaceIds,
    removedBrowserWorkspaceIds,
    mirroredEditorTabs,
    mirroredAgentTabs,
    mirroredEditorFileIds,
    mirroredEditorHostTabIds,
    removedEditorFileIds,
    mirroredTerminalIds,
    honorSnapshotActiveFocus
  } = mirrored

  const retainedUnifiedTabs = currentUnifiedTabs.filter((tab) => {
    if (tab.contentType === 'agent-session') {
      return false
    }
    if (tab.contentType === 'browser') {
      return (
        !removedBrowserWorkspaceIds.has(tab.entityId) &&
        !mirroredBrowserWorkspaceIds.has(tab.entityId)
      )
    }
    if (tab.contentType === 'editor') {
      return (
        !removedEditorFileIds.has(tab.entityId) &&
        !mirroredEditorFileIds.has(tab.entityId) &&
        !mirroredEditorHostTabIds.has(tab.id)
      )
    }
    if (tab.contentType !== 'terminal') {
      return true
    }
    if (removedTerminalIds.has(tab.entityId) || removedTerminalIds.has(tab.id)) {
      return false
    }
    return !mirroredTerminalIds.has(tab.entityId) && !mirroredTerminalIds.has(tab.id)
  })
  const existingViewModeByTabId = new Map(
    currentUnifiedTabs
      .filter((tab) => tab.contentType === 'terminal' && tab.viewMode)
      .map((tab) => [tab.id, tab.viewMode] as const)
  )
  const mirroredTerminalUnifiedTabs = mirroredTerminalTabs.map((entry) =>
    buildTerminalUnifiedTab(
      entry.tab,
      hostGroupIdByTabId.get(entry.hostTabId) ?? targetGroupId,
      environmentId,
      entry.tab.viewMode ?? existingViewModeByTabId.get(entry.tab.id)
    )
  )
  const mirroredBrowserUnifiedTabs = mirroredBrowserTabs.map((entry) => entry.unifiedTab)
  const mirroredEditorUnifiedTabs = mirroredEditorTabs.map((entry) => entry.unifiedTab)
  const mirroredAgentUnifiedTabs = mirroredAgentTabs.map((entry) => entry.unifiedTab)
  const mirroredUnifiedTabs = [
    ...mirroredTerminalUnifiedTabs,
    ...mirroredBrowserUnifiedTabs,
    ...mirroredEditorUnifiedTabs,
    ...mirroredAgentUnifiedTabs
  ]
  const nextUnifiedTabs =
    retainedUnifiedTabs.length + mirroredUnifiedTabs.length > 0
      ? [...retainedUnifiedTabs, ...mirroredUnifiedTabs]
      : null
  const validUnifiedTabIds = new Set(nextUnifiedTabs?.map((tab) => tab.id) ?? [])
  const activeIntent = buildWebSessionTabsActiveIntentStage(state, environmentId, mirrored, {
    nextUnifiedTabs,
    retainedUnifiedTabs,
    mirroredUnifiedTabs,
    validUnifiedTabIds
  })
  const {
    activeHostTerminalId,
    activeHostTerminalParentId,
    activeMirroredTerminalId,
    activeHostBrowser,
    activeMirroredBrowser,
    activeMirroredBrowserTabId,
    activeMirroredBrowserWorkspaceId,
    activeHostEditor,
    activeMirroredEditor,
    activeMirroredEditorFileId,
    activeMirroredEditorTabId,
    activeHostAgent,
    activeMirroredAgentTabId,
    intentMirroredTerminalId,
    intentMirroredBrowser,
    intentMirroredEditor,
    intentMirroredAgent,
    currentActiveTerminalStillExists,
    intentTerminalId,
    nextActiveTerminalId,
    currentActiveBrowserStillExists,
    intentBrowserWorkspaceId,
    nextActiveBrowserWorkspaceId,
    activeEditorFileIdForWorktree,
    currentActiveEditorStillExists,
    intentEditorFileId,
    nextActiveEditorFileId,
    currentVisibleUnifiedTabId,
    currentVisibleStructuredTabId,
    activeGroupId,
    reservedEmptyPreviewFallbackTabId,
    intentUnifiedTabId,
    nextActiveUnifiedTabId,
    mirroredUnifiedIds,
    hostToLocalTabId
  } = activeIntent
  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  const clientGroupIdByLocalTabId = new Map(
    mirroredBrowserTabs.flatMap((entry) =>
      entry.clientGroupId ? [[entry.unifiedTab.id, entry.clientGroupId]] : []
    )
  )
  // Why: once this worktree has client groups, placement is client-owned — snapshots may only
  // append never-seen tabs, drop vanished ones, and honor explicit focus intent. Host order,
  // host actives, and host layout apply only on first adoption (no client groups yet).
  const clientOwnedPlacement = buildWebSessionTabsClientOwnedPlacement(
    state,
    mirrored,
    {
      nextUnifiedTabs,
      currentGroups,
      mirroredUnifiedTabs,
      validUnifiedTabIds,
      intentUnifiedTabId,
      reservedEmptyPreviewFallbackTabId,
      honorSnapshotActiveFocus,
      clientGroupIdByLocalTabId,
      existingTabIndex
    },
    environmentId,
    worktreeId,
    options
  )
  return {
    ...mirrored,
    retainedUnifiedTabs,
    existingViewModeByTabId,
    mirroredTerminalUnifiedTabs,
    mirroredBrowserUnifiedTabs,
    mirroredEditorUnifiedTabs,
    mirroredAgentUnifiedTabs,
    mirroredUnifiedTabs,
    nextUnifiedTabs,
    validUnifiedTabIds,
    activeHostTerminalId,
    activeHostTerminalParentId,
    activeMirroredTerminalId,
    activeHostBrowser,
    activeMirroredBrowser,
    activeMirroredBrowserTabId,
    activeMirroredBrowserWorkspaceId,
    activeHostEditor,
    activeMirroredEditor,
    activeMirroredEditorFileId,
    activeMirroredEditorTabId,
    activeHostAgent,
    activeMirroredAgentTabId,
    intentMirroredTerminalId,
    intentMirroredBrowser,
    intentMirroredEditor,
    intentMirroredAgent,
    currentActiveTerminalStillExists,
    intentTerminalId,
    nextActiveTerminalId,
    currentActiveBrowserStillExists,
    intentBrowserWorkspaceId,
    nextActiveBrowserWorkspaceId,
    activeEditorFileIdForWorktree,
    currentActiveEditorStillExists,
    intentEditorFileId,
    nextActiveEditorFileId,
    currentVisibleUnifiedTabId,
    currentVisibleStructuredTabId,
    activeGroupId,
    reservedEmptyPreviewFallbackTabId,
    intentUnifiedTabId,
    nextActiveUnifiedTabId,
    mirroredUnifiedIds,
    hostToLocalTabId,
    currentGroups,
    clientGroupIdByLocalTabId,
    clientOwnedPlacement
  }
}

export type WebSessionTabsFocusContext = ReturnType<typeof buildWebSessionTabsFocusContext>
