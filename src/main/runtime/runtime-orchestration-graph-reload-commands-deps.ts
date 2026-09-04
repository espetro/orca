import type { RuntimeGraphReloadLifecycle } from './runtime-graph-reload-lifecycle'
import type { RuntimeGraphStatus, RuntimeSyncedTab } from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-tail-shared'

export type RuntimeOrchestrationGraphReloadCommandsDeps = {
  store: { getRepos?(): unknown; getProjectGroups?(): unknown } | null | undefined
  graphReloadLifecycle: RuntimeGraphReloadLifecycle
  getRendererGraphEpoch: () => number
  setRendererGraphEpoch: (value: number) => void
  getGraphStatus: () => RuntimeGraphStatus
  setGraphStatus: (value: RuntimeGraphStatus) => void
  getAuthoritativeWindowId: () => number | null
  setAuthoritativeWindowId: (value: number | null) => void
  isHeadlessGraphFallbackAvailable: () => boolean
  setHeadlessGraphFallbackAvailable: (value: boolean) => void
  getPendingHeadlessPromotionWindowId: () => number | null
  setPendingHeadlessPromotionWindowId: (value: number | null) => void
  getRendererGeneration: () => string | null
  setRendererGeneration: (value: string | null) => void
  getSessionTabsInventoryPublicationEpoch: () => number | null
  setSessionTabsInventoryPublicationEpoch: (value: number | null) => void
  tabs: Map<string, RuntimeSyncedTab>
  leaves: Map<string, RuntimeLeafRecord>
  leavesByPtyId: Map<string, RuntimeLeafRecord[]>
  handles: Map<string, unknown>
  handleByLeafKey: Map<string, string>
  handleByPtyId: Map<string, string>
  handleByPtyIncarnation: Map<string, unknown>
  detachedPreAllocatedLeaves: Map<string, RuntimeLeafRecord>
  waitersByHandle: Map<string, Set<unknown>>
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  setTerminalSideEffectConsumerAvailable: (available: boolean) => void
  rememberDetachedPreAllocatedLeaves: () => void
  refreshWritableFlags: () => void
  adoptPreAllocatedHandle: (leaf: RuntimeLeafRecord) => string | null
  rejectWaitersForHandle: (handle: string, reason: string) => void
  rejectAllWaiters: (reason: string) => void
  reconcilePtyIncarnationHandles: () => void
  clearPtyIncarnationHandles: () => void
  markSessionTabsInventoryPublished: () => void
  attachWindow: (windowId: number) => void
}
