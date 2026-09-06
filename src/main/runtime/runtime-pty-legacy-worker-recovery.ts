import type { LegacyWorkerTerminalRecoveryResolution } from './orca-runtime'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { planLegacyWorkerTerminalRecovery } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { runtimeWorktreeIdsEqual } from './runtime-tail-projection'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'
import type { RuntimePtyWorktrees, RuntimePtyWorktreesDeps } from './runtime-pty-worktrees'

export class RuntimePtyLegacyWorkerRecovery {
  constructor(
    private readonly host: RuntimePtyWorktrees,
    private readonly deps: RuntimePtyWorktreesDeps
  ) {}

  armLegacyWorkerTerminalRecoveryRetry(
    scopeKey: string,
    retry: {
      attempt: number
      connectionId?: string
      materializeRenderer: boolean
      timer: ReturnType<typeof setTimeout> | null
    }
  ): void {
    if (retry.timer) {
      return
    }
    const delayMs = Math.min(1_000 * 2 ** retry.attempt, 30_000)
    retry.attempt += 1
    retry.timer = setTimeout(() => {
      retry.timer = null
      void this.deps
        .reconcileLegacyWorkerTerminals({
          ...(retry.connectionId ? { connectionId: retry.connectionId } : {}),
          materializeRenderer: retry.materializeRenderer
        })
        .catch((error) => {
          console.warn('[orchestration] worker terminal recovery retry failed', {
            scope: scopeKey,
            error
          })
          if (this.deps.legacyWorkerTerminalRecoveryRetries().get(scopeKey) === retry) {
            this.armLegacyWorkerTerminalRecoveryRetry(scopeKey, retry)
          }
        })
    }, delayMs)
    retry.timer.unref?.()
  }

  cancelLegacyWorkerTerminalRecoveryRetry(scopeKey: string): void {
    const retry = this.deps.legacyWorkerTerminalRecoveryRetries().get(scopeKey)
    if (retry?.timer) {
      clearTimeout(retry.timer)
    }
    this.deps.legacyWorkerTerminalRecoveryRetries().delete(scopeKey)
  }

  getLegacyWorkerTerminalRecoveryPlan(): LegacyWorkerTerminalRecoveryPlan {
    try {
      return planLegacyWorkerTerminalRecovery(
        this.deps.getOrchestrationDb().listLegacyWorkerTerminalRecoveryRows()
      )
    } catch (error) {
      console.warn('[orchestration] failed to plan legacy worker terminal recovery', error)
      return { blockedPanes: [], candidates: [], ambiguousDispatchIds: [] }
    }
  }

  async persistLegacyWorkerTerminalRecoveryBatch(
    resolutions: readonly LegacyWorkerTerminalRecoveryResolution[]
  ): Promise<ReadonlySet<string>> {
    const store = this.deps.store()
    if (
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
    ) {
      return new Set()
    }
    const originalSessions = new Map<ExecutionHostId, WorkspaceSessionState>()
    const stagedSessions = new Map<ExecutionHostId, WorkspaceSessionState>()
    const stagedDispatchIds = new Set<string>()
    try {
      for (const { candidate, resolution } of resolutions) {
        const hostId = this.deps.tryGetWorkspaceSessionHostIdForWorktree(candidate.worktreeId)
        const session = hostId ? store.getWorkspaceSession(hostId) : null
        if (!hostId || !session) {
          continue
        }
        originalSessions.set(hostId, originalSessions.get(hostId) ?? session)
        let next =
          resolution === 'exited'
            ? retireTerminalSurfaceFromPersistence(session, {
                worktreeId: candidate.worktreeId,
                parentTabId: candidate.tabId,
                leafId: candidate.leafId,
                ptyId: candidate.ptyId,
                incarnationId: candidate.incarnationId
              })
            : session
        const record = next.sleepingAgentSessionsByPaneKey?.[candidate.paneKey]
        if (record && runtimeWorktreeIdsEqual(record.worktreeId, candidate.worktreeId)) {
          const sleepingAgentSessionsByPaneKey = { ...next.sleepingAgentSessionsByPaneKey }
          delete sleepingAgentSessionsByPaneKey[candidate.paneKey]
          next = { ...next, sleepingAgentSessionsByPaneKey }
        }
        if (next !== session) {
          store.setWorkspaceSession(next, hostId)
        }
        stagedSessions.set(hostId, store.getWorkspaceSession(hostId))
        stagedDispatchIds.add(candidate.dispatchId)
      }
      if (stagedDispatchIds.size > 0) {
        await this.deps.flushWorkspaceSessionOrThrowAsync()
      }
      return stagedDispatchIds
    } catch (error) {
      for (const [hostId, original] of originalSessions) {
        const staged = stagedSessions.get(hostId)
        const current = store.getWorkspaceSession(hostId)
        if (!staged || !current) {
          continue
        }
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(original, staged, current)
        if (rolledBack !== current) {
          store.setWorkspaceSession(rolledBack, hostId)
        }
      }
      console.warn('[orchestration] failed to persist legacy worker recovery batch', {
        dispatchIds: [...stagedDispatchIds],
        error
      })
      return new Set()
    }
  }

  prepareLegacyWorkerTerminalRecovery(): LegacyWorkerTerminalRecoveryPlan {
    const plan = this.getLegacyWorkerTerminalRecoveryPlan()
    const store = this.deps.store()
    if (
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
    ) {
      return plan
    }
    const sessions = new Map<
      ExecutionHostId,
      { current: WorkspaceSessionState; next: WorkspaceSessionState }
    >()
    const changedHostIds = new Set<ExecutionHostId>()
    for (const blocked of plan.blockedPanes) {
      let hostIds: ExecutionHostId[]
      try {
        hostIds = [this.deps.getWorkspaceSessionHostIdForWorktree(blocked.worktreeId)]
      } catch (error) {
        console.warn('[orchestration] legacy worker resume fence owner is unavailable', {
          worktreeId: blocked.worktreeId,
          error
        })
        hostIds = store.getWorkspaceSessionHostIds?.() ?? [LOCAL_EXECUTION_HOST_ID]
      }
      for (const hostId of hostIds) {
        let state = sessions.get(hostId)
        if (!state) {
          const current = store.getWorkspaceSession(hostId)
          if (!current) {
            continue
          }
          state = { current, next: structuredClone(current) }
          sessions.set(hostId, state)
        }
        const record = state.next.sleepingAgentSessionsByPaneKey?.[blocked.paneKey]
        if (
          !record ||
          !runtimeWorktreeIdsEqual(record.worktreeId, blocked.worktreeId) ||
          record.automaticResumeBlockedBy === 'legacy-orchestration-worker'
        ) {
          continue
        }
        state.next.sleepingAgentSessionsByPaneKey = {
          ...state.next.sleepingAgentSessionsByPaneKey,
          [blocked.paneKey]: {
            ...record,
            automaticResumeBlockedBy: 'legacy-orchestration-worker'
          }
        }
        changedHostIds.add(hostId)
      }
    }
    const changed = [...sessions].filter(([hostId]) => changedHostIds.has(hostId))
    if (changed.length === 0) {
      return plan
    }
    try {
      for (const [hostId, state] of changed) {
        store.setWorkspaceSession(state.next, hostId)
      }
    } catch (error) {
      console.warn('[orchestration] failed to stage legacy worker resume fence', error)
    }
    return plan
  }

  reconcileMissingLegacyWorkerTerminal(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): boolean {
    if (candidate.dispatchStatus !== 'pending' && candidate.dispatchStatus !== 'dispatched') {
      return true
    }
    try {
      this.deps
        .getOrchestrationDb()
        .reconcileMissingWorkerTerminal(
          candidate.dispatchId,
          'The assigned worker terminal is no longer live after orchestration recovery.'
        )
      return true
    } catch (error) {
      console.warn('[orchestration] failed to reconcile missing worker terminal', {
        dispatchId: candidate.dispatchId,
        error
      })
      return false
    }
  }

  rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    const snapshot = this.deps.mobileSessionTabsByWorktree().get(candidate.worktreeId)
    if (snapshot) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId: candidate.ptyId,
        exactSurfaces: [{ parentTabId: candidate.tabId, leafId: candidate.leafId }],
        exactOnly: true
      })
      if (retired) {
        this.deps.mobileSessionTabsByWorktree().set(candidate.worktreeId, retired.snapshot)
        this.deps.notifyMobileSessionTabsChanged(candidate.worktreeId)
      }
    }

    const leafKey = this.deps.getLeafKey(candidate.tabId, candidate.leafId)
    const leaf = this.deps.leaves().get(leafKey)
    const pty = this.deps.ptysById().get(candidate.ptyId)
    if (
      leaf?.ptyId === candidate.ptyId &&
      runtimeWorktreeIdsEqual(leaf.worktreeId, candidate.worktreeId)
    ) {
      this.deps.leaves().delete(leafKey)
      const surfaceHandle = this.deps.handleByLeafKey().get(leafKey)
      this.deps.handleByLeafKey().delete(leafKey)
      const handleRecord = surfaceHandle ? this.deps.handles().get(surfaceHandle) : undefined
      if (
        surfaceHandle &&
        handleRecord?.tabId === candidate.tabId &&
        handleRecord.leafId === candidate.leafId &&
        handleRecord.ptyId === candidate.ptyId
      ) {
        this.deps.handles().delete(surfaceHandle)
      }
      this.host.rebuildLeafPtyIndex()
      if (![...this.deps.leaves().values()].some((entry) => entry.tabId === candidate.tabId)) {
        this.deps.tabs().delete(candidate.tabId)
      }
    }
    if (pty?.tabId === candidate.tabId) {
      pty.tabId = null
      pty.paneKey = null
    }
    this.deps
      .notifier()
      ?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, 'rolled_back', candidate.ptyId)
  }

  updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    const scopeKey = options.connectionId ? `ssh:${options.connectionId}` : 'local'
    const hasDeferredWorker = plan.candidates.some((candidate) => {
      const sshPty = parseAppSshPtyId(candidate.ptyId)
      const inScope = options.connectionId
        ? sshPty?.connectionId === options.connectionId
        : sshPty === null
      return inScope && deferredDispatchIds.has(candidate.dispatchId)
    })
    if (!hasDeferredWorker) {
      this.cancelLegacyWorkerTerminalRecoveryRetry(scopeKey)
      return
    }
    const existing = this.deps.legacyWorkerTerminalRecoveryRetries().get(scopeKey)
    const retry = existing ?? {
      attempt: 0,
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      materializeRenderer: options.materializeRenderer === true,
      timer: null
    }
    retry.materializeRenderer ||= options.materializeRenderer === true
    this.deps.legacyWorkerTerminalRecoveryRetries().set(scopeKey, retry)
    this.armLegacyWorkerTerminalRecoveryRetry(scopeKey, retry)
  }
}
