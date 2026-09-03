import type { WebSessionTabsFocusContext } from './web-session-tabs-apply-focus'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import { toVisibleTabType } from './web-session-tabs-mirrored-equality'

export function buildWebSessionTabsVisibleFocusTypes(
  ctx: NonNullable<WebSessionTabsFocusContext>,
  state: WebSessionTabsSyncState,
  isActiveWorktree: boolean
) {
  const {
    snapshot,
    worktreeId,
    navigationIntentTab,
    nextUnifiedTabs,
    nextTerminalTabs,
    nextWorktreeOpenFileIds,
    nextActiveUnifiedTabId,
    nextActiveTerminalId,
    nextActiveBrowserWorkspaceId,
    nextActiveEditorFileId,
    activeMirroredAgentTabId,
    intentMirroredAgent,
    currentActiveTerminalStillExists,
    currentActiveBrowserStillExists,
    currentActiveEditorStillExists,
    intentBrowserWorkspaceId,
    intentTerminalId,
    intentEditorFileId,
    currentVisibleUnifiedTabId,
    currentVisibleStructuredTabId
  } = ctx
  const focusIntentVisibleTabType =
    navigationIntentTab?.type === 'agent-session' && intentMirroredAgent
      ? ('agent-session' as const)
      : navigationIntentTab?.type === 'browser' && intentBrowserWorkspaceId
        ? ('browser' as const)
        : navigationIntentTab?.type === 'terminal' && intentTerminalId
          ? ('terminal' as const)
          : intentEditorFileId
            ? ('editor' as const)
            : null
  const snapshotVisibleTabType =
    snapshot.activeTabType === 'agent-session' && activeMirroredAgentTabId
      ? ('agent-session' as const)
      : snapshot.activeTabType === 'browser' && nextActiveBrowserWorkspaceId
        ? ('browser' as const)
        : snapshot.activeTabType === 'terminal' && nextActiveTerminalId
          ? ('terminal' as const)
          : (snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file') &&
              nextActiveEditorFileId
            ? ('editor' as const)
            : null
  const currentVisibleTabType =
    state.activeTabTypeByWorktree[worktreeId] ?? (isActiveWorktree ? state.activeTabType : null)
  const currentVisibleTabTypeStillValid =
    currentVisibleStructuredTabId !== null
      ? ('agent-session' as const)
      : currentVisibleTabType === 'agent-session' &&
          currentVisibleUnifiedTabId &&
          nextUnifiedTabs?.some(
            (tab) => tab.id === currentVisibleUnifiedTabId && tab.contentType === 'agent-session'
          )
        ? ('agent-session' as const)
        : currentVisibleTabType === 'browser' && currentActiveBrowserStillExists
          ? ('browser' as const)
          : currentVisibleTabType === 'editor' && currentActiveEditorStillExists
            ? ('editor' as const)
            : currentVisibleTabType === 'terminal' && currentActiveTerminalStillExists
              ? ('terminal' as const)
              : null
  const activeUnifiedTab =
    nextActiveUnifiedTabId && nextUnifiedTabs
      ? (nextUnifiedTabs.find((tab) => tab.id === nextActiveUnifiedTabId) ?? null)
      : null
  const fallbackVisibleTabType =
    activeUnifiedTab !== null
      ? toVisibleTabType(activeUnifiedTab)
      : nextActiveTerminalId
        ? ('terminal' as const)
        : nextActiveBrowserWorkspaceId
          ? ('browser' as const)
          : nextActiveEditorFileId
            ? ('editor' as const)
            : ('terminal' as const)
  const currentActiveTerminalStillValid =
    state.activeTabId && (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : null
  const currentActiveEditorStillValid =
    state.activeFileId && nextWorktreeOpenFileIds.has(state.activeFileId)
      ? state.activeFileId
      : null
  return {
    focusIntentVisibleTabType,
    snapshotVisibleTabType,
    currentVisibleTabTypeStillValid,
    activeUnifiedTab,
    fallbackVisibleTabType,
    currentActiveTerminalStillValid,
    currentActiveEditorStillValid
  }
}
