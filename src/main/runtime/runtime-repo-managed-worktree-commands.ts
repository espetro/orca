import type {
  Repo,
  RuntimeWorktreeListResult,
  DetectedWorktree,
  DetectedWorktreeListResult
} from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../shared/worktree/ownership'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { mergeWorktree } from '../ipc/worktree-logic'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import { getRetiredNameRegistryForRepo } from '../worktree-name-retirement'
import { stopMissingWorktreeTerminals } from './missing-worktree-terminal-reconciliation'
import {
  listRuntimeFolderWorkspaces,
  type RuntimeStore
} from './runtime-repo-git-commands-shared-types'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import type { RuntimeRepoGitCommandsDeps } from './runtime-repo-git-commands-deps'

// Why: narrow closure surface over OrcaRuntimeService so repo/git commands stay
// unit-testable without constructing the full runtime (pattern of runtime-linear-command-host).

export class RuntimeRepoManagedWorktreeCommands {
  private readonly deps: RuntimeRepoGitCommandsDeps

  constructor(deps: RuntimeRepoGitCommandsDeps) {
    this.deps = deps
  }

  private get self() {
    return this
  }

  async listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await self.deps.listResolvedWorktrees()
    const repoId = repoSelector ? (await self.deps.resolveRepoSelector(repoSelector)).id : null
    const settings = self.deps.store?.getSettings()
    const visibilityDefaults = sourceDefaultsSupported
      ? settings?.worktreeVisibilityDefaults
      : settings?.worktreeVisibilityDefaults
        ? { external: settings.worktreeVisibilityDefaults.external }
        : undefined
    const visibilitySettings = settings
      ? { ...settings, worktreeVisibilityDefaults: visibilityDefaults }
      : undefined
    const visibilitySourceMatchersByRepoId = self.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolved,
      visibilityDefaults
    )
    const worktrees = resolved.filter((worktree) => {
      if (repoId && worktree.repoId !== repoId) {
        return false
      }
      return self.isRuntimeWorktreeVisible(
        worktree,
        visibilitySourceMatchersByRepoId.get(worktree.repoId),
        visibilitySettings
      )
    })
    return {
      worktrees: worktrees.slice(0, limit),
      totalCount: worktrees.length,
      truncated: worktrees.length > limit
    }
  }

  /** Keyed by repo id on the wire even though one repo is requested: the caller asked by selector
   *  and needs to know which repo answered.
   *
   *  The tier watermark rides alongside the names rather than being expanded into them — expanding
   *  it would put 552 strings per spent tier on the wire, which is what compaction exists to
   *  avoid. A client predating the field reads the names only and under-retires, degrading to the
   *  pre-retirement behavior for compacted tiers instead of breaking. */
  async listRetiredWorktreeNames(repoSelector: string): Promise<{
    retiredNamesByRepo: Record<string, readonly string[]>
    retiredNameTiersByRepo: Record<string, number>
  }> {
    const store = self.deps.store
    if (!store) {
      return { retiredNamesByRepo: {}, retiredNameTiersByRepo: {} }
    }
    const repo = await self.deps.resolveRepoSelector(repoSelector)
    const settings = store.getSettings()
    const registry: RetiredNameRegistry = await getRetiredNameRegistryForRepo(
      store,
      repo,
      store.getRepos(),
      settings
    )
    return {
      retiredNamesByRepo: { [repo.id]: registry.names },
      retiredNameTiersByRepo: { [repo.id]: registry.exhaustedTiers }
    }
  }

  async listDetectedManagedWorktrees(
    repoSelector: string,
    connectionId?: string | null,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    return self.listDetectedWorktreesForResolvedRepo(
      await self.resolveRepoSelectorForConnection(repoSelector, connectionId),
      sourceDefaultsSupported
    )
  }

  private async listDetectedWorktreesForResolvedRepo(
    repo: Repo,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    const store = self.deps.requireStore()
    const settings = store.getSettings()
    const visibilityDefaults = sourceDefaultsSupported
      ? settings.worktreeVisibilityDefaults
      : settings.worktreeVisibilityDefaults
        ? { external: settings.worktreeVisibilityDefaults.external }
        : undefined
    const visibilitySettings = {
      ...settings,
      worktreeVisibilityDefaults: visibilityDefaults
    }
    if (isFolderRepo(repo)) {
      const worktrees = listRuntimeFolderWorkspaces(store, repo)
      const metaById = store.getAllWorktreeMeta()
      const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
      const matcher = createWorktreeVisibilitySourceMatcher(
        [repo.path, ...worktrees.map((worktree) => worktree.path)],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
      const detected = worktrees.map((worktree) =>
        self.toRuntimeDetectedWorktree(
          repo,
          worktree,
          matcher,
          visibilitySettings,
          getRepoOwnedWorktreeMeta(repo, worktree.id, metaById, repoOwnerCount) ?? null
        )
      )
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
      }
    }
    let scan: RuntimeWorktreeScanResult
    try {
      scan = await self.deps.listRepoWorktreesForResolution(repo)
    } catch {
      scan = { ok: false, worktrees: [] }
    }
    if (scan.ok) {
      pruneLineageForMissingRepoWorktrees(store, repo, scan.worktrees)
    }
    const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
      [repo.path, ...scan.worktrees.map((worktree) => worktree.path)],
      resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
      resolveConfiguredWorktreeBasePaths(repo)
    )
    const expectedHostId = getRepoExecutionHostId(repo)
    const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
    const metaById = store.getAllWorktreeMeta()
    const detected = scan.worktrees.map((gitWorktree) => {
      const worktreeId = `${repo.id}::${gitWorktree.path}`
      // A host-qualified row is exact; the locator-keyed one is only trustworthy when this repo owns it.
      const meta =
        readWorktreeMetaForHost(store, worktreeId, expectedHostId) ??
        getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
      const worktree = {
        ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
        hostId: repoOwnerCount === 1 ? (meta?.hostId ?? expectedHostId) : expectedHostId
      }
      const detectedWorktree = self.toRuntimeDetectedWorktree(
        repo,
        worktree,
        worktreeVisibilitySourceMatcher,
        visibilitySettings,
        meta ?? null
      )
      if (scan.ok) {
        return detectedWorktree
      }
      return applyMetadataFallbackVisibility(detectedWorktree)
    })
    return {
      repoId: repo.id,
      authoritative: scan.ok,
      source: scan.ok ? 'git' : 'metadata-fallback',
      worktrees: projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
    }
  }

  async teardownMissingManagedWorktreeTerminals(
    repoSelector: string,
    knownWorktreeIds: readonly string[],
    connectionId?: string | null
  ): Promise<{ stoppedWorktreeIds: string[] }> {
    const repo = await self.resolveRepoSelectorForConnection(repoSelector, connectionId)
    // Why: killing PTYs must be proven against the host right now — a cached scan
    // (30s TTL) can still list a directory git already dropped, and the renderer
    // purges its state either way, so a stale miss strands those processes for good.
    self.deps.invalidateWorktreeScanCacheForRepo(repo.id)
    // Why: rescanning by `id:` would re-resolve the already-resolved repo, and a
    // duplicate id across hosts makes that second lookup throw selector_ambiguous
    // even though the caller's selector was unique — losing the sweep entirely.
    const detected = await self.listDetectedWorktreesForResolvedRepo(repo)
    if (!detected.authoritative) {
      return { stoppedWorktreeIds: [] }
    }
    return stopMissingWorktreeTerminals(
      repo,
      knownWorktreeIds,
      detected.worktrees.map((worktree) => worktree.id),
      {
        runtime: this,
        getLocalProvider: () => self.deps.getLocalProvider(),
        getSshProvider: (connectionId) => self.deps.getSshProviderFn?.(connectionId),
        onPtyStopped: self.deps.onPtyStopped ?? undefined
      }
    )
  }

  private resolveRepoSelectorForConnection(
    repoSelector: string,
    connectionId?: string | null
  ): Promise<Repo> {
    if (connectionId === undefined) {
      return self.deps.resolveRepoSelector(repoSelector)
    }
    // Why: an explicit connection identity only *narrows* the selector; it must not
    // change the grammar. Matching the selector as a bare repo id would make
    // `path:`/`name:` selectors resolve to repo_not_found on this path alone.
    const wanted = connectionId?.trim() || null
    const matches = self.deps
      .selectReposBySelector(repoSelector)
      .filter((repo) => (repo.connectionId?.trim() || null) === wanted)
    if (matches.length !== 1) {
      throw new Error(matches.length > 1 ? 'selector_ambiguous' : 'repo_not_found')
    }
    return Promise.resolve(matches[0])
  }

  private isRuntimeWorktreeVisible(
    worktree: Worktree,
    worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher,
    settings?: ReturnType<RuntimeStore['getSettings']>
  ): boolean {
    const repo = self.deps.store?.getRepo(worktree.repoId)
    if (!repo || !self.deps.store) {
      return true
    }
    return self.toRuntimeDetectedWorktree(repo, worktree, worktreeVisibilitySourceMatcher, settings)
      .visible
  }

  private buildRuntimeVisibilitySourceMatchersByRepoId(
    worktrees: readonly Worktree[],
    visibilityDefaults?: GlobalSettings['worktreeVisibilityDefaults']
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    const checkoutPathsByRepoId = new Map<string, string[]>()
    for (const worktree of worktrees) {
      const checkoutPaths = checkoutPathsByRepoId.get(worktree.repoId) ?? []
      checkoutPaths.push(worktree.path)
      checkoutPathsByRepoId.set(worktree.repoId, checkoutPaths)
    }
    return new Map(
      (self.deps.store?.getRepos() ?? [])
        .filter((repo) => checkoutPathsByRepoId.has(repo.id))
        .map((repo) => [
          repo.id,
          createWorktreeVisibilitySourceMatcher(
            [repo.path, ...(checkoutPathsByRepoId.get(repo.id) ?? [])],
            resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
            resolveConfiguredWorktreeBasePaths(repo)
          )
        ])
    )
  }

  private toRuntimeDetectedWorktree(
    repo: Repo,
    worktree: Worktree,
    worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>,
    providedMeta?: WorktreeMeta | null
  ): DetectedWorktree {
    const settings = providedSettings ?? self.deps.store?.getSettings()
    if (!settings) {
      return {
        ...worktree,
        ownership: 'unknown-legacy',
        selectedCheckout: false,
        visible: true
      }
    }
    return toDetectedWorktree({
      repo,
      worktree,
      meta:
        providedMeta === undefined
          ? self.deps.store?.getWorktreeMeta(worktree.id)
          : (providedMeta ?? undefined),
      settings,
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
      isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
      worktreeVisibilitySourceMatcher
    })
  }
}
