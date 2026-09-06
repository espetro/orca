/* eslint-disable max-lines -- Why: code moved verbatim from runtime-mobile-session-facade.ts; splitting further would scatter one command surface */
// Mobile terminal creation: idempotent create, agent launch resolution, runtime-owned and renderer-rescued surfaces, pty-backed publication.
import { randomUUID } from 'node:crypto'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type {
  PtyControllerInventory,
  RuntimePtyWorktreeRecord,
  TerminalWorkspaceLaunchScope
} from './orca-runtime'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'

import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { MOBILE_TERMINAL_CREATE_RESULT_TTL_MS } from './orca-runtime'
import {
  MOBILE_TERMINAL_READY_FALLBACK_MS,
  MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
  isClientDisconnectedError
} from './runtime-terminal-surface-shared'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { getLatestPtyTitle, runtimeWorktreeIdsEqual } from './runtime-tail-projection'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { navigationTargetsHost } from '../../shared/runtime-navigation'
import { normalizeCompatibleAgentTitleForOwner } from '../../shared/agent-title-owner'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import {
  applyMobileSessionTabNavigation,
  getMobileSessionTabsForWorktree
} from './runtime-mobile-session-tab-sync-commands'
import { toMobileSessionTabsResult } from './runtime-mobile-session-tabs-projection'
import type { RuntimeMobileSessionFacadeCtx } from './runtime-mobile-session-facade-ctx'

export async function createMobileSessionTerminal(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeSelector: string,
  opts: {
    afterTabId?: string
    targetGroupId?: string
    command?: string
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    agent?: TuiAgent
    agentPrompt?: string
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
    viewMode?: 'terminal' | 'chat'
    activate?: boolean
    select?: boolean
    clientNavigationId?: string
    navigation?: RuntimeNavigationTarget
    clientMutationId?: string
    signal?: AbortSignal
  } = {}
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const navigation = opts.navigation ?? 'all'
  const select = opts.select ?? opts.activate !== false
  const runOpts = {
    ...opts,
    activate: select && navigationTargetsHost(navigation)
  }
  const mutationId = opts.clientMutationId
  let result: RuntimeMobileSessionCreateTerminalResult
  if (!mutationId) {
    result = await runCreateMobileSessionTerminal(ctx, worktreeSelector, runOpts)
  } else {
    // Why: idempotency is caller-owned; two paired devices may reuse the same mutation id without sharing a result.
    const mutationKey = `${opts.clientNavigationId ?? 'local'}\0${worktreeSelector}\0${mutationId}`
    // Why: a retried create (double-tap, reconnect replay) with the same
    // idempotency key must return the in-flight operation instead of spawning a
    // duplicate terminal. Successes are kept briefly so a retry whose response
    // was lost in transit reuses the created terminal; failures are dropped
    // immediately so a retry can start a fresh create.
    const inflight = ctx.mobileTerminalCreateByMutationId.get(mutationKey)
    const run = inflight ?? runCreateMobileSessionTerminal(ctx, worktreeSelector, runOpts)
    if (!inflight) {
      ctx.mobileTerminalCreateByMutationId.set(mutationKey, run)
      const drop = (): void => {
        if (ctx.mobileTerminalCreateByMutationId.get(mutationKey) === run) {
          ctx.mobileTerminalCreateByMutationId.delete(mutationKey)
        }
      }
      void run.then(() => {
        setTimeout(drop, MOBILE_TERMINAL_CREATE_RESULT_TTL_MS).unref?.()
      }, drop)
    }
    result = await run
  }
  if (select) {
    const worktreeId =
      ctx.deps.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
      (await ctx.deps.resolveWorktreeSelector(worktreeSelector)).id
    applyMobileSessionTabNavigation(
      ctx,
      getMobileSessionTabsForWorktree(ctx, worktreeId),
      result.tab.id,
      navigation,
      opts.clientNavigationId
    )
  }
  return result
}

export async function runCreateMobileSessionTerminal(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeSelector: string,
  opts: {
    afterTabId?: string
    targetGroupId?: string
    command?: string
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    agent?: TuiAgent
    agentPrompt?: string
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
    viewMode?: 'terminal' | 'chat'
    activate?: boolean
    clientNavigationId?: string
    clientMutationId?: string
    signal?: AbortSignal
  } = {}
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const pairedCreate = Boolean(opts.clientNavigationId)
  const graphEpoch = ctx.deps.captureReadyGraphEpoch()
  const workspace = await ctx.deps.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
  const worktreeId = workspace.id
  const cwd = ctx.deps.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
  ctx.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
  let afterDesktopTabId: string | undefined
  if (opts.afterTabId) {
    const snapshot = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
    const anchor = snapshot?.tabs.find((tab) => tab.id === opts.afterTabId)
    if (!anchor) {
      throw new Error('after_tab_not_found')
    }
    afterDesktopTabId = anchor.type === 'terminal' ? anchor.parentTabId : anchor.id
  }
  const startupCommand = await resolveMobileSessionTerminalCommand(ctx, workspace, opts)
  ctx.deps.assertStableReadyGraph(graphEpoch)
  if (opts.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  const win = ctx.deps.getAvailableAuthoritativeWindow()
  if (!win) {
    return await createRuntimeOwnedMobileSessionTerminal(
      ctx,
      worktreeId,
      opts.activate !== false,
      opts.afterTabId,
      {
        command: startupCommand.command,
        cwd,
        env: startupCommand.env,
        envToDelete: startupCommand.envToDelete,
        startupCommandDelivery: startupCommand.startupCommandDelivery,
        launchAgent: startupCommand.launchAgent,
        viewMode: opts.viewMode,
        targetGroupId: opts.targetGroupId,
        launchConfig: startupCommand.launchConfig,
        signal: opts.signal
      }
    )
  }
  if (win.webContents.isDestroyed?.()) {
    throw new Error('runtime_unavailable')
  }
  const releasePublicationThrottle = pairedCreate
    ? ctx.deps.rendererPublicationThrottle().acquire(win.webContents)
    : () => {}
  try {
    const requestId = randomUUID()
    const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
        opts.signal?.removeEventListener('abort', onAbort)
        reject(new Error('Terminal creation timed out'))
      }, 10_000)
      // Why: a dead client connection cancels the wait; the renderer tab (and
      // its shell) stays alive for the host and mirrors on reconnect (#7718).
      const onAbort = (): void => {
        clearTimeout(timer)
        getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
        reject(new Error('client_disconnected'))
      }

      const handler = (
        event: Electron.IpcMainEvent,
        r: { requestId: string; tabId?: string; title?: string; error?: string }
      ): void => {
        if (event.sender !== win.webContents || r.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
        opts.signal?.removeEventListener('abort', onAbort)
        if (r.error) {
          reject(new Error(r.error))
        } else {
          resolve({ tabId: r.tabId!, title: r.title ?? '' })
        }
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
      win.webContents.send('terminal:requestTabCreate', {
        requestId,
        worktreeId,
        afterTabId: afterDesktopTabId,
        targetGroupId: opts.targetGroupId,
        command: startupCommand.command,
        cwd,
        ...(startupCommand.env ? { env: startupCommand.env } : {}),
        ...(startupCommand.envToDelete ? { envToDelete: startupCommand.envToDelete } : {}),
        ...(startupCommand.launchConfig ? { launchConfig: startupCommand.launchConfig } : {}),
        ...(startupCommand.launchAgent ? { launchAgent: startupCommand.launchAgent } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
        startupCommandDelivery: startupCommand.startupCommandDelivery,
        source: 'runtime-session',
        activate: opts.activate
      })
    })

    if (opts.activate !== false) {
      ctx.deps.notifier()?.focusTerminal(reply.tabId, worktreeId, null)
    }
    // Why: register the wait before the renderer's PTY spawn arrives so that
    // spawn (registerPty) can publish the pty-backed surface main-side even if
    // graph-sync is stalled (#7587). Removed in the finally below.
    const pendingCreateKey = `${worktreeId}::${reply.tabId}`
    // Why: a rescue publishes into the active group (opts.targetGroupId is not
    // threaded); the renderer's reconciling publication then moves the tab to the
    // requested group, so any wrong-group placement is cosmetic and stall-window-only.
    ctx.deps.pendingMobileTerminalCreatesByKey().set(pendingCreateKey, {
      activate: opts.activate !== false,
      paired: pairedCreate,
      selectIfNoActiveTab: true,
      ...(startupCommand.command ? { startupCommand: startupCommand.command } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {})
    })
    try {
      // Why: the PTY spawn and the tabCreate reply race on independent IPC
      // channels; if the spawn already registered, publish immediately so the
      // wait resolves without depending on a graph sync.
      ensurePtyBackedMobileSurfaceForRendererTab(ctx, worktreeId, reply.tabId)
      const surface = await waitForMobileTerminalSurface(ctx, worktreeId, reply.tabId, {
        timeoutMs: MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
        signal: opts.signal
      })
      if (isReadyMobileTerminalSurface(surface)) {
        ctx.deps.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
        return surface
      }
      const readySurface = await waitForMobileTerminalSurface(ctx, worktreeId, reply.tabId, {
        timeoutMs: MOBILE_TERMINAL_READY_FALLBACK_MS,
        requireReady: true,
        signal: opts.signal
      }).catch(() => null)
      if (readySurface) {
        ctx.deps.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
        return readySurface
      }
      if (opts.signal?.aborted) {
        // Why: nobody awaits this create anymore; don't materialize or roll back — the renderer's own publication settles the tab.
        throw new Error('client_disconnected')
      }
      const pendingSurface = findMobileTerminalSurface(ctx, worktreeId, reply.tabId)
      if (!pendingSurface) {
        throw new Error('Timed out waiting for terminal surface after creation')
      }
      // Why: a hidden renderer can publish the tab shell before the PTY spawns; reuse the same identity so later focus adopts instead of creating another tab.
      return await createRuntimeOwnedMobileSessionTerminal(
        ctx,
        worktreeId,
        opts.activate !== false,
        opts.afterTabId,
        {
          command: startupCommand.command,
          cwd,
          env: startupCommand.env,
          envToDelete: startupCommand.envToDelete,
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          identity: { tabId: pendingSurface.tab.parentTabId, leafId: pendingSurface.tab.leafId },
          launchAgent: startupCommand.launchAgent,
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          launchConfig: startupCommand.launchConfig,
          signal: opts.signal
        }
      )
    } catch (error) {
      // Why: publication latency (hidden renderer) can trip the surface timeout; rescue only when a live PTY backs the tab, else a ghost tab skips rollback (#7587).
      if (ctx.deps.findLiveRegisteredPtyForRendererTab(worktreeId, reply.tabId)) {
        const rescued = ensurePtyBackedMobileSurfaceForRendererTab(ctx, worktreeId, reply.tabId)
        if (rescued) {
          ctx.deps.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return rescued
        }
      }
      // Why: don't roll back on a client disconnect or a live shell already backing the tab — that would kill a visible terminal ("tab dies after ~10s", #7718).
      if (
        isClientDisconnectedError(error) ||
        ctx.deps.hasLiveShellForRendererTab(worktreeId, reply.tabId)
      ) {
        throw error
      }
      // Why: renderer made the tab but no live PTY backs it (real spawn/handle failure); roll it back so it can't linger as a ghost in mobile snapshots.
      ctx.deps.notifier()?.closeTerminal(reply.tabId)
      throw error
    } finally {
      ctx.deps.pendingMobileTerminalCreatesByKey().delete(pendingCreateKey)
    }
  } finally {
    releasePublicationThrottle()
  }
}

export async function resolveMobileSessionTerminalCommand(
  ctx: RuntimeMobileSessionFacadeCtx,
  workspace: TerminalWorkspaceLaunchScope,
  opts: {
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    agent?: TuiAgent
    agentPrompt?: string
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }
): Promise<{
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
}> {
  if (opts.command || !opts.agent) {
    return {
      command: opts.command,
      env: opts.env,
      envToDelete: opts.envToDelete,
      launchConfig: opts.launchConfig,
      launchAgent: opts.launchAgent,
      startupCommandDelivery: opts.startupCommandDelivery
    }
  }
  const store = ctx.deps.store()
  if (!store) {
    throw new Error('runtime_unavailable')
  }
  const settings = store.getSettings()
  if (!isTuiAgentEnabled(opts.agent, settings.disabledTuiAgents)) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  // Why: mobile may be iOS while the shell host is Windows/macOS/Linux or SSH Linux; quote for the host shell.
  const platform = ctx.deps.getAgentLaunchPlatformForWorkspace(workspace)
  // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
  const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : repoIsRemote(workspace)
  const queuedShell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: settings.terminalWindowsShell
  })
  const startupPlan = buildAgentStartupPlan({
    agent: opts.agent,
    prompt: opts.agentPrompt ?? '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(opts.agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(opts.agent, settings.agentDefaultEnv),
    platform,
    shell: queuedShell,
    isRemote,
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    throw new Error(`Could not build launch command for ${opts.agent}.`)
  }
  if (opts.agentPrompt && startupPlan.followupPrompt) {
    throw new Error(`Agent ${opts.agent} does not support startup prompt quick commands.`)
  }
  await ctx.deps.markWorkspaceTrustedForAgent(opts.agent, workspace.connectionId, workspace.path)
  return {
    command: startupPlan.launchCommand,
    env: startupPlan.env,
    // Why: a real-home Codex resume strips inherited CODEX_HOME via
    // envToDelete; dropping it here would resume against the wrong home.
    envToDelete: opts.envToDelete,
    launchConfig: startupPlan.launchConfig,
    launchAgent: opts.agent,
    startupCommandDelivery: startupPlan.startupCommandDelivery
  }
}

export async function createRuntimeOwnedMobileSessionTerminal(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  activate: boolean,
  afterTabId?: string,
  opts: {
    command?: string
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    identity?: { tabId: string; leafId: string; sessionId?: string }
    launchAgent?: TuiAgent
    viewMode?: 'terminal' | 'chat'
    targetGroupId?: string
    launchConfig?: SleepingAgentLaunchConfig
    signal?: AbortSignal
  } = {}
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const workspace = await ctx.deps.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
  const cwd = ctx.deps.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
  // Why: SshPtyProvider treats sessionId as a relay reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
  const stableSessionId =
    opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
  const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
  const terminal = await ctx.deps.createTerminal(`id:${worktreeId}`, {
    focus: false,
    command: opts.command,
    cwd,
    env: opts.env,
    envToDelete: opts.envToDelete,
    ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
    ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
    ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
    startupCommandDelivery: opts.startupCommandDelivery,
    ...(opts.identity
      ? {
          tabId: opts.identity.tabId,
          leafId: opts.identity.leafId,
          ...(stableSessionId ? { sessionId: stableSessionId } : {})
        }
      : stableSessionId
        ? { sessionId: stableSessionId }
        : {}),
    ...(isNewSession ? { isNewSession: true } : {}),
    // Why: this method publishes the authoritative snapshot below; skip the intermediate publish to avoid a wrong-group flash.
    deferMobileSessionPublish: true,
    signal: opts.signal
  })
  const livePty = ctx.deps.getLivePtyForHandle(terminal.handle)
  if (!livePty) {
    throw new Error('terminal_handle_stale')
  }
  const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
  const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
  if (opts.viewMode) {
    // Why: the runtime-owned binding must survive a serve restart with the same initial mode, not a later client's local default.
    ctx.deps.persistHeadlessSessionTabProps()(worktreeId, parentTabId, {
      viewMode: opts.viewMode
    })
  }
  const existing = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
  const existingSurface =
    existing?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === parentTabId &&
        candidate.leafId === leafId
    ) ?? null
  const parentLayout = ctx.deps.buildMaterializedHeadlessParentLayout(
    leafId,
    livePty.pty.ptyId,
    existingSurface?.parentLayout
  )
  const tab: RuntimeMobileSessionTerminalTab = {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    parentTabId,
    leafId,
    ptyId: livePty.pty.ptyId,
    title: terminal.title ?? livePty.pty.title ?? 'Terminal',
    ...(cwd ? { startupCwd: cwd } : {}),
    ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
    ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
    parentLayout,
    isActive: activate
  }
  const tabs = (existing?.tabs ?? [])
    .filter((candidate) => candidate.id !== tab.id)
    .map((candidate) => ({
      ...candidate,
      ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
        ? { parentLayout }
        : {}),
      isActive: activate ? false : candidate.isActive
    }))
  const insertAfter = afterTabId ? tabs.findIndex((candidate) => candidate.id === afterTabId) : -1
  if (insertAfter >= 0) {
    tabs.splice(insertAfter + 1, 0, tab)
  } else {
    tabs.push(tab)
  }
  const next: RuntimeMobileSessionTabsSnapshot = {
    worktree: worktreeId,
    publicationEpoch: `headless:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    // Why: activating the new tab also focuses its group, so a "+" targeting a specific split group makes that group active too.
    activeGroupId:
      activate && opts.targetGroupId
        ? opts.targetGroupId
        : (existing?.activeGroupId ??
          ctx.deps.mobileTabSnapshots().getHeadlessMobileSessionGroupId(worktreeId)),
    activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
    activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
    tabGroups: ctx.deps
      .mobileTabSnapshots()
      .buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activate ? tab : null,
        existing?.tabGroups,
        opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
      ),
    // Why: keep group split geometry on new-tab creation, else opening a terminal while split loses the arrangement.
    ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
    tabs
  }
  ctx.deps.mobileSessionTabsByWorktree().set(worktreeId, next)
  const result = toMobileSessionTabsResult(ctx, next)
  const changeSequence = ctx.deps.nextMobileSessionTabsChangeSequence()
  for (const subscription of ctx.deps.mobileSessionTabListeners()) {
    subscription.listener(
      ctx.deps
        .mobileTabSnapshots()
        .projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
      changeSequence
    )
  }
  const created = result.tabs.find((candidate) => candidate.id === tab.id)
  if (!created || created.type !== 'terminal') {
    throw new Error('terminal_handle_stale')
  }
  return {
    tab: created,
    publicationEpoch: result.publicationEpoch,
    snapshotVersion: result.snapshotVersion
  }
}

export function waitForMobileTerminalSurface(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  parentTabId: string,
  options: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal } = {}
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const timeoutMs = options.timeoutMs ?? MOBILE_TERMINAL_SURFACE_TIMEOUT_MS
  const existing = findMobileTerminalSurface(ctx, worktreeId, parentTabId, options)
  if (existing) {
    return Promise.resolve(existing)
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error('client_disconnected'))
  }

  return new Promise<RuntimeMobileSessionCreateTerminalResult>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const idx = ctx.deps.graphSyncCallbacks().indexOf(check)
      if (idx !== -1) {
        ctx.deps.graphSyncCallbacks().splice(idx, 1)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for terminal surface after creation'))
    }, timeoutMs)
    // Why: a dead client connection cancels the wait immediately instead of running down the timeout into rollback (#7718).
    const onAbort = (): void => {
      cleanup()
      reject(new Error('client_disconnected'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const check = (): void => {
      const next = findMobileTerminalSurface(ctx, worktreeId, parentTabId, options)
      if (!next) {
        return
      }
      cleanup()
      resolve(next)
    }
    ctx.deps.graphSyncCallbacks().push(check)
    check()
  })
}

export function findMobileTerminalSurface(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  parentTabId: string,
  options: { requireReady?: boolean } = {}
): RuntimeMobileSessionCreateTerminalResult | null {
  const snapshot = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
  if (!snapshot) {
    return null
  }
  const result = toMobileSessionTabsResult(ctx, snapshot)
  const tab = result.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
  )
  if (!tab || tab.type !== 'terminal') {
    return null
  }
  const surface = {
    tab,
    publicationEpoch: result.publicationEpoch,
    snapshotVersion: result.snapshotVersion
  }
  if (options.requireReady === true && !isReadyMobileTerminalSurface(surface)) {
    return null
  }
  return surface
}

export function findMobileTerminalSurfaceForPty(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  ptyId: string
): RuntimeMobileSessionCreateTerminalResult | null {
  const snapshot = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
  const tab = snapshot?.tabs.find(
    (candidate) =>
      candidate.type === 'terminal' &&
      (candidate.ptyId === ptyId ||
        candidate.parentLayout?.ptyIdsByLeafId?.[candidate.leafId] === ptyId)
  )
  return tab?.type === 'terminal'
    ? findMobileTerminalSurface(ctx, worktreeId, tab.parentTabId)
    : null
}

export function ensurePtyBackedMobileSurfaceForRendererTab(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  tabId: string
): RuntimeMobileSessionCreateTerminalResult | null {
  const pending = ctx.deps.pendingMobileTerminalCreatesByKey().get(`${worktreeId}::${tabId}`)
  if (!pending) {
    return null
  }
  const existing = findMobileTerminalSurface(ctx, worktreeId, tabId)
  const pty = ctx.deps.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
  if (pty) {
    pty.runtimeSessionOwned = true
    if (pending.paired) {
      ctx.deps.setPairedRendererSessionOwnership(pty.ptyId, true)
    }
  }
  if (
    existing &&
    isReadyMobileTerminalSurface(existing) &&
    (pending.viewMode === undefined || existing.tab.viewMode === pending.viewMode)
  ) {
    // Why: the renderer's ready publication already landed with the intended mode; only a pending shell needs the main-side rescue.
    return existing
  }
  const leafId = pty ? parsePaneKey(pty.paneKey ?? '')?.leafId : undefined
  if (!pty || !leafId) {
    return existing
  }
  publishPtyBackedMobileSessionTerminal(ctx, worktreeId, pty, {
    tabId,
    leafId,
    title: null,
    activate: pending.activate,
    selectIfNoActiveTab: pending.selectIfNoActiveTab,
    ...(pending.viewMode ? { viewMode: pending.viewMode } : {})
  })
  // Why: check closures normally drain only inside syncWindowGraph; a main-side publish must drain them too or the pending wait misses the insertion.
  for (const cb of ctx.deps.graphSyncCallbacks()) {
    cb()
  }
  return findMobileTerminalSurface(ctx, worktreeId, tabId)
}

export function restoreLivePairedRendererSessionOwnedMobileTerminals(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string | null,
  options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
): void {
  for (const ptyId of ctx.deps.pairedRendererSessionOwnedPtyIds()) {
    const pty = ctx.deps.ptysById().get(ptyId)
    if (
      !pty?.connected ||
      !pty.tabId ||
      (worktreeId !== null && !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId))
    ) {
      continue
    }
    const targetWorktreeId = worktreeId ?? pty.worktreeId
    const pane = parsePaneKey(pty.paneKey ?? '')
    if (!pane || pane.tabId !== pty.tabId) {
      continue
    }
    const existing = ctx.deps.mobileSessionTabsByWorktree().get(targetWorktreeId)
    if (existing && options.missingSnapshotOnly) {
      continue
    }
    if (
      existing?.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === pty.ptyId || (tab.parentTabId === pty.tabId && tab.leafId === pane.leafId))
      )
    ) {
      continue
    }
    if (!existing) {
      ctx.deps.mobileSessionTabsByWorktree().set(targetWorktreeId, {
        worktree: targetWorktreeId,
        publicationEpoch: `renderer-rescue:${Date.now().toString(36)}`,
        snapshotVersion: 0,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabGroups: [],
        tabs: []
      })
    }
    publishPtyBackedMobileSessionTerminal(ctx, targetWorktreeId, pty, {
      tabId: pty.tabId,
      leafId: pane.leafId,
      title: null,
      activate: false,
      selectIfNoActiveTab: false,
      notify: options.notify
    })
  }
}

export function isReadyMobileTerminalSurface(
  surface: RuntimeMobileSessionCreateTerminalResult | null
): boolean {
  return (
    surface?.tab.status === 'ready' &&
    typeof surface.tab.terminal === 'string' &&
    surface.tab.terminal.length > 0
  )
}

export function publishPtyBackedMobileSessionTerminal(
  ctx: RuntimeMobileSessionFacadeCtx,
  worktreeId: string,
  pty: RuntimePtyWorktreeRecord,
  args: {
    tabId: string
    leafId: string
    title: string | null
    activate: boolean
    selectIfNoActiveTab?: boolean
    startupCwd?: string
    viewMode?: 'terminal' | 'chat'
    split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
    notify?: boolean
  }
): void {
  if (
    !ctx.deps.isMobileSessionSurfaceMembershipAllowed(
      worktreeId,
      args.tabId,
      args.leafId,
      pty.ptyId
    )
  ) {
    return
  }
  const existing = ctx.deps.mobileSessionTabsByWorktree().get(worktreeId)
  const ownerAgent = pty.launchAgent ?? pty.foregroundAgent
  const title = normalizeCompatibleAgentTitleForOwner(
    args.title ?? getLatestPtyTitle(pty) ?? 'Terminal',
    ownerAgent
  )
  const existingTab = existing?.tabs.find(
    (candidate): candidate is RuntimeMobileSessionTerminalTab =>
      candidate.type === 'terminal' &&
      candidate.parentTabId === args.tabId &&
      candidate.leafId === args.leafId
  )
  // Why: a split inserts into the parent tab's layout, which lives on the
  // sibling surface, not this new leaf's (empty) existing surface.
  const baseLayout = args.split
    ? (existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.leafId === args.split!.splitFromLeafId
      )?.parentLayout ?? existingTab?.parentLayout)
    : existingTab?.parentLayout
  const parentLayout = ctx.deps.buildMaterializedHeadlessParentLayout(
    args.leafId,
    pty.ptyId,
    baseLayout,
    args.split
  )
  // Why: a main-side PTY rescue or split publication must not erase the
  // host's explicit tab mode before the renderer graph catches up.
  const viewMode =
    args.viewMode ??
    existingTab?.viewMode ??
    existing?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === args.tabId &&
        candidate.viewMode !== undefined
    )?.viewMode
  const tab: RuntimeMobileSessionTerminalTab = {
    type: 'terminal',
    id: `${args.tabId}::${args.leafId}`,
    parentTabId: args.tabId,
    leafId: args.leafId,
    ptyId: pty.ptyId,
    title,
    ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
    ...(viewMode ? { viewMode } : {}),
    parentLayout,
    isActive: args.activate || (args.selectIfNoActiveTab !== false && existing?.activeTabId == null)
  }
  const existingTabs = (existing?.tabs ?? []).filter(
    (candidate) =>
      !(
        candidate.type === 'terminal' &&
        candidate.parentTabId === args.tabId &&
        candidate.leafId === args.leafId
      )
  )
  const tabs = (
    ctx.deps.mobileSnapshotMerge() as unknown as {
      mergeMobileSessionSnapshotTabs: (...a: unknown[]) => RuntimeMobileSessionTerminalTab[]
    }
  ).mergeMobileSessionSnapshotTabs(
    existingTabs.map((candidate) => ({
      ...candidate,
      // Why: the client picks one sibling's parentLayout to render the whole
      // tab; a split must update every sibling surface to the new tree, or a
      // stale single-leaf sibling makes the client fall back to a default
      // direction ("Split Right" renders as down).
      ...(args.split && candidate.type === 'terminal' && candidate.parentTabId === args.tabId
        ? { parentLayout }
        : {}),
      isActive: tab.isActive ? false : candidate.isActive
    })),
    [tab]
  )
  const activeTab =
    (tab.isActive ? tab : tabs.find((candidate) => candidate.id === existing?.activeTabId)) ??
    tabs.find((candidate) => candidate.isActive) ??
    (args.selectIfNoActiveTab !== false ? tabs[0] : null) ??
    null
  const terminalTabs = tabs.filter(
    (candidate): candidate is RuntimeMobileSessionTerminalTab => candidate.type === 'terminal'
  )
  const next: RuntimeMobileSessionTabsSnapshot = {
    worktree: worktreeId,
    publicationEpoch:
      existing?.publicationEpoch ?? `headless:pty-backed:${Date.now().toString(36)}`,
    snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
    activeGroupId:
      existing?.activeGroupId ??
      ctx.deps.mobileTabSnapshots().getHeadlessMobileSessionGroupId(worktreeId),
    activeTabId: activeTab?.id ?? null,
    activeTabType: activeTab?.type ?? null,
    tabGroups: (
      ctx.deps.mobileSnapshotMerge() as unknown as {
        mergeMobileSessionTabGroups: (...a: unknown[]) => RuntimeMobileSessionTabGroup[]
      }
    ).mergeMobileSessionTabGroups(
      worktreeId,
      existing?.tabGroups ?? [],
      terminalTabs,
      activeTab?.type === 'terminal' ? activeTab : null
    ),
    ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
    tabs
  }
  ctx.deps.mobileSessionTabsByWorktree().set(worktreeId, next)
  if (args.notify !== false) {
    ctx.deps.notifyMobileSessionTabsChanged(worktreeId)
  }
}

export function replaceHeadlessTerminalFromRendererSnapshotForRecovery(
  ctx: RuntimeMobileSessionFacadeCtx,
  ptyId: string,
  snapshot: {
    data: string
    cols: number
    rows: number
    cwd?: string | null
    oscLinks?: TerminalOscLinkRange[]
  },
  trailingOutput: { data: string; seq: number }[] = []
): void {
  if (!snapshot.data) {
    return
  }
  // Why: a redraw byte can create a suffix-only model before the renderer settles; replace it with the exact snapshot already sent mobile.
  ctx.deps.providerSnapshotPreferredPtys().add(ptyId)
  ctx.deps.disposeHeadlessTerminal(ptyId)
  ctx.deps.seedHeadlessTerminal(
    ptyId,
    snapshot.data,
    { cols: snapshot.cols, rows: snapshot.rows },
    { cwd: snapshot.cwd, oscLinks: snapshot.oscLinks }
  )
  for (const chunk of trailingOutput) {
    ctx.deps.trackHeadlessTerminalData(ptyId, chunk.data, chunk.seq)
  }
  // The seed's write chain owns subsequent live bytes; suppress on-data hydration from replacing this known-good seed.
  ctx.deps.headlessHydrationState().set(ptyId, 'done')
}

export async function refreshMobileSessionPtyRecords(
  ctx: RuntimeMobileSessionFacadeCtx,
  targetWorktreeId: string | null = null
): Promise<Set<string> | null> {
  const inventory = await refreshMobileSessionPtyInventory(ctx, targetWorktreeId)
  return inventory ? new Set(inventory.livePtyIds) : null
}

export async function refreshMobileSessionPtyInventory(
  ctx: RuntimeMobileSessionFacadeCtx,
  targetWorktreeId: string | null = null
): Promise<PtyControllerInventory | null> {
  if (targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    // Non-floating refreshes all query the aggregate controller inventory;
    // coalesce targeted and all-worktree callers so they cannot invalidate
    // one another through the shared aggregate generation fence.
    const pending = ctx.pendingMobileSessionPtyAggregateInventoryRefresh
    if (pending) {
      return pending
    }
    // Why: reconnect exit bursts share one authoritative daemon inventory
    // instead of multiplying a full cross-generation list RPC per stale tab.
    const refresh = performMobileSessionPtyRecordsRefresh(ctx, targetWorktreeId).finally(() => {
      if (ctx.pendingMobileSessionPtyAggregateInventoryRefresh === refresh) {
        ctx.pendingMobileSessionPtyAggregateInventoryRefresh = null
      }
    })
    ctx.pendingMobileSessionPtyAggregateInventoryRefresh = refresh
    return refresh
  }
  return await performMobileSessionPtyRecordsRefresh(ctx, targetWorktreeId)
}

export async function performMobileSessionPtyRecordsRefresh(
  ctx: RuntimeMobileSessionFacadeCtx,
  targetWorktreeId: string | null
): Promise<PtyControllerInventory | null> {
  if (!ctx.deps.ptyController()?.listProcesses && !ctx.deps.ptyController()?.hasPty) {
    return null
  }
  // Why: floating PTY identity is explicit, so polling must not resolve every Git/SSH worktree.
  const isFloatingWorkspace = targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const resolvedWorktrees = isFloatingWorkspace ? [] : await ctx.deps.listResolvedWorktrees()
  return await ctx.deps.refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees,
    isFloatingWorkspace ? targetWorktreeId : null
  )
}
