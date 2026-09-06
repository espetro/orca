import type { RuntimeLeafRecord } from './runtime-leaf-record'
import type { RuntimePtyWorktreesDeps } from './runtime-pty-worktrees'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildPtyWorktreesDepsImpl(runtime: OrcaRuntimeService): RuntimePtyWorktreesDeps {
  // Bracket reads keep TS's noUnusedLocals honest about host member usage.
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    adoptTerminalOrphansFromInventory: (...args) =>
      rt['adoptTerminalOrphansFromInventory'](...args),
    agentPromptExplicitStatusFloorByPtyId: () => rt['agentPromptExplicitStatusFloorByPtyId'],
    agentPromptLifecycleByPtyId: () => rt['agentPromptLifecycleByPtyId'],
    agentPromptPermissionSequenceByPtyId: () => rt['agentPromptPermissionSequenceByPtyId'],
    agentStatusOscProcessorsByPtyId: () => rt['agentStatusOscProcessorsByPtyId'],
    assertGraphReady: (...args) => rt['assertGraphReady'](...args),
    cancelPendingDriverMutations: (...args) => rt['cancelPendingDriverMutations'](...args),
    claudeAgentTeams: () => rt['claudeAgentTeams'],
    clearAgentRowSnapshotsForPty: (...args) => rt['clearAgentRowSnapshotsForPty'](...args),
    clearWaitBlockedCheckState: (...args) => rt['clearWaitBlockedCheckState'](...args),
    dataListeners: () => rt['dataListeners'],
    disposeHeadlessTerminal: (...args) => rt['disposeHeadlessTerminal'](...args),
    disposePtyTitleTracker: () => rt['disposePtyTitleTracker'],
    earlyExitedPtyIncarnations: () => rt['earlyExitedPtyIncarnations'],
    emitTerminalAgentStatusEvents: (...args) => rt['emitTerminalAgentStatusEvents'](...args),
    ensurePtyBackedMobileSurfaceForRendererTab: (...args) =>
      rt['ensurePtyBackedMobileSurfaceForRendererTab'](...args),
    failActiveDispatchOnExit: (...args) => rt['failActiveDispatchOnExit'](...args),
    flushPendingTerminalSideEffectFacts: (...args) =>
      rt['flushPendingTerminalSideEffectFacts'](...args),
    flushWorkspaceSessionOrThrowAsync: (...args) =>
      rt['flushWorkspaceSessionOrThrowAsync'](...args),
    folderWorkspaceToResolvedWorktree: (...args) =>
      rt['folderWorkspaceToResolvedWorktree'](...args),
    freshSubscribeGuard: () => rt['freshSubscribeGuard'],
    getDriver: (...args) => rt['getDriver'](...args),
    getLeafKey: (...args) => rt['getLeafKey'](...args),
    getMobileSessionTabsForWorktree: (...args) => rt['getMobileSessionTabsForWorktree'](...args),
    getMobileTerminalPaneKey: (...args) => rt['getMobileTerminalPaneKey'](...args),
    getOrCreatePtyTitleTrackerEntry: (() => rt['getOrCreatePtyTitleTrackerEntry']) as never,
    getOrchestrationDb: (...args) => rt['getOrchestrationDb'](...args),
    getRendererTerminalSerializerGeneration: (...args) =>
      rt['getRendererTerminalSerializerGeneration'](...args),
    getWorkspaceSessionHostIdForWorktree: (...args) =>
      rt['getWorkspaceSessionHostIdForWorktree'](...args),
    graphStatus: () => rt['graphStatus'],
    graphSyncCallbacks: () => rt['graphSyncCallbacks'],
    handleByLeafKey: () => rt['handleByLeafKey'],
    handleByPtyId: () => rt['handleByPtyId'],
    handleByPtyIncarnation: () => rt['handleByPtyIncarnation'],
    handles: () => rt['handles'],
    headlessTerminals: () => rt['headlessTerminals'],
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
      rt['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](...args),
    intentionalHandlelessPtyStops: () => rt['intentionalHandlelessPtyStops'],
    isRecognizedForegroundAgentProcess: (...args) =>
      rt['isRecognizedForegroundAgentProcess'](...args),
    isRemoteDesktopResizeDriven: (...args) => rt['isRemoteDesktopResizeDriven'](...args),
    layoutQueues: () => rt['layoutQueues'],
    layouts: () => rt['layouts'],
    leaves: () => rt['leaves'],
    leavesByPtyId: () => rt['leavesByPtyId'],
    legacyWorkerRecoveredPtys: () => rt['legacyWorkerRecoveredPtys'],
    legacyWorkerTerminalRecoveryRetries: () => rt['legacyWorkerTerminalRecoveryRetries'],
    makeRuntimePaneKey: (...args) => rt['makeRuntimePaneKey'](...args),
    managedWorktrees: () => rt['managedWorktrees'],
    maybeHydrateHeadlessFromRenderer: (...args) => rt['maybeHydrateHeadlessFromRenderer'](...args),
    messageWaitersByHandle: () => rt['messageWaitersByHandle'],
    mobileSessionTabsByWorktree: () => rt['mobileSessionTabsByWorktree'],
    mobileTabSnapshots: () => rt['mobileTabSnapshots'],
    notifier: () => rt['notifier'],
    notifyMobileSessionTabsChanged: (...args) => rt['notifyMobileSessionTabsChanged'](...args),
    osc7ScanTailByPtyId: () => rt['osc7ScanTailByPtyId'],
    oscTitleScanTailByPtyId: () => rt['oscTitleScanTailByPtyId'],
    pairedRendererSessionOwnedPtyIds: () => rt['pairedRendererSessionOwnedPtyIds'],
    pathFlavorForPty: () => rt['pathFlavorForPty'],
    pendingMobileTerminalCreatesByKey: () => rt['pendingMobileTerminalCreatesByKey'],
    pendingPtyRegistrationIncarnations: () => rt['pendingPtyRegistrationIncarnations'],
    processAgentStatusOscForPty: (...args) => rt['processAgentStatusOscForPty'](...args),
    providerBufferAcquisitionsByPtyId: () => rt['providerBufferAcquisitionsByPtyId'],
    providerModeSnapshotScansByPtyId: () => rt['providerModeSnapshotScansByPtyId'],
    providerModeTrackersByPtyId: () => rt['providerModeTrackersByPtyId'],
    providerSequenceInitializedPtys: () => rt['providerSequenceInitializedPtys'],
    providerSequenceOffsetByPtyId: () => rt['providerSequenceOffsetByPtyId'],
    providerSnapshotPreferredPtys: () => rt['providerSnapshotPreferredPtys'],
    providerVisibleRetryAtByPtyId: () => rt['providerVisibleRetryAtByPtyId'],
    providerVisibleStateByPtyId: () => rt['providerVisibleStateByPtyId'],
    ptyExitListenersByPtyId: () => rt['ptyExitListenersByPtyId'],
    ptyExit_notifyTabAndMobile: (...args) => rt['ptyExit_notifyTabAndMobile'](...args),
    ptyLifecycleGenerationById: () => rt['ptyLifecycleGenerationById'],
    ptyLivenessObservationSequence: () => rt['ptyLivenessObservationSequence'],
    ptyLivenessVerdictByPtyId: () => rt['ptyLivenessVerdictByPtyId'],
    ptyOutputSequenceById: () => rt['ptyOutputSequenceById'],
    ptysById: () => rt['ptysById'],
    recentPtyOutputById: () => rt['recentPtyOutputById'],
    recentPtyPathCandidatesById: () => rt['recentPtyPathCandidatesById'],
    reconcileAgentStatusForEndedProcessFn: () => rt['reconcileAgentStatusForEndedProcessFn'],
    reconcileLegacyWorkerTerminalsNow: (...args) =>
      rt['reconcileLegacyWorkerTerminalsNow'](...args),
    recordOsc7MetadataForPty: () => rt['recordOsc7MetadataForPty'],
    recordRecentPtyOutputForPathProvenance: (...args) =>
      rt['recordRecentPtyOutputForPathProvenance'](...args),
    refreshPtyForegroundAgent: () => rt['refreshPtyForegroundAgent'],
    rendererGraphEpoch: () => rt['rendererGraphEpoch'],
    replaceHeadlessTerminalAfterExecutionContextChange: (...args) =>
      rt['replaceHeadlessTerminalAfterExecutionContextChange'](...args),
    resetTrackedTerminalStateForProviderGeneration: () =>
      rt['resetTrackedTerminalStateForProviderGeneration'],
    resolvePaneAgentIdentityField: (...args) => rt['resolvePaneAgentIdentityField'](...args),
    resolveTerminalWorkspaceLaunchScope: (...args) =>
      rt['resolveTerminalWorkspaceLaunchScope'](...args),
    resolveWorktreeSelector: (...args) => rt['resolveWorktreeSelector'](...args),
    restoreAgentPromptLifecycleByteOrder: (...args) =>
      rt['restoreAgentPromptLifecycleByteOrder'](...args),
    restoredOrchestrationAuthorityByPtyId: () => rt['restoredOrchestrationAuthorityByPtyId'],
    retireAgentHookCompatibilityAuthorityFn: () => rt['retireAgentHookCompatibilityAuthorityFn'],
    retireOrchestrationMailboxDeliveryForPty: (...args) =>
      rt['retireOrchestrationMailboxDeliveryForPty'](...args),
    runtimeId: () => rt['runtimeId'],
    scheduleWaitBlockedCheck: (...args) => rt['scheduleWaitBlockedCheck'](...args),
    setupCompletionTokenByPtyId: () => rt['setupCompletionTokenByPtyId'],
    shouldAnswerQueriesForLiveChunk: (...args) => rt['shouldAnswerQueriesForLiveChunk'](...args),
    snapshotValueComparison: () => rt['snapshotValueComparison'],
    spawnPublishedPtys: () => rt['spawnPublishedPtys'],
    stopRequestedPtyIds: () => rt['stopRequestedPtyIds'],
    store: () => rt['store'],
    subscriberDrivenProviderAttachInventoryWaiters: () =>
      rt['subscriberDrivenProviderAttachInventoryWaiters'],
    subscriberDrivenProviderAttachesByPtyId: () => rt['subscriberDrivenProviderAttachesByPtyId'],
    syntheticTerminalHandles: () => rt['syntheticTerminalHandles'],
    tabs: () => rt['tabs'],
    terminalCwdByPtyId: () => rt['terminalCwdByPtyId'],
    terminalExecutionHostField: (...args) => rt['terminalExecutionHostField'](...args),
    terminalFileUriHostnameByPtyId: () => rt['terminalFileUriHostnameByPtyId'],
    terminalSpawnCommandsByPtyId: () => rt['terminalSpawnCommandsByPtyId'],
    trackHeadlessTerminalData: (...args) => rt['trackHeadlessTerminalData'](...args),
    tryGetWorkspaceSessionHostIdForWorktree: (...args) =>
      rt['tryGetWorkspaceSessionHostIdForWorktree'](...args),
    waitersByHandle: () => rt['waitersByHandle'],
    wslDistroByPtyId: () => rt['wslDistroByPtyId'],
    reconcileLegacyWorkerTerminals: (...args) => rt['reconcileLegacyWorkerTerminals'](...args),
    nextPtyLifecycleGeneration: () => rt['nextPtyLifecycleGeneration'],
    setNextPtyLifecycleGeneration: (value) => {
      rt['nextPtyLifecycleGeneration'] = value
    },
    setPtyLivenessObservationSequence: (value) => {
      rt['ptyLivenessObservationSequence'] = value
    },
    ptyController: () => rt['ptyController'],
    livenessApi: () =>
      // Why: the verdict helpers need earlyExited/pending maps plus the
      // absence-probe caches, which now live on the facade itself.
      ({
        earlyExitedPtyIncarnations: rt['earlyExitedPtyIncarnations'],
        pendingPtyRegistrationIncarnations: rt['pendingPtyRegistrationIncarnations'],
        stopRequestedPtyIds: rt['stopRequestedPtyIds'],
        provenAbsentLeafPtyVerdicts: rt['ptyWorktrees'].provenAbsentLeafPtyVerdicts,
        leafPtyAbsenceProbes: rt['ptyWorktrees'].leafPtyAbsenceProbes,
        ptyController: rt['ptyController']
          ? {
              probePtyLiveness: async (ptyId) =>
                Boolean(await rt['ptyController']?.probePtyLiveness?.(ptyId))
            }
          : undefined,
        controllerKnowsPtyIsLive: (ptyId) => rt['controllerKnowsPtyIsLive'](ptyId),
        forgetPtyLivenessVerdict: (ptyId, observedNoLaterThan) =>
          rt['forgetPtyLivenessVerdict'](ptyId, observedNoLaterThan),
        getOrCreatePtyWorktreeRecord: (ptyId) => rt['getOrCreatePtyWorktreeRecord'](ptyId),
        getLeavesForPty: (ptyId) => rt['getLeavesForPty'](ptyId),
        adoptPreAllocatedHandle: (leaf) => rt['adoptPreAllocatedHandle'](leaf as RuntimeLeafRecord),
        recordPtyWorktree: (ptyId, worktreeId, opts) =>
          rt['recordPtyWorktree'](ptyId, worktreeId, opts),
        ensurePtyBackedMobileSurfaceForRendererTab: (worktreeId, tabId) =>
          rt['ensurePtyBackedMobileSurfaceForRendererTab'](worktreeId, tabId),
        graphStatus: rt['graphStatus'],
        spawnPublishedPtys: rt['spawnPublishedPtys'],
        pendingMobileTerminalCreatesByKey: rt['pendingMobileTerminalCreatesByKey'] as never,
        ptysById: rt['ptysById'],
        handleByPtyId: rt['handleByPtyId'],
        leafExistsForPty: (ptyId) => rt['leafExistsForPty'](ptyId)
      }),
    setPtyControllerRef: (controller) => {
      rt['ptyController'] = controller
    }
  }
}
