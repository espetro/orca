import type { RelayDispatcher } from './dispatcher'
import type { ManagedPty } from './pty-handler'
import type { RelayPtySourceOutput } from './relay-pty-source-output'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'

export const MAX_RELAY_PTY_SESSIONS = 50
export const REPLAY_BUFFER_MAX = 100 * 1024
const PTY_OUTPUT_BATCH_INTERVAL_MS = 8
const PTY_OUTPUT_DRAIN_CONTINUE_MS = 1
const PTY_OUTPUT_FLUSH_CHUNK_CHARS = 16 * 1024
const PTY_OUTPUT_FLUSH_MAX_WRITES = 2
const PTY_OUTPUT_PRODUCER_HIGH_BYTES = 128 * 1024
const PTY_OUTPUT_PRODUCER_LOW_BYTES = 64 * 1024
const INTERACTIVE_OUTPUT_WINDOW_MS = 100
const INTERACTIVE_OUTPUT_MAX_CHARS = 1024
const INTERACTIVE_REDRAW_MAX_CHARS = PTY_OUTPUT_FLUSH_CHUNK_CHARS
const INTERACTIVE_OUTPUT_BUDGET_CHARS = 32 * 1024

type PendingPtyOutput = RelayPtySourceOutput & {
  data: string
  interactive?: boolean
  sourceChunk?: RelayPtySourceOutput
}

export type PtyPendingExit = { id: string; code: number; incarnationId: string }

/** Owns the pending-output queues, flush scheduling, producer backpressure and pending-exit
 *  publication for {@link ManagedPty} instances. The handler keeps PTY lookup and delegates. */
export class PtyOutputFlushQueue {
  private pendingOutputByPty = new Map<string, PendingPtyOutput[]>()
  private pendingExitByPty = new Map<string, PtyPendingExit>()
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null
  private pausedOutputPtys = new Set<string>()
  private consumerPausedOutputPtys = new Set<string>()
  private lastInputAtByPty = new Map<string, number>()
  private interactiveOutputCharsByPty = new Map<string, number>()
  private sourcePublication: RelayPtySourcePublication | null = null

  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly getManaged: (id: string) => ManagedPty | undefined
  ) {}

  setSourcePublication(publication: RelayPtySourcePublication | null): void {
    this.sourcePublication = publication
  }

  setConsumerDeliveryPaused(id: string, paused: boolean): void {
    if (paused) {
      this.consumerPausedOutputPtys.add(id)
      this.pausePtyOutput(id)
      return
    }
    this.consumerPausedOutputPtys.delete(id)
    this.maybeResumePtyOutput(id)
  }

  handleSourcePublicationCapacity(id: string): void {
    if (this.pendingOutputByPty.has(id)) {
      this.scheduleOutputFlush(0)
    }
    this.maybeResumePtyOutput(id)
    this.publishPendingExit(id)
  }

  /** Drain-time input timestamp for the interactive-redraw fast path. */
  noteInput(id: string): void {
    this.lastInputAtByPty.set(id, performance.now())
    this.interactiveOutputCharsByPty.set(id, 0)
  }

  recordPendingExit(exit: PtyPendingExit): void {
    this.pendingExitByPty.set(exit.id, exit)
    this.publishPendingExit(exit.id)
  }

  private isLikelyInteractiveRedraw(data: string): boolean {
    if (data.length <= INTERACTIVE_OUTPUT_MAX_CHARS) {
      return true
    }
    return data.length <= INTERACTIVE_REDRAW_MAX_CHARS && data.includes('\x1b[')
  }

  private shouldSendInteractiveOutputNow(id: string, data: string): boolean {
    const lastInputAt = this.lastInputAtByPty.get(id)
    const now = performance.now()
    if (lastInputAt === undefined || now - lastInputAt > INTERACTIVE_OUTPUT_WINDOW_MS) {
      this.interactiveOutputCharsByPty.delete(id)
      return false
    }
    if (!this.isLikelyInteractiveRedraw(data)) {
      this.interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    const usedChars = this.interactiveOutputCharsByPty.get(id) ?? 0
    if (usedChars + data.length > INTERACTIVE_OUTPUT_BUDGET_CHARS) {
      this.interactiveOutputCharsByPty.set(id, INTERACTIVE_OUTPUT_BUDGET_CHARS)
      return false
    }
    this.interactiveOutputCharsByPty.set(id, usedChars + data.length)
    return true
  }

  enqueuePtyOutput(
    id: string,
    data: string,
    meta: { rawLength?: number; transformed?: boolean; seq?: number } = {}
  ): void {
    const queue = this.pendingOutputByPty.get(id) ?? []
    if (this.sourcePublication?.accepts(id)) {
      queue.push({ data, ...meta })
      this.pendingOutputByPty.set(id, queue)
      if (queue.length === 1 && this.shouldSendInteractiveOutputNow(id, data)) {
        queue[0].interactive = true
        if (this.flushPtyOutput(id)) {
          return
        }
      }
      if (this.pendingProducerBytes(id) >= PTY_OUTPUT_PRODUCER_HIGH_BYTES) {
        this.pausePtyOutput(id)
      }
      this.scheduleOutputFlush(PTY_OUTPUT_BATCH_INTERVAL_MS)
      return
    }
    const existing = queue.at(-1)
    if (meta.transformed === true) {
      if (queue.length === 0) {
        const transformed = { data, ...meta }
        if (this.publishPtyOutput(id, transformed, false)) {
          return
        }
        queue.push(transformed)
      } else if (existing?.transformed) {
        existing.data += data
        existing.rawLength = (existing.rawLength ?? 0) + (meta.rawLength ?? data.length)
        existing.seq = meta.seq
      } else {
        queue.push({ data, ...meta })
      }
      this.pendingOutputByPty.set(id, queue)
      this.pausePtyOutput(id)
      return
    }
    const pending: PendingPtyOutput = existing && !existing.transformed ? existing : { data: '' }
    const previousLength = pending.data.length
    pending.data += data
    if (pending.rawLength !== undefined || meta.rawLength !== undefined) {
      pending.rawLength = (pending.rawLength ?? previousLength) + (meta.rawLength ?? data.length)
    }
    if (meta.seq !== undefined) {
      pending.seq = meta.seq
    }
    if (!existing || existing.transformed) {
      queue.push(pending)
    }
    this.pendingOutputByPty.set(id, queue)
    if (queue.length === 1 && this.shouldSendInteractiveOutputNow(id, pending.data)) {
      pending.interactive = true
      if (this.flushPtyOutput(id)) {
        return
      }
    }
    if (this.pendingProducerBytes(id) >= PTY_OUTPUT_PRODUCER_HIGH_BYTES) {
      this.pausePtyOutput(id)
    }
    this.scheduleOutputFlush(PTY_OUTPUT_BATCH_INTERVAL_MS)
  }

  private scheduleOutputFlush(delayMs: number): void {
    if (this.outputFlushTimer !== null) {
      return
    }
    this.outputFlushTimer = setTimeout(() => this.flushPendingOutput(), delayMs)
  }

  private flushPendingOutput(): void {
    this.outputFlushTimer = null
    // Why batch before the first send: a re-entrant sink must read the values a whole-map snapshot
    // would have frozen. Why the raw iterator: `for...of` would consume one entry past the limit.
    const pendingEntries = this.pendingOutputByPty[Symbol.iterator]()
    const batch: [string, PendingPtyOutput[]][] = []
    while (batch.length < PTY_OUTPUT_FLUSH_MAX_WRITES) {
      const next = pendingEntries.next()
      if (next.done === true) {
        break
      }
      batch.push([next.value[0], next.value[1].map((pending) => ({ ...pending }))])
    }
    let writes = 0
    for (const [id, queue] of batch) {
      this.pendingOutputByPty.delete(id)
      if (this.flushPtyOutput(id, queue)) {
        writes++
      }
    }
    if (this.pendingOutputByPty.size > 0 && writes > 0) {
      // Why: yield between slices of a large chunk so client input and control frames can interleave.
      this.scheduleOutputFlush(PTY_OUTPUT_DRAIN_CONTINUE_MS)
    }
  }

  flushPtyOutput(id: string, capturedQueue?: PendingPtyOutput[]): boolean {
    const queue = capturedQueue ?? this.pendingOutputByPty.get(id)
    const pending = queue?.[0]
    if (!queue || !pending) {
      this.publishPendingExit(id)
      return true
    }
    const desiredChars = pending.transformed
      ? pending.data.length
      : Math.min(pending.data.length, PTY_OUTPUT_FLUSH_CHUNK_CHARS)
    const sourceOnlyEmission =
      pending.transformed === true && pending.data.length === 0 && (pending.rawLength ?? 0) > 0
    const paramsWithoutData = {
      id,
      ...(pending.seq === undefined ? {} : { seq: pending.seq }),
      ...(pending.rawLength === undefined ? {} : { rawLength: pending.rawLength }),
      ...(pending.transformed ? { transformed: true } : {})
    }
    // Why: a failed publish may already have reserved this exact span (source-ledger append,
    // partial legacy fan-out), so a retry must resend it verbatim and slice the remainder at
    // the memo boundary — capacity and coalesced data can both have changed since. The capacity
    // search is skipped on retry: its result is discarded, and publish re-checks capacity.
    let chunkChars =
      pending.transformed || pending.sourceChunk
        ? desiredChars
        : (this.dispatcher.maxLegacyPtyDataChars?.(paramsWithoutData, pending.data, desiredChars) ??
          desiredChars)
    if (
      chunkChars > 0 &&
      chunkChars < pending.data.length &&
      pending.data.charCodeAt(chunkChars - 1) >= 0xd800 &&
      pending.data.charCodeAt(chunkChars - 1) <= 0xdbff
    ) {
      chunkChars--
    }
    if (
      (!sourceOnlyEmission && chunkChars <= 0) ||
      (pending.transformed && chunkChars !== pending.data.length)
    ) {
      this.pendingOutputByPty.set(id, queue)
      this.pausePtyOutput(id)
      return false
    }
    const chunk = pending.sourceChunk?.data ?? pending.data.slice(0, chunkChars)
    const remaining = pending.data.slice(chunk.length)
    const chunkRawLength = pending.transformed
      ? pending.rawLength
      : pending.rawLength === undefined
        ? undefined
        : chunk.length
    const chunkSeq =
      pending.seq === undefined ? undefined : pending.seq - (pending.data.length - chunk.length)
    const sourceChunk =
      pending.sourceChunk ??
      ({
        data: chunk,
        ...(chunkSeq === undefined ? {} : { seq: chunkSeq }),
        ...(chunkRawLength === undefined ? {} : { rawLength: chunkRawLength }),
        ...(pending.transformed ? { transformed: true } : {})
      } satisfies RelayPtySourceOutput)
    pending.sourceChunk = sourceChunk
    const published = this.publishPtyOutput(id, sourceChunk, pending.interactive === true)
    if (!published) {
      this.pendingOutputByPty.set(id, queue)
      this.pausePtyOutput(id)
      return false
    }
    // rawLength fallback is defensive only: transformed memos always carry rawLength (ingress meta).
    const publishedRawLength = sourceChunk.rawLength ?? sourceChunk.data.length
    const remainingRawLength = pending.transformed
      ? (pending.rawLength ?? 0) - publishedRawLength
      : remaining.length
    if (remaining || (pending.transformed && remainingRawLength > 0)) {
      queue[0] = {
        data: remaining,
        ...(pending.transformed ? { transformed: true } : {}),
        ...(pending.rawLength === undefined ? {} : { rawLength: remainingRawLength }),
        seq: pending.seq
      }
    } else {
      queue.shift()
    }
    if (queue.length === 0) {
      this.pendingOutputByPty.delete(id)
      this.publishPendingExit(id)
    } else {
      this.pendingOutputByPty.set(id, queue)
    }
    this.maybeResumePtyOutput(id)
    this.clearOutputFlushTimerIfIdle()
    return true
  }

  private clearOutputFlushTimerIfIdle(): void {
    if (this.pendingOutputByPty.size > 0 || this.outputFlushTimer === null) {
      return
    }
    clearTimeout(this.outputFlushTimer)
    this.outputFlushTimer = null
  }

  clearPtyFlowState(id: string): void {
    this.pendingOutputByPty.delete(id)
    this.pendingExitByPty.delete(id)
    this.pausedOutputPtys.delete(id)
    this.consumerPausedOutputPtys.delete(id)
    this.clearPtyInputState(id)
    this.clearOutputFlushTimerIfIdle()
  }

  private clearPtyInputState(id: string): void {
    this.lastInputAtByPty.delete(id)
    this.interactiveOutputCharsByPty.delete(id)
  }

  /** Drop pending output already captured by a replay buffer, before the replay is delivered. */
  clearPendingOutputForReplay(id: string): void {
    this.pendingOutputByPty.delete(id)
    this.clearOutputFlushTimerIfIdle()
    this.maybeResumePtyOutput(id)
  }

  private publishPtyOutput(
    id: string,
    output: RelayPtySourceOutput,
    interactive: boolean
  ): boolean {
    if (this.sourcePublication?.accepts(id)) {
      return this.sourcePublication.publish(id, output, interactive)
    }
    if (this.dispatcher.tryNotifyPtyData) {
      return this.dispatcher.tryNotifyPtyData(
        {
          id,
          data: output.data,
          ...(output.seq === undefined ? {} : { seq: output.seq }),
          ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
          ...(output.transformed ? { transformed: true } : {})
        },
        { interactive }
      )
    }
    this.dispatcher.notify('pty.data', {
      id,
      data: output.data,
      ...(output.seq === undefined ? {} : { seq: output.seq }),
      ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
      ...(output.transformed ? { transformed: true } : {})
    })
    return true
  }

  private publishPendingExit(id: string): void {
    if (this.pendingOutputByPty.has(id)) {
      return
    }
    const exit = this.pendingExitByPty.get(id)
    if (!exit) {
      return
    }
    if (this.sourcePublication?.accepts(id)) {
      try {
        // Why: after the exit settlement, re-entering sealAndPublishExit would pump a closed
        // ledger delivery; the settled state alone decides completion.
        if (this.sourcePublication.exitPublicationSettled(id)) {
          this.pendingExitByPty.delete(id)
          return
        }
        if (!this.sourcePublication.sealAndPublishExit(exit)) {
          return
        }
        if (
          this.sourcePublication.accepts(id) &&
          !this.sourcePublication.exitPublicationSettled(id)
        ) {
          return
        }
        this.pendingExitByPty.delete(id)
        return
      } catch (err) {
        // Why: a source-publication fault must never escape onExit — it reaches
        // uncaughtException and kills the whole relay daemon. Fall back to the legacy exit.
        process.stderr.write(
          `[pty-handler] pty source exit publication failed for ${id}: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }\n`
        )
      }
    }
    // Why: a retired record can already have projected this exit to the legacy subscribers, and
    // the broadcast below would hand them a second copy.
    let retiredExitPublished: boolean | null | undefined
    try {
      retiredExitPublished = this.sourcePublication?.publishExitAfterRetire?.(exit)
    } catch (err) {
      process.stderr.write(
        `[pty-handler] retired pty exit publication failed for ${id}: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`
      )
    }
    const published =
      retiredExitPublished ??
      (this.dispatcher.tryNotifyPtyExit
        ? this.dispatcher.tryNotifyPtyExit(exit)
        : (this.dispatcher.notify('pty.exit', exit), true))
    if (!published) {
      return
    }
    this.pendingExitByPty.delete(id)
  }

  private pendingProducerBytes(id: string): number {
    return (this.pendingOutputByPty.get(id) ?? []).reduce(
      (total, pending) =>
        total + Math.max(Buffer.byteLength(pending.data, 'utf8'), 2 * pending.data.length) + 128,
      0
    )
  }

  private pausePtyOutput(id: string): void {
    if (this.pausedOutputPtys.has(id)) {
      return
    }
    const managed = this.getManaged(id)
    if (!managed || managed.disposed) {
      return
    }
    this.pausedOutputPtys.add(id)
    managed.pty.pause()
  }

  private maybeResumePtyOutput(id: string): void {
    if (
      !this.pausedOutputPtys.has(id) ||
      this.consumerPausedOutputPtys.has(id) ||
      this.pendingProducerBytes(id) > PTY_OUTPUT_PRODUCER_LOW_BYTES ||
      this.dispatcher.legacyRetentionBelowLowWater === false
    ) {
      return
    }
    const managed = this.getManaged(id)
    this.pausedOutputPtys.delete(id)
    if (managed && !managed.disposed) {
      managed.pty.resume()
    }
  }

  handleLegacyCapacity(): void {
    if (this.pendingOutputByPty.size > 0) {
      this.scheduleOutputFlush(0)
    }
    for (const id of Array.from(this.pendingExitByPty.keys())) {
      this.publishPendingExit(id)
    }
    for (const id of Array.from(this.pausedOutputPtys)) {
      this.maybeResumePtyOutput(id)
    }
  }

  dispose(): void {
    if (this.outputFlushTimer !== null) {
      clearTimeout(this.outputFlushTimer)
      this.outputFlushTimer = null
    }
    this.pendingOutputByPty.clear()
    this.pendingExitByPty.clear()
    this.pausedOutputPtys.clear()
    this.consumerPausedOutputPtys.clear()
    this.lastInputAtByPty.clear()
    this.interactiveOutputCharsByPty.clear()
  }
}
