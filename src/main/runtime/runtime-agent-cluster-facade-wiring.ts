import type { RuntimeAgentClusterFacadeDeps } from './runtime-agent-cluster-facade'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildAgentClusterFacadeDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeAgentClusterFacadeDeps {
  // Bracket reads keep TS's noUnusedLocals honest about host member usage.
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    assertLiveTerminalHandleTargetsPty: (...args) =>
      rt['assertLiveTerminalHandleTargetsPty'](...args),
    closeStructuredTuiOwner: (...args) => rt['closeStructuredTuiOwner'](...args),
    closeTerminal: (...args) => rt['closeTerminal'](...args),
    createTerminal: (...args) => rt['createTerminal'](...args),
    emitMobileSessionTabsSnapshot: (...args: any[]) =>
      rt['mobileSessionFacade'].emitMobileSessionTabsSnapshot(...args),
    focusTerminal: (...args) => rt['focusTerminal'](...args),
    getAgentLaunchPlatformForRepo: (repo) => rt['getAgentLaunchPlatformForRepo'](repo),
    getAgentLaunchPlatformForWorkspace: (scope) => rt['getAgentLaunchPlatformForWorkspace'](scope),
    getHeadlessMobileSessionGroupId: (...args: any[]) =>
      rt['mobileSessionFacade'].getHeadlessMobileSessionGroupId(...args),
    getKnownWorkspaceSessionWorktreeIds: (...args) =>
      rt['getKnownWorkspaceSessionWorktreeIds'](...args),
    getLeavesForPty: (...args) => rt['getLeavesForPty'](...args),
    getLiveLeafForHandle: (...args) => rt['getLiveLeafForHandle'](...args),
    getLivePtyForHandle: (...args) => rt['getLivePtyForHandle'](...args),
    getLocalProvider: (...args) => rt['getLocalProvider'](...args),
    getOrchestrationDbIfAvailable: (...args) => rt['getOrchestrationDbIfAvailable'](...args),
    getPaneKeyForTerminalHandle: (...args) => rt['getPaneKeyForTerminalHandle'](...args),
    getPrimaryLeafForPty: (...args) => rt['getPrimaryLeafForPty'](...args),
    getPtyLifecycleGeneration: (...args) => rt['getPtyLifecycleGeneration'](...args),
    getPtyOutputSequence: (...args) => rt['getPtyOutputSequence'](...args),
    getPtyRecordForPaneKey: (...args) => rt['getPtyRecordForPaneKey'](...args),
    getPtyWriteHostPlatform: (...args) => rt['getPtyWriteHostPlatform'](...args),
    getSummaryForRuntimeWorktreeId: (...args: never[]) =>
      (
        rt as unknown as { getSummaryForRuntimeWorktreeId: (...a: never[]) => unknown }
      ).getSummaryForRuntimeWorktreeId(...args),
    getTerminalHandleForPaneKey: (...args) => rt['getTerminalHandleForPaneKey'](...args),
    getWorkspaceSessionForWorktree: (...args) => rt['getWorkspaceSessionForWorktree'](...args),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (...args) =>
      rt['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](...args),
    isLeafPtyProvenAbsent: (...args) => rt['isLeafPtyProvenAbsent'](...args),
    issuePtyHandle: (...args) => rt['issuePtyHandle'](...args),
    issueStructuredTuiPtyHandle: (...args) => rt['issueStructuredTuiPtyHandle'](...args),
    makeRuntimePaneKey: (...args: never[]) =>
      (rt as unknown as { makeRuntimePaneKey: (...a: never[]) => unknown }).makeRuntimePaneKey(
        ...args
      ),
    nextTitleObservationSequence: (...args) => rt['nextTitleObservationSequence'](...args),
    proveRecoveredStructuredTuiPtyProcess: (...args) =>
      rt['proveRecoveredStructuredTuiPtyProcess'](...args),
    readTerminal: (...args) => rt['readTerminal'](...args),
    refreshMobileSessionPtyRecords: (...args) => rt['refreshMobileSessionPtyRecords'](...args),
    refreshStructuredTuiOwnerBinding: (...args) => rt['refreshStructuredTuiOwnerBinding'](...args),
    requireStore: (...args) => rt['requireStore'](...args),
    resolveConfiguredCodexStructuredArgs: (...args) =>
      rt['resolveConfiguredCodexStructuredArgs'](...args),
    resolveRecoveredStructuredTuiTranscript: (...args: never[]) =>
      (
        rt as unknown as { resolveRecoveredStructuredTuiTranscript: (...a: never[]) => unknown }
      ).resolveRecoveredStructuredTuiTranscript(...args),
    resolveRuntimeFileTarget: (...args) => rt['resolveRuntimeFileTarget'](...args),
    resolveTerminalWorkspaceLaunchScope: (...args) =>
      rt['resolveTerminalWorkspaceLaunchScope'](...args),
    resolveWorkspaceTerminalStartupCwd: (...args: never[]) =>
      (
        rt as unknown as { resolveWorkspaceTerminalStartupCwd: (...a: never[]) => unknown }
      ).resolveWorkspaceTerminalStartupCwd(...args),
    resolveWorktreeSelector: (...args) => rt['resolveWorktreeSelector'](...args),
    sendTerminal: (...args: never[]) =>
      (rt as unknown as { sendTerminal: (...a: never[]) => unknown }).sendTerminal(...args),
    setPtyManagementTitleFromObservedTitle: (...args) =>
      rt['setPtyManagementTitleFromObservedTitle'](...args),
    showTerminal: (...args) => rt['showTerminal'](...args),
    splitTerminal: (...args: never[]) =>
      (rt as unknown as { splitTerminal: (...a: never[]) => unknown }).splitTerminal(...args),
    stopStructuredSessionProcess: (...args) => rt['stopStructuredSessionProcess'](...args),
    structuredTuiStatus: (...args) => rt['structuredTuiStatus'](...args),
    subscribeToTerminalData: (...args) => rt['subscribeToTerminalData'](...args),
    terminalHasShellForegroundProcess: (...args) =>
      rt['terminalAgentStatusBinding'].terminalHasShellForegroundProcess(...args),
    waitForAdoptedStructuredTuiProof: (...args: never[]) =>
      (
        rt as unknown as { waitForAdoptedStructuredTuiProof: (...a: never[]) => unknown }
      ).waitForAdoptedStructuredTuiProof(...args),
    waitForStructuredClaudeTuiProof: (...args: never[]) =>
      (
        rt as unknown as { waitForStructuredClaudeTuiProof: (...a: never[]) => unknown }
      ).waitForStructuredClaudeTuiProof(...args),
    waitForStructuredTuiIdleOrExit: (...args) => rt['waitForStructuredTuiIdleOrExit'](...args),
    waitForStructuredTuiOwnerExit: (...args) => rt['waitForStructuredTuiOwnerExit'](...args),
    waitForStructuredTuiProof: (...args: never[]) =>
      (
        rt as unknown as { waitForStructuredTuiProof: (...a: never[]) => unknown }
      ).waitForStructuredTuiProof(...args),
    waitForStructuredTuiPtyExit: (...args) => rt['waitForStructuredTuiPtyExit'](...args),
    waitForTerminal: (...args: never[]) =>
      (rt as unknown as { waitForTerminal: (...a: never[]) => unknown }).waitForTerminal(...args),
    agentSessionClaimSigner: () => rt['agentSessionClaimSigner'],
    agentSessionCreateOperations: () => rt['agentSessionCreateOperations'],
    claudeAgentTeams: () => rt['claudeAgentTeams'],
    onTerminalAgentStatus: () => rt['onTerminalAgentStatus'],
    getSshProviderFn: () => rt['getSshProviderFn'],
    prepareCodexStructuredLaunchFn: () => rt['prepareCodexStructuredLaunchFn'],
    getAgentProviderSessionRowsForPaneFn: () => rt['getAgentProviderSessionRowsForPaneFn'],
    getAgentStatusSnapshotFn: () => rt['getAgentStatusSnapshotFn'],
    runtimeId: () => rt['runtimeId'],
    store: () => rt['store'],
    ptysById: () => rt['ptysById'],
    ptyController: () => rt['ptyController'],
    tabs: () => rt['tabs'],
    notifier: () => rt['notifier'],
    mobileSessionTabsByWorktree: () => rt['mobileSessionTabsByWorktree'],
    ptyWorktrees: () => rt['ptyWorktrees'],
    skillArtifactCommands: () => rt['skillArtifactCommands'],
    mobileSessionFacade: () => rt['mobileSessionFacade'],
    hookAgentRowResolutionCommands: () => rt['hookAgentRowResolutionCommands'],
    terminalAgentStatusBinding: () => rt['terminalAgentStatusBinding'],
    getTerminalAgentStatusPtyId: () => rt['getTerminalAgentStatusPtyId'],
    assertTerminalAgentStatusPtyBinding: () => rt['assertTerminalAgentStatusPtyBinding'],
    getTerminalAgentStatusSnapshot: () => rt['getTerminalAgentStatusSnapshot'],
    hasAuthoritativeTerminalWaitPermission: () => rt['hasAuthoritativeTerminalWaitPermission'],
    getOrCreatePtyTitleTrackerEntry: () => rt['getOrCreatePtyTitleTrackerEntry'],
    agentPromptLifecycleByPtyId: () => rt['agentPromptLifecycleByPtyId'],
    agentPromptPermissionSequenceByPtyId: () => rt['agentPromptPermissionSequenceByPtyId'],
    agentPromptExplicitStatusFloorByPtyId: () => rt['agentPromptExplicitStatusFloorByPtyId'],
    agentPromptSubmissionTailByPtyId: () => rt['agentPromptSubmissionTailByPtyId'],
    agentStatusOscProcessorsByPtyId: () => rt['agentStatusOscProcessorsByPtyId'],
    latestAgentStatusByPaneKey: () => rt['latestAgentStatusByPaneKey']
  }
}
