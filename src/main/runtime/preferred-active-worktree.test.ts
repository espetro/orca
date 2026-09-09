/**
 * Preferred active worktree selection: when a freshly paired client has empty
 * local state the host advertises a best-guess worktree id. The selection must
 * be deterministic, prefer the paired device's own selection, never silently
 * land on the floating-terminal pseudo-worktree, and fall back gracefully when
 * state is sparse.
 */
import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  pickPreferredActiveWorktreeId,
  type PreferredActiveWorktreeInput
} from './preferred-active-worktree'

const WT_A = 'repo-1::/tmp/wt-a'
const WT_B = 'repo-1::/tmp/wt-b'
const WT_C = 'repo-2::/tmp/wt-c'
const REPO_1 = { id: 'repo-1', path: '/tmp/repo-1' }
const REPO_2 = { id: 'repo-2', path: '/tmp/repo-2' }

function makeSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT_A,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function makeRepos(ids: string[]): Record<string, { id: string; path: string }> {
  const all: Record<string, { id: string; path: string }> = {
    'repo-1': REPO_1,
    'repo-2': REPO_2
  }
  return Object.fromEntries(ids.map((id) => [id, all[id]]))
}

function makeMeta(ids: string[]): Record<string, unknown> {
  return Object.fromEntries(ids.map((id) => [id, { id }]))
}

function tab(worktreeId: string): TerminalTab {
  return {
    id: `${worktreeId}::tab`,
    ptyId: null,
    worktreeId,
    title: `Terminal ${worktreeId}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function pick(
  overrides: Partial<PreferredActiveWorktreeInput> & {
    pairedDeviceId?: string | null
    reposById?: Record<string, { id: string; path: string }>
    worktreeMetaById?: Record<string, unknown>
  } = {}
): string | null {
  const reposById = overrides.reposById ?? makeRepos(['repo-1', 'repo-2'])
  const worktreeMetaById = overrides.worktreeMetaById ?? makeMeta([WT_A, WT_B, WT_C])
  return pickPreferredActiveWorktreeId({
    session: overrides.session ?? makeSession(),
    reposById,
    worktreeMetaById,
    ...(overrides.mobileClientTabSelectionsByDeviceId !== undefined
      ? { mobileClientTabSelectionsByDeviceId: overrides.mobileClientTabSelectionsByDeviceId }
      : {}),
    ...(overrides.pairedDeviceId !== undefined ? { pairedDeviceId: overrides.pairedDeviceId } : {})
  })
}

describe('pickPreferredActiveWorktreeId', () => {
  it('device selection beats fallback even when lastVisited is newer', () => {
    const result = pick({
      pairedDeviceId: 'device-1',
      session: makeSession({
        tabsByWorktree: { [WT_A]: [tab(WT_A)], [WT_B]: [tab(WT_B)] },
        lastVisitedAtByWorktreeId: { [WT_B]: 100, [WT_A]: 50 }
      }),
      mobileClientTabSelectionsByDeviceId: {
        'device-1': { [WT_A]: { activeTabId: 't', activeGroupId: null, activeTabIdByGroupId: {} } }
      }
    })
    expect(result).toBe(WT_A)
  })

  it('device selection skips empty worktrees and falls back to lastVisited', () => {
    const result = pick({
      pairedDeviceId: 'device-1',
      session: makeSession({
        tabsByWorktree: { [WT_A]: [], [WT_B]: [tab(WT_B)] },
        lastVisitedAtByWorktreeId: { [WT_B]: 100, [WT_A]: 50 }
      }),
      mobileClientTabSelectionsByDeviceId: {
        'device-1': { [WT_A]: { activeTabId: 't', activeGroupId: null, activeTabIdByGroupId: {} } }
      }
    })
    expect(result).toBe(WT_B)
  })

  it('device selection skips worktrees whose repo is missing', () => {
    const result = pick({
      pairedDeviceId: 'device-1',
      reposById: makeRepos(['repo-1']),
      session: makeSession({
        tabsByWorktree: { [WT_A]: [tab(WT_A)], [WT_C]: [tab(WT_C)] },
        lastVisitedAtByWorktreeId: { [WT_C]: 100 }
      }),
      worktreeMetaById: makeMeta([WT_A, WT_C]),
      mobileClientTabSelectionsByDeviceId: {
        'device-1': { [WT_C]: { activeTabId: 't', activeGroupId: null, activeTabIdByGroupId: {} } }
      }
    })
    expect(result).toBe(WT_A)
  })

  it('device selection skips worktrees missing worktreeMeta', () => {
    const result = pick({
      pairedDeviceId: 'device-1',
      session: makeSession({
        tabsByWorktree: { [WT_A]: [tab(WT_A)], [WT_B]: [tab(WT_B)] },
        lastVisitedAtByWorktreeId: { [WT_B]: 100 }
      }),
      worktreeMetaById: makeMeta([WT_A]),
      mobileClientTabSelectionsByDeviceId: {
        'device-1': { [WT_B]: { activeTabId: 't', activeGroupId: null, activeTabIdByGroupId: {} } }
      }
    })
    expect(result).toBe(WT_A)
  })

  it('skips floating-terminal host when it has no tabs even if device picked it', () => {
    const result = pick({
      pairedDeviceId: 'device-1',
      session: makeSession({
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [],
          [WT_A]: [tab(WT_A)]
        },
        lastVisitedAtByWorktreeId: { [FLOATING_TERMINAL_WORKTREE_ID]: 999 }
      }),
      worktreeMetaById: makeMeta([WT_A, FLOATING_TERMINAL_WORKTREE_ID]),
      mobileClientTabSelectionsByDeviceId: {
        'device-1': {
          [FLOATING_TERMINAL_WORKTREE_ID]: {
            activeTabId: 't',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      }
    })
    expect(result).toBe(WT_A)
    expect(result).not.toBe(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('accepts floating-terminal host when it actually holds tabs', () => {
    const result = pick({
      pairedDeviceId: 'device-1',
      session: makeSession({
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [tab(FLOATING_TERMINAL_WORKTREE_ID)]
        }
      }),
      mobileClientTabSelectionsByDeviceId: {
        'device-1': {
          [FLOATING_TERMINAL_WORKTREE_ID]: {
            activeTabId: 'float-tab',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      }
    })
    expect(result).toBe(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('lastVisitedAtByWorktreeId is the fallback when no device selection exists', () => {
    const result = pick({
      session: makeSession({
        tabsByWorktree: { [WT_A]: [tab(WT_A)], [WT_B]: [tab(WT_B)] },
        lastVisitedAtByWorktreeId: { [WT_A]: 10, [WT_B]: 99 }
      })
    })
    expect(result).toBe(WT_B)
  })

  it('breaks lastVisited ties by lex order of worktree id', () => {
    const result = pick({
      session: makeSession({
        tabsByWorktree: { [WT_A]: [tab(WT_A)], [WT_B]: [tab(WT_B)] },
        lastVisitedAtByWorktreeId: { [WT_A]: 50, [WT_B]: 50 }
      })
    })
    expect(result).toBe(WT_A)
  })

  it('lastVisited fallback skips repo-less and meta-less entries', () => {
    const result = pick({
      reposById: makeRepos(['repo-1']),
      worktreeMetaById: makeMeta([WT_A, WT_B]),
      session: makeSession({
        tabsByWorktree: { [WT_A]: [tab(WT_A)], [WT_B]: [tab(WT_B)], [WT_C]: [tab(WT_C)] },
        lastVisitedAtByWorktreeId: { [WT_C]: 200, [WT_A]: 100, [WT_B]: 50 }
      })
    })
    expect(result).toBe(WT_A)
  })

  it('walks tabsByWorktree lex order when lastVisited is missing', () => {
    const result = pick({
      session: makeSession({
        tabsByWorktree: { [WT_B]: [tab(WT_B)], [WT_A]: [tab(WT_A)] }
      })
    })
    expect(result).toBe(WT_A)
  })

  it('returns null when there are no candidates anywhere', () => {
    const result = pick({
      session: makeSession({
        tabsByWorktree: {},
        lastVisitedAtByWorktreeId: { [WT_A]: 100 }
      })
    })
    expect(result).toBeNull()
  })

  it('never trusts activeWorktreeId set to global-floating-terminal with empty tabs', () => {
    const result = pick({
      session: makeSession({
        activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [] }
      })
    })
    expect(result).toBeNull()
  })
})
