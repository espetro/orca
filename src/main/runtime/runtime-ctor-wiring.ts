// Why: deps literals are transplanted verbatim from the OrcaRuntimeService
// constructor and read host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'
import { reconcileRequestedWorkerTerminalReleases } from './orchestration/worker-terminal-release-reconciliation'
import type { RuntimeTerminalRecoveryCommandsDeps } from './runtime-terminal-recovery-commands'
import type { RuntimeWindowGraphClientCommandsDeps } from './runtime-window-graph-client-commands'
import type { RuntimeWorktreePsDeps } from './runtime-worktree-ps'
import type { RuntimeMobileTabOperationsDeps } from './runtime-mobile-tab-operations'

export function buildTerminalRecoveryCommandsDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeTerminalRecoveryCommandsDeps {
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    _orchestrationDb: () => rt['_orchestrationDb'],
    prepareLegacyWorkerTerminalRecovery: (...args) =>
      rt['prepareLegacyWorkerTerminalRecovery'](...args),
    resolveTerminalWorkspaceLaunchScope: (...args) =>
      rt['resolveTerminalWorkspaceLaunchScope'](...args),
    canRecoverPersistentLocalPtysFn: () => rt['canRecoverPersistentLocalPtysFn'],
    folderWorkspaceToResolvedWorktree: (...args) =>
      rt['folderWorkspaceToResolvedWorktree'](...args),
    resolveWorktreeSelector: (...args) => rt['resolveWorktreeSelector'](...args),
    refreshPtyWorktreeRecordsWithControllerInventory: (...args) =>
      rt['refreshPtyWorktreeRecordsWithControllerInventory'](...args),
    getWorkspaceSessionForWorktree: (...args) => rt['getWorkspaceSessionForWorktree'](...args),
    hasExactPersistedTerminalSurfaceIdentity: (...args) =>
      rt['hasExactPersistedTerminalSurfaceIdentity'](...args),
    hasExactTerminalSurfaceIdentity: (...args) => rt['hasExactTerminalSurfaceIdentity'](...args),
    getTerminalTopologyRevision: (...args) => rt['getTerminalTopologyRevision'](...args),
    adoptTerminalOrphansFromInventory: (...args) =>
      rt['adoptTerminalOrphansFromInventory'](...args),
    notifier: () => rt['notifier'],
    legacyWorkerTerminalReceiptEpochByPane: () => rt['legacyWorkerTerminalReceiptEpochByPane'],
    rendererGraphEpoch: () => rt['rendererGraphEpoch'],
    ptysById: () => rt['ptysById'],
    onPtyExit: (...args) => rt['onPtyExit'](...args),
    persistLegacyWorkerTerminalRecoveryBatch: (...args) =>
      rt['persistLegacyWorkerTerminalRecoveryBatch'](...args),
    legacyWorkerRecoveredPtys: () => rt['legacyWorkerRecoveredPtys'],
    rollbackLegacyWorkerTerminalSurface: (...args) =>
      rt['rollbackLegacyWorkerTerminalSurface'](...args),
    reconcileMissingLegacyWorkerTerminal: (...args) =>
      rt['reconcileMissingLegacyWorkerTerminal'](...args),
    updateLegacyWorkerTerminalRecoveryRetry: (...args) =>
      rt['updateLegacyWorkerTerminalRecoveryRetry'](...args),
    notifyMessageArrived: (...args) => rt['notifyMessageArrived'](...args),
    reconcileRequestedWorkerTerminalReleasesFn: () =>
      reconcileRequestedWorkerTerminalReleases(runtime)
  }
}

export function buildWindowGraphClientCommandsDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeWindowGraphClientCommandsDeps {
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    adoptFirstPtyForLeafHandle: (...args) => rt['adoptFirstPtyForLeafHandle'](...args),
    adoptPreAllocatedHandle: (...args) => rt['adoptPreAllocatedHandle'](...args),
    applyRemoteDesktopLayout: (...args) => rt['applyRemoteDesktopLayout'](...args),
    attachWindow: (...args) => rt['attachWindow'](...args),
    buildAgentOrchestrationByPaneKey: (...args) => rt['buildAgentOrchestrationByPaneKey'](...args),
    cancelMobileDictationForClient: (...args) => rt['cancelMobileDictationForClient'](...args),
    collectMobileVisibleGraphChangedWorktrees: (...args) =>
      rt['collectMobileVisibleGraphChangedWorktrees'](...args),
    deliverPendingMessagesForLeaf: (...args) => rt['deliverPendingMessagesForLeaf'](...args),
    enqueueLayout: (...args) => rt['enqueueLayout'](...args),
    getAutoRestoreFitMs: (...args) => rt['getAutoRestoreFitMs'](...args),
    getAvailableAuthoritativeWindow: (...args) => rt['getAvailableAuthoritativeWindow'](...args),
    getDriver: (...args) => rt['getDriver'](...args),
    getLeafKey: (...args) => rt['getLeafKey'](...args),
    getMobileDisplayMode: (...args) => rt['getMobileDisplayMode'](...args),
    getNativeChatLaunchDraftResolutionClientEventSnapshot: (...args) =>
      rt['getNativeChatLaunchDraftResolutionClientEventSnapshot'](...args),
    getStatus: (...args) => rt['getStatus'](...args),
    getTerminalSize: (...args) => rt['getTerminalSize'](...args),
    hasRemoteDesktopViewers: (...args) => rt['hasRemoteDesktopViewers'](...args),
    invalidateLeafHandle: (...args) => rt['invalidateLeafHandle'](...args),
    makeRuntimePaneKey: (...args) => rt['makeRuntimePaneKey'](...args),
    markGraphReady: (...args) => rt['markGraphReady'](...args),
    markSessionTabsInventoryPublished: (...args) =>
      rt['markSessionTabsInventoryPublished'](...args),
    mobileTookFloor: (...args) => rt['mobileTookFloor'](...args),
    nextTitleObservationSequence: (...args) => rt['nextTitleObservationSequence'](...args),
    notifyFitOverrideListeners: (...args) => rt['notifyFitOverrideListeners'](...args),
    notifyRemoteTerminalViewPresenceChanged: (...args) =>
      rt['notifyRemoteTerminalViewPresenceChanged'](...args),
    pickMostRecentActor: (...args) => rt['pickMostRecentActor'](...args),
    rebuildLeafPtyIndex: (...args) => rt['rebuildLeafPtyIndex'](...args),
    reconcileMobileSessionRetirementFences: (...args) =>
      rt['reconcileMobileSessionRetirementFences'](...args),
    reconcilePtyIncarnationHandles: (...args) => rt['reconcilePtyIncarnationHandles'](...args),
    recordPtyWorktree: (...args) => rt['recordPtyWorktree'](...args),
    resolveDesktopRestoreTarget: (...args) => rt['resolveDesktopRestoreTarget'](...args),
    scheduleMobileSessionTabsChanged: (...args) => rt['scheduleMobileSessionTabsChanged'](...args),
    setDriver: (...args) => rt['setDriver'](...args),
    syncMobileSessionTabs: (...args) => rt['syncMobileSessionTabs'](...args),
    _orchestrationDb: () => rt['_orchestrationDb'],
    authoritativeWindowId: () => rt['authoritativeWindowId'],
    authoritativeWindowIdSet: (windowId) => {
      rt['authoritativeWindowId'] = windowId
    },
    detachedPreAllocatedLeaves: rt['detachedPreAllocatedLeaves'],
    freshSubscribeGuard: rt['freshSubscribeGuard'],
    getDesktopWindowStatusFn: () => rt['getDesktopWindowStatusFn'](),
    graphStatus: () => rt['graphStatus'],
    graphSyncCallbacks: rt['graphSyncCallbacks'],
    handleByLeafKey: rt['handleByLeafKey'],
    handleByPtyId: rt['handleByPtyId'],
    handleByPtyIncarnation: rt['handleByPtyIncarnation'],
    headlessGraphFallbackAvailable: rt['headlessGraphFallbackAvailable'],
    headlessGraphFallbackAvailableSet: (value) => {
      rt['headlessGraphFallbackAvailable'] = value
    },
    lastRendererSizes: rt['lastRendererSizes'],
    layouts: rt['layouts'],
    leaves: () => rt['leaves'],
    mobileSessionTabsByWorktree: rt['mobileSessionTabsByWorktree'],
    mobileSubscribers: rt['mobileSubscribers'],
    offscreenBrowserBackend: () => rt['offscreenBrowserBackend'],
    pendingHeadlessPromotionWindowId: () => rt['pendingHeadlessPromotionWindowId'],
    pendingRestoreTimers: rt['pendingRestoreTimers'],
    pendingSoftLeavers: rt['pendingSoftLeavers'],
    ptysById: rt['ptysById'],
    remoteDesktopHostReclaimTargets: rt['remoteDesktopHostReclaimTargets'],
    rendererGeneration: () => rt['rendererGeneration'],
    rendererGenerationSet: (generation) => {
      rt['rendererGeneration'] = generation
    },
    rendererGraphEpoch: () => rt['rendererGraphEpoch'],
    revokeTerminalFileGrantsForClient: (...args) =>
      rt['revokeTerminalFileGrantsForClient'](...args),
    runtimeId: rt['runtimeId'],
    sessionTabsInventoryPublicationEpoch: () => rt['sessionTabsInventoryPublicationEpoch'],
    sessionTabsInventoryPublicationEpochSet: (epoch) => {
      rt['sessionTabsInventoryPublicationEpoch'] = epoch
    },
    store: rt['store'],
    tabs: () => rt['tabs'],
    tabsSet: (next) => {
      rt['tabs'] = next
    },
    leavesSet: (next) => {
      rt['leaves'] = next
    },
    terminalFitOverrides: rt['terminalFitOverrides']
  }
}

export function buildWorktreePsDepsImpl(runtime: OrcaRuntimeService): RuntimeWorktreePsDeps {
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    attachAgentRowsToSummaries: (...args) => rt['attachAgentRowsToSummaries'](...args),
    buildRuntimeVisibilitySourceMatchersByRepoId: (...args) =>
      rt['buildRuntimeVisibilitySourceMatchersByRepoId'](...args),
    getSummaryForRuntimeWorktreeId: (...args) => rt['getSummaryForRuntimeWorktreeId'](...args),
    isRuntimeWorktreeVisible: (...args) => rt['isRuntimeWorktreeVisible'](...args),
    leaves: rt['leaves'],
    listResolvedWorktreeSnapshot: (...args) => rt['listResolvedWorktreeSnapshot'](...args),
    makeRuntimePaneKey: (...args) => rt['makeRuntimePaneKey'](...args),
    ptysById: rt['ptysById'],
    refreshPtyWorktreeRecordsFromController: (...args) =>
      rt['refreshPtyWorktreeRecordsFromController'](...args),
    store: () => rt['store'],
    tabs: rt['tabs']
  }
}

export function buildMobileTabOperationsDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeMobileTabOperationsDeps {
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    applySeededAgentStatus: (...args) => rt['applySeededAgentStatus'](...args),
    assertStableReadyGraph: (...args) => rt['assertStableReadyGraph'](...args),
    browserTabClose: (...args) => rt['browserTabClose'](...args),
    captureReadyGraphEpoch: (...args) => rt['captureReadyGraphEpoch'](...args),
    clientHostedBrowserRows: rt['clientHostedBrowserRows'],
    clientSessionTabSelections: () => rt['clientSessionTabSelections'],
    closeFileWatchersForRemoval: () => rt['closeFileWatchersForRemoval'],
    closeStructuredAgentSessionTab: (...args) => rt['closeStructuredAgentSessionTab'](...args),
    collectBrowserGroupAssignment: (...args) => rt['collectBrowserGroupAssignment'](...args),
    fileCommands: rt['fileCommands'],
    forgetFileWatchersAfterRemoval: () => rt['forgetFileWatchersAfterRemoval'],
    getAvailableAuthoritativeWindow: (...args) => rt['getAvailableAuthoritativeWindow'](...args),
    getPtyOutputSequence: (...args) => rt['getPtyOutputSequence'](...args),
    getTerminalSize: (...args) => rt['getTerminalSize'](...args),
    getTrackedRawTitleForPty: () => rt['getTrackedRawTitleForPty'],
    getValidatedExplicitWorktreeIdSelector: (...args) =>
      rt['getValidatedExplicitWorktreeIdSelector'](...args),
    getWorkspaceSessionForWorktree: (...args) => rt['getWorkspaceSessionForWorktree'](...args),
    hasRecentExpiredSshLeasePane: (...args) => rt['hasRecentExpiredSshLeasePane'](...args),
    hasRecentTerminalOutputPath: (...args) => rt['hasRecentTerminalOutputPath'](...args),
    hasServeOrSshOwnedBinding: (...args) => rt['hasServeOrSshOwnedBinding'](...args),
    headlessHydrationState: rt['headlessHydrationState'],
    headlessTerminals: rt['headlessTerminals'],
    isHeadlessBuiltMobileSessionPublicationBase: (...args) =>
      rt['isHeadlessBuiltMobileSessionPublicationBase'](...args),
    mobileSessionTabsByWorktree: rt['mobileSessionTabsByWorktree'],
    mobileSessionTabsChangeSequence: rt['mobileSessionTabsChangeSequence'],
    notifier: () => rt['notifier'],
    offscreenBrowserBackend: () => rt['offscreenBrowserBackend'],
    persistClientHostedBrowserPagesForWorktree: (...args) =>
      rt['persistClientHostedBrowserPagesForWorktree'](...args),
    persistedClientHostedBrowserWorktreeIds: rt['persistedClientHostedBrowserWorktreeIds'],
    providerSnapshotPreferredPtys: rt['providerSnapshotPreferredPtys'],
    ptyController: () => rt['ptyController'],
    ptyWorktrees: () => rt['ptyWorktrees'],
    recordRecentPtyOutputForPathProvenance: (...args) =>
      rt['recordRecentPtyOutputForPathProvenance'](...args),
    rendererPublicationThrottle: rt['rendererPublicationThrottle'],
    repointPendingMessagesForHandle: (...args) => rt['repointPendingMessagesForHandle'](...args),
    republishMobileSessionTabsSnapshot: (...args) =>
      rt['republishMobileSessionTabsSnapshot'](...args),
    requireStore: (...args) => rt['requireStore'](...args),
    resolveKnownWorkspaceFileTarget: (...args) => rt['resolveKnownWorkspaceFileTarget'](...args),
    resolveRuntimeFileTarget: (...args) => rt['resolveRuntimeFileTarget'](...args),
    resolveRuntimeGitTarget: (...args) => rt['resolveRuntimeGitTarget'](...args),
    resolveTerminalContext: (...args) => rt['resolveTerminalContext'](...args),
    resolveTerminalCwd: (...args) => rt['resolveTerminalCwd'](...args),
    resolveTerminalFileUriHostname: (...args) => rt['resolveTerminalFileUriHostname'](...args),
    resolveWorktreeSelector: (...args) => rt['resolveWorktreeSelector'](...args),
    restoreFileWatchersAfterFailedRemoval: () => rt['restoreFileWatchersAfterFailedRemoval'],
    retireRuntimeOwnedBrowserSessionTab: (...args) =>
      rt['retireRuntimeOwnedBrowserSessionTab'](...args),
    runtimeId: () => rt['runtimeId'],
    snapshotValueComparison: () => rt['snapshotValueComparison'],
    store: () => rt['store'],
    tabs: rt['tabs'],
    terminalClusterFacade: () => rt['terminalClusterFacade'],
    workspaceSessionHasRuntimeOwnedPtyCandidate: (...args) =>
      rt['workspaceSessionHasRuntimeOwnedPtyCandidate'](...args),
    workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate: (...args) =>
      rt['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate'](...args),
    recordOsc7MetadataForPty: () => rt['recordOsc7MetadataForPty'],
    buildHeadlessMobileSessionBrowserTabs: (...args) =>
      rt['buildHeadlessMobileSessionBrowserTabs'](...args),
    buildHeadlessMobileSessionTerminalTabs: (...args) =>
      rt['buildHeadlessMobileSessionTerminalTabs'](...args),
    headlessMobileSnapshotContentUnchanged: (...args) =>
      rt['headlessMobileSnapshotContentUnchanged'](...args),
    isRuntimeOwnedHeadlessMobileTab: (...args) => rt['isRuntimeOwnedHeadlessMobileTab'](...args),
    mergeMobileSessionSnapshotTabs: (...args) => rt['mergeMobileSessionSnapshotTabs'](...args),
    mergeMobileSessionTabGroups: (...args) => rt['mergeMobileSessionTabGroups'](...args),
    notifyMobileSessionTabSnapshots: (...args) => rt['notifyMobileSessionTabSnapshots'](...args),
    reconcileHeadlessMobileSessionBrowserTabs: (...args) =>
      rt['reconcileHeadlessMobileSessionBrowserTabs'](...args),
    mobileSessionFacade: () => rt['mobileSessionFacade'],
    mobileTabSnapshots: () => rt['mobileTabSnapshots']
  }
}
