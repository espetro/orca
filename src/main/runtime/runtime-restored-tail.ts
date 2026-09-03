/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output. */
import { normalizeTerminalChunk } from './runtime-agent-title-projection'
import { appendNormalizedToTailBuffer } from './runtime-tail-buffers'
import { appendCompletedTerminalTranscript, buildPreview } from './runtime-tail-read'
import type { RetainedTailRedrawCursor } from './runtime-tail-redraw'
import type { RuntimePtyWorktreeRecord } from './runtime-tail-shared'
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
