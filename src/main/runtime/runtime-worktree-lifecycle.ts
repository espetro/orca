/* eslint-disable max-lines -- Why: this module contains extracted worktree lifecycle operations; state-owner extraction can split further if max-lines limits expand */
import type {
  RemoveWorktreeResult,
  ForceDeleteWorktreeBranchResult,
  ExecutionHostId,
  GitPushTarget
} from '../../shared/runtime-rpc-schema'
import { preservedBranchCleanupScopeKey } from '../../shared/preserved-branch-cleanup'
import { parseExactWorktreeIdSelector } from '../../shared/worktree/id'
import { parseExecutionHostId } from '../../shared/runtime-execution-host'
import { requireSshGitProvider } from '../git/ssh-git-provider'
import { getSshFilesystemProvider } from '../git/ssh-filesystem-provider'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  getLocalProjectWorktreeGitOptions,
  getRepoExecutionHostId,
  resolveWorktreeRemovalRepoOwner
} from '../../shared/repo-worktree-git-context'
import {
  forceDeleteLocalBranch,
  listWorktreesStrict,
  removeWorktree,
  findRegisteredDeletableWorktree,
  assertWorktreeUnlockedForRemoval,
  formatWorktreeRemovalError,
  isWindowsAbsolutePathLike
} from '../../shared/worktree-git-commands'
import {
  removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  cleanupUnusedWorktreePushTargetRemote
} from '../../shared/worktree-removal-coordination'
import {
  getRuntimeFolderWorkspaceRootId,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  canCleanupUnregisteredOrcaLeftoverDirectory,
  resolveWorktreeRemovalMetadata,
  isRuntimeWorktreePathMissing,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError,
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath,
  isLocalRuntimeGitRepository,
  assertWorktreeCleanForRemoval,
  isDangerousWorktreeRemovalPath,
  removeLocalWorktreePath,
  getWorktreeSharedLinkPaths,
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths,
  recoverLocalWindowsWorktreeRemoval,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../../shared/worktree-removal-fs'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { gitExecFileAsync } from '../git/runner'
import { deleteRemoteWorktreeHistory } from '../../shared/terminal-history/remote-history-sync'
import { withWorktreeSpan } from '../../shared/tracing-worktree-spans'
import { getRuntimeWorktreeRemovalOptionsKey } from '../../shared/worktree-removal-race-detection'
import { killAllProcessesForWorktree } from '../child-process/worktree-process-cleanup'
import { invalidateAuthorizedRootsCache } from '../authorized-roots-cache'
import { getEffectiveHooks, runHook } from '../worktree-hooks/hook-runner'

type WorktreeLifecycleRuntime = {
  store: unknown | undefined
  preservedBranchCleanupByScope: Map<string, unknown>
  removeManagedWorktreeInFlight: Map<string, unknown>
  getSshProviderFn?: (connectionId: string) => unknown
  getLocalProvider(): unknown
  onPtyStopped?: (...args: unknown[]) => void
  requireStore(): unknown
  resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    hostId?: ExecutionHostId
  ): Promise<unknown>
  clearOptimisticReconcileToken(worktreeId: string): void
  removeWorktreeMetadataAndHistory(store: unknown, worktreeId: string, hostId?: ExecutionHostId): void
  acquireFileWatcherRemoval(path: string, connectionId?: string): Promise<unknown>
  stopPtysForDestructiveWorktreeRemoval(
    worktreeId: string,
    options: unknown
  ): Promise<void>
  closeFileWatchersForRemoval(path: string): Promise<void>
  invalidateResolvedWorktreeCache(): void
  invalidateWorktreeScanCacheForRepo(repoId: string): void
  notifyWorktreesChanged(repoId: string): void
  emitWorktreeLifecycle(event: unknown): void
}

export function rememberPreservedBranchCleanupTarget(
  runtime: WorktreeLifecycleRuntime,
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined,
  pushTarget: GitPushTarget | undefined
): void {
  if (result?.preservedBranch) {
    const head = result.preservedBranch.head ?? fallbackHead
    if (!head) {
      throw new Error(
        `Cannot safely offer force-delete for preserved branch "${result.preservedBranch.branchName}" without its saved commit.`
      )
    }
    runtime.preservedBranchCleanupByScope.set(
      preservedBranchCleanupScopeKey({ worktreeId, hostId }),
      {
        worktreeId,
        ...(hostId ? { hostId } : {}),
        branchName: result.preservedBranch.branchName,
        head,
        ...(pushTarget ? { pushTarget } : {})
      }
    )
    return
  }
  runtime.preservedBranchCleanupByScope.delete(
    preservedBranchCleanupScopeKey({ worktreeId, hostId })
  )
}

function preserveBranchHeadFallback(
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined
): RemoveWorktreeResult {
  if (!result?.preservedBranch || result.preservedBranch.head || !fallbackHead) {
    return result ?? {}
  }
  return {
    ...result,
    preservedBranch: {
      ...result.preservedBranch,
      head: fallbackHead
    }
  }
}

export async function forceDeletePreservedBranch(
  runtime: WorktreeLifecycleRuntime,
  worktreeSelector: string,
  branchName: string,
  expectedHead: string,
  hostId?: string
): Promise<ForceDeleteWorktreeBranchResult> {
  if (!runtime.store) {
    throw new Error('runtime_unavailable')
  }
  const removalTarget = parseExactWorktreeIdSelector(worktreeSelector)
  const normalizedHostId = parseExecutionHostId(hostId)?.id
  const exactTarget = removalTarget
    ? runtime.preservedBranchCleanupByScope.get(
        preservedBranchCleanupScopeKey({ worktreeId: removalTarget.id, hostId: normalizedHostId })
      )
    : undefined
  const legacyMatches =
    removalTarget && !hostId
      ? [...runtime.preservedBranchCleanupByScope.values()].filter(
          (target) =>
            (target as any).worktreeId === removalTarget.id &&
            (target as any).branchName === branchName &&
            (target as any).head === expectedHead
        )
      : []
  const cleanupTarget = exactTarget ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined)
  if (
    !removalTarget ||
    !cleanupTarget ||
    (cleanupTarget as any).branchName !== branchName ||
    (cleanupTarget as any).head !== expectedHead
  ) {
    throw new Error(`No preserved branch cleanup is pending for "${branchName}".`)
  }

  const repoOwner = resolveWorktreeRemovalRepoOwner(
    runtime.store as any,
    removalTarget.repoId,
    (cleanupTarget as any).hostId
  )
  if (repoOwner.kind === 'ambiguous') {
    throw new Error(
      `Workspace identity is ambiguous across hosts: ${removalTarget.id}. Retry with an explicit host.`
    )
  }
  const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
  if (!repo) {
    throw new Error('repo_not_found')
  }
  if (isFolderRepo(repo)) {
    throw new Error('Folder workspaces do not have local Git branches.')
  }

  if (repo.connectionId) {
    const provider = requireSshGitProvider(repo.connectionId)
    // Why: SSH must use the write-capable relay RPC; the shared exec-based
    // helper routes through the read-only git.exec allowlist, which rejects
    // the worktree/update-ref/config writes this delete needs.
    await provider.forceDeletePreservedBranch(
      repo.path,
      (cleanupTarget as any).branchName,
      (cleanupTarget as any).head
    )
    await cleanupUnusedWorktreePushTargetRemoteSsh(
      provider,
      repo.path,
      removalTarget.id,
      (cleanupTarget as any).pushTarget,
      runtime.store as any
    )
  } else {
    const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(runtime.requireStore() as any, repo)
    await (Object.keys(localWorktreeGitOptions).length > 0
      ? forceDeleteLocalBranch(
          repo.path,
          (cleanupTarget as any).branchName,
          (cleanupTarget as any).head,
          (argv, cwd) => gitExecFileAsync(argv, { cwd, ...localWorktreeGitOptions })
        )
      : forceDeleteLocalBranch(repo.path, (cleanupTarget as any).branchName, (cleanupTarget as any).head))
    await cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      removalTarget.id,
      (cleanupTarget as any).pushTarget,
      runtime.store as any,
      localWorktreeGitOptions
    )
  }

  runtime.preservedBranchCleanupByScope.delete(
    preservedBranchCleanupScopeKey({
      worktreeId: removalTarget.id,
      hostId: (cleanupTarget as any).hostId
    })
  )
  return { deleted: true }
}

export async function removeManagedWorktree(
  runtime: WorktreeLifecycleRuntime,
  worktreeSelector: string,
  force = false,
  runHooks = false,
  // Why (#11960): only an explicit Force Delete waives PTY-stop proof; `force`
  // alone is already set by the ordinary delete confirmation.
  allowUnverifiedPtyStop = false,
  hostId?: string
): Promise<RemoveWorktreeResult & { warning?: string }> {
  if (!runtime.store) {
    throw new Error('runtime_unavailable')
  }
  const store = runtime.store as any
  const cleanupHostId = parseExecutionHostId(hostId)?.id
  const removalTarget = await runtime.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
  const cleanupScopeKey = preservedBranchCleanupScopeKey({
    worktreeId: (removalTarget as any).id,
    hostId: cleanupHostId
  })
  const optionsKey = getRuntimeWorktreeRemovalOptionsKey(force, runHooks, allowUnverifiedPtyStop)
  const inFlightRemoval = runtime.removeManagedWorktreeInFlight.get(cleanupScopeKey)
  if (inFlightRemoval) {
    if ((inFlightRemoval as any).optionsKey === optionsKey) {
      return (inFlightRemoval as any).promise
    }
    throw new Error(`Worktree deletion already in progress: ${(removalTarget as any).id}`)
  }

  // Why: runtime callers can race the same workspace through CLI/mobile
  // retries. Share one destructive operation per host-qualified workspace.
  const removal = (async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
    // Why: CLI, mobile and headless serve delete through here rather than the IPC handler; without
    // this span their freezes are as invisible as desktop deletes were before `worktree.remove`.
    return withWorktreeSpan({ stage: 'remove', path: (removalTarget as any).path }, async () => {
      // Why (STA-4343): a repo id can exist once per host. Honor the caller's
      // host qualifier, and refuse an unqualified delete the runtime cannot
      // pin to one owner rather than deleting a same-id workspace elsewhere.
      const repoOwner = resolveWorktreeRemovalRepoOwner(
        store,
        (removalTarget as any).repoId,
        cleanupHostId
      )
      if (repoOwner.kind === 'ambiguous') {
        throw new Error(
          `Workspace identity is ambiguous across hosts: ${(removalTarget as any).id}. Retry with an explicit host.`
        )
      }
      const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
      // Why (STA-4343): metadata is keyed by the bare id, so purging it unqualified
      // would evict a same-id row owned by another host. A caller that named no host
      // still resolved exactly one repo above, and that repo names the owner.
      const removalHostId = repo ? (cleanupHostId ?? getRepoExecutionHostId(repo)) : cleanupHostId
      if (!repo) {
        const orphanHost = parseExecutionHostId((store as any).getWorktreeMeta((removalTarget as any).id)?.hostId)
        if (cleanupHostId && orphanHost?.id !== cleanupHostId) {
          throw new Error(
            `Workspace identity for ${(removalTarget as any).id} no longer belongs to ${cleanupHostId}. Refresh projects and try again.`
          )
        }
        const sshPtyProvider =
          orphanHost?.kind === 'ssh' ? runtime.getSshProviderFn?.(orphanHost.targetId) : undefined
        const ptyProvider = (sshPtyProvider ?? runtime.getLocalProvider()) as any
        const externalOrphanHost = orphanHost?.kind === 'ssh' || orphanHost?.kind === 'runtime'
        if (ptyProvider) {
          // External host inventories must never sweep a same-id local workspace.
          await killAllProcessesForWorktree((removalTarget as any).id, {
            runtime: runtime as any,
            resolvedWorktreeId: (removalTarget as any).id,
            ...(orphanHost?.kind === 'ssh' ? { resolvedConnectionId: orphanHost.targetId } : {}),
            ...(orphanHost?.kind === 'runtime'
              ? { resolvedRuntimeEnvironmentId: orphanHost.environmentId }
              : {}),
            localProvider: ptyProvider,
            onPtyStopped: runtime.onPtyStopped ?? undefined,
            ...(externalOrphanHost
              ? {
                  includeProviderInventory: orphanHost?.kind === 'ssh' && Boolean(sshPtyProvider),
                  includeLocalRegistry: false
                }
              : {})
          }).catch((error) => {
            console.warn(
              `[worktree-teardown] orphan cleanup failed for ${(removalTarget as any).id}:`,
              error
            )
          })
        }
        // Why: nothing is deleted on disk here, so watchers must be restored — a folder
        // workspace or explorer pane rooted at the same path stays live.
        const orphanFullPath = splitWorktreeId((removalTarget as any).id)?.worktreePath
        const orphanWatcherPath =
          splitWorktreeIdForFilesystem((removalTarget as any).id)?.worktreePath === orphanFullPath
            ? orphanFullPath
            : undefined
        if (orphanWatcherPath) {
          await runtime.acquireFileWatcherRemoval(
            orphanWatcherPath,
            orphanHost?.kind === 'ssh' ? orphanHost.targetId : undefined
          )
            .then((gate: any) => gate.finish(false))
            .catch(() => {})
        }
        await deleteRemoteWorktreeHistory(sshPtyProvider as any, (removalTarget as any).id)
        runtime.clearOptimisticReconcileToken((removalTarget as any).id)
        runtime.removeWorktreeMetadataAndHistory(
          store,
          (removalTarget as any).id,
          cleanupHostId ?? orphanHost?.id
        )
        runtime.preservedBranchCleanupByScope.delete(cleanupScopeKey)
        runtime.invalidateResolvedWorktreeCache()
        runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
        invalidateAuthorizedRootsCache()
        runtime.notifyWorktreesChanged((removalTarget as any).repoId)
        // Why: non-desktop callers must be able to tell "forgotten" from "deleted"; nothing left the disk.
        return {
          warning: `Project ${(removalTarget as any).repoId} is no longer tracked, so ${(removalTarget as any).path} was forgotten without deleting the directory or its Git worktree registration.`
        }
      }
      if (isFolderRepo(repo)) {
        if ((removalTarget as any).id === getRuntimeFolderWorkspaceRootId(repo)) {
          throw new Error(
            'Cannot delete the project root workspace. Remove the folder project instead.'
          )
        }
        // This service runs inside the selected runtime, so runtime-stamped repos use its
        // local PTY namespace; only a direct SSH connection is external from here.
        const folderConnectionId = repo.connectionId?.trim() || null
        const folderSshPtyProvider = folderConnectionId
          ? runtime.getSshProviderFn?.(folderConnectionId)
          : undefined
        const folderPtyProvider = (folderSshPtyProvider ?? runtime.getLocalProvider()) as any
        if (folderPtyProvider) {
          // Why: folder workspace deletion has no Git removal phase where PTYs
          // would otherwise be swept; tear them down before hiding the workspace.
          await killAllProcessesForWorktree((removalTarget as any).id, {
            runtime: runtime as any,
            resolvedWorktreeId: (removalTarget as any).id,
            ...(folderConnectionId ? { resolvedConnectionId: folderConnectionId } : {}),
            localProvider: folderPtyProvider,
            onPtyStopped: runtime.onPtyStopped ?? undefined,
            ...(folderConnectionId
              ? {
                  includeProviderInventory: Boolean(folderSshPtyProvider),
                  includeLocalRegistry: false
                }
              : {})
          }).catch((err) => {
            console.warn(`[worktree-teardown] failed for ${(removalTarget as any).id}:`, err)
          })
        }
        await deleteRemoteWorktreeHistory(folderSshPtyProvider as any, (removalTarget as any).id)
        runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
        runtime.preservedBranchCleanupByScope.delete(cleanupScopeKey)
        runtime.invalidateResolvedWorktreeCache()
        runtime.notifyWorktreesChanged(repo.id)
        return {}
      }
      const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
      const fsProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : null
      const localWorktreeGitOptions = repo.connectionId
        ? {}
        : getLocalProjectWorktreeGitOptions(runtime.requireStore() as any, repo)
      const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
      const registeredWorktrees = repo.connectionId
        ? await (provider as any)!.listWorktrees(repo.path)
        : hasLocalWorktreeGitOptions
          ? await listWorktreesStrict(repo.path, localWorktreeGitOptions)
          : await listWorktreesStrict(repo.path)
      const removedMeta = resolveWorktreeRemovalMetadata(
        store,
        (removalTarget as any).repoId,
        (removalTarget as any).id,
        cleanupHostId ?? getRepoExecutionHostId(repo)
      )
      const removedPushTarget = (removedMeta as any)?.pushTarget ?? (removalTarget as any).pushTarget
      const registeredWorktree = findRegisteredDeletableWorktree(
        repo.path,
        (removalTarget as any).path,
        registeredWorktrees
      )
      if (!registeredWorktree) {
        let canCleanOrphanedDirectory = false
        if (
          canCleanupUnregisteredOrcaWorktreeDirectory({
            meta: removedMeta
          })
        ) {
          if (repo.connectionId) {
            if (!fsProvider) {
              throw new Error('SSH filesystem provider unavailable')
            }
            if (!fsProvider.lstat) {
              throw new Error('SSH filesystem provider lstat unavailable')
            }
            canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
              (removalTarget as any).path,
              repo.path,
              (path: any) => (fsProvider as any).lstat!(path),
              (path: any) => (fsProvider as any).readFile(path)
            )
          } else {
            const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
            canCleanOrphanedDirectory =
              !isDangerousWorktreeRemovalPath((removalTarget as any).path, repo.path) &&
              (await canSafelyRemoveOrphanedWorktreeDirectory(
                toLocalWorktreeRuntimePath((removalTarget as any).path, localWorktreeGitOptions),
                toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
                access.statPath,
                access.readPath
              ))
          }
        }
        if (canCleanOrphanedDirectory) {
          if (!force) {
            throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
          }
          if (repo.connectionId) {
            const removalGate = await runtime.acquireFileWatcherRemoval(
              (removalTarget as any).path,
              repo.connectionId
            )
            let removalCompleted = false
            try {
              await runtime.stopPtysForDestructiveWorktreeRemoval((removalTarget as any).id, {
                connectionId: repo.connectionId,
                allowUnverifiedStop: allowUnverifiedPtyStop
              })
              await (fsProvider as any)!.deletePath((removalTarget as any).path, true)
              removalCompleted = true
            } finally {
              await (removalGate as any).finish(removalCompleted)
            }
            await cleanupUnusedWorktreePushTargetRemoteSsh(
              provider!,
              repo.path,
              (removalTarget as any).id,
              removedPushTarget,
              store
            )
            await deleteRemoteWorktreeHistory(
              runtime.getSshProviderFn?.(repo.connectionId),
              (removalTarget as any).id
            )
          } else {
            const removalGate = await runtime.acquireFileWatcherRemoval((removalTarget as any).path)
            let removalCompleted = false
            try {
              await runtime.stopPtysForDestructiveWorktreeRemoval((removalTarget as any).id, {
                allowUnverifiedStop: allowUnverifiedPtyStop
              })
              await removeLocalWorktreePath((removalTarget as any).path, localWorktreeGitOptions)
              removalCompleted = true
            } finally {
              await (removalGate as any).finish(removalCompleted)
            }
            await cleanupUnusedWorktreePushTargetRemote(
              repo.path,
              (removalTarget as any).id,
              removedPushTarget,
              store,
              localWorktreeGitOptions
            )
          }
          runtime.clearOptimisticReconcileToken((removalTarget as any).id)
          runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
          runtime.preservedBranchCleanupByScope.delete(cleanupScopeKey)
          runtime.invalidateResolvedWorktreeCache()
          runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
          invalidateAuthorizedRootsCache()
          runtime.notifyWorktreesChanged(repo.id)
          return {}
        }
        if (!repo.connectionId) {
          const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
          const runtimeWorktreePath = toLocalWorktreeRuntimePath(
            (removalTarget as any).path,
            localWorktreeGitOptions
          )
          if (
            await canCleanupUnregisteredOrcaLeftoverDirectory({
              meta: removedMeta,
              worktreePath: (removalTarget as any).path,
              runtimeWorktreePath,
              repo,
              runtimeRepoPath: toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
              registeredWorktrees,
              statPath: access.statPath,
              isGitRepository: (path: any) =>
                isLocalRuntimeGitRepository(path, localWorktreeGitOptions)
            })
          ) {
            if (!force) {
              throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
            }
            const removalGate = await runtime.acquireFileWatcherRemoval((removalTarget as any).path)
            let removalCompleted = false
            try {
              await runtime.stopPtysForDestructiveWorktreeRemoval((removalTarget as any).id, {
                allowUnverifiedStop: allowUnverifiedPtyStop
              })
              await removeLocalWorktreePath((removalTarget as any).path, localWorktreeGitOptions)
              removalCompleted = true
            } finally {
              await (removalGate as any).finish(removalCompleted)
            }
            await cleanupUnusedWorktreePushTargetRemote(
              repo.path,
              (removalTarget as any).id,
              removedPushTarget,
              store,
              localWorktreeGitOptions
            )
            runtime.clearOptimisticReconcileToken((removalTarget as any).id)
            runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
            runtime.preservedBranchCleanupByScope.delete(cleanupScopeKey)
            runtime.invalidateResolvedWorktreeCache()
            runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
            invalidateAuthorizedRootsCache()
            runtime.notifyWorktreesChanged(repo.id)
            return {}
          }
        }
        if (
          await isRuntimeWorktreePathMissing(repo, (removalTarget as any).path, localWorktreeGitOptions)
        ) {
          if (!force && !removedMeta) {
            // Why: without persisted metadata, require the renderer recovery
            // path before deleting Orca-only state for an unregistered path.
            throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
          }
          // Why: a manually deleted worktree is already gone from Git and disk.
          // Finish runtime metadata cleanup without requiring force or touching
          // any unregistered path that still exists.
          await (repo.connectionId
            ? cleanupUnusedWorktreePushTargetRemoteSsh(
                provider!,
                repo.path,
                (removalTarget as any).id,
                removedPushTarget,
                store
              )
            : cleanupUnusedWorktreePushTargetRemote(
                repo.path,
                (removalTarget as any).id,
                removedPushTarget,
                store,
                localWorktreeGitOptions
              ))
          if (repo.connectionId) {
            await deleteRemoteWorktreeHistory(
              runtime.getSshProviderFn?.(repo.connectionId),
              (removalTarget as any).id
            )
          }
          runtime.clearOptimisticReconcileToken((removalTarget as any).id)
          runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
          runtime.preservedBranchCleanupByScope.delete(cleanupScopeKey)
          runtime.invalidateResolvedWorktreeCache()
          runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
          invalidateAuthorizedRootsCache()
          runtime.notifyWorktreesChanged(repo.id)
          return {}
        }
        throw new Error(`Refusing to delete unregistered worktree path: ${(removalTarget as any).path}`)
      }
      const canonicalWorktreePath = (registeredWorktree as any).path
      const deleteBranch = (removedMeta as any)?.preserveBranchOnDelete !== true

      // Why: a Git lock must block before archive hooks or linked-path cleanup
      // mutate the workspace; dirty-file force is a separate permission.
      try {
        assertWorktreeUnlockedForRemoval(registeredWorktree)
      } catch (error) {
        throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
      }

      // Why: a prior forced Windows recovery can delete the directory but leave
      // Git's stale registration; recover and verify it before clearing metadata.
      if (
        !repo.connectionId &&
        force === true &&
        process.platform === 'win32' &&
        (isWindowsAbsolutePathLike(canonicalWorktreePath) ||
          !!(localWorktreeGitOptions as any).wslDistro) &&
        removedMeta &&
        (await isRuntimeWorktreePathMissing(repo, canonicalWorktreePath, localWorktreeGitOptions))
      ) {
        const removalResult = await removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
          canonicalWorktreePath,
          repoPath: repo.path,
          localWorktreeGitOptions,
          registeredWorktree,
          deleteBranch
        })
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          (removalTarget as any).id,
          removedPushTarget,
          store,
          localWorktreeGitOptions
        )
        rememberPreservedBranchCleanupTarget(
          runtime,
          (removalTarget as any).id,
          cleanupHostId,
          removalResult,
          (registeredWorktree as any).head,
          removedPushTarget
        )
        runtime.clearOptimisticReconcileToken((removalTarget as any).id)
        runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
        runtime.invalidateResolvedWorktreeCache()
        runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
        invalidateAuthorizedRootsCache()
        runtime.notifyWorktreesChanged(repo.id)
        return removalResult ?? {}
      }
      if (repo.connectionId) {
        const remoteRemoveOptions = !deleteBranch ? { deleteBranch } : {}
        const removalGate = await runtime.acquireFileWatcherRemoval(
          canonicalWorktreePath,
          repo.connectionId
        )
        let rawRemovalResult: RemoveWorktreeResult | undefined
        let removalCompleted = false
        try {
          await runtime.stopPtysForDestructiveWorktreeRemoval((removalTarget as any).id, {
            connectionId: repo.connectionId,
            allowUnverifiedStop: allowUnverifiedPtyStop
          })
          rawRemovalResult = await (Object.keys(remoteRemoveOptions).length > 0
            ? (provider as any)!.removeWorktree(canonicalWorktreePath, force, remoteRemoveOptions)
            : (provider as any)!.removeWorktree(canonicalWorktreePath, force))
          removalCompleted = true
        } finally {
          await (removalGate as any).finish(removalCompleted)
        }
        const removalResult = preserveBranchHeadFallback(
          rawRemovalResult,
          (registeredWorktree as any).head
        )
        await cleanupUnusedWorktreePushTargetRemoteSsh(
          provider!,
          repo.path,
          (removalTarget as any).id,
          removedPushTarget,
          store
        )
        await deleteRemoteWorktreeHistory(
          runtime.getSshProviderFn?.(repo.connectionId),
          (removalTarget as any).id
        )
        rememberPreservedBranchCleanupTarget(
          runtime,
          (removalTarget as any).id,
          cleanupHostId,
          removalResult,
          (registeredWorktree as any).head,
          removedPushTarget
        )
        runtime.clearOptimisticReconcileToken((removalTarget as any).id)
        runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
        runtime.invalidateResolvedWorktreeCache()
        runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
        invalidateAuthorizedRootsCache()
        runtime.notifyWorktreesChanged(repo.id)
        return removalResult ?? {}
      }

      const hooks = getEffectiveHooks(repo)
      let warning: string | undefined
      if ((hooks as any)?.scripts.archive && runHooks) {
        const result = await runHook(
          'archive',
          canonicalWorktreePath,
          repo,
          undefined,
          hasLocalWorktreeGitOptions ? localWorktreeGitOptions : undefined
        )
        if (!(result as any).success) {
          console.error(
            `[hooks] archive hook failed for ${canonicalWorktreePath}:`,
            (result as any).output
          )
        }
      } else if ((hooks as any)?.scripts.archive) {
        // Runtime RPC calls have no renderer trust prompt, so hooks require explicit CLI opt-in.
        warning = `orca.yaml archive hook skipped for ${canonicalWorktreePath}; pass --run-hooks to run it.`
        console.warn(`[hooks] ${warning}`)
      }

      const refreshedWorktrees = hasLocalWorktreeGitOptions
        ? await listWorktreesStrict(repo.path, localWorktreeGitOptions)
        : await listWorktreesStrict(repo.path)
      const refreshedRegisteredWorktree = findRegisteredDeletableWorktree(
        repo.path,
        canonicalWorktreePath,
        refreshedWorktrees
      )
      if (!refreshedRegisteredWorktree) {
        throw new Error(
          `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
        )
      }
      try {
        // Why: an archive hook can race another Git client that locks the row;
        // recheck before linked-path, watcher, or terminal teardown side effects.
        assertWorktreeUnlockedForRemoval(refreshedRegisteredWorktree)
      } catch (error) {
        throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
      }

      // Why: `orca.yaml` shared directories are symlinked in too, and a
      // directory-only ignore rule leaves those links untracked, so removal must
      // tolerate and unlink them exactly like the per-user shared paths.
      const linkedPaths = getWorktreeSharedLinkPaths(repo)
      const ignoredLinkedPaths = force
        ? []
        : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths)
      try {
        await (hasLocalWorktreeGitOptions
          ? assertWorktreeCleanForRemoval(canonicalWorktreePath, force, {
              ...localWorktreeGitOptions,
              ...(ignoredLinkedPaths.length > 0
                ? { ignoredUntrackedPaths: ignoredLinkedPaths }
                : {})
            })
          : ignoredLinkedPaths.length > 0
            ? assertWorktreeCleanForRemoval(canonicalWorktreePath, force, {
                ignoredUntrackedPaths: ignoredLinkedPaths
              })
            : assertWorktreeCleanForRemoval(canonicalWorktreePath, force))
      } catch (error) {
        if (!isOrphanCompatiblePreflightError(error)) {
          throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
        }
        // Why: Git can still classify this as an orphan after preflight;
        // retain strict PTY teardown before any recursive fallback deletion.
      }

      let removalResult: RemoveWorktreeResult | undefined
      const removalGate = await runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
      let removalCompleted = false
      try {
        // Why: linked-path deletion is destructive too; PTYs must release every
        // handle before Windows or WSL filesystem cleanup starts.
        await runtime.stopPtysForDestructiveWorktreeRemoval((removalTarget as any).id, {
          allowUnverifiedStop: allowUnverifiedPtyStop
        })

        if (linkedPaths.length > 0) {
          await removeWorktreeLinkedPaths(canonicalWorktreePath, linkedPaths)
        }

        try {
          const removeOptions = {
            ...(!deleteBranch ? { deleteBranch } : {}),
            // Why: removal already validated the Git row under the selected
            // project runtime; keep branch cleanup on that same canonical row.
            knownRemovedWorktree: refreshedRegisteredWorktree,
            ...localWorktreeGitOptions
          }
          removalResult = preserveBranchHeadFallback(
            await removeWorktree(repo.path, canonicalWorktreePath, force, removeOptions),
            (refreshedRegisteredWorktree as any).head
          )
        } catch (error) {
          // Why: Git for Windows can deregister a clean worktree before its
          // recursive filesystem deletion fails transiently.
          const recoveredRemovalResult = await recoverLocalWindowsWorktreeRemoval({
            error,
            force,
            canonicalWorktreePath,
            repoPath: repo.path,
            localWorktreeGitOptions,
            registeredWorktree: refreshedRegisteredWorktree,
            deleteBranch,
            closeWatcher: (worktreePath: any) => runtime.closeFileWatchersForRemoval(worktreePath)
          })
          if (recoveredRemovalResult) {
            removalResult = recoveredRemovalResult
            removalCompleted = true
          } else if (isOrphanedWorktreeError(error)) {
            const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
            if (
              await canSafelyRemoveOrphanedWorktreeDirectory(
                toLocalWorktreeRuntimePath(canonicalWorktreePath, localWorktreeGitOptions),
                toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
                access.statPath,
                access.readPath
              )
            ) {
              await runtime.closeFileWatchersForRemoval(canonicalWorktreePath)
              await removeLocalWorktreePath(canonicalWorktreePath, localWorktreeGitOptions).catch(
                () => {}
              )
            } else {
              console.warn(
                `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${canonicalWorktreePath}`
              )
            }
            // Why: `git worktree remove` failed, so git's internal worktree tracking
            // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
            // list` continues to show the stale entry and the branch it had checked out
            // remains locked — other worktrees cannot check it out.
            await gitExecFileAsync(['worktree', 'prune'], {
              cwd: repo.path,
              ...localWorktreeGitOptions
            }).catch(() => {})
            await cleanupUnusedWorktreePushTargetRemote(
              repo.path,
              (removalTarget as any).id,
              removedPushTarget,
              store,
              localWorktreeGitOptions
            )
            runtime.clearOptimisticReconcileToken((removalTarget as any).id)
            runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
            runtime.preservedBranchCleanupByScope.delete(cleanupScopeKey)
            runtime.invalidateResolvedWorktreeCache()
            runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
            invalidateAuthorizedRootsCache()
            runtime.notifyWorktreesChanged(repo.id)
            removalCompleted = true
            return {
              // eslint-disable-next-line unicorn/no-useless-spread -- Why: conditional property inclusion pattern
              ...(warning ? { warning } : {})
            }
          } else {
            throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
          }
        }
        removalCompleted = true
      } finally {
        await (removalGate as any).finish(removalCompleted)
      }

      await cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        (removalTarget as any).id,
        removedPushTarget,
        store,
        localWorktreeGitOptions
      )
      rememberPreservedBranchCleanupTarget(
        runtime,
        (removalTarget as any).id,
        cleanupHostId,
        removalResult,
        (refreshedRegisteredWorktree as any).head,
        removedPushTarget
      )
      runtime.clearOptimisticReconcileToken((removalTarget as any).id)
      runtime.removeWorktreeMetadataAndHistory(store, (removalTarget as any).id, removalHostId)
      runtime.invalidateResolvedWorktreeCache()
      runtime.invalidateWorktreeScanCacheForRepo((removalTarget as any).repoId)
      invalidateAuthorizedRootsCache()
      runtime.notifyWorktreesChanged(repo.id)
      return {
        ...removalResult,
        // eslint-disable-next-line unicorn/no-useless-spread -- Why: conditional property inclusion pattern
        ...(warning ? { warning } : {})
      }
    })
  })()
  runtime.removeManagedWorktreeInFlight.set(cleanupScopeKey, { optionsKey, promise: removal })
  try {
    const result = await removal
    runtime.emitWorktreeLifecycle({
      kind: 'removed',
      worktreeId: (removalTarget as any).id,
      path: (removalTarget as any).path
    })
    return result
  } finally {
    if ((runtime.removeManagedWorktreeInFlight.get(cleanupScopeKey) as any)?.promise === removal) {
      runtime.removeManagedWorktreeInFlight.delete(cleanupScopeKey)
    }
  }
}
