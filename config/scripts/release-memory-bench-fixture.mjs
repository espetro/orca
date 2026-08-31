// Deterministic workspace fixture + store-driven fixture application for the
// release-memory bench: local git repo, N terminal panes via the app runtime
// client surface (window.api + __store), same approach as
// terminal-cold-park-resource-bench.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function git(repoPath, ...args) {
  return execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' })
}

// Local git repo fixture so the app has a real workspace to open terminals in
// (same shape as terminal-cold-park-resource-bench's createLocalRepoFixture).
export function createWorkspaceFixture() {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'orca-release-memory-fx-'))
  const repoPath = path.join(baseDir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '--initial-branch=main')
  git(repoPath, 'config', 'user.email', 'bench@orca.local')
  git(repoPath, 'config', 'user.name', 'Orca Bench')
  writeFileSync(path.join(repoPath, 'README.md'), '# release-memory fixture\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'init', '--no-gpg-sign')
  return { baseDir, repoPath }
}

export async function applyFixture(page, preset, fixture) {
  const registered = await page.evaluate(async (repoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('store-unavailable')
    }
    await store.getState().fetchSettings?.()
    const addResult = await window.api.repos.add({ path: repoPath, kind: 'git' })
    if ('error' in addResult) {
      throw new Error(addResult.error)
    }
    await store.getState().fetchRepos()
    const state = store.getState()
    const repo = state.repos.find((c) => c.path === repoPath) ?? addResult.repo
    await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
    const nextState = store.getState()
    nextState.setActiveView('terminal')
    const worktrees = nextState.worktreesByRepo?.[repo.id] ?? []
    const primary = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0]
    if (!primary) {
      throw new Error('no-worktrees')
    }
    nextState.setActiveWorktree(primary.id, 'local')
    return { repoId: repo.id, worktreeId: primary.id, activeWorktreeId: nextState.activeWorktreeId }
  }, fixture.repoPath)
  const created = await page.evaluate(
    async (config) => {
      const store = window.__store
      if (!store) {
        return { terminals: 0, error: 'store-unavailable' }
      }
      const opened = { terminals: 0 }
      const outcomes = []
      for (let index = 0; index < config.terminalPanes; index += 1) {
        try {
          // Why: local (same-machine) terminals go through the store's
          // openNewTerminalTabInActiveWorkspace → createTab + pty.spawn path;
          // the web-runtime-session bridge targets remote Orca hosts only and
          // fails with "not connected to a remote Orca host" on a fresh
          // profile (no paired runtime environment).
          await store.getState().openNewTerminalTabInActiveWorkspace()
          const state = store.getState()
          const tabs = state.tabsByWorktree?.[config.worktreeId] ?? []
          outcomes.push(`terminal-tabs:${tabs.length}`)
          if (tabs.length > index) {
            opened.terminals += 1
          }
        } catch (error) {
          outcomes.push(`error: ${error?.message ?? String(error)}`)
        }
      }
      return { ...opened, outcomes }
    },
    { terminalPanes: preset.terminalPanes, worktreeId: registered.worktreeId }
  )
  return {
    applied: true,
    terminals: created.terminals,
    editor: preset.editor === true,
    browserTab: preset.browserTab === true,
    outcomes: created.outcomes
  }
}
