import { getAgentLaunchPlatformForRepo } from './agent-launch-platform'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { Repo } from '../../shared/repo-types'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { areWorktreePathsEqual, mergeWorktree } from '../ipc/worktree-logic'
import type { Store } from '../persistence'
import type { Worktree } from '../../shared/worktree/types'
import type { ResolvedWorktree } from './orca-runtime'
import {
  getLocalProjectWorktreeGitOptionsForRuntime,
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from '../project-runtime-git-options'
import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import type { RepoWorktreeRowDeps } from './repo-worktree-row-resolution'
import {
  listStoredWorktreeRowsForRepo,
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow
} from './repo-worktree-row-resolution'
import {
  RESOLVED_WORKTREE_CACHE_TTL_MS,
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
  resolveWorktreeScanCacheTtlMs,
  withTimeoutResult
} from './runtime-tail-projection'

type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}
type ResolvedWorktreeCache = ResolvedWorktreeSnapshot & {
  expiresAt: number
}
type ResolvedWorktreeInFlight = {
  generation: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
type RuntimeWorktreeScanCache = {
  generation: number
  runtimeKey: string
  result: RuntimeWorktreeScanResult
  expiresAt: number
  adminFingerprint: string | null
  scannedAt: number
}
type RuntimeWorktreeScanInFlight = {
  generation: number
  runtimeKey: string
  promise: Promise<RuntimeWorktreeScanRefresh>
}
type RuntimeWorktreeScanRefresh = {
  result: RuntimeWorktreeScanResult
  adminFingerprint: string | null
  adminFingerprintProbe: Promise<string | null> | null
  scannedAt: number
}

export type RuntimeResolvedWorktreeCacheDeps = {
  store: () => Store | null
  requireStore: () => Store
  listFolderWorkspaces: (repo: Repo, repoOwnerCount: number) => Worktree[]
}

export class RuntimeResolvedWorktreeCache {
  private readonly deps: RuntimeResolvedWorktreeCacheDeps
  private resolvedWorktreeCache: ResolvedWorktreeCache | null = null
  private resolvedWorktreeInFlight: ResolvedWorktreeInFlight | null = null
  private resolvedWorktreeGeneration = 0
  private worktreeScanGenerations = new Map<string, number>()
  private worktreeScanCache = new Map<string, RuntimeWorktreeScanCache>()
  private worktreeScanInFlight = new Map<string, RuntimeWorktreeScanInFlight>()
  private worktreeAdminFingerprintProbes = new Set<string>()

  constructor(deps: RuntimeResolvedWorktreeCacheDeps) {
    this.deps = deps
  }

  buildResolvedWorktreeFromId(worktreeId: string): ResolvedWorktree | null {
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed?.repoId || !parsed.worktreePath) {
      return null
    }
    const repo = this.deps
      .store()
      ?.getRepos()
      .find((entry) => entry.id === parsed.repoId)
    const git = {
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: repo ? areWorktreePathsEqual(parsed.worktreePath, repo.path) : false
    }
    const meta = this.deps.store()?.getWorktreeMeta(worktreeId)
    const merged = {
      ...mergeWorktree(parsed.repoId, git, meta, repo?.displayName),
      ...(repo ? { hostId: meta?.hostId ?? getRepoExecutionHostId(repo) } : {})
    }
    return {
      ...merged,
      id: worktreeId,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git,
      displayName: merged.displayName,
      comment: merged.comment
    }
  }

  listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    const store = this.deps.store()
    if (!store || !targetWorktree) {
      return []
    }
    const target = splitWorktreeIdForFilesystem(targetWorktreeId)
    if (!target?.repoId || !target.worktreePath) {
      return []
    }
    const worktreeIds = new Set(
      Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) => {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        return (
          parsed?.repoId === target.repoId &&
          Boolean(parsed.worktreePath) &&
          (isPathInsideOrEqual(target.worktreePath, parsed.worktreePath) ||
            isPathInsideOrEqual(parsed.worktreePath, target.worktreePath))
        )
      })
    )
    worktreeIds.add(targetWorktreeId)

    const resolved: ResolvedWorktree[] = []
    for (const worktreeId of worktreeIds) {
      const worktree =
        worktreeId === targetWorktreeId
          ? targetWorktree
          : this.buildResolvedWorktreeFromId(worktreeId)
      if (worktree) {
        resolved.push(worktree)
      }
    }
    return resolved
  }

  hasFreshResolvedWorktreeCache(): boolean {
    return Boolean(this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > Date.now())
  }

  /** Synchronous read of the cache entry, if warm; never computes. */
  peekSnapshot(): ResolvedWorktreeCache | null {
    const entry = this.resolvedWorktreeCache
    return entry && entry.expiresAt > Date.now() ? entry : null
  }

  async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return (await this.listResolvedWorktreeSnapshot()).worktrees
  }

  async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.deps.store()) {
      return { worktrees: [], platformByRepoId: new Map<string, NodeJS.Platform>() }
    }
    const now = Date.now()
    if (this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > now) {
      return this.resolvedWorktreeCache
    }
    const generation = this.resolvedWorktreeGeneration
    if (this.resolvedWorktreeInFlight?.generation === generation) {
      return this.resolvedWorktreeInFlight.promise
    }

    const promise = this.computeResolvedWorktrees(generation)
    this.resolvedWorktreeInFlight = { generation, promise }
    try {
      return await promise
    } finally {
      if (this.resolvedWorktreeInFlight?.promise === promise) {
        this.resolvedWorktreeInFlight = null
      }
    }
  }

  async computeResolvedWorktrees(generation: number): Promise<ResolvedWorktreeSnapshot> {
    const store = this.deps.store()
    if (!store) {
      return { worktrees: [], platformByRepoId: new Map<string, NodeJS.Platform>() }
    }
    const metaById = store.getAllWorktreeMeta() ?? {}
    const repos = store.getRepos()
    const repoOwnerCounts = new Map<string, number>()
    for (const repo of repos) {
      repoOwnerCounts.set(repo.id, (repoOwnerCounts.get(repo.id) ?? 0) + 1)
    }
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(
      this.deps.requireStore(),
      repos
    )
    const platformByRepoId = new Map<string, NodeJS.Platform>(
      repos.map((repo) => [
        repo.id,
        getAgentLaunchPlatformForRepo(repo, projectRuntimeByRepoId.get(repo.id))
      ])
    )
    const deps = this.repoWorktreeRowDeps()
    const perRepoWorktrees = await Promise.all(
      repos.map(
        async (repo) =>
          await resolveRepoWorktreeRows(
            deps,
            repo,
            metaById,
            projectRuntimeByRepoId,
            repoOwnerCounts.get(repo.id) ?? 1
          )
      )
    )
    const lineageById = this.deps.store()?.getAllWorktreeLineage?.() ?? {}
    const worktrees = perRepoWorktrees.flatMap((rows) =>
      projectResolvedWorktreeLineage(rows, lineageById)
    )
    // Why: short TTL avoids shelling out on every frequent poll while still catching worktree changes made outside Orca.
    // Why stamped on completion, not entry: a compute that spent longer than the TTL would otherwise publish an
    // already-expired entry, so the very next poll recomputes and every caller repeats the same slow path.
    if (generation === this.resolvedWorktreeGeneration) {
      this.resolvedWorktreeCache = {
        worktrees,
        platformByRepoId,
        expiresAt: Date.now() + RESOLVED_WORKTREE_CACHE_TTL_MS
      }
    }
    return { worktrees, platformByRepoId }
  }

  repoWorktreeRowDeps(): RepoWorktreeRowDeps {
    const store = this.deps.requireStore()
    return {
      store,
      scanRepo: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId),
      listFolderWorkspaces: (repo, repoOwnerCount) =>
        this.deps.listFolderWorkspaces(repo, repoOwnerCount)
    }
  }

  async resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null> {
    if (!this.deps.store()) {
      return null
    }
    return await resolveScopedWorktreeIdRow(this.repoWorktreeRowDeps(), worktreeId, requiredHostId)
  }

  async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const now = Date.now()
    const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scanScopeKey) ?? 0
    const projectRuntime = repo.connectionId
      ? undefined
      : projectRuntimeByRepoId
        ? projectRuntimeByRepoId.get(repo.id)
        : resolveLocalProjectRuntimeForRepo(this.deps.requireStore(), repo)
    const runtimeKey = projectRuntime
      ? projectRuntime.status === 'resolved'
        ? projectRuntime.runtime.cacheKey
        : projectRuntime.repair.cacheKey
      : repo.connectionId
        ? `ssh:${repo.connectionId}:${getSshGitProviderGeneration(repo.connectionId)}`
        : 'local:default'
    const cached = this.worktreeScanCache.get(scanScopeKey)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      cached.expiresAt > now
    ) {
      return cached.result
    }
    const inFlight = this.worktreeScanInFlight.get(scanScopeKey)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      const refresh = await inFlight.promise
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      return refresh.result
    }
    const reusableCached =
      cached?.generation === generation && cached.runtimeKey === runtimeKey ? cached : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
    this.worktreeScanInFlight.set(scanScopeKey, { generation, runtimeKey, promise })
    try {
      const refresh = await promise
      // Why: fence the caller as well as cache writeback, or an event refresh can consume a stale scan.
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      // Why: back off local spawn failures under resource pressure while disconnected SSH can recover on the next poll.
      if (
        (refresh.result.ok || !repo.connectionId) &&
        this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise
      ) {
        const entry: RuntimeWorktreeScanCache = {
          generation,
          runtimeKey,
          result: refresh.result,
          expiresAt: Date.now() + resolveWorktreeScanCacheTtlMs(repo),
          adminFingerprint: refresh.adminFingerprint,
          scannedAt: refresh.scannedAt
        }
        this.worktreeScanCache.set(scanScopeKey, entry)
        // Why a writeback instead of storing the promise: a probe that never settles must not be
        // awaited by a later refresh. Identity check keeps a stale probe out of a newer entry.
        void refresh.adminFingerprintProbe?.then((fingerprint) => {
          if (this.worktreeScanCache.get(scanScopeKey) === entry) {
            entry.adminFingerprint = fingerprint
          }
        })
      }
      return refresh.result
    } finally {
      if (this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise) {
        this.worktreeScanInFlight.delete(scanScopeKey)
      }
    }
  }

  async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const scannedAt = Date.now()
    // SSH and WSL-routed repos run Git off-host, so a local admin-dir read cannot describe them.
    const fingerprintCapable =
      !repo.connectionId &&
      // Why: a repo whose scan TTL already reaches the reconciliation interval can never reuse a
      // fingerprint, so reading one would be pure work. Agent-scratch roots are that case today.
      resolveWorktreeScanCacheTtlMs(repo) < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS &&
      !getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    // Why issue it before the scan: a change landing while the scan runs must not be stamped as
    // already-observed, or the next probe would mask it until the reconciliation deadline.
    const probe = fingerprintCapable ? this.startRepoWorktreeAdminFingerprintProbe(repo) : null
    const reusable =
      cached?.result.ok === true &&
      scannedAt - cached.scannedAt < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
        ? cached
        : null
    if (probe && reusable) {
      // Why await only here: this is the one branch whose decision needs the probe. A scan-bound
      // caller must never wait on it, or every cold read pays filesystem latency it cannot use.
      const probed = await withTimeoutResult(probe, WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      if (!probed.ok) {
        // Why log: expiry and "fingerprint unavailable" both surface as `null`, so a wedged mount is
        // otherwise indistinguishable from a repo that simply cannot be fingerprinted.
        console.warn('[worktree-scan] admin fingerprint probe expired; running a full scan', {
          repoId: repo.id,
          timeoutMs: WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
        })
      }
      const current = probed.ok ? probed.value : null
      if (current !== null && current === reusable.adminFingerprint) {
        return {
          result: reusable.result,
          adminFingerprint: current,
          adminFingerprintProbe: null,
          scannedAt: reusable.scannedAt
        }
      }
    }
    const result = await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime)
    return { result, adminFingerprint: null, adminFingerprintProbe: probe, scannedAt }
  }

  startRepoWorktreeAdminFingerprintProbe(repo: Repo): Promise<string | null> | null {
    if (this.worktreeAdminFingerprintProbes.has(repo.id)) {
      return null
    }
    this.worktreeAdminFingerprintProbes.add(repo.id)
    return readRepoWorktreeAdminFingerprint(repo.path)
      .catch(() => null)
      .finally(() => {
        this.worktreeAdminFingerprintProbes.delete(repo.id)
      })
  }

  async listRepoWorktreesForResolutionUncached(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined
  ): Promise<RuntimeWorktreeScanResult> {
    if (!repo.connectionId) {
      return await scanLocalRepoWorktreesForResolution(
        repo.path,
        getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
      )
    }
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    try {
      return { ok: true, worktrees: await provider.listWorktrees(repo.path) }
    } catch {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
  }

  listStoredWorktreesForResolution(repo: Repo): GitWorktreeInfo[] {
    return this.deps.store() ? listStoredWorktreeRowsForRepo(this.deps.requireStore(), repo) : []
  }

  async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktreeGeneration += 1
    this.resolvedWorktreeCache = null
  }

  invalidateWorktreeScanCacheForRepo(repoId: string): void {
    const prefix = `${repoId}\0`
    const scopeKeys = new Set(
      this.deps
        .store()
        ?.getRepos()
        .filter((repo) => repo.id === repoId)
        .map((repo) => `${repoId}\0${getRepoExecutionHostId(repo)}`) ?? []
    )
    for (const keys of [
      this.worktreeScanGenerations.keys(),
      this.worktreeScanCache.keys(),
      this.worktreeScanInFlight.keys()
    ]) {
      for (const key of keys) {
        if (key.startsWith(prefix)) {
          scopeKeys.add(key)
        }
      }
    }
    for (const key of scopeKeys) {
      this.worktreeScanGenerations.set(key, (this.worktreeScanGenerations.get(key) ?? 0) + 1)
      this.worktreeScanCache.delete(key)
      this.worktreeScanInFlight.delete(key)
    }
  }

  invalidateSshWorktreeScanCacheInternal(targetId: string): void {
    const repos = this.deps.store()?.getRepos() ?? []
    const affectedRepos = repos.filter((repo) => repo.connectionId === targetId)
    const affectedScopeKeys = new Set(
      affectedRepos.map((repo) => `${repo.id}\0${getRepoExecutionHostId(repo)}`)
    )
    for (const key of affectedScopeKeys) {
      this.worktreeScanGenerations.set(key, (this.worktreeScanGenerations.get(key) ?? 0) + 1)
      this.worktreeScanCache.delete(key)
      this.worktreeScanInFlight.delete(key)
    }
    if (affectedScopeKeys.size > 0) {
      this.resolvedWorktreeGeneration += 1
      this.resolvedWorktreeCache = null
    }
  }
}
