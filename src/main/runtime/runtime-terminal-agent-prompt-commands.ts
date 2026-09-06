/* eslint-disable max-lines -- Why: extracted agent-prompt command cluster (prompt send, agent status, startup build, headless seed, remote create reconcile) from terminal cluster facade */
import type { Repo } from '../../shared/repo-types'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import { isQuarterCircleSpinnerOnlyAgentTitle } from '../../shared/agent-title-status'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise,
  yieldBetweenTerminalInputChunks
} from './agent-session-terminal-operations'
import {
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  agentTitleProvesAgentPresence,
  classifyAgentTitle,
  getLatestLeafTitle,
  mapExplicitAgentStateToRuntimeTerminalStatus,
  ptyTitleProvesAgentPresence,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-agent-title-projection'
import { buildSendPayload, assertTerminalInputWithinLimitWithYield } from './runtime-tail-read'
import { inferWorktreeIdFromPtyId } from './runtime-worktree-projection'
import { withTimeoutResult } from './runtime-tail-shared'
import { isKnownReadyPromptPreview, buildTerminalWaitText as _btw } from './runtime-tail-projection'

// 'node:crypto'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusEntry } from '../../shared/agent-status-types'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'

// '../../shared/agent-title-status'

// '../../shared/terminal-title-agent-type'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalSend } from '../../shared/runtime-terminal-contracts'
import type { HeadlessSeedMetadata, WorktreeStartupFollowup } from './runtime-contracts'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS, buildTerminalWaitText } from './runtime-tail-projection'
import type { RuntimeTerminalAgentStatus, RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export async function writeTerminalAgentPrompt(
  ctx: Ctx,
  handle: string,
  ptyId: string,
  generation: number,
  pastePayload: string,
  options: {
    beforeWrite?: (ptyId: string) => void | Promise<void>
    suffixFailureError?: string
    signal?: AbortSignal
  } = {}
): Promise<number> {
  assertAgentPromptRequestActive(options.signal)
  ctx.assertAgentPromptGeneration(ptyId, generation)
  const permissionBaseline = ctx.deps.getAgentPromptActivity(handle, ptyId)
  ctx.deps.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
  const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
  // Why: the floor for every wait below. Enter must never overtake bytes the execution
  // host is still feeding the child, and that cost is proportional to the payload.
  const writeHostPlatform = ctx.deps.getPtyWriteHostPlatform(ptyId)
  const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
  const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
  const renderGate = ctx.deps.createAgentPromptRenderGate(ptyId, pasteIngestMs)
  let wrotePasteBytes = false
  let completedPaste = false
  try {
    const chunks = iterateTerminalInputChunks(pastePayload)
    let chunk = chunks.next()
    let firstChunk = true
    while (!chunk.done) {
      const nextChunk = chunks.next()
      assertAgentPromptRequestActive(options.signal)
      ctx.assertAgentPromptGeneration(ptyId, generation)
      // Why: the first chunk was just admitted above; re-checking the lease there would only
      // re-read what `assertAdmitted` established.
      if (!firstChunk) {
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      }
      firstChunk = false
      await options.beforeWrite?.(ptyId)
      assertAgentPromptRequestActive(options.signal)
      ctx.assertAgentPromptGeneration(ptyId, generation)
      ctx.deps.assertAgentPromptPermissionSafe(
        permissionBaseline,
        ctx.deps.getAgentPromptActivity(handle, ptyId)
      )
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      if (nextChunk.done) {
        renderGate?.arm()
      }
      const wrote = ctx.deps.ptyController()?.write(ptyId, chunk.value) ?? false
      if (!wrote) {
        throw new Error('terminal_not_writable')
      }
      wrotePasteBytes = true
      chunk = nextChunk
      if (!chunk.done) {
        await yieldBetweenTerminalInputChunks()
      }
    }
    completedPaste = true
  } catch (error) {
    if (wrotePasteBytes && !completedPaste && ctx.getPtyLifecycleGeneration(ptyId) === generation) {
      // Why: a lease that moved mid-paste also refuses this terminator, leaving the TUI in paste
      // mode — the incoming owner re-establishes the mode, and feeding a session we no longer own
      // is the worse outcome.
      try {
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        ctx.deps.ptyController()?.write(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
      } catch {
        // The original refusal is the actionable error.
      }
    }
    renderGate?.dispose()
    throw error
  }

  if (renderGate) {
    try {
      await waitForAgentPromptPromise(renderGate.wait(), options.signal)
    } finally {
      renderGate.dispose()
    }
  } else {
    await waitForAgentPromptDelay(
      getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength),
      options.signal
    )
  }
  assertAgentPromptRequestActive(options.signal)
  ctx.assertAgentPromptGeneration(ptyId, generation)
  agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
  try {
    await options.beforeWrite?.(ptyId)
  } catch (error) {
    if (options.suffixFailureError) {
      throw new Error(options.suffixFailureError)
    }
    throw error
  }
  assertAgentPromptRequestActive(options.signal)
  ctx.assertAgentPromptGeneration(ptyId, generation)
  const waitTextCache: AgentPromptWaitTextCache = {}
  const baseline = ctx.deps.getAgentPromptActivity(handle, ptyId, waitTextCache)
  ctx.deps.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
  agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
  const suffixWrote = ctx.deps.ptyController()?.write(ptyId, AGENT_PROMPT_SUBMIT) ?? false
  if (!suffixWrote) {
    throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
  }
  await verifyAgentPromptSubmission({
    baseline,
    readActivity: () => ctx.deps.getAgentPromptActivity(handle, ptyId, waitTextCache),
    timeoutMs: resolveAgentPromptEffectTimeoutMs(ctx.deps.getPtyAgent(ptyId)),
    signal: options.signal
  })
  return 1
}

export async function sendTerminalAgentPrompt(
  ctx: Ctx,
  handle: string,
  prompt: string,
  options: {
    beforeWrite?: (ptyId: string) => void | Promise<void>
    suffixFailureError?: string
    signal?: AbortSignal
  } = {}
): Promise<RuntimeTerminalSend> {
  const payload = buildAgentPromptPasteBytes(prompt)
  const pty = ctx.getLivePtyForHandle(handle)
  if (pty) {
    if (!pty.pty.connected) {
      throw new Error('terminal_not_writable')
    }
    await assertTerminalInputWithinLimitWithYield(payload)
    const generation = ctx.getPtyLifecycleGeneration(pty.pty.ptyId)
    const submits = await ctx.serializeAgentPromptSubmission(
      pty.pty.ptyId,
      generation,
      async () => {
        ctx.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
        ctx.assertAgentPromptGeneration(pty.pty.ptyId, generation)
        return await ctx.writeTerminalAgentPrompt(
          handle,
          pty.pty.ptyId,
          generation,
          payload,
          options
        )
      }
    )
    const bytesWritten = Buffer.byteLength(payload, 'utf8') + submits
    return { handle, accepted: true, bytesWritten }
  }

  const { leaf } = ctx.getLiveLeafForHandle(handle)
  if (!leaf.writable || !leaf.ptyId) {
    throw new Error('terminal_not_writable')
  }
  await assertTerminalInputWithinLimitWithYield(payload)
  // Why: same absence gate as sendTerminal — a stale graph mirror must not
  // accept a prompt into a void; unknown liveness still proceeds.
  if (await ctx.isLeafPtyProvenAbsent(leaf.ptyId)) {
    throw new Error('terminal_not_writable')
  }
  const generation = ctx.getPtyLifecycleGeneration(leaf.ptyId)
  const submits = await ctx.serializeAgentPromptSubmission(leaf.ptyId, generation, async () => {
    ctx.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId!)
    ctx.assertAgentPromptGeneration(leaf.ptyId!, generation)
    return await ctx.writeTerminalAgentPrompt(handle, leaf.ptyId!, generation, payload, options)
  })
  const bytesWritten = Buffer.byteLength(payload, 'utf8') + submits
  return { handle, accepted: true, bytesWritten }
}

export async function sendTerminal(
  ctx: Ctx,
  handle: string,
  action: {
    text?: string
    enter?: boolean
    interrupt?: boolean
  },
  options: {
    beforeWrite?: (ptyId: string) => void | Promise<void>
    reserveWrite?: (ptyId: string) => void
    afterWrite?: (ptyId: string) => void | Promise<void>
    suffixFailureError?: string
    // Why: the pre-Enter wait now scales with the payload, so an abandoned request must be
    // able to stop it instead of writing Enter minutes after the caller gave up.
    signal?: AbortSignal
  } = {}
): Promise<RuntimeTerminalSend> {
  const pty = ctx.getLivePtyForHandle(handle)
  if (pty) {
    if (!pty.pty.connected) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    await assertTerminalInputWithinLimitWithYield(action.text)
    await ctx.writeTerminalAction(pty.pty.ptyId, action, payload, options)
    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  const { leaf } = ctx.getLiveLeafForHandle(handle)
  if (!leaf.writable || !leaf.ptyId) {
    throw new Error('terminal_not_writable')
  }
  const payload = buildSendPayload(action)
  if (payload === null) {
    throw new Error('invalid_terminal_send')
  }
  await assertTerminalInputWithinLimitWithYield(action.text)
  // Why: leaf.writable mirrors the renderer graph, which can still answer for
  // a prior process's ptyId — and provider writes to unknown ids are accepted
  // no-ops. Only controller-proven absence rejects; unknown proceeds (a
  // restored daemon session takes writes before its pane remounts).
  if (await ctx.isLeafPtyProvenAbsent(leaf.ptyId)) {
    throw new Error('terminal_not_writable')
  }

  await ctx.writeTerminalAction(leaf.ptyId, action, payload, options)

  return {
    handle,
    accepted: true,
    bytesWritten: Buffer.byteLength(payload, 'utf8')
  }
}

export async function writeTerminalAction(
  ctx: Ctx,
  ptyId: string,
  action: { text?: string; enter?: boolean; interrupt?: boolean },
  payload: string,
  options: {
    beforeWrite?: (ptyId: string) => void | Promise<void>
    reserveWrite?: (ptyId: string) => void
    afterWrite?: (ptyId: string) => void | Promise<void>
    suffixFailureError?: string
    signal?: AbortSignal
  } = {}
): Promise<void> {
  // Why: the lease is checked before the mobile floor is reserved, so a refused send never takes
  // a claim it will not use.
  const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
  // Why: direct terminal.send can carry paste-sized text from RPC/mobile
  // clients; chunk text before PTY/ConPTY while preserving suffix separation.
  const text = typeof action.text === 'string' ? action.text : ''
  const hasSuffix = action.enter || action.interrupt
  if (text) {
    await ctx.writeTerminalInputChunks(ptyId, text, options, admitted)
  }
  if (hasSuffix) {
    const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
    if (text) {
      // Why: same hazard as the agent-prompt path -- Enter must not overtake text the
      // execution host is still ingesting, and a flat 500 ms cannot cover 16 MB.
      await waitForAgentPromptDelay(
        getAgentPromptSubmitDelayMs(
          ctx.deps.getPtyWriteHostPlatform(ptyId),
          Buffer.byteLength(text, 'utf8')
        ),
        options.signal
      )
    }
    // Why: the 500ms text/suffix pause is long enough for a handoff to complete, so the submit
    // is re-checked against the fence the text was admitted under.
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    try {
      await options.beforeWrite?.(ptyId)
    } catch (error) {
      if (options.suffixFailureError) {
        throw new Error(options.suffixFailureError)
      }
      throw error
    }
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    options.reserveWrite?.(ptyId)
    const suffixWrote = ctx.deps.ptyController()?.write(ptyId, suffix) ?? false
    if (!suffixWrote) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
    await options.afterWrite?.(ptyId)
    return
  }
  if (text) {
    return
  }

  await options.beforeWrite?.(ptyId)
  agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
  options.reserveWrite?.(ptyId)
  const wrote = ctx.deps.ptyController()?.write(ptyId, payload) ?? false
  if (!wrote) {
    throw new Error('terminal_not_writable')
  }
  await options.afterWrite?.(ptyId)
}

export function buildStartupForAgent(
  ctx: Ctx,
  repo: Repo,
  agent: TuiAgent,
  prompt: string | undefined,
  launchPreferences?: AgentLaunchPreferences
): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
  if (!ctx.deps.store()) {
    throw new Error('runtime_unavailable')
  }
  const settings = ctx.requireStore().getSettings()
  if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  // Why: CLI clients may target SSH runtimes from macOS/Windows, so quote for
  // the workspace shell rather than the client shell.
  const agentLaunchPlatform = ctx.deps.getAgentLaunchPlatformForRepo(repo)
  const isRemote = repoIsRemote(repo)
  const queuedShell = resolveLocalWindowsAgentStartupShell({
    platform: agentLaunchPlatform,
    isRemote,
    terminalWindowsShell: settings.terminalWindowsShell
  })
  const sessionOptions = ctx.toAgentSessionOptions(launchPreferences)
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: prompt ?? '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    sessionOptions,
    sessionOptionsOverrideAgentArgs: Boolean(sessionOptions),
    platform: agentLaunchPlatform,
    shell: queuedShell,
    isRemote,
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    throw new Error(`Could not build launch command for ${agent}.`)
  }
  return {
    agent,
    startup: {
      command: startupPlan.launchCommand,
      launchConfig: startupPlan.launchConfig,
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      ...(startupPlan.env ? { env: startupPlan.env } : {})
    },
    ...(startupPlan.followupPrompt
      ? {
          followup: {
            expectedProcess: startupPlan.expectedProcess,
            prompt: startupPlan.followupPrompt
          }
        }
      : {})
  }
}

export async function isTerminalRunningAgent(
  ctx: Ctx,
  handle: string,
  options: { retryForegroundWrappers?: boolean } = {}
): Promise<boolean> {
  try {
    const pty = ctx.getLivePtyForHandle(handle)
    if (pty) {
      const leaf = ctx.deps.getPrimaryLeafForPty(pty.pty.ptyId)
      return await ctx.deps.isPtyRunningAgent(pty.pty, leaf, options)
    }
    const { leaf } = ctx.getLiveLeafForHandle(handle)
    const trackedPty = leaf.ptyId ? ctx.deps.ptysById().get(leaf.ptyId) : null
    // Why: check the leaf pane title and the tab title, which already carries OSC-enriched agent indicators (e.g. ✳ prefix).
    const paneTitle = getLatestLeafTitle(leaf, null)
    const paneTitleClassification = classifyAgentTitle(paneTitle)
    if (
      trackedPty
        ? ptyTitleProvesAgentPresence(trackedPty, paneTitle, paneTitleClassification)
        : agentTitleProvesAgentPresence(paneTitle, paneTitleClassification)
    ) {
      return true
    }
    const tabTitle = ctx.deps.tabs().get(leaf.tabId)?.title?.trim() || null
    const tabTitleClassification = paneTitle === null ? classifyAgentTitle(tabTitle) : 'neutral'
    if (
      trackedPty
        ? ptyTitleProvesAgentPresence(trackedPty, tabTitle, tabTitleClassification)
        : agentTitleProvesAgentPresence(tabTitle, tabTitleClassification)
    ) {
      return true
    }
    const openCodeMarkerTitle = paneTitle ?? tabTitle
    const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    if (!isOpenCodeNativeTitle(openCodeMarkerTitle) && isKnownReadyPromptPreview(waitText)) {
      return true
    }
    const hasCurrentTitleEvidence = paneTitle !== null || tabTitle !== null
    if (leaf.lastAgentStatus !== null && !hasCurrentTitleEvidence) {
      return true
    }
    if (!leaf.ptyId || !ctx.deps.ptyController()) {
      return false
    }
    const fg = await ctx.deps.ptyController()!.getForegroundProcess(leaf.ptyId)
    // Why: a bare `Cursor Agent` title is identity, not liveness — it reads the same
    // whether cursor-agent is parked or long exited with the shell back. A null
    // foreground is untracked, not alive, so no-evidence must stay a refusal. A live
    // pane wrongly refused here means the read failed; fix that, not this.
    if (!fg) {
      return false
    }
    // Why: Claude's management UI runs under the Claude process but isn't a task-capable session; suppress only that process.
    const shouldSuppressClaudeForeground =
      paneTitleClassification === 'management' || tabTitleClassification === 'management'
    if (shouldSuppressClaudeForeground && isExpectedAgentProcess(fg, 'claude')) {
      return false
    }
    // Why: review-note delivery auto-submits with Enter, so only known agent processes are safe (not arbitrary focused TUIs).
    return await ctx.deps.isRecognizedForegroundAgentProcess(leaf.ptyId, fg, {
      suppressClaude: shouldSuppressClaudeForeground,
      retryWrappers: options.retryForegroundWrappers !== false
    })
  } catch {
    return false
  }
}

export function getFreshExplicitAgentStatusForHandle(
  ctx: Ctx,
  handle: string,
  paneKeyOverride?: string | null
): {
  status: NonNullable<RuntimeTerminalAgentStatus['status']>
  updatedAt: number
  /** When this state was entered. Pinned across same-state pings, so it identifies the turn. */
  stateStartedAt: number
} | null {
  const paneKey = paneKeyOverride ?? ctx.getPaneKeyForTerminalHandle(handle)
  const now = Date.now()
  let bestStatus: NonNullable<RuntimeTerminalAgentStatus['status']> | null = null
  let bestUpdatedAt = -1
  let bestStateStartedAt = -1

  const consider = (
    state: AgentStatusEntry['state'] | undefined,
    updatedAt: number | null | undefined,
    restoredUnconfirmed = false,
    stateStartedAt?: number | null
  ): void => {
    if (!state || restoredUnconfirmed) {
      return
    }
    if (typeof updatedAt !== 'number' || now - updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
      return
    }
    const status = mapExplicitAgentStateToRuntimeTerminalStatus(state)
    // Why: older retained permission rows can remain visible after the agent
    // resumes. Prefer the newest explicit state; only let permission win ties.
    if (updatedAt > bestUpdatedAt || (updatedAt === bestUpdatedAt && status === 'permission')) {
      bestStatus = status
      bestUpdatedAt = updatedAt
      bestStateStartedAt = typeof stateStartedAt === 'number' ? stateStartedAt : updatedAt
    }
  }

  if (paneKey) {
    const retained = ctx.deps.latestAgentStatusByPaneKey().get(paneKey)
    consider(retained?.payload.state, retained?.updatedAt, false, retained?.stateStartedAt)
  }

  for (const entry of ctx.deps.getAgentStatusSnapshotFn()?.() ?? []) {
    if (entry.terminalHandle !== handle && (!paneKey || entry.paneKey !== paneKey)) {
      continue
    }
    consider(entry.state, entry.receivedAt, entry.restoredUnconfirmed, entry.stateStartedAt)
  }

  return bestStatus
    ? { status: bestStatus, updatedAt: bestUpdatedAt, stateStartedAt: bestStateStartedAt }
    : null
}

export async function getTerminalAgentStatus(
  ctx: Ctx,
  handle: string
): Promise<RuntimeTerminalAgentStatus> {
  const ptyId = ctx.deps.getTerminalAgentStatusPtyId(handle)
  const terminal = ctx.deps.getTerminalAgentStatusSnapshot(handle, ptyId)
  const explicitStatus = ctx.getFreshExplicitAgentStatusForHandle(handle)
  const lifecycle = ctx.deps.agentPromptLifecycleByPtyId().get(ptyId)
  if (
    (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) ||
    ctx.deps.hasAuthoritativeTerminalWaitPermission(terminal, explicitStatus, lifecycle)
  ) {
    return { handle, isRunningAgent: true, status: 'permission' }
  }
  if (explicitStatus) {
    // Why: permission titles can linger after hooks report the agent resumed.
    // Fresh hook state is tighter, but current shell/management evidence wins.
    const isRunningAgent =
      !terminalTitleBlocksExplicitAgentStatus(terminal.title) &&
      !(await ctx.terminalHasShellForegroundProcess(handle, ptyId))
    ctx.deps.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    return {
      handle,
      isRunningAgent,
      status: isRunningAgent ? explicitStatus.status : null
    }
  }
  if (terminal.titleStatus) {
    // Why: an OpenCode marker and a lone quarter-circle spinner (STA-4028) are activity,
    // not identity, so resolve both through the identity/foreground evidence path.
    if (
      isOpenCodeNativeTitle(terminal.title) ||
      isQuarterCircleSpinnerOnlyAgentTitle(terminal.title)
    ) {
      const isRunningAgent = await ctx.isTerminalRunningAgent(handle)
      ctx.deps.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return {
        handle,
        isRunningAgent,
        status: isRunningAgent ? terminal.titleStatus : null
      }
    }
    return { handle, isRunningAgent: true, status: terminal.titleStatus }
  }

  const isRunningAgent = await ctx.isTerminalRunningAgent(handle)
  ctx.deps.assertTerminalAgentStatusPtyBinding(handle, ptyId)
  return { handle, isRunningAgent, status: null }
}

export function seedHeadlessTerminal(
  ctx: Ctx,
  ptyId: string,
  data: string,
  size?: { cols: number; rows: number },
  metadata: HeadlessSeedMetadata = {}
): void {
  if (!data) {
    return
  }
  const existing = ctx.deps.headlessTerminals().get(ptyId)
  if (existing) {
    // Why: emulator already has live data — re-seeding would duplicate
    // every byte. The seed is only valid when the emulator is fresh.
    if (metadata.preferProviderIfExisting) {
      ctx.deps.providerSnapshotPreferredPtys().add(ptyId)
    }
    return
  }
  const dims = size ?? ctx.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  const state = ctx.createPtyHeadlessTerminalState(ptyId, dims)
  state.outputSequence = ctx.getPtyOutputSequence(ptyId)
  ctx.deps.headlessTerminals().set(ptyId, state)
  ctx.deps.recordOsc7MetadataForPty(ptyId, data)
  ctx.recordRecentPtyOutputForPathProvenance(ptyId, data)
  state.writeChain = state.writeChain
    .then(async () => {
      // Why: seed writes never set forwardQueryReplies — the main-side
      // replay guard. A snapshot containing old queries must answer no one.
      await state.emulator.write(data)
      // Why AFTER the seed write: the snapshot payload cannot carry kitty
      // pushes (rehydrateSequences deliberately omits them), but ordering
      // behind it keeps the parse deterministic. Unflagged like the seed —
      // re-applying flags must answer no one.
      if (typeof metadata.kittyKeyboardFlags === 'number') {
        await state.emulator.applyKittyKeyboardFlags(metadata.kittyKeyboardFlags)
      }
      if (metadata.cwd !== undefined) {
        state.emulator.setCwd(metadata.cwd)
      }
      if (metadata.oscLinks !== undefined) {
        state.emulator.setRestoredOscLinks(metadata.oscLinks)
      }
      // Why derived from the emulator: the seed bytes bypass ownership.scan,
      // so the scanner must inherit the restored alternate-screen state or a
      // pane seeded mid-TUI never arms its recovery trigger.
      state.ownership.seedOwner(metadata.terminalOwner, {
        alternateScreen: state.emulator.isAlternateScreen
      })
      ctx.deps.providerSnapshotPreferredPtys().delete(ptyId)
    })
    .catch(() => {
      // Seeding is best-effort; live data will continue to populate the
      // emulator even if the snapshot replay fails.
    })
}

export async function reconcileRemoteTerminalCreate(
  ctx: Ctx,
  worktreeId: string,
  terminalHandle: string
): Promise<RuntimeTerminalCreate | null> {
  if (!ctx.deps.ptyController()?.listProcesses) {
    throw new Error('runtime_unavailable')
  }
  const listed = await withTimeoutResult(
    ctx.deps.ptyController()!.listProcesses!(),
    PTY_CONTROLLER_LIST_TIMEOUT_MS
  )
  if (!listed.ok) {
    // Why: unknown inventory cannot prove the first create failed, so spawning could duplicate a live shell.
    throw new Error('runtime_unavailable')
  }
  const matches = listed.value.filter((session) => session.terminalHandle === terminalHandle)
  if (matches.length > 1) {
    throw new Error('terminal_create_identity_conflict')
  }
  if (matches.length === 0) {
    const sameWorktreeHasUnknownIdentity = listed.value.some(
      (session) =>
        (session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)) === worktreeId &&
        !session.terminalHandle
    )
    if (sameWorktreeHasUnknownIdentity) {
      // Why: older retained providers may list the first shell without its handle; absence is not authoritative in that shape.
      throw new Error('runtime_unavailable')
    }
    return null
  }
  const session = matches[0]
  const authoritativeWorktreeId = session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)
  if (authoritativeWorktreeId !== worktreeId) {
    // Why: a reused address or forged provider record must never adopt a PTY from another workspace.
    throw new Error('terminal_create_identity_conflict')
  }
  ctx.adoptControllerTerminalHandle(session.id, terminalHandle)
  const pty = ctx.deps.recordPtyWorktree(session.id, worktreeId, {
    connected: true,
    title: session.title
  })
  const adoptedHandle = ctx.deps.issuePtyHandle(pty)
  if (adoptedHandle !== terminalHandle) {
    throw new Error('terminal_create_identity_conflict')
  }
  return {
    handle: adoptedHandle,
    ptyId: session.id,
    worktreeId,
    title: session.title || null,
    surface: 'background'
  }
}
