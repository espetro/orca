import type { ExecutionHostId } from '../../shared/execution-host'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeWorktreePsSummary
} from '../../shared/runtime-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeVisibilitySourceMatcher } from '../../shared/worktree/visibility-sources'
import type {
  ResolvedWorktree,
  ResolvedWorktreeSnapshot,
  RuntimePtyWorktreeRecord,
  RuntimeStore,
  RuntimeWorkingTerminalEvidence
} from './orca-runtime'
import type { RuntimeLeafRecord } from './runtime-leaf-record'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-tail-projection'
import {
  DEFAULT_WORKTREE_PS_LIMIT,
  addRuntimeWorkingTerminalEvidence,
  buildRuntimeWorktreeSummaryPathIndex,
  compareWorktreePs,
  getLatestPtyTitle,
  getLeafWorktreeStatus,
  getSavedTabWorktreeStatus,
  maxTimestamp,
  mergeWorktreeSummaryStatus,
  runtimeWorktreeIdsEqual
} from './runtime-tail-projection'

export type RuntimeWorktreePsDeps = {
  attachAgentRowsToSummaries: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    mirroredWorktreeIdByTabId: ReadonlyMap<string, string>,
    connectedPtyEvidence: {
      tabIds: ReadonlySet<string>
      paneKeys: ReadonlySet<string>
      ptyIds: ReadonlySet<string>
    },
    workingTerminalEvidenceByWorktreeId: ReadonlyMap<
      string,
      readonly RuntimeWorkingTerminalEvidence[]
    >
  ) => void
  buildRuntimeVisibilitySourceMatchersByRepoId: (
    worktrees: readonly Worktree[],
    visibilityDefaults?: GlobalSettings['worktreeVisibilityDefaults']
  ) => Map<string, WorktreeVisibilitySourceMatcher>
  getSummaryForRuntimeWorktreeId: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ) => RuntimeWorktreePsSummary | null
  isRuntimeWorktreeVisible: (
    worktree: Worktree,
    worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher,
    settings?: ReturnType<RuntimeStore['getSettings']>
  ) => boolean
  leaves: Map<string, RuntimeLeafRecord>
  listResolvedWorktreeSnapshot: () => Promise<ResolvedWorktreeSnapshot>
  makeRuntimePaneKey: (
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ) => string
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  refreshPtyWorktreeRecordsFromController: (
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId?: string | null,
    deadline?: number
  ) => Promise<Set<string> | null>
  store: () => RuntimeStore | null
  tabs: Map<string, RuntimeSyncedTab>
}

export class RuntimeWorktreePs {
  private readonly deps: RuntimeWorktreePsDeps

  constructor(deps: RuntimeWorktreePsDeps) {
    this.deps = deps
  }

  async getWorktreePs(
    limit = DEFAULT_WORKTREE_PS_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktreeSnapshot = await this.deps.listResolvedWorktreeSnapshot()
    const settings = this.deps.store()?.getSettings()
    const visibilityDefaults = sourceDefaultsSupported
      ? settings?.worktreeVisibilityDefaults
      : settings?.worktreeVisibilityDefaults
        ? { external: settings.worktreeVisibilityDefaults.external }
        : undefined
    const visibilitySettings = settings
      ? { ...settings, worktreeVisibilityDefaults: visibilityDefaults }
      : undefined
    const visibilitySourceMatchersByRepoId = this.deps.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolvedWorktreeSnapshot.worktrees,
      visibilityDefaults
    )
    const resolvedWorktrees = resolvedWorktreeSnapshot.worktrees.filter((worktree) =>
      this.deps.isRuntimeWorktreeVisible(
        worktree,
        visibilitySourceMatchersByRepoId.get(worktree.repoId),
        visibilitySettings
      )
    )
    // Why: worktree.ps backs the mobile sidebar, so it must use the same
    // host-owned imported-worktree visibility gate as worktree.list/desktop.
    const freshPtyLiveness =
      await this.deps.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const repoById = new Map((this.deps.store()?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const platformByRepoId = resolvedWorktreeSnapshot.platformByRepoId
    const summaries = new Map<string, RuntimeWorktreePsSummary>()
    const workingTerminalEvidenceByWorktreeId = new Map<string, RuntimeWorkingTerminalEvidence[]>()

    // Why: the GitHub cache is keyed by `repoPath::branch` (no refs/heads/ prefix),
    // matching how the renderer's fetchPRForBranch stores entries. We look up cached
    // PR info so mobile clients can group worktrees by PR state without making
    // expensive `gh` CLI calls. Falls back to meta.linkedPR if no cache entry exists.
    const ghCache = this.deps.store()?.getGitHubCache?.()
    for (const worktree of resolvedWorktrees) {
      const meta =
        this.deps.store()?.getWorktreeMeta?.(worktree.id) ??
        this.deps.store()?.getAllWorktreeMeta()[worktree.id]
      const repo = repoById.get(worktree.repoId)
      let linkedPR: { number: number; state: string } | null = null
      const branch = worktree.branch.replace(/^refs\/heads\//, '')
      if (branch && ghCache) {
        // Why: the renderer keys the PR cache by `repoId::branch` (getGitHubPRCacheKey
        // prefers repo.id over repo.path), so read by id first and fall back to path
        // for legacy/path-keyed entries. Reading only by path missed every cached
        // entry, leaving mobile's linked-PR badge stuck on the 'unknown' fallback.
        const cached =
          (repo?.id ? ghCache.pr[`${repo.id}::${branch}`] : undefined) ??
          (repo?.path ? ghCache.pr[`${repo.path}::${branch}`] : undefined)
        if (cached?.data) {
          linkedPR = { number: cached.data.number, state: cached.data.state }
        }
      }
      if (!linkedPR && meta?.linkedPR != null) {
        linkedPR = { number: meta.linkedPR, state: 'unknown' }
      }
      const terminalPlatform = platformByRepoId.get(worktree.repoId) ?? process.platform
      // Why: use the instance-validated lineage from attachLineageToResolvedWorktrees,
      // not the raw store entry — shipped mobile clients trust parentWorktreeId as-is,
      // so a stale same-path entry would nest replacement checkouts under old parents.
      const lineage = worktree.lineage
      summaries.set(worktree.id, {
        // Why: mobile mirrors desktop workspace grouping/order from persisted
        // metadata, while older runtimes may not have hydrated every field yet.
        workspaceKind: 'git',
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        ...((meta?.hostId ?? worktree.hostId) ? { hostId: meta?.hostId ?? worktree.hostId } : {}),
        terminalPlatform,
        repo: repo?.displayName ?? worktree.repoId,
        path: worktree.path,
        branch: worktree.branch,
        isArchived: worktree.isArchived,
        isMainWorktree: worktree.isMainWorktree,
        hasHostSidebarActivity: false,
        ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
        ...(lineage?.worktreeInstanceId !== undefined
          ? { lineageWorktreeInstanceId: lineage.worktreeInstanceId }
          : {}),
        ...(lineage?.parentWorktreeInstanceId !== undefined
          ? { parentWorktreeInstanceId: lineage.parentWorktreeInstanceId }
          : {}),
        parentWorktreeId: worktree.parentWorktreeId,
        childWorktreeIds: worktree.childWorktreeIds,
        displayName: worktree.displayName,
        workspaceStatus: meta?.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
        sortOrder: meta?.sortOrder ?? 0,
        ...(meta?.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
        lastActivityAt: worktree.lastActivityAt,
        ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
        ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
        linkedIssue: worktree.linkedIssue,
        linkedPR,
        linkedLinearIssue: meta?.linkedLinearIssue ?? null,
        linkedGitLabMR: meta?.linkedGitLabMR ?? null,
        linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
        comment: meta?.comment ?? '',
        isPinned: meta?.isPinned ?? false,
        isActive: false,
        unread: meta?.isUnread ?? false,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: '',
        status: 'inactive',
        agents: []
      })
    }

    const projectGroupById = new Map(
      (this.deps.store()?.getProjectGroups?.() ?? []).map((group) => [group.id, group])
    )
    for (const folderWorkspace of this.deps.store()?.getFolderWorkspaces?.() ?? []) {
      const projectGroup = projectGroupById.get(folderWorkspace.projectGroupId)
      if (!projectGroup?.parentPath) {
        continue
      }
      const worktree = folderWorkspaceToWorktree(folderWorkspace)
      summaries.set(worktree.id, {
        // Why: folder workspaces use the same mobile grouping/order contract as
        // git worktrees, but legacy records may be missing order metadata.
        workspaceKind: 'folder-workspace',
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        repo: projectGroup.name,
        path: worktree.path,
        branch: worktree.branch,
        isArchived: worktree.isArchived,
        isMainWorktree: worktree.isMainWorktree,
        hasHostSidebarActivity: false,
        ...(worktree.instanceId !== undefined ? { worktreeInstanceId: worktree.instanceId } : {}),
        parentWorktreeId: null,
        childWorktreeIds: [],
        displayName: worktree.displayName,
        workspaceStatus: worktree.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
        sortOrder: worktree.sortOrder ?? 0,
        ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
        lastActivityAt: worktree.lastActivityAt,
        ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
        ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
        linkedIssue: worktree.linkedIssue ?? null,
        linkedPR: null,
        linkedLinearIssue: worktree.linkedLinearIssue ?? null,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null,
        linkedGitLabIssue: worktree.linkedGitLabIssue ?? null,
        comment: worktree.comment,
        isPinned: worktree.isPinned,
        isActive: false,
        unread: worktree.isUnread,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: '',
        status: 'inactive',
        agents: []
      })
    }

    const runtimeWorktreeSummaryPathIndex = buildRuntimeWorktreeSummaryPathIndex(
      summaries,
      resolvedWorktrees,
      platformByRepoId
    )
    const missingRuntimeWorktreeIds = new Set<string>()
    const countedPtyIds = new Set<string>()
    const session = this.deps.store()?.getWorkspaceSession?.()
    const savedTabOwnerById = new Map<string, { worktreeId: string; title: string }>()
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        savedTabOwnerById.set(tab.id, { worktreeId, title: tab.title })
      }
    }
    const savedLayoutTabIdByPtyId = new Map<string, string>()
    for (const [tabId, layout] of Object.entries(session?.terminalLayoutsByTabId ?? {})) {
      for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
        if (ptyId) {
          savedLayoutTabIdByPtyId.set(ptyId, tabId)
        }
      }
    }
    for (const leaf of this.deps.leaves.values()) {
      if (
        !leaf.ptyId ||
        !leaf.connected ||
        (freshPtyLiveness !== null && !freshPtyLiveness.has(leaf.ptyId))
      ) {
        continue
      }
      const freshPtyOwner = this.deps.ptysById.get(leaf.ptyId)
      if (
        freshPtyLiveness !== null &&
        freshPtyOwner?.connected &&
        !runtimeWorktreeIdsEqual(freshPtyOwner.worktreeId, leaf.worktreeId)
      ) {
        // Why: provider/persisted ownership is fresher than a renderer leaf left behind by graph migration or another client.
        continue
      }
      const summary = this.deps.getSummaryForRuntimeWorktreeId(
        summaries,
        runtimeWorktreeSummaryPathIndex,
        missingRuntimeWorktreeIds,
        leaf.worktreeId
      )
      if (!summary) {
        continue
      }
      countedPtyIds.add(leaf.ptyId)
      summary.hasHostSidebarActivity = true
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = true
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
      const leafStatus = getLeafWorktreeStatus(leaf, this.deps.tabs.get(leaf.tabId)?.title ?? null)
      if (leafStatus === 'working') {
        addRuntimeWorkingTerminalEvidence(workingTerminalEvidenceByWorktreeId, summary.worktreeId, {
          paneKey: this.deps.makeRuntimePaneKey(leaf),
          ptyId: leaf.ptyId,
          tabId: leaf.tabId
        })
      }
      mergeWorktreeSummaryStatus(summary, leafStatus)
      if (
        leaf.preview &&
        (summary.preview.length === 0 || (leaf.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = leaf.preview
      }
    }

    for (const pty of this.deps.ptysById.values()) {
      if (
        !pty.connected ||
        countedPtyIds.has(pty.ptyId) ||
        (freshPtyLiveness !== null && !freshPtyLiveness.has(pty.ptyId))
      ) {
        continue
      }
      const persistedTabId = savedLayoutTabIdByPtyId.get(pty.ptyId)
      let owner = persistedTabId ? savedTabOwnerById.get(persistedTabId) : undefined
      if (freshPtyLiveness !== null) {
        // Why: refresh resolved provider/migration ownership; stale persisted tabs may supply a title but cannot reassign a live PTY.
        owner = {
          worktreeId: pty.worktreeId,
          title: owner?.title ?? getLatestPtyTitle(pty) ?? ''
        }
      }
      if (!owner && persistedTabId && pty.tabId === persistedTabId) {
        owner = {
          worktreeId: pty.worktreeId,
          title: getLatestPtyTitle(pty) ?? ''
        }
      }
      const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
      const hasExplicitRuntimeOwner =
        pty.tabId !== null && parsedPaneKey?.tabId === pty.tabId && parsedPaneKey.leafId.length > 0
      const savedTabOwner = pty.tabId ? savedTabOwnerById.get(pty.tabId) : undefined
      const hasSavedLayout =
        pty.tabId !== null && Object.hasOwn(session?.terminalLayoutsByTabId ?? {}, pty.tabId)
      if (!owner && hasExplicitRuntimeOwner && !hasSavedLayout) {
        owner = {
          worktreeId: savedTabOwner?.worktreeId ?? pty.worktreeId,
          title: savedTabOwner?.title ?? getLatestPtyTitle(pty) ?? ''
        }
      }
      if (!owner) {
        // Why: provider existence alone cannot attribute a reused or unbound PTY to a workspace.
        continue
      }
      const summary = this.deps.getSummaryForRuntimeWorktreeId(
        summaries,
        runtimeWorktreeSummaryPathIndex,
        missingRuntimeWorktreeIds,
        owner.worktreeId
      )
      if (!summary) {
        continue
      }
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = true
      summary.hasHostSidebarActivity = true
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, pty.lastOutputAt)
      const ptyStatus = getSavedTabWorktreeStatus(owner.title, true)
      if (ptyStatus === 'working') {
        addRuntimeWorkingTerminalEvidence(workingTerminalEvidenceByWorktreeId, summary.worktreeId, {
          paneKey: pty.paneKey,
          ptyId: pty.ptyId,
          tabId: pty.tabId ?? persistedTabId ?? null
        })
      }
      mergeWorktreeSummaryStatus(summary, ptyStatus)
      if (
        pty.preview &&
        (summary.preview.length === 0 || (pty.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = pty.preview
      }
    }

    const mirroredWorktreeIdByTabId = new Map<string, string>()
    const sessionsByHostId = new Map<ExecutionHostId, WorkspaceSessionState>()
    for (const summary of summaries.values()) {
      const repo = repoById.get(summary.repoId)
      const hostId = repo ? getRepoExecutionHostId(repo) : 'local'
      const session = this.deps.store()?.getWorkspaceSession?.(hostId)
      if (session) {
        sessionsByHostId.set(hostId, session)
      }
    }
    for (const session of sessionsByHostId.values()) {
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        for (const tab of tabs) {
          mirroredWorktreeIdByTabId.set(tab.id, worktreeId)
        }
        if (tabs.length === 0) {
          continue
        }
        const summary = this.deps.getSummaryForRuntimeWorktreeId(
          summaries,
          runtimeWorktreeSummaryPathIndex,
          missingRuntimeWorktreeIds,
          worktreeId
        )
        if (!summary) {
          continue
        }
        if (
          tabs.some((tab) => tab.ptyId !== null && this.deps.ptysById.get(tab.ptyId)?.connected)
        ) {
          summary.hasHostSidebarActivity = true
        }
      }
      for (const [worktreeId, tabs] of Object.entries(session.browserTabsByWorktree ?? {})) {
        if (tabs.length === 0) {
          continue
        }
        const summary = this.deps.getSummaryForRuntimeWorktreeId(
          summaries,
          runtimeWorktreeSummaryPathIndex,
          missingRuntimeWorktreeIds,
          worktreeId
        )
        if (summary) {
          summary.hasHostSidebarActivity = true
        }
      }
      if (session.activeWorktreeId) {
        const activeSummary = this.deps.getSummaryForRuntimeWorktreeId(
          summaries,
          runtimeWorktreeSummaryPathIndex,
          missingRuntimeWorktreeIds,
          session.activeWorktreeId
        )
        if (activeSummary) {
          activeSummary.isActive = true
        }
      }
    }
    // Why: a live renderer graph may precede persistence, but persisted tab
    // ownership wins when an automatic workspace rename has already rekeyed it.
    for (const [tabId, tab] of this.deps.tabs) {
      if (!mirroredWorktreeIdByTabId.has(tabId)) {
        mirroredWorktreeIdByTabId.set(tabId, tab.worktreeId)
      }
    }

    // Why: a connected PTY proves a pane is still live even when its tab has
    // already left every session record (daemon-held terminals, graph gaps).
    // Deliberately trusts the optimistic connected flag (no freshPtyLiveness
    // gate, unlike the count loops above): evidence only KEEPS rows.
    const connectedPtyEvidence = {
      tabIds: new Set<string>(),
      paneKeys: new Set<string>(),
      ptyIds: new Set<string>()
    }
    for (const pty of this.deps.ptysById.values()) {
      if (!pty.connected) {
        continue
      }
      connectedPtyEvidence.ptyIds.add(pty.ptyId)
      if (pty.tabId) {
        connectedPtyEvidence.tabIds.add(pty.tabId)
      }
      if (pty.paneKey) {
        connectedPtyEvidence.paneKeys.add(pty.paneKey)
      }
    }

    this.deps.attachAgentRowsToSummaries(
      summaries,
      runtimeWorktreeSummaryPathIndex,
      missingRuntimeWorktreeIds,
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      workingTerminalEvidenceByWorktreeId
    )

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
  }
}
