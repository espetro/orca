import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { SSH_EXIT_UNCONFIRMED_REASON } from '../../shared/pty-liveness-verdict'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  OPERATOR_CLOSE_EXIT_CAUSE,
  resolveUnreportedExitCause
} from '../../shared/terminal-exit-cause'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import { DISCONNECTED_PTY_RECORD_MAX, notifyRuntimeListeners } from './runtime-tail-projection'
import type { RuntimePtyWorktrees, RuntimePtyWorktreesDeps } from './runtime-pty-worktrees'
type RuntimePtyRecord = OrcaRuntimeService['ptysById'] extends Map<string, infer T> ? T : never
import type { OrcaRuntimeService } from './orca-runtime'

export class RuntimePtyExitPipeline {
  constructor(
    private readonly host: RuntimePtyWorktrees,
    private readonly deps: RuntimePtyWorktreesDeps
  ) {}

  onPtyExit(
    ptyId: string,
    exitCode: number,
    exitIncarnationId?: PtyIncarnationId,
    options?: {
      hostExitConfirmed?: boolean
      cause?: TerminalExitCause
      providerExitObserved?: boolean
    }
  ): void {
    const pty = this.ptyExit_guardIncarnation(ptyId, exitIncarnationId)
    if (!pty) {
      return
    }

    const { exitCause } = this.ptyExit_resolveExitCause(ptyId, exitCode, options?.cause)

    const { preservesAbnormalSshSurface, preservesIntentionalHandlessSurface, incarnationId } =
      this.ptyExit_decideSshSurface(pty, ptyId, exitCode, options)

    this.ptyExit_collectExitPaneKeys(pty, ptyId, exitCode, options, preservesAbnormalSshSurface)

    this.ptyExit_updateLivenessVerdict(ptyId, preservesAbnormalSshSurface)

    const exactSurfaces = this.ptyExit_cleanupLeaves(pty, ptyId)

    const exitedSurfaces = this.deps.ptyExit_notifyTabAndMobile(
      pty,
      ptyId,
      exitIncarnationId,
      exitCode,
      exitCause,
      preservesAbnormalSshSurface,
      preservesIntentionalHandlessSurface,
      exactSurfaces,
      incarnationId
    )

    this.ptyExit_releaseLayout(ptyId)

    this.ptyExit_settleDispatch(
      ptyId,
      exitCode,
      exitCause,
      preservesAbnormalSshSurface,
      exitedSurfaces
    )

    this.ptyExit_teardown(ptyId)
  }

  ptyExit_cleanupLeaves(
    pty: RuntimePtyRecord | null,
    ptyId: string
  ): Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[] {
    this.host.advancePtyLifecycleGeneration(ptyId)
    this.notifyPtyExitListeners(ptyId)

    const exactSurfaceByKey = new Map<
      string,
      Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>
    >()

    for (const leaf of this.host.getLeavesForPty(ptyId)) {
      exactSurfaceByKey.set(`${leaf.worktreeId}\0${leaf.tabId}\0${leaf.leafId}`, {
        worktreeId: leaf.worktreeId,
        parentTabId: leaf.tabId,
        leafId: leaf.leafId
      })
    }

    const parsedPaneKey = parsePaneKey(pty?.paneKey ?? '')
    if (pty?.tabId && parsedPaneKey) {
      exactSurfaceByKey.set(`${pty.worktreeId}\0${pty.tabId}\0${parsedPaneKey.leafId}`, {
        worktreeId: pty.worktreeId,
        parentTabId: pty.tabId,
        leafId: parsedPaneKey.leafId
      })
    }

    return [...exactSurfaceByKey.values()]
  }

  ptyExit_collectExitPaneKeys(
    _pty: RuntimePtyRecord | null,
    ptyId: string,
    exitCode: number,
    options?: { hostExitConfirmed?: boolean; providerExitObserved?: boolean },
    preservesAbnormalSshSurface?: boolean
  ): void {
    const exitPaneKeys = this.collectPaneKeysForPty(ptyId)

    if (preservesAbnormalSshSurface) {
      this.deps.restoredOrchestrationAuthorityByPtyId().delete(ptyId)
    } else {
      this.host.retirePtyAgentLaunchAuthority(ptyId)
    }

    const processDeathCertified =
      exitCode >= 0 || options?.hostExitConfirmed === true || options?.providerExitObserved === true

    if (processDeathCertified && exitPaneKeys.size > 0) {
      this.deps.reconcileAgentStatusForEndedProcessFn()?.(exitPaneKeys)
    }
  }

  ptyExit_decideSshSurface(
    pty: RuntimePtyRecord | null,
    ptyId: string,
    exitCode: number,
    options?: { hostExitConfirmed?: boolean }
  ): {
    preservesAbnormalSshSurface: boolean
    preservesIntentionalHandlessSurface: boolean
    incarnationId: PtyIncarnationId
  } {
    const preservesAbnormalSshSurface =
      this.host.isSshOwnedPtyId(ptyId) &&
      pty?.connectionId != null &&
      exitCode < 0 &&
      options?.hostExitConfirmed !== true

    const incarnationId =
      (pty?.incarnationId as PtyIncarnationId) ??
      (`runtime:${this.deps.runtimeId()}:${this.host.getPtyLifecycleGeneration(ptyId)}` as PtyIncarnationId)

    const intentionalStopIncarnation = this.deps.intentionalHandlelessPtyStops().get(ptyId)
    const preservesIntentionalHandlessSurface =
      this.deps.intentionalHandlelessPtyStops().has(ptyId) &&
      (intentionalStopIncarnation === null || intentionalStopIncarnation === incarnationId)

    return {
      preservesAbnormalSshSurface,
      preservesIntentionalHandlessSurface,
      incarnationId
    }
  }

  ptyExit_guardIncarnation(
    ptyId: string,
    exitIncarnationId?: PtyIncarnationId
  ): RuntimePtyRecord | null {
    const pty = this.deps.ptysById().get(ptyId)
    if (exitIncarnationId && pty?.incarnationId && exitIncarnationId !== pty.incarnationId) {
      return null
    }
    return pty ?? null
  }

  ptyExit_releaseLayout(ptyId: string): void {
    this.deps.layouts().delete(ptyId)
    this.deps.layoutQueues().delete(ptyId)
    this.deps.freshSubscribeGuard().delete(ptyId)
    this.deps.cancelPendingDriverMutations(ptyId)
    this.deps.retireOrchestrationMailboxDeliveryForPty(ptyId)
  }

  ptyExit_resolveExitCause(
    ptyId: string,
    exitCode: number,
    cause?: TerminalExitCause
  ): { exitCause: TerminalExitCause; stopNeverConfirmed: boolean } {
    const observedCause = cause ?? resolveUnreportedExitCause(exitCode)
    const stopNeverConfirmed =
      observedCause.kind === 'unknown' && observedCause.reason === 'stop_unverified'
    const exitCause: TerminalExitCause =
      this.deps.stopRequestedPtyIds().has(ptyId) && !stopNeverConfirmed
        ? OPERATOR_CLOSE_EXIT_CAUSE
        : observedCause
    this.deps.stopRequestedPtyIds().delete(ptyId)
    return { exitCause, stopNeverConfirmed }
  }

  ptyExit_settleDispatch(
    _ptyId: string,
    exitCode: number,
    exitCause: TerminalExitCause,
    preservesAbnormalSshSurface: boolean,
    exitedSurfaces: { handle: string; paneKey: string | null }[]
  ): void {
    if (preservesAbnormalSshSurface) {
      return
    }

    for (const surface of exitedSurfaces) {
      this.deps.failActiveDispatchOnExit(surface.handle, surface.paneKey, exitCode, exitCause)
    }
  }

  ptyExit_teardown(_ptyId: string): void {
    this.pruneDisconnectedPtyRecords()
  }

  ptyExit_updateLivenessVerdict(ptyId: string, preservesAbnormalSshSurface: boolean): void {
    if (preservesAbnormalSshSurface) {
      if (this.host.getPtyLivenessVerdict(ptyId)?.status !== 'unverifiable') {
        this.host.markPtyLivenessUnverifiable(ptyId, SSH_EXIT_UNCONFIRMED_REASON)
      }
    }
  }

  notifyPtyExitListeners(ptyId: string): void {
    const listeners = this.deps.ptyExitListenersByPtyId().get(ptyId)
    if (!listeners) {
      return
    }
    this.deps.ptyExitListenersByPtyId().delete(ptyId)
    notifyRuntimeListeners(listeners, (listener) => listener(), 'pty-exit')
  }

  collectPaneKeysForPty(ptyId: string): Set<string> {
    const paneKeys = new Set<string>()
    const pty = this.deps.ptysById().get(ptyId)
    if (pty?.paneKey && parsePaneKey(pty.paneKey)) {
      paneKeys.add(pty.paneKey)
    }
    const receipt = this.deps.restoredOrchestrationAuthorityByPtyId().get(ptyId)
    if (receipt?.paneKey && parsePaneKey(receipt.paneKey)) {
      paneKeys.add(receipt.paneKey)
    }
    for (const leaf of this.host.getLeavesForPty(ptyId)) {
      if (isValidTerminalTabId(leaf.tabId) && isTerminalLeafId(leaf.leafId)) {
        paneKeys.add(makePaneKey(leaf.tabId, leaf.leafId))
      }
    }
    return paneKeys
  }

  pruneDisconnectedPtyRecords(): void {
    const retained = [...this.deps.ptysById().values()]
      .filter((pty) => !pty.connected && !this.host.leafExistsForPty(pty.ptyId))
      .sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0))
    const staleCount = Math.max(0, retained.length - DISCONNECTED_PTY_RECORD_MAX)
    for (const stale of retained.slice(0, staleCount)) {
      // Why: exited runtime-owned PTYs stay readable, but long-lived runtimes churn through many sessions; bound the archive.
      this.host.dropDisconnectedPtyRecord(stale.ptyId)
    }
  }
}
