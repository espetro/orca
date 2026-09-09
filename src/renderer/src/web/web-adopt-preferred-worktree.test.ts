import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  applyAdoptedPreferredWorktree,
  decideAdoptPreferredWorktree
} from './web-adopt-preferred-worktree'

function makeRepo(id: string): Repo {
  return { id } as unknown as Repo
}

function makeWorktree(id: string, repoId: string): Worktree {
  return { id, repoId } as unknown as Worktree
}

type MinimalAppState = Pick<
  AppState,
  'repos' | 'worktreesByRepo' | 'activeWorktreeId' | 'activeRepoId'
>

function makeState(partial: Partial<MinimalAppState> = {}): AppState {
  const state: MinimalAppState = {
    repos: [],
    worktreesByRepo: {},
    activeWorktreeId: null,
    activeRepoId: null,
    ...partial
  }
  return state as unknown as AppState
}

describe('decideAdoptPreferredWorktree', () => {
  it('rejects when preferredActiveWorktreeId is null', () => {
    expect(decideAdoptPreferredWorktree(makeState(), null)).toEqual({
      adopt: false,
      reason: 'worktree-id-missing'
    })
  })

  it('rejects when preferredActiveWorktreeId is undefined', () => {
    expect(decideAdoptPreferredWorktree(makeState(), undefined)).toEqual({
      adopt: false,
      reason: 'worktree-id-missing'
    })
  })

  it('rejects when local activeWorktreeId is set even if preferred matches', () => {
    const repo = makeRepo('repo-1')
    const worktree = makeWorktree('wt-1', 'repo-1')
    const state = makeState({
      activeWorktreeId: 'wt-1',
      activeRepoId: 'repo-1',
      repos: [repo],
      worktreesByRepo: { 'repo-1': [worktree] }
    })
    expect(decideAdoptPreferredWorktree(state, 'wt-1')).toEqual({
      adopt: false,
      reason: 'local-selection-present'
    })
  })

  it('rejects when local activeRepoId is set but activeWorktreeId is null', () => {
    const state = makeState({ activeRepoId: 'repo-1' })
    expect(decideAdoptPreferredWorktree(state, 'wt-1')).toEqual({
      adopt: false,
      reason: 'local-selection-present'
    })
  })

  it('rejects when preferred worktree is not yet hydrated into worktreesByRepo', () => {
    const state = makeState({
      repos: [makeRepo('repo-1')],
      worktreesByRepo: { 'repo-1': [makeWorktree('wt-other', 'repo-1')] }
    })
    expect(decideAdoptPreferredWorktree(state, 'wt-missing')).toEqual({
      adopt: false,
      reason: 'worktree-not-hydrated'
    })
  })

  it('rejects when the worktree exists but its repo is not hydrated', () => {
    const worktree = makeWorktree('wt-x', 'repo-x')
    const state = makeState({
      repos: [makeRepo('repo-other')],
      worktreesByRepo: { 'repo-x': [worktree] }
    })
    expect(decideAdoptPreferredWorktree(state, 'wt-x')).toEqual({
      adopt: false,
      reason: 'repo-not-hydrated'
    })
  })

  it('adopts when both worktree and repo are hydrated', () => {
    const repo = makeRepo('repo-x')
    const worktree = makeWorktree('wt-x', 'repo-x')
    const state = makeState({
      repos: [repo, makeRepo('repo-y')],
      worktreesByRepo: {
        'repo-y': [makeWorktree('wt-y', 'repo-y')],
        'repo-x': [worktree, makeWorktree('wt-x-2', 'repo-x')]
      }
    })
    expect(decideAdoptPreferredWorktree(state, 'wt-x')).toEqual({
      adopt: true,
      worktreeId: 'wt-x',
      repoId: 'repo-x'
    })
  })
})

describe('applyAdoptedPreferredWorktree', () => {
  it('writes activeWorktreeId and activeRepoId through the supplied setter', () => {
    const set = vi.fn()
    applyAdoptedPreferredWorktree(set, { adopt: true, worktreeId: 'wt-x', repoId: 'repo-x' })
    expect(set).toHaveBeenCalledTimes(1)
    const updater = set.mock.calls[0]![0] as (state: AppState) => Partial<AppState>
    const patch = updater({} as AppState)
    expect(patch).toEqual({ activeWorktreeId: 'wt-x', activeRepoId: 'repo-x' })
  })
})
