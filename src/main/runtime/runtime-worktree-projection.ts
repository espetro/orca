/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */
// Pure terminal tail projection: ANSI-normalized tail buffers, wait-state
// detection, restored-tail seeding, and worktree/agent title classification.
// Zero runtime state — every function here is a pure transform over its args.
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import type {
  RuntimeWorktreePsSummary,
  RuntimeWorktreeStatus
} from '../../shared/runtime-types'
import {
  isPathInsideOrEqual,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { worktreeIdComparisonKey, splitWorktreeId } from '../../shared/worktree/id'
import { makePaneKey } from '../../shared/stable-pane-id'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import { worktreePathComparisonKey } from '../ipc/worktree-path-comparison'
import { getDetectedWorktreeStatus, getLatestAgentCandidateTitle } from './runtime-agent-title-projection'
import type { ResolvedWorktree, RuntimeLeafRecord } from './runtime-tail-shared'


function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

export function branchSelectorMatches(branch: string, selector: string): boolean {
  // Why: Git can report a local branch as `refs/heads/foo` or `foo` depending on the plumbing path; accept either.
  return normalizeLocalBranchName(branch) === normalizeLocalBranchName(selector)
}

export function runtimePathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

/**
 * Why: runtime identity is per *workspace*, not per checkout dir. Folder projects back
 * several independent workspaces with one directory, separated only by the
 * `::workspace:<uuid>` suffix that filesystem callers must strip; stripping it here
 * instead lets one session steal a sibling's PTYs. Normalize only path spelling, so
 * Windows/WSL/SSH ids still match themselves across hosts.
 */
export function runtimeWorktreeIdsEqual(left: string, right: string): boolean {
  const leftKey = worktreeIdComparisonKey(left)
  return leftKey === null ? left === right : leftKey === worktreeIdComparisonKey(right)
}

export function runtimeWorktreeIdentityKey(worktreeId: string): string {
  // Same suffix rule: this keys PTY refresh, sleep, and mutation-queue state per session.
  const parsed = splitWorktreeId(worktreeId)
  return parsed
    ? `${parsed.repoId}\0${normalizeRuntimePathForComparison(parsed.worktreePath)}`
    : worktreeId
}

function runtimeWorktreeLookupKey(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  return JSON.stringify(
    parsed
      ? ['parsed', parsed.repoId, normalizeRuntimePathForComparison(parsed.worktreePath)]
      : ['raw', worktreeId]
  )
}

export function createIncrementalResolvedWorktreeLookup(
  resolvedWorktrees: ResolvedWorktree[]
): (worktreeId: string) => ResolvedWorktree | undefined {
  const worktreeByIdentity = new Map<string, ResolvedWorktree>()
  let indexedCount = 0
  return (worktreeId) => {
    const lookupKey = runtimeWorktreeLookupKey(worktreeId)
    const indexed = worktreeByIdentity.get(lookupKey)
    if (indexed) {
      return indexed
    }
    while (indexedCount < resolvedWorktrees.length) {
      const worktree = resolvedWorktrees[indexedCount]
      indexedCount += 1
      const key = runtimeWorktreeLookupKey(worktree.id)
      // Why: preserve Array.find's first match when normalized identities collide.
      if (!worktreeByIdentity.has(key)) {
        worktreeByIdentity.set(key, worktree)
      }
      if (key === lookupKey) {
        return worktreeByIdentity.get(key)
      }
    }
    return undefined
  }
}

export function resolveTerminalSessionWorktreeId(
  session: WorkspaceSessionState,
  targetWorktreeId: string
): string | null {
  const keyedWorktreeIds = new Set([
    ...Object.keys(session.tabsByWorktree),
    ...Object.keys(session.tabGroups ?? {}),
    ...Object.keys(session.tabGroupLayouts ?? {}),
    ...Object.keys(session.activeTabIdByWorktree ?? {}),
    ...Object.keys(session.activeGroupIdByWorktree ?? {})
  ])
  const matches = [...keyedWorktreeIds].filter((worktreeId) =>
    runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId)
  )
  return matches.length > 1 ? null : (matches[0] ?? targetWorktreeId)
}

export function canonicalizeTerminalSessionWorktreeId(
  session: WorkspaceSessionState,
  sourceWorktreeId: string,
  targetWorktreeId: string
): void {
  if (sourceWorktreeId === targetWorktreeId) {
    return
  }
  const tabs = session.tabsByWorktree[sourceWorktreeId] ?? []
  delete session.tabsByWorktree[sourceWorktreeId]
  session.tabsByWorktree[targetWorktreeId] = tabs.map((tab) => ({
    ...tab,
    worktreeId: targetWorktreeId
  }))

  const groups = session.tabGroups?.[sourceWorktreeId]
  if (groups) {
    delete session.tabGroups![sourceWorktreeId]
    session.tabGroups![targetWorktreeId] = groups.map((group) => ({
      ...group,
      worktreeId: targetWorktreeId
    }))
  }
  for (const keyedState of [
    session.tabGroupLayouts,
    session.activeTabIdByWorktree,
    session.activeGroupIdByWorktree
  ]) {
    if (!keyedState || !Object.hasOwn(keyedState, sourceWorktreeId)) {
      continue
    }
    keyedState[targetWorktreeId] = keyedState[sourceWorktreeId] as never
    delete keyedState[sourceWorktreeId]
  }
}

export function inferWorktreeIdFromPtyId(ptyId: string): string | null {
  return parsePtySessionId(ptyId).worktreeId
}

export function indexPersistedPtyWorktreeBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<string, string> {
  const worktreeIdByPtyId = new Map<string, string>()
  const ambiguousPtyIds = new Set<string>()
  const bind = (ptyId: string | null | undefined, worktreeId: string): void => {
    if (!ptyId || ambiguousPtyIds.has(ptyId)) {
      return
    }
    const existingWorktreeId = worktreeIdByPtyId.get(ptyId)
    if (existingWorktreeId && existingWorktreeId !== worktreeId) {
      // Why: a corrupt/stale duplicate binding must not attribute a live PTY to whichever workspace was visited first.
      worktreeIdByPtyId.delete(ptyId)
      ambiguousPtyIds.add(ptyId)
      return
    }
    worktreeIdByPtyId.set(ptyId, worktreeId)
  }

  for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      bind(tab.ptyId, worktreeId)
      bind(session?.remoteSessionIdsByTabId?.[tab.id], worktreeId)
      const layout = session?.terminalLayoutsByTabId[tab.id]
      for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
        bind(ptyId, worktreeId)
      }
    }
  }
  return worktreeIdByPtyId
}

export function indexPersistedPtySurfaceBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<
  string,
  { worktreeId: string; tabId: string; paneKey: string; incarnationId: string }
> {
  const bindingByPtyId = new Map<
    string,
    { worktreeId: string; tabId: string; paneKey: string; incarnationId: string }
  >()
  const ambiguousPtyIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      for (const [leafId, ptyId] of Object.entries(
        session?.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        if (!ptyId || ambiguousPtyIds.has(ptyId)) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        const incarnationId = session?.terminalPtyIncarnationsByPaneKey?.[paneKey]
        if (!incarnationId) {
          continue
        }
        const binding = { worktreeId, tabId: tab.id, paneKey, incarnationId }
        const existing = bindingByPtyId.get(ptyId)
        if (
          existing &&
          (existing.worktreeId !== worktreeId ||
            existing.paneKey !== paneKey ||
            existing.incarnationId !== incarnationId)
        ) {
          bindingByPtyId.delete(ptyId)
          ambiguousPtyIds.add(ptyId)
          continue
        }
        bindingByPtyId.set(ptyId, binding)
      }
    }
  }
  return bindingByPtyId
}

export function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false
    }
  }
  return true
}

export function parseRuntimeWorktreeId(
  worktreeId: string
): { repoId: string; worktreePath: string } | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId) {
    return null
  }
  if (!parsed.worktreePath) {
    return null
  }
  return parsed
}

type RuntimeWorktreeSummaryPathCandidate = {
  summary: RuntimeWorktreePsSummary
  order: number
}

export type RuntimeWorktreeSummaryPathIndex = {
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
  posixAbsolute: Map<string, RuntimeWorktreeSummaryPathCandidate>
  posixRelative: Map<string, RuntimeWorktreeSummaryPathCandidate>
  windows: Map<string, RuntimeWorktreeSummaryPathCandidate>
  windowsAbsolute: Map<string, RuntimeWorktreeSummaryPathCandidate>
}

export function buildRuntimeWorktreeSummaryPathIndex(
  summaries: ReadonlyMap<string, RuntimeWorktreePsSummary>,
  resolvedWorktrees: readonly ResolvedWorktree[],
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
): RuntimeWorktreeSummaryPathIndex {
  const index: RuntimeWorktreeSummaryPathIndex = {
    platformByRepoId,
    posixAbsolute: new Map(),
    posixRelative: new Map(),
    windows: new Map(),
    windowsAbsolute: new Map()
  }
  for (const [order, worktree] of resolvedWorktrees.entries()) {
    const summary = summaries.get(worktree.id)
    if (!summary) {
      continue
    }
    const platform = platformByRepoId.get(worktree.repoId) ?? process.platform
    const candidate = { summary, order }
    if (isPosixAbsoluteRuntimeWorktreePath(worktree.path)) {
      setFirstRuntimeWorktreePathCandidate(
        index.posixAbsolute,
        runtimeWorktreeSummaryPathKey(worktree.repoId, worktree.path, platform),
        candidate
      )
      continue
    }

    const windowsKey = runtimeWorktreeSummaryPathKey(worktree.repoId, worktree.path, 'win32')
    setFirstRuntimeWorktreePathCandidate(index.windows, windowsKey, candidate)
    if (isWindowsAbsolutePathLike(worktree.path)) {
      setFirstRuntimeWorktreePathCandidate(index.windowsAbsolute, windowsKey, candidate)
    } else if (platform !== 'win32') {
      setFirstRuntimeWorktreePathCandidate(
        index.posixRelative,
        runtimeWorktreeSummaryPathKey(worktree.repoId, worktree.path, platform),
        candidate
      )
    }
  }
  return index
}

export function findRuntimeWorktreeSummaryByPath(
  index: RuntimeWorktreeSummaryPathIndex,
  repoId: string,
  worktreePath: string,
  platform: NodeJS.Platform
): RuntimeWorktreePsSummary | null {
  if (isPosixAbsoluteRuntimeWorktreePath(worktreePath)) {
    return (
      index.posixAbsolute.get(runtimeWorktreeSummaryPathKey(repoId, worktreePath, platform))
        ?.summary ?? null
    )
  }

  const windowsKey = runtimeWorktreeSummaryPathKey(repoId, worktreePath, 'win32')
  if (platform === 'win32' || isWindowsAbsolutePathLike(worktreePath)) {
    return index.windows.get(windowsKey)?.summary ?? null
  }

  const posixCandidate = index.posixRelative.get(
    runtimeWorktreeSummaryPathKey(repoId, worktreePath, platform)
  )
  const windowsCandidate = index.windowsAbsolute.get(windowsKey)
  // Why: a malformed path can match both the POSIX and Windows indexes; keep the old pairwise scan's first-match order.
  if (!posixCandidate) {
    return windowsCandidate?.summary ?? null
  }
  if (!windowsCandidate || posixCandidate.order < windowsCandidate.order) {
    return posixCandidate.summary
  }
  return windowsCandidate.summary
}

function setFirstRuntimeWorktreePathCandidate(
  candidates: Map<string, RuntimeWorktreeSummaryPathCandidate>,
  key: string,
  candidate: RuntimeWorktreeSummaryPathCandidate
): void {
  if (!candidates.has(key)) {
    candidates.set(key, candidate)
  }
}

function isPosixAbsoluteRuntimeWorktreePath(worktreePath: string): boolean {
  return worktreePath.startsWith('/') && !worktreePath.startsWith('//')
}

function runtimeWorktreeSummaryPathKey(
  repoId: string,
  worktreePath: string,
  platform: NodeJS.Platform
): string {
  return `${repoId}\0${worktreePathComparisonKey(worktreePath, platform)}`
}

export function includeTargetResolvedWorktree(
  resolvedWorktrees: ResolvedWorktree[],
  targetWorktree: ResolvedWorktree | null
): ResolvedWorktree[] {
  if (!targetWorktree || resolvedWorktrees.some((worktree) => worktree.id === targetWorktree.id)) {
    return resolvedWorktrees
  }
  return [...resolvedWorktrees, targetWorktree]
}

export function findResolvedWorktreeIdForPath(
  resolvedWorktrees: ResolvedWorktree[],
  cwd: string,
  targetWorktreeId?: string | null
): string | null {
  if (!cwd) {
    return null
  }
  const matches = resolvedWorktrees
    .filter((worktree) => isPathInsideOrEqual(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)
  // Why: a cwd cannot distinguish folder-workspace siblings, which all share one
  // directory. Break that tie toward the caller's target instead of store order,
  // so an unattributed PTY still lands in the workspace being listed. Only ties at
  // the deepest path qualify — a nested worktree must still beat its parent.
  const deepest = matches.filter((worktree) => worktree.path.length === matches[0]?.path.length)
  return (
    (deepest.length > 1
      ? deepest.find((worktree) => worktree.id === targetWorktreeId)?.id
      : undefined) ??
    matches[0]?.id ??
    null
  )
}

export function getLeafWorktreeStatus(
  leaf: RuntimeLeafRecord,
  tabTitle: string | null
): RuntimeWorktreeStatus {
  // Why: recompute from the live title each call (no sticky state) so worktree.ps mirrors the desktop sidebar's getWorktreeStatus.
  const titleCandidates = [
    { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
    { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt },
    { title: tabTitle, updatedAt: 0 }
  ]
  const latestTitle = getLatestAgentCandidateTitle(...titleCandidates)
  const detected = latestTitle ? detectAgentStatusFromTitle(latestTitle) : leaf.lastAgentStatus
  return getDetectedWorktreeStatus(detected, leaf.ptyId !== null)
}
