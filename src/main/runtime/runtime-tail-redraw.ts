/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */

export type RetainedTailRedrawCursor = {
  rowFromEnd: number
  column: number
}
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, MAX_TAIL_PARTIAL_CHARS } from './runtime-tail-shared'

type RetainedTerminalRow = {
  text: string
  completed: boolean
}

export function finalizeRetainedTerminalRows(
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

export function splitRetainedTerminalTailSegments(value: string): {
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

export function processTerminalTailCompleteSegments(segments: string[]): string[] {
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

export function containsTerminalVerticalLineControl(value: string): boolean {
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
