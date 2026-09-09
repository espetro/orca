import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

/**
 * Why: when a paired web client reconnects with empty localStorage it must
 * not stare at a blank UI. The host has richer state — the device's per-worktree
 * tab selections, the workspace's recency map, and the persisted tab inventory —
 * so it advertises a best-guess worktree for the client to land on. The selection
 * is wire-additive (optional `preferredActiveWorktreeId` on `RuntimeStatus`); old
 * clients ignore unknown keys via zod `.strip()`.
 *
 * Priority order (deterministic so tests can pin behavior):
 *   1. Paired device's worktree selections, in insertion order. Skip entries
 *      with empty tabs, missing repo, missing worktree meta, or the
 *      floating-terminal host unless it actually holds tabs.
 *   2. `lastVisitedAtByWorktreeId` ordered by descending timestamp, ties
 *      broken lexically by worktree id.
 *   3. `Object.keys(session.tabsByWorktree)` in lex order.
 *   4. `null` when nothing matches.
 *
 * `global-floating-terminal` is the synthetic "floating terminal host"
 * pseudo-worktree, not a real user workspace. It only qualifies when it
 * already holds a tab, so an empty floating host never becomes the landing
 * target.
 */
export type PreferredActiveWorktreeInput = {
  session: WorkspaceSessionState
  reposById: Readonly<Record<string, { id: string; path: string }>>
  worktreeMetaById: Readonly<Record<string, unknown>>
  mobileClientTabSelectionsByDeviceId?: PersistedMobileClientTabSelections
  pairedDeviceId?: string | null
}

export function pickPreferredActiveWorktreeId(input: PreferredActiveWorktreeInput): string | null {
  const { session, reposById, worktreeMetaById } = input
  const deviceSelection =
    input.pairedDeviceId && input.mobileClientTabSelectionsByDeviceId
      ? input.mobileClientTabSelectionsByDeviceId[input.pairedDeviceId]
      : undefined

  if (deviceSelection) {
    for (const worktreeId of Object.keys(deviceSelection)) {
      if (isEligible(worktreeId, session, reposById, worktreeMetaById)) {
        return worktreeId
      }
    }
  }

  const lastVisited = Object.entries(session.lastVisitedAtByWorktreeId ?? {}).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1]
    }
    return a[0].localeCompare(b[0])
  })
  for (const [worktreeId] of lastVisited) {
    if (isEligible(worktreeId, session, reposById, worktreeMetaById)) {
      return worktreeId
    }
  }

  const tabKeys = Object.keys(session.tabsByWorktree).sort((a, b) => a.localeCompare(b))
  for (const worktreeId of tabKeys) {
    if (isEligible(worktreeId, session, reposById, worktreeMetaById)) {
      return worktreeId
    }
  }

  return null
}

function isEligible(
  worktreeId: string,
  session: WorkspaceSessionState,
  reposById: Readonly<Record<string, { id: string; path: string }>>,
  worktreeMetaById: Readonly<Record<string, unknown>>
): boolean {
  const tabs = session.tabsByWorktree[worktreeId] ?? []
  const hasTabs = tabs.length > 0
  // Why: the floating-terminal host is a synthetic pseudo-worktree, not a real
  // workspace, so it cannot belong to a repo or carry a WorktreeMeta. Only
  // admit it when it actually holds tabs — an empty floating host is never
  // a useful landing target.
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return hasTabs
  }
  if (!hasTabs) {
    return false
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  if (!reposById[repoId]) {
    return false
  }
  if (!worktreeMetaById[worktreeId]) {
    return false
  }
  return true
}
