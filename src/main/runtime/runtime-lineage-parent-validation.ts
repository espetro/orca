import { sharesResolvedWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'
import {
  RuntimeLineageError,
  type ResolvedWorktreeSnapshot,
  type RuntimeStore
} from './runtime-contracts'
import type { ResolvedWorktree } from './runtime-contracts'

export function validateLineageParent(
  deps: {
    resolvedWorktreeCache: { peekSnapshot(): ResolvedWorktreeSnapshot | null }
    store?: Pick<RuntimeStore, 'getWorktreeLineage'> | null
  },
  child: ResolvedWorktree,
  parent: ResolvedWorktree
): void {
  const childWorktreeId = child.id
  const parentWorktreeId = parent.id
  if (childWorktreeId === parentWorktreeId) {
    throw new RuntimeLineageError('LINEAGE_PARENT_CYCLE', 'A worktree cannot parent itself.')
  }
  if (!sharesResolvedWorktreeLineageBoundary(child, parent)) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_CONTEXT_CONFLICT',
      'Parent worktree must belong to the same repository, execution host, and project.'
    )
  }
  const instanceByWorktreeId = new Map(
    deps.resolvedWorktreeCache
      .peekSnapshot()
      ?.worktrees.map((worktree) => [worktree.id, worktree.instanceId]) ?? [
      [child.id, child.instanceId],
      [parent.id, parent.instanceId]
    ]
  )
  let cursor: string | undefined = parentWorktreeId
  const visited = new Set<string>([childWorktreeId])
  while (cursor) {
    if (visited.has(cursor)) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CYCLE',
        'Parent selector would create a lineage cycle.'
      )
    }
    visited.add(cursor)
    const lineage = deps.store?.getWorktreeLineage?.(cursor)
    if (!lineage) {
      break
    }
    const cursorInstanceId = instanceByWorktreeId.get(cursor)
    const parentInstanceId = instanceByWorktreeId.get(lineage.parentWorktreeId)
    if (
      cursorInstanceId !== lineage.worktreeInstanceId ||
      parentInstanceId !== lineage.parentWorktreeInstanceId
    ) {
      break
    }
    cursor = lineage.parentWorktreeId
  }
}
