import type { RuntimeMobileSnapshotMergeDeps } from './runtime-mobile-snapshot-merge-commands-deps'

type RuntimeMobileSessionTabsSnapshot = any
type RuntimeMobileSessionClientTab = any
type RuntimeMobileSessionTerminalTab = any
type RuntimeMobileSessionBrowserTab = any
type RuntimeMobileSessionMarkdownTab = any

export class RuntimeMobileSnapshotMergeCommands {
  constructor(private readonly deps: RuntimeMobileSnapshotMergeDeps) {}

  mergePreservedHeadlessMobileSessionTabs(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): RuntimeMobileSessionTabsSnapshot {
    if (!existing) {
      return snapshot
    }
    const preservedTabs = this.collectPreservedHeadlessMobileSessionTabs(existing, snapshot)
    if (preservedTabs.length === 0) {
      return snapshot
    }
    const preservedActiveTab = preservedTabs.find(
      (tab: any) => tab.id === existing.activeTabId && tab.isActive
    )
    const hasIncomingActiveTab = snapshot.tabs.some((tab: any) => tab.isActive)
    const normalizedPreservedTabs = preservedTabs.map((tab: any) =>
      hasIncomingActiveTab && !preservedActiveTab ? { ...tab, isActive: false } : tab
    )
    const normalizedIncomingTabs = preservedActiveTab
      ? snapshot.tabs.map((tab: any) => (tab.isActive ? { ...tab, isActive: false } : tab))
      : snapshot.tabs
    const tabs = this.mergeMobileSessionSnapshotTabs(
      normalizedIncomingTabs,
      normalizedPreservedTabs
    )
    if (tabs.length === snapshot.tabs.length) {
      return snapshot
    }
    return {
      ...snapshot,
      tabs,
      activeTabId: preservedActiveTab?.id ?? snapshot.activeTabId
    }
  }

  private collectPreservedHeadlessMobileSessionTabs(
    existing: RuntimeMobileSessionTabsSnapshot,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): (RuntimeMobileSessionClientTab | RuntimeMobileSessionTerminalTab | RuntimeMobileSessionBrowserTab | RuntimeMobileSessionMarkdownTab)[] {
    return []
  }

  private mergeMobileSessionSnapshotTabs(a: any[], b: any[]): any[] {
    return a
  }
}
