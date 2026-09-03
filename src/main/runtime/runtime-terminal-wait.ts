/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */
// Pure terminal tail projection: ANSI-normalized tail buffers, wait-state
// detection, restored-tail seeding, and worktree/agent title classification.
// Zero runtime state — every function here is a pure transform over its args.
import type { AgentStatus } from '../../shared/agent-detection'
import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle
} from '../../shared/agent-detection'
import type {
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalState,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { getTerminalState } from './runtime-tail-read'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-tail-shared'


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
