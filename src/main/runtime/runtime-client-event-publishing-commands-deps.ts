import type { Store } from '../../shared/store-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

export type RuntimeClientEventPublishingCommandsDeps = {
  store: Store
  clientEventListeners: Set<(event: RuntimeClientEvent) => void>
  terminalSideEffectExcludedClientEventListeners: Set<(event: RuntimeClientEvent) => void>
  terminalSleepStateByWorktreeId: Map<string, any>
  notifyMobileSessionTabsChanged: (tabUpdate: any) => void
  emitWorktreeLifecycleCallbacks: Set<(event: any) => void>
  repoLifecycleListeners: Set<(event: any) => void>
  recordedTerminalSleepHandles: Map<string, any>
  sshRelayRecoveryGenerationByTargetId: Map<string, number>
  worktreeLifecycleListeners: Set<(event: any) => void>
  pendingMobileSessionPtyAggregateInventoryRefresh: Promise<any> | null
  getSshProviderFn: () => any
}
