import type { RuntimeTerminalClusterDeps } from './runtime-terminal-cluster-facade'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildTerminalClusterFacadeDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeTerminalClusterDeps {
  // Bracket reads keep TS's noUnusedLocals honest about host member usage.
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    resolveTerminalWorkspaceLaunchScopeHook: (selector) =>
      rt['resolveTerminalWorkspaceLaunchScope'](selector),
    ptyWorktrees: () => rt['ptyWorktrees'],
    recentPtyOutputById: () => rt['recentPtyOutputById'],
    recentPtyPathCandidatesById: () => rt['recentPtyPathCandidatesById'],
    leaves: () => rt['leaves'],
    mobileSessionTabsByWorktree: () => rt['mobileSessionTabsByWorktree'],
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
      rt['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](...args),
    notifyMobileSessionTabsChanged: (...args) => rt['notifyMobileSessionTabsChanged'](...args),
    layouts: () => rt['layouts'],
    isFreshSubscribe: (...args) => rt['isFreshSubscribe'](...args),
    terminalFitOverrides: () => rt['terminalFitOverrides'],
    mobileSubscribers: () => rt['mobileSubscribers'],
    pickEarliestRestoreTarget: (...args) => rt['pickEarliestRestoreTarget'](...args),
    lastRendererSizes: () => rt['lastRendererSizes'],
    suppressResizesForMs: (...args) => rt['suppressResizesForMs'](...args),
    mobileSessionFacade: () => rt['mobileSessionFacade'],
    activeRemoteDesktopViewport: (...args) => rt['activeRemoteDesktopViewport'](...args),
    remoteDesktopViewerRevisions: () => rt['remoteDesktopViewerRevisions'],
    remoteDesktopOwners: () => rt['remoteDesktopOwners'],
    resolveRemoteDesktopHostReclaimTarget: (...args) =>
      rt['resolveRemoteDesktopHostReclaimTarget'](...args),
    freshSubscribeGuard: () => rt['freshSubscribeGuard'],
    remoteDesktopHostReclaimTargets: () => rt['remoteDesktopHostReclaimTargets'],
    graphStatus: () => rt['graphStatus'],
    rendererGraphEpoch: () => rt['rendererGraphEpoch'],
    mobileTabSnapshots: () => rt['mobileTabSnapshots'],
    resolvedWorktreeCache: () => rt['resolvedWorktreeCache'],
    listKnownExecutionHostIds: (...args) => rt['listKnownExecutionHostIds'](...args),
    tryGetWorkspaceSessionHostIdForWorktree: (...args) =>
      rt['tryGetWorkspaceSessionHostIdForWorktree'](...args),
    tabs: () => rt['tabs'],
    terminalExecutionHostField: (...args) => rt['terminalExecutionHostField'](...args),
    resolvePaneAgentIdentityField: (...args) => rt['resolvePaneAgentIdentityField'](...args),
    pendingRestoreTimers: () => rt['pendingRestoreTimers'],
    pendingSoftLeavers: () => rt['pendingSoftLeavers'],
    providerModeSnapshotScansByPtyId: () => rt['providerModeSnapshotScansByPtyId'],
    providerModeTrackersByPtyId: () => rt['providerModeTrackersByPtyId'],
    providerSequenceOffsetByPtyId: () => rt['providerSequenceOffsetByPtyId'],
    preferTrackedLastTitle: () => rt['preferTrackedLastTitle'],
    providerSnapshotsWithLiveModeTransition: () => rt['providerSnapshotsWithLiveModeTransition'],
    headlessTerminals: () => rt['headlessTerminals'],
    closeMobileSessionTab: (...args) => rt['closeMobileSessionTab'](...args),
    clientEventPublishingCommands: () => rt['clientEventPublishingCommands'],
    getAvailableAuthoritativeWindow: (...args) => rt['getAvailableAuthoritativeWindow'](...args),
    assertPtyDidNotExitBeforeRegistration: (...args) =>
      rt['assertPtyDidNotExitBeforeRegistration'](...args),
    releaseRejectedPtyRegistrationFence: (...args) =>
      rt['releaseRejectedPtyRegistrationFence'](...args),
    registerPreAllocatedHandleForPty: (...args) => rt['registerPreAllocatedHandleForPty'](...args),
    preparePtyExecutionContext: (...args) => rt['preparePtyExecutionContext'](...args),
    registerPty: (...args) => rt['registerPty'](...args),
    issuePtyHandle: (...args) => rt['issuePtyHandle'](...args),
    handles: () => rt['handles'],
    terminalCreateIdempotency: () => rt['terminalCreateIdempotency'],
    getPtyLivenessVerdict: (...args) => rt['getPtyLivenessVerdict'](...args),
    headlessHydrationState: () => rt['headlessHydrationState'],
    terminalSideEffectConsumerAvailable: () => rt['terminalSideEffectConsumerAvailable'],
    ptyOutputSequenceById: () => rt['ptyOutputSequenceById'],
    terminalSideEffectLocalConsumerAvailable: () => rt['terminalSideEffectLocalConsumerAvailable'],
    layoutQueues: () => rt['layoutQueues'],
    coalescesWith: (...args) => rt['coalescesWith'](...args),
    subscriberDrivenProviderAttachesByPtyId: () => rt['subscriberDrivenProviderAttachesByPtyId'],
    isKnownUnattachedLocalDaemonPty: (...args) => rt['isKnownUnattachedLocalDaemonPty'](...args),
    terminalFocusNavigationCoalescer: () => rt['terminalFocusNavigationCoalescer'],
    currentDriver: () => rt['currentDriver'],
    latestAgentStatusByPaneKey: () => rt['latestAgentStatusByPaneKey'],
    orchestrationCommands: () => rt['orchestrationCommands'],
    hookAgentRowResolutionCommands: () => rt['hookAgentRowResolutionCommands'],
    agentPromptLifecycleByPtyId: () => rt['agentPromptLifecycleByPtyId'],
    ptyTitleTrackersByPtyId: () => rt['ptyTitleTrackersByPtyId'],
    terminalTopologyRevisionByRepoId: () => rt['terminalTopologyRevisionByRepoId'],
    managedWorktrees: () => rt['managedWorktrees'],
    rawTerminalViewSubscriberCounts: () => rt['rawTerminalViewSubscriberCounts'],
    remoteTerminalViewSubscriberCounts: () => rt['remoteTerminalViewSubscriberCounts'],
    providerSnapshotPreferredPtys: () => rt['providerSnapshotPreferredPtys'],
    getPrimaryLeafForPty: (...args) => rt['getPrimaryLeafForPty'](...args),
    isPtyRunningAgent: (...args) => rt['ptyWorktrees'].isPtyRunningAgent(...args),
    isRecognizedForegroundAgentProcess: (...args) =>
      rt['isRecognizedForegroundAgentProcess'](...args),
    markRemoteWorkspaceTrustedForAgent: (...args) =>
      rt['markRemoteWorkspaceTrustedForAgent'](...args),
    markLocalWorkspaceTrustedForAgent: (...args) =>
      rt['markLocalWorkspaceTrustedForAgent'](...args),
    terminalSpawnCommandsByPtyId: () => rt['terminalSpawnCommandsByPtyId'],
    fitOverrideListeners: () => rt['fitOverrideListeners'],
    resizeListeners: () => rt['resizeListeners'],
    waitBlockedCheckStateByPtyId: () => rt['waitBlockedCheckStateByPtyId'],
    agentStatusOscProcessorsByPtyId: () => rt['agentStatusOscProcessorsByPtyId'],
    providerVisibleStateByPtyId: () => rt['providerVisibleStateByPtyId'],
    providerVisibleRetryAtByPtyId: () => rt['providerVisibleRetryAtByPtyId'],
    reconcileLegacyWorkerTerminalsNow: (...args) =>
      rt['reconcileLegacyWorkerTerminalsNow'](...args),
    recordPtyWorktree: (...args) => rt['recordPtyWorktree'](...args),
    recordAgentPromptPermissionObservation: (...args) =>
      rt['recordAgentPromptPermissionObservation'](...args),
    terminalPaneRecoveryByIdentity: () => rt['terminalPaneRecoveryByIdentity'],
    terminalCwdByPtyId: () => rt['terminalCwdByPtyId'],
    waitersByHandle: () => rt['waitersByHandle'],
    folderWorkspaceToResolvedWorktree: (...args) =>
      rt['folderWorkspaceToResolvedWorktree'](...args),
    agentPromptSubmissionTailByPtyId: () => rt['agentPromptSubmissionTailByPtyId'],
    providerBufferAcquisitionsByPtyId: () => rt['providerBufferAcquisitionsByPtyId'],
    driverListeners: () => rt['driverListeners'],
    setPairedRendererSessionOwnership: (...args) =>
      rt['setPairedRendererSessionOwnership'](...args),
    pairedRendererSessionOwnedPtyIds: () => rt['pairedRendererSessionOwnedPtyIds'],
    dataListeners: () => rt['dataListeners'],
    messageWaitersByHandle: () => rt['messageWaitersByHandle'],
    graphSyncCallbacks: () => rt['graphSyncCallbacks'],
    setupCompletionTokenByPtyId: () => rt['setupCompletionTokenByPtyId'],
    getPtyWriteHostPlatform: (...args) => rt['getPtyWriteHostPlatform'](...args),
    getAgentPromptActivity: (...args) => rt['getAgentPromptActivity'](...args),
    assertAgentPromptPermissionSafe: (...args) =>
      rt['agentClusterFacade'].assertAgentPromptPermissionSafe(...args),
    createAgentPromptRenderGate: (...args) =>
      rt['agentClusterFacade'].createAgentPromptRenderGate(...args),
    getPtyAgent: (...args) => rt['getPtyAgent'](...args),
    store: () => rt['store'],
    ptyController: () => rt['ptyController'],
    notifier: () => rt['notifier'],
    ptysById: () => rt['ptysById'],
    handleByPtyId: () => rt['handleByPtyId'],
    claudeAgentTeams: () => rt['claudeAgentTeams'],
    terminalAgentStatusBinding: () => rt['terminalAgentStatusBinding'],
    onTerminalAgentStatus: () => rt['onTerminalAgentStatus'],
    onTerminalSideEffects: () => rt['onTerminalSideEffects'],
    getAgentStatusSnapshotFn: () => rt['getAgentStatusSnapshotFn'],
    buildAgentHookPtyEnv: () => rt['buildAgentHookPtyEnv'],
    onRemoteTerminalViewPresenceChanged: () => rt['onRemoteTerminalViewPresenceChanged'],
    snapshotValueComparison: () => rt['snapshotValueComparison'],
    getAgentLaunchPlatformForRepo: (repo) => rt['getAgentLaunchPlatformForRepo'](repo),
    getAgentLaunchPlatformForWorkspace: (scope) => rt['getAgentLaunchPlatformForWorkspace'](scope),
    getOrCreatePtyTitleTrackerEntry: (...args) => rt['getOrCreatePtyTitleTrackerEntry'](...args),
    getTrackedRawTitleForPty: (...args) => rt['getTrackedRawTitleForPty'](...args),
    recordOsc7MetadataForPty: (...args) => rt['recordOsc7MetadataForPty'](...args),
    cloneTerminalLayoutSnapshot: (...args) => rt['cloneTerminalLayoutSnapshot'](...args),
    collectPersistedTerminalLeafIds: (layout) =>
      rt['mobileTabSnapshots'].collectPersistedTerminalLeafIds(layout),
    getTerminalAgentStatusPtyId: (...args) => rt['getTerminalAgentStatusPtyId'](...args),
    assertTerminalAgentStatusPtyBinding: (...args) =>
      rt['assertTerminalAgentStatusPtyBinding'](...args),
    getTerminalAgentStatusSnapshot: (...args) => rt['getTerminalAgentStatusSnapshot'](...args),
    hasAuthoritativeTerminalWaitPermission: (...args) =>
      rt['hasAuthoritativeTerminalWaitPermission'](...args)
  }
}
