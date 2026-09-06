/* eslint-disable max-lines -- Why: terminal create/orphan adoption are one transactional flow; further split needs state-owner extraction. */
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess
} from '../../shared/claude-agent-teams-tmux-compat'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeTerminalCreate,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  copySleepingAgentLaunchConfig,
  inferCapturedClaudeAgentTeamsMode,
  mergeTerminalEnvDeletionKeys
} from './agent-session-terminal-operations'
import { buildClaudeAgentTeamsLaunchPlan } from './claude-agent-teams-shim-env'
import type {
  PtyControllerInventory,
  RuntimePtyController,
  TerminalCreateOptions,
  TerminalWorkspaceLaunchScope
} from './orca-runtime'
import { createTerminalRevealWarning } from './orca-runtime'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import {
  canonicalizeTerminalSessionWorktreeId,
  getLatestPtyTitle,
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-tail-projection'
import { ownerSurfacing, resolveTerminalPresentation } from './runtime-terminal-surface-shared'
import { terminalOrphanExecutionOwnersEqual } from './terminal-orphan-owner'
import {
  hasExactTerminalOrphanGroupLayout,
  mergeTerminalOrphanGroupLayout
} from './terminal-orphan-topology'
import { getTerminalViewColorQueryReplyColors } from './terminal-view-attribute-store'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'
import { randomUUID } from 'node:crypto'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export async function adoptTerminalOrphansFromInventory(
  ctx: Ctx,
  request: RuntimeTerminalOrphanAdoptionRequest,
  workspace: TerminalWorkspaceLaunchScope,
  inventory: PtyControllerInventory
): Promise<RuntimeTerminalOrphanAdoptionResult> {
  const { livePtyIds, terminalIdentityByPtyId } = inventory
  const store = ctx.deps.store()
  const session = ctx.getWorkspaceSessionForWorktree(workspace.id)
  if (
    !store?.setWorkspaceSession ||
    (!store.flushPendingOrThrowAsync && !store.flushOrThrow) ||
    !session
  ) {
    throw new Error('workspace_session_unavailable')
  }
  const sessionWorktreeId = resolveTerminalSessionWorktreeId(session, workspace.id)
  if (!sessionWorktreeId) {
    throw new Error('terminal_orphan_competing_owner')
  }
  const repoId = getRepoIdFromWorktreeId(workspace.id)
  const worktreeConnectionId = workspace.connectionId
  let worktreeWslDistro: string | null = null
  if (!worktreeConnectionId && workspace.repo) {
    try {
      worktreeWslDistro =
        getLocalProjectWorktreeGitOptions(ctx.requireStore(), workspace.repo).wslDistro ?? null
    } catch {
      throw new Error('terminal_orphan_owner_mismatch')
    }
  }
  const currentRevision = ctx.getTerminalTopologyRevision(workspace.id)
  const seenPtyIds = new Set<string>()
  const seenPaneKeys = new Set<string>()
  const validated = request.claims.map((claim) => {
    const paneKey = makePaneKey(claim.tabId, claim.leafId)
    if (seenPtyIds.has(claim.ptyId) || seenPaneKeys.has(paneKey)) {
      throw new Error('terminal_orphan_claim_duplicate')
    }
    seenPtyIds.add(claim.ptyId)
    seenPaneKeys.add(paneKey)
    const live = ctx.getLivePtyForHandle(claim.terminal)
    const pty = live?.pty
    const controllerIdentity = terminalIdentityByPtyId.get(claim.ptyId)
    if (
      !pty ||
      pty.ptyId !== claim.ptyId ||
      controllerIdentity?.handle !== claim.terminal ||
      controllerIdentity?.incarnationId !== claim.incarnationId ||
      !livePtyIds.has(claim.ptyId) ||
      !pty.connected ||
      !pty.incarnationId ||
      pty.incarnationId !== claim.incarnationId
    ) {
      throw new Error('terminal_orphan_stale')
    }
    if (
      !runtimeWorktreeIdsEqual(pty.worktreeId, workspace.id) ||
      !terminalOrphanExecutionOwnersEqual(
        { connectionId: worktreeConnectionId, wslDistro: worktreeWslDistro },
        {
          connectionId: pty.connectionId ?? null,
          ...(controllerIdentity?.wslDistro !== undefined
            ? { wslDistro: controllerIdentity.wslDistro }
            : process.platform === 'win32' && !worktreeConnectionId
              ? {}
              : { wslDistro: null })
        }
      )
    ) {
      throw new Error('terminal_orphan_owner_mismatch')
    }
    const visualOwners = ctx.getLeavesForPty(claim.ptyId)
    if (
      visualOwners.some(
        (owner) =>
          !runtimeWorktreeIdsEqual(owner.worktreeId, workspace.id) ||
          owner.tabId !== claim.tabId ||
          owner.leafId !== claim.leafId
      )
    ) {
      throw new Error('terminal_orphan_already_visual')
    }
    if ((pty.tabId && pty.tabId !== claim.tabId) || (pty.paneKey && pty.paneKey !== paneKey)) {
      throw new Error('terminal_orphan_competing_owner')
    }
    return { claim, pty, paneKey }
  })

  const persistedBindingsByPtyId = new Map<string, { worktreeId: string; paneKey: string }[]>()
  const addPersistedBinding = (
    ptyId: string,
    binding: { worktreeId: string; paneKey: string }
  ): void => {
    const bindings = persistedBindingsByPtyId.get(ptyId) ?? []
    bindings.push(binding)
    persistedBindingsByPtyId.set(ptyId, bindings)
  }
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = session.terminalLayoutsByTabId[tab.id]
      for (const [leafId, boundPtyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (boundPtyId) {
          addPersistedBinding(boundPtyId, {
            worktreeId,
            paneKey: makePaneKey(tab.id, leafId)
          })
        }
      }
      if (tab.ptyId && !layout) {
        addPersistedBinding(tab.ptyId, { worktreeId, paneKey: tab.id })
      }
    }
  }
  const persistedBinding = (ptyId: string): { worktreeId: string; paneKey: string } | null => {
    const bindings = persistedBindingsByPtyId.get(ptyId) ?? []
    if (bindings.length > 1) {
      throw new Error('terminal_orphan_competing_owner')
    }
    return bindings[0] ?? null
  }
  const isExactPersisted = validated.every(({ claim, paneKey }) => {
    const binding = persistedBinding(claim.ptyId)
    return (
      binding !== null &&
      runtimeWorktreeIdsEqual(binding.worktreeId, workspace.id) &&
      binding.paneKey === paneKey &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === claim.incarnationId
    )
  })
  if (isExactPersisted && sessionWorktreeId === workspace.id) {
    for (const { claim, pty, paneKey } of validated) {
      pty.tabId = claim.tabId
      pty.paneKey = paneKey
    }
    return {
      adopted: false,
      topologyRevision: currentRevision,
      snapshot: ctx.getTerminalOrphanAdoptionSnapshot(workspace.id)
    }
  }
  if (currentRevision !== request.expectedTopologyRevision) {
    throw new Error('terminal_topology_conflict')
  }

  const topologyTabsById = new Map(request.topology?.tabs.map((tab) => [tab.tabId, tab]) ?? [])
  const topologyGroups = request.topology?.groups ?? []
  if (request.topology) {
    const claimedLeafIdsByTabId = new Map<string, Set<string>>()
    for (const { claim } of validated) {
      const leafIds = claimedLeafIdsByTabId.get(claim.tabId) ?? new Set<string>()
      leafIds.add(claim.leafId)
      claimedLeafIdsByTabId.set(claim.tabId, leafIds)
    }
    if (
      topologyTabsById.size !== request.topology.tabs.length ||
      topologyTabsById.size !== claimedLeafIdsByTabId.size
    ) {
      throw new Error('terminal_orphan_topology_invalid')
    }
    for (const [tabId, claimedLeafIds] of claimedLeafIdsByTabId) {
      const topologyTab = topologyTabsById.get(tabId)
      if (!topologyTab) {
        throw new Error('terminal_orphan_topology_invalid')
      }
      const topologyLeafIds = new Set<string>()
      const nodes = [topologyTab.root]
      let leafCount = 0
      while (nodes.length > 0) {
        const node = nodes.pop()!
        if (node.type === 'leaf') {
          leafCount += 1
          topologyLeafIds.add(node.leafId)
        } else {
          nodes.push(node.first, node.second)
        }
      }
      if (
        leafCount !== topologyLeafIds.size ||
        topologyLeafIds.size !== claimedLeafIds.size ||
        [...topologyLeafIds].some((leafId) => !claimedLeafIds.has(leafId)) ||
        !topologyLeafIds.has(topologyTab.activeLeafId) ||
        (topologyTab.expandedLeafId !== null && !topologyLeafIds.has(topologyTab.expandedLeafId))
      ) {
        throw new Error('terminal_orphan_topology_invalid')
      }
    }
    const seenGroupIds = new Set<string>()
    const groupedTabIds = new Set<string>()
    for (const group of topologyGroups) {
      if (seenGroupIds.has(group.id) || !group.tabOrder.includes(group.activeTabId)) {
        throw new Error('terminal_orphan_topology_invalid')
      }
      seenGroupIds.add(group.id)
      for (const tabId of group.tabOrder) {
        if (!topologyTabsById.has(tabId) || groupedTabIds.has(tabId)) {
          throw new Error('terminal_orphan_topology_invalid')
        }
        groupedTabIds.add(tabId)
      }
      if (group.recentTabIds?.some((tabId) => !group.tabOrder.includes(tabId))) {
        throw new Error('terminal_orphan_topology_invalid')
      }
    }
    if (groupedTabIds.size !== topologyTabsById.size) {
      throw new Error('terminal_orphan_topology_invalid')
    }
    if (request.topology.groupLayout) {
      if (!hasExactTerminalOrphanGroupLayout(request.topology.groupLayout, seenGroupIds)) {
        throw new Error('terminal_orphan_topology_invalid')
      }
    }
  }

  for (const { claim, paneKey } of validated) {
    const existingBinding = persistedBinding(claim.ptyId)
    if (
      existingBinding &&
      (!runtimeWorktreeIdsEqual(existingBinding.worktreeId, workspace.id) ||
        existingBinding.paneKey !== paneKey)
    ) {
      throw new Error('terminal_orphan_competing_owner')
    }
    const proposedPtyId =
      session.terminalLayoutsByTabId[claim.tabId]?.ptyIdsByLeafId?.[claim.leafId]
    if (proposedPtyId && proposedPtyId !== claim.ptyId) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    const graphOwner = ctx.deps.leaves().get(ctx.getLeafKey(claim.tabId, claim.leafId))
    if (
      graphOwner &&
      (graphOwner.ptyId !== claim.ptyId ||
        !runtimeWorktreeIdsEqual(graphOwner.worktreeId, workspace.id))
    ) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    if (
      Object.entries(session.tabsByWorktree).some(
        ([ownerWorktreeId, tabs]) =>
          !runtimeWorktreeIdsEqual(ownerWorktreeId, workspace.id) &&
          tabs.some((tab) => tab.id === claim.tabId)
      )
    ) {
      throw new Error('terminal_orphan_surface_occupied')
    }
    if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
      throw new Error('terminal_orphan_surface_retired')
    }
    for (const snapshot of ctx.deps.mobileSessionTabsByWorktree().values()) {
      const surfaceOwner = snapshot.tabs.find(
        (tab): tab is RuntimeMobileSessionTerminalTab =>
          tab.type === 'terminal' && tab.parentTabId === claim.tabId && tab.leafId === claim.leafId
      )
      if (
        surfaceOwner &&
        (snapshot.worktree !== workspace.id || surfaceOwner.ptyId !== claim.ptyId)
      ) {
        throw new Error('terminal_orphan_surface_occupied')
      }
      const owner = snapshot.tabs.find(
        (tab): tab is RuntimeMobileSessionTerminalTab =>
          tab.type === 'terminal' && tab.ptyId === claim.ptyId
      )
      if (
        owner &&
        (snapshot.worktree !== workspace.id ||
          owner.parentTabId !== claim.tabId ||
          owner.leafId !== claim.leafId)
      ) {
        throw new Error('terminal_orphan_competing_owner')
      }
    }
  }

  const next = structuredClone(session)
  canonicalizeTerminalSessionWorktreeId(next, sessionWorktreeId, workspace.id)
  const existingTabs = next.tabsByWorktree[workspace.id] ?? []
  const tabsById = new Map(existingTabs.map((tab) => [tab.id, tab]))
  for (const { claim, pty, paneKey } of validated) {
    let tab = tabsById.get(claim.tabId)
    if (!tab) {
      const title = getLatestPtyTitle(pty) ?? pty.controllerTitle ?? `Terminal ${tabsById.size + 1}`
      tab = {
        id: claim.tabId,
        ptyId: claim.ptyId,
        worktreeId: workspace.id,
        title,
        defaultTitle: title,
        customTitle: null,
        color: null,
        sortOrder: tabsById.size,
        createdAt: Date.now(),
        pendingActivationSpawn: true
      }
      tabsById.set(claim.tabId, tab)
    }
    const existingLayout = next.terminalLayoutsByTabId[claim.tabId]
    const topologyTab = topologyTabsById.get(claim.tabId)
    next.terminalLayoutsByTabId[claim.tabId] = topologyTab
      ? {
          ...existingLayout,
          root: topologyTab.root,
          activeLeafId: topologyTab.activeLeafId,
          expandedLeafId: topologyTab.expandedLeafId,
          ptyIdsByLeafId: {
            ...existingLayout?.ptyIdsByLeafId,
            [claim.leafId]: claim.ptyId
          }
        }
      : existingLayout
        ? {
            ...existingLayout,
            root: ctx.deps.collectPersistedTerminalLeafIds(existingLayout).includes(claim.leafId)
              ? existingLayout.root
              : existingLayout.root === null
                ? { type: 'leaf', leafId: claim.leafId }
                : {
                    type: 'split',
                    direction: 'vertical',
                    first: existingLayout.root,
                    second: { type: 'leaf', leafId: claim.leafId }
                  },
            ptyIdsByLeafId: {
              ...existingLayout.ptyIdsByLeafId,
              [claim.leafId]: claim.ptyId
            }
          }
        : {
            root: { type: 'leaf', leafId: claim.leafId },
            activeLeafId: claim.leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [claim.leafId]: claim.ptyId }
          }
    next.terminalPtyIncarnationsByPaneKey = {
      ...next.terminalPtyIncarnationsByPaneKey,
      [paneKey]: claim.incarnationId
    }
  }
  const adoptedTabIds = [...new Set(validated.map(({ claim }) => claim.tabId))]
  next.tabsByWorktree[workspace.id] = [...tabsById.values()]
  const activeTabId =
    request.activeTabId && tabsById.has(request.activeTabId)
      ? request.activeTabId
      : (adoptedTabIds[0] ?? null)
  const existingGroups = next.tabGroups?.[workspace.id] ?? []
  const targetGroupId =
    (request.activeGroupId && existingGroups.some((group) => group.id === request.activeGroupId)
      ? request.activeGroupId
      : existingGroups[0]?.id) ??
    request.activeGroupId ??
    randomUUID()
  const proposedGroups = topologyGroups.map((group) => ({
    ...group,
    worktreeId: workspace.id
  }))
  const groups =
    existingGroups.length === 0 && proposedGroups.length > 0
      ? proposedGroups
      : existingGroups.length > 0
        ? existingGroups
            .map((group) => {
              const proposed = proposedGroups.find((candidate) => candidate.id === group.id)
              const tabOrder = proposed
                ? [
                    ...group.tabOrder.filter((tabId) => !adoptedTabIds.includes(tabId)),
                    ...proposed.tabOrder
                  ]
                : group.id === targetGroupId && proposedGroups.length === 0
                  ? [...new Set([...group.tabOrder, ...adoptedTabIds])]
                  : group.tabOrder.filter((tabId) => !adoptedTabIds.includes(tabId))
              return {
                ...group,
                tabOrder,
                activeTabId: proposed
                  ? proposed.activeTabId
                  : group.id === targetGroupId && activeTabId
                    ? activeTabId
                    : group.activeTabId && tabOrder.includes(group.activeTabId)
                      ? group.activeTabId
                      : (tabOrder[0] ?? null),
                ...(proposed?.recentTabIds ? { recentTabIds: proposed.recentTabIds } : {})
              }
            })
            .concat(
              proposedGroups.filter(
                (proposed) => !existingGroups.some((group) => group.id === proposed.id)
              )
            )
        : [{ id: targetGroupId, worktreeId: workspace.id, activeTabId, tabOrder: adoptedTabIds }]
  const retainedGroups = groups.filter((group) => group.tabOrder.length > 0)
  next.tabGroups = {
    ...next.tabGroups,
    [workspace.id]: retainedGroups
  }
  const mergedGroupLayout = mergeTerminalOrphanGroupLayout({
    existingLayout: next.tabGroupLayouts?.[workspace.id],
    existingGroupIds: existingGroups.map((group) => group.id),
    proposedLayout: request.topology?.groupLayout,
    proposedGroupIds: proposedGroups.map((group) => group.id),
    mergedGroupIds: retainedGroups.map((group) => group.id)
  })
  if (mergedGroupLayout) {
    next.tabGroupLayouts = {
      ...next.tabGroupLayouts,
      [workspace.id]: mergedGroupLayout
    }
  }
  const activeGroup =
    (request.activeGroupId
      ? retainedGroups.find(
          (group) =>
            group.id === request.activeGroupId &&
            (!activeTabId || group.tabOrder.includes(activeTabId))
        )
      : undefined) ??
    retainedGroups.find((group) => activeTabId && group.tabOrder.includes(activeTabId)) ??
    retainedGroups[0]!
  const convergedActiveTabId =
    activeTabId && activeGroup.tabOrder.includes(activeTabId)
      ? activeTabId
      : activeGroup.activeTabId
  next.activeTabIdByWorktree = {
    ...next.activeTabIdByWorktree,
    ...(convergedActiveTabId ? { [workspace.id]: convergedActiveTabId } : {})
  }
  next.activeGroupIdByWorktree = {
    ...next.activeGroupIdByWorktree,
    [workspace.id]: activeGroup.id
  }
  const persisted = advanceTerminalTopologyRevision(next, workspace.id)
  let staged: WorkspaceSessionState | null = null
  try {
    ctx.setWorkspaceSessionForWorktree(workspace.id, persisted)
    staged = ctx.getWorkspaceSessionForWorktree(workspace.id)
    await ctx.flushWorkspaceSessionOrThrowAsync()
  } catch (error) {
    const current = ctx.getWorkspaceSessionForWorktree(workspace.id)
    if (staged && current) {
      const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
      if (rolledBack !== current) {
        ctx.setWorkspaceSessionForWorktree(workspace.id, rolledBack)
      }
    }
    throw error
  }
  for (const { claim, pty, paneKey } of validated) {
    pty.tabId = claim.tabId
    pty.paneKey = paneKey
  }
  ctx.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(workspace.id, {
    force: true,
    allowAttachedWindow: true,
    onlyRuntimeOwnedTerminals: true
  })
  ctx.deps.notifyMobileSessionTabsChanged(workspace.id)
  return {
    adopted: true,
    topologyRevision: persisted.terminalTopologyRevisionByRepoId?.[repoId] ?? currentRevision + 1,
    snapshot: ctx.getTerminalOrphanAdoptionSnapshot(workspace.id)
  }
}

export async function createTerminal(
  ctx: Ctx,
  worktreeSelector?: string,
  opts: TerminalCreateOptions = {}
): Promise<RuntimeTerminalCreate> {
  if (opts.startupAgent && worktreeSelector === undefined) {
    // Why: the launch is resolved against a workspace, so with no selector
    // startupAgent is silently dropped and the terminal is a bare shell.
    throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
  }
  const presentation = resolveTerminalPresentation(opts)
  const requiresRendererFocus = opts.presentation === 'focused' || opts.focus === true
  const availableAuthoritativeWindow = ctx.deps.getAvailableAuthoritativeWindow()
  // Why: pre-diff createTerminal fell back to the renderer's active worktree
  // when no selector was provided. The new background-spawn branch hard-
  // requires a resolvable selector, so route the no-selector case through
  // the renderer IPC path to preserve that behavior.
  const rendererWindow = opts.rendererBacked === true ? availableAuthoritativeWindow : null
  const shouldCreateInBackground =
    worktreeSelector !== undefined &&
    (Boolean(opts.agentSessionClaim) ||
      (!requiresRendererFocus && opts.rendererBacked !== true) ||
      // Why: `orca serve` exposes the local runtime without a renderer
      // window. Renderer-backed and focus-requested creates are preferred on
      // the renderer, but with no window a background spawn is the only
      // usable path — otherwise getAuthoritativeWindow() below throws and the
      // caller gets no terminal at all (#10333). Focus is not lost: the
      // spawned pane is still published and revealed with `activate`.
      availableAuthoritativeWindow === null)

  if (shouldCreateInBackground) {
    if (!ctx.deps.ptyController()?.spawn) {
      throw new Error('runtime_unavailable')
    }
    const workspace = await ctx.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const launchOpts = await ctx.resolveAgentTerminalCreateOptions(workspace, opts)
    let ptySpawnCommitReported = false
    const reportPtySpawnCommitted = (): void => {
      if (ptySpawnCommitReported) {
        return
      }
      ptySpawnCommitReported = true
      launchOpts.onPtySpawnCommitted?.()
    }
    const cwd = ctx.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
    let preAllocatedHandle = launchOpts.preAllocatedHandle ?? ctx.createPreAllocatedTerminalHandle()
    // Why: mint tabId in main before spawn so paneKey is known at PTY env
    // build time. Hook-based agent status (Claude/Codex/Cursor/Gemini) keys
    // off `${tabId}:${leafId}` — without these vars set on the PTY, the
    // hook payload arrives with an empty paneKey and the renderer cannot
    // attribute the event. Use a stable UUID leaf because hooks reject the
    // legacy numeric pane keys after the pane-id migration.
    const hintedTabId = launchOpts.tabId?.trim()
    const canAdoptPaneIdentity =
      hintedTabId !== undefined &&
      isValidHostTerminalTabId(hintedTabId) &&
      launchOpts.leafId !== undefined &&
      isTerminalLeafId(launchOpts.leafId)
    let tabId = canAdoptPaneIdentity ? (hintedTabId as string) : randomUUID()
    let leafId = canAdoptPaneIdentity ? (launchOpts.leafId as string) : randomUUID()
    let paneKey = makePaneKey(tabId, leafId)
    const claimedStablePaneCreate = ctx.deps.ptyController()!.claimStablePaneCreate?.({
      worktreeId: workspace.id,
      connectionId: workspace.connectionId,
      tabId,
      leafId
    })
    let stablePaneCreateReleased = false
    const releaseStablePaneCreate = (): void => {
      if (stablePaneCreateReleased) {
        return
      }
      stablePaneCreateReleased = true
      claimedStablePaneCreate?.()
    }
    try {
      if (launchOpts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      const adoptedBeforeLaunch = await ctx.deps.ptyController()!.adoptStablePane?.({
        cols: 120,
        rows: 40,
        cwd,
        connectionId: workspace.connectionId,
        worktreeId: workspace.id,
        preAllocatedHandle,
        tabId,
        leafId
      })
      const launchToken = launchOpts.launchConfig
        ? (launchOpts.launchToken ?? randomUUID())
        : undefined
      const baseEnv = {
        ...launchOpts.env,
        ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
      }
      const claudeAgentTeamsSourceCommand =
        launchOpts.claudeAgentTeamsSourceCommand?.trim() || launchOpts.command?.trim() || undefined
      const claudeAgentTeamsMode = ctx.deps.store()?.getSettings?.().claudeAgentTeamsMode
      const effectiveClaudeAgentTeamsMode = inferCapturedClaudeAgentTeamsMode(
        launchOpts.launchConfig,
        claudeAgentTeamsSourceCommand,
        claudeAgentTeamsMode
      )
      let agentTeamsPlan: Awaited<ReturnType<typeof buildClaudeAgentTeamsLaunchPlan>> | undefined
      try {
        agentTeamsPlan = adoptedBeforeLaunch
          ? undefined
          : await buildClaudeAgentTeamsLaunchPlan({
              command: claudeAgentTeamsSourceCommand,
              mode: effectiveClaudeAgentTeamsMode,
              baseEnv: {
                ...process.env,
                ...baseEnv
              },
              createTeamEnv: (shimDir, shimBin) =>
                ctx.deps.claudeAgentTeams().createLaunchEnv({
                  leaderHandle: preAllocatedHandle,
                  baseEnv: {
                    ...process.env,
                    ...baseEnv
                  },
                  shimDir,
                  shimBin
                }).env
            })
      } catch (error) {
        releaseStablePaneCreate?.()
        throw error
      }
      const sequencedStartupCommand =
        agentTeamsPlan &&
        claudeAgentTeamsSourceCommand &&
        launchOpts.command &&
        claudeAgentTeamsSourceCommand !== launchOpts.command
          ? agentTeamsPlan.command
          : undefined
      const effectiveLaunchConfig =
        launchOpts.launchConfig && agentTeamsPlan
          ? {
              ...launchOpts.launchConfig,
              agentCommand: launchOpts.launchConfig.agentCommand
                ? effectiveClaudeAgentTeamsMode === 'in-process' || process.platform === 'win32'
                  ? addClaudeTeammateModeInProcess(launchOpts.launchConfig.agentCommand)
                  : addClaudeTeammateModeAuto(launchOpts.launchConfig.agentCommand)
                : agentTeamsPlan.command,
              agentEnv: {
                ...launchOpts.launchConfig.agentEnv,
                ...agentTeamsPlan.env
              }
            }
          : launchOpts.launchConfig
      // Why: setup/agent sequencing wraps the PTY launch in a wait shell before
      // Claude Agent Teams runs. Preserve the direct Claude command separately
      // so the wrapper can exec the teammate-mode variant after setup completes.
      const env = ctx.buildTerminalWorkspaceEnv(
        workspace,
        {
          ...baseEnv,
          ...(sequencedStartupCommand
            ? { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand }
            : {})
        },
        paneKey,
        tabId,
        agentTeamsPlan?.env
      )
      const terminalColorQueryReplies =
        launchOpts.terminalColorQueryReplies ?? getTerminalViewColorQueryReplyColors()
      if (launchOpts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      let result: Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>
      try {
        result = await ctx.deps.ptyController()!.spawn!({
          cols: 120,
          rows: 40,
          cwd,
          command: sequencedStartupCommand
            ? launchOpts.command
            : (agentTeamsPlan?.command ?? launchOpts.command),
          launchAgent: launchOpts.launchAgent,
          commandDelivery: 'provider',
          startupCommandDelivery: launchOpts.startupCommandDelivery,
          env,
          envToDelete: mergeTerminalEnvDeletionKeys(
            launchOpts.envToDelete,
            agentTeamsPlan?.envToDelete
          ),
          resumeProviderSession: launchOpts.resumeProviderSession,
          telemetry: launchOpts.telemetry,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId,
          ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
          ...(launchOpts.agentSessionClaim
            ? {
                agentSessionEnsure: {
                  claim: launchOpts.agentSessionClaim,
                  surface: {
                    worktreeId: workspace.id,
                    tabId,
                    leafId,
                    terminalHandle: preAllocatedHandle
                  }
                }
              }
            : {}),
          ...(launchOpts.agentSessionCreateOperationId
            ? { agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId }
            : {}),
          ...(launchOpts.signal ? { signal: launchOpts.signal } : {}),
          ...(launchOpts.onPtySpawnCommitted
            ? { onPtySpawnCommitted: reportPtySpawnCommitted }
            : {}),
          ...(adoptedBeforeLaunch ? { adoptedStablePane: adoptedBeforeLaunch } : {}),
          ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
          ...(!adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
          // Why: a host-initiated create has no renderer session writer, so
          // without its own binding graph sync cannot classify the terminal
          // and prunes the tab out from under a running agent.
          persistHostSessionBinding: true
        })
      } finally {
        releaseStablePaneCreate?.()
      }
      if (!result.stablePaneOwner) {
        reportPtySpawnCommitted()
      }
      const adoptedStablePane = Boolean(result.stablePaneOwner)
      if (result.agentSessionEnsure) {
        const canonicalSurface = result.agentSessionEnsure.owner.surface
        preAllocatedHandle = canonicalSurface.terminalHandle
        tabId = canonicalSurface.tabId
        leafId = canonicalSurface.leafId
        paneKey = makePaneKey(tabId, leafId)
      } else if (result.stablePaneOwner) {
        preAllocatedHandle = result.stablePaneOwner.handle
        tabId = result.stablePaneOwner.tabId
        leafId = result.stablePaneOwner.leafId
        paneKey = makePaneKey(tabId, leafId)
      }
      try {
        ctx.deps.assertPtyDidNotExitBeforeRegistration(result.id, result.incarnationId)
      } catch (error) {
        if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
          ctx.deps.releaseRejectedPtyRegistrationFence(result.id, result.incarnationId)
        }
        throw error
      }
      ctx.deps.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
      if (result.wslDistro) {
        ctx.deps.preparePtyExecutionContext(result.id, result.wslDistro ?? null, {})
      }
      ctx.deps.registerPty(result.id, workspace.id, workspace.connectionId, {
        tabId,
        leafId,
        ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
      })
      if (launchOpts.structuredAgentSessionId) {
        agentSessionPtyWriteGate.bindPty(result.id, launchOpts.structuredAgentSessionId)
      }
      const pty = ctx.getOrCreatePtyWorktreeRecord(result.id)
      if (pty) {
        // Released again by releaseRuntimeSessionOwnershipForRendererRetiredTabs
        // once the renderer de-persists the tab, i.e. when the user closes it.
        pty.runtimeSessionOwned = true
        if (!adoptedStablePane) {
          if (launchOpts.title) {
            const observedAt = ctx.nextTitleObservationSequence()
            pty.title = launchOpts.title
            pty.titleUpdatedAt = observedAt
            ctx.setPtyManagementTitleFromObservedTitle(pty, launchOpts.title, observedAt)
          } else {
            pty.title = null
            pty.titleUpdatedAt = null
          }
          pty.launchConfig = effectiveLaunchConfig
            ? copySleepingAgentLaunchConfig(effectiveLaunchConfig)
            : null
          pty.launchToken = launchToken ?? null
          pty.launchIncarnationId = launchToken ? pty.incarnationId : null
          pty.launchAgent = launchOpts.launchAgent ?? null
        }
        pty.tabId = tabId
        pty.paneKey = paneKey
      }
      const handle = pty ? ctx.deps.issuePtyHandle(pty) : preAllocatedHandle
      if (pty && !adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
        ctx.publishPtyBackedMobileSessionTerminal(workspace.id, pty, {
          tabId,
          leafId,
          title: launchOpts.title ?? null,
          activate: presentation === 'focused',
          // Why: explicit background presentation may carry legacy activate
          // metadata from an already-owned renderer pane; don't select it on mobile.
          selectIfNoActiveTab: presentation !== 'background',
          ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
          ...(cwd !== workspace.path ? { startupCwd: cwd } : {})
        })
      }
      let surface: RuntimeTerminalCreate['surface'] = 'background'
      let warning: string | undefined
      if (presentation !== 'background' && ctx.deps.notifier()?.revealTerminalSession) {
        try {
          // Why: after the PTY is spawned, renderer tab adoption is best-effort;
          // failing here must not strand a live process without returning a handle.
          // Pass the pre-minted tabId so the renderer adopts under the same id
          // already baked into the PTY env — keeps paneKey hook attribution intact.
          await ctx.deps.notifier()!.revealTerminalSession?.(workspace.id, {
            ptyId: result.id,
            title: launchOpts.title ?? null,
            ...(cwd !== workspace.path ? { cwd } : {}),
            ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
            ...(launchToken ? { launchToken } : {}),
            ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
            ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
            activate: presentation === 'focused',
            ...(presentation ? { presentation } : {}),
            ...ownerSurfacing(opts.surfaceOwner !== false),
            tabId,
            leafId
          })
          surface = 'visible'
        } catch (err) {
          console.warn(`[terminal-create] failed to create inactive tab for ${result.id}:`, err)
          warning = createTerminalRevealWarning(handle, err)
        }
      } else if (presentation !== 'background') {
        warning = createTerminalRevealWarning(handle)
      }
      return {
        handle,
        tabId,
        paneKey,
        ptyId: result.id,
        worktreeId: workspace.id,
        title: pty?.title ?? launchOpts.title ?? null,
        ...ctx.getPtyExecutionHostMetadata(result.id),
        surface,
        ...(result.pid ? { processId: result.pid } : {}),
        ...(result.agentSessionEnsure
          ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
          : {}),
        ...(adoptedStablePane ? { isReattach: true as const } : {}),
        ...(warning ? { warning } : {})
      }
    } finally {
      releaseStablePaneCreate()
    }
  }

  ctx.assertGraphReady()
  const win = rendererWindow ?? ctx.getAuthoritativeWindow()
  // Why: mirrors browserTabCreate — when no worktree is specified, pass
  // undefined so the renderer uses its current active worktree.
  const workspace = worktreeSelector
    ? await ctx.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    : null
  const launchOpts = workspace ? await ctx.resolveAgentTerminalCreateOptions(workspace, opts) : opts
  const worktreeId = workspace?.id
  const cwd = workspace
    ? ctx.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd)
    : launchOpts.cwd
  const requestId = randomUUID()

  // Why: terminal creation is a renderer-side Zustand store operation (like
  // browser tab creation). The main process sends a request, the renderer
  // creates the tab and replies with the tabId so we can resolve the handle.
  const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      reject(new Error('Terminal creation timed out'))
    }, 10_000)

    const handler = (
      event: Electron.IpcMainEvent,
      r: { requestId: string; tabId?: string; title?: string; error?: string }
    ): void => {
      if (event.sender !== win.webContents || r.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      if (r.error) {
        reject(new Error(r.error))
      } else {
        resolve({ tabId: r.tabId!, title: r.title ?? launchOpts.title ?? '' })
      }
    }
    getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
    win.webContents.send('terminal:requestTabCreate', {
      requestId,
      worktreeId,
      command: launchOpts.command,
      cwd,
      ...(launchOpts.env ? { env: launchOpts.env } : {}),
      ...(launchOpts.launchConfig ? { launchConfig: launchOpts.launchConfig } : {}),
      ...(launchOpts.resumeProviderSession
        ? { resumeProviderSession: launchOpts.resumeProviderSession }
        : {}),
      ...(launchOpts.launchToken ? { launchToken: launchOpts.launchToken } : {}),
      ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
      ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
      startupCommandDelivery: launchOpts.startupCommandDelivery,
      title: launchOpts.title,
      activate: presentation === 'focused',
      ...(presentation ? { presentation } : {}),
      ...ownerSurfacing(opts.surfaceOwner !== false)
    })
  })

  // Why: the renderer created the tab immediately, but the graph sync that
  // populates ctx.deps.leaves() may not have arrived yet. Wait for the leaf to
  // appear so we can return a valid handle the caller can use right away.
  const handle = await ctx.waitForTerminalHandle(reply.tabId)
  return {
    handle,
    tabId: reply.tabId,
    worktreeId: worktreeId ?? '',
    title: reply.title,
    ...ctx.getPtyExecutionHostMetadata(ctx.deps.handles().get(handle)?.ptyId ?? null),
    surface: 'visible'
  }
}
