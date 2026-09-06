import type {
  RuntimeMobileSessionTabsResult,
  RuntimeSyncedTab,
  RuntimeWorktreePsSummary
} from '../../shared/runtime-types'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-tail-projection'
import { findRuntimeWorktreeSummaryByPath, parseRuntimeWorktreeId } from './runtime-tail-projection'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../shared/runtime-types'
import type { RuntimeLeafRecord } from './orca-runtime'

export type RuntimeWorktreeSummaryCommandsDeps = Pick<
  RuntimeManagedWorktreesDeps,
  | 'mobileSessionTabsByWorktree'
  | 'projectMobileSessionTabsForClient'
  | 'toMobileSessionTabsResult'
  | 'tabs'
  | 'leaves'
>

import type { RuntimeManagedWorktreesDeps } from './runtime-managed-worktrees'

export class RuntimeWorktreeSummaryCommands {
  constructor(private deps: RuntimeWorktreeSummaryCommandsDeps) {}

  getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(worktreeId)
    if (!snapshot) {
      return this.deps.projectMobileSessionTabsForClient(
        {
          worktree: worktreeId,
          publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        clientNavigationId
      )
    }
    return this.deps.projectMobileSessionTabsForClient(
      this.deps.toMobileSessionTabsResult(snapshot),
      clientNavigationId
    )
  }

  getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    const exact = summaries.get(runtimeWorktreeId)
    if (exact) {
      return exact
    }
    if (missingRuntimeWorktreeIds.has(runtimeWorktreeId)) {
      return null
    }
    const parsed = parseRuntimeWorktreeId(runtimeWorktreeId)
    if (!parsed) {
      return null
    }
    const comparisonPlatform =
      runtimeWorktreeSummaryPathIndex.platformByRepoId.get(parsed.repoId) ?? process.platform
    const indexed = findRuntimeWorktreeSummaryByPath(
      runtimeWorktreeSummaryPathIndex,
      parsed.repoId,
      parsed.worktreePath,
      comparisonPlatform
    )
    if (indexed) {
      return indexed
    }
    missingRuntimeWorktreeIds.add(runtimeWorktreeId)
    return null
  }

  collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = new Set<string>()
    for (const [tabId, tab] of this.deps.tabs()) {
      const prev = previousTabs.get(tabId)
      if (!prev || prev.title !== tab.title) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [tabId, tab] of previousTabs) {
      if (!this.deps.tabs().has(tabId)) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [leafKey, leaf] of this.deps.leaves()) {
      const prev = previousLeaves.get(leafKey)
      if (
        !prev ||
        prev.ptyId !== leaf.ptyId ||
        prev.connected !== leaf.connected ||
        prev.paneTitle !== leaf.paneTitle
      ) {
        changed.add(leaf.worktreeId)
      }
    }
    for (const [leafKey, leaf] of previousLeaves) {
      if (!this.deps.leaves().has(leafKey)) {
        changed.add(leaf.worktreeId)
      }
    }
    return changed
  }
}
