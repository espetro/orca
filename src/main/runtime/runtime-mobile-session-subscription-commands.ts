/* eslint-disable max-lines -- Why: code moved verbatim from runtime-mobile-session-facade.ts; splitting further would scatter one command surface */
// Mobile subscriber presence: input floor, viewport/phone-fit, subscribe/unsubscribe, display-mode flips.
import type { ApplyLayoutResult, DriverState } from './orca-runtime'
import {
  MOBILE_AUTO_RESTORE_FIT_MAX_MS,
  MOBILE_AUTO_RESTORE_FIT_MIN_MS
} from './runtime-tail-projection'
import { clampTerminalViewport } from './runtime-worktree-git-shared'
import type { RuntimeMobileSessionFacadeCtx } from './runtime-mobile-session-facade-ctx'

export function markMobileActor(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string
): void {
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  const sub = inner?.get(clientId)
  if (sub) {
    sub.lastActedAt = Date.now()
  }
  ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId })
}

export function beginMobileInputFloor(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string
): { commit: () => Promise<void>; rollback: () => void } | null {
  // Why: admit a client still inside its soft-leave grace (mirrors
  // mobileTookFloor) so a write landing in that window reserves the floor
  // instead of being dropped; post-grace/orphaned writers stay rejected.
  const softLeaver = ctx.deps.pendingSoftLeavers().get(ptyId)
  if (
    !ctx.deps.mobileSubscribers().get(ptyId)?.has(clientId) &&
    softLeaver?.clientId !== clientId
  ) {
    return null
  }
  const state = ctx.mobileInputFloorClaims.get(ptyId) ?? {
    base: ctx.deps.getDriver(ptyId),
    generation: 0,
    committedGeneration: 0,
    pending: new Map<symbol, { clientId: string; generation: number }>()
  }
  ctx.mobileInputFloorClaims.set(ptyId, state)
  const token = Symbol('mobile-input-floor')
  const generation = ++state.generation
  state.pending.set(token, { clientId, generation })
  ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId })
  let settled = false
  return {
    commit: async () => {
      if (settled) {
        return
      }
      settled = true
      state.pending.delete(token)
      // Why: a newer accepted write owns the floor; an older claim that was
      // delayed before commit must not replace its rollback baseline or driver.
      if (generation < state.committedGeneration) {
        if (state.pending.size === 0 && ctx.mobileInputFloorClaims.get(ptyId) === state) {
          ctx.mobileInputFloorClaims.delete(ptyId)
        }
        return
      }
      const previousFloor = state.base
      // Why: a successful write becomes the rollback baseline for any
      // overlapping reservations that have not reached the PTY yet.
      state.committedGeneration = generation
      state.base = { kind: 'mobile', clientId }
      await mobileTookFloor(
        ctx,
        ptyId,
        clientId,
        previousFloor,
        () =>
          ctx.mobileInputFloorClaims.get(ptyId) === state &&
          state.committedGeneration === generation
      )
      if (state.pending.size === 0 && ctx.mobileInputFloorClaims.get(ptyId) === state) {
        ctx.mobileInputFloorClaims.delete(ptyId)
      }
    },
    rollback: () => {
      if (settled) {
        return
      }
      settled = true
      state.pending.delete(token)
      if (ctx.mobileInputFloorClaims.get(ptyId) !== state) {
        return
      }
      const current = ctx.deps.getDriver(ptyId)
      if (current.kind === 'mobile' && current.clientId === clientId) {
        const pendingClientId = Array.from(state.pending.values()).at(-1)?.clientId
        ctx.deps.setDriver(
          ptyId,
          pendingClientId ? { kind: 'mobile', clientId: pendingClientId } : state.base
        )
      }
      if (state.pending.size === 0) {
        ctx.mobileInputFloorClaims.delete(ptyId)
      }
    }
  }
}

export async function mobileTookFloor(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string,
  previousFloor?: DriverState,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  const sub = inner?.get(clientId)
  const softLeaver = ctx.deps.pendingSoftLeavers().get(ptyId)
  // Why: native chat pauses terminal output, so its later sends have no
  // subscriber lifecycle that could release a newly-created desktop lock.
  if (!sub && softLeaver?.clientId !== clientId) {
    return
  }
  if (sub) {
    sub.lastActedAt = Date.now()
  }
  const prev = previousFloor ?? ctx.deps.getDriver(ptyId)
  const currentMode = ctx.mobileDisplayModes.get(ptyId)
  // Why: a deliberate mobile action implies mobile is resuming control.
  // If the display mode is currently 'desktop' (set by an earlier
  // take-back), flip it back to 'auto' (= map absence) and re-apply so
  // phone-fit takes hold again. See docs/mobile-presence-lock.md.
  if (prev.kind === 'desktop' || currentMode === 'desktop') {
    if (currentMode === 'desktop') {
      ctx.mobileDisplayModes.delete(ptyId)
    }
    await applyMobileDisplayMode(ctx, ptyId)
  }
  // Why: display changes are async; a later PTY write must keep the floor
  // when an older phone-fit operation eventually completes.
  if (!isCurrent()) {
    return
  }
  ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId })
}

export async function updateMobileViewport(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string,
  viewport: { cols: number; rows: number }
): Promise<{ updated: boolean; applied: boolean }> {
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  const sub = inner?.get(clientId)
  if (!sub) {
    return { updated: false, applied: false }
  }
  sub.viewport = viewport
  sub.lastActedAt = Date.now()

  const mode = getMobileDisplayMode(ctx, ptyId)
  if (mode === 'desktop') {
    // Watching at desktop dims — viewport is informational only.
    return { updated: true, applied: false }
  }
  // Why: a desktop take-back is released only by a deliberate mobile gesture
  // (mobileTookFloor / setDisplayMode / fresh subscribe). A passive viewport report
  // — iOS resume and every reconnect force one — must not re-phone-fit and re-take
  // the floor, or the take-back looks like a no-op to the desktop user.
  if (ctx.deps.getDriver(ptyId).kind === 'desktop') {
    return { updated: true, applied: false }
  }
  // Drive PTY dims by the most-recent-actor (just updated to this client).
  const winner = ctx.deps.pickMostRecentActor(inner!)
  if (!winner) {
    return { updated: false, applied: false }
  }
  const winnerSub = inner!.get(winner.clientId)
  const driveViewport = winnerSub?.viewport ?? viewport
  const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
    driveViewport.cols,
    driveViewport.rows
  )

  sub.wasResizedToPhone = true
  // The driver is already mobile{this client} when we got here; refresh
  // to update lastActedAt-based ordering on later actor selection.
  ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId })

  const needsFreshSubscribeGuard = !ctx.deps.layouts().has(ptyId)
  if (needsFreshSubscribeGuard) {
    ctx.deps.freshSubscribeGuard().add(ptyId)
  }
  let result: ApplyLayoutResult
  try {
    result = await ctx.deps.enqueueLayout(ptyId, {
      kind: 'phone',
      cols: clampedCols,
      rows: clampedRows,
      ownerClientId: winner.clientId
    })
  } finally {
    if (needsFreshSubscribeGuard) {
      ctx.deps.freshSubscribeGuard().delete(ptyId)
    }
  }
  return { updated: true, applied: result.ok }
}

export function getMobileAutoRestoreFitMs(ctx: RuntimeMobileSessionFacadeCtx): number | null {
  return ctx.deps.getAutoRestoreFitMs()
}

export function setMobileAutoRestoreFitMs(
  ctx: RuntimeMobileSessionFacadeCtx,
  ms: number | null
): number | null {
  if (!ctx.deps.store()?.updateSettings) {
    return ctx.deps.getAutoRestoreFitMs()
  }
  let normalized: number | null
  if (ms == null) {
    normalized = null
  } else if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    normalized = null
  } else {
    normalized = Math.min(
      Math.max(ms, MOBILE_AUTO_RESTORE_FIT_MIN_MS),
      MOBILE_AUTO_RESTORE_FIT_MAX_MS
    )
  }
  ctx.deps
    .store()!
    .updateSettings?.({ mobileAutoRestoreFitMs: normalized }, { notifyListeners: true })
  if (normalized == null) {
    ctx.deps.cancelAllPendingFitRestoreTimers()
  }
  return normalized
}

export function setMobileDisplayMode(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  mode: 'auto' | 'desktop'
): void {
  if (mode === 'auto') {
    ctx.mobileDisplayModes.delete(ptyId)
  } else {
    ctx.mobileDisplayModes.set(ptyId, mode)
  }
}

export function getMobileDisplayMode(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string
): 'auto' | 'desktop' {
  return ctx.mobileDisplayModes.get(ptyId) ?? 'auto'
}

export function isMobileSubscriberActive(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string
): boolean {
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  return inner !== undefined && inner.size > 0
}

export function updateMobileSubscriberViewport(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string,
  viewport: { cols: number; rows: number }
): void {
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  const record = inner?.get(clientId)
  if (!record) {
    return
  }
  record.viewport = viewport
}

export async function handleMobileSubscribe(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string,
  viewport?: { cols: number; rows: number }
): Promise<boolean> {
  try {
    return await handleMobileSubscribeInternal(ctx, ptyId, clientId, viewport)
  } finally {
    // Every subscribe path mutates mobileSubscribers — resync the daemon
    // background mark once, whatever branch returned.
    ctx.deps.notifyRemoteTerminalViewPresenceChanged(ptyId)
  }
}

export async function handleMobileSubscribeInternal(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string,
  viewport?: { cols: number; rows: number }
): Promise<boolean> {
  const mode = getMobileDisplayMode(ctx, ptyId)

  // Cancel pending restore timer for this ptyId — any new subscriber
  // supersedes any old client's pending restore.
  const pendingRestore = ctx.deps.pendingRestoreTimers().get(ptyId)
  if (pendingRestore) {
    clearTimeout(pendingRestore.timer)
    ctx.deps.pendingRestoreTimers().delete(ptyId)
  }

  // Resubscribe-grace honor: same client returning within soft-leave
  // window restores prior record (preserving baseline so we don't capture
  // phone-fitted dims as the new baseline).
  const softLeaver = ctx.deps.pendingSoftLeavers().get(ptyId)
  if (softLeaver && softLeaver.clientId === clientId) {
    clearTimeout(softLeaver.timer)
    ctx.deps.pendingSoftLeavers().delete(ptyId)
    let inner = ctx.deps.mobileSubscribers().get(ptyId)
    if (!inner) {
      inner = new Map()
      ctx.deps.mobileSubscribers().set(ptyId, inner)
    }
    inner.set(clientId, {
      ...softLeaver.record,
      viewport: viewport ?? null,
      lastActedAt: Date.now()
    })
    if (!viewport) {
      return false
    }
    ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId })
    if (mode !== 'desktop') {
      const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
        viewport.cols,
        viewport.rows
      )
      ctx.deps.freshSubscribeGuard().add(ptyId)
      try {
        await ctx.deps.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        ctx.deps.freshSubscribeGuard().delete(ptyId)
      }
    }
    return true
  }

  let inner = ctx.deps.mobileSubscribers().get(ptyId)
  if (!inner) {
    inner = new Map()
    ctx.deps.mobileSubscribers().set(ptyId, inner)
  }

  // Capture restore baseline BEFORE applyLayout writes the override.
  // Multi-mobile: peer joiner against an already-fitted PTY captures null
  // — the existing baseline-holder's snapshot remains canonical. See
  // docs/mobile-presence-lock.md.
  //
  // Resubscribe-after-indefinite-hold: the held override carries the only
  // authoritative pre-fit dims across the no-subscriber gap. Inherit it
  // first; otherwise rendererSize/currentSize would be the held phone dims
  // and applyLayout would clobber the override's previousCols with phone
  // dims, making any subsequent Restore a no-op.
  const heldOverride = ctx.deps.terminalFitOverrides().get(ptyId)
  const existing = inner.get(clientId)
  const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
  const currentSize = ctx.deps.getTerminalSize(ptyId)
  const rendererSize = ctx.deps.lastRendererSizes().get(ptyId)
  const previousCols =
    existing?.previousCols ??
    heldOverride?.previousCols ??
    (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
  const previousRows =
    existing?.previousRows ??
    heldOverride?.previousRows ??
    (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
  const now = Date.now()
  const subscribedAt = existing?.subscribedAt ?? now

  if (!viewport) {
    // Why: mobile can subscribe before its WebView has measured. Keep the
    // subscriber + desktop baseline so updateViewport/setDisplayMode can
    // late-bind the viewport without recapturing phone dims.
    inner.set(clientId, {
      clientId,
      viewport: null,
      wasResizedToPhone: false,
      previousCols,
      previousRows,
      subscribedAt,
      lastActedAt: now
    })
    return false
  }

  const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
    viewport.cols,
    viewport.rows
  )

  if (mode === 'desktop') {
    // Passive watch — null baseline (we'll capture later if user toggles
    // to auto/phone, since safeFit will have converged by then). Do not
    // flip driver.
    inner.set(clientId, {
      clientId,
      viewport,
      wasResizedToPhone: false,
      previousCols: null,
      previousRows: null,
      subscribedAt,
      lastActedAt: now
    })
    return false
  }

  inner.set(clientId, {
    clientId,
    viewport,
    wasResizedToPhone: true,
    previousCols,
    previousRows,
    subscribedAt,
    lastActedAt: now
  })

  // Subscribe-fresh with auto/phone counts as "take the floor".
  ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId })

  // Route the actual resize through the state machine. The fresh-subscribe
  // gate lets enqueueLayout's "no layouts entry" short-circuit pass on
  // the very first transition for this PTY.
  ctx.deps.freshSubscribeGuard().add(ptyId)
  try {
    await ctx.deps.enqueueLayout(ptyId, {
      kind: 'phone',
      cols: clampedCols,
      rows: clampedRows,
      ownerClientId: clientId
    })
  } finally {
    ctx.deps.freshSubscribeGuard().delete(ptyId)
  }

  return true
}

export function handleMobileUnsubscribe(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  clientId: string
): void {
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  if (!inner) {
    return
  }
  const subscriber = inner.get(clientId)
  if (!subscriber) {
    return
  }
  const wasResizedToPhone = subscriber.wasResizedToPhone

  inner.delete(clientId)
  ctx.deps.notifyRemoteTerminalViewPresenceChanged(ptyId)

  if (inner.size > 0) {
    // Why: if the leaving client was the only one with a non-null restore
    // baseline (typical when peer joiners subscribed against an
    // already-phone-fitted PTY and got null prevCols), donate the baseline
    // to the earliest surviving subscriber so a future last-leaver can
    // still restore correctly. See docs/mobile-presence-lock.md.
    if (
      subscriber.previousCols != null &&
      subscriber.previousRows != null &&
      !ctx.deps.pickEarliestRestoreTarget(inner)
    ) {
      let earliestSurvivor: { clientId: string; subscribedAt: number } | null = null
      for (const sub of inner.values()) {
        if (earliestSurvivor === null || sub.subscribedAt < earliestSurvivor.subscribedAt) {
          earliestSurvivor = { clientId: sub.clientId, subscribedAt: sub.subscribedAt }
        }
      }
      if (earliestSurvivor) {
        const heir = inner.get(earliestSurvivor.clientId)
        if (heir) {
          heir.previousCols = subscriber.previousCols
          heir.previousRows = subscriber.previousRows
        }
      }
    }
    // Peers still on the line. If the disconnecting client was the active
    // mobile driver, re-elect the most-recent surviving subscriber so the
    // banner remains correct and active phone-fit dims follow them.
    const driver = ctx.deps.getDriver(ptyId)
    if (driver.kind === 'mobile' && driver.clientId === clientId) {
      const next = ctx.deps.pickMostRecentActor(inner)
      if (next) {
        ctx.deps.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
        // Fire-and-forget — handleMobileUnsubscribe stays sync; applyLayout
        // failures self-recover on the next gesture.
        void applyMobileDisplayMode(ctx, ptyId)
      }
    }
    return
  }

  // Last subscriber leaving — clean up.
  ctx.deps.mobileSubscribers().delete(ptyId)
  const mode = getMobileDisplayMode(ctx, ptyId)

  // Resubscribe-grace: hold driver=mobile{clientId} for ~250ms so a quick
  // re-subscribe (older clients without updateViewport) doesn't flash the
  // desktop banner. See docs/mobile-presence-lock.md.
  const SOFT_LEAVE_GRACE_MS = 250
  const existingSoft = ctx.deps.pendingSoftLeavers().get(ptyId)
  if (existingSoft) {
    clearTimeout(existingSoft.timer)
    ctx.deps.pendingSoftLeavers().delete(ptyId)
  }
  const softTimer = setTimeout(() => {
    ctx.deps.pendingSoftLeavers().delete(ptyId)
    if (!ctx.deps.mobileSubscribers().has(ptyId)) {
      ctx.deps.setDriver(ptyId, { kind: 'idle' })
      if (ctx.deps.hasRemoteDesktopViewers(ptyId)) {
        void ctx.deps.applyRemoteDesktopLayout(ptyId)
      }
    }
  }, SOFT_LEAVE_GRACE_MS)
  if (typeof softTimer.unref === 'function') {
    softTimer.unref()
  }
  ctx.deps.pendingSoftLeavers().set(ptyId, {
    clientId,
    timer: softTimer,
    record: {
      clientId: subscriber.clientId,
      viewport: subscriber.viewport,
      wasResizedToPhone: subscriber.wasResizedToPhone,
      previousCols: subscriber.previousCols,
      previousRows: subscriber.previousRows,
      subscribedAt: subscriber.subscribedAt,
      lastActedAt: subscriber.lastActedAt
    }
  })

  if (mode === 'auto' && wasResizedToPhone) {
    const existingTimer = ctx.deps.pendingRestoreTimers().get(ptyId)
    if (existingTimer) {
      clearTimeout(existingTimer.timer)
      ctx.deps.pendingRestoreTimers().delete(ptyId)
    }
    // Why: scheduling is conditional on the user's mobileAutoRestoreFitMs
    // preference. `null` (default, "Indefinite") leaves the PTY at phone
    // dims until the user clicks Restore on the desktop banner — the
    // central UX promise of docs/mobile-fit-hold.md. A finite value runs
    // the restore that long after the last unsubscribe.
    const autoRestoreMs = ctx.deps.getAutoRestoreFitMs()
    if (autoRestoreMs == null) {
      // Indefinite hold: the fit override persists, the SOFT_LEAVE_GRACE
      // driver-state grace above still releases the input lock, and the
      // banner's Restore button is the explicit return path.
    } else {
      // Snapshot the disconnecting subscriber's baseline NOW, before the
      // timer fires. By the time the timer runs, the subscriber map has
      // been deleted; resolveDesktopRestoreTarget would fall through to
      // lastRendererSizes → current PTY size (which is at phone dims,
      // wrong). The disconnecting subscriber's baseline is the correct
      // restore target.
      const fallback = ctx.deps.lastRendererSizes().get(ptyId)
      const restoreCols =
        subscriber.previousCols ?? fallback?.cols ?? ctx.deps.getTerminalSize(ptyId)?.cols ?? 80
      const restoreRows =
        subscriber.previousRows ?? fallback?.rows ?? ctx.deps.getTerminalSize(ptyId)?.rows ?? 24
      const timer = setTimeout(() => {
        ctx.deps.pendingRestoreTimers().delete(ptyId)
        if (isMobileSubscriberActive(ctx, ptyId)) {
          return
        }
        if (ctx.deps.hasRemoteDesktopLayoutState(ptyId)) {
          void ctx.deps.applyRemoteDesktopLayout(ptyId)
          return
        }
        void ctx.deps.enqueueLayout(ptyId, {
          kind: 'desktop',
          cols: restoreCols,
          rows: restoreRows
        })
      }, autoRestoreMs)
      // Why: a delayed mobile restore should not keep Electron main alive
      // after the last window/runtime transport has otherwise shut down.
      if (typeof timer.unref === 'function') {
        timer.unref()
      }

      ctx.deps.pendingRestoreTimers().set(ptyId, { timer, clientId })
    }
  }
  // 'desktop' mode: was never resized, nothing to restore.
}

export async function applyMobileDisplayMode(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string
): Promise<boolean> {
  const mode = getMobileDisplayMode(ctx, ptyId)
  const inner = ctx.deps.mobileSubscribers().get(ptyId)
  const subscriber = inner ? ctx.deps.pickMostRecentActor(inner) : null
  const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

  if (mode === 'desktop') {
    // Reset wasResizedToPhone on every fitted subscriber so a future
    // toggle back to auto re-issues the resize. applyLayout owns the
    // actual PTY resize + override delete + renderer notify. Track which
    // subscribers we cleared so a failed resize can re-arm them.
    const clearedFitSubscribers = inner
      ? [...inner.values()].filter((sub) => sub.wasResizedToPhone)
      : []
    for (const sub of clearedFitSubscribers) {
      sub.wasResizedToPhone = false
    }
    const anyWasResized = clearedFitSubscribers.length > 0
    // Why (#7588): also restore when a fit-override is still held but no
    // subscriber carries wasResizedToPhone — e.g. a null-viewport resubscribe
    // after an indefinite hold resets the flag yet leaves the override,
    // stranding the desktop "phone size" modal. Reuse resolveDesktopRestoreTarget
    // (the same resolver the anyWasResized branch uses) so the two adjacent
    // restore paths can never resolve to different dims for the same state.
    if (anyWasResized || ctx.deps.terminalFitOverrides().has(ptyId)) {
      const restore = ctx.deps.resolveDesktopRestoreTarget(ptyId)
      const result = await ctx.deps.enqueueLayout(ptyId, {
        kind: 'desktop',
        cols: restore.cols,
        rows: restore.rows
      })
      // Why (#7588): a failed resize rolls the override back (still held), so
      // re-arm the flags we cleared. Otherwise a later unsubscribe under a
      // finite mobileAutoRestoreFitMs would see wasResizedToPhone=false, skip
      // scheduling its auto-restore timer, and strand the held phone-fit.
      if (!result.ok) {
        for (const sub of clearedFitSubscribers) {
          sub.wasResizedToPhone = true
        }
      }
    } else {
      // Nothing was fitted or held — emit a mode-change resize event so
      // the mobile client still learns the toggle landed.
      const size = ctx.deps.getTerminalSize(ptyId)
      ctx.deps.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'desktop',
        reason: 'mode-change',
        seq: ctx.deps.layouts().get(ptyId)?.seq
      })
    }
  } else {
    // mode === 'auto' — the only non-desktop mode after the 'phone'
    // (sticky-fit) collapse. Phone-fit if the active subscriber has a
    // viewport and we haven't already applied it.
    if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
      const viewport = subscriberRecord.viewport
      if (viewport) {
        await handleMobileSubscribe(ctx, ptyId, subscriberRecord.clientId, viewport)
        // After a phone-fit an override IS held, so this reports false. The
        // auto branch is never reached from reclaim (it sets 'desktop'
        // first); computed here only to keep the post-condition uniform.
        return !ctx.deps.terminalFitOverrides().has(ptyId)
      }
    }
    // Why: always emit the mode change even when no resize occurred — the
    // mobile client needs to learn the toggle landed even if dims didn't
    // actually change. Carry the current seq (or undefined if no layout
    // entry yet) so the mobile-side stale-event filter behaves correctly.
    const size = ctx.deps.getTerminalSize(ptyId)
    ctx.deps.notifyTerminalResize(ptyId, {
      cols: size?.cols ?? 0,
      rows: size?.rows ?? 0,
      displayMode: 'auto',
      reason: 'mode-change',
      seq: ctx.deps.layouts().get(ptyId)?.seq
    })
  }
  return !ctx.deps.terminalFitOverrides().has(ptyId)
}
