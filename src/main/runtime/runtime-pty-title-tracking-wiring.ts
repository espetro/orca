import type { RuntimePtyTitleTrackingCommandsDeps } from './runtime-pty-title-tracking-commands-deps'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildPtyTitleTrackingCommandsDepsImpl(
  runtime: OrcaRuntimeService
): RuntimePtyTitleTrackingCommandsDeps {
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    ptyTitleTrackersByPtyId: rt['ptyTitleTrackersByPtyId'],
    ptysById: rt['ptysById'],
    mobileSessionTabListeners: rt['mobileSessionTabListeners'],
    ptyDelayedForegroundSnapshotTitleObservations: rt[
      'ptyDelayedForegroundSnapshotTitleObservations'
    ] as never,
    mobileSessionTabsAgentStatusHeartbeat: rt['mobileSessionTabsAgentStatusHeartbeat'],
    terminalSideEffectConsumerAvailable: rt['terminalSideEffectConsumerAvailable'],
    terminalSideEffectLocalConsumerAvailable: rt['terminalSideEffectLocalConsumerAvailable'],
    onTerminalSideEffects: rt['onTerminalSideEffects'] as never,
    terminalSpawnCommandsByPtyId: rt['terminalSpawnCommandsByPtyId'],
    oscTitleScanTailByPtyId: rt['oscTitleScanTailByPtyId'] as never,
    osc7ScanTailByPtyId: rt['osc7ScanTailByPtyId'],
    agentStatusOscProcessorsByPtyId: rt['agentStatusOscProcessorsByPtyId'] as never,
    agentPromptLifecycleByPtyId: rt['agentPromptLifecycleByPtyId'],
    agentPromptPermissionSequenceByPtyId: rt['agentPromptPermissionSequenceByPtyId'],
    terminalSideEffectTitleGateKeysByClientEventListener: rt[
      'terminalSideEffectTitleGateKeysByClientEventListener'
    ] as never,
    wslDistroByPtyId: rt['wslDistroByPtyId'],
    terminalCwdByPtyId: rt['terminalCwdByPtyId'],
    terminalFileUriHostnameByPtyId: rt['terminalFileUriHostnameByPtyId'],
    getLeavesForPty: (ptyId) => rt['getLeavesForPty'](ptyId),
    recordTerminalSideEffectFact: (ptyId, fact) => rt['recordTerminalSideEffectFact'](ptyId, fact),
    touchMobileSessionSnapshotsForPty: (ptyId) => rt['touchMobileSessionSnapshotsForPty'](ptyId),
    confirmPtyAgentExit: (ptyId) => rt['terminalAgentStatusBinding'].confirmPtyAgentExit(ptyId),
    retirePtyAgentLaunchAuthority: (ptyId) => rt['retirePtyAgentLaunchAuthority'](ptyId),
    recordAgentPromptLifecycleState: (ptyId, agentStatus) =>
      rt['recordAgentPromptLifecycleState'](ptyId, agentStatus),
    nextTitleObservationSequence: () => rt['nextTitleObservationSequence'](),
    setPtyManagementTitleFromObservedTitle: (pty, normalizedTitle, observedAt) =>
      rt['setPtyManagementTitleFromObservedTitle'](pty, normalizedTitle, observedAt),
    shouldDelayPtyBackedMobileSnapshotForForegroundAgent: (pty, normalizedTitle) =>
      rt['terminalAgentStatusBinding'].shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
        pty,
        normalizedTitle
      ),
    refreshPtyForegroundAgentFromController: (ptyId, opts) =>
      rt['terminalAgentStatusBinding'].refreshPtyForegroundAgentFromController(ptyId, opts),
    getPendingForegroundAgentRefreshForTitle: (ptyId, observedAt) =>
      rt['terminalAgentStatusBinding'].getPendingForegroundAgentRefreshForTitle(ptyId, observedAt),
    delayPtyBackedMobileSnapshotForForegroundAgent: (ptyId, observedAt, foregroundRefresh) =>
      rt['terminalAgentStatusBinding'].delayPtyBackedMobileSnapshotForForegroundAgent(
        ptyId,
        observedAt,
        foregroundRefresh
      ),
    resolvePtyTuiIdleWaiters: (pty, ptyId) => rt['resolvePtyTuiIdleWaiters'](pty, ptyId),
    resolveTuiIdleWaiters: (leaf) => rt['resolveTuiIdleWaiters'](leaf),
    deliverPendingMessagesForLeaf: (leaf) => rt['deliverPendingMessagesForLeaf'](leaf),
    countTerminalSideEffectConsumingClientEventListeners: () =>
      rt['countTerminalSideEffectConsumingClientEventListeners'](),
    clearWaitBlockedCheckState: (ptyId) => rt['clearWaitBlockedCheckState'](ptyId),
    primeWaitBlockedBaselineFromSeededTail: (ptyId) =>
      rt['primeWaitBlockedBaselineFromSeededTail'](ptyId),
    clearAgentRowSnapshotsForPty: (ptyId) => rt['clearAgentRowSnapshotsForPty'](ptyId)
  }
}
