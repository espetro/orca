import type { ApplyLayoutResult, PtyLayoutState, PtyLayoutTarget } from './runtime-contracts'
import type { RuntimeTerminalClusterDeps } from './runtime-terminal-cluster-facade'

/** Shared context for the layout command functions extracted from RuntimeTerminalCluster. */
export type RuntimeTerminalLayoutCtx = {
  deps: RuntimeTerminalClusterDeps
  enqueueLayout: typeof enqueueLayout
  runLayoutSlot: typeof runLayoutSlot
  applyLayout: typeof applyLayout
  getDriver: (ptyId: string) => { kind: string }
  getTerminalSize: (ptyId: string) => { cols: number; rows: number } | null
  resizeHeadlessTerminal: (ptyId: string, cols: number, rows: number) => void
  notifyFitOverrideListeners: (
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ) => void
  notifyTerminalResize: (
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ) => void
}

export async function applyLayout(
  ctx: RuntimeTerminalLayoutCtx,
  ptyId: string,
  target: PtyLayoutTarget
): Promise<ApplyLayoutResult> {
  // Why: re-check pty-exit at the head of the slot — the queue may have
  // accepted this target before onPtyExit ran.
  if (!ctx.deps.layouts().has(ptyId) && !ctx.deps.isFreshSubscribe(ptyId)) {
    return { ok: false, reason: 'pty-exited' }
  }

  const prev = ctx.deps.layouts().get(ptyId) ?? null
  const seq = (prev?.seq ?? 0) + 1
  const next: PtyLayoutState = { ...target, seq, appliedAt: Date.now() }

  const currentSize = ctx.getTerminalSize(ptyId)
  const dimsChanged = currentSize?.cols !== target.cols || currentSize?.rows !== target.rows
  const modeChanged = (prev?.kind ?? 'desktop') !== target.kind

  // Snapshot for rollback.
  const prevFitOverride = ctx.deps.terminalFitOverrides().get(ptyId) ?? null

  // Tentative writes — the resize is the point of no return.
  ctx.deps.layouts().set(ptyId, next)
  if (target.kind === 'phone') {
    // Why: pull baseline cols+rows atomically from the same subscriber so
    // they can't desync.
    const baseline = (() => {
      const inner = ctx.deps.mobileSubscribers().get(ptyId)
      if (!inner) {
        return null
      }
      return ctx.deps.pickEarliestRestoreTarget(inner)
    })()
    ctx.deps.terminalFitOverrides().set(ptyId, {
      mode: 'mobile-fit',
      cols: target.cols,
      rows: target.rows,
      previousCols: baseline?.previousCols ?? null,
      previousRows: baseline?.previousRows ?? null,
      updatedAt: next.appliedAt,
      clientId: target.ownerClientId
    })
  } else {
    ctx.deps.terminalFitOverrides().delete(ptyId)
  }

  if (dimsChanged) {
    let ok = false
    try {
      const r = ctx.deps.ptyController()?.resize?.(ptyId, target.cols, target.rows)
      ok = r ?? true
    } catch (err) {
      console.error('[layout] ptyController.resize threw', { ptyId, err })
      ok = false
    }
    if (!ok) {
      // Roll back to pre-call snapshot. seq is NOT bumped on the wire
      // because we never emit below.
      if (prev) {
        ctx.deps.layouts().set(ptyId, prev)
      } else {
        ctx.deps.layouts().delete(ptyId)
      }
      if (prevFitOverride) {
        ctx.deps.terminalFitOverrides().set(ptyId, prevFitOverride)
      } else {
        ctx.deps.terminalFitOverrides().delete(ptyId)
      }
      return { ok: false, reason: 'resize-failed' }
    }
    ctx.resizeHeadlessTerminal(ptyId, target.cols, target.rows)
  }

  // Why: remote desktop ownership is a fit hold for the host and passive
  // peer viewers. Emit every remote layout so owner changes at equal geometry
  // still park/release the correct clients without relying on resize deltas.
  // Defense-in-depth (#7588): also emit when the override's presence
  // changed even without a kind flip. applyLayout is the sole writer and
  // keeps override presence in lockstep with layout kind, so overrideChanged
  // ≡ modeChanged in every reachable state today; the extra clause fires
  // only if that invariant is ever violated, repairing the renderer instead
  // of stranding the held modal.
  const overrideChanged = (prevFitOverride != null) !== (target.kind === 'phone')
  if (target.kind === 'remote-desktop' || modeChanged || overrideChanged) {
    // Why: phone→desktop arms the renderer-cascade suppress window
    // before the collateral safeFit IPCs arrive. See "Renderer cascade
    // suppression".
    if (target.kind === 'desktop') {
      ctx.deps.lastRendererSizes().delete(ptyId)
      ctx.deps.suppressResizesForMs(500)
    }
    ctx.deps
      .notifier()
      ?.terminalFitOverrideChanged(
        ptyId,
        target.kind === 'phone'
          ? 'mobile-fit'
          : target.kind === 'remote-desktop'
            ? 'remote-desktop-fit'
            : 'desktop-fit',
        target.cols,
        target.rows
      )
    ctx.notifyFitOverrideListeners(
      ptyId,
      target.kind === 'phone'
        ? 'mobile-fit'
        : target.kind === 'remote-desktop'
          ? 'remote-desktop-fit'
          : 'desktop-fit',
      target.cols,
      target.rows
    )
  }

  // Mobile-facing event always fires (phone clients need to re-fit on
  // every dim change, not just mode flips).
  ctx.notifyTerminalResize(ptyId, {
    cols: target.cols,
    rows: target.rows,
    displayMode: target.kind === 'phone' ? 'phone' : 'desktop',
    reason: 'apply-layout',
    seq
  })

  return { ok: true, state: next }
}
export async function applyRemoteDesktopLayout(
  ctx: RuntimeTerminalLayoutCtx,
  ptyId: string
): Promise<boolean> {
  if (ctx.getDriver(ptyId).kind === 'mobile') {
    return true
  }
  const target = ctx.deps.activeRemoteDesktopViewport(ptyId)
  const reclaimingHost = !target
  const viewerRevision = ctx.deps.remoteDesktopViewerRevisions().get(ptyId) ?? 0
  const layoutTarget: PtyLayoutTarget = target
    ? {
        kind: 'remote-desktop',
        cols: target.cols,
        rows: target.rows,
        ownerSubscriptionKey: ctx.deps.remoteDesktopOwners().get(ptyId)!
      }
    : { kind: 'desktop', ...ctx.deps.resolveRemoteDesktopHostReclaimTarget(ptyId) }
  ctx.deps.freshSubscribeGuard().add(ptyId)
  try {
    const result = await ctx.enqueueLayout(ctx, ptyId, layoutTarget)
    // Why: only drop the recorded host size once the reclaim resize actually
    // landed. If it failed, the PTY is still at the remote-viewer width, so
    // keep the target for the next reclaim (otherwise it resolves via the
    // stale remote width and never restores true host geometry).
    if (
      reclaimingHost &&
      result.ok &&
      !ctx.deps.remoteDesktopOwners().has(ptyId) &&
      ctx.deps.remoteDesktopViewerRevisions().get(ptyId) === viewerRevision
    ) {
      ctx.deps.remoteDesktopHostReclaimTargets().delete(ptyId)
    }
    return result.ok
  } finally {
    ctx.deps.freshSubscribeGuard().delete(ptyId)
  }
}
export function enqueueLayout(
  ctx: RuntimeTerminalLayoutCtx,
  ptyId: string,
  target: PtyLayoutTarget
): Promise<ApplyLayoutResult> {
  // Why: PTY-exit short-circuit. Fresh-subscribe gate lets the very first
  // transition through even though `layouts` has no entry yet.
  if (!ctx.deps.layouts().has(ptyId) && !ctx.deps.isFreshSubscribe(ptyId)) {
    return Promise.resolve({ ok: false, reason: 'pty-exited' })
  }

  let entry = ctx.deps.layoutQueues().get(ptyId)
  if (!entry) {
    entry = { running: null, pending: [] }
    ctx.deps.layoutQueues().set(ptyId, entry)
  }
  const queue = entry

  return new Promise<ApplyLayoutResult>((resolve) => {
    if (!queue.running) {
      queue.running = ctx.runLayoutSlot(ctx, ptyId, target, [resolve])
      return
    }
    const tail = queue.pending.at(-1)
    if (tail && ctx.deps.coalescesWith(tail.target, target)) {
      tail.target = target
      tail.waiters.push(resolve)
      return
    }
    queue.pending.push({ target, waiters: [resolve] })
  })
}
export async function runLayoutSlot(
  ctx: RuntimeTerminalLayoutCtx,
  ptyId: string,
  target: PtyLayoutTarget,
  waiters: ((r: ApplyLayoutResult) => void)[]
): Promise<ApplyLayoutResult> {
  let result: ApplyLayoutResult
  try {
    result = await ctx.applyLayout(ctx, ptyId, target)
  } catch (err) {
    // Why: defensive — applyLayout itself catches resize errors, but a
    // throw from one of the synchronous map writes (e.g. notifier hook)
    // must not jam the queue forever.
    console.error('[layout] applyLayout threw', { ptyId, err })
    result = { ok: false, reason: 'resize-failed' }
  }
  for (const w of waiters) {
    w(result)
  }

  const queue = ctx.deps.layoutQueues().get(ptyId)
  if (!queue) {
    return result
  }
  const next = queue.pending.shift()
  if (next) {
    queue.running = ctx.runLayoutSlot(ctx, ptyId, next.target, next.waiters)
  } else {
    queue.running = null
    // Why: drop the entry once empty so the map doesn't grow without bound
    // across short-lived PTYs.
    ctx.deps.layoutQueues().delete(ptyId)
  }
  return result
}
