/* eslint-disable max-lines -- Why: terminal list/serialize command cluster extracted verbatim from the terminal cluster facade; the serialize variants share buffer-shape contracts that would fragment if split. */
import type { PtyProviderBufferSnapshot } from '../providers/types'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import { parseExecutionHostId } from '../../shared/execution-host'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import {
  DEFAULT_TERMINAL_LIST_LIMIT,
  DEFAULT_TERMINAL_READ_LIMIT,
  getLatestLeafTitle,
  includeTargetResolvedWorktree,
  projectTerminalTailLines,
  terminalReadLimit,
  type ResolvedWorktree,
  type RuntimeTerminalProjection
} from './runtime-tail-projection'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import type { ProviderSnapshotReadOptions, RuntimeLeafRecord } from './runtime-contracts'
import type {
  RuntimeTerminalListHostScope,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary,
  RuntimeTerminalVisualGroupNode,
  RuntimeTerminalVisualLayout,
  RuntimeTerminalVisualTab
} from '../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalCluster } from './runtime-terminal-cluster-facade'

type Ctx = RuntimeTerminalCluster

export async function listTerminals(
  ctx: Ctx,
  worktreeSelector?: string,
  limit = DEFAULT_TERMINAL_LIST_LIMIT,
  opts: {
    handles?: readonly string[]
    requireFreshPtyLiveness?: boolean
    includeVisualLayouts?: boolean
  } = {}
): Promise<RuntimeTerminalListResult> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('invalid_limit')
  }
  const graphEpoch = ctx.deps.graphStatus() === 'ready' ? ctx.deps.rendererGraphEpoch() : null
  const explicitTargetWorktreeId = worktreeSelector
    ? ctx.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    : null
  const initialResolvedWorktreeCache = ctx.deps.resolvedWorktreeCache().peekSnapshot()
  const cachedResolvedWorktrees =
    initialResolvedWorktreeCache && initialResolvedWorktreeCache.expiresAt > Date.now()
      ? initialResolvedWorktreeCache.worktrees
      : null
  const cachedExplicitTargetWorktree =
    explicitTargetWorktreeId && cachedResolvedWorktrees
      ? (cachedResolvedWorktrees.find((worktree) => worktree.id === explicitTargetWorktreeId) ??
        null)
      : null
  const parsedExplicitTargetWorktree =
    explicitTargetWorktreeId && !cachedExplicitTargetWorktree
      ? ctx.buildResolvedWorktreeFromId(explicitTargetWorktreeId)
      : null
  const targetWorktree =
    worktreeSelector && !explicitTargetWorktreeId
      ? await ctx.resolveWorktreeSelector(worktreeSelector)
      : (cachedExplicitTargetWorktree ?? parsedExplicitTargetWorktree)
  const targetWorktreeId = explicitTargetWorktreeId ?? targetWorktree?.id ?? null
  const classificationResolvedWorktreeCache = ctx.deps.resolvedWorktreeCache().peekSnapshot()
  const classificationResolvedWorktrees =
    targetWorktreeId &&
    classificationResolvedWorktreeCache &&
    classificationResolvedWorktreeCache.expiresAt > Date.now()
      ? includeTargetResolvedWorktree(classificationResolvedWorktreeCache.worktrees, targetWorktree)
      : targetWorktreeId && explicitTargetWorktreeId
        ? ctx.listKnownResolvedWorktreesForExplicitTarget(targetWorktreeId, targetWorktree)
        : null
  const worktreesById =
    targetWorktreeId && targetWorktree
      ? new Map([[targetWorktree.id, targetWorktree]])
      : targetWorktreeId
        ? new Map()
        : await ctx.getResolvedWorktreeMap()
  if (graphEpoch !== null) {
    ctx.assertStableReadyGraph(graphEpoch)
  }

  const resolvedWorktrees =
    targetWorktreeId && classificationResolvedWorktrees
      ? classificationResolvedWorktrees
      : targetWorktreeId && targetWorktree
        ? [targetWorktree]
        : targetWorktreeId
          ? []
          : [...worktreesById.values()]
  const controllerInventory = await ctx.refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees,
    targetWorktreeId
  )
  const refreshedPtyLiveness = controllerInventory ? new Set(controllerInventory.livePtyIds) : null
  if (opts.requireFreshPtyLiveness && !refreshedPtyLiveness) {
    throw new Error('terminal_liveness_unavailable')
  }
  // Why: a proof of absence, not a proof of liveness — leaves whose PTY the
  // controller answered for but did not list must not read as connected. An
  // unavailable inventory (null) proves nothing and demotes nothing.
  const provenLivePtyIds = controllerInventory?.allLivePtyIds ?? null

  const livePtyWorktreeIds = new Set<string>()
  for (const pty of ctx.deps.ptysById().values()) {
    if (pty.connected) {
      livePtyWorktreeIds.add(pty.worktreeId)
    }
  }

  const terminals: RuntimeTerminalSummary[] = []
  const ptyIdsFromLeaves = new Set<string>()
  if (graphEpoch !== null) {
    for (const leaf of ctx.deps.leaves().values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      if (opts.requireFreshPtyLiveness && (!leaf.ptyId || !refreshedPtyLiveness?.has(leaf.ptyId))) {
        continue
      }
      if (!leaf.ptyId && livePtyWorktreeIds.has(leaf.worktreeId)) {
        continue
      }
      if (leaf.ptyId) {
        ptyIdsFromLeaves.add(leaf.ptyId)
      }
      terminals.push(ctx.buildTerminalSummary(leaf, worktreesById, provenLivePtyIds))
    }
  }

  // Why: worktree.ps can classify active worktrees from PTY records even when
  // the renderer graph is missing a leaf. terminal.list needs the same fallback
  // so mobile does not show a false "No terminals" create flow.
  for (const pty of ctx.deps.ptysById().values()) {
    if (!pty.connected || ptyIdsFromLeaves.has(pty.ptyId)) {
      continue
    }
    if (opts.requireFreshPtyLiveness && !refreshedPtyLiveness?.has(pty.ptyId)) {
      continue
    }
    if (targetWorktreeId && pty.worktreeId !== targetWorktreeId) {
      continue
    }
    terminals.push(ctx.buildPtyTerminalSummary(pty, worktreesById))
  }

  const requestedHandles = opts.handles ? new Set(opts.handles) : null
  const matchingTerminals = requestedHandles
    ? terminals.filter((terminal) => requestedHandles.has(terminal.handle))
    : terminals
  const listedTerminals = matchingTerminals.slice(0, limit)
  // Why: undefined (pre-flag client) must still get layouts; only an explicit
  // `false` opts out.
  const visualLayouts =
    opts.includeVisualLayouts === false
      ? []
      : ctx.buildTerminalVisualLayouts(listedTerminals, worktreesById, targetWorktreeId)

  return {
    terminals: listedTerminals,
    hostScope: ctx.buildTerminalListHostScope(
      targetWorktreeId,
      matchingTerminals,
      worktreesById.values(),
      controllerInventory?.queriedHostIds ?? new Set()
    ),
    ...(visualLayouts.length > 0 ? { visualLayouts } : {}),
    topologyRevisions: Object.fromEntries(
      [...new Set(matchingTerminals.map((terminal) => terminal.worktreeId))].map((worktreeId) => [
        worktreeId,
        ctx.getTerminalTopologyRevision(worktreeId)
      ])
    ),
    totalCount: matchingTerminals.length,
    truncated: matchingTerminals.length > limit
  }
}

export function buildTerminalSummary(
  ctx: Ctx,
  leaf: RuntimeLeafRecord,
  worktreesById: Map<string, ResolvedWorktree>,
  provenLivePtyIds: ReadonlySet<string> | null = null
): RuntimeTerminalSummary {
  const worktree = worktreesById.get(leaf.worktreeId)
  const tab = ctx.deps.tabs().get(leaf.tabId) ?? null

  const pty = leaf.ptyId ? ctx.deps.ptysById().get(leaf.ptyId) : undefined
  const title = getLatestLeafTitle(leaf, tab?.title ?? null)
  // Why: leaf.connected mirrors the renderer graph (`ptyId !== null`), so a
  // restored surface whose PTY died with a prior run still reads connected.
  // Demote only on a controller-proven absence, and only for locally-scoped
  // ids the aggregate inventory authoritatively covers — SSH/remote scopes may
  // be legitimately missing from it, and unknown liveness never demotes.
  // The sync hasPty rescue closes the spawn/list race: a just-spawned PTY can
  // register after the inventory snapshot, and federation reads one
  // connected:false as exited.
  const provenAbsent =
    provenLivePtyIds !== null &&
    leaf.ptyId !== null &&
    !provenLivePtyIds.has(leaf.ptyId) &&
    !leaf.ptyId.startsWith('remote:') &&
    parseAppSshPtyId(leaf.ptyId) === null &&
    ctx.deps.ptyController()?.hasPty?.(leaf.ptyId) !== true
  return {
    handle: ctx.issueHandle(leaf),
    ptyId: leaf.ptyId,
    incarnationId: pty?.incarnationId ?? null,
    orphaned: false,
    worktreeId: leaf.worktreeId,
    worktreePath: worktree?.path ?? '',
    branch: worktree?.branch ?? '',
    tabId: leaf.tabId,
    leafId: leaf.leafId,
    title,
    connected: provenAbsent ? false : leaf.connected,
    writable: provenAbsent ? false : leaf.writable,
    lastOutputAt: leaf.lastOutputAt,
    preview: leaf.preview,
    ...(leaf.lastExitCause ? { exitCause: leaf.lastExitCause } : {}),
    ...ctx.deps.terminalExecutionHostField(leaf.ptyId, leaf.worktreeId),
    ...ctx.deps.resolvePaneAgentIdentityField(
      pty?.launchAgent,
      pty?.foregroundAgent,
      title,
      // Why guarded: makePaneKey THROWS on a non-UUID leaf id, and an unguarded call here took
      // down terminal.list for every pane in the list, not just the odd one.
      isTerminalLeafId(leaf.leafId) ? makePaneKey(leaf.tabId, leaf.leafId) : null
    )
  }
}

export function buildTerminalVisualLayouts(
  ctx: Ctx,
  terminals: RuntimeTerminalSummary[],
  worktreesById: Map<string, ResolvedWorktree>,
  targetWorktreeId: string | null
): RuntimeTerminalVisualLayout[] {
  if (terminals.length === 0) {
    return []
  }
  // Why: the mobile/session snapshot supplies topology, but terminal.list
  // must print the same handles in both the flat list and visual tree.
  const summariesByLeafKey = new Map(
    terminals.map((terminal) => [ctx.getLeafKey(terminal.tabId, terminal.leafId), terminal])
  )
  const summariesByWorktree = new Map<string, RuntimeTerminalSummary[]>()
  for (const terminal of terminals) {
    const existing = summariesByWorktree.get(terminal.worktreeId)
    if (existing) {
      existing.push(terminal)
    } else {
      summariesByWorktree.set(terminal.worktreeId, [terminal])
    }
  }
  const snapshots = targetWorktreeId
    ? [ctx.deps.mobileSessionTabsByWorktree().get(targetWorktreeId)].filter(
        (snapshot): snapshot is RuntimeMobileSessionTabsSnapshot => snapshot !== undefined
      )
    : [...ctx.deps.mobileSessionTabsByWorktree().values()]
  const layouts: RuntimeTerminalVisualLayout[] = []
  for (const snapshot of snapshots) {
    const worktreeTerminals = summariesByWorktree.get(snapshot.worktree)
    if (!worktreeTerminals || worktreeTerminals.length === 0) {
      continue
    }
    const groups = ctx.buildTerminalVisualGroups(snapshot, summariesByLeafKey)
    if (groups.length === 0) {
      continue
    }
    const groupsById = new Map(
      groups
        .filter((group): group is RuntimeTerminalVisualGroupNode & { groupId: string } =>
          Boolean(group.groupId)
        )
        .map((group) => [group.groupId, group])
    )
    const root =
      ctx.buildTerminalVisualGroupLayout(snapshot.tabGroupLayout, groupsById) ?? groups[0]
    if (!root) {
      continue
    }
    const worktree = worktreesById.get(snapshot.worktree)
    layouts.push({
      worktreeId: snapshot.worktree,
      worktreePath: worktree?.path ?? worktreeTerminals[0]?.worktreePath ?? '',
      root
    })
  }
  return layouts
}

export function buildTerminalVisualGroups(
  ctx: Ctx,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  summariesByLeafKey: ReadonlyMap<string, RuntimeTerminalSummary>
): RuntimeTerminalVisualGroupNode[] {
  const terminalTabs = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
  )
  if (terminalTabs.length === 0) {
    return []
  }
  const tabsByParentId = new Map<string, RuntimeMobileSessionTerminalTab[]>()
  const parentOrder: string[] = []
  for (const tab of terminalTabs) {
    const existing = tabsByParentId.get(tab.parentTabId)
    if (existing) {
      existing.push(tab)
    } else {
      parentOrder.push(tab.parentTabId)
      tabsByParentId.set(tab.parentTabId, [tab])
    }
  }
  const groupSources =
    snapshot.tabGroups && snapshot.tabGroups.length > 0
      ? snapshot.tabGroups
      : [{ id: null, activeTabId: snapshot.activeTabId, tabOrder: parentOrder }]
  return groupSources
    .map((group): RuntimeTerminalVisualGroupNode | null => {
      const tabs = group.tabOrder
        .map((tabId) => {
          const surfaces =
            tabsByParentId.get(tabId) ?? terminalTabs.filter((tab) => tab.id === tabId)
          return ctx.buildTerminalVisualTab(tabId, surfaces, summariesByLeafKey)
        })
        .filter((tab): tab is RuntimeTerminalVisualTab => tab !== null)
      if (tabs.length === 0) {
        return null
      }
      return {
        type: 'group',
        groupId: group.id,
        activeTabId:
          group.activeTabId && tabs.some((tab) => tab.tabId === group.activeTabId)
            ? group.activeTabId
            : (tabs[0]?.tabId ?? null),
        tabs
      }
    })
    .filter((group): group is RuntimeTerminalVisualGroupNode => group !== null)
}

export function buildTerminalListHostScope(
  ctx: Ctx,
  targetWorktreeId: string | null,
  terminals: readonly RuntimeTerminalSummary[],
  worktrees: Iterable<ResolvedWorktree>,
  queriedHostIds: ReadonlySet<ExecutionHostId>
): RuntimeTerminalListHostScope {
  const knownHostIds = ctx.deps.listKnownExecutionHostIds(
    queriedHostIds,
    targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID
  )
  let resolvedTargetHostId: ExecutionHostId | null = null
  for (const worktree of worktrees) {
    if (worktree.hostId) {
      knownHostIds.add(worktree.hostId)
      if (worktree.id === targetWorktreeId) {
        resolvedTargetHostId = worktree.hostId
      }
    }
  }
  for (const terminal of terminals) {
    if (terminal.executionHostId) {
      knownHostIds.add(terminal.executionHostId)
    }
  }
  const scopedHostId = targetWorktreeId
    ? (resolvedTargetHostId ?? ctx.deps.tryGetWorkspaceSessionHostIdForWorktree(targetWorktreeId))
    : null
  if (scopedHostId) {
    knownHostIds.add(scopedHostId)
  }
  const candidates = targetWorktreeId ? (scopedHostId ? [scopedHostId] : []) : knownHostIds
  // Paired runtimes own a separate control plane. Mirrored rows are evidence
  // for those rows only; this runtime cannot claim their complete inventory.
  const coveredHostIds = new Set(
    [...candidates].filter(
      (hostId) => queriedHostIds.has(hostId) && parseExecutionHostId(hostId)?.kind !== 'runtime'
    )
  )
  return {
    hostIds: [...coveredHostIds].sort(),
    omittedHostIds: [...knownHostIds].filter((hostId) => !coveredHostIds.has(hostId)).sort()
  }
}

export async function serializeHeadlessTerminalBuffer(
  ctx: Ctx,
  ptyId: string,
  opts: { scrollbackRows?: number; includeEmpty?: boolean } = {}
): Promise<{
  data: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq?: number
  source?: 'headless'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  scrollbackAnsi?: string
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
  // Why: dangling mid-escape tail the restorer must write LAST, after any
  // reset, so the next live chunk completes it instead of rendering it
  // literally (Bug E / #7329).
  pendingEscapeTailAnsi?: string
} | null> {
  const state = ctx.deps.headlessTerminals().get(ptyId)
  if (!state) {
    return null
  }
  await state.writeChain
  await state.ownership.settle()
  // Why: normal history is separated from an active alternate frame, so the
  // caller's scrollback policy can be honored without painting it into alt.
  const scrollbackRows = opts.scrollbackRows ?? 0
  const snapshot = state.emulator.getSnapshot({ scrollbackRows })
  const terminalOwner = state.ownership.owner
  const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
  return data.length > 0 || opts.includeEmpty === true
    ? ctx.deps.preferTrackedLastTitle()(ptyId, {
        data,
        frameRestoreAnsi: snapshot.frameRestoreAnsi,
        cols: snapshot.cols,
        rows: snapshot.rows,
        cwd: snapshot.cwd ?? ctx.deps.terminalCwdByPtyId().get(ptyId),
        lastTitle: snapshot.lastTitle,
        seq: state.outputSequence,
        source: 'headless' as const,
        oscLinks: snapshot.oscLinks,
        scrollbackAnsi: snapshot.scrollbackAnsi,
        // Why beside outputSequence and never re-read later: the flags must
        // describe the same stream position as the image, or replay would
        // apply push/pop transitions twice or out of order.
        ...(parseTerminalKittyKeyboardFlags(snapshot.modes?.kittyKeyboardFlags) !== undefined
          ? { kittyKeyboardFlags: snapshot.modes.kittyKeyboardFlags }
          : {}),
        ...(snapshot.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
          : {}),
        ...(terminalOwner ? { terminalOwner } : {}),
        // Why: lets the renderer skip the destructive scrollback clear when
        // restoring an alt-screen snapshot — clearing wipes xterm's own
        // history that the TUI relies on for scroll-up after a tab return.
        alternateScreen: snapshot.modes?.alternateScreen ?? state.emulator.isAlternateScreen,
        // Why NOT folded into data: the renderer writes its post-replay
        // reset after data, and any ESC after a dangling partial aborts it.
        // The restorer writes this last (Bug E fix).
        pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
      })
    : null
}

export async function serializeTerminalBufferFromAvailableState(
  ctx: Ctx,
  ptyId: string,
  opts: { scrollbackRows?: number } = {}
): Promise<{
  data: string
  frameRestoreAnsi?: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq?: number
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  pendingEscapeTailAnsi?: string
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
} | null> {
  if (ctx.deps.providerSnapshotPreferredPtys().has(ptyId)) {
    // Why: pre-attach stream bytes only form a suffix of restored state. A
    // sequenced provider snapshot safely reconciles live bytes; renderer is
    // the fallback when an older provider cannot expose that boundary.
    const providerSnapshot = await ctx.serializeProviderTerminalBuffer(ptyId, opts)
    if (providerSnapshot) {
      return providerSnapshot
    }
    const rendererSnapshot = await ctx.serializeRendererTerminalBuffer(ptyId, opts)
    if (rendererSnapshot) {
      return rendererSnapshot
    }
  }
  const headlessSnapshot = await ctx.serializeHeadlessTerminalBuffer(ptyId, opts)
  if (headlessSnapshot) {
    return headlessSnapshot
  }

  const rendererSnapshot = await ctx.serializeRendererTerminalBuffer(ptyId, opts)
  if (!rendererSnapshot) {
    return ctx.serializeProviderTerminalBuffer(ptyId, opts)
  }
  if (rendererSnapshot.data.length > 0) {
    return rendererSnapshot
  }
  // Why: parked desktop panes register serializers before their xterm has
  // hydrated. Treat that empty shell as provisional so retained provider
  // history can restore mobile without forcing the desktop pane to mount.
  const providerSnapshot = await ctx.serializeProviderTerminalBuffer(ptyId, opts)
  return providerSnapshot &&
    (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
    ? providerSnapshot
    : rendererSnapshot
}

export async function serializeProviderTerminalBuffer(
  ctx: Ctx,
  ptyId: string,
  opts: { scrollbackRows?: number } = {},
  wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
): Promise<PtyProviderBufferSnapshot | null> {
  const generation = ctx.getPtyLifecycleGeneration(ptyId)
  const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
  let acquisition = ctx.deps.providerBufferAcquisitionsByPtyId().get(ptyId)
  // Why before the re-acquire branch: an unresponsive provider is a property of
  // the process, not of the row count one caller asked for. Checking retirement
  // only after re-acquiring let a wider request replace the retired entry and
  // hang again; the hung call's own settle still clears it and allows recovery.
  if (acquisition?.generation === generation && acquisition.timedOut) {
    return null
  }
  if (
    !acquisition ||
    acquisition.generation !== generation ||
    acquisition.scrollbackRows < scrollbackRows
  ) {
    const promise = ctx.captureProviderTerminalBuffer(ptyId, opts, generation)
    acquisition = { generation, scrollbackRows, promise, timedOut: false }
    ctx.deps.providerBufferAcquisitionsByPtyId().set(ptyId, acquisition)
    void promise.finally(() => {
      if (ctx.deps.providerBufferAcquisitionsByPtyId().get(ptyId) === acquisition) {
        ctx.deps.providerBufferAcquisitionsByPtyId().delete(ptyId)
      }
    })
  }
  if (acquisition.timedOut) {
    return null
  }
  if (typeof wait.timeoutMs !== 'number') {
    return acquisition.promise
  }
  const result = await withTimeout<
    { settled: true; value: PtyProviderBufferSnapshot | null } | { settled: false }
  >(
    acquisition.promise.then((value) => ({ settled: true as const, value })),
    wait.timeoutMs,
    { settled: false as const }
  )
  if (!result.settled) {
    if (wait.retireOnTimeout) {
      acquisition.timedOut = true
    }
    return null
  }
  return result.value
}

export async function serializeRendererTerminalBuffer(
  ctx: Ctx,
  ptyId: string,
  opts: { scrollbackRows?: number } = {}
): Promise<{
  data: string
  frameRestoreAnsi?: string
  cols: number
  rows: number
  seq?: number
  cwd?: string | null
  lastTitle?: string
  source?: 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  kittyKeyboardFlags?: number
} | null> {
  if (ctx.deps.ptyController()?.hasRendererSerializer?.(ptyId) === false) {
    return null
  }
  let rendererSnapshot: {
    data: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    oscLinks?: TerminalOscLinkRange[]
    kittyKeyboardFlags?: number
  } | null = null
  try {
    // Why: recovery/read fallback wants visible alt-screen content (e.g. an
    // active TUI), so altScreenForcesZeroRows is FALSE here. Hydration is
    // the only path that suppresses alt-screen scrollback.
    rendererSnapshot = await (ctx.deps.ptyController()?.serializeBuffer?.(ptyId, {
      scrollbackRows: opts.scrollbackRows,
      altScreenForcesZeroRows: false
    }) ?? Promise.resolve(null))
  } catch {
    // Why: terminal snapshots should not depend on a mounted renderer pane.
    // If renderer serialization races reload/unmount, callers can still use
    // their existing null fallback paths.
  }
  return rendererSnapshot
    ? ctx.deps.preferTrackedLastTitle()(ptyId, {
        ...rendererSnapshot,
        cwd: rendererSnapshot.cwd ?? ctx.deps.terminalCwdByPtyId().get(ptyId),
        source: 'renderer' as const
      })
    : null
}

export async function captureProviderTerminalBuffer(
  ctx: Ctx,
  ptyId: string,
  opts: { scrollbackRows?: number },
  generation: number
): Promise<PtyProviderBufferSnapshot | null> {
  const liveModeTracker = new TerminalKittyKeyboardModeTracker()
  let liveModeTrackers = ctx.deps.providerModeSnapshotScansByPtyId().get(ptyId)
  if (!liveModeTrackers) {
    liveModeTrackers = new Set()
    ctx.deps.providerModeSnapshotScansByPtyId().set(ptyId, liveModeTrackers)
  }
  liveModeTrackers.add(liveModeTracker)
  try {
    // Why: daemon PTYs survive an app relaunch before any renderer mounts.
    // Mobile still needs their retained history without navigating desktop.
    const snapshot = await ctx.deps.ptyController()?.serializeProviderBuffer?.(ptyId, opts)
    if (!snapshot || ctx.getPtyLifecycleGeneration(ptyId) !== generation) {
      return null
    }
    const snapshotModeTracker = new TerminalKittyKeyboardModeTracker()
    if (typeof snapshot.alternateScreen === 'boolean') {
      snapshotModeTracker.scan(snapshot.alternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
    } else {
      // Why: older providers omit mode metadata, but their ANSI snapshot
      // still carries the DECSET/DECRST needed to classify the active screen.
      snapshotModeTracker.scanReplay(snapshot.data)
    }
    const observedSnapshotMode = snapshotModeTracker.hasObservedAlternateScreenSwitch
    let effectiveAlternateScreen: boolean | undefined
    if (observedSnapshotMode || liveModeTracker.hasObservedAlternateScreenSwitch) {
      const modeTracker = new TerminalKittyKeyboardModeTracker()
      if (observedSnapshotMode) {
        modeTracker.scan(snapshotModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      }
      // Why: stream bytes received after the request began can be newer
      // than snapshot metadata, so an observed live transition wins.
      if (liveModeTracker.hasObservedAlternateScreenSwitch) {
        modeTracker.scan(liveModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      }
      ctx.deps.providerModeTrackersByPtyId().set(ptyId, modeTracker)
      effectiveAlternateScreen = modeTracker.isAlternateScreen
    }
    const providerOffset = ctx.deps.providerSequenceOffsetByPtyId().get(ptyId) ?? 0
    const reconciledSnapshot = ctx.deps.preferTrackedLastTitle()(ptyId, {
      ...snapshot,
      seq: providerOffset + snapshot.seq,
      ...(effectiveAlternateScreen !== undefined
        ? { alternateScreen: effectiveAlternateScreen }
        : {})
    })
    if (liveModeTracker.hasObservedAlternateScreenSwitch) {
      ctx.deps.providerSnapshotsWithLiveModeTransition().add(reconciledSnapshot)
    }
    return reconciledSnapshot
  } catch {
    return null
  } finally {
    liveModeTrackers.delete(liveModeTracker)
    if (liveModeTrackers.size === 0) {
      ctx.deps.providerModeSnapshotScansByPtyId().delete(ptyId)
    }
  }
}

export async function readProviderTerminalTailLines(
  ctx: Ctx,
  ptyId: string,
  limit: number | undefined,
  snapshotOptions: ProviderSnapshotReadOptions = {}
): Promise<RuntimeTerminalProjection> {
  const generation = ctx.getPtyLifecycleGeneration(ptyId)
  const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
  const snapshot = await ctx.serializeProviderTerminalBuffer(
    ptyId,
    { scrollbackRows: snapshotOptions.visibleScreenOnly ? 0 : lineLimit },
    snapshotOptions
  )
  if (!snapshot) {
    return { lines: [] }
  }
  // Why: a cached acquisition can carry scrollback this caller did not ask for,
  // so visible-only reads parse the grid itself rather than trusting the request.
  if (snapshotOptions.visibleScreenOnly) {
    const projection = await ctx.parseVisibleSnapshot(snapshot)
    // Live bytes ordered after the provider frame make that frame stale.
    return ctx.getPtyLifecycleGeneration(ptyId) === generation &&
      ctx.getPtyOutputSequence(ptyId) <= snapshot.seq
      ? projection
      : { lines: [] }
  }
  const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
  if (data.length === 0) {
    return { lines: [] }
  }
  const emulator = new HeadlessEmulator({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: lineLimit
  })
  try {
    await emulator.write(data)
    const projection = projectTerminalTailLines(emulator, lineLimit)
    return ctx.getPtyLifecycleGeneration(ptyId) === generation &&
      ctx.getPtyOutputSequence(ptyId) <= snapshot.seq
      ? projection
      : { lines: [] }
  } finally {
    emulator.dispose()
  }
}
