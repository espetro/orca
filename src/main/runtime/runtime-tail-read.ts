/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */
// Pure terminal tail projection: ANSI-normalized tail buffers, wait-state
// detection, restored-tail seeding, and worktree/agent title classification.
// Zero runtime state — every function here is a pure transform over its args.
import type {
  RuntimeTerminalRead,
  RuntimeTerminalState,
  RuntimeTerminalWaitBlockedReason
} from '../../shared/runtime-types'
import {
  isTerminalInputTooLargeWithYield,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { RetainedTailRedrawCursor } from './runtime-tail-redraw'
import type { RuntimeLeafRecord, RuntimeTerminalProjection } from './runtime-tail-shared'
import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE, findActionableTerminalWaitBlockedSignal } from './runtime-terminal-wait'


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
