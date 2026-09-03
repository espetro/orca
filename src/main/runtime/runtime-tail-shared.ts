/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */
// Pure terminal tail projection: ANSI-normalized tail buffers, wait-state
// detection, restored-tail seeding, and worktree/agent title classification.
// Zero runtime state — every function here is a pure transform over its args.
import type { AgentStatus } from '../../shared/agent-detection'
import { isAgentScratchRepoRootPath } from '../../shared/agent-scratch-worktrees'
import type {
  RuntimeWorktreeStatus,
  RuntimeSyncedLeaf
} from '../../shared/runtime-types'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'
import type { TerminalTailWaitState } from './runtime-tail-read'
import type { RetainedTailRedrawCursor } from './runtime-tail-redraw'


export type ResolvedWorktree = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

export type RuntimeLeafRecord = RuntimeSyncedLeaf & {
  ptyGeneration: number
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  tailBuffer: string[]
  tailTranscriptBuffer: string[]
  tailTranscriptChars: number
  tailPartialLine: string
  tailPendingAnsi: string
  tailRedrawCursor: RetainedTailRedrawCursor | null
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  waitBlockedAt: number | null
  tailWaitState?: TerminalTailWaitState
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  paneTitleUpdatedAt: number | null
}

export type RuntimePtyWorktreeRecord = {
  ptyId: string
  incarnationId: string | null
  worktreeId: string
  connectionId: string | null
  runtimeSessionOwned: boolean
  isWsl: boolean | null
  wslDistro: string | null
  tabId: string | null
  paneKey: string | null
  launchAgent: TuiAgent | null
  launchToken: string | null
  launchIncarnationId: string | null
  connected: boolean
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  managementTitle: string | null
  managementTitleAt: number | null
  controllerTitle: string | null
  title: string | null
  titleUpdatedAt: number | null
  lastOutputAt: number | null
  tailBuffer: string[]
  tailTranscriptBuffer: string[]
  tailTranscriptChars: number
  tailPartialLine: string
  tailPendingAnsi: string
  tailRedrawCursor: RetainedTailRedrawCursor | null
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  waitBlockedAt: number | null
  tailWaitState?: TerminalTailWaitState
}

export type RuntimeWorktreeAgentSource = {
  paneKey: string
  ptyId?: string
  tabId?: string
  worktreeId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  state: ParsedAgentStatusPayload['state']
  workingMode?: ParsedAgentStatusPayload['workingMode']
  agentType: string | null
  prompt: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  stateStartedAt: number
  updatedAt: number
  restoredUnconfirmed?: boolean
}

export type RuntimeWorkingTerminalEvidence = {
  paneKey: string | null
  ptyId: string | null
  tabId: string | null
}

export type RuntimeTerminalProjection = {
  lines: string[]
  draft?: string
}

export const WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS = 50
// Why: chunks that could complete an actionable prompt bypass the throttle so blocked stamps stay immediate; scanned over the new chunk + short carry, never the whole window.
export const WAIT_BLOCKED_KEYWORD_PATTERN =
  /press enter|press t to trust|do you trust|trust this|trusted workspace|permission required|requires permission|allow once|allow always|update available|choose working directory|codex just got an upgrade|hooks need review/
export const WAIT_BLOCKED_KEYWORD_CARRY_CHARS = 31
export const MAX_TAIL_LINES = 2000
export const MAX_TAIL_CHARS = 256 * 1024
export const MAX_TAIL_PARTIAL_CHARS = 4000
export const MAX_TAIL_PENDING_ANSI_CHARS = 4096
export const DEFAULT_TERMINAL_READ_LIMIT = 120
export const MAX_TERMINAL_READ_LIMIT = 2000
export const MAX_TERMINAL_PREVIEW_CHARS = 32 * 1024
export const AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 8_000
export const VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 750
export const VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS = 1_000
export const TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS = 10
export const MAX_PREVIEW_LINES = 6
export const MAX_PREVIEW_CHARS = 300
export const WORKTREE_STATUS_PRIORITY: Record<RuntimeWorktreeStatus, number> = {
  inactive: 0,
  active: 1,
  done: 2,
  working: 3,
  permission: 4
}
export const DEFAULT_REPO_SEARCH_REFS_LIMIT = 25
export const DEFAULT_TERMINAL_LIST_LIMIT = 200
export const DEFAULT_WORKTREE_LIST_LIMIT = 200
export const DEFAULT_WORKTREE_PS_LIMIT = 200
export const DISCONNECTED_PTY_RECORD_MAX = 128
export const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000
const WORKTREE_SCAN_CACHE_TTL_MS = 30_000
// Why: agent-scratch repos don't need 30s freshness — the steady-state scan
// fan-out was measured at ~128 git execs/min on real installs, mostly against
// these (crash-cluster diagnostics, 2026-07).
const WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS = 5 * 60_000
// Why: the Git-admin fingerprint reads HEAD and its ref tip exactly, but sparse-checkout pattern
// edits are invisible to it and a tip living in packed-refs or reftable only gets an mtime + size
// stamp, so a real scan still runs on this interval even while the probe reports "unchanged".
export const WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS = 5 * 60_000
// Why reserved rather than spent on the probe: when the probe expires the caller still has to run
// `git worktree list` and answer inside the same budget, so the fallback needs its own room. Sized
// for a healthy Git on a busy host, well above the tens of milliseconds a warm list costs.
const WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS = 1500
// Why derived from the caller's budget instead of a generous absolute: this wait runs *inside*
// RESOLVED_WORKTREE_REPO_TIMEOUT_MS, so outlasting it buys nothing — the caller has already given up
// and restored persisted rows — while turning a reusable scan into a full-budget stall that repeats
// on every TTL expiry. Subtracting keeps that invariant true by construction if either side moves.
// Why not smaller: the probe reads a subset of what the fallback scan reads, so a probe too slow to
// fit is a scan that will not fit either — waiting is strictly better right up to the budget.
// Expiring yields `null`, the existing "cannot prove unchanged" sentinel, so a real scan runs.
export const WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS =
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS - WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS

export function resolveWorktreeScanCacheTtlMs(repo: Pick<Repo, 'path' | 'connectionId'>): number {
  return !repo.connectionId && isAgentScratchRepoRootPath(repo.path)
    ? WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS
    : WORKTREE_SCAN_CACHE_TTL_MS
}
export const PTY_CONTROLLER_LIST_TIMEOUT_MS = 3000
// Why: the slice of the list budget reserved for the aggregate to collect the providers
// that answered after a stalled one gives up.
export const PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS = 500
// Why: the renderer waits 15s; leave room for the verified failure response and release the spawn fence before its caller times out.
export const WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS = 12_000

export async function waitForWorktreeTerminalMutation(
  previous: Promise<void>,
  deadline?: number
): Promise<void> {
  if (deadline === undefined) {
    await previous
    return
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('terminal_worktree_sleep_timeout')
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('terminal_worktree_sleep_timeout')),
          remainingMs
        )
      })
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

// Why: listener fan-out is best-effort delivery. One subscriber throwing synchronously — e.g. a
// paired-client relay whose stream is closed — must never abort the emitting operation or leak
// state (a lock/mutation) the caller holds across the emit. Isolate every listener and log.
export function notifyRuntimeListeners<L>(
  listeners: Iterable<L>,
  deliver: (listener: L) => void,
  context: string
): void {
  for (const listener of listeners) {
    try {
      deliver(listener)
    } catch (error) {
      console.error(`[runtime] ${context} listener threw`, error)
    }
  }
}
// Why (§3.3): 30s freshness window reuses a recent fetch for repeat create/dispatch on the same repo+remote; short enough a changed remote is seen next action.
export const FETCH_FRESHNESS_MS = 30_000
// Why: bound fetches so a Windows credential-manager GUI hang (STA-1292) can't wedge worktree creation; parity with the exact-base refresh sibling.
export const REMOTE_FETCH_TIMEOUT_MS = 60_000
export const REMOTE_FETCH_CACHE_MAX = 512
export const DRIFT_PROBE_SUBJECT_LIMIT = 5

export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next()
    if (oldest.done) {
      return
    }
    map.delete(oldest.value)
  }
}

export function getExplicitWorktreeIdSelector(selector: string | undefined): string | null {
  if (!selector?.startsWith('id:')) {
    return null
  }
  const id = selector.slice(3)
  return id.length > 0 ? id : null
}

export function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  return withTimeout(
    promise.then((value) => ({ ok: true, value }) as const),
    timeoutMs,
    {
      ok: false
    }
  )
}
