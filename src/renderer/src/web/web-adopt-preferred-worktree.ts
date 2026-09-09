// Why: a freshly paired web client with empty localStorage needs the server's
// published `preferredActiveWorktreeId` to seed `activeWorktreeId`/`activeRepoId`
// so the user lands in the worktree the server already considers active instead
// of an empty workspace. Electron reads its local store directly and never runs
// this path, so any populated local session wins and is never overridden.
import type { AppState } from '../store/types'

export type AdoptPreferredWorktreeDecision =
  | {
      adopt: false
      reason:
        | 'local-selection-present'
        | 'worktree-not-hydrated'
        | 'repo-not-hydrated'
        | 'worktree-id-missing'
    }
  | { adopt: true; worktreeId: string; repoId: string }

export function decideAdoptPreferredWorktree(
  state: AppState,
  preferredActiveWorktreeId: string | null | undefined
): AdoptPreferredWorktreeDecision {
  if (!preferredActiveWorktreeId) {
    return { adopt: false, reason: 'worktree-id-missing' }
  }
  if (state.activeWorktreeId || state.activeRepoId) {
    return { adopt: false, reason: 'local-selection-present' }
  }
  // Why: insertion order over `Object.values` is JS-engine order for string
  // keys, which matches the order repos were registered locally. Server-side
  // priority (`device row` > recency > lex) already happened in
  // `preferred-active-worktree.ts`; here we resolve the id against hydrated state.
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const found = worktrees.find((worktree) => worktree.id === preferredActiveWorktreeId)
    if (!found) {
      continue
    }
    const repo = state.repos.find((r) => r.id === found.repoId)
    if (!repo) {
      return { adopt: false, reason: 'repo-not-hydrated' }
    }
    return { adopt: true, worktreeId: found.id, repoId: found.repoId }
  }
  return { adopt: false, reason: 'worktree-not-hydrated' }
}

export function applyAdoptedPreferredWorktree(
  set: (fn: (state: AppState) => Partial<AppState>) => void,
  decision: Extract<AdoptPreferredWorktreeDecision, { adopt: true }>
): void {
  // Why: writing both fields together avoids a transient state where the
  // active repo and active worktree disagree, which the workspace router
  // treats as a cross-scope navigation.
  set(() => ({
    activeWorktreeId: decision.worktreeId,
    activeRepoId: decision.repoId
  }))
}
