import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type {
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  describeTerminalExitCause,
  isDeliberateTerminalExit
} from '../../shared/terminal-exit-cause'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { OrchestrationDb } from './orchestration/db'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { DispatchStatus } from './orchestration/types'
import type { WorkerTerminalReleaseReconciliationResult } from './orchestration/worker-terminal-release-reconciliation'
import {
  getLatestPtyTitle,
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-tail-projection'
import type {
  LegacyWorkerTerminalRecoveryResolution,
  LegacyWorkerTerminalRecoveryResult,
  PtyControllerInventory,
  ResolvedWorktree,
  RuntimeNotifier,
  RuntimePtyWorktreeRecord,
  TerminalWorkspaceLaunchScope
} from './orca-runtime'

export type RuntimeTerminalRecoveryCommandsDeps = {
  _orchestrationDb: () => OrchestrationDb | null
  prepareLegacyWorkerTerminalRecovery: () => LegacyWorkerTerminalRecoveryPlan
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
  canRecoverPersistentLocalPtysFn: () => () => boolean
  folderWorkspaceToResolvedWorktree: (folderWorkspace: FolderWorkspace) => ResolvedWorktree
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null,
    deadline?: number,
    connectionId?: string | null
  ) => Promise<PtyControllerInventory | null>
  getWorkspaceSessionForWorktree: (worktreeId: string) => WorkspaceSessionState | null
  hasExactPersistedTerminalSurfaceIdentity: (expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }) => boolean
  hasExactTerminalSurfaceIdentity: (expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    terminalHandle: string
    incarnationId: string
  }) => boolean
  getTerminalTopologyRevision: (worktreeId: string) => number
  adoptTerminalOrphansFromInventory: (
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ) => Promise<RuntimeTerminalOrphanAdoptionResult>
  notifier: () => RuntimeNotifier | null
  legacyWorkerTerminalReceiptEpochByPane: () => Map<string, number>
  rendererGraphEpoch: () => number
  ptysById: () => Map<string, RuntimePtyWorktreeRecord>
  onPtyExit: (
    ptyId: string,
    exitCode: number,
    exitIncarnationId?: PtyIncarnationId,
    options?: {
      hostExitConfirmed?: boolean
      cause?: TerminalExitCause
      providerExitObserved?: boolean
    }
  ) => void
  persistLegacyWorkerTerminalRecoveryBatch: (
    resolutions: readonly LegacyWorkerTerminalRecoveryResolution[]
  ) => Promise<ReadonlySet<string>>
  legacyWorkerRecoveredPtys: () => Set<string>
  rollbackLegacyWorkerTerminalSurface: (
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ) => void
  reconcileMissingLegacyWorkerTerminal: (
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ) => boolean
  updateLegacyWorkerTerminalRecoveryRetry: (
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ) => void
  notifyMessageArrived: (handle: string, messageType?: string) => void
  reconcileRequestedWorkerTerminalReleasesFn: () => Promise<WorkerTerminalReleaseReconciliationResult>
}

export class RuntimeTerminalRecoveryCommands {
  private readonly deps: RuntimeTerminalRecoveryCommandsDeps

  constructor(deps: RuntimeTerminalRecoveryCommandsDeps) {
    this.deps = deps
  }

  async reconcileLegacyWorkerTerminalsNow(options: {
    connectionId?: string
    materializeRenderer?: boolean
  }): Promise<LegacyWorkerTerminalRecoveryResult> {
    const plan = this.deps.prepareLegacyWorkerTerminalRecovery()
    const adoptedDispatchIds: string[] = []
    const exitedDispatchIds: string[] = []
    const deferredDispatchIds = new Set(plan.ambiguousDispatchIds)
    const pendingResolutions: LegacyWorkerTerminalRecoveryResolution[] = []
    const recoveryCandidatesByProvider = new Map<
      string,
      {
        connectionId: string | null
        entries: {
          candidate: (typeof plan.candidates)[number]
          workspace: TerminalWorkspaceLaunchScope
          resolvedWorkspace: ResolvedWorktree
        }[]
      }
    >()
    for (const candidate of plan.candidates) {
      try {
        const workspace = await this.deps.resolveTerminalWorkspaceLaunchScope(
          `id:${candidate.worktreeId}`
        )
        const sshPty = parseAppSshPtyId(candidate.ptyId)
        if (workspace.connectionId) {
          if (
            options.connectionId !== workspace.connectionId ||
            sshPty?.connectionId !== workspace.connectionId
          ) {
            deferredDispatchIds.add(candidate.dispatchId)
            continue
          }
        } else if (
          options.connectionId !== undefined ||
          sshPty !== null ||
          !this.deps.canRecoverPersistentLocalPtysFn()()
        ) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        const resolvedWorkspace = workspace.folderWorkspace
          ? this.deps.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
          : await this.deps.resolveWorktreeSelector(`id:${workspace.id}`)
        const connectionId = workspace.connectionId ?? null
        const providerKey = connectionId === null ? 'local' : `ssh:${connectionId}`
        const provider = recoveryCandidatesByProvider.get(providerKey) ?? {
          connectionId,
          entries: []
        }
        provider.entries.push({ candidate, workspace, resolvedWorkspace })
        recoveryCandidatesByProvider.set(providerKey, provider)
      } catch {
        deferredDispatchIds.add(candidate.dispatchId)
      }
    }
    for (const provider of recoveryCandidatesByProvider.values()) {
      const resolvedWorktrees = [
        ...new Map(
          provider.entries.map(({ resolvedWorkspace }) => [resolvedWorkspace.id, resolvedWorkspace])
        ).values()
      ]
      const inventory = await this.deps.refreshPtyWorktreeRecordsWithControllerInventory(
        resolvedWorktrees,
        null,
        undefined,
        provider.connectionId
      )
      if (!inventory) {
        provider.entries.forEach(({ candidate }) => deferredDispatchIds.add(candidate.dispatchId))
        continue
      }
      for (const { candidate, workspace } of provider.entries) {
        if (!inventory.livePtyIds.has(candidate.ptyId)) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const controllerIdentity = inventory.terminalIdentityByPtyId.get(candidate.ptyId)
        if (!controllerIdentity) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          controllerIdentity.handle !== candidate.terminalHandle ||
          controllerIdentity.incarnationId !== candidate.incarnationId
        ) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const preAdoptionInventory =
          await this.deps.refreshPtyWorktreeRecordsWithControllerInventory(
            resolvedWorktrees,
            null,
            undefined,
            provider.connectionId
          )
        if (!preAdoptionInventory) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (!preAdoptionInventory.livePtyIds.has(candidate.ptyId)) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const preAdoptionIdentity = preAdoptionInventory.terminalIdentityByPtyId.get(
          candidate.ptyId
        )
        if (!preAdoptionIdentity) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          preAdoptionIdentity.handle !== candidate.terminalHandle ||
          preAdoptionIdentity.incarnationId !== candidate.incarnationId
        ) {
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const session = this.deps.getWorkspaceSessionForWorktree(candidate.worktreeId)
        const sessionWorktreeId = session
          ? resolveTerminalSessionWorktreeId(session, candidate.worktreeId)
          : null
        const activeTabId = sessionWorktreeId
          ? session?.activeTabIdByWorktree?.[sessionWorktreeId]
          : undefined
        const activeGroupId = sessionWorktreeId
          ? session?.activeGroupIdByWorktree?.[sessionWorktreeId]
          : undefined
        const exactSurfaceAlreadyPublished =
          this.deps.hasExactPersistedTerminalSurfaceIdentity(candidate) &&
          this.deps.hasExactTerminalSurfaceIdentity(candidate)
        if (!exactSurfaceAlreadyPublished) {
          try {
            await this.deps.adoptTerminalOrphansFromInventory(
              {
                worktree: `id:${candidate.worktreeId}`,
                expectedTopologyRevision: this.deps.getTerminalTopologyRevision(
                  candidate.worktreeId
                ),
                ...(activeTabId ? { activeTabId } : {}),
                ...(activeGroupId ? { activeGroupId } : {}),
                claims: [
                  {
                    terminal: candidate.terminalHandle,
                    ptyId: candidate.ptyId,
                    incarnationId: candidate.incarnationId,
                    tabId: candidate.tabId,
                    leafId: candidate.leafId
                  }
                ]
              },
              workspace,
              preAdoptionInventory
            )
          } catch (error) {
            console.warn('[orchestration] legacy worker terminal adoption deferred', {
              dispatchId: candidate.dispatchId,
              error
            })
            deferredDispatchIds.add(candidate.dispatchId)
            continue
          }
        }
        let rendererMaterialized =
          options.materializeRenderer !== true ||
          this.deps.legacyWorkerTerminalReceiptEpochByPane().get(candidate.paneKey) ===
            this.deps.rendererGraphEpoch()
        const pty = this.deps.ptysById().get(candidate.ptyId)
        if (
          options.materializeRenderer &&
          !rendererMaterialized &&
          pty &&
          this.deps.notifier()?.revealTerminalSession
        ) {
          for (let attempt = 0; attempt < 2 && !rendererMaterialized; attempt += 1) {
            try {
              const reveal = await this.deps
                .notifier()
                ?.revealTerminalSession?.(candidate.worktreeId, {
                  ptyId: candidate.ptyId,
                  title: getLatestPtyTitle(pty) ?? pty.controllerTitle,
                  activate: false,
                  presentation: 'background',
                  tabId: candidate.tabId,
                  leafId: candidate.leafId,
                  focus: false,
                  expectedProcessIdentity: {
                    terminalHandle: candidate.terminalHandle,
                    incarnationId: candidate.incarnationId
                  }
                })
              const identity = reveal?.identity
              if (
                !identity ||
                !runtimeWorktreeIdsEqual(identity.worktreeId, candidate.worktreeId) ||
                identity.tabId !== candidate.tabId ||
                identity.leafId !== candidate.leafId ||
                identity.ptyId !== candidate.ptyId
              ) {
                throw new Error('terminal_reveal_identity_mismatch')
              }
              rendererMaterialized = true
              this.deps
                .legacyWorkerTerminalReceiptEpochByPane()
                .set(candidate.paneKey, this.deps.rendererGraphEpoch())
            } catch (error) {
              if (attempt === 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, 100))
                continue
              }
              console.warn('[orchestration] adopted legacy worker was not revealed', {
                dispatchId: candidate.dispatchId,
                error
              })
            }
          }
        }
        if (!rendererMaterialized) {
          this.deps.legacyWorkerTerminalReceiptEpochByPane().delete(candidate.paneKey)
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          options.materializeRenderer === true &&
          !this.deps.hasExactTerminalSurfaceIdentity({
            worktreeId: candidate.worktreeId,
            tabId: candidate.tabId,
            leafId: candidate.leafId,
            ptyId: candidate.ptyId,
            terminalHandle: candidate.terminalHandle,
            incarnationId: candidate.incarnationId
          })
        ) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        const finalInventory = await this.deps.refreshPtyWorktreeRecordsWithControllerInventory(
          resolvedWorktrees,
          null,
          undefined,
          provider.connectionId
        )
        if (!finalInventory) {
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (!finalInventory.livePtyIds.has(candidate.ptyId)) {
          this.deps.legacyWorkerTerminalReceiptEpochByPane().delete(candidate.paneKey)
          this.deps.onPtyExit(candidate.ptyId, 0, candidate.incarnationId)
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        const finalIdentity = finalInventory.terminalIdentityByPtyId.get(candidate.ptyId)
        if (!finalIdentity) {
          this.deps.legacyWorkerTerminalReceiptEpochByPane().delete(candidate.paneKey)
          deferredDispatchIds.add(candidate.dispatchId)
          continue
        }
        if (
          finalIdentity.handle !== candidate.terminalHandle ||
          finalIdentity.incarnationId !== candidate.incarnationId
        ) {
          this.deps.legacyWorkerTerminalReceiptEpochByPane().delete(candidate.paneKey)
          pendingResolutions.push({ candidate, resolution: 'exited' })
          continue
        }
        pendingResolutions.push({ candidate, resolution: 'adopted' })
      }
    }
    const persistedDispatchIds =
      await this.deps.persistLegacyWorkerTerminalRecoveryBatch(pendingResolutions)
    for (const { candidate, resolution } of pendingResolutions) {
      if (!persistedDispatchIds.has(candidate.dispatchId)) {
        deferredDispatchIds.add(candidate.dispatchId)
        continue
      }
      if (resolution === 'adopted') {
        this.deps.legacyWorkerRecoveredPtys().add(candidate.ptyId)
        this.deps.notifier()?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, 'adopted')
        adoptedDispatchIds.push(candidate.dispatchId)
        continue
      }
      this.deps.rollbackLegacyWorkerTerminalSurface(candidate)
      if (!this.deps.reconcileMissingLegacyWorkerTerminal(candidate)) {
        deferredDispatchIds.add(candidate.dispatchId)
        continue
      }
      this.deps.notifier()?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, 'exited')
      exitedDispatchIds.push(candidate.dispatchId)
    }
    const result = {
      blockedPaneCount: plan.blockedPanes.length,
      adoptedDispatchIds,
      exitedDispatchIds,
      deferredDispatchIds: [...deferredDispatchIds]
    }
    this.deps.updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
    // Why: previously requested releases may only finish after the owning provider's terminals
    // are rediscovered; this pass runs per scope (local and each reconnected provider).
    void this.deps.reconcileRequestedWorkerTerminalReleasesFn().catch((error) => {
      console.warn('[orchestration] worker terminal release reconciliation failed', { error })
    })
    return result
  }

  failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ): void {
    const db = this.deps._orchestrationDb()
    if (!db) {
      return
    }

    // Why the pane key too: a reminted handle no longer matches the row, but the
    // pane identity behind it outlives the remint.
    const dispatch = db.getActiveDispatchForTerminal(handle, paneKey ?? undefined)
    if (!dispatch) {
      return
    }

    const errorContext = describeTerminalExitCause(cause)
    const settled = db.failDispatch(dispatch.id, errorContext, {
      workerProcessExited: true,
      terminationReason: cause.kind
    })

    // Why: a deliberate close is not an incident. Escalating it trains
    // coordinators to ignore the channel that should wake them for a real one.
    if (isDeliberateTerminalExit(cause)) {
      return
    }

    // Why: failDispatch above is the authoritative state transition and has already
    // committed. Everything below is best-effort mail on top of it — resolving the
    // recipient reads the database too — and onPtyExit runs this synchronously per leaf,
    // so letting any of it escape would abandon the remaining leaves and the pty record
    // pruning that close out this exit.
    try {
      // Why: create an escalation message so the coordinator is notified about
      // the unexpected exit, even if the circuit breaker hasn't tripped yet.
      const recipient = this.resolveExitEscalationRecipient(dispatch.run_id)
      if (!recipient) {
        return
      }
      const escalation = db.insertMessage({
        from: handle,
        to: recipient.to,
        subject: `Agent exited unexpectedly (${errorContext})`,
        body: this.describeWorkerExit(dispatch, cause, handle, settled?.status),
        type: 'escalation',
        priority: 'high',
        // Why: applyEscalationToDispatch rejects an escalation without an exact Dispatch
        // binding, and a coordinator reading this needs to know which Dispatch died.
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          // Why both: `exitCode` stays for readers that already parse it, but it
          // is the raw number the host handed over, not a verdict — `exitCause`
          // is what says whether the agent was killed, finished, or was closed.
          exitCode,
          exitCause: cause,
          handle
        }),
        ...(recipient.runId ? { runId: recipient.runId } : {})
      })
      // Why: worker death is the one escalation nobody will poll for — the dead pane
      // can't nudge the coordinator, so wake its check --wait the way every other
      // message producer does.
      this.deps.notifyMessageArrived(escalation.to_handle, escalation.type)
    } catch (error) {
      // Why: log the Run rather than the recipient — resolution itself can be what failed.
      console.warn('[orchestration] failed to escalate worker exit', {
        dispatchId: dispatch.id,
        runId: dispatch.run_id,
        error
      })
    }
  }

  describeWorkerExit(
    dispatch: { id: string; task_id: string; run_id: string },
    cause: TerminalExitCause,
    handle: string,
    settledStatus: DispatchStatus | undefined
  ): string {
    const task = this.deps._orchestrationDb()?.getTask?.(dispatch.task_id, dispatch.run_id)
    const title =
      typeof task?.spec === 'string'
        ? buildOrchestrationTaskDisplayMetadata({
            spec: task.spec,
            taskTitle: task.task_title,
            displayName: task.display_name
          }).taskTitle
        : ''
    const named = title ? `"${title}" (${dispatch.task_id})` : dispatch.task_id
    const outcome =
      settledStatus === 'circuit_broken'
        ? ' This task has now failed too many times, so it will not be retried automatically.'
        : settledStatus === 'failed'
          ? ' The task is ready to be dispatched again.'
          : ''
    // Why the cause and not a code: `code 0` reads as success even when the
    // worker was killed, which is what sent operators chasing phantom OOMs.
    return `Worker ${handle} stopped while running task ${named}. ${describeTerminalExitCause(
      cause
    )}.${outcome}`
  }

  resolveExitEscalationRecipient(runId: string): { to: string; runId?: string } | undefined {
    const owningRun = this.deps._orchestrationDb()?.getRun?.(runId)
    if (owningRun && owningRun.legacy !== 1) {
      return { to: `run:${owningRun.id}`, runId: owningRun.id }
    }
    const legacyRun = this.deps._orchestrationDb()?.getActiveCoordinatorRun?.()
    return legacyRun ? { to: legacyRun.coordinator_handle } : undefined
  }
}
