import { randomUUID } from 'node:crypto'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type {
  RuntimeTerminalResolvePane,
  RuntimeTerminalSplit
} from '../../shared/runtime-terminal-contracts'
import {
  ownerSurfacing,
  REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS
} from './runtime-terminal-surface-shared'
import type { RuntimePtyWorktreeRecord } from './orca-runtime'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export async function splitPtyBackedTerminal(
  ctx: Ctx,
  pty: RuntimePtyWorktreeRecord,
  opts: {
    direction?: 'horizontal' | 'vertical'
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    activate?: boolean
    // Why: same split as createTerminal — adopt the pane without revealing its
    // workspace, for splits the user never asked to see.
    surfaceOwner?: false
    telemetrySource?: TerminalPaneSplitSource
  } = {}
): Promise<RuntimeTerminalSplit> {
  if (!ctx.deps.ptyController()?.spawn) {
    throw new Error('runtime_unavailable')
  }
  if (!pty.connected) {
    throw new Error('terminal_exited')
  }
  const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
  const parentTabId = pty.tabId?.trim()
  if (!parentTabId || !parsedPaneKey) {
    throw new Error('terminal_handle_stale')
  }
  const direction = opts.direction ?? 'horizontal'
  const workspace = await ctx.resolveTerminalWorkspaceLaunchScope(`id:${pty.worktreeId}`)
  const sourceAuthority = ctx.resolveTerminalSplitSourceAuthority(
    workspace.id,
    parentTabId,
    parsedPaneKey.leafId,
    pty.ptyId
  )
  if (!sourceAuthority) {
    throw new Error('terminal_split_source_not_found')
  }
  const sourceIncarnationId =
    sourceAuthority.liveIncarnationId ?? sourceAuthority.persistedIncarnationId
  const leafId = randomUUID()
  const preAllocatedHandle = ctx.createPreAllocatedTerminalHandle()
  const paneKey = makePaneKey(parentTabId, leafId)
  const result = await ctx.deps.ptyController()!.spawn!({
    cols: 120,
    rows: 40,
    cwd: workspace.path,
    command: opts.command,
    commandDelivery: 'provider',
    env: ctx.buildTerminalWorkspaceEnv(workspace, opts.env ?? {}, paneKey, parentTabId),
    envToDelete: opts.envToDelete,
    connectionId: workspace.connectionId,
    worktreeId: workspace.id,
    preAllocatedHandle,
    tabId: parentTabId,
    leafId,
    persistHostSessionBinding: true,
    ...(sourceAuthority.persisted
      ? {
          expectedSourceBinding: {
            ...(sourceAuthority.persistedWorktreeId
              ? { worktreeId: sourceAuthority.persistedWorktreeId }
              : {}),
            tabId: parentTabId,
            leafId: parsedPaneKey.leafId,
            ptyId: pty.ptyId,
            // Why: the store can only match its own persisted map, so a live-only id it never
            // recorded would reject every split from a session restored without incarnations.
            // The live id is fenced by revalidateSourceAuthority below instead.
            ...(sourceAuthority.persistedIncarnationId
              ? { incarnationId: sourceAuthority.persistedIncarnationId }
              : {})
          }
        }
      : {})
  })
  ctx.deps.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
  if (result.wslDistro) {
    ctx.deps.preparePtyExecutionContext(result.id, result.wslDistro ?? null, {})
  }
  ctx.deps.registerPty(result.id, workspace.id, workspace.connectionId)
  const createdPty = ctx.getOrCreatePtyWorktreeRecord(result.id)
  if (createdPty) {
    createdPty.tabId = parentTabId
    createdPty.paneKey = paneKey
    createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
    ctx.deps.setPairedRendererSessionOwnership(
      createdPty.ptyId,
      ctx.deps.pairedRendererSessionOwnedPtyIds().has(pty.ptyId)
    )
  }

  const revealSplit = async (): Promise<void> => {
    await ctx.deps.notifier()?.revealTerminalSession?.(workspace.id, {
      ptyId: result.id,
      title: null,
      activate: opts.activate !== false,
      ...ownerSurfacing(opts.surfaceOwner !== false),
      tabId: parentTabId,
      leafId,
      splitFromLeafId: parsedPaneKey.leafId,
      splitDirection: direction,
      splitTelemetrySource: opts.telemetrySource
    })
  }

  try {
    const revalidateSourceAuthority = (): void => {
      const current = ctx.resolveTerminalSplitSourceAuthority(
        workspace.id,
        parentTabId,
        parsedPaneKey.leafId,
        pty.ptyId
      )
      if (
        !current ||
        (sourceAuthority.persisted && !current.persisted) ||
        (sourceIncarnationId !== null &&
          (current.liveIncarnationId ?? current.persistedIncarnationId) !== sourceIncarnationId)
      ) {
        throw new Error('terminal_split_source_not_found')
      }
    }
    revalidateSourceAuthority()
    if (!sourceAuthority.persisted) {
      await revealSplit()
      // Why: rejecting here unmounts the pane the reveal just added only because the retire
      // below always emits its exit and the tab still holds the source sibling — the renderer's
      // exit handler closes non-final panes. Never close it by tabId: that drops the whole tab.
      revalidateSourceAuthority()
    }
    if (createdPty) {
      const persisted = ctx.persistHeadlessTerminalSplit({
        worktreeId: workspace.id,
        tabId: parentTabId,
        leafId,
        ptyId: createdPty.ptyId,
        splitFromLeafId: parsedPaneKey.leafId,
        direction
      })
      if (sourceAuthority.persisted && !persisted) {
        throw new Error('workspace_session_unavailable')
      }
      ctx.publishPtyBackedMobileSessionTerminal(workspace.id, createdPty, {
        tabId: parentTabId,
        leafId,
        title: null,
        activate: opts.activate !== false,
        split: { splitFromLeafId: parsedPaneKey.leafId, direction }
      })
    }
  } catch (error) {
    ctx.deps.setPairedRendererSessionOwnership(result.id, false)
    let stopped = false
    try {
      stopped =
        (await ctx.deps.ptyController()!.stopAndWait?.(result.id, {
          deadlineMs: Date.now() + REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS
        })) ?? false
    } catch {
      // Best-effort fallback below preserves the original split authority error.
    }
    if (!stopped) {
      try {
        ctx.deps.ptyController()!.kill(result.id)
      } catch {
        // Best-effort cleanup; retirement below still runs and the original error still throws.
      }
    }
    try {
      ctx.deps.ptyController()!.retireRejectedPty?.(result.id, stopped)
    } catch {
      // Best-effort cleanup; preserve the original split authority error.
    }
    throw error
  }
  const committedSourceAuthority = sourceAuthority.persisted
    ? ctx.resolveTerminalSplitSourceAuthority(
        workspace.id,
        parentTabId,
        parsedPaneKey.leafId,
        pty.ptyId
      )
    : null
  if (sourceAuthority.persisted && committedSourceAuthority?.rendererMounted) {
    // Why: renderer adoption is a projection after the durable main commit; rejection cannot undo it.
    void revealSplit().catch(() => undefined)
  }

  return {
    handle: ctx.deps.issuePtyHandle(createdPty ?? pty),
    tabId: parentTabId,
    paneRuntimeId: -1
  }
}

export async function recoverTerminalPane(
  ctx: Ctx,
  paneKey: string,
  expectedWorktreeId: string,
  expectedHandle?: string
): Promise<RuntimeTerminalResolvePane> {
  const parsed = parsePaneKey(paneKey)
  const pty = ctx.getPtyRecordForPaneKey(paneKey)
  if (
    !parsed ||
    !pty ||
    !expectedHandle ||
    pty.worktreeId !== expectedWorktreeId ||
    ctx.getPaneKeyForTerminalHandle(expectedHandle) !== paneKey
  ) {
    throw new Error('terminal_not_found')
  }
  const recoveryKey = `${expectedWorktreeId}\0${paneKey}`
  const pending = ctx.deps.terminalPaneRecoveryByIdentity().get(recoveryKey)
  if (pending) {
    return pending
  }
  if (pty?.connected) {
    const current = ctx.resolveTerminalPane(paneKey, expectedWorktreeId)
    if (expectedHandle === undefined || current.handle !== expectedHandle) {
      return current
    }
    throw new Error('terminal_not_recoverable')
  }
  if (!ctx.getRecentExpiredSshLease(expectedWorktreeId, parsed.tabId, parsed.leafId, pty.ptyId)) {
    // Why: an explicit close leaves a terminated lease; only relay expiry authorizes shell recreation.
    throw new Error('terminal_not_recoverable')
  }
  // Why: disconnected PTYs can reissue handles during graph cleanup; only a connected replacement satisfies the pane CAS.
  const recovery = ctx
    .createTerminal(`id:${expectedWorktreeId}`, {
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      focus: false
    })
    .then((terminal) => ({
      handle: terminal.handle,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      ptyId: terminal.ptyId ?? null,
      worktreeId: expectedWorktreeId
    }))
  ctx.deps.terminalPaneRecoveryByIdentity().set(recoveryKey, recovery)
  const clearRecovery = (): void => {
    if (ctx.deps.terminalPaneRecoveryByIdentity().get(recoveryKey) === recovery) {
      ctx.deps.terminalPaneRecoveryByIdentity().delete(recoveryKey)
    }
  }
  void recovery.then(clearRecovery, clearRecovery)
  return recovery
}

export function replaceHeadlessTerminalAfterExecutionContextChange(ctx: Ctx, ptyId: string): void {
  ctx.disposeHeadlessTerminal(ptyId)
  ctx.deps.providerSnapshotPreferredPtys().add(ptyId)
  const dims = ctx.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  const state = ctx.createPtyHeadlessTerminalState(ptyId, dims)
  ctx.deps.headlessTerminals().set(ptyId, state)
  state.writeChain = state.writeChain
    .then(async () => {
      const snapshot = await ctx.serializeProviderTerminalBuffer(ptyId)
      if (!snapshot) {
        return
      }
      const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
      // Why: a newer live OSC 7 can arrive while the snapshot is in flight;
      // only seed metadata while no post-correction CWD has won the race.
      if (!ctx.deps.terminalCwdByPtyId().has(ptyId)) {
        ctx.deps.recordOsc7MetadataForPty(ptyId, data)
      }
      await state.emulator.write(data)
      if (snapshot.cwd !== undefined) {
        state.emulator.setCwd(snapshot.cwd)
        if (!ctx.deps.terminalCwdByPtyId().has(ptyId) && snapshot.cwd?.trim()) {
          ctx.deps.terminalCwdByPtyId().set(ptyId, snapshot.cwd)
        }
      }
      if (snapshot.oscLinks !== undefined) {
        state.emulator.setRestoredOscLinks(snapshot.oscLinks)
      }
      state.ownership.seedOwner(snapshot.terminalOwner, {
        alternateScreen: state.emulator.isAlternateScreen
      })
      state.outputSequence = snapshot.seq
    })
    .catch(() => {
      // Best-effort: live bytes already chain behind this replacement state.
    })
    .finally(() => {
      ctx.deps.providerSnapshotPreferredPtys().delete(ptyId)
    })
}
