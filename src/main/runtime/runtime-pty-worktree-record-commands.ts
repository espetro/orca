/* eslint-disable max-lines -- Why: extracted PTY worktree record + controller inventory tracking cluster from the managed-worktrees facade */
import type {
  PtyControllerInventory,
  PtyControllerTerminalIdentity,
  ResolvedWorktree,
  RuntimePtyWorktreeRecord
} from './orca-runtime'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { NO_OBSERVING_PROVIDER_REASON } from '../../shared/pty-liveness-verdict'
import {
  PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS,
  PTY_CONTROLLER_LIST_TIMEOUT_MS,
  createIncrementalResolvedWorktreeLookup,
  findResolvedWorktreeIdForPath,
  inferWorktreeIdFromPtyId,
  indexPersistedPtySurfaceBindings,
  indexPersistedPtyWorktreeBindings,
  maxTimestamp,
  runtimeWorktreeIdsEqual,
  withTimeoutResult
} from './runtime-tail-projection'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { cloneAgentSessionOwnerBinding } from '../../shared/claimed-agent-pty-owner-snapshot'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'

export type RuntimePtyWorktreeRecordCommandsDeps = Pick<
  RuntimeManagedWorktreesDeps,
  | 'ptysById'
  | 'wslDistroByPtyId'
  | 'nextTitleObservationSequence'
  | 'setPtyManagementTitleFromObservedTitle'
  | 'invalidatePtyIncarnationHandle'
  | 'store'
  | 'ptyController'
  | 'ptyLivenessObservationSequence'
  | 'forgetPtyLivenessVerdict'
  | 'adoptControllerTerminalHandle'
  | 'restoredOrchestrationAuthorityByPtyId'
  | 'rememberRestoredOrchestrationAuthority'
  | 'reconcileSubscriberDrivenProviderAttach'
  | 'refreshPtyForegroundAgent'
  | 'leafExistsForPty'
  | 'ptyLivenessVerdictByPtyId'
  | 'markPtyLivenessUnverifiable'
  | 'pruneDisconnectedPtyRecords'
  | 'refreshFloatingWorkspacePtyLiveness'
>

import type { RuntimeManagedWorktreesDeps } from './runtime-managed-worktrees'

export class RuntimePtyWorktreeRecordCommands {
  ptyControllerAggregateInventoryGeneration = 0
  ptyControllerInventoryGenerationByProvider = new Map<string, number>()
  ptyControllerInventorySequence = 0

  constructor(private deps: RuntimePtyWorktreeRecordCommandsDeps) {}

  getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    const existing = this.deps.ptysById().get(ptyId)
    if (existing) {
      return existing
    }
    const inferredWorktreeId = inferWorktreeIdFromPtyId(ptyId)
    if (!inferredWorktreeId) {
      return null
    }
    // Why: daemon-backed PTY session IDs are prefixed with the worktree ID so mobile summaries survive renderer graph gaps and reloads.
    return this.recordPtyWorktree(ptyId, inferredWorktreeId)
  }

  recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'title'
        | 'connectionId'
        | 'runtimeSessionOwned'
        | 'isWsl'
        | 'wslDistro'
        | 'incarnationId'
        | 'agentSessionOwners'
      >
    > = {}
  ): RuntimePtyWorktreeRecord {
    let pty = this.deps.ptysById().get(ptyId)
    if (!pty) {
      const titleObservedAt = state.title ? this.deps.nextTitleObservationSequence() : null
      const connectionId = state.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
      const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
      const fallbackWslDistro =
        process.platform === 'win32' && connectionId === null && worktreePath
          ? parseWslUncPath(worktreePath)?.distro
          : undefined
      const wslDistro =
        connectionId === null
          ? (state.wslDistro ??
            this.deps.wslDistroByPtyId().get(ptyId) ??
            fallbackWslDistro ??
            null)
          : null
      pty = {
        ptyId,
        incarnationId: state.incarnationId ?? null,
        worktreeId,
        connectionId,
        runtimeSessionOwned: state.runtimeSessionOwned ?? false,
        isWsl: state.isWsl ?? null,
        wslDistro,
        tabId: state.tabId ?? null,
        paneKey: state.paneKey ?? null,
        launchConfig: null,
        launchToken: null,
        launchIncarnationId: null,
        launchAgent: null,
        agentSessionOwners: (state.agentSessionOwners ?? []).map(cloneAgentSessionOwnerBinding),
        foregroundAgent: null,
        connected: state.connected ?? true,
        disconnectedAt: state.connected === false ? Date.now() : null,
        lastExitCode: null,
        lastExitCause: null,
        lastAgentStatus: null,
        lastAgentStatusObservedLive: false,
        lastAgentStatusStartedAtEpochMs: null,
        lastAgentStatusRichInvalidatedAtEpochMs: null,
        lastOscTitle: null,
        lastOscTitleAt: null,
        lastOscTitleEpochMs: null,
        managementTitle: null,
        managementTitleAt: null,
        controllerTitle: null,
        title: state.title ?? null,
        titleUpdatedAt: titleObservedAt,
        lastOutputAt: state.lastOutputAt ?? null,
        tailBuffer: [],
        tailTranscriptBuffer: [],
        tailTranscriptChars: 0,
        tailPartialLine: '',
        tailPendingAnsi: '',
        tailRedrawCursor: null,
        tailTruncated: false,
        tailLinesTotal: 0,
        preview: state.preview ?? '',
        waitBlockedAt: null
      }
      if (state.title) {
        this.deps.setPtyManagementTitleFromObservedTitle(pty, state.title, titleObservedAt ?? 0)
      }
      this.deps.ptysById().set(ptyId, pty)
      if (wslDistro) {
        this.deps.wslDistroByPtyId().set(ptyId, wslDistro)
      } else if (connectionId !== null) {
        // Why: restored SSH IDs can collide with stale local parser state; connection ownership must win before their first output is parsed.
        this.deps.wslDistroByPtyId().delete(ptyId)
      }
      // Why: restored/controller-discovered PTYs learn their worktree here without registerPty(), so URL enrichment must bind at this source.
      advertisedUrlWatcher.bindPty(ptyId, worktreeId)
      return pty
    }

    pty.worktreeId = worktreeId
    if (
      state.incarnationId !== undefined &&
      pty.incarnationId !== null &&
      state.incarnationId !== pty.incarnationId
    ) {
      pty.agentSessionOwners = []
    }
    if (state.incarnationId !== undefined) {
      if (pty.incarnationId && state.incarnationId && pty.incarnationId !== state.incarnationId) {
        this.deps.invalidatePtyIncarnationHandle(ptyId)
      }
      pty.incarnationId = state.incarnationId
    }
    if (state.agentSessionOwners !== undefined) {
      pty.agentSessionOwners = state.agentSessionOwners.map(cloneAgentSessionOwnerBinding)
    }
    if (state.connectionId !== undefined) {
      pty.connectionId = state.connectionId
      if (state.connectionId !== null) {
        pty.wslDistro = null
        this.deps.wslDistroByPtyId().delete(ptyId)
      }
    }
    if (state.runtimeSessionOwned !== undefined) {
      pty.runtimeSessionOwned = state.runtimeSessionOwned
    }
    if (state.isWsl !== undefined) {
      pty.isWsl = state.isWsl
    }
    if (state.wslDistro !== undefined) {
      pty.wslDistro = state.wslDistro
      if (state.wslDistro) {
        this.deps.wslDistroByPtyId().set(ptyId, state.wslDistro)
      } else {
        this.deps.wslDistroByPtyId().delete(ptyId)
      }
    }
    if (state.tabId !== undefined) {
      pty.tabId = state.tabId
    }
    if (state.paneKey !== undefined) {
      pty.paneKey = state.paneKey
    }
    if (state.connected !== undefined) {
      pty.connected = state.connected
      pty.disconnectedAt = state.connected ? null : (pty.disconnectedAt ?? Date.now())
    }
    if (state.lastOutputAt !== undefined) {
      pty.lastOutputAt = maxTimestamp(pty.lastOutputAt, state.lastOutputAt)
    }
    if (state.preview !== undefined && state.preview.length > 0) {
      pty.preview = state.preview
    }
    if (state.title !== undefined && state.title !== null && state.title.length > 0) {
      const observedAt = this.deps.nextTitleObservationSequence()
      pty.title = state.title
      pty.titleUpdatedAt = observedAt
      this.deps.setPtyManagementTitleFromObservedTitle(pty, state.title, observedAt)
    }
    // Why: recordPtyWorktree is the common lifecycle point for every path that resolves a PTY's worktree (renderer restore, controller list).
    advertisedUrlWatcher.bindPty(ptyId, worktreeId)
    return pty
  }

  async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
    return inventory ? new Set(inventory.livePtyIds) : null
  }

  async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    if (targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      const targetedLiveness = this.deps.refreshFloatingWorkspacePtyLiveness()
      if (targetedLiveness !== null) {
        return {
          livePtyIds: targetedLiveness,
          allLivePtyIds: targetedLiveness,
          terminalIdentityByPtyId: new Map(),
          queriedHostIds: new Set([LOCAL_EXECUTION_HOST_ID])
        }
      }
    }
    if (!this.deps.ptyController?.listProcesses) {
      return null
    }
    const inventoryGeneration = this.ptyControllerInventorySequence + 1
    this.ptyControllerInventorySequence = inventoryGeneration
    const livenessObservationAtStart = this.deps.ptyLivenessObservationSequence()
    const providerKey = typeof connectionId === 'string' ? `ssh:${connectionId}` : 'local'
    if (connectionId === undefined) {
      this.ptyControllerAggregateInventoryGeneration = inventoryGeneration
    } else {
      this.ptyControllerInventoryGenerationByProvider.set(providerKey, inventoryGeneration)
    }
    const listBudgetMs =
      deadline === undefined
        ? PTY_CONTROLLER_LIST_TIMEOUT_MS
        : Math.max(1, Math.min(PTY_CONTROLLER_LIST_TIMEOUT_MS, deadline - Date.now()))
    // Why: give each provider a deadline strictly inside our own, so a relay that
    // never answers still leaves the aggregate time to return the providers that did
    // — expiring at the same instant would discard the whole inventory instead.
    const providerListOpts = {
      deadlineMs: Date.now() + Math.max(1, listBudgetMs - PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS)
    }
    const processInventory =
      connectionId === undefined && this.deps.ptyController.listProcessesWithHostScope
        ? this.deps.ptyController.listProcessesWithHostScope(providerListOpts)
        : this.deps.ptyController
            .listProcesses(connectionId, providerListOpts)
            .then((processes) => {
              const hostIds = new Set<ExecutionHostId>()
              if (connectionId === undefined || connectionId === null) {
                hostIds.add(LOCAL_EXECUTION_HOST_ID)
              } else {
                hostIds.add(toSshExecutionHostId(connectionId))
              }
              if (connectionId === undefined) {
                for (const process of processes) {
                  const hostId = getPtyExecutionHost(process.id)
                  if (
                    hostId &&
                    hostId !== 'foreign' &&
                    parseExecutionHostId(hostId)?.kind === 'ssh'
                  ) {
                    hostIds.add(hostId)
                  }
                }
              }
              return { processes, hostIds: [...hostIds] }
            })
    const sessionsResult = await withTimeoutResult(processInventory, listBudgetMs)
    if (!sessionsResult.ok) {
      // Why: a transient controller failure is not evidence that retained PTYs exited.
      return null
    }
    const isCurrentInventory =
      connectionId === undefined
        ? this.ptyControllerAggregateInventoryGeneration === inventoryGeneration &&
          ![...this.ptyControllerInventoryGenerationByProvider.values()].some(
            (generation) => generation > inventoryGeneration
          )
        : this.ptyControllerInventoryGenerationByProvider.get(providerKey) ===
            inventoryGeneration &&
          this.ptyControllerAggregateInventoryGeneration <= inventoryGeneration
    if (!isCurrentInventory) {
      return null
    }
    const sessions = sessionsResult.value.processes
    const queriedHostIds = new Set(sessionsResult.value.hostIds)
    const controllerIdentityByPtyId = new Map<string, PtyControllerTerminalIdentity>()
    const ptyIdByControllerHandle = new Map<string, string>()
    const ambiguousControllerPtyIds = new Set<string>()
    for (const session of sessions) {
      const handle = session.terminalHandle?.trim()
      const incarnationId = session.incarnationId?.trim()
      if (!handle?.startsWith('term_') || !incarnationId) {
        continue
      }
      const priorPtyId = ptyIdByControllerHandle.get(handle)
      if (priorPtyId && priorPtyId !== session.id) {
        ambiguousControllerPtyIds.add(priorPtyId)
        ambiguousControllerPtyIds.add(session.id)
        controllerIdentityByPtyId.delete(priorPtyId)
        continue
      }
      if (controllerIdentityByPtyId.has(session.id)) {
        ambiguousControllerPtyIds.add(session.id)
        controllerIdentityByPtyId.delete(session.id)
        continue
      }
      ptyIdByControllerHandle.set(handle, session.id)
      controllerIdentityByPtyId.set(session.id, {
        handle,
        incarnationId,
        ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {})
      })
    }
    for (const ptyId of ambiguousControllerPtyIds) {
      controllerIdentityByPtyId.delete(ptyId)
    }
    const findResolvedWorktree = createIncrementalResolvedWorktreeLookup(resolvedWorktrees)
    const persistedIndexesByHostId = new Map<
      ExecutionHostId,
      {
        worktreeIdByPtyId: ReadonlyMap<string, string>
        surfaceByPtyId: ReturnType<typeof indexPersistedPtySurfaceBindings>
      }
    >()
    const getPersistedIndexes = (hostId: ExecutionHostId) => {
      const existing = persistedIndexesByHostId.get(hostId)
      if (existing) {
        return existing
      }
      const persistedSession = this.deps.store?.getWorkspaceSession?.(hostId)
      const indexes = {
        worktreeIdByPtyId: indexPersistedPtyWorktreeBindings(persistedSession),
        surfaceByPtyId: indexPersistedPtySurfaceBindings(persistedSession)
      }
      persistedIndexesByHostId.set(hostId, indexes)
      return indexes
    }
    const allLivePtyIds = new Set(sessions.map((session) => session.id))
    const selectedLivePtyIds = new Set<string>()
    for (const session of sessions) {
      // The owning inventory positively observed this PTY again; prior lost-contact doubt is stale.
      this.deps.forgetPtyLivenessVerdict(session.id, livenessObservationAtStart)
      const sessionConnectionId =
        parseAppSshPtyId(session.id)?.connectionId ??
        (typeof connectionId === 'string' ? connectionId : null)
      const persistedIndexes = getPersistedIndexes(
        sessionConnectionId ? toSshExecutionHostId(sessionConnectionId) : LOCAL_EXECUTION_HOST_ID
      )
      const controllerIdentity = controllerIdentityByPtyId.get(session.id)
      const persistedWorktreeId = persistedIndexes.worktreeIdByPtyId.get(session.id)
      const providerWorktree = session.worktreeId
        ? findResolvedWorktree(session.worktreeId)
        : undefined
      const inferredWorktreeId = inferWorktreeIdFromPtyId(session.id)
      const persistedWorktree = persistedWorktreeId
        ? findResolvedWorktree(persistedWorktreeId)
        : undefined
      const hasMigrationEvidence =
        Boolean(session.worktreeId) &&
        !providerWorktree &&
        Boolean(persistedWorktree) &&
        Boolean(inferredWorktreeId) &&
        runtimeWorktreeIdsEqual(session.worktreeId as string, inferredWorktreeId as string)
      // Why: an unresolved explicit provider owner remains authoritative unless the session id proves it was frozen before a persisted rename migration.
      const worktreeId = providerWorktree
        ? providerWorktree.id
        : hasMigrationEvidence
          ? (persistedWorktree?.id ?? null)
          : (session.worktreeId ??
            persistedWorktree?.id ??
            inferredWorktreeId ??
            findResolvedWorktreeIdForPath(resolvedWorktrees, session.cwd, targetWorktreeId))
      const persistedSurface = persistedIndexes.surfaceByPtyId.get(session.id)
      const restoresExactSurface =
        persistedSurface &&
        session.incarnationId &&
        persistedSurface.incarnationId === session.incarnationId &&
        Boolean(worktreeId) &&
        runtimeWorktreeIdsEqual(persistedSurface.worktreeId, worktreeId as string)
      this.deps.adoptControllerTerminalHandle(
        session.id,
        controllerIdentity?.handle ?? session.terminalHandle,
        controllerIdentity?.incarnationId ?? session.incarnationId,
        { exactRestoredSurface: Boolean(restoresExactSurface && controllerIdentity) }
      )
      if (
        !targetWorktreeId ||
        (worktreeId && runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        selectedLivePtyIds.add(session.id)
      }
      if (
        targetWorktreeId &&
        (!worktreeId || !runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        const receipt = this.deps.restoredOrchestrationAuthorityByPtyId().get(session.id)
        if (receipt && runtimeWorktreeIdsEqual(receipt.worktreeId, targetWorktreeId)) {
          this.deps.restoredOrchestrationAuthorityByPtyId().delete(session.id)
        }
        continue
      }
      this.deps.restoredOrchestrationAuthorityByPtyId().delete(session.id)
      if (worktreeId) {
        const pty = this.recordPtyWorktree(session.id, worktreeId, {
          connected: true,
          ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
          agentSessionOwners: session.incarnationId ? (session.agentSessionOwners ?? []) : [],
          ...(session.wslDistro !== undefined
            ? { isWsl: Boolean(session.wslDistro), wslDistro: session.wslDistro }
            : {}),
          ...(restoresExactSurface
            ? { tabId: persistedSurface.tabId, paneKey: persistedSurface.paneKey }
            : {})
        })
        if (restoresExactSurface && controllerIdentity) {
          this.deps.rememberRestoredOrchestrationAuthority(
            pty,
            controllerIdentity.handle,
            controllerIdentity.incarnationId
          )
        } else {
          this.deps.restoredOrchestrationAuthorityByPtyId().delete(session.id)
        }
        pty.controllerTitle = session.title?.trim() || null
        this.deps.reconcileSubscriberDrivenProviderAttach(session.id)
      }
      // Why: fire-and-forget so this listing hot path doesn't serialize a relay round-trip per session and a throw can't abort the sweep below.
      this.deps.refreshPtyForegroundAgent()(session.id)
    }
    for (const pty of this.deps.ptysById().values()) {
      if (connectionId !== undefined && pty.connectionId !== connectionId) {
        continue
      }
      if (!allLivePtyIds.has(pty.ptyId) && !this.deps.leafExistsForPty(pty.ptyId)) {
        const currentVerdict = this.deps.ptyLivenessVerdictByPtyId().get(pty.ptyId)
        if (
          currentVerdict &&
          currentVerdict.observedAt > livenessObservationAtStart &&
          currentVerdict.verdict.status === 'unverifiable'
        ) {
          pty.connected = false
          pty.disconnectedAt ??= Date.now()
          continue
        }
        const observed = this.deps.ptyController.hasPty?.(pty.ptyId)
        if (observed === true) {
          // Why: an SSH spawn can become addressable before an overlapping relay list includes it.
          allLivePtyIds.add(pty.ptyId)
          if (
            !targetWorktreeId ||
            (pty.worktreeId && runtimeWorktreeIdsEqual(pty.worktreeId, targetWorktreeId))
          ) {
            selectedLivePtyIds.add(pty.ptyId)
          }
          pty.connected = true
          pty.disconnectedAt = null
          this.deps.forgetPtyLivenessVerdict(pty.ptyId)
          continue
        }
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
        pty.agentSessionOwners = []
        // Why: this list only enumerates registered providers, so a dropped relay
        // clears `connected` for every one of its PTYs at once. Only `false` here
        // is an observed absence; `null` means no provider could be asked.
        if (observed === false) {
          this.deps.forgetPtyLivenessVerdict(pty.ptyId)
        } else if (observed === null) {
          this.deps.markPtyLivenessUnverifiable(pty.ptyId, NO_OBSERVING_PROVIDER_REASON)
        }
      }
    }
    // Why: runs after the hasPty rescue so a still-addressable pane keeps its receipt.
    // A provider that failed to list is absent from `sessions`, and dropping authority on
    // that silence would retire an orchestration handle the relay can still reach.
    for (const [ptyId, receipt] of this.deps.restoredOrchestrationAuthorityByPtyId()) {
      const inScope =
        connectionId === undefined ||
        (connectionId === null && receipt.hostScope.kind !== 'ssh') ||
        (typeof connectionId === 'string' &&
          receipt.hostScope.kind === 'ssh' &&
          receipt.hostScope.targetId === connectionId)
      if (inScope && !allLivePtyIds.has(ptyId)) {
        this.deps.restoredOrchestrationAuthorityByPtyId().delete(ptyId)
      }
    }
    this.deps.pruneDisconnectedPtyRecords()
    return {
      livePtyIds: targetWorktreeId ? selectedLivePtyIds : allLivePtyIds,
      allLivePtyIds,
      terminalIdentityByPtyId: controllerIdentityByPtyId,
      queriedHostIds
    }
  }
}
