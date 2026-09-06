import type { RuntimeMobileSessionFacadeDeps } from './runtime-mobile-session-facade'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildMobileSessionFacadeDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeMobileSessionFacadeDeps {
  // Bracket reads keep TS's noUnusedLocals honest about host member usage.
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    acceptedRendererMobileSnapshotByWorktree: () => rt['acceptedRendererMobileSnapshotByWorktree'],
    accountCommands: () => rt['accountCommands'],
    agentPromptExplicitStatusFloorByPtyId: () => rt['agentPromptExplicitStatusFloorByPtyId'],
    agentStatusOscProcessorsByPtyId: () => rt['agentStatusOscProcessorsByPtyId'],
    applyHeadlessSessionTabPropsToSnapshot: () => rt['applyHeadlessSessionTabPropsToSnapshot'],
    applyHeadlessTerminalPaneLayoutToSnapshot: () =>
      rt['applyHeadlessTerminalPaneLayoutToSnapshot'],
    applyMobileSessionRetirementFences: (...args) =>
      rt['applyMobileSessionRetirementFences'](...args),
    applyNativeChatLaunchDraftResolutionFence: (...args) =>
      rt['applyNativeChatLaunchDraftResolutionFence'](...args),
    applyRemoteDesktopLayout: (...args) => rt['applyRemoteDesktopLayout'](...args),
    assertSessionTabsInventoryRequestActive: (...args) =>
      rt['assertSessionTabsInventoryRequestActive'](...args),
    assertStableReadyGraph: (...args) => rt['assertStableReadyGraph'](...args),
    authoritativeWindowId: () => rt['authoritativeWindowId'],
    buildMaterializedHeadlessParentLayout: (...args: unknown[]) =>
      rt['terminalClusterFacade'].buildMaterializedHeadlessParentLayout(...args),
    cancelAllPendingFitRestoreTimers: (...args) => rt['cancelAllPendingFitRestoreTimers'](...args),
    captureReadyGraphEpoch: (...args) => rt['captureReadyGraphEpoch'](...args),
    claudeAgentTeams: () => rt['claudeAgentTeams'],
    clearWaitBlockedCheckState: (...args) => rt['clearWaitBlockedCheckState'](...args),
    clientEventPublishingCommands: () => rt['clientEventPublishingCommands'],
    clientSessionTabSelections: () => rt['clientSessionTabSelections'],
    collectReturnedSessionTabIds: (...args) => rt['collectReturnedSessionTabIds'](...args),
    createTerminal: (...args) => rt['createTerminal'](...args),
    currentDriver: () => rt['currentDriver'],
    delayPtyBackedMobileSnapshotForForegroundAgent: () =>
      rt['delayPtyBackedMobileSnapshotForForegroundAgent'],
    deliverPendingStartupCommandToBareRendererPty: (...args) =>
      rt['deliverPendingStartupCommandToBareRendererPty'](...args),
    detachedPreAllocatedLeaves: () => rt['detachedPreAllocatedLeaves'],
    disposeHeadlessTerminal: (...args) => rt['disposeHeadlessTerminal'](...args),
    disposePtyTitleTracker: () => rt['disposePtyTitleTracker'],
    earlyExitedPtyIncarnations: () => rt['earlyExitedPtyIncarnations'],
    enqueueLayout: (...args) => rt['enqueueLayout'](...args),
    findHandleForPtyRecord: (...args) => rt['findHandleForPtyRecord'](...args),
    findLiveRegisteredPtyForRendererTab: (...args) =>
      rt['findLiveRegisteredPtyForRendererTab'](...args),
    forgetPtyLivenessVerdict: (...args) => rt['forgetPtyLivenessVerdict'](...args),
    freshSubscribeGuard: () => rt['freshSubscribeGuard'],
    getAgentLaunchPlatformForWorkspace: (scope) => rt['getAgentLaunchPlatformForWorkspace'](scope),
    getAgentProviderSessionRowsForPaneFn: () => rt['getAgentProviderSessionRowsForPaneFn'],
    getAgentProviderSessionSnapshotFn: () => rt['getAgentProviderSessionSnapshotFn'],
    getAgentStatusSnapshotFn: () => rt['getAgentStatusSnapshotFn'],
    getAuthoritativeSessionTabsInventoryEpoch: (...args) =>
      rt['getAuthoritativeSessionTabsInventoryEpoch'](...args),
    getAutoRestoreFitMs: (...args) => rt['getAutoRestoreFitMs'](...args),
    getAvailableAuthoritativeWindow: (...args) => rt['getAvailableAuthoritativeWindow'](...args),
    getDriver: (...args) => rt['getDriver'](...args),
    getHookAgentRowForPane: (...args) => rt['getHookAgentRowForPane'](...args),
    getKnownWorkspaceSessionWorktreeIds: (...args) =>
      rt['getKnownWorkspaceSessionWorktreeIds'](...args),
    getLeafKey: (...args) => rt['getLeafKey'](...args),
    getLeavesForPty: (...args) => rt['getLeavesForPty'](...args),
    getLiveBrowserTabsByPageId: (...args) => rt['getLiveBrowserTabsByPageId'](...args),
    getLivePtyForHandle: (...args) => rt['getLivePtyForHandle'](...args),
    getMobileSessionTopLevelTabId: () => rt['getMobileSessionTopLevelTabId'],
    getTerminalSize: (...args) => rt['getTerminalSize'](...args),
    getUnpersistedTrackedTitleForPty: () => rt['getUnpersistedTrackedTitleForPty'],
    getValidatedExplicitWorktreeIdSelector: (...args) =>
      rt['getValidatedExplicitWorktreeIdSelector'](...args),
    getWorkspaceSessionHydrationTargets: (...args) =>
      rt['getWorkspaceSessionHydrationTargets'](...args),
    graphStatus: () => rt['graphStatus'],
    graphSyncCallbacks: () => rt['graphSyncCallbacks'],
    handleByLeafKey: () => rt['handleByLeafKey'],
    handleByPtyId: () => rt['handleByPtyId'],
    hasLiveShellForRendererTab: (...args) => rt['hasLiveShellForRendererTab'](...args),
    hasRemoteDesktopLayoutState: (...args) => rt['hasRemoteDesktopLayoutState'](...args),
    hasRemoteDesktopViewers: (...args) => rt['hasRemoteDesktopViewers'](...args),
    hasServeOrSshOwnedBinding: (...args: unknown[]) =>
      (rt['hasServeOrSshOwnedBinding'] as (...a: unknown[]) => unknown)(...args),
    headlessHydrationState: () => rt['headlessHydrationState'],
    headlessSessionTabPersistenceCommands: () => rt['headlessSessionTabPersistenceCommands'],
    headlessTerminals: () => rt['headlessTerminals'],
    hookAgentRowResolutionCommands: () => rt['hookAgentRowResolutionCommands'],
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
      rt['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](...args),
    isDeliberatelyParkedPane: (...args) => rt['isDeliberatelyParkedPane'](...args),
    isHeadlessBuiltMobileSessionPublicationBase: (publicationEpoch) =>
      rt['isHeadlessBuiltMobileSessionPublicationBase'](publicationEpoch),
    isHeadlessMobileSessionPublication: (publicationEpoch) =>
      rt['isHeadlessMobileSessionPublication'](publicationEpoch),
    isKnownUnattachedLocalDaemonPty: (...args) => rt['isKnownUnattachedLocalDaemonPty'](...args),
    isMobileSessionSurfaceMembershipAllowed: (...args: any[]) =>
      (rt['isMobileSessionSurfaceMembershipAllowed'] as (...a: any[]) => any)(...args),
    isTerminalAlternateScreen: (...args: any[]) =>
      (rt['isTerminalAlternateScreen'] as (...a: any[]) => any)(...args),
    issuePtyHandle: (...args) => rt['issuePtyHandle'](...args),
    lastRendererSizes: () => rt['lastRendererSizes'],
    latestAgentStatusByPaneKey: () => rt['latestAgentStatusByPaneKey'],
    layouts: () => rt['layouts'],
    leaves: () => rt['leaves'],
    legacyWorkerRecoveredPtys: () => rt['legacyWorkerRecoveredPtys'],
    listMobileFiles: () => rt['listMobileFiles'],
    listResolvedWorktrees: (...args) => rt['listResolvedWorktrees'](...args),
    listRuntimeMarkdownDocuments: () => rt['listRuntimeMarkdownDocuments'],
    managedWorktrees: () => rt['managedWorktrees'],
    markWorkspaceTrustedForAgent: (...args) => rt['markWorkspaceTrustedForAgent'](...args),
    mobileNotificationReplay: () => rt['mobileNotificationReplay'],
    mobileSessionTabListeners: () => rt['mobileSessionTabListeners'],
    mobileSessionTabsAgentStatusHeartbeat: () => rt['mobileSessionTabsAgentStatusHeartbeat'],
    mobileSessionTabsByWorktree: () => rt['mobileSessionTabsByWorktree'],
    nextMobileSessionTabsChangeSequence: () => {
      const v = rt['mobileSessionTabsChangeSequence'] + 1
      rt['mobileSessionTabsChangeSequence'] = v
      return v
    },
    mobileSnapshotMerge: () => rt['mobileSnapshotMerge'],
    mobileSubscribers: () => rt['mobileSubscribers'],
    mobileTabSnapshots: () => rt['mobileTabSnapshots'],
    notificationListeners: () => rt['notificationListeners'],
    notifier: () => rt['notifier'],
    notifyFitOverrideListeners: (...args) => rt['notifyFitOverrideListeners'](...args),
    notifyMobileSessionTabsChanged: (...args) => rt['notifyMobileSessionTabsChanged'](...args),
    notifyRemoteTerminalViewPresenceChanged: (...args) =>
      rt['notifyRemoteTerminalViewPresenceChanged'](...args),
    notifyTerminalResize: (...args) => rt['notifyTerminalResize'](...args),
    offscreenBrowserBackend: () => rt['offscreenBrowserBackend'],
    openMobileDiff: () => rt['openMobileDiff'],
    openMobileFile: () => rt['openMobileFile'],
    osc7ScanTailByPtyId: () => rt['osc7ScanTailByPtyId'],
    oscTitleScanTailByPtyId: () => rt['oscTitleScanTailByPtyId'],
    pairedRendererSessionOwnedPtyIds: () => rt['pairedRendererSessionOwnedPtyIds'],
    pendingMobileTerminalCreatesByKey: () => rt['pendingMobileTerminalCreatesByKey'],
    pendingPtyRegistrationIncarnations: () => rt['pendingPtyRegistrationIncarnations'],
    pendingRestoreTimers: () => rt['pendingRestoreTimers'],
    pendingSoftLeavers: () => rt['pendingSoftLeavers'],
    persistHeadlessSessionTabProps: () => rt['persistHeadlessSessionTabProps'],
    persistHeadlessTabGroups: (...args) => rt['persistHeadlessTabGroups'](...args),
    persistHeadlessTerminalActiveLeaf: (...args) =>
      rt['persistHeadlessTerminalActiveLeaf'](...args),
    persistHeadlessTerminalPaneLayout: () => rt['persistHeadlessTerminalPaneLayout'],
    persistHeadlessTerminalTabOrder: (...args: unknown[]) =>
      (rt['persistHeadlessTerminalTabOrder'] as (...a: unknown[]) => unknown)(...args),
    pickEarliestRestoreTarget: (...args) => rt['pickEarliestRestoreTarget'](...args),
    pickMostRecentActor: (...args) => rt['pickMostRecentActor'](...args),
    providerBufferAcquisitionsByPtyId: () => rt['providerBufferAcquisitionsByPtyId'],
    providerModeSnapshotScansByPtyId: () => rt['providerModeSnapshotScansByPtyId'],
    providerModeTrackersByPtyId: () => rt['providerModeTrackersByPtyId'],
    providerSequenceInitializedPtys: () => rt['providerSequenceInitializedPtys'],
    providerSequenceOffsetByPtyId: () => rt['providerSequenceOffsetByPtyId'],
    providerSnapshotPreferredPtys: () => rt['providerSnapshotPreferredPtys'],
    providerSnapshotsWithLiveModeTransition: () => rt['providerSnapshotsWithLiveModeTransition'],
    providerVisibleRetryAtByPtyId: () => rt['providerVisibleRetryAtByPtyId'],
    providerVisibleStateByPtyId: () => rt['providerVisibleStateByPtyId'],
    pruneDisconnectedPtyTranscript: (...args) => rt['pruneDisconnectedPtyTranscript'](...args),
    ptyController: () => rt['ptyController'],
    ptyDelayedForegroundSnapshotTitleObservations: () =>
      rt['ptyDelayedForegroundSnapshotTitleObservations'],
    ptyOutputSequenceById: () => rt['ptyOutputSequenceById'],
    ptysById: () => rt['ptysById'],
    rawTerminalViewSubscriberCounts: () => rt['rawTerminalViewSubscriberCounts'],
    readMobileFile: () => rt['readMobileFile'],
    readProviderTerminalTailLines: (...args) => rt['readProviderTerminalTailLines'](...args),
    readVisibleTerminalState: (...args) => rt['readVisibleTerminalState'](...args),
    recentPtyOutputById: () => rt['recentPtyOutputById'],
    recentPtyPathCandidatesById: () => rt['recentPtyPathCandidatesById'],
    reconcileNativeChatLaunchDraftResolutionTombstones: (...args) =>
      rt['reconcileNativeChatLaunchDraftResolutionTombstones'](...args),
    recordPtyWorktree: (...args) => rt['recordPtyWorktree'](...args),
    refreshPtyWorktreeRecordsWithControllerInventory: (...args) =>
      rt['refreshPtyWorktreeRecordsWithControllerInventory'](...args),
    releaseRuntimeSessionOwnershipForRendererRetiredTabs: (...args: unknown[]) =>
      (rt['releaseRuntimeSessionOwnershipForRendererRetiredTabs'] as (...a: unknown[]) => unknown)(
        ...args
      ),
    remoteDesktopHostReclaimTargets: () => rt['remoteDesktopHostReclaimTargets'],
    remoteDesktopOwners: () => rt['remoteDesktopOwners'],
    remoteDesktopViewerRevisions: () => rt['remoteDesktopViewerRevisions'],
    remoteDesktopViewers: () => rt['remoteDesktopViewers'],
    remoteTerminalViewSubscriberCounts: () => rt['remoteTerminalViewSubscriberCounts'],
    removePersistedHeadlessTerminalTab: (...args: unknown[]) =>
      (rt['removePersistedHeadlessTerminalTab'] as (...a: unknown[]) => unknown)(...args),
    rendererPublicationThrottle: () => rt['rendererPublicationThrottle'],
    resizeListeners: () => rt['resizeListeners'],
    resolveDesktopRestoreTarget: (...args) => rt['resolveDesktopRestoreTarget'](...args),
    resolveExitWaiters: (...args) => rt['resolveExitWaiters'](...args),
    resolvePtyExitWaiters: (...args) => rt['resolvePtyExitWaiters'](...args),
    resolveTerminalWorkspaceLaunchScope: (...args) =>
      rt['resolveTerminalWorkspaceLaunchScope'](...args),
    resolveWorkspaceTerminalStartupCwd: (...args) =>
      rt['resolveWorkspaceTerminalStartupCwd'](...args),
    resolveWorktreeSelector: (...args) => rt['resolveWorktreeSelector'](...args),
    retireMobileSessionSurfacesForPty: (...args) =>
      rt['retireMobileSessionSurfacesForPty'](...args),
    searchMobileFilePaths: () => rt['searchMobileFilePaths'],
    seedHeadlessTerminal: (...args) => rt['seedHeadlessTerminal'](...args),
    setDriver: (...args) => rt['setDriver'](...args),
    setPairedRendererSessionOwnership: (...args) =>
      rt['setPairedRendererSessionOwnership'](...args),
    settleSessionTabsInventory: (...args) => rt['settleSessionTabsInventory'](...args),
    setupCompletionTokenByPtyId: () => rt['setupCompletionTokenByPtyId'],
    shouldDelayPtyBackedMobileSnapshotForForegroundAgent: () =>
      rt['shouldDelayPtyBackedMobileSnapshotForForegroundAgent'],
    snapshotValueComparison: () => rt['snapshotValueComparison'],
    store: () => rt['store'],
    tabs: () => rt['tabs'],
    terminalCwdByPtyId: () => rt['terminalCwdByPtyId'],
    terminalFileUriHostnameByPtyId: () => rt['terminalFileUriHostnameByPtyId'],
    terminalFitOverrides: () => rt['terminalFitOverrides'],
    terminalSpawnCommandsByPtyId: () => rt['terminalSpawnCommandsByPtyId'],
    trackHeadlessTerminalData: (...args) => rt['trackHeadlessTerminalData'](...args),
    waitForSessionTabsInventoryPublication: (...args) =>
      rt['waitForSessionTabsInventoryPublication'](...args),
    withClientHostedPagesHold: (...args: unknown[]) =>
      (rt['withClientHostedPagesHold'] as (...a: unknown[]) => unknown)(...args),
    wslDistroByPtyId: () => rt['wslDistroByPtyId']
  }
}
