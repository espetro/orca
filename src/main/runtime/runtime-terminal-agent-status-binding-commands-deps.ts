import type { RuntimePtyController, RuntimeStore, ResolvedWorktree } from './runtime-repo-git-commands-shared-types'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'

export type RuntimeTerminalAgentStatusBindingCommandsDeps = {
  ptyController: RuntimePtyController | null
  ptysById: Map<string, any>
  getLivePtyForHandle: (handle: string) => any
  getLiveLeafForHandle: (handle: string) => any
  getPrimaryLeafForPty: (ptyId: string) => any
  getLeavesForPty: (ptyId: string) => any[]
  ptyTitleTrackersByPtyId: Map<string, any>
  ptyForegroundProcessReads: Map<string, any>
  ptyForegroundAgentRefreshes: Map<string, any>
  ptyDelayedForegroundSnapshotTitleObservations: Map<string, number>
  mobileSessionTabListeners: Set<any>
  mobileSessionTabsAgentStatusHeartbeat: any
  agentPromptLifecycleByPtyId: Map<string, any>
  recordTerminalSideEffectFact: (ptyId: string, fact: any) => void
  deliverPendingMessagesForLeaf: (leaf: any) => void
  touchMobileSessionSnapshotsForPty: (ptyId: string) => void
  getFreshExplicitAgentStatusForHandle: (handle: string) => any
  getTerminalAgentStatus: (handle: string) => Promise<RuntimeTerminalAgentStatus>
}
