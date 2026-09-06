import type { RuntimeManagedWorktreesDeps } from './runtime-managed-worktrees'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildManagedWorktreesDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeManagedWorktreesDeps {
  // Bracket reads keep TS's noUnusedLocals honest about host member usage.
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    _orchestrationDb: rt['_orchestrationDb'],
    acceptedRendererMobileSnapshotByWorktree: () => rt['acceptedRendererMobileSnapshotByWorktree'],
    adoptControllerTerminalHandle: (...args) => rt['adoptControllerTerminalHandle'](...args),
    agentBrowserBridge: rt['agentBrowserBridge'],
    assertGraphReady: (...args) => rt['assertGraphReady'](...args),
    assertStableReadyGraph: (...args) => rt['assertStableReadyGraph'](...args),
    attachAgentRowsToSummaries: (...args) => rt['attachAgentRowsToSummaries'](...args),
    authoritativeWindowId: () => rt['authoritativeWindowId'],
    buildResolvedWorktreeFromId: (...args) => rt['buildResolvedWorktreeFromId'](...args),
    buildStartupForAgent: (...args) => rt['buildStartupForAgent'](...args),
    buildStartupForDraft: (...args) => rt['buildStartupForDraft'](...args),
    captureReadyGraphEpoch: (...args) => rt['captureReadyGraphEpoch'](...args),
    clientEventPublishingCommands: () => rt['clientEventPublishingCommands'],
    createDefaultTabTerminals: (...args) => rt['createDefaultTabTerminals'](...args),
    createTerminal: (...args) => rt['createTerminal'](...args),
    emitClientEvent: (...args) => rt['emitClientEvent'](...args),
    fetchRemoteWithCache: (...args) => rt['fetchRemoteWithCache'](...args),
    forgetPtyLivenessVerdict: (...args) => rt['forgetPtyLivenessVerdict'](...args),
    getAvailableAuthoritativeWindow: (...args) => rt['getAvailableAuthoritativeWindow'](...args),
    getLeafKey: (...args) => rt['getLeafKey'](...args),
    getLivePtyForHandle: (...args) => rt['getLivePtyForHandle'](...args),
    getLocalProvider: (...args) => rt['getLocalProvider'](...args),
    getOrStartRemoteFetch: (...args) => rt['getOrStartRemoteFetch'](...args),
    getOrStartRemoteTrackingBaseRefresh: (...args) =>
      rt['getOrStartRemoteTrackingBaseRefresh'](...args),
    getPtyRecordForPaneKey: (...args) => rt['getPtyRecordForPaneKey'](...args),
    getRecordedTerminalSleepHandles: (...args) => rt['getRecordedTerminalSleepHandles'](...args),
    getResolvedWorktreeMap: (...args) => rt['getResolvedWorktreeMap'](...args),
    getRuntimeId: (...args) => rt['getRuntimeId'](...args),
    getSshProviderFn: () => rt['getSshProviderFn'],
    getStartedAt: (...args) => rt['getStartedAt'](...args),
    getTerminalHandlesForPtyId: (...args) => rt['getTerminalHandlesForPtyId'](...args),
    graphStatus: () => rt['graphStatus'],
    hasFreshResolvedWorktreeCache: (...args) => rt['hasFreshResolvedWorktreeCache'](...args),
    hasRemoteTrackingRef: (...args) => rt['hasRemoteTrackingRef'](...args),
    hookAgentRowResolutionCommands: () => rt['hookAgentRowResolutionCommands'],
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
      rt['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](...args),
    intentionalHandlelessPtyStops: () => rt['intentionalHandlelessPtyStops'],
    invalidatePtyIncarnationHandle: (...args) => rt['invalidatePtyIncarnationHandle'](...args),
    invalidateResolvedWorktreeCache: (...args) => rt['invalidateResolvedWorktreeCache'](...args),
    invalidateSshWorktreeScanCacheInternal: (...args) =>
      rt['invalidateSshWorktreeScanCacheInternal'](...args),
    invalidateWorktreeScanCacheForRepo: (...args) =>
      rt['invalidateWorktreeScanCacheForRepo'](...args),
    leafExistsForPty: (...args) => rt['leafExistsForPty'](...args),
    leaves: () => rt['leaves'],
    listResolvedWorktreeSnapshot: (...args) => rt['listResolvedWorktreeSnapshot'](...args),
    listResolvedWorktrees: (...args) => rt['listResolvedWorktrees'](...args),
    makeRuntimePaneKey: (...args) => rt['makeRuntimePaneKey'](...args),
    markLocalWorkspaceTrustedForAgent: (...args) =>
      rt['markLocalWorkspaceTrustedForAgent'](...args),
    markPtyLivenessUnverifiable: (...args) => rt['markPtyLivenessUnverifiable'](...args),
    markRemoteWorkspaceTrustedForAgent: (...args) =>
      rt['markRemoteWorkspaceTrustedForAgent'](...args),
    mobileSessionTabsAgentStatusHeartbeat: () => rt['mobileSessionTabsAgentStatusHeartbeat'],
    mobileSessionTabsByWorktree: () => rt['mobileSessionTabsByWorktree'],
    mobileTabSnapshots: () => rt['mobileTabSnapshots'],
    nextTitleObservationSequence: (...args) => rt['nextTitleObservationSequence'](...args),
    notifier: rt['notifier'],
    notifyMobileSessionTabsChanged: (...args) => rt['notifyMobileSessionTabsChanged'](...args),
    offscreenBrowserBackend: rt['offscreenBrowserBackend'],
    onPtyStopped: () => rt['onPtyStopped'],
    pasteStartupDraftWhenReady: (...args) => rt['pasteStartupDraftWhenReady'](...args),
    projectMobileSessionTabsForClient: (...args) =>
      rt['projectMobileSessionTabsForClient'](...args),
    pruneDisconnectedPtyRecords: (...args) => rt['pruneDisconnectedPtyRecords'](...args),
    ptyController: rt['ptyController'],
    ptyLivenessVerdictByPtyId: () => rt['ptyLivenessVerdictByPtyId'],
    ptyLivenessObservationSequence: () => rt['ptyLivenessObservationSequence'],
    ptysById: () => rt['ptysById'],
    reconcileSubscriberDrivenProviderAttach: (...args) =>
      rt['reconcileSubscriberDrivenProviderAttach'](...args),
    refreshFloatingWorkspacePtyLiveness: (...args) =>
      rt['refreshFloatingWorkspacePtyLiveness'](...args),
    refreshMobileSessionPtyRecords: (...args) => rt['refreshMobileSessionPtyRecords'](...args),
    refreshPtyForegroundAgent: () => rt['refreshPtyForegroundAgent'],
    rememberRestoredOrchestrationAuthority: (...args) =>
      rt['rememberRestoredOrchestrationAuthority'](...args),
    requireStore: (...args) => rt['requireStore'](...args),
    resolveExplicitWorktreeIdScoped: (...args) => rt['resolveExplicitWorktreeIdScoped'](...args),
    resolveFolderWorkspaceConnectionId: (...args) =>
      rt['resolveFolderWorkspaceConnectionId'](...args),
    resolveLineageCandidateForTaskId: (...args) => rt['resolveLineageCandidateForTaskId'](...args),
    resolveRemoteTrackingBase: (...args) => rt['resolveRemoteTrackingBase'](...args),
    resolveRepoSelector: (...args) => rt['resolveRepoSelector'](...args),
    resolveWorkspaceParentSelector: (...args) => rt['resolveWorkspaceParentSelector'](...args),
    restoredOrchestrationAuthorityByPtyId: () => rt['restoredOrchestrationAuthorityByPtyId'],
    sendStartupFollowupWhenReady: (...args) => rt['sendStartupFollowupWhenReady'](...args),
    setPtyManagementTitleFromObservedTitle: (...args) =>
      rt['setPtyManagementTitleFromObservedTitle'](...args),
    setupCompletionTokenByPtyId: () => rt['setupCompletionTokenByPtyId'],
    showTerminal: (...args) => rt['showTerminal'](...args),
    snapshotValueComparison: () => rt['snapshotValueComparison'],
    splitTerminal: (...args) => rt['splitTerminal'](...args),
    store: rt['store'],
    tabs: () => rt['tabs'],
    terminalMutationTailByWorktreeId: () => rt['terminalMutationTailByWorktreeId'],
    terminalSleepByWorktreeId: () => rt['terminalSleepByWorktreeId'],
    terminalSleepStateByWorktreeId: () => rt['terminalSleepStateByWorktreeId'],
    toMobileSessionTabsResult: (...args) => rt['toMobileSessionTabsResult'](...args),
    validateLineageParent: (...args) => rt['validateLineageParent'](...args),
    wslDistroByPtyId: () => rt['wslDistroByPtyId'],
    getHostedReviewExecutionOptions: (...args) => rt['getHostedReviewExecutionOptions'](...args),
    getLocalGitExecutionOptionArgs: (...args) => rt['getLocalGitExecutionOptionArgs'](...args)
  }
}
