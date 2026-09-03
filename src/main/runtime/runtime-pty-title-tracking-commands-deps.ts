/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RuntimePtyTitleTrackerEntry } from '../pty-handling/pty-title-tracker-types'

export type RuntimePtyTitleTrackingCommandsDeps = {
  ptyTitleTrackersByPtyId: Map<string, RuntimePtyTitleTrackerEntry>
  ptysById: Map<string, any>
  mobileSessionTabListeners: Set<any>
  ptyDelayedForegroundSnapshotTitleObservations: Set<string>
  mobileSessionTabsAgentStatusHeartbeat: any
  terminalSideEffectConsumerAvailable: boolean
  terminalSideEffectLocalConsumerAvailable: boolean
  onTerminalSideEffects: ((fact: any) => void) | null
  terminalSpawnCommandsByPtyId: Map<string, string>
  oscTitleScanTailByPtyId: Map<string, string>
  osc7ScanTailByPtyId: Map<string, string>
  agentStatusOscProcessorsByPtyId: Map<string, any>
  agentPromptLifecycleByPtyId: Map<string, any>
  agentPromptPermissionSequenceByPtyId: Map<string, any>
  terminalSideEffectTitleGateKeysByClientEventListener: Map<any, Set<string>>
  wslDistroByPtyId: Map<string, string>
  terminalCwdByPtyId: Map<string, string>
  terminalFileUriHostnameByPtyId: Map<string, string>
  getLeavesForPty: (ptyId: string) => any[]
  recordTerminalSideEffectFact: (ptyId: string, fact: any) => void
  touchMobileSessionSnapshotsForPty: (ptyId: string) => void
  confirmPtyAgentExit: (ptyId: string) => void
  retirePtyAgentLaunchAuthority: (ptyId: string) => void
  recordAgentPromptLifecycleState: (ptyId: string, agentStatus: any) => void
  nextTitleObservationSequence: () => number
  setPtyManagementTitleFromObservedTitle: (
    pty: any,
    normalizedTitle: string,
    observedAt: number
  ) => void
  shouldDelayPtyBackedMobileSnapshotForForegroundAgent: (
    pty: any,
    normalizedTitle: string
  ) => boolean
  refreshPtyForegroundAgentFromController: (
    ptyId: string,
    opts: { afterTitleObservation: number }
  ) => Promise<boolean>
  getPendingForegroundAgentRefreshForTitle: (
    ptyId: string,
    observedAt: number
  ) => Promise<boolean> | undefined
  delayPtyBackedMobileSnapshotForForegroundAgent: (
    ptyId: string,
    observedAt: number,
    foregroundRefresh: Promise<boolean>
  ) => void
  resolvePtyTuiIdleWaiters: (pty: any, ptyId: string) => void
  resolveTuiIdleWaiters: (leaf: any) => void
  deliverPendingMessagesForLeaf: (leaf: any) => void
  countTerminalSideEffectConsumingClientEventListeners: () => number
  clearWaitBlockedCheckState: (ptyId: string) => void
  primeWaitBlockedBaselineFromSeededTail: (ptyId: string) => void
  clearAgentRowSnapshotsForPty: (ptyId: string) => void
}
