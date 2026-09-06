import { existsSync } from 'node:fs'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { moveWorktree } from '../git/worktree'
import { maybeAutoRenameBranchOnFirstWork } from './first-work-branch-rename'
import { rememberBranchRenameFailureOutput } from './branch-rename-failure-output'
import { renameWorktreeFolderOnFirstWork } from './first-work-folder-rename'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type FirstWorkRenameHookDeps = {
  getStore: () => Store | null
  getRuntime: () => OrcaRuntimeService | null
}

export function createFirstWorkRenameHookAdapter(deps: FirstWorkRenameHookDeps) {
  // Kill switch for the first-work on-disk folder rename; the renderer reconciles the id change (migrateWorktreeIdentity) so it isn't mistaken for a deletion.
  const ENABLE_FIRST_WORK_FOLDER_RENAME = false

  // Why: inject the index.ts store/runtime singletons so the rename orchestrator stays module-state-free and unit-testable.
  return function maybeAutoRenameBranchOnFirstWorkFromHook(event: {
    paneKey: string
    tabId: string | undefined
    worktreeId: string | undefined
    payload: { state: string; prompt?: string; lastAssistantMessage?: string }
    isReplay: boolean | undefined
  }): void {
    const currentStore = deps.getStore()
    const currentRuntime = deps.getRuntime()
    if (!currentStore || !currentRuntime) {
      return
    }
    void maybeAutoRenameBranchOnFirstWork(
      {
        paneKey: event.paneKey,
        tabId: event.tabId,
        worktreeId: event.worktreeId,
        state: event.payload.state,
        prompt: event.payload.prompt,
        assistantMessage: event.payload.lastAssistantMessage,
        isReplay: event.isReplay
      },
      {
        getSettings: () => currentStore.getSettings(),
        getRepo: (repoId) => currentStore.getRepo(repoId),
        getAgentEnvResolvers: () => currentRuntime.getCommitMessageAgentEnvironmentResolvers(),
        getCurrentDisplayName: (worktreeId) => {
          const scope = parseWorkspaceKey(worktreeId)
          if (scope?.type === 'folder') {
            return currentStore.getFolderWorkspace(scope.folderWorkspaceId)?.name
          }
          return currentStore.getWorktreeMeta(worktreeId)?.displayName
        },
        getFolderWorkspacePath: (worktreeId) => {
          const scope = parseWorkspaceKey(worktreeId)
          return scope?.type === 'folder'
            ? currentStore.getFolderWorkspace(scope.folderWorkspaceId)?.folderPath
            : undefined
        },
        isPendingFirstAgentMessageRename: (worktreeId) => {
          const scope = parseWorkspaceKey(worktreeId)
          if (scope?.type === 'folder') {
            return (
              currentStore.getFolderWorkspace(scope.folderWorkspaceId)
                ?.pendingFirstAgentMessageRename === true
            )
          }
          return currentStore.getWorktreeMeta(worktreeId)?.pendingFirstAgentMessageRename === true
        },
        canRenameOrcaCreatedBranch: (worktreeId) => {
          const meta = currentStore.getWorktreeMeta(worktreeId)
          // Why: a user branch could coincidentally match a creature name; only Orca-stamped worktrees are safe to auto-rename.
          return !!meta?.orcaCreationSource && meta.preserveBranchOnDelete !== true
        },
        setDisplayName: (worktreeId, displayName) => {
          rememberBranchRenameFailureOutput(worktreeId, null)
          const scope = parseWorkspaceKey(worktreeId)
          if (scope?.type === 'folder') {
            currentStore.updateFolderWorkspace(scope.folderWorkspaceId, {
              name: displayName,
              pendingFirstAgentMessageRename: false,
              firstAgentMessageRenameError: null
            })
            currentRuntime.notifyFolderWorkspaceChanged()
            return
          }
          currentStore.setWorktreeMeta(worktreeId, {
            displayName,
            pendingFirstAgentMessageRename: false,
            // Success clears the failure badge (redundant with the explicit setRenameError(null)).
            firstAgentMessageRenameError: null
          })
        },
        renameWorktreeFolder: ENABLE_FIRST_WORK_FOLDER_RENAME
          ? (worktreeId, newLeaf) =>
              renameWorktreeFolderOnFirstWork(worktreeId, newLeaf, {
                getRepo: (repoId) => currentStore.getRepo(repoId),
                getSettings: () => currentStore.getSettings(),
                migrateWorktreeIdentity: (oldId, newId) =>
                  currentStore.migrateWorktreeIdentity(oldId, newId),
                notifyWorktreeRenamed: (repoId, oldId, newId) =>
                  currentRuntime.notifyWorktreeFolderRenamed(repoId, oldId, newId),
                pathExists: async (candidate) => existsSync(candidate),
                moveWorktree
              })
          : undefined,
        setRenameError: (worktreeId, error, failureOutput) => {
          // Refresh the full-output capture before the dedupe below — a repeat error string is still a fresh run.
          rememberBranchRenameFailureOutput(worktreeId, error === null ? null : failureOutput)
          // Skip the write + push when unchanged — most settled worktrees never had an error to clear.
          const scope = parseWorkspaceKey(worktreeId)
          if (scope?.type === 'folder') {
            const current = currentStore.getFolderWorkspace(
              scope.folderWorkspaceId
            )?.firstAgentMessageRenameError
            if ((current ?? null) === (error ?? null)) {
              return
            }
            currentStore.updateFolderWorkspace(scope.folderWorkspaceId, {
              firstAgentMessageRenameError: error
            })
            currentRuntime.notifyFolderWorkspaceChanged()
            return
          }
          const current = currentStore.getWorktreeMeta(worktreeId)?.firstAgentMessageRenameError
          if ((current ?? null) === (error ?? null)) {
            return
          }
          currentStore.setWorktreeMeta(worktreeId, { firstAgentMessageRenameError: error })
          // Why: the hook only knows the worktreeId, so derive the repoId notifyBranchRenamed expects.
          currentRuntime.notifyBranchRenamed(getRepoIdFromWorktreeId(worktreeId))
        },
        resolveWorktreeIdForTab: (tabId) => currentStore.getWorktreeIdForTab(tabId),
        onRenamed: (repoIdOrWorktreeId) => {
          if (parseWorkspaceKey(repoIdOrWorktreeId)?.type === 'folder') {
            currentRuntime.notifyFolderWorkspaceChanged()
            return
          }
          currentRuntime.notifyBranchRenamed(repoIdOrWorktreeId)
        }
      }
    )
  }
}
