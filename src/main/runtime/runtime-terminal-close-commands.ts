import { countTerminalLayoutLeaves } from './headless-terminal-split-layout'
import type { RuntimeTerminalClose } from '../../shared/runtime-terminal-contracts'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-session-contracts'
import type { RuntimePtyWorktreeRecord, TerminalHandleRecord } from './runtime-contracts'
import type { RuntimeTerminalClusterDeps } from './runtime-terminal-cluster-facade'

export type RuntimeTerminalCloseCtx = {
  deps: RuntimeTerminalClusterDeps
  assertGraphReady(): void
  countLeavesInTab(tabId: string): number
  findMobileTerminalSurface(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null
  findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null
  getLiveLeafForHandle(handle: string): {
    leaf: { tabId: string; worktreeId: string; paneRuntimeId: number; ptyId: string | null }
  }
  getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  describeTerminalClose: typeof describeTerminalClose
  getPtyIdsForExplicitTabClose: typeof getPtyIdsForExplicitTabClose
  stopExplicitlyClosedTabPtys: typeof stopExplicitlyClosedTabPtys
}

export async function closeTerminal(
  ctx: RuntimeTerminalCloseCtx,
  handle: string
): Promise<RuntimeTerminalClose> {
  const pty = ctx.getLivePtyForHandle(handle)
  ctx.deps.claudeAgentTeams().removeTeamForLeaderHandle(handle)
  if (pty) {
    // Why: PTY exit can immediately replace a ready SSH publication with a pending one, so capture its durable HUB surface before killing it.
    const surface =
      (pty.pty.tabId ? ctx.findMobileTerminalSurface(pty.pty.worktreeId, pty.pty.tabId) : null) ??
      ctx.findMobileTerminalSurfaceForPty(pty.pty.worktreeId, pty.pty.ptyId)
    const tabId = surface?.tab.parentTabId ?? pty.pty.tabId ?? pty.record.tabId
    // Why: relay recovery can leave stale renderer leaves; the persisted HUB layout defines whether closing this PTY closes the whole surface.
    const siblingCount = surface?.tab.parentLayout
      ? countTerminalLayoutLeaves(surface.tab.parentLayout.root)
      : ctx.countLeavesInTab(tabId)
    if (
      siblingCount <= 1 &&
      surface &&
      ctx.deps.tabs().has(tabId) &&
      ctx.deps.notifier()?.closeTerminalTab
    ) {
      const ptyIdsToKill = ctx.getPtyIdsForExplicitTabClose(ctx, pty.pty.worktreeId, tabId)
      try {
        await ctx.deps.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, {
          localPtyTeardownOwnedExternally: true
        })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
          throw error
        }
        ctx.deps.notifier()!.closeTerminal?.(tabId)
      }
      const ptyKilled = await ctx.stopExplicitlyClosedTabPtys(ctx, ptyIdsToKill, pty.pty.ptyId)
      return ctx.describeTerminalClose(ctx, handle, tabId, pty.pty.ptyId, ptyKilled)
    }
    if (siblingCount <= 1 && !surface && pty.pty.tabId && ctx.deps.notifier()?.closeTerminalTab) {
      const ptyIdsToKill = ctx.getPtyIdsForExplicitTabClose(ctx, pty.pty.worktreeId, tabId)
      await ctx.deps
        .notifier()!
        .closeTerminalTab?.(tabId, { localPtyTeardownOwnedExternally: true })
      const ptyKilled = await ctx.stopExplicitlyClosedTabPtys(ctx, ptyIdsToKill, pty.pty.ptyId)
      return ctx.describeTerminalClose(ctx, handle, tabId, pty.pty.ptyId, ptyKilled)
    }
    const ptyKilled = await ctx.stopExplicitlyClosedTabPtys(ctx, [pty.pty.ptyId], pty.pty.ptyId)
    if (!ptyKilled || siblingCount <= 1) {
      if (surface) {
        // Why: paired viewers keep ended streams mounted until the HUB publishes removal, so explicit close uses the durable host-tab transaction instead of viewer-local exit handling.
        try {
          await ctx.deps.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
            throw error
          }
          ctx.deps.notifier()?.closeTerminal(tabId)
        }
      } else {
        ctx.deps.notifier()?.closeTerminal(tabId)
      }
    }
    return ctx.describeTerminalClose(ctx, handle, tabId, pty.pty.ptyId, ptyKilled)
  }
  ctx.assertGraphReady()
  const { leaf } = ctx.getLiveLeafForHandle(handle)
  // Why: in a multi-pane tab, killing the PTY is enough (renderer's exit handler closes the pane); an extra IPC close would race it and close the whole tab.
  const siblingCount = ctx.countLeavesInTab(leaf.tabId)
  const ptyIdsToKill =
    siblingCount <= 1
      ? ctx.getPtyIdsForExplicitTabClose(ctx, leaf.worktreeId, leaf.tabId)
      : leaf.ptyId
        ? [leaf.ptyId]
        : []
  if (siblingCount <= 1 && ctx.deps.notifier()?.closeTerminalTab) {
    await ctx.deps.notifier()!.closeTerminalTab?.(leaf.tabId, {
      localPtyTeardownOwnedExternally: true
    })
  }
  const ptyKilled = leaf.ptyId
    ? await ctx.stopExplicitlyClosedTabPtys(ctx, ptyIdsToKill, leaf.ptyId)
    : false
  if (siblingCount > 1 ? !ptyKilled : !ctx.deps.notifier()?.closeTerminalTab) {
    ctx.deps.notifier()?.closeTerminal(leaf.tabId, leaf.paneRuntimeId)
  }
  return ctx.describeTerminalClose(ctx, handle, leaf.tabId, leaf.ptyId ?? null, ptyKilled)
}

export async function stopExplicitlyClosedTabPtys(
  ctx: RuntimeTerminalCloseCtx,
  ptyIds: readonly string[],
  addressedPtyId: string
): Promise<boolean> {
  return ctx.deps.ptyWorktrees().stopExplicitlyClosedTabPtys(ptyIds, addressedPtyId)
}

export function describeTerminalClose(
  ctx: RuntimeTerminalCloseCtx,
  handle: string,
  tabId: string,
  ptyId: string | null,
  ptyKilled: boolean
): RuntimeTerminalClose {
  if (ptyKilled || !ptyId) {
    return { handle, tabId, ptyKilled }
  }
  const verdict = ctx.deps.getPtyLivenessVerdict(ptyId)
  if (verdict?.status === 'unverifiable') {
    return {
      handle,
      tabId,
      ptyKilled,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: verdict.reason
    }
  }
  if (verdict?.status === 'live') {
    return { handle, tabId, ptyKilled, ptyStopVerdict: 'live' }
  }
  return { handle, tabId, ptyKilled }
}

export function getPtyIdsForExplicitTabClose(
  ctx: RuntimeTerminalCloseCtx,
  worktreeId: string,
  tabId: string
): string[] {
  return ctx.deps.ptyWorktrees().getPtyIdsForExplicitTabClose(worktreeId, tabId)
}
