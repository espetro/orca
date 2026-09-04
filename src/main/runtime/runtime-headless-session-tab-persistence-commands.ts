import type { RuntimeHeadlessSessionTabPersistenceDeps } from './runtime-headless-session-tab-persistence-commands-deps'
import type { WorkspaceSessionState, RuntimeMobileSessionTabsSnapshot, TerminalPaneLayoutNode, RuntimeMobileSessionSnapshotTab } from '../../shared/worktree/types'

export class RuntimeHeadlessSessionTabPersistenceCommands {
  constructor(private deps: RuntimeHeadlessSessionTabPersistenceDeps) {}

  persistHeadlessSessionTabProps = (
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ): void => {
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.deps.store?.setWorkspaceSession) {
      return
    }
    const tabs = session.tabsByWorktree[worktreeId]
    const nextSession: WorkspaceSessionState = { ...session }
    let changed = false
    if (tabs?.some((tab) => tab.id === tabId)) {
      changed = true
      nextSession.tabsByWorktree = {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
                ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
              }
            : tab
        )
      }
    }

    const unifiedTabs = session.unifiedTabs?.[worktreeId]
    if (unifiedTabs?.some((tab) => tab.id === tabId || tab.entityId === tabId)) {
      changed = true
      nextSession.unifiedTabs = {
        ...session.unifiedTabs,
        [worktreeId]: unifiedTabs.map((tab) =>
          tab.id === tabId || tab.entityId === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {})
              }
            : tab
        )
      }
    }

    if (!changed) {
      return
    }
    this.deps.setWorkspaceSessionForWorktree(worktreeId, nextSession)
  }

  applyHeadlessSessionTabPropsToSnapshot = (
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ): void => {
    const snapshot = this.deps.getMobileSessionTabsByWorktree(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (this.getMobileSessionTopLevelTabId(tab) !== tabId) {
        return tab
      }
      changed = true
      return {
        ...tab,
        ...(props.color !== undefined ? { color: props.color } : {}),
        ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
        ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.deps.setMobileSessionTabsByWorktree(worktreeId, nextSnapshot)
    this.deps.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  getMobileSessionTopLevelTabId = (tab: RuntimeMobileSessionSnapshotTab): string => {
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  persistHeadlessTerminalPaneLayout = (
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
    }
  ): void => {
    this.deps.setTerminalLayoutsByTabId(args.tabId, args.root)
    this.deps.setExpandedLeafIdByTabId(args.tabId, args.expandedLeafId)
    const session = this.deps.getWorkspaceSessionForWorktree(worktreeId)
    if (!session) {
      return
    }
    const nextSession: WorkspaceSessionState = { ...session }
    this.deps.setWorkspaceSessionForWorktree(worktreeId, nextSession)
  }

  persistHeadlessTerminalPaneLayoutToSnapshot = (
    worktreeId: string,
    tabId: string,
    root: TerminalPaneLayoutNode | null
  ): void => {
    const snapshot = this.deps.getMobileSessionTabsByWorktree(worktreeId)
    if (!snapshot) {
      return
    }
    const updated = snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || tab.id !== tabId) {
        return tab
      }
      return { ...tab, terminalLayout: root }
    })
    if (updated === snapshot.tabs) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs: updated
    }
    this.deps.setMobileSessionTabsByWorktree(worktreeId, nextSnapshot)
    this.deps.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  applyHeadlessTerminalPaneLayoutToSnapshot = (
    worktreeId: string,
    tabId: string,
    expandedLeafId: string | null
  ): void => {
    const snapshot = this.deps.getMobileSessionTabsByWorktree(worktreeId)
    if (!snapshot) {
      return
    }
    const updated = snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || tab.id !== tabId) {
        return tab
      }
      return { ...tab, expandedLeafId }
    })
    if (updated === snapshot.tabs) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs: updated
    }
    this.deps.setMobileSessionTabsByWorktree(worktreeId, nextSnapshot)
    this.deps.emitMobileSessionTabsSnapshot(nextSnapshot)
  }
}
