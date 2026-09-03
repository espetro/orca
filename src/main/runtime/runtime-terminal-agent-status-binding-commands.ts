import type { RuntimeTerminalAgentStatusBindingCommandsDeps } from './runtime-terminal-agent-status-binding-commands-deps'
import type { TerminalAgentStatusSnapshot, RuntimeTerminalInteractiveWait, RuntimeTerminalAgentStatus, RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from '../../shared/agent-prompt-injection'
import { detectAgentStatusFromTitle, isOpenCodeNativeTitle } from '../../shared/agent-detection'
import { getTerminalState } from '../../shared/terminal-tab-types'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { recognizeAgentProcess, isShellProcess } from '../../shared/agent-process-recognition'
import { hasCompatibleAgentTitleIdentity } from '../../shared/agent-title-owner'
import { buildTerminalWaitText, getLatestAgentCandidateTitleInfo, TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../../shared/agent-prompt-injection'

type PtyForegroundProcessRead = { controller: any; process: string | null; available: boolean }
type PtyForegroundProcessReadEntry = { controller: any; startedAfterTitleObservation: number; promise: Promise<PtyForegroundProcessRead> }
type PtyForegroundAgentRefresh = { promise: Promise<boolean>; startedAfterTitleObservation: number; requestedAfterTitleObservation: number }

export class RuntimeTerminalAgentStatusBindingCommands {
  constructor(private readonly deps: RuntimeTerminalAgentStatusBindingCommandsDeps) {}

  getTerminalAgentStatusPtyId = (handle: string): string => {
    const pty = this.deps.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_gone')
      }
      return pty.pty.ptyId
    }
    const { leaf } = this.deps.getLiveLeafForHandle(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    return leaf.ptyId
  }

  assertTerminalAgentStatusPtyBinding = (handle: string, expectedPtyId: string): void => {
    if (this.getTerminalAgentStatusPtyId(handle) === expectedPtyId) {
      return
    }
    throw new Error('terminal_handle_stale')
  }

  getTerminalAgentStatusSnapshot = (handle: string, expectedPtyId: string, waitTextOverride?: string): TerminalAgentStatusSnapshot => {
    const pty = this.deps.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected || pty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_not_writable')
      }
      const leaf = this.deps.getPrimaryLeafForPty(pty.pty.ptyId)
      const leafTitle = leaf
        ? getLatestAgentCandidateTitleInfo(
            { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
            { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
          )
        : null
      const ptyTitle = leafTitle ?? getLatestAgentCandidateTitleInfo(
        { title: pty.pty.title, updatedAt: pty.pty.titleUpdatedAt },
        { title: pty.pty.lastOscTitle, updatedAt: pty.pty.lastOscTitleAt }
      )
      const waitText = waitTextOverride ?? buildTerminalWaitText(pty.pty.tailBuffer, pty.pty.tailPartialLine, pty.pty.preview)
      return {
        waitText,
        waitBlockedAt: pty.pty.waitBlockedAt,
        title: ptyTitle?.title ?? null,
        titleStatus: ptyTitle ? detectAgentStatusFromTitle(ptyTitle.title) : pty.pty.lastAgentStatus,
        titleStatusIsLive: ptyTitle !== null
      }
    }
    const { leaf } = this.deps.getLiveLeafForHandle(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    if (leaf.ptyId !== expectedPtyId) {
      throw new Error('terminal_not_writable')
    }
    const title = getLatestAgentCandidateTitleInfo(
      { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
      { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
    )
    return {
      waitText: waitTextOverride ?? buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview),
      waitBlockedAt: leaf.waitBlockedAt,
      title: title?.title ?? null,
      titleStatus: title ? detectAgentStatusFromTitle(title.title) : leaf.lastAgentStatus,
      titleStatusIsLive: (title?.updatedAt ?? 0) > 0
    }
  }

  hasAuthoritativeTerminalWaitPermission = (terminal: TerminalAgentStatusSnapshot, explicitStatus: { status: any; updatedAt: number } | null, lifecycle: { status: any | null; updatedAt: number } | null | undefined): boolean => {
    return this.resolveAuthoritativeTerminalWaitPermission(terminal, explicitStatus, lifecycle) !== null
  }

  resolveAuthoritativeTerminalWaitPermission = (terminal: TerminalAgentStatusSnapshot, explicitStatus: { status: any; updatedAt: number } | null, lifecycle: { status: any | null; updatedAt: number } | null | undefined): RuntimeTerminalWaitBlockedReason | null => {
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    if (!blockedByWaitText) {
      return null
    }
    const liveTitleClearsBlockedText = terminal.titleStatusIsLive && terminal.titleStatus !== null && terminal.titleStatus !== 'permission' && !isOpenCodeNativeTitle(terminal.title) && blockedByWaitText !== 'agent-approval-prompt'
    if (liveTitleClearsBlockedText && lifecycle?.status !== terminal.titleStatus) {
      return null
    }
    if (blockedByWaitText === 'agent-approval-prompt') {
      return blockedByWaitText
    }
    const newestPermissionAt = Math.max(
      explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
      terminal.waitBlockedAt ?? -1
    )
    const newestClearAt = Math.max(
      explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
    )
    return newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt ? blockedByWaitText : null
  }

  async getTerminalInteractiveWait(handle: string): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let terminal: TerminalAgentStatusSnapshot
    try {
      ptyId = this.getTerminalAgentStatusPtyId(handle)
      terminal = this.getTerminalAgentStatusSnapshot(handle, ptyId)
    } catch {
      return undefined
    }
    const explicitStatus = this.deps.getFreshExplicitAgentStatusForHandle(handle)
    const promptReason = this.resolveAuthoritativeTerminalWaitPermission(terminal, explicitStatus, this.deps.agentPromptLifecycleByPtyId.get(ptyId))
    if (promptReason) {
      return {
        source: 'prompt-text',
        reason: promptReason,
        ...(terminal.waitBlockedAt !== null ? { since: terminal.waitBlockedAt } : {})
      }
    }
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { source: 'title' }
    }
    if (explicitStatus?.status !== 'permission') {
      return null
    }
    const status = await withTimeout(this.probeAgentStatusOncePerPty(handle, ptyId), TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS, undefined)
    if (!status) {
      return undefined
    }
    return status.isRunningAgent && status.status === 'permission' ? { source: 'hook', since: explicitStatus.updatedAt } : null
  }

  private readonly interactiveWaitProbesByPtyId = new Map<string, Promise<RuntimeTerminalAgentStatus | undefined>>()

  probeAgentStatusOncePerPty = (handle: string, ptyId: string): Promise<RuntimeTerminalAgentStatus | undefined> => {
    const inFlight = this.interactiveWaitProbesByPtyId.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = this.deps.getTerminalAgentStatus(handle).catch(() => undefined).finally(() => {
      if (this.interactiveWaitProbesByPtyId.get(ptyId) === probe) {
        this.interactiveWaitProbesByPtyId.delete(ptyId)
      }
    })
    this.interactiveWaitProbesByPtyId.set(ptyId, probe)
    return probe
  }

  terminalHasShellForegroundProcess = async (handle: string, ptyId: string): Promise<boolean> => {
    if (!this.deps.ptyController) {
      return false
    }
    let foregroundProcess: string | null
    try {
      foregroundProcess = await this.deps.ptyController.getForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return false
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    if (!foregroundProcess || !isShellProcess(foregroundProcess)) {
      return false
    }
    const confirmationController = this.deps.ptyController
    if (!confirmationController?.confirmForegroundProcess) {
      return true
    }
    let confirmedProcess: string | null
    try {
      confirmedProcess = await confirmationController.confirmForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return true
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    return recognizeAgentProcess(confirmedProcess) === null
  }

  shouldDelayPtyBackedMobileSnapshotForForegroundAgent = (pty: any, title: string): boolean => {
    return !pty.launchAgent && pty.foregroundAgent === null && hasCompatibleAgentTitleIdentity(title)
  }

  readPtyForegroundProcessFromController = (ptyId: string, afterTitleObservation = 0): Promise<PtyForegroundProcessRead> | null => {
    const controller = this.deps.ptyController
    if (!controller) {
      return null
    }
    const pending = this.deps.ptyForegroundProcessReads.get(ptyId)
    if (pending?.controller === controller && pending.startedAfterTitleObservation >= afterTitleObservation) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      return pending.promise.then(() => this.readPtyForegroundProcessFromController(ptyId, afterTitleObservation) ?? { controller, process: null, available: false })
    }
    const unavailable: PtyForegroundProcessRead = { controller, process: null, available: false }
    let processRead: Promise<string | null>
    try {
      processRead = Promise.resolve(controller.getForegroundProcess(ptyId))
    } catch {
      const entry: PtyForegroundProcessReadEntry = { controller, startedAfterTitleObservation: afterTitleObservation, promise: Promise.resolve(unavailable) }
      entry.promise = entry.promise.finally(() => {
        if (this.deps.ptyForegroundProcessReads.get(ptyId) === entry) {
          this.deps.ptyForegroundProcessReads.delete(ptyId)
        }
      })
      this.deps.ptyForegroundProcessReads.set(ptyId, entry)
      return entry.promise
    }
    let entry: PtyForegroundProcessReadEntry
    const promise = processRead.then((process) => ({ controller, process, available: true })).catch(() => unavailable).finally(() => {
      if (this.deps.ptyForegroundProcessReads.get(ptyId) === entry) {
        this.deps.ptyForegroundProcessReads.delete(ptyId)
      }
    })
    entry = { controller, startedAfterTitleObservation: afterTitleObservation, promise }
    this.deps.ptyForegroundProcessReads.set(ptyId, entry)
    return entry.promise
  }

  confirmPtyAgentExit = (ptyId: string): void => {
    const pty = this.deps.ptysById.get(ptyId)
    const titleObservedAt = pty?.lastOscTitleAt ?? null
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, titleObservedAt ?? 0)
    if (!pty?.connected || !foregroundRead) {
      this.deps.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      return
    }
    void foregroundRead.then((result) => {
      const current = this.deps.ptysById.get(ptyId)
      if (current !== pty || !current.connected) {
        return
      }
      if (current.lastOscTitleAt !== titleObservedAt && current.lastAgentStatus !== null) {
        return
      }
      if (result.controller === this.deps.ptyController && result.available && recognizeAgentProcess(result.process) !== null) {
        const restoredStatus = this.deps.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
        if (restoredStatus !== null && restoredStatus !== undefined) {
          current.lastAgentStatus = restoredStatus
          for (const leaf of this.deps.getLeavesForPty(ptyId)) {
            if (leaf.lastAgentStatus !== null) {
              continue
            }
            leaf.lastAgentStatus = restoredStatus
            if (restoredStatus === 'idle') {
              this.deps.deliverPendingMessagesForLeaf(leaf)
            }
          }
        }
        return
      }
      this.deps.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
    })
  }

  refreshPtyForegroundAgent = (ptyId: string): void => {
    void this.refreshPtyForegroundAgentFromController(ptyId)
  }

  getPendingForegroundAgentRefreshForTitle = (ptyId: string, titleObservedAt: number): Promise<boolean> | undefined => {
    if (!this.deps.ptyForegroundAgentRefreshes.has(ptyId)) {
      return undefined
    }
    return this.refreshPtyForegroundAgentFromController(ptyId, { afterTitleObservation: titleObservedAt })
  }

  delayPtyBackedMobileSnapshotForForegroundAgent = (ptyId: string, titleObservedAt: number, foregroundRefresh: Promise<boolean>): void => {
    this.deps.ptyDelayedForegroundSnapshotTitleObservations.set(ptyId, titleObservedAt)
    void foregroundRefresh.then((foregroundAgentChanged) => {
      if (this.deps.ptyDelayedForegroundSnapshotTitleObservations.get(ptyId) !== titleObservedAt) {
        return
      }
      this.deps.ptyDelayedForegroundSnapshotTitleObservations.delete(ptyId)
      if (this.deps.mobileSessionTabListeners.size > 0) {
        this.deps.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
      }
      if (!foregroundAgentChanged) {
        this.deps.touchMobileSessionSnapshotsForPty(ptyId)
      }
    })
  }

  refreshPtyForegroundAgentFromController = (ptyId: string, options: { afterTitleObservation?: number } = {}): Promise<boolean> => {
    const startedAfterTitleObservation = options.afterTitleObservation ?? 0
    const pendingRefresh = this.deps.ptyForegroundAgentRefreshes.get(ptyId)
    if (pendingRefresh) {
      pendingRefresh.requestedAfterTitleObservation = Math.max(pendingRefresh.requestedAfterTitleObservation, startedAfterTitleObservation)
      return pendingRefresh.promise
    }
    const entry: PtyForegroundAgentRefresh = { promise: Promise.resolve(false), startedAfterTitleObservation, requestedAfterTitleObservation: startedAfterTitleObservation }
    const refresh = (async (): Promise<boolean> => {
      while (true) {
        entry.startedAfterTitleObservation = entry.requestedAfterTitleObservation
        const foregroundAgentChanged = await this.loadPtyForegroundAgentFromController(ptyId, entry.startedAfterTitleObservation)
        if (foregroundAgentChanged || entry.requestedAfterTitleObservation <= entry.startedAfterTitleObservation) {
          return foregroundAgentChanged
        }
      }
    })().finally(() => {
      if (this.deps.ptyForegroundAgentRefreshes.get(ptyId) === entry) {
        this.deps.ptyForegroundAgentRefreshes.delete(ptyId)
      }
    })
    entry.promise = refresh
    this.deps.ptyForegroundAgentRefreshes.set(ptyId, entry)
    return refresh
  }

  loadPtyForegroundAgentFromController = async (ptyId: string, afterTitleObservation = 0): Promise<boolean> => {
    if (!this.deps.ptyController) {
      return false
    }
    const pty = this.deps.ptysById.get(ptyId)
    if (!pty?.connected) {
      return false
    }
    if (pty.launchAgent) {
      return false
    }
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, afterTitleObservation)
    if (!foregroundRead) {
      return false
    }
    const result = await foregroundRead
    if (result.controller !== this.deps.ptyController || !result.available) {
      return false
    }
    const foregroundProcess = result.process
    const foregroundAgent = foregroundProcess ? (recognizeAgentProcess(foregroundProcess)?.agent ?? null) : null
    if (pty.foregroundAgent === foregroundAgent) {
      return false
    }
    pty.foregroundAgent = foregroundAgent
    this.deps.touchMobileSessionSnapshotsForPty(ptyId)
    return true
  }
}
