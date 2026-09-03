/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */
// Pure terminal tail projection: ANSI-normalized tail buffers, wait-state
// detection, restored-tail seeding, and worktree/agent title classification.
// Zero runtime state — every function here is a pure transform over its args.
import type { AgentStatus } from '../../shared/agent-detection'
import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle,
  isOpenCodeNativeTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  isShellProcess
} from '../../shared/agent-detection'
import { isAgentScratchRepoRootPath } from '../../shared/agent-scratch-worktrees'
import type {
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalRead,
  RuntimeTerminalState,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalAgentStatus,
  RuntimeTerminalWaitCondition,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeStatus,
  RuntimeSyncedLeaf
} from '../../shared/runtime-types'
import type { ParsedAgentStatusPayload, AgentStatusEntry } from '../../shared/agent-status-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import {
  isPathInsideOrEqual,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  isTerminalInputTooLargeWithYield,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import type { TuiAgent } from '../../shared/tui-agent'
import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'
import { worktreeIdComparisonKey, splitWorktreeId } from '../../shared/worktree/id'
import { makePaneKey } from '../../shared/stable-pane-id'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import { worktreePathComparisonKey } from '../ipc/worktree-path-comparison'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'

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
const MAX_TAIL_LINES = 2000
export const MAX_TAIL_CHARS = 256 * 1024
const MAX_TAIL_PARTIAL_CHARS = 4000
const MAX_TAIL_PENDING_ANSI_CHARS = 4096
export const DEFAULT_TERMINAL_READ_LIMIT = 120
const MAX_TERMINAL_READ_LIMIT = 2000
const MAX_TERMINAL_PREVIEW_CHARS = 32 * 1024
export const AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 8_000
export const VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 750
export const VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS = 1_000
export const TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS = 10
const MAX_PREVIEW_LINES = 6
const MAX_PREVIEW_CHARS = 300
const WORKTREE_STATUS_PRIORITY: Record<RuntimeWorktreeStatus, number> = {
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

export function buildPreview(lines: string[], partialLine: string): string {
  const previewLines: string[] = []
  const collectVisibleLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      previewLines.push(trimmed)
    }
  }

  if (partialLine.length > 0) {
    collectVisibleLine(partialLine)
  }
  for (
    let index = lines.length - 1;
    index >= 0 && previewLines.length < MAX_PREVIEW_LINES;
    index--
  ) {
    collectVisibleLine(lines[index])
  }
  previewLines.reverse()

  const preview = previewLines.join('\n')
  return preview.length > MAX_PREVIEW_CHARS
    ? preview.slice(preview.length - MAX_PREVIEW_CHARS)
    : preview
}

// Why: restore payloads can be multi-MB; the records only retain a bounded tail,
// so cap the one-time parse on the spawn path to the suffix that can matter.
const MAX_RESTORE_TAIL_SEED_CHARS = 256 * 1024

type RestoredTerminalTailSeed = {
  lines: string[]
  transcriptLines: string[]
  transcriptChars: number
  partialLine: string
  pendingAnsi: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  linesTotal: number
  preview: string
}

type RestorableTerminalTailRecord = Pick<
  RuntimePtyWorktreeRecord,
  | 'lastOutputAt'
  | 'tailBuffer'
  | 'tailTranscriptBuffer'
  | 'tailTranscriptChars'
  | 'tailPartialLine'
  | 'tailPendingAnsi'
  | 'tailRedrawCursor'
  | 'tailTruncated'
  | 'tailLinesTotal'
  | 'preview'
>

export function buildRestoredTerminalTailSeed(text: string): RestoredTerminalTailSeed | null {
  let bounded = text
  let sliced = false
  if (bounded.length > MAX_RESTORE_TAIL_SEED_CHARS) {
    bounded = bounded.slice(-MAX_RESTORE_TAIL_SEED_CHARS)
    // Why: an arbitrary suffix can start mid-escape; restarting after the first
    // line break resumes at a boundary (escape params never span \n or \r —
    // \r covers newline-free CR-redraw streams). Consume a full \r\n pair so
    // the seed does not begin with a phantom blank line.
    const anchor = bounded.search(/[\r\n]/)
    if (anchor !== -1) {
      bounded = bounded.slice(
        bounded[anchor] === '\r' && bounded[anchor + 1] === '\n' ? anchor + 2 : anchor + 1
      )
    }
    sliced = true
  }
  // Why: the live-path pipeline, so seeded records equal what streaming the
  // same bytes through onPtyData would have produced.
  const normalized = normalizeTerminalChunk(bounded)
  const tail = appendNormalizedToTailBuffer([], '', normalized.text, null)
  if (tail.lines.length === 0 && tail.partialLine.length === 0) {
    return null
  }
  const transcript = appendCompletedTerminalTranscript(
    [],
    0,
    tail.newlyCompletedLines,
    tail.newCompleteLines
  )
  return {
    lines: tail.lines,
    transcriptLines: transcript.lines,
    transcriptChars: transcript.characters,
    partialLine: tail.partialLine,
    pendingAnsi: normalized.pendingAnsi,
    redrawCursor: tail.redrawCursor,
    truncated: sliced || tail.truncated || transcript.truncated,
    linesTotal: tail.newCompleteLines,
    preview: buildPreview(tail.lines, tail.partialLine)
  }
}

export function restoredTerminalTailSeedAllowed(record: RestorableTerminalTailRecord): boolean {
  return (
    record.lastOutputAt === null &&
    record.preview.length === 0 &&
    record.tailBuffer.length === 0 &&
    record.tailPartialLine.length === 0
  )
}

// Deliberately untouched: lastOutputAt (historical bytes must not read as fresh
// activity) and waitBlockedAt/tailWaitState (a restored prompt is not a live
// wait signal; the next live chunk recomputes both from this seeded tail).
export function applyRestoredTerminalTailSeed(
  record: RestorableTerminalTailRecord,
  seed: RestoredTerminalTailSeed
): void {
  // Why shared instances: append helpers never mutate prior arrays, and equal
  // references let tailStateMatches keep its O(1) leaf/pty reuse fast path.
  record.tailBuffer = seed.lines
  record.tailTranscriptBuffer = seed.transcriptLines
  record.tailTranscriptChars = seed.transcriptChars
  record.tailPartialLine = seed.partialLine
  record.tailPendingAnsi = seed.pendingAnsi
  record.tailRedrawCursor = seed.redrawCursor
  record.tailTruncated = seed.truncated
  record.tailLinesTotal = seed.linesTotal
  record.preview = seed.preview
}

export function buildTerminalWaitText(lines: string[], partialLine: string, preview: string): string {
  const waitText = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  // Why: the preview is intentionally short, but wait readiness needs the retained tail so ready headers aren't truncated away.
  return waitText.length > 0 ? waitText : preview
}

export type TerminalTailWaitState = {
  waitText: string
  signal: { reason: RuntimeTerminalWaitBlockedReason; index: number } | null
  // Why: preview is only an empty-tail fallback, recomputed each append, so a preview-derived state can't be reused as the next previous state (gated on fromTail).
  fromTail: boolean
}

// Why: runs per PTY chunk (hundreds/sec); only candidate-bearing tails parse the full 256 KiB, and the cached state avoids repeating that work next chunk.
export function computeTerminalTailWaitState(
  lines: string[],
  partialLine: string,
  preview: string
): TerminalTailWaitState {
  const tailShape = inspectTerminalWaitTail(lines, partialLine)
  if (!tailShape.fromTail) {
    return {
      waitText: preview,
      signal: findActionableTerminalWaitBlockedSignal(preview.toLowerCase()),
      fromTail: false
    }
  }
  if (!tailShape.mayContainBlockedSignal) {
    // Why: reads waitText only when a signal exists; avoid retaining a rebuilt 256 KiB string in the common case.
    return { waitText: '', signal: null, fromTail: true }
  }
  const tailText = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  const fromTail = tailText.length > 0
  const waitText = fromTail ? tailText : preview
  return {
    waitText,
    signal: findActionableTerminalWaitBlockedSignal(waitText.toLowerCase()),
    fromTail
  }
}

function inspectTerminalWaitTail(
  lines: string[],
  partialLine: string
): { fromTail: boolean; mayContainBlockedSignal: boolean } {
  let fromTail = false
  let mayContainBlockedSignal = false
  for (const line of lines) {
    if (!fromTail && line.trim().length > 0) {
      fromTail = true
    }
    if (!mayContainBlockedSignal && TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(line)) {
      mayContainBlockedSignal = true
    }
  }
  if (!fromTail && partialLine.trim().length > 0) {
    fromTail = true
  }
  if (!mayContainBlockedSignal && TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(partialLine)) {
    mayContainBlockedSignal = true
  }
  return { fromTail, mayContainBlockedSignal }
}

// Why: consumes precomputed wait states so full-tail scans aren't repeated per chunk (replaces the former inline double full-tail scan).
export function tailGainedNewerBlockedReason(
  previous: TerminalTailWaitState,
  next: TerminalTailWaitState,
  appendedText: string
): boolean {
  if (next.signal === null) {
    return false
  }
  // Why: permission prompts can split across PTY chunks; stamp when the tail first becomes blocked, or a later prompt follows stale blocked text.
  if (previous.signal === null) {
    return true
  }
  const appendCandidateSignal = findActionableTerminalWaitBlockedSignal(
    `${previous.waitText}${appendedText}`.toLowerCase()
  )
  return appendCandidateSignal !== null && appendCandidateSignal.index > previous.signal.index
}

export function appendNormalizedToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null = null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      redrawCursor: previousRedrawCursor,
      truncated: false,
      newCompleteLines: 0,
      newlyCompletedLines: []
    }
  }

  // Why: fullscreen TUIs emit long newline-free redraw streams; keep the line transcript for pagination but bound partial-line work.
  const previousPartialWasCapped = previousPartialLine.length > MAX_TAIL_PARTIAL_CHARS
  const boundedPreviousPartialLine = previousPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const combinedChunk = `${boundedPreviousPartialLine}${normalizedChunk}`
  if (previousRedrawCursor || containsTerminalVerticalLineControl(combinedChunk)) {
    return appendNormalizedToMultilineTailBuffer(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
  }

  // Why: status UIs redraw one line via CR/backspace/erase; retain the latest redraw segment instead of appending every spinner frame.
  const segments = splitRetainedTerminalTailSegments(combinedChunk)
  const pieces = processTerminalTailCompleteSegments(segments.completeSegments)
  const newlyCompletedLines = pieces.map((line) => trimTerminalLineRight(line))
  const partialResult = applyTerminalLineControls(segments.partialSegment)
  const nextPartialLine = trimTerminalLineRight(partialResult.text)
  const retainedPartialLine = nextPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const newCompleteLines = segments.completeLineCount
  const omittedNewCompleteLines = newCompleteLines - pieces.length
  let nextLines =
    newCompleteLines > 0
      ? [...(omittedNewCompleteLines > 0 ? [] : previousLines), ...newlyCompletedLines]
      : previousLines
  let truncated =
    previousPartialWasCapped ||
    omittedNewCompleteLines > 0 ||
    nextPartialLine.length > MAX_TAIL_PARTIAL_CHARS

  if (nextLines.length > MAX_TAIL_LINES) {
    nextLines = nextLines.slice(nextLines.length - MAX_TAIL_LINES)
    truncated = true
  }

  if (newCompleteLines > 0 || retainedPartialLine.length > previousPartialLine.length) {
    if (nextLines === previousLines) {
      nextLines = [...previousLines]
    }
    let totalChars =
      nextLines.reduce((sum, line) => sum + line.length, 0) + retainedPartialLine.length
    let trimStartIndex = 0
    while (trimStartIndex < nextLines.length && totalChars > MAX_TAIL_CHARS) {
      totalChars -= nextLines[trimStartIndex].length
      trimStartIndex += 1
    }
    if (trimStartIndex > 0) {
      nextLines = nextLines.slice(trimStartIndex)
      truncated = true
    }
  }

  const redrawCursor =
    !partialResult.hadControl || partialResult.cursorColumn === nextPartialLine.length
      ? null
      : {
          rowFromEnd: 0,
          column: partialResult.cursorColumn
        }

  return {
    lines: nextLines,
    partialLine: retainedPartialLine,
    redrawCursor,
    truncated,
    newCompleteLines,
    newlyCompletedLines
  }
}

function trimTerminalLineRight(line: string): string {
  let end = line.length
  while (end > 0) {
    const code = line.charCodeAt(end - 1)
    if (code !== 0x20 && code !== 0x09) {
      break
    }
    end -= 1
  }
  return end === line.length ? line : line.slice(0, end)
}

// Why a window: the unwindowed impl below is O(tail) per chunk (~93% of the event loop under TUI flood, findings log 2026-07-03); a redraw only touches rows the cursor reaches, so window the suffix and share the prefix by reference. Equivalence fuzz-verified in retained-tail-redraw-window.equivalence.test.ts.
const REDRAW_WINDOW_SAFETY_ROWS = 8

function maxUpwardCursorReach(
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): number {
  let reach = previousRedrawCursor ? previousRedrawCursor.rowFromEnd : 0
  const cursorUpPattern = /\u001b\[(\d*)(?:;[\d;]*)?A/g
  let match: RegExpExecArray | null
  while ((match = cursorUpPattern.exec(normalizedChunk)) !== null) {
    reach += match[1] ? Number.parseInt(match[1], 10) : 1
  }
  return reach
}

function appendNormalizedToMultilineTailBuffer(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const windowRows =
    maxUpwardCursorReach(normalizedChunk, previousRedrawCursor) + REDRAW_WINDOW_SAFETY_ROWS
  if (windowRows >= previousLines.length) {
    return appendNormalizedToMultilineTailBufferUnwindowed(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
  }
  const prefixLength = previousLines.length - windowRows
  const suffix = previousLines.slice(prefixLength)
  const windowed = appendNormalizedToMultilineTailBufferUnwindowed(
    suffix,
    boundedPreviousPartialLine,
    normalizedChunk,
    previousPartialWasCapped,
    previousRedrawCursor
  )
  let lines = previousLines.slice(0, prefixLength)
  // Why: the shared prefix must match the unwindowed finalize's trailing-space trim without paying a regex per untouched row.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const lastChar = line.charCodeAt(line.length - 1)
    if (lastChar === 32 || lastChar === 9) {
      lines[index] = line.replace(/[ \t]+$/g, '')
    }
  }
  for (const line of windowed.lines) {
    lines.push(line)
  }
  let truncated = windowed.truncated
  if (lines.length > MAX_TAIL_LINES) {
    lines = lines.slice(lines.length - MAX_TAIL_LINES)
    truncated = true
  }
  let totalChars = windowed.partialLine.length
  for (const line of lines) {
    totalChars += line.length
  }
  let dropCount = 0
  while (dropCount < lines.length && totalChars > MAX_TAIL_CHARS) {
    totalChars -= lines[dropCount]!.length
    dropCount += 1
  }
  if (dropCount > 0) {
    lines = lines.slice(dropCount)
    truncated = true
  }
  return {
    lines,
    partialLine: windowed.partialLine,
    redrawCursor: windowed.redrawCursor,
    truncated,
    newCompleteLines: windowed.newCompleteLines,
    newlyCompletedLines: windowed.newlyCompletedLines
  }
}

export function appendNormalizedToMultilineTailBufferUnwindowed(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const rows: RetainedTerminalRow[] = [
    ...previousLines.map((line) => ({ text: line, completed: true })),
    { text: boundedPreviousPartialLine, completed: false }
  ]
  let cursorRow = previousRedrawCursor
    ? Math.max(0, rows.length - 1 - previousRedrawCursor.rowFromEnd)
    : rows.length - 1
  let cursorColumn = previousRedrawCursor?.column ?? boundedPreviousPartialLine.length
  let newCompleteLines = 0
  const newlyCompletedLines: string[] = []
  let newlyCompletedLineCharacters = 0
  let newlyCompletedLineStart = 0
  let truncated = previousPartialWasCapped

  const retainNewlyCompletedLine = (line: string): void => {
    newlyCompletedLines.push(line)
    newlyCompletedLineCharacters += line.length
    while (
      newlyCompletedLines.length - newlyCompletedLineStart > MAX_TAIL_LINES ||
      newlyCompletedLineCharacters > MAX_TAIL_CHARS
    ) {
      newlyCompletedLineCharacters -= newlyCompletedLines[newlyCompletedLineStart]!.length
      newlyCompletedLineStart += 1
    }
    // Why: a single PTY chunk can carry unbounded newlines; compact in batches while retaining the suffix needed for stable pagination.
    if (newlyCompletedLineStart >= MAX_TAIL_LINES) {
      newlyCompletedLines.splice(0, newlyCompletedLineStart)
      newlyCompletedLineStart = 0
    }
  }

  const ensureCursorRow = (): void => {
    while (cursorRow >= rows.length) {
      rows.push({ text: '', completed: false })
    }
  }
  const trimRows = (): void => {
    const maxRows = MAX_TAIL_LINES + 1
    if (rows.length <= maxRows) {
      return
    }
    const removeCount = rows.length - maxRows
    rows.splice(0, removeCount)
    cursorRow = Math.max(0, cursorRow - removeCount)
    truncated = true
  }
  const moveCursorToColumn = (nextColumn: number): void => {
    cursorColumn = clampTerminalPreviewCursor(nextColumn)
  }
  const markCursorRowRewritten = (): void => {
    ensureCursorRow()
    rows[cursorRow]!.completed = false
  }
  const writeChar = (char: string): void => {
    ensureCursorRow()
    markCursorRowRewritten()
    const row = rows[cursorRow]!
    if (cursorColumn > row.text.length) {
      row.text = `${row.text}${' '.repeat(cursorColumn - row.text.length)}`
    }
    row.text =
      cursorColumn >= row.text.length
        ? `${row.text}${char}`
        : `${row.text.slice(0, cursorColumn)}${char}${row.text.slice(cursorColumn + 1)}`
    cursorColumn += 1
  }
  const eraseLine = (mode: number): void => {
    ensureCursorRow()
    markCursorRowRewritten()
    const row = rows[cursorRow]!
    if (mode === 0) {
      row.text = row.text.slice(0, cursorColumn)
    } else if (mode === 1) {
      const deleteCount = Math.min(cursorColumn + 1, row.text.length)
      row.text = `${' '.repeat(deleteCount)}${row.text.slice(deleteCount)}`
    } else if (mode === 2) {
      row.text = ''
    }
  }

  for (let index = 0; index < normalizedChunk.length; index += 1) {
    const char = normalizedChunk[index]
    if (char === '\n') {
      ensureCursorRow()
      rows[cursorRow]!.completed = true
      newCompleteLines += 1
      retainNewlyCompletedLine(trimTerminalLineRight(rows[cursorRow]!.text))
      cursorRow += 1
      cursorColumn = 0
      ensureCursorRow()
      trimRows()
      continue
    }
    if (char === '\r') {
      cursorColumn = 0
      continue
    }
    if (char === '\u0008') {
      cursorColumn = Math.max(0, cursorColumn - 1)
      continue
    }
    if (char === '\u001b') {
      const parsed = parseAnsiControlSequence(normalizedChunk, index)
      if (!parsed) {
        continue
      }
      index = parsed.endIndex
      if (parsed.kind !== 'csi' || !hasCanonicalNumericCsiParams(parsed.params)) {
        continue
      }
      const firstParam = parsed.firstParam ?? 1
      if (parsed.final === 'A') {
        cursorRow = Math.max(0, cursorRow - firstParam)
        rows.splice(cursorRow + 1)
      } else if (parsed.final === 'K') {
        eraseLine(parsed.firstParam ?? 0)
      } else if (parsed.final === 'G' || parsed.final === '`') {
        moveCursorToColumn(firstParam - 1)
      } else if (parsed.final === 'D') {
        cursorColumn = Math.max(0, cursorColumn - firstParam)
      } else if (parsed.final === 'C') {
        moveCursorToColumn(cursorColumn + firstParam)
      }
      continue
    }
    writeChar(char)
  }

  return finalizeRetainedTerminalRows(
    rows,
    cursorRow,
    cursorColumn,
    truncated,
    newCompleteLines,
    newlyCompletedLineStart > 0
      ? newlyCompletedLines.slice(newlyCompletedLineStart)
      : newlyCompletedLines
  )
}

export type RetainedTailRedrawCursor = {
  rowFromEnd: number
  column: number
}

type RetainedTerminalRow = {
  text: string
  completed: boolean
}

function finalizeRetainedTerminalRows(
  rows: RetainedTerminalRow[],
  cursorRow: number,
  cursorColumn: number,
  initialTruncated: boolean,
  newCompleteLines: number,
  newlyCompletedLines: string[]
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  let truncated = initialTruncated
  let retainedRows = rows.map((row) => ({ ...row, text: row.text.replace(/[ \t]+$/g, '') }))

  if (retainedRows.length > MAX_TAIL_LINES + 1) {
    const removeCount = retainedRows.length - (MAX_TAIL_LINES + 1)
    retainedRows = retainedRows.slice(removeCount)
    cursorRow = Math.max(0, cursorRow - removeCount)
    truncated = true
  }

  let totalChars = retainedRows.reduce((sum, row) => sum + row.text.length, 0)
  let trimStartIndex = 0
  while (trimStartIndex < retainedRows.length - 1 && totalChars > MAX_TAIL_CHARS) {
    totalChars -= retainedRows[trimStartIndex]!.text.length
    trimStartIndex += 1
  }
  if (trimStartIndex > 0) {
    retainedRows = retainedRows.slice(trimStartIndex)
    cursorRow = Math.max(0, cursorRow - trimStartIndex)
    truncated = true
  }
  while (
    retainedRows.length > 1 &&
    cursorRow < retainedRows.length - 1 &&
    retainedRows.at(-1)?.completed === false &&
    retainedRows.at(-1)?.text.length === 0
  ) {
    retainedRows.pop()
  }

  const lastRow = retainedRows.at(-1)
  let partialLine = lastRow && !lastRow.completed ? lastRow.text : ''
  let lines = (lastRow && !lastRow.completed ? retainedRows.slice(0, -1) : retainedRows).map(
    (row) => row.text
  )

  if (partialLine.length > MAX_TAIL_PARTIAL_CHARS) {
    partialLine = partialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
    truncated = true
  }
  if (lines.length > MAX_TAIL_LINES) {
    lines = lines.slice(lines.length - MAX_TAIL_LINES)
    truncated = true
  }
  const outputRowCount = lines.length + 1
  const defaultCursorRow = outputRowCount - 1
  const defaultCursorColumn = partialLine.length
  const redrawCursor =
    cursorRow === defaultCursorRow && cursorColumn === defaultCursorColumn
      ? null
      : {
          rowFromEnd: Math.max(0, outputRowCount - 1 - cursorRow),
          column: clampTerminalPreviewCursor(cursorColumn)
        }

  return {
    lines,
    partialLine,
    redrawCursor,
    truncated,
    newCompleteLines,
    newlyCompletedLines
  }
}

function splitRetainedTerminalTailSegments(value: string): {
  completeSegments: string[]
  partialSegment: string
  completeLineCount: number
} {
  let completeLineCount = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') {
      completeLineCount += 1
    }
  }

  const retainedCompleteCount = Math.min(completeLineCount, MAX_TAIL_LINES)
  const omittedCompleteCount = completeLineCount - retainedCompleteCount
  let startIndex = 0
  if (omittedCompleteCount > 0) {
    let seen = 0
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== '\n') {
        continue
      }
      seen += 1
      if (seen === omittedCompleteCount) {
        startIndex = index + 1
        break
      }
    }
  }

  const completeSegments: string[] = []
  let segmentStart = startIndex
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] !== '\n') {
      continue
    }
    completeSegments.push(value.slice(segmentStart, index))
    segmentStart = index + 1
  }

  return {
    completeSegments,
    partialSegment: value.slice(segmentStart),
    completeLineCount
  }
}

function processTerminalTailCompleteSegments(segments: string[]): string[] {
  const processed: string[] = []
  let totalChars = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const line = applyTerminalLineControls(segments[index]!).text
    processed.push(line)
    totalChars += line.length
    if (totalChars > MAX_TAIL_CHARS) {
      break
    }
  }
  processed.reverse()
  return processed
}

function applyTerminalLineControls(line: string): {
  text: string
  cursorColumn: number
  hadControl: boolean
} {
  const carriageIndex = line.lastIndexOf('\r')
  const latestRedraw = carriageIndex !== -1 ? line.slice(carriageIndex + 1) : line
  if (!latestRedraw.includes('\u0008') && !latestRedraw.includes('\u001b')) {
    return {
      text: latestRedraw,
      cursorColumn: latestRedraw.length,
      hadControl: carriageIndex !== -1
    }
  }

  const chars: string[] = []
  let cursor = 0
  const moveCursorTo = (nextCursor: number): void => {
    cursor = clampTerminalPreviewCursor(nextCursor)
  }
  const writeChar = (char: string): void => {
    if (cursor > chars.length) {
      const oldLength = chars.length
      chars.length = cursor
      chars.fill(' ', oldLength, cursor)
    }
    if (cursor >= chars.length) {
      chars.push(char)
    } else {
      chars[cursor] = char
    }
    cursor += 1
  }
  for (let index = 0; index < latestRedraw.length; index += 1) {
    const char = latestRedraw[index]
    if (char === '\u0008') {
      if (cursor > 0) {
        cursor -= 1
      }
    } else if (char === '\u001b') {
      const parsed = parseAnsiControlSequence(latestRedraw, index)
      if (!parsed) {
        continue
      }
      index = parsed.endIndex
      if (parsed.kind !== 'csi') {
        continue
      }
      if (!hasCanonicalNumericCsiParams(parsed.params)) {
        continue
      }
      if (parsed.final === 'K') {
        const mode = parsed.firstParam ?? 0
        if (mode === 0) {
          chars.length = cursor
        } else if (mode === 1) {
          const deleteCount = Math.min(cursor + 1, chars.length)
          chars.fill(' ', 0, deleteCount)
        } else if (mode === 2) {
          chars.length = 0
        }
      } else if (parsed.final === 'G' || parsed.final === '`') {
        moveCursorTo((parsed.firstParam ?? 1) - 1)
      } else if (parsed.final === 'D') {
        cursor = Math.max(0, cursor - (parsed.firstParam ?? 1))
      } else if (parsed.final === 'C') {
        moveCursorTo(cursor + (parsed.firstParam ?? 1))
      }
    } else {
      writeChar(char)
    }
  }
  return { text: chars.join(''), cursorColumn: cursor, hadControl: true }
}

function clampTerminalPreviewCursor(nextCursor: number): number {
  if (!Number.isFinite(nextCursor)) {
    return MAX_TAIL_PARTIAL_CHARS
  }
  return Math.min(MAX_TAIL_PARTIAL_CHARS, Math.max(0, Math.floor(nextCursor)))
}

function parseAnsiControlSequence(
  value: string,
  escapeIndex: number
):
  | { kind: 'csi'; final: string; params: string; firstParam: number | null; endIndex: number }
  | {
      kind: 'other'
      endIndex: number
    }
  | null {
  const introducer = value[escapeIndex + 1]
  if (introducer === '[') {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code < 0x40 || code > 0x7e) {
        continue
      }
      const params = value.slice(escapeIndex + 2, index)
      const firstParamMatch = /^(\d+)/.exec(params)
      return {
        kind: 'csi',
        final: value[index] ?? '',
        params,
        firstParam: firstParamMatch ? Number(firstParamMatch[1]) : null,
        endIndex: index
      }
    }
    return null
  }
  if (introducer === ']') {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      if (value[index] === '\u0007') {
        return { kind: 'other', endIndex: index }
      }
      if (value[index] === '\u001b' && value[index + 1] === '\\') {
        return { kind: 'other', endIndex: index + 1 }
      }
    }
    return null
  }
  if (isStTerminatedStringControlIntroducer(introducer)) {
    for (let index = escapeIndex + 2; index < value.length; index += 1) {
      if (value[index] === '\u001b' && value[index + 1] === '\\') {
        return { kind: 'other', endIndex: index + 1 }
      }
    }
    return null
  }
  return { kind: 'other', endIndex: escapeIndex + 1 }
}

function isStTerminatedStringControlIntroducer(introducer: string | undefined): boolean {
  return introducer === 'P' || introducer === 'X' || introducer === '^' || introducer === '_'
}

function hasCanonicalNumericCsiParams(params: string): boolean {
  return /^[0-9;]*$/.test(params)
}

function containsTerminalVerticalLineControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\u001b') {
      continue
    }
    const parsed = parseAnsiControlSequence(value, index)
    if (!parsed) {
      return false
    }
    index = parsed.endIndex
    if (
      parsed.kind === 'csi' &&
      parsed.final === 'A' &&
      hasCanonicalNumericCsiParams(parsed.params)
    ) {
      return true
    }
  }
  return false
}

export function appendCompletedTerminalTranscript(
  previousLines: string[],
  previousCharacters: number,
  newlyCompletedLines: string[],
  newCompleteLineCount: number
): { lines: string[]; characters: number; truncated: boolean } {
  if (newCompleteLineCount === 0) {
    return { lines: previousLines, characters: previousCharacters, truncated: false }
  }

  const omittedNewLineCount = Math.max(0, newCompleteLineCount - newlyCompletedLines.length)
  const lines = omittedNewLineCount > 0 ? [] : [...previousLines]
  let characters = omittedNewLineCount > 0 ? 0 : previousCharacters
  for (const line of newlyCompletedLines) {
    lines.push(line)
    characters += line.length
  }

  let dropCount = Math.max(0, lines.length - MAX_TAIL_LINES)
  for (let index = 0; index < dropCount; index += 1) {
    characters -= lines[index]!.length
  }
  while (dropCount < lines.length && characters > MAX_TAIL_CHARS) {
    characters -= lines[dropCount]!.length
    dropCount += 1
  }

  return {
    lines: dropCount > 0 ? lines.slice(dropCount) : lines,
    characters,
    truncated: omittedNewLineCount > 0 || dropCount > 0
  }
}

export function tailStateMatches(
  lines: string[],
  transcriptLines: string[],
  partialLine: string,
  pendingAnsi: string,
  redrawCursor: RetainedTailRedrawCursor | null,
  truncated: boolean,
  linesTotal: number,
  snapshot: {
    lines: string[]
    transcriptLines: string[]
    partialLine: string
    pendingAnsi: string
    redrawCursor: RetainedTailRedrawCursor | null
    truncated: boolean
    linesTotal: number
  }
): boolean {
  if (
    partialLine !== snapshot.partialLine ||
    pendingAnsi !== snapshot.pendingAnsi ||
    !tailRedrawCursorsMatch(redrawCursor, snapshot.redrawCursor) ||
    truncated !== snapshot.truncated ||
    linesTotal !== snapshot.linesTotal ||
    lines.length !== snapshot.lines.length ||
    transcriptLines.length !== snapshot.transcriptLines.length
  ) {
    return false
  }
  if (lines === snapshot.lines) {
    return true
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== snapshot.lines[index]) {
      return false
    }
  }
  if (transcriptLines !== snapshot.transcriptLines) {
    for (let index = 0; index < transcriptLines.length; index++) {
      if (transcriptLines[index] !== snapshot.transcriptLines[index]) {
        return false
      }
    }
  }
  return true
}

function tailRedrawCursorsMatch(
  left: RetainedTailRedrawCursor | null,
  right: RetainedTailRedrawCursor | null
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return left.rowFromEnd === right.rowFromEnd && left.column === right.column
}

function buildTailLines(lines: string[], partialLine: string): string[] {
  return partialLine.length > 0 ? [...lines, partialLine] : lines
}

export function terminalReadLimit(limit: number | undefined, defaultLimit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return defaultLimit
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_TERMINAL_READ_LIMIT)
}

function trimTerminalPreviewToCharacterBudget(
  lines: string[],
  characterBudget: number
): { tail: string[]; limited: boolean; omittedLineCount: number; slicedFirstLine: boolean } {
  let totalCharacters = lines.reduce((sum, line) => sum + line.length, 0)
  if (totalCharacters <= characterBudget) {
    return { tail: lines, limited: false, omittedLineCount: 0, slicedFirstLine: false }
  }

  let omittedLineCount = 0
  while (
    omittedLineCount < lines.length &&
    totalCharacters - lines[omittedLineCount].length >= characterBudget
  ) {
    totalCharacters -= lines[omittedLineCount].length
    omittedLineCount += 1
  }
  const tail = omittedLineCount > 0 ? lines.slice(omittedLineCount) : [...lines]

  let slicedFirstLine = false
  if (tail.length > 0 && totalCharacters > characterBudget) {
    tail[0] = tail[0].slice(totalCharacters - characterBudget)
    slicedFirstLine = true
  }

  return { tail, limited: true, omittedLineCount, slicedFirstLine }
}

export function readTerminalTail(args: {
  handle: string
  status: RuntimeTerminalState
  previewLines: string[]
  completedLines: string[]
  partialLine: string
  completedLineCount: number
  bufferTruncated: boolean
  cursor?: number
  limit?: number
}): RuntimeTerminalRead {
  const oldestCursor = Math.max(0, args.completedLineCount - args.completedLines.length)
  const latestCursor = args.completedLineCount

  if (typeof args.cursor === 'number' && args.cursor >= 0) {
    const limit = terminalReadLimit(args.limit, MAX_TERMINAL_READ_LIMIT)
    if (args.cursor > latestCursor) {
      return {
        handle: args.handle,
        status: args.status,
        tail: [],
        truncated: false,
        limited: false,
        oldestCursor: String(oldestCursor),
        nextCursor: String(latestCursor),
        latestCursor: String(latestCursor),
        returnedLineCount: 0
      }
    }
    // Why: cursor reads return completed lines only, so a partial isn't delivered once as "hel" then again as "hello" after the newline.
    const startCursor = Math.max(args.cursor, oldestCursor)
    const startIndex = startCursor - oldestCursor
    const available = args.completedLines.slice(startIndex)
    const tail = available.slice(0, limit)
    const nextCursor = startCursor + tail.length
    return {
      handle: args.handle,
      status: args.status,
      tail,
      truncated: args.cursor < oldestCursor,
      limited: tail.length < available.length,
      oldestCursor: String(oldestCursor),
      nextCursor: String(nextCursor),
      latestCursor: String(latestCursor),
      returnedLineCount: tail.length
    }
  }

  // Why: un-cursored reads are preview reads — return the latest bounded view; the larger buffer stays available via cursor reads + --limit.
  const limit = terminalReadLimit(args.limit, DEFAULT_TERMINAL_READ_LIMIT)
  const allLines = buildTailLines(args.previewLines, args.partialLine)
  const lineBoundedTail = allLines.slice(-limit)
  const charBoundedTail = trimTerminalPreviewToCharacterBudget(
    lineBoundedTail,
    MAX_TERMINAL_PREVIEW_CHARS
  )
  const lineBoundedStartIndex = Math.max(0, allLines.length - lineBoundedTail.length)
  const charBoundedStartIndex = lineBoundedStartIndex + charBoundedTail.omittedLineCount
  const hasPageableOmittedCompletedLines =
    Math.min(args.completedLineCount, charBoundedStartIndex) > 0 ||
    (charBoundedTail.slicedFirstLine && charBoundedStartIndex < args.completedLineCount)
  // Why: a long partial line trimmed by the char budget can't be recovered via nextCursor, since cursor reads only page completed lines.
  const truncatedByNonPageablePartial = charBoundedTail.limited && !hasPageableOmittedCompletedLines
  return {
    handle: args.handle,
    status: args.status,
    tail: charBoundedTail.tail,
    truncated: args.bufferTruncated || truncatedByNonPageablePartial,
    limited: lineBoundedTail.length < allLines.length || charBoundedTail.limited,
    oldestCursor: String(oldestCursor),
    nextCursor: String(latestCursor),
    latestCursor: String(latestCursor),
    returnedLineCount: charBoundedTail.tail.length
  }
}

export function shouldFallbackToVisibleTerminalSnapshot(
  read: RuntimeTerminalRead,
  opts: { cursor?: number; limit?: number }
): boolean {
  if (typeof opts.cursor === 'number') {
    return false
  }
  if (read.tail.length === 0) {
    return false
  }
  const hasSubstantialBlankTail =
    read.limited === true || read.truncated || read.tail.length >= DEFAULT_TERMINAL_READ_LIMIT
  return hasSubstantialBlankTail && read.tail.every((line) => line.trim().length === 0)
}

function visibleNonBlankTerminalLines(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0)
}

export function projectVisibleTerminalLines(emulator: HeadlessEmulator): {
  lines: string[]
  draft?: string
} {
  const lines = emulator.getVisibleLines()
  const draft = detectTerminalComposerDraft(emulator.getCursorLineContext())
  if (draft) {
    lines[draft.promptRow] = draft.promptGlyph
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      lines[row] = ''
    }
  }
  return {
    lines: visibleNonBlankTerminalLines(lines),
    ...(draft ? { draft: draft.text } : {})
  }
}

export function projectTerminalTailLines(
  emulator: HeadlessEmulator,
  limit: number
): RuntimeTerminalProjection {
  const tail = emulator.getBufferTailLines(limit)
  const visible = emulator.getVisibleLines()
  const visibleRange = emulator.getVisibleBufferRange()
  const draft = detectTerminalComposerDraft(emulator.getCursorLineContext())
  if (draft && visibleRange.endExclusive === visibleRange.totalLength) {
    visible[draft.promptRow] = draft.promptGlyph
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      visible[row] = ''
    }
    const scrollbackTail = tail.slice(0, Math.max(0, tail.length - visible.length))
    tail.splice(0, tail.length, ...scrollbackTail, ...visibleNonBlankTerminalLines(visible))
  }
  return {
    lines: visibleNonBlankTerminalLines(tail).slice(-limit),
    ...(draft ? { draft: draft.text } : {})
  }
}

// Why: every read carries its source, so a caller that asked for a screen and got a response
// with no source at all knows it reached a host that predates screen reads — rather than
// mistaking the stream for the screen. Rendered lines only ever enter a read through
// buildVisibleSnapshotReadFallback, which stamps `screen` itself, so anything still unlabelled
// here is the accumulated stream.
export function labelTerminalReadSource(resolved: RuntimeTerminalRead): RuntimeTerminalRead {
  return resolved.source ? resolved : { ...resolved, source: 'stream' }
}

export function buildVisibleSnapshotReadFallback(
  read: RuntimeTerminalRead,
  visibleLines: string[],
  limit: number | undefined,
  draft?: string
): RuntimeTerminalRead {
  const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
  const lineBoundedTail = visibleLines.slice(-lineLimit)
  const charBoundedTail = trimTerminalPreviewToCharacterBudget(
    lineBoundedTail,
    MAX_TERMINAL_PREVIEW_CHARS
  )
  return {
    ...read,
    tail: charBoundedTail.tail,
    limited:
      read.limited || lineBoundedTail.length < visibleLines.length || charBoundedTail.limited,
    returnedLineCount: charBoundedTail.tail.length,
    source: 'screen',
    ...(draft ? { draft } : {})
  }
}

export function getTerminalState(leaf: RuntimeLeafRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  if (leaf.lastExitCode !== null) {
    return 'exited'
  }
  return 'unknown'
}

export function buildSendPayload(action: {
  text?: string
  enter?: boolean
  interrupt?: boolean
}): string | null {
  let payload = ''
  if (typeof action.text === 'string' && action.text.length > 0) {
    payload += action.text
  }
  if (action.enter) {
    payload += '\r'
  }
  if (action.interrupt) {
    payload += '\x03'
  }
  return payload.length > 0 ? payload : null
}

export async function assertTerminalInputWithinLimitWithYield(text: string | undefined): Promise<void> {
  if (!text) {
    return
  }
  if (await isTerminalInputTooLargeWithYield(text)) {
    throw new Error(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
}

// Why: tui-idle needs OSC title transitions; an unsupported CLI/plain shell never fires one, so cap at 5min to avoid indefinite hangs.
export const TUI_IDLE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const TUI_IDLE_POLL_INTERVAL_MS = 2000
export const TUI_IDLE_QUIESCENCE_MS = 3000
const EXPLICIT_IDLE_TITLE_RE = /(^|\s)(ready|idle|done)(\s|$|[.!?])/i
const CLAUDE_IDLE_PREFIX = '\u2733'
const GEMINI_IDLE_PREFIX = '\u25c7'
const PI_IDLE_PREFIX = '\u03c0 - '

// Clamp for mobileAutoRestoreFitMs: floor above the legacy 300ms debounce, 1h ceiling (a held PTY beyond that is "I forgot", not intentional).
export const MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000
export const MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1000

export function detectExplicitIdleStatusFromTitle(title: string): AgentStatus | null {
  const status = detectAgentStatusFromTitle(title)
  if (status !== 'idle') {
    return null
  }
  // Why: launch titles like "Codex YOLO" contain an agent name but aren't readiness signals; terminal.wait needs explicit idle evidence.
  if (
    EXPLICIT_IDLE_TITLE_RE.test(title) ||
    // Why: unblock hookless remote waits; guarded writes corroborate this marker.
    isOpenCodeNativeTitle(title) ||
    title.startsWith(CLAUDE_IDLE_PREFIX) ||
    title.startsWith('* ') ||
    title.includes(GEMINI_IDLE_PREFIX) ||
    title.startsWith(PI_IDLE_PREFIX)
  ) {
    return 'idle'
  }
  return null
}

export function isKnownReadyPromptPreview(preview: string): boolean {
  const normalized = preview.toLowerCase()
  const readyIndex = findKnownReadyPromptIndex(normalized)
  if (readyIndex === null) {
    return false
  }
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  if (blockedSignal !== null && blockedSignal.index > readyIndex) {
    return false
  }
  return true
}

export function detectTerminalWaitBlockedReason(preview: string): RuntimeTerminalWaitBlockedReason | null {
  const normalized = preview.toLowerCase()
  return findActionableTerminalWaitBlockedSignal(normalized)?.reason ?? null
}

function findActionableTerminalWaitBlockedSignal(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  const blockedSignal = findTerminalWaitBlockedSignal(normalized)
  if (blockedSignal === null) {
    return null
  }
  const dismissedModalIndex = findDismissedStartupModalIndex(normalized)
  // Why: a live prompt after the modal means it was dismissed → signal no longer actionable, even mid-run (Cursor never reports idle via OSC title).
  return dismissedModalIndex !== null && dismissedModalIndex > blockedSignal.index
    ? null
    : blockedSignal
}

// Why: a live prompt (idle OR busy) proves the startup modal was dismissed, so a mid-run Cursor lane stops reporting stale trust hits.
function findDismissedStartupModalIndex(normalized: string): number | null {
  const indexes = [
    findCodexReadyPromptIndex(normalized),
    findAntigravityReadyPromptIndex(normalized),
    findCursorActivePromptIndex(normalized)
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.max(...indexes) : null
}

function findKnownReadyPromptIndex(normalized: string): number | null {
  const indexes = [
    findCodexReadyPromptIndex(normalized),
    findAntigravityReadyPromptIndex(normalized),
    findCursorReadyPromptIndex(normalized)
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.max(...indexes) : null
}

// Why: match the banner's last occurrence to skip the trust dialog's own "Cursor Agent" text; "→" is cursor-agent's persistent input prompt.
function findCursorActivePromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('cursor agent')
  if (headerIndex === -1) {
    return null
  }
  return normalized.includes('→', headerIndex) ? headerIndex : null
}

// Why: cursor-agent emits no idle OSC title; infer idle from the tail (braille spinner = busy, its absence = idle).
const CURSOR_BUSY_SPINNER_RE = /[⠁-⣿]/

function findCursorReadyPromptIndex(normalized: string): number | null {
  const activeIndex = findCursorActivePromptIndex(normalized)
  if (activeIndex === null) {
    return null
  }
  return CURSOR_BUSY_SPINNER_RE.test(normalized.slice(activeIndex)) ? null : activeIndex
}

function findCodexReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const readySegment = normalized.slice(headerIndex)
  // Why: Codex prints permissions only in YOLO mode; the stable ready header is OpenAI Codex + model + directory.
  return readySegment.includes('model:') && readySegment.includes('directory:') ? headerIndex : null
}

function findAntigravityReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('antigravity cli')
  if (headerIndex === -1) {
    return null
  }
  let lineStart = headerIndex
  let modelIndex: number | null = null
  let promptIndex: number | null = null

  // Why: ready previews can include echoed paste after the header; scan line bounds directly instead of splitting the whole tail.
  for (let cursor = headerIndex; cursor <= normalized.length; cursor += 1) {
    if (cursor < normalized.length && normalized.charCodeAt(cursor) !== 10) {
      continue
    }
    let trimmedStart = lineStart
    let trimmedEnd = cursor
    while (trimmedStart < trimmedEnd && isTerminalWaitWhitespace(normalized, trimmedStart)) {
      trimmedStart += 1
    }
    while (trimmedEnd > trimmedStart && isTerminalWaitWhitespace(normalized, trimmedEnd - 1)) {
      trimmedEnd -= 1
    }
    if (lineStart > headerIndex && trimmedStart < trimmedEnd) {
      if (modelIndex === null && normalized.startsWith('gemini', trimmedStart)) {
        modelIndex = trimmedStart
      }
      if (
        promptIndex === null &&
        trimmedEnd - trimmedStart === 1 &&
        normalized.charCodeAt(trimmedStart) === 62
      ) {
        promptIndex = trimmedStart
      }
    }
    lineStart = cursor + 1
  }

  return modelIndex !== null && promptIndex !== null ? Math.max(modelIndex, promptIndex) : null
}

function isTerminalWaitWhitespace(value: string, index: number): boolean {
  const code = value.charCodeAt(index)
  return code === 32 || (code >= 9 && code <= 13)
}

const TERMINAL_WAIT_BLOCKED_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission required|requires permission|allow once|allow always|run this command\?/i

// Why text at all: cursor-agent's hook set has no approval event and beforeShellExecution
// fires for auto-allowed commands too, so the menu is the only authority. Match the key-bound
// choices rather than the prose above them.
const CURSOR_APPROVAL_CHOICE_MARKERS = [
  'run (once)',
  'to allowlist?',
  'run everything',
  'skip & tell the agent'
]
// Why bounded to the last lines: an answered menu stays in scrollback, and a stale hit fails
// tui-idle and refuses prompt injection. Only a dialog that still owns the bottom of the
// screen is live, and confining the whole match to that window also keeps prose above or
// below — an agent narrating "I'll pick Run Everything" — from anchoring it.
const CURSOR_APPROVAL_TAIL_LINES = 8

function findCursorApprovalPromptIndex(normalized: string): number | null {
  const windowStart = startOfLastLines(normalized, CURSOR_APPROVAL_TAIL_LINES)
  const tail = normalized.slice(windowStart)
  if (!tail.includes('run this command?')) {
    return null
  }
  const lines = tail.split('\n')
  while (lines.length > 0 && lines.at(-1)?.trim() === '') {
    lines.pop()
  }
  let matchedLines = 0
  let lastChoiceLine = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!isCursorApprovalChoiceLine(lines[index])) {
      continue
    }
    matchedLines += 1
    lastChoiceLine = index
  }
  if (matchedLines < 2) {
    return null
  }
  // Why no slack: every capture of a live dialog ends on its last choice, and one line of
  // tolerance is enough for the agent's own narration of a choice to revive an answered menu.
  // A redraw caught mid-flight reads as no wait until the next poll, which is the safe way
  // to be wrong.
  return lastChoiceLine === lines.length - 1
    ? windowStart + tail.lastIndexOf('run this command?')
    : null
}

// Why the trailing key and not the wording alone: an agent narrating "next time I'll suggest
// Run Everything" writes the same words as the menu. A selectable row ends in the key that
// picks it, and prose does not. Spelled as key names rather than a character class, because
// any lowercase run would readmit "…suggest Run Everything (as before)".
const CURSOR_APPROVAL_CHOICE_KEY_RE =
  /\((?:shift\+tab|ctrl\+[a-z]|esc(?: or [a-z])*|tab|enter|return|space|[a-z]|[\u21b5\u21e7\u21b9\u238b\u23ce]{1,3})\)\s*$/

function isCursorApprovalChoiceLine(line: string): boolean {
  return (
    CURSOR_APPROVAL_CHOICE_KEY_RE.test(line) &&
    CURSOR_APPROVAL_CHOICE_MARKERS.some((marker) => line.includes(marker))
  )
}

/** Offset of the first character of the last `count` newline-separated lines. */
function startOfLastLines(value: string, count: number): number {
  let cursor = value.length
  for (let seen = 0; seen < count; seen += 1) {
    const previous = value.lastIndexOf('\n', cursor - 1)
    if (previous === -1) {
      return 0
    }
    cursor = previous
  }
  return cursor + 1
}

/** Why a spread and not `agentWait: value`: an absent key is the only way to say the pane was
 *  never evaluated, which a reader must not confuse with an evaluated "no wait". */
export function expandTerminalInteractiveWait(
  agentWait: RuntimeTerminalInteractiveWait | null | undefined
): { agentWait?: RuntimeTerminalInteractiveWait | null } {
  return agentWait === undefined ? {} : { agentWait }
}

/** A wedged PTY controller must not stall every reader of this pane. */
export const TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS = 2_000

function findTerminalWaitBlockedSignal(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number } | null {
  // Why: one combined negative scan over the up-to-256 KiB tail avoids a dozen full-tail searches when no prompt can match.
  if (!TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(normalized)) {
    return null
  }
  const candidates: { reason: RuntimeTerminalWaitBlockedReason; index: number }[] = []
  const updateIndex = normalized.lastIndexOf('update available')
  if (updateIndex !== -1 && normalized.includes('press enter to continue', updateIndex)) {
    candidates.push({ reason: 'codex-update-prompt', index: updateIndex })
  }
  const cwdIndex = normalized.lastIndexOf('choose working directory to')
  if (cwdIndex !== -1 && normalized.includes('press enter to continue', cwdIndex)) {
    candidates.push({ reason: 'codex-cwd-prompt', index: cwdIndex })
  }
  const modelMigrationIndex = normalized.lastIndexOf('codex just got an upgrade')
  if (
    modelMigrationIndex !== -1 &&
    normalized.includes('press enter to continue', modelMigrationIndex)
  ) {
    candidates.push({ reason: 'codex-model-migration-prompt', index: modelMigrationIndex })
  }
  const hooksIndex = normalized.lastIndexOf('hooks need review')
  if (hooksIndex !== -1 && normalized.includes('press enter to confirm', hooksIndex)) {
    candidates.push({ reason: 'codex-hooks-review-prompt', index: hooksIndex })
  }
  const trustIndex = Math.max(
    normalized.lastIndexOf('do you trust'),
    normalized.lastIndexOf('trust this'),
    normalized.lastIndexOf('trusted workspace')
  )
  const trustSegment = trustIndex === -1 ? '' : normalized.slice(trustIndex)
  if (
    trustIndex !== -1 &&
    (trustSegment.includes('workspace') ||
      trustSegment.includes('folder') ||
      trustSegment.includes('directory') ||
      trustSegment.includes('repo'))
  ) {
    candidates.push({ reason: 'codex-trust-workspace', index: trustIndex })
  }
  const interactivePromptIndex = Math.max(
    normalized.lastIndexOf('press enter to confirm'),
    normalized.lastIndexOf('press enter to continue'),
    normalized.lastIndexOf('press enter to view'),
    normalized.lastIndexOf('press enter to insert'),
    normalized.lastIndexOf('press t to trust')
  )
  const interactivePromptContext =
    interactivePromptIndex === -1
      ? ''
      : normalized.slice(Math.max(0, interactivePromptIndex - 600), interactivePromptIndex + 200)
  const hasCodexInteractiveContext =
    interactivePromptContext.includes('codex') ||
    interactivePromptContext.includes('permission') ||
    interactivePromptContext.includes('sandbox') ||
    interactivePromptContext.includes('trust') ||
    interactivePromptContext.includes('hook')
  if (interactivePromptIndex !== -1 && hasCodexInteractiveContext) {
    const contextStart = Math.max(0, interactivePromptIndex - 600)
    const hasSpecificPromptInContext = candidates.some(
      (candidate) => candidate.index >= contextStart && candidate.index <= interactivePromptIndex
    )
    if (!hasSpecificPromptInContext) {
      candidates.push({ reason: 'codex-interactive-prompt', index: interactivePromptIndex })
    }
  }
  const cursorApprovalIndex = findCursorApprovalPromptIndex(normalized)
  if (cursorApprovalIndex !== null) {
    candidates.push({ reason: 'agent-approval-prompt', index: cursorApprovalIndex })
  }
  const permissionPromptIndex = Math.max(
    normalized.lastIndexOf('permission required'),
    normalized.lastIndexOf('requires permission')
  )
  if (permissionPromptIndex !== -1) {
    const permissionSegment = normalized.slice(permissionPromptIndex, permissionPromptIndex + 1_500)
    const decisionCount = ['allow once', 'allow always', 'reject', 'deny'].filter((choice) =>
      permissionSegment.includes(choice)
    ).length
    if (decisionCount >= 2) {
      // Why: preserve the existing remote receipt value for mixed-version clients.
      candidates.push({ reason: 'codex-interactive-prompt', index: permissionPromptIndex })
    }
  }
  return candidates.length > 0
    ? candidates.reduce((latest, candidate) =>
        candidate.index > latest.index ? candidate : latest
      )
    : null
}

export function buildTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: RuntimeLeafRecord
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    undefined,
    leaf.lastExitCause
  )
}

export function buildTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: RuntimeLeafRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    blockedReason,
    leaf.lastExitCause
  )
}

export function buildPtyTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: RuntimePtyWorktreeRecord
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    undefined,
    pty.lastExitCause
  )
}

export function buildPtyTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: RuntimePtyWorktreeRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    blockedReason,
    pty.lastExitCause
  )
}

function buildTerminalWait(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  status: RuntimeTerminalState,
  exitCode: number | null,
  blockedReason?: RuntimeTerminalWaitBlockedReason,
  exitCause?: TerminalExitCause | null
): RuntimeTerminalWait {
  return {
    handle,
    condition,
    satisfied: blockedReason === undefined,
    status,
    exitCode,
    ...(exitCause ? { exitCause } : {}),
    ...(blockedReason ? { blockedReason } : {})
  }
}

export function getPtyTerminalState(pty: RuntimePtyWorktreeRecord): RuntimeTerminalState {
  return pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown'
}

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

export function classifyLatestAgentTitle(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): 'agent' | 'management' | 'neutral' {
  return classifyAgentTitle(getLatestAgentCandidateTitle(...titles))
}

export function getLatestPtyTitle(pty: RuntimePtyWorktreeRecord): string | null {
  return getLatestAgentCandidateTitle(
    { title: pty.title, updatedAt: pty.titleUpdatedAt },
    { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
  )
}

export function getLatestLeafTitle(leaf: RuntimeLeafRecord, tabTitle: string | null): string | null {
  return getLatestAgentCandidateTitle(
    { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
    { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt },
    { title: tabTitle, updatedAt: 0 }
  )
}

// Why: an 'agent' title only proves an agent owns the pane when something other than a
// quarter-circle spinner carries it — those glyphs are generic progress frames (STA-4028).
export function agentTitleProvesAgentPresence(
  title: string | null,
  classification: 'agent' | 'management' | 'neutral'
): boolean {
  return (
    classification === 'agent' &&
    !isOpenCodeNativeTitle(title) &&
    !isQuarterCircleSpinnerOnlyAgentTitle(title)
  )
}

export function ptyTitleProvesAgentPresence(
  pty: RuntimePtyWorktreeRecord,
  title: string | null,
  classification: 'agent' | 'management' | 'neutral'
): boolean {
  return (
    agentTitleProvesAgentPresence(title, classification) ||
    (isQuarterCircleSpinnerOnlyAgentTitle(title) &&
      pty.launchAgent === 'claude' &&
      pty.launchToken !== null &&
      pty.launchIncarnationId === pty.incarnationId)
  )
}

export function classifyAgentTitle(title: string | null): 'agent' | 'management' | 'neutral' {
  if (!title) {
    return 'neutral'
  }
  if (isClaudeManagementTitle(title)) {
    return 'management'
  }
  return detectAgentStatusFromTitle(title) !== null ? 'agent' : 'neutral'
}

export function isTerminalSendSettlementAgent(
  agent: TuiAgent | null | undefined
): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex'
}

export function findLastCompleteOscTitleRange(data: string): { start: number; end: number } | null {
  // Why: one forward cursor keeps hostile unterminated OSC output linear-time.
  let last: { start: number; end: number } | null = null
  let searchFrom = 0
  while (searchFrom < data.length) {
    const start = data.indexOf('\x1b]', searchFrom)
    if (start === -1) {
      break
    }
    const command = data[start + 2]
    if ((command !== '0' && command !== '1' && command !== '2') || data[start + 3] !== ';') {
      searchFrom = start + 2
      continue
    }
    let cursor = start + 4
    for (; cursor < data.length; cursor += 1) {
      if (data[cursor] === '\x07') {
        last = { start, end: cursor + 1 }
        searchFrom = cursor + 1
        break
      }
      if (data[cursor] !== '\x1b') {
        continue
      }
      if (data[cursor + 1] === '\\') {
        last = { start, end: cursor + 2 }
        searchFrom = cursor + 2
      } else {
        searchFrom = cursor
      }
      break
    }
    if (cursor === data.length) {
      break
    }
  }
  return last
}

export function terminalTitleBlocksExplicitAgentStatus(title: string | null): boolean {
  if (!title) {
    return false
  }
  return isClaudeManagementTitle(title) || isShellProcess(title)
}

export function getLatestAgentCandidateTitle(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): string | null {
  return getLatestAgentCandidateTitleInfo(...titles)?.title ?? null
}

export function getLatestAgentCandidateTitleInfo(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): { title: string; updatedAt: number } | null {
  let latest: { title: string; updatedAt: number } | null = null
  for (const candidate of titles) {
    const title = candidate.title?.trim()
    if (!title) {
      continue
    }
    const updatedAt = candidate.updatedAt ?? 0
    if (!latest || updatedAt > latest.updatedAt) {
      latest = { title, updatedAt }
    }
  }
  return latest
}

export function getSavedTabWorktreeStatus(title: string, hasPty: boolean): RuntimeWorktreeStatus {
  return getDetectedWorktreeStatus(detectAgentStatusFromTitle(title), hasPty)
}

function getDetectedWorktreeStatus(
  detected: AgentStatus | null,
  hasPty: boolean
): RuntimeWorktreeStatus {
  if (detected === 'permission') {
    return 'permission'
  }
  if (detected === 'working') {
    return 'working'
  }
  return hasPty ? 'active' : 'inactive'
}

export function mapExplicitAgentStateToRuntimeTerminalStatus(
  state: AgentStatusEntry['state']
): NonNullable<RuntimeTerminalAgentStatus['status']> {
  switch (state) {
    case 'blocked':
    case 'waiting':
      return 'permission'
    case 'working':
      return 'working'
    case 'done':
      return 'idle'
  }
}

export function addRuntimeWorkingTerminalEvidence(
  evidenceByWorktreeId: Map<string, RuntimeWorkingTerminalEvidence[]>,
  worktreeId: string,
  evidence: RuntimeWorkingTerminalEvidence
): void {
  const existing = evidenceByWorktreeId.get(worktreeId)
  if (existing) {
    existing.push(evidence)
  } else {
    evidenceByWorktreeId.set(worktreeId, [evidence])
  }
}

export function runtimeWorkingTerminalEvidenceMatchesSource(
  evidence: RuntimeWorkingTerminalEvidence,
  source: RuntimeWorktreeAgentSource
): boolean {
  if (evidence.paneKey) {
    return (
      evidence.paneKey === source.paneKey ||
      Boolean(evidence.ptyId && source.ptyId && evidence.ptyId === source.ptyId)
    )
  }
  if (evidence.ptyId && source.ptyId) {
    return evidence.ptyId === source.ptyId
  }
  return Boolean(evidence.tabId && evidence.tabId === source.tabId)
}

export function mergeWorktreeSummaryStatus(
  summary: RuntimeWorktreePsSummary,
  next: RuntimeWorktreeStatus,
  nextWorkingMode?: RuntimeWorktreePsSummary['workingMode']
): void {
  const currentPriority = WORKTREE_STATUS_PRIORITY[summary.status]
  const nextPriority = WORKTREE_STATUS_PRIORITY[next]
  if (nextPriority > currentPriority) {
    summary.status = next
    if (next === 'working' && nextWorkingMode === 'monitoring') {
      summary.workingMode = 'monitoring'
    } else {
      delete summary.workingMode
    }
    return
  }
  if (nextPriority === currentPriority && next === 'working') {
    if (nextWorkingMode === 'monitoring') {
      summary.workingMode = 'monitoring'
    } else {
      delete summary.workingMode
    }
  }
}

export function normalizeTerminalChunk(
  chunk: string,
  pendingAnsi: string = ''
): { text: string; pendingAnsi: string } {
  // Why: skip full ANSI/OSC scanning for the common plain-text PTY chunk (perf on high-throughput streams).
  if (pendingAnsi.length === 0 && !terminalChunkNeedsNormalization(chunk)) {
    return { text: chunk, pendingAnsi: '' }
  }
  const combined = `${pendingAnsi}${chunk}`
  const parts: string[] = []
  let textStart = 0
  for (let index = 0; index < combined.length; index += 1) {
    const char = combined[index]
    if (char === '\x1b') {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      if (index + 1 >= combined.length) {
        return { text: parts.join(''), pendingAnsi: combined.slice(index) }
      }
      const parsed = parseAnsiControlSequence(combined, index)
      if (!parsed) {
        return {
          text: parts.join(''),
          pendingAnsi: trimPendingAnsiControl(combined.slice(index))
        }
      }
      if (parsed.kind === 'csi' && isTerminalPreviewLineControl(parsed)) {
        // Why: Codex redraws status text with ANSI controls but no CR; keep them so the tail overwrites the prior frame.
        parts.push(combined.slice(index, parsed.endIndex + 1))
      }
      index = parsed.endIndex
      textStart = index + 1
      continue
    }
    if (char === '\r' && combined[index + 1] === '\n') {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      parts.push('\n')
      index += 1
      textStart = index + 1
      continue
    }
    const code = combined.charCodeAt(index)
    if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0d) {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      parts.push(char)
      textStart = index + 1
    } else if (!isTerminalPreviewPrintableCodeUnit(code)) {
      appendTerminalNormalizedSpan(parts, combined, textStart, index)
      textStart = index + 1
    }
  }
  appendTerminalNormalizedSpan(parts, combined, textStart, combined.length)
  return { text: parts.join(''), pendingAnsi: '' }
}

function appendTerminalNormalizedSpan(
  parts: string[],
  value: string,
  start: number,
  end: number
): void {
  if (end > start) {
    parts.push(value.slice(start, end))
  }
}

function isTerminalPreviewPrintableCodeUnit(code: number): boolean {
  return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)
}

function terminalChunkNeedsNormalization(chunk: string): boolean {
  for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index)
    if (
      code === 0x1b ||
      code === 0x7f ||
      code === 0x0d ||
      code < 0x09 ||
      (code > 0x0a && code < 0x20) ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

function trimPendingAnsiControl(value: string): string {
  if (value.length <= MAX_TAIL_PENDING_ANSI_CHARS) {
    return value
  }
  const introducer = value.slice(0, Math.min(2, value.length))
  const suffixBudget = Math.max(0, MAX_TAIL_PENDING_ANSI_CHARS - introducer.length)
  return `${introducer}${value.slice(-suffixBudget)}`
}

function isTerminalPreviewLineControl(parsed: {
  final: string
  params: string
  firstParam: number | null
}): boolean {
  if (!hasCanonicalNumericCsiParams(parsed.params)) {
    return false
  }
  if (parsed.final === 'K') {
    const mode = parsed.firstParam ?? 0
    return mode === 0 || mode === 1 || mode === 2
  }
  return (
    parsed.final === 'A' ||
    parsed.final === 'G' ||
    parsed.final === '`' ||
    parsed.final === 'D' ||
    parsed.final === 'C'
  )
}

export function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

export function compareWorktreePs(
  left: RuntimeWorktreePsSummary,
  right: RuntimeWorktreePsSummary
): number {
  // Pinned and unread worktrees sort above others so they survive truncation.
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1
  }
  if (left.unread !== right.unread) {
    return left.unread ? -1 : 1
  }
  // Why: worktree.ps is truncated for mobile, so host-visible activity must sort above inactive rows.
  if (left.hasHostSidebarActivity !== right.hasHostSidebarActivity) {
    return left.hasHostSidebarActivity ? -1 : 1
  }
  const leftLast = left.lastOutputAt ?? -1
  const rightLast = right.lastOutputAt ?? -1
  if (leftLast !== rightLast) {
    return rightLast - leftLast
  }
  if (left.liveTerminalCount !== right.liveTerminalCount) {
    return right.liveTerminalCount - left.liveTerminalCount
  }
  return left.path.localeCompare(right.path)
}
