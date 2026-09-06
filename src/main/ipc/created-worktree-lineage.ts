import type { CreateWorktreeArgs, CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Store } from '../persistence'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { sharesWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'

export type CreatedWorktreeLineageRecords = {
  lineage: CreateWorktreeResult['lineage']
  workspaceLineage: CreateWorktreeResult['workspaceLineage']
}

const NO_CREATED_WORKTREE_LINEAGE: CreatedWorktreeLineageRecords = {
  lineage: null,
  workspaceLineage: null
}

/** Why not throw on a missing parent: nesting is optional decoration, and the pick can go stale
 *  between the composer and the create. A malformed or self-referential key is a bad request and
 *  still fails; a parent that simply disappeared degrades to an unattached workspace, matching the
 *  runtime path and `recordWorkspaceLineageForCreatedWorktree`. */
export function assertAttachableParentWorkspace(
  store: Store,
  parentWorkspace: CreateWorktreeArgs['parentWorkspace'],
  childWorkspaceKey: ReturnType<typeof worktreeWorkspaceKey>
): void {
  if (!parentWorkspace) {
    return
  }
  if (parentWorkspace === childWorkspaceKey) {
    throw new Error('A worktree cannot be attached to itself.')
  }
  const parentScope = parseWorkspaceKey(parentWorkspace)
  if (!parentScope) {
    throw new Error(`Invalid parent workspace: ${parentWorkspace}`)
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    console.warn(`[worktree-create] parent folder workspace not found: ${parentWorkspace}`)
    return
  }
  if (parentScope.type === 'worktree' && !store.getWorktreeMeta(parentScope.worktreeId)) {
    console.warn(`[worktree-create] parent worktree workspace not found: ${parentWorkspace}`)
  }
}

/** Mirrors the projection's edge rule so we never persist a row the sidebar would silently drop.
 *  WorktreeMeta has no repoId, so the parent's comes from its `<repoId>::<path>` id. */
function createdWorktreeSharesParentLineageBoundary(
  worktree: Worktree,
  parentWorktreeId: string,
  parentMeta: WorktreeMeta
): boolean {
  return sharesWorktreeLineageBoundary(worktree, {
    repoId: getRepoIdFromWorktreeId(parentWorktreeId),
    hostId: parentMeta.hostId,
    projectId: parentMeta.projectId
  })
}

export function recordWorkspaceLineageForCreatedWorktree(
  store: Store,
  args: CreateWorktreeArgs,
  worktree: Worktree,
  createdAt: number
): CreatedWorktreeLineageRecords {
  if (!args.parentWorkspace || !worktree.instanceId) {
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const childWorkspaceKey = worktreeWorkspaceKey(worktree.id)
  if (args.parentWorkspace === childWorkspaceKey) {
    console.warn(`[worktree-create] refusing to attach ${worktree.id} to itself`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const parentScope = parseWorkspaceKey(args.parentWorkspace)
  if (!parentScope) {
    console.warn(`[worktree-create] ignoring invalid parent workspace ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    console.warn(`[worktree-create] parent folder workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const parentWorktreeMeta =
    parentScope.type === 'worktree' ? store.getWorktreeMeta(parentScope.worktreeId) : null
  if (parentScope.type === 'worktree' && !parentWorktreeMeta) {
    console.warn(`[worktree-create] parent worktree workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }

  // Why: only a worktree parent produces sidebar nesting; a folder parent has no WorktreeLineage row.
  let lineage: CreateWorktreeResult['lineage'] = null
  let parentOutsideLineageBoundary = false
  if (parentScope.type === 'worktree' && parentWorktreeMeta) {
    if (!parentWorktreeMeta.instanceId) {
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} has no instance identity; skipping lineage`
      )
    } else if (
      !createdWorktreeSharesParentLineageBoundary(
        worktree,
        parentScope.worktreeId,
        parentWorktreeMeta
      )
    ) {
      parentOutsideLineageBoundary = true
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} is outside ${worktree.id}'s repo/host/project boundary; skipping lineage`
      )
    } else {
      lineage = store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: parentScope.worktreeId,
        parentWorktreeInstanceId: parentWorktreeMeta.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt
      })
    }
  }

  // Why: persisting a workspace row for an out-of-boundary worktree parent poisons the whole host —
  // `filterLineageForHost` returns null for any owned row whose child and parent hosts differ, so
  // every nesting on that host stops hydrating, and the row survives restarts.
  if (parentOutsideLineageBoundary) {
    return NO_CREATED_WORKTREE_LINEAGE
  }

  const workspaceLineage = store.setWorkspaceLineage({
    childWorkspaceKey,
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: args.parentWorkspace,
    parentInstanceId: parentWorktreeMeta?.instanceId ?? null,
    origin: 'manual',
    capture: {
      source: parentScope.type === 'worktree' ? 'manual-action' : 'active-workspace',
      confidence: 'explicit'
    },
    createdAt
  })
  return { lineage, workspaceLineage }
}
