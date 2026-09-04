import type { RuntimeOrchestrationCommandsDeps } from './runtime-orchestration-commands-deps'
import type {
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  OrchestrationCompatibilityHostStamp
} from '../../shared/orchestration-compatibility-evidence'
import type { AgentStatusOrchestrationContext } from '../../shared/agent-status-types'
import type { RuntimePtyWorktreeRecord } from '../../shared/runtime-types'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { runtimeWorktreeIdsEqual } from '../../shared/worktree/id'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

export class RuntimeOrchestrationCommands {
  constructor(private deps: RuntimeOrchestrationCommandsDeps) {}

  freezeOrchestrationCompatibilityCallerAuthority(
    terminal: OrchestrationCompatibilityTerminalAuthority,
    processIncarnation: string,
    paneKey: string,
    terminalHandle: string,
    launchTokenHash: string
  ): OrchestrationCompatibilityCallerAuthority {
    return Object.freeze({
      hostScope: Object.freeze({ ...terminal.hostScope }),
      paneKey,
      terminalHandle,
      processIncarnation,
      launchTokenHash
    })
  }

  orchestrationCompatibilityHostMatches(
    hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope'],
    host: OrchestrationCompatibilityHostStamp | undefined
  ): boolean {
    if (hostScope.kind === 'local') {
      return host === undefined
    }
    if (hostScope.kind === 'wsl') {
      return (
        host?.kind === 'wsl' && host.hostId === hostScope.hostId && host.distro === hostScope.distro
      )
    }
    if (host?.kind !== 'ssh' || host.targetId !== hostScope.targetId) {
      return false
    }
    const authority = this.deps.orchestrationCompatibilitySshAttachments.get(host.attachmentId)
    return (
      authority?.targetId === host.targetId &&
      authority.connectionIncarnation === host.connectionIncarnation
    )
  }

  orchestrationCompatibilityHostScopesEqual(
    left: OrchestrationCompatibilityTerminalAuthority['hostScope'],
    right: OrchestrationCompatibilityTerminalAuthority['hostScope']
  ): boolean {
    if (left.kind !== right.kind) {
      return false
    }
    if (left.kind === 'local' && right.kind === 'local') {
      return left.hostId === right.hostId
    }
    if (left.kind === 'wsl' && right.kind === 'wsl') {
      return left.hostId === right.hostId && left.distro === right.distro
    }
    return left.kind === 'ssh' && right.kind === 'ssh' && left.targetId === right.targetId
  }

  getOrchestrationCompatibilityHostScope(
    pty: RuntimePtyWorktreeRecord
  ): OrchestrationCompatibilityTerminalAuthority['hostScope'] | null {
    if (pty.connectionId) {
      return { kind: 'ssh', targetId: pty.connectionId }
    }
    if (pty.isWsl || pty.wslDistro) {
      return pty.wslDistro ? { kind: 'wsl', hostId: 'local', distro: pty.wslDistro } : null
    }
    return { kind: 'local', hostId: 'local' }
  }

  rememberRestoredOrchestrationAuthority(
    pty: RuntimePtyWorktreeRecord,
    terminalHandle: string,
    incarnationId: string
  ): void {
    const paneKey = pty.paneKey
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!paneKey || !parsePaneKey(paneKey) || !hostScope) {
      this.deps.restoredOrchestrationAuthorityByPtyId.delete(pty.ptyId)
      return
    }
    this.deps.restoredOrchestrationAuthorityByPtyId.set(
      pty.ptyId,
      Object.freeze({
        ptyId: pty.ptyId,
        worktreeId: pty.worktreeId,
        terminalHandle,
        paneKey,
        processIncarnation: `${pty.ptyId}:${incarnationId}`,
        hostScope: Object.freeze({ ...hostScope })
      })
    )
  }

  getOrchestrationDbIfAvailable() {
    try {
      return this.deps.orchestrationDb ?? this.deps.store?.getOrchestrationDb?.()
    } catch {
      return this.deps.orchestrationDb
    }
  }

  buildAgentOrchestrationByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined {
    const db = this.getOrchestrationDbIfAvailable()
    if (!db) {
      return undefined
    }
    if (db.hasAnyDispatchContexts?.() === false) {
      return undefined
    }
    const contexts: Record<string, AgentStatusOrchestrationContext> = {}
    const queriedHandles = new Set<string>()
    for (const leaf of this.deps.leaves.values()) {
      if (!leaf.ptyId) {
        continue
      }
      const handle = this.deps.issueHandle(leaf)
      queriedHandles.add(handle)
      const context = this.getAgentStatusOrchestrationContextForHandle(handle, db)
      if (context) {
        contexts[this.deps.makeRuntimePaneKey(leaf)] = context
      }
    }
    for (const pty of this.deps.ptysById.values()) {
      if (!pty.paneKey || contexts[pty.paneKey]) {
        continue
      }
      const handle = this.deps.issuePtyHandle(pty)
      if (queriedHandles.has(handle)) {
        continue
      }
      queriedHandles.add(handle)
      const context = this.getAgentStatusOrchestrationContextForHandle(handle, db)
      if (context) {
        contexts[pty.paneKey] = context
      }
    }
    return Object.keys(contexts).length > 0 ? contexts : undefined
  }

  getAgentStatusOrchestrationContextForHandle(
    handle: string,
    db = this.getOrchestrationDbIfAvailable()
  ): AgentStatusOrchestrationContext | undefined {
    const dispatch =
      db?.getActiveDispatchForTerminal?.(handle) ??
      this.deps.getRecentSettledDispatchForTerminal(handle, db)
    if (!dispatch) {
      return undefined
    }
    const task = db?.getTask?.(dispatch.task_id, dispatch.run_id)
    const display =
      typeof task?.spec === 'string'
        ? buildOrchestrationTaskDisplayMetadata({
            spec: task.spec,
            taskTitle: task.task_title,
            displayName: task.display_name
          })
        : { taskTitle: '', displayName: '' }
    const owningRun =
      task?.run_id && task.run_id === dispatch.run_id ? db?.getRun?.(dispatch.run_id) : undefined
    const runCoordinatorHandle = owningRun?.coordinator_handle ?? undefined
    const legacyActiveRun =
      owningRun?.legacy === 1 && (dispatch.status === 'pending' || dispatch.status === 'dispatched')
        ? db?.getActiveCoordinatorRun?.()
        : undefined
    const handleWorktreeId = legacyActiveRun
      ? this.deps.getWorktreeIdForTerminalHandle(handle)
      : null
    const legacyCoordinatorWorktreeId = legacyActiveRun
      ? this.deps.getWorktreeIdForTerminalHandle(legacyActiveRun.coordinator_handle)
      : null
    const scopedLegacyActiveRun =
      legacyActiveRun &&
      handleWorktreeId &&
      legacyCoordinatorWorktreeId &&
      runtimeWorktreeIdsEqual(legacyCoordinatorWorktreeId, handleWorktreeId)
        ? legacyActiveRun
        : undefined
    const coordinatorHandle = runCoordinatorHandle ?? scopedLegacyActiveRun?.coordinator_handle
    const orchestrationRunId = owningRun?.legacy === 0 ? owningRun.id : scopedLegacyActiveRun?.id
    const creatorPaneKey = task?.created_by_pane_key
    const creatorPaneHandle = creatorPaneKey
      ? this.deps.getTerminalHandleForPaneKey(creatorPaneKey)
      : null
    const creatorAuthority = creatorPaneHandle
      ? this.deps.getOrchestrationDispatchAuthority(creatorPaneHandle)
      : null
    const storedCreatorPane = creatorPaneKey ? parsePaneKey(creatorPaneKey) : null
    const currentCreatorPane = creatorAuthority?.paneKey
      ? parsePaneKey(creatorAuthority.paneKey)
      : null
    const sameCreatorPane = Boolean(
      creatorPaneKey &&
      creatorAuthority?.paneKey &&
      (creatorPaneKey === creatorAuthority.paneKey ||
        (storedCreatorPane &&
          currentCreatorPane &&
          storedCreatorPane.leafId === currentCreatorPane.leafId))
    )
    const paneRun = creatorPaneKey ? db?.getCurrentRunForPane?.(creatorPaneKey) : undefined
    const sameRunCreatorDispatch = Boolean(
      task?.creator_dispatch_id &&
      task.creator_dispatch_run_id === owningRun?.id &&
      task.creator_dispatch_pane_key &&
      task.creator_dispatch_process_incarnation === task.created_by_process_incarnation &&
      parsePaneKey(task.creator_dispatch_pane_key)?.leafId === storedCreatorPane?.leafId
    )
    const currentCreatorHandle =
      owningRun?.legacy === 0 &&
      task?.created_by_run_generation === owningRun.consumer_generation &&
      task.created_by_process_incarnation === creatorAuthority?.processIncarnation &&
      sameCreatorPane &&
      (paneRun
        ? paneRun.id === owningRun.id &&
          paneRun.consumer_generation === task.created_by_run_generation
        : sameRunCreatorDispatch)
        ? (creatorPaneHandle ?? undefined)
        : undefined
    const parentTerminalHandle =
      currentCreatorHandle ??
      (coordinatorHandle && coordinatorHandle !== handle ? coordinatorHandle : undefined)
    const parentPaneKey = parentTerminalHandle
      ? this.deps.getPaneKeyForTerminalHandle(parentTerminalHandle)
      : undefined

    return {
      taskId: dispatch.task_id,
      dispatchId: dispatch.id,
      dispatchStatus: dispatch.status,
      ...(display.taskTitle ? { taskTitle: display.taskTitle } : {}),
      ...(display.displayName ? { displayName: display.displayName } : {}),
      ...(parentTerminalHandle ? { parentTerminalHandle } : {}),
      ...(parentPaneKey ? { parentPaneKey } : {}),
      ...(coordinatorHandle ? { coordinatorHandle } : {}),
      ...(orchestrationRunId ? { orchestrationRunId } : {})
    }
  }

  writeOrchestrationPointerPty(ptyId: string, data: string): boolean | Promise<boolean> {
    try {
      if (data === '\r') {
        const admitted = this.deps.orchestrationPointerAdmissionByPtyId.get(ptyId)
        this.deps.orchestrationPointerAdmissionByPtyId.delete(ptyId)
        if (admitted) {
          agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        }
      } else {
        const admission = agentSessionPtyWriteGate.admit(ptyId)
        if (!admission.admitted) {
          this.deps.orchestrationPointerAdmissionByPtyId.delete(ptyId)
          return this.deps.ptyController?.write(ptyId, data) ?? false
        }
        this.deps.orchestrationPointerAdmissionByPtyId.set(ptyId, {
          sessionId: admission.sessionId,
          runtimeFence: admission.runtimeFence
        })
      }
      if (this.deps.ptyController?.writeWithSettlement) {
        return this.deps.ptyController.writeWithSettlement(ptyId, data).catch(() => false)
      }
      return this.deps.ptyController?.write(ptyId, data) ?? false
    } catch {
      return false
    }
  }
}
