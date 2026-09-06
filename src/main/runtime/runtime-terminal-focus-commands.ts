/* eslint-disable max-lines -- Why: focus/idle-fallback poll/split-source-authority command cluster extracted verbatim from the terminal cluster facade; splitting further would fragment a single focus-coalescing flow. */
import { isShellProcess } from '../../shared/agent-detection'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
  copySleepingAgentLaunchConfig,
  resolveBareAgentLaunchCommand
} from './agent-session-terminal-operations'
import { terminalLayoutContainsLeaf } from './headless-terminal-split-layout'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult,
  buildTerminalWaitText,
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason,
  getLatestPtyTitle,
  isKnownReadyPromptPreview,
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-tail-projection'
import type { RuntimeTerminalFocus } from '../../shared/runtime-types'
import type {
  TerminalWaiter,
  TerminalCreateOptions,
  TerminalWorkspaceLaunchScope,
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from './orca-runtime'
import { TUI_IDLE_POLL_INTERVAL_MS, TUI_IDLE_QUIESCENCE_MS } from './runtime-tail-projection'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export async function focusTerminal(
  ctx: Ctx,
  handle: string,
  options: { navigateHost?: boolean } = {}
): Promise<RuntimeTerminalFocus> {
  const navigateHost = options.navigateHost !== false
  const livePtyIdentity = (): RuntimeTerminalFocus => {
    const live = ctx.getLivePtyForHandle(handle)
    if (!live?.pty.connected) {
      throw new Error('terminal_exited')
    }
    return {
      handle,
      tabId: live.pty.tabId ?? live.record.tabId,
      worktreeId: live.pty.worktreeId,
      navigated: false
    }
  }
  const liveLeafIdentity = (): RuntimeTerminalFocus => {
    ctx.assertGraphReady()
    const { leaf: current } = ctx.getLiveLeafForHandle(handle)
    return {
      handle,
      tabId: current.tabId,
      worktreeId: current.worktreeId,
      navigated: false
    }
  }

  const pty = ctx.getLivePtyForHandle(handle)
  if (pty) {
    if (!pty.pty.connected) {
      throw new Error('terminal_exited')
    }
    if (!navigateHost || !ctx.deps.notifier()?.revealTerminalSession) {
      return {
        handle,
        tabId: pty.pty.tabId ?? pty.record.tabId,
        worktreeId: pty.pty.worktreeId,
        navigated: false
      }
    }
    // Coalesce concurrent host navigations: only the latest full reveal claims navigated.
    return ctx.deps.terminalFocusNavigationCoalescer().run({
      key: handle,
      resolveSuperseded: (completed) =>
        completed ? { ...completed, navigated: false } : livePtyIdentity(),
      run: async (navCtx) => {
        const live = ctx.getLivePtyForHandle(handle)
        if (!live?.pty.connected) {
          throw new Error('terminal_exited')
        }
        if (!navCtx.isCurrent()) {
          return {
            handle,
            tabId: live.pty.tabId ?? live.record.tabId,
            worktreeId: live.pty.worktreeId,
            navigated: false
          }
        }
        const notifier = ctx.deps.notifier()
        if (!notifier?.revealTerminalSession) {
          return {
            handle,
            tabId: live.pty.tabId ?? live.record.tabId,
            worktreeId: live.pty.worktreeId,
            navigated: false
          }
        }
        const parsedPaneKey = parsePaneKey(live.pty.paneKey ?? '')
        const revealed = await notifier.revealTerminalSession(live.pty.worktreeId, {
          ptyId: live.pty.ptyId,
          title: getLatestPtyTitle(live.pty),
          ...(live.pty.launchConfig
            ? { launchConfig: copySleepingAgentLaunchConfig(live.pty.launchConfig) }
            : {}),
          ...(live.pty.launchToken ? { launchToken: live.pty.launchToken } : {}),
          ...(live.pty.launchAgent ? { launchAgent: live.pty.launchAgent } : {}),
          ...(live.pty.tabId !== null ? { tabId: live.pty.tabId } : {}),
          ...(parsedPaneKey ? { leafId: parsedPaneKey.leafId } : {})
        })
        if (!navCtx.isCurrent() || ctx.deps.notifier() !== notifier) {
          return {
            handle,
            tabId: revealed?.tabId ?? live.pty.tabId ?? live.record.tabId,
            worktreeId: live.pty.worktreeId,
            navigated: false
          }
        }
        return {
          handle,
          tabId: revealed?.tabId ?? live.pty.tabId ?? live.record.tabId,
          worktreeId: live.pty.worktreeId,
          navigated: true
        }
      }
    })
  }
  ctx.assertGraphReady()
  const { leaf } = ctx.getLiveLeafForHandle(handle)
  if (!navigateHost) {
    return {
      handle,
      tabId: leaf.tabId,
      worktreeId: leaf.worktreeId,
      navigated: false
    }
  }
  if (!ctx.deps.notifier()?.focusTerminal) {
    return {
      handle,
      tabId: leaf.tabId,
      worktreeId: leaf.worktreeId,
      navigated: false
    }
  }
  return ctx.deps.terminalFocusNavigationCoalescer().run({
    key: handle,
    resolveSuperseded: (completed) =>
      completed ? { ...completed, navigated: false } : liveLeafIdentity(),
    run: async (navCtx) => {
      ctx.assertGraphReady()
      const { leaf: liveLeaf } = ctx.getLiveLeafForHandle(handle)
      if (!navCtx.isCurrent()) {
        return {
          handle,
          tabId: liveLeaf.tabId,
          worktreeId: liveLeaf.worktreeId,
          navigated: false
        }
      }
      const notifier = ctx.deps.notifier()
      if (!notifier?.focusTerminal) {
        return {
          handle,
          tabId: liveLeaf.tabId,
          worktreeId: liveLeaf.worktreeId,
          navigated: false
        }
      }
      notifier.focusTerminal(liveLeaf.tabId, liveLeaf.worktreeId, liveLeaf.leafId)
      if (!navCtx.isCurrent() || ctx.deps.notifier() !== notifier) {
        return {
          handle,
          tabId: liveLeaf.tabId,
          worktreeId: liveLeaf.worktreeId,
          navigated: false
        }
      }
      return {
        handle,
        tabId: liveLeaf.tabId,
        worktreeId: liveLeaf.worktreeId,
        navigated: true
      }
    }
  })
}

export function startTuiIdleFallbackPoll(
  ctx: Ctx,
  waiter: TerminalWaiter,
  leaf: RuntimeLeafRecord,
  waiterTimeoutMs: number
): void {
  let foregroundPollInFlight = false
  waiter.pollInterval = setInterval(async () => {
    if (!waiter.pollInterval) {
      return
    }
    let startedForegroundPoll = false
    try {
      if (leaf.lastAgentStatus === 'idle') {
        if (waiter.pollInterval) {
          clearInterval(waiter.pollInterval)
          waiter.pollInterval = null
        }
        ctx.resolveWaiter(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
        return
      }
      // Why: the renderer-synced title is the only path where OSC titles are visible for daemon-hosted terminals.
      const pollTitle = leaf.paneTitle ?? ctx.deps.tabs().get(leaf.tabId)?.title
      if (pollTitle) {
        const titleStatus = detectExplicitIdleStatusFromTitle(pollTitle)
        if (titleStatus === 'idle') {
          if (waiter.pollInterval) {
            clearInterval(waiter.pollInterval)
            waiter.pollInterval = null
          }
          ctx.resolveWaiter(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
          return
        }
      }
      const leafWaitText = buildTerminalWaitText(
        leaf.tailBuffer,
        leaf.tailPartialLine,
        leaf.preview
      )
      const blockedReason = detectTerminalWaitBlockedReason(leafWaitText)
      if (blockedReason) {
        if (waiter.pollInterval) {
          clearInterval(waiter.pollInterval)
          waiter.pollInterval = null
        }
        ctx.resolveWaiter(
          waiter,
          buildTerminalWaitBlockedResult(waiter.handle, 'tui-idle', leaf, blockedReason)
        )
        return
      }
      if (isKnownReadyPromptPreview(leafWaitText)) {
        if (waiter.pollInterval) {
          clearInterval(waiter.pollInterval)
          waiter.pollInterval = null
        }
        ctx.resolveWaiter(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
        return
      }
      // Foreground fallback: a reported non-shell process with quiet output is treated as idle.
      if (
        leaf.lastAgentStatus === null &&
        leaf.ptyId &&
        ctx.deps.ptyController() &&
        !foregroundPollInFlight
      ) {
        foregroundPollInFlight = true
        startedForegroundPoll = true
        const fg = await ctx.deps.ptyController()!.getForegroundProcess(leaf.ptyId)
        if (fg && !isShellProcess(fg)) {
          const quietMs = leaf.lastOutputAt ? Date.now() - leaf.lastOutputAt : 0
          if (quietMs >= TUI_IDLE_QUIESCENCE_MS) {
            if (waiter.pollInterval) {
              clearInterval(waiter.pollInterval)
              waiter.pollInterval = null
            }
            ctx.resolveWaiter(waiter, buildTerminalWaitResult(waiter.handle, 'tui-idle', leaf))
          }
        }
      }
    } catch {
      // Swallow transient PTY inspection errors and keep polling.
    } finally {
      if (startedForegroundPoll) {
        foregroundPollInFlight = false
      }
    }
  }, TUI_IDLE_POLL_INTERVAL_MS)
  const retainedWaitText = buildTerminalWaitText(
    leaf.tailBuffer,
    leaf.tailPartialLine,
    leaf.preview
  )
  if (leaf.lastAgentStatus === null && retainedWaitText.length === 0) {
    ctx.startTuiIdleVisibleReadProbe(waiter, waiterTimeoutMs)
  }
}

export async function resolveAgentTerminalCreateOptions(
  ctx: Ctx,
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions
): Promise<TerminalCreateOptions> {
  // Why: raw shell commands like `codex exec` must remain user-authored shell.
  // Only unmanaged, repo-backed, bare agent launches get Settings defaults.
  const callerSuppliedLaunch =
    opts.env ||
    opts.launchConfig ||
    opts.launchAgent ||
    opts.startupCommandDelivery ||
    opts.claudeAgentTeamsSourceCommand
  const store = ctx.deps.store()
  if (opts.startupAgent) {
    // Why: falling through unresolved would spawn a bare shell that can only time
    // out waiting for an agent. A caller-supplied launch contradicts the agent:
    // `command` would be overwritten, `resumeProviderSession` would pair resume
    // identity with a fresh launch.
    if (callerSuppliedLaunch || opts.command || opts.resumeProviderSession) {
      throw new Error(
        `startupAgent ${opts.startupAgent} cannot combine with a caller-supplied launch.`
      )
    }
    if (!store) {
      throw new Error('runtime_unavailable')
    }
  } else if (callerSuppliedLaunch || !store || !opts.command || !workspace.repo) {
    return opts
  }

  const settings = store.getSettings()
  const platform = ctx.deps.getAgentLaunchPlatformForWorkspace(workspace)
  const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : Boolean(workspace.connectionId)
  const queuedShell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: settings.terminalWindowsShell
  })
  if (opts.startupAgent && !isTuiAgentEnabled(opts.startupAgent, settings.disabledTuiAgents)) {
    throw new Error(`Agent ${opts.startupAgent} is disabled. Choose an enabled agent.`)
  }
  const agent =
    opts.startupAgent ??
    resolveBareAgentLaunchCommand({
      command: opts.command,
      settings,
      platform,
      isRemote
    })
  if (!agent) {
    return opts
  }

  const sessionOptions = ctx.toAgentSessionOptions(opts.launchPreferences)
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    sessionOptions,
    sessionOptionsOverrideAgentArgs: Boolean(sessionOptions),
    platform,
    shell: queuedShell,
    isRemote,
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    // Why: an explicit agent that yields no plan would otherwise spawn a bare
    // shell that never reaches agent readiness.
    if (opts.startupAgent) {
      throw new Error(`Could not build launch command for ${opts.startupAgent}.`)
    }
    return opts
  }

  await ctx.markWorkspaceTrustedForAgent(agent, workspace.connectionId, workspace.path)

  return {
    ...opts,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    startupCommandDelivery: startupPlan.startupCommandDelivery
  }
}

export function resolveTerminalSplitSourceAuthority(
  ctx: Ctx,
  worktreeId: string,
  tabId: string,
  leafId: string,
  ptyId: string
): {
  persisted: boolean
  rendererMounted: boolean
  persistedWorktreeId: string | null
  persistedIncarnationId: string | null
  liveIncarnationId: string | null
} | null {
  const session = ctx.getWorkspaceSessionForWorktree(worktreeId)
  const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
  const persistedTab = sessionWorktreeId
    ? session?.tabsByWorktree[sessionWorktreeId]?.find(
        (tab) => tab.id === tabId && runtimeWorktreeIdsEqual(tab.worktreeId, worktreeId)
      )
    : undefined
  const persistedLayout = session?.terminalLayoutsByTabId?.[tabId]
  const persistedIncarnationId =
    session?.terminalPtyIncarnationsByPaneKey?.[makePaneKey(tabId, leafId)] ?? null
  const liveIncarnationId = ctx.deps.ptysById().get(ptyId)?.incarnationId ?? null
  if (persistedIncarnationId && liveIncarnationId && persistedIncarnationId !== liveIncarnationId) {
    return null
  }
  const persisted = Boolean(
    persistedTab &&
    persistedLayout?.ptyIdsByLeafId?.[leafId] === ptyId &&
    terminalLayoutContainsLeaf(persistedLayout.root, leafId)
  )
  const rendererTab = ctx.deps.tabs().get(tabId)
  const rendererLeaf = ctx.deps.leaves().get(ctx.getLeafKey(tabId, leafId))
  const rendererMounted = Boolean(
    rendererTab &&
    rendererLeaf &&
    runtimeWorktreeIdsEqual(rendererTab.worktreeId, worktreeId) &&
    runtimeWorktreeIdsEqual(rendererLeaf.worktreeId, worktreeId) &&
    rendererLeaf.ptyId === ptyId
  )
  if (persisted && persistedLayout) {
    return {
      persisted: true,
      rendererMounted,
      persistedWorktreeId: sessionWorktreeId,
      persistedIncarnationId,
      liveIncarnationId
    }
  }
  // Why: renderer adoption can precede graph sync; this path still requires reveal success before commit.
  const projected = [...ctx.deps.mobileSessionTabsByWorktree().entries()].some(
    ([candidateWorktreeId, snapshot]) =>
      runtimeWorktreeIdsEqual(candidateWorktreeId, worktreeId) &&
      snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          tab.parentTabId === tabId &&
          tab.leafId === leafId &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[leafId] === ptyId)
      )
  )
  if (!rendererMounted && !projected) {
    return null
  }
  return {
    persisted: false,
    rendererMounted,
    persistedWorktreeId: null,
    persistedIncarnationId: null,
    liveIncarnationId
  }
}

export function startPtyTuiIdleFallbackPoll(
  ctx: Ctx,
  waiter: TerminalWaiter,
  pty: RuntimePtyWorktreeRecord,
  waiterTimeoutMs: number
): void {
  let foregroundPollInFlight = false
  waiter.pollInterval = setInterval(async () => {
    if (!waiter.pollInterval) {
      return
    }
    let startedForegroundPoll = false
    try {
      if (pty.lastAgentStatus === 'idle') {
        if (waiter.pollInterval) {
          clearInterval(waiter.pollInterval)
          waiter.pollInterval = null
        }
        ctx.resolveWaiter(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
        return
      }
      const ptyWaitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      const blockedReason = detectTerminalWaitBlockedReason(ptyWaitText)
      if (blockedReason) {
        if (waiter.pollInterval) {
          clearInterval(waiter.pollInterval)
          waiter.pollInterval = null
        }
        ctx.resolveWaiter(
          waiter,
          buildPtyTerminalWaitBlockedResult(waiter.handle, 'tui-idle', pty, blockedReason)
        )
        return
      }
      // Why: adopted background PTY handles use their live xterm title as the same readiness signal as leaf handles.
      if (
        ctx.getAdoptedPtyExplicitIdleStatus(pty) === 'idle' ||
        isKnownReadyPromptPreview(ptyWaitText)
      ) {
        if (waiter.pollInterval) {
          clearInterval(waiter.pollInterval)
          waiter.pollInterval = null
        }
        ctx.resolveWaiter(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
        return
      }
      if (pty.lastAgentStatus === null && ctx.deps.ptyController() && !foregroundPollInFlight) {
        foregroundPollInFlight = true
        startedForegroundPoll = true
        const fg = await ctx.deps.ptyController()!.getForegroundProcess(pty.ptyId)
        if (fg && !isShellProcess(fg)) {
          const quietMs = pty.lastOutputAt ? Date.now() - pty.lastOutputAt : 0
          if (quietMs >= TUI_IDLE_QUIESCENCE_MS) {
            if (waiter.pollInterval) {
              clearInterval(waiter.pollInterval)
              waiter.pollInterval = null
            }
            ctx.resolveWaiter(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
          }
        }
      }
    } catch {
      // Swallow transient PTY inspection errors and keep polling.
    } finally {
      if (startedForegroundPoll) {
        foregroundPollInFlight = false
      }
    }
  }, TUI_IDLE_POLL_INTERVAL_MS)
  const retainedWaitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
  if (pty.lastAgentStatus === null && retainedWaitText.length === 0) {
    ctx.startTuiIdleVisibleReadProbe(waiter, waiterTimeoutMs)
  }
}
