import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import {
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS,
  mapExplicitAgentStateToRuntimeTerminalStatus,
  detectTerminalWaitBlockedReason
} from './runtime-tail-projection'
import { isKnownReadyPromptPreview } from './runtime-terminal-wait'
import { TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS } from './runtime-tail-shared'
import { createSetupCompletionScanner } from './orchestration/setup-completion-signal'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import type { RuntimeVisibleTerminalState, TerminalWaiter } from './orca-runtime'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export function maybeHydrateHeadlessFromRenderer(ctx: Ctx, ptyId: string): void {
  if (ctx.deps.headlessHydrationState().has(ptyId)) {
    return
  }
  const providerSnapshotPreferred = ctx.deps.providerSnapshotPreferredPtys().has(ptyId)
  if (ctx.deps.headlessTerminals().has(ptyId) && !providerSnapshotPreferred) {
    // Daemon-snapshot seed already populated the emulator — skip hydration.
    ctx.deps.headlessHydrationState().set(ptyId, 'done')
    return
  }
  const controller = ctx.deps.ptyController()
  if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
    return
  }
  if (!controller.hasRendererSerializer(ptyId)) {
    // Renderer hasn't registered yet (or never will). Live writes lazy-
    // create the state via trackHeadlessTerminalData on this same tick.
    return
  }

  if (providerSnapshotPreferred) {
    // Why: a stream byte can create a partial model before restored history
    // arrives. A mounted renderer snapshot can safely replace that model.
    ctx.disposeHeadlessTerminal(ptyId)
  }

  ctx.deps.headlessHydrationState().set(ptyId, 'pending')
  const dims = ctx.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  // Why: hydration writes below never set forwardQueryReplies (main-side
  // replay guard) — renderer-buffer snapshots can embed stale queries.
  const state = ctx.createPtyHeadlessTerminalState(ptyId, dims)
  state.outputSequence = ctx.getPtyOutputSequence(ptyId)
  ctx.deps.headlessTerminals().set(ptyId, state)

  // Why: append the seed work to writeChain so live writes queued by
  // trackHeadlessTerminalData (after this method returns synchronously)
  // execute AFTER the seed-write resolves. If we awaited inline before
  // setting headlessTerminals, the live byte would lazy-create a separate
  // state and the seed-resolve would overwrite it, dropping live bytes.
  state.writeChain = state.writeChain.then(async () => {
    try {
      const rendered = await controller.serializeBuffer!(ptyId, {
        scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
        altScreenForcesZeroRows: true
      })
      if (!rendered || rendered.data.length === 0) {
        return
      }
      ctx.deps.recordOsc7MetadataForPty(ptyId, rendered.data)
      ctx.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
      // Resize to renderer's dims so the seed reflows correctly into the
      // emulator's grid, then resize back to PTY dims (if known) so live
      // writes use the correct cell layout.
      if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
        state.emulator.resize(rendered.cols, rendered.rows)
      }
      await state.emulator.write(rendered.data)
      const ptyDims = ctx.getTerminalSize(ptyId)
      if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
        state.emulator.resize(ptyDims.cols, ptyDims.rows)
      }
      // Why: the renderer xterm no longer sees synthetic hook title frames
      // (they feed main's tracker only), so its serializer lastTitle can be
      // stale here. Prefer main's tracked title; the renderer's is only the
      // seed when main has observed none (fresh relaunch, cold tracker).
      state.ownership.seedOwner(undefined, {
        alternateScreen: state.emulator.isAlternateScreen
      })
      const seedTitle = ctx.deps.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
      if (seedTitle) {
        state.emulator.setLastTitle(seedTitle)
        ctx.applySeededAgentStatus(ptyId, seedTitle)
      }
      ctx.deps.providerSnapshotPreferredPtys().delete(ptyId)
    } catch {
      // Hydration is best-effort. Live writes continue via the same
      // writeChain that this catch-arm leaves intact.
    } finally {
      ctx.deps.headlessHydrationState().set(ptyId, 'done')
    }
  })
}

export function emitTerminalAgentStatusEvents(
  ctx: Ctx,
  ptyId: string,
  chunk: ProcessedAgentStatusChunk
): boolean {
  // Why: snapshot retention (for mobile worktree.ps) must run even when no
  // renderer listener is attached, so we don't early-return on a missing
  // onTerminalAgentStatus — only the per-target emit below is gated on it.
  if (chunk.payloads.length === 0) {
    return false
  }
  const targets = new Map<
    string,
    {
      source: 'mounted-leaf' | 'pty-record'
      paneKey: string
      tabId?: string
      worktreeId?: string
      connectionId?: string | null
    }
  >()
  const pty = ctx.deps.ptysById().get(ptyId)
  const connectionId = pty?.connectionId ?? null
  for (const leaf of ctx.getLeavesForPty(ptyId)) {
    const paneKey = ctx.makeRuntimePaneKey(leaf)
    targets.set(paneKey, {
      source: 'mounted-leaf',
      paneKey,
      tabId: leaf.tabId,
      worktreeId: leaf.worktreeId,
      connectionId
    })
  }
  if (targets.size === 0 && pty?.paneKey) {
    targets.set(pty.paneKey, {
      source: 'pty-record',
      paneKey: pty.paneKey,
      tabId: pty.tabId ?? undefined,
      worktreeId: pty.worktreeId,
      connectionId
    })
  }
  let retainedChanged = false
  for (const payload of chunk.payloads) {
    ctx.recordAgentPromptLifecycleState(
      ptyId,
      mapExplicitAgentStateToRuntimeTerminalStatus(payload.state)
    )
    for (const target of targets.values()) {
      retainedChanged =
        ctx.retainAgentRowSnapshot(
          ptyId,
          target.paneKey,
          target.worktreeId,
          target.tabId,
          target.connectionId ?? null,
          payload
        ) || retainedChanged
      if (!ctx.deps.onTerminalAgentStatus()) {
        continue
      }
      try {
        ctx.deps.onTerminalAgentStatus()?.({
          ptyId,
          ...target,
          payload
        })
      } catch (err) {
        console.error('[runtime] terminal agent status listener threw', {
          ptyId,
          paneKey: target.paneKey,
          state: payload.state,
          agentType: payload.agentType,
          err
        })
      }
    }
  }
  return retainedChanged
}

export async function readVisibleTerminalState(
  ctx: Ctx,
  ptyId: string
): Promise<RuntimeVisibleTerminalState | null> {
  if (!ctx.deps.providerSnapshotPreferredPtys().has(ptyId)) {
    return ctx.readHeadlessVisibleTerminalState(ptyId)
  }

  const generation = ctx.getPtyLifecycleGeneration(ptyId)
  const outputSequence = ctx.getPtyOutputSequence(ptyId)
  const cached = ctx.deps.providerVisibleStateByPtyId().get(ptyId)
  const trackedMode = ctx.deps.providerModeTrackersByPtyId().get(ptyId)
  if (
    cached?.generation === generation &&
    outputSequence <= cached.sequence &&
    (!trackedMode || trackedMode.isAlternateScreen === cached.isAlternateScreen)
  ) {
    return cached
  }
  if (trackedMode && !trackedMode.isAlternateScreen) {
    const headlessState = await ctx.readHeadlessVisibleTerminalState(ptyId)
    return headlessState
      ? { ...headlessState, isAlternateScreen: false }
      : {
          lines: [],
          isAlternateScreen: false,
          sequence: outputSequence,
          generation
        }
  }
  if ((ctx.deps.providerVisibleRetryAtByPtyId().get(ptyId) ?? 0) > Date.now()) {
    return null
  }

  const snapshot = await ctx.serializeProviderTerminalBuffer(
    ptyId,
    { scrollbackRows: 0 },
    { timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS }
  )
  if (!snapshot || ctx.getPtyLifecycleGeneration(ptyId) !== generation) {
    ctx.deps
      .providerVisibleRetryAtByPtyId()
      .set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
    return null
  }
  ctx.deps.providerVisibleRetryAtByPtyId().delete(ptyId)
  if (ctx.deps.providerSnapshotsWithLiveModeTransition().has(snapshot)) {
    // Why: the provider frame can predate a mode switch observed while its
    // RPC was pending; the ordered live emulator owns the post-switch grid.
    const liveState = await ctx.readHeadlessVisibleTerminalState(ptyId)
    if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
      return liveState
    }
  }
  const projection = await ctx.parseVisibleSnapshot(snapshot)
  if (
    ctx.getPtyLifecycleGeneration(ptyId) !== generation ||
    ctx.getPtyOutputSequence(ptyId) > snapshot.seq
  ) {
    return null
  }
  const visibleState: RuntimeVisibleTerminalState = {
    lines: projection.lines,
    ...(projection.draft ? { draft: projection.draft } : {}),
    isAlternateScreen: snapshot.alternateScreen ?? false,
    sequence: snapshot.seq,
    generation
  }
  ctx.deps.providerVisibleStateByPtyId().set(ptyId, visibleState)
  return visibleState
}

export async function resolveActiveTerminal(ctx: Ctx, worktreeSelector?: string): Promise<string> {
  if (ctx.deps.graphStatus() !== 'ready') {
    const targetWorktreeId = worktreeSelector
      ? (await ctx.resolveWorktreeSelector(worktreeSelector)).id
      : null
    const snapshots = targetWorktreeId
      ? [ctx.getMobileSessionTabsForWorktree(targetWorktreeId)]
      : await ctx.listAllMobileSessionTabs()
    for (const snapshot of snapshots) {
      const activeTerminal = snapshot.tabs.find(
        (tab) =>
          tab.type === 'terminal' &&
          tab.isActive &&
          tab.status === 'ready' &&
          typeof tab.terminal === 'string'
      )
      if (activeTerminal?.type === 'terminal' && activeTerminal.terminal) {
        return activeTerminal.terminal
      }
    }
    const listed = await ctx.listTerminals(worktreeSelector, undefined, {
      includeVisualLayouts: false
    })
    const first = listed.terminals[0]?.handle
    if (first) {
      return first
    }
    throw new Error('no_active_terminal')
  }
  ctx.assertGraphReady()

  const targetWorktreeId = worktreeSelector
    ? (await ctx.resolveWorktreeSelector(worktreeSelector)).id
    : null

  // Prefer the tab's activeLeafId — this is the pane the user last focused
  for (const tab of ctx.deps.tabs().values()) {
    if (targetWorktreeId && tab.worktreeId !== targetWorktreeId) {
      continue
    }
    if (!tab.activeLeafId) {
      continue
    }
    const leafKey = ctx.getLeafKey(tab.tabId, tab.activeLeafId)
    const leaf = ctx.deps.leaves().get(leafKey)
    if (leaf) {
      return ctx.issueHandle(leaf)
    }
  }

  // Fallback: any leaf in the target worktree
  for (const leaf of ctx.deps.leaves().values()) {
    if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
      continue
    }
    return ctx.issueHandle(leaf)
  }

  throw new Error('no_active_terminal')
}

export function startTuiIdleVisibleReadProbe(
  ctx: Ctx,
  waiter: TerminalWaiter,
  waiterTimeoutMs: number
): void {
  const settleMarginMs = Math.min(
    TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
    Math.max(1, Math.floor(waiterTimeoutMs / 3))
  )
  const probeTimeoutMs = Math.min(
    VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS + settleMarginMs,
    Math.max(0, waiterTimeoutMs - settleMarginMs)
  )
  const providerTimeoutMs = Math.min(
    VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
    Math.max(0, probeTimeoutMs - settleMarginMs)
  )
  // Node clamps sub-millisecond timers to 1ms, so no distinct retirement deadline exists.
  if (providerTimeoutMs < 1) {
    return
  }
  // Retire the provider before the detached probe and waiter can settle.
  void withTimeout(
    ctx.readTerminal(
      waiter.handle,
      {},
      {
        timeoutMs: providerTimeoutMs,
        retireOnTimeout: true,
        // Why: the ready banner stays in scrollback for the whole session, so
        // classifying history would call a working agent idle (#15569 review).
        visibleScreenOnly: true
      }
    ),
    probeTimeoutMs,
    null
  )
    .then((read) => {
      if (
        !read ||
        read.source !== 'screen' ||
        !ctx.deps.waitersByHandle().get(waiter.handle)?.has(waiter)
      ) {
        return
      }
      const snapshotText = read.tail.join('\n')
      const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
      if (!blockedReason && !isKnownReadyPromptPreview(snapshotText)) {
        return
      }
      // Why resolve before clearing: a stale handle throws while locating the
      // record, and a cleared interval would leave the waiter with no poll and
      // no probe — able to end only in timeout.
      const result = ctx.buildTuiIdleProbeResult(waiter.handle, blockedReason)
      if (waiter.pollInterval) {
        clearInterval(waiter.pollInterval)
        waiter.pollInterval = null
      }
      ctx.resolveWaiter(waiter, result)
    })
    .catch(() => {})
}

export async function waitForSetupTerminalCompletion(
  ctx: Ctx,
  handle: string
): Promise<{ exitCode: number | null }> {
  const ptyId = ctx.getLivePtyForHandle(handle)?.pty.ptyId
  if (!ptyId) {
    throw new Error('terminal_handle_stale')
  }
  const completionToken = ctx.deps.setupCompletionTokenByPtyId().get(ptyId)
  const exitAbort = new AbortController()
  return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    const cleanup = (): void => {
      unsubscribe?.()
      exitAbort.abort()
    }
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      ctx.deps.setupCompletionTokenByPtyId().delete(ptyId)
      resolve({ exitCode })
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const scanner = completionToken ? createSetupCompletionScanner(completionToken, finish) : null

    if (scanner) {
      unsubscribe = ctx.subscribeToTerminalData(ptyId, scanner.scan)
    }
    // Why: setup can finish before the observer is registered on fast local worktrees.
    const replay = ctx.deps.recentPtyOutputById().get(ptyId)?.read()
    if (scanner && replay) {
      scanner.scan(replay)
    }
    if (!settled) {
      void ctx
        .waitForTerminal(handle, {
          condition: 'exit',
          signal: exitAbort.signal
        })
        .then((wait) => {
          if (wait.satisfied && wait.condition === 'exit' && wait.status === 'exited') {
            finish(wait.exitCode)
          }
        })
        .catch(fail)
    }
  })
}

export async function reclaimTerminalForDesktop(ctx: Ctx, ptyId: string): Promise<boolean> {
  ctx.cancelPendingDriverMutations(ptyId)
  if (ctx.isMobileSubscriberActive(ptyId)) {
    ctx.setMobileDisplayMode(ptyId, 'desktop')
    await ctx.applyMobileDisplayMode(ptyId)
    ctx.releaseDesktopTakeBack(ptyId)
    // Why: a desktop-initiated reclaim is "I'm taking over right now", not a
    // sticky preference. The next mobile subscribe (e.g. user switches back to
    // the terminal tab on the phone) must default to phone-fit again, not stay
    // in passive desktop-watch mode.
    ctx.setMobileDisplayMode(ptyId, 'auto')
    if (ctx.hasRemoteDesktopLayoutState(ptyId)) {
      // Why: the lock is already released above, so this re-layout is
      // best-effort. Reporting its `ok` would tell the desktop "nothing was
      // reclaimed" and cost the caller its post-take-back refit and focus.
      await ctx.applyRemoteDesktopLayout(ptyId)
    }
    return true
  }
  const heldOverride = ctx.deps.terminalFitOverrides().get(ptyId)
  if (heldOverride && ctx.hasRemoteDesktopLayoutState(ptyId)) {
    // Why: applyRemoteDesktopLayout no-ops while the driver still reads mobile.
    ctx.setDriver(ptyId, { kind: 'idle' })
    // Why: best-effort, like the local held branch below. A host whose resize
    // keeps failing (dropped SSH/WSL provider, exited PTY) would otherwise
    // roll the lock back and leave the banner stranded, making every retry a
    // no-op — the one branch that broke this method's release guarantee.
    await ctx.applyRemoteDesktopLayout(ptyId)
    ctx.releaseDesktopTakeBack(ptyId)
    ctx.setMobileDisplayMode(ptyId, 'auto')
    return true
  }
  if (heldOverride) {
    // Why: with no subscribers, resolveDesktopRestoreTarget can fall through
    // to current PTY size — which is at phone dims (wrong). Prefer a fresh
    // desktop renderer measurement when one exists; otherwise use the
    // override's pre-fit baseline before falling back to current size.
    const fallback = ctx.resolveDesktopRestoreTarget(ptyId)
    const renderer = ctx.deps.lastRendererSizes().get(ptyId)
    const cols = renderer?.cols ?? heldOverride.previousCols ?? fallback.cols
    const rows = renderer?.rows ?? heldOverride.previousRows ?? fallback.rows
    await ctx.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    ctx.releaseDesktopTakeBack(ptyId)
    ctx.setMobileDisplayMode(ptyId, 'auto')
    return true
  }
  // Why: a stale lock — driver still reads mobile with no active subscriber
  // and no held override (e.g. reclaimed inside the soft-leave grace, or a
  // subscriber that dropped without a clean unsubscribe). Release it so the
  // banner can't linger; there is nothing to resize.
  if (ctx.getDriver(ptyId).kind === 'mobile') {
    ctx.releaseDesktopTakeBack(ptyId)
    return true
  }
  return false
}
