/* eslint-disable max-lines -- Why: extracted worktree terminal sleep/stop command cluster from the managed-worktrees facade */
import type { ResolvedWorktree } from './orca-runtime'
import type { RuntimeWorktreeTerminalSleepResult } from '../../shared/runtime-types'
import {
  WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS,
  includeTargetResolvedWorktree,
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual,
  setsEqual,
  waitForWorktreeTerminalMutation
} from './runtime-tail-projection'
import { teardownRpcDeadline } from './worktree-teardown'

/** Facade methods the sleep/stop commands reach back into. */
export type RuntimeManagedWorktreeSleepCommandsHost = Pick<
  RuntimeManagedWorktrees,
  'resolveWorktreeSelector' | 'refreshPtyWorktreeRecordsFromController' | 'getLivePtyIdsForWorktree'
>

export type RuntimeManagedWorktreeSleepCommandsDeps = Pick<
  RuntimeManagedWorktreesDeps,
  | 'terminalMutationTailByWorktreeId'
  | 'terminalSleepStateByWorktreeId'
  | 'terminalSleepByWorktreeId'
  | 'emitClientEvent'
  | 'getRecordedTerminalSleepHandles'
  | 'getTerminalHandlesForPtyId'
  | 'getResolvedWorktreeMap'
  | 'notifier'
  | 'ptyController'
  | 'captureReadyGraphEpoch'
  | 'assertStableReadyGraph'
  | 'intentionalHandlelessPtyStops'
  | 'ptysById'
  | 'leaves'
>

import type {
  RuntimeManagedWorktrees,
  RuntimeManagedWorktreesDeps
} from './runtime-managed-worktrees'

export class RuntimeManagedWorktreeSleepCommands {
  private terminalSleepGeneration = 0

  constructor(
    private deps: RuntimeManagedWorktreeSleepCommandsDeps,
    private host: RuntimeManagedWorktreeSleepCommandsHost
  ) {}

  async acquireWorktreeTerminalMutation(
    worktreeId: string,
    deadline?: number
  ): Promise<() => void> {
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const previous = this.deps.terminalMutationTailByWorktreeId().get(key) ?? Promise.resolve()
    let releaseCurrent = (): void => {}
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => {}).then(() => current)
    this.deps.terminalMutationTailByWorktreeId().set(key, tail)
    try {
      await waitForWorktreeTerminalMutation(
        previous.catch(() => {}),
        deadline
      )
    } catch (error) {
      // Why: resolve this abandoned queue node now so it can never acquire later and stop a terminal after the caller timed out.
      releaseCurrent()
      void tail.finally(() => {
        if (this.deps.terminalMutationTailByWorktreeId().get(key) === tail) {
          this.deps.terminalMutationTailByWorktreeId().delete(key)
        }
      })
      throw error
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseCurrent()
      void tail.finally(() => {
        if (this.deps.terminalMutationTailByWorktreeId().get(key) === tail) {
          this.deps.terminalMutationTailByWorktreeId().delete(key)
        }
      })
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId)
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.deps.terminalSleepStateByWorktreeId().get(key)
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.deps.terminalSleepStateByWorktreeId().delete(key)
      this.deps.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }

  commitWorktreeTerminalSleepPtys(args: {
    worktreeId: string
    generation: number
    ptyIds: readonly string[]
    pendingPtyIds: Set<string>
    committedPtyIds: Set<string>
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  }): void {
    const newlyCommittedPtyIds = [...new Set(args.ptyIds)]
      .filter((ptyId) => !args.committedPtyIds.has(ptyId))
      .sort()
    for (const ptyId of newlyCommittedPtyIds) {
      args.pendingPtyIds.delete(ptyId)
      args.committedPtyIds.add(ptyId)
    }
    if (newlyCommittedPtyIds.length === 0) {
      return
    }
    this.deps.emitClientEvent({
      type: 'worktreeTerminalSleepState',
      worktreeId: args.worktreeId,
      generation: args.generation,
      phase: 'committed',
      ptyIds: newlyCommittedPtyIds,
      terminalHandles: this.deps.getRecordedTerminalSleepHandles(
        newlyCommittedPtyIds,
        args.terminalHandlesByPtyId
      )
    })
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    // Why: sleep is renderer-initiated on desktop (it tears down tab state
    // before killing PTYs). The notifier tells the renderer to run its own
    // sleep flow so all cleanup happens in the correct order.
    this.deps.notifier?.sleepWorktree(worktree.id)
    return { worktreeId: worktree.id }
  }

  async sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const sleepDeadline = Date.now() + WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS
    const releaseMutation = await this.acquireWorktreeTerminalMutation(worktree.id, sleepDeadline)
    const key = runtimeWorktreeIdentityKey(worktree.id)
    const existingSleepState = this.deps.terminalSleepStateByWorktreeId().get(key)
    if (existingSleepState?.phase === 'sleeping') {
      try {
        const resolvedWorktrees = includeTargetResolvedWorktree(
          [...(await this.deps.getResolvedWorktreeMap()).values()],
          worktree
        )
        const refreshedPtyLiveness = await this.host.refreshPtyWorktreeRecordsFromController(
          resolvedWorktrees,
          worktree.id,
          sleepDeadline
        )
        if (!refreshedPtyLiveness) {
          throw new Error('terminal_liveness_unavailable')
        }
        if (this.host.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness).size === 0) {
          releaseMutation()
          return {
            stopped: 0,
            stoppedPtyIds: [],
            livePtyIds: [],
            postStopVerified: true
          }
        }
        this.deps.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: existingSleepState.worktreeId,
          generation: existingSleepState.generation,
          phase: 'woken',
          ptyIds: existingSleepState.ptyIds,
          terminalHandles: existingSleepState.terminalHandles
        })
        this.deps.terminalSleepStateByWorktreeId().delete(key)
      } catch (error) {
        releaseMutation()
        throw error
      }
    }
    const priorPartialState = existingSleepState?.phase === 'partial' ? existingSleepState : null
    const committedPtyIds = new Set(priorPartialState?.ptyIds ?? [])
    const terminalHandlesByPtyId = { ...priorPartialState?.terminalHandlesByPtyId }
    const pendingPtyIds = new Set<string>()
    let generation = 0
    let fullyCommitted = false
    let releaseReversibleRendererStops = (): void => {}
    try {
      const resolvedWorktrees = includeTargetResolvedWorktree(
        [...(await this.deps.getResolvedWorktreeMap()).values()],
        worktree
      )
      const refreshedPtyLiveness = await this.host.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!refreshedPtyLiveness) {
        throw new Error('terminal_liveness_unavailable')
      }
      const livePtyIds = this.host.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
      generation = ++this.terminalSleepGeneration
      for (const ptyId of livePtyIds) {
        pendingPtyIds.add(ptyId)
        terminalHandlesByPtyId[ptyId] = this.deps.getTerminalHandlesForPtyId(ptyId)
      }
      const liveTerminalHandles = this.deps.getRecordedTerminalSleepHandles(
        livePtyIds,
        terminalHandlesByPtyId
      )
      this.deps.terminalSleepStateByWorktreeId().set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'stopping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles: this.deps.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        ),
        terminalHandlesByPtyId
      })
      this.deps.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: worktree.id,
        generation,
        phase: 'started',
        ptyIds: [...livePtyIds].sort(),
        terminalHandles: liveTerminalHandles
      })
      if (committedPtyIds.size > 0) {
        this.deps.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: worktree.id,
          generation,
          phase: 'committed',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles: this.deps.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
        })
      }
      if (livePtyIds.size === 0) {
        const terminalHandles = this.deps.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        )
        this.deps.terminalSleepStateByWorktreeId().set(key, {
          worktreeId: worktree.id,
          generation,
          phase: 'sleeping',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles,
          terminalHandlesByPtyId
        })
        fullyCommitted = true
        return {
          stopped: 0,
          stoppedPtyIds: [],
          livePtyIds: [],
          postStopVerified: true
        }
      }
      const ptyController = this.deps.ptyController
      if (!ptyController?.stopAndWait) {
        throw new Error('terminal_worktree_sleep_unavailable')
      }
      const stopAndWait = ptyController.stopAndWait.bind(ptyController)

      const orderedLivePtyIds = [...livePtyIds].sort()
      releaseReversibleRendererStops =
        ptyController.markReversibleStops?.(orderedLivePtyIds) ?? (() => {})
      const stopResults = await Promise.allSettled(
        orderedLivePtyIds.map(async (ptyId) => ({
          ptyId,
          stopped: await stopAndWait(ptyId, {
            keepHistory: true,
            deadlineMs: teardownRpcDeadline(sleepDeadline)
          })
        }))
      )
      const successfulStopPtyIds = orderedLivePtyIds.filter((_, index) => {
        const result = stopResults[index]
        return result?.status === 'fulfilled' && result.value.stopped
      })
      const failedStopIndex = stopResults.findIndex((result) =>
        result.status === 'rejected' ? true : !result.value.stopped
      )

      const postStopLiveness = await this.host.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!postStopLiveness) {
        this.commitWorktreeTerminalSleepPtys({
          worktreeId: worktree.id,
          generation,
          ptyIds: successfulStopPtyIds,
          pendingPtyIds,
          committedPtyIds,
          terminalHandlesByPtyId
        })
        if (failedStopIndex !== -1) {
          const failedStop = stopResults[failedStopIndex]
          throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
            ptyId: orderedLivePtyIds[failedStopIndex],
            ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
          })
        }
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_liveness_unavailable'
        }
      }
      const remainingLivePtyIds = this.host.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
      const provenStoppedPtyIds = orderedLivePtyIds.filter(
        (ptyId) => !remainingLivePtyIds.has(ptyId)
      )
      this.commitWorktreeTerminalSleepPtys({
        worktreeId: worktree.id,
        generation,
        ptyIds: provenStoppedPtyIds,
        pendingPtyIds,
        committedPtyIds,
        terminalHandlesByPtyId
      })
      if (failedStopIndex !== -1 && remainingLivePtyIds.size > 0) {
        const failedStop = stopResults[failedStopIndex]
        console.error('[runtime] worktree terminal sleep physical stop failed', {
          worktreeId: worktree.id,
          ptyId: orderedLivePtyIds[failedStopIndex],
          cause: failedStop.status === 'rejected' ? failedStop.reason : 'stop_not_acknowledged'
        })
        throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
          ptyId: orderedLivePtyIds[failedStopIndex],
          remainingLivePtyIds: [...remainingLivePtyIds].sort(),
          ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
        })
      }
      if (remainingLivePtyIds.size > 0) {
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_worktree_sleep_still_live',
          remainingLivePtyIds: [...remainingLivePtyIds].sort()
        }
      }
      const terminalHandles = this.deps.getRecordedTerminalSleepHandles(
        committedPtyIds,
        terminalHandlesByPtyId
      )
      this.deps.terminalSleepStateByWorktreeId().set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'sleeping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles,
        terminalHandlesByPtyId
      })
      fullyCommitted = true
      return {
        stopped: provenStoppedPtyIds.length,
        stoppedPtyIds: provenStoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: true
      }
    } finally {
      releaseReversibleRendererStops()
      if (!fullyCommitted && generation > 0) {
        const cancelledPtyIds = [...pendingPtyIds].sort()
        if (cancelledPtyIds.length > 0) {
          this.deps.emitClientEvent({
            type: 'worktreeTerminalSleepState',
            worktreeId: worktree.id,
            generation,
            phase: 'cancelled',
            ptyIds: cancelledPtyIds,
            terminalHandles: this.deps.getRecordedTerminalSleepHandles(
              cancelledPtyIds,
              terminalHandlesByPtyId
            )
          })
        }
        if (committedPtyIds.size > 0) {
          const terminalHandles = this.deps.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
          this.deps.terminalSleepStateByWorktreeId().set(key, {
            worktreeId: worktree.id,
            generation,
            phase: 'partial',
            ptyIds: [...committedPtyIds].sort(),
            terminalHandles,
            terminalHandlesByPtyId
          })
        } else {
          this.deps.terminalSleepStateByWorktreeId().delete(key)
        }
      }
      releaseMutation()
    }
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    const existing = this.deps.terminalSleepByWorktreeId().get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.deps.terminalSleepByWorktreeId().set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.deps.terminalSleepByWorktreeId().get(worktree.id) === sleeping) {
        this.deps.terminalSleepByWorktreeId().delete(worktree.id)
      }
    }
  }

  async stopExactTerminalsForWorktree(
    worktreeSelector: string,
    expectedPtyIds: readonly string[],
    opts: { keepHistory?: boolean; targetOnly?: boolean } = {}
  ): Promise<{
    stopped: number
    stoppedPtyIds: string[]
    livePtyIds: string[]
    postStopVerified: boolean
    postStopFailure?: string
    remainingLivePtyIds?: string[]
  }> {
    // Why: exact stop hibernates one known pane; worktree sleep discovers its complete host-owned set separately.
    const graphEpoch = this.deps.captureReadyGraphEpoch()
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    this.deps.assertStableReadyGraph(graphEpoch)
    const expected = new Set(expectedPtyIds.filter((ptyId) => ptyId.length > 0))
    if (expected.size !== 1) {
      throw new Error('terminal_exact_stop_requires_single_pty')
    }
    const resolvedWorktrees = [...(await this.deps.getResolvedWorktreeMap()).values()]
    const refreshedPtyLiveness =
      await this.host.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!refreshedPtyLiveness) {
      throw new Error('terminal_liveness_unavailable')
    }
    const livePtyIds = this.host.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
    const targetOnly = opts.targetOnly === true
    const expectedIsLive = [...expected].every((ptyId) => livePtyIds.has(ptyId))
    if (targetOnly ? !expectedIsLive : !setsEqual(livePtyIds, expected)) {
      const error = Object.assign(new Error('terminal_stop_pty_set_mismatch'), {
        livePtyIds: [...livePtyIds].sort(),
        expectedPtyIds: [...expected].sort()
      })
      throw error
    }

    if (!this.deps.ptyController?.stopAndWait) {
      throw new Error('terminal_exact_stop_unavailable')
    }

    const stoppedPtyIds: string[] = []
    for (const ptyId of [...expected].sort()) {
      if (opts.keepHistory) {
        this.deps
          .intentionalHandlelessPtyStops()
          .set(ptyId, this.deps.ptysById().get(ptyId)?.incarnationId ?? null)
      }
      try {
        if (
          !(await this.deps.ptyController.stopAndWait(ptyId, { keepHistory: opts.keepHistory }))
        ) {
          throw Object.assign(new Error('terminal_exact_stop_failed'), { ptyId })
        }
      } finally {
        this.deps.intentionalHandlelessPtyStops().delete(ptyId)
      }
      stoppedPtyIds.push(ptyId)
    }
    const postStopLiveness =
      await this.host.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!postStopLiveness) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      }
    }
    const remainingLivePtyIds = this.host.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
    const stoppedTargetsStillLive = [...expected].filter((ptyId) => remainingLivePtyIds.has(ptyId))
    if (targetOnly ? stoppedTargetsStillLive.length > 0 : remainingLivePtyIds.size > 0) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_exact_stop_still_live',
        remainingLivePtyIds: [...remainingLivePtyIds].sort()
      }
    }
    return {
      stopped: stoppedPtyIds.length,
      stoppedPtyIds,
      livePtyIds: [...livePtyIds].sort(),
      postStopVerified: true,
      ...(targetOnly && remainingLivePtyIds.size > 0
        ? { remainingLivePtyIds: [...remainingLivePtyIds].sort() }
        : {})
    }
  }

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: {
      deadline?: number
      stopPty?: (
        ptyId: string,
        stop: () => boolean | Promise<boolean>
      ) => Promise<{ stopped: boolean; owner: boolean }>
      /** Authoritative id for an orphan whose selector no longer resolves. */
      resolvedWorktreeId?: string
      resolvedConnectionId?: string
      resolvedRuntimeEnvironmentId?: string
    } = {}
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.deps.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.host.resolveWorktreeSelector(worktreeSelector)
    this.deps.assertStableReadyGraph(graphEpoch)
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const ownsWorktree = options.resolvedWorktreeId
      ? (candidate: string | undefined): boolean =>
          candidate ? runtimeWorktreeIdsEqual(candidate, worktree.id) : false
      : (candidate: string | undefined): boolean => candidate === worktree.id
    const ownsHost = (ptyId: string, connectionId?: string | null): boolean => {
      if (options.resolvedRuntimeEnvironmentId !== undefined) {
        return ptyId.startsWith(
          `remote:${encodeURIComponent(options.resolvedRuntimeEnvironmentId)}@@`
        )
      }
      return (
        options.resolvedConnectionId === undefined || connectionId === options.resolvedConnectionId
      )
    }
    const ptyIds = new Set<string>()
    for (const leaf of this.deps.leaves().values()) {
      if (
        ownsWorktree(leaf.worktreeId) &&
        leaf.ptyId &&
        ownsHost(leaf.ptyId, this.deps.ptysById().get(leaf.ptyId)?.connectionId)
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.deps.ptysById().values()) {
      if (ownsWorktree(pty.worktreeId) && pty.connected && ownsHost(pty.ptyId, pty.connectionId)) {
        ptyIds.add(pty.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        break
      }
      const stop = (): boolean | Promise<boolean> => {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          return false
        }
        if (options.stopPty) {
          // Why: destructive worktree cleanup must not let its cross-surface
          // dedupe treat fire-and-forget controller.kill as physical exit.
          // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep
          // deadline so a wedged daemon yields the accurate stop failure; no deadline
          // (non-destructive) keeps the provider default RPC timeout.
          if (options.deadline !== undefined) {
            return (
              this.deps.ptyController?.stopAndWait?.(ptyId, {
                deadlineMs: teardownRpcDeadline(options.deadline)
              }) ?? false
            )
          }
          return this.deps.ptyController?.stopAndWait?.(ptyId) ?? false
        }
        return Boolean(this.deps.ptyController?.kill(ptyId))
      }
      const stopResult = options.stopPty
        ? await options.stopPty(ptyId, stop)
        : { stopped: stop(), owner: true }
      if (stopResult.owner && stopResult.stopped) {
        stopped += 1
      }
    }
    return { stopped }
  }
}
