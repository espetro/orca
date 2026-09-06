import type { DriverState, PtyControllerInventory } from './orca-runtime'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type { MobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'
import type { RuntimeMobileSessionFacadeDeps } from './runtime-mobile-session-facade'

/** Narrow facade view handed to extracted module functions; owns the facade's mobile-session mutable state. */
export type RuntimeMobileSessionFacadeCtx = {
  deps: RuntimeMobileSessionFacadeDeps
  mobileDictation: {
    id: string
    owner: string
    clientId?: string
    connectionId?: string
    state: 'starting' | 'active' | 'closing'
    partialText: string
    finalTexts: string[]
    errors: string[]
  } | null
  mobileDisplayModes: Map<string, 'desktop'>
  mobileInputFloorClaims: Map<
    string,
    {
      base: DriverState
      generation: number
      committedGeneration: number
      pending: Map<symbol, { clientId: string; generation: number }>
    }
  >
  mobileTerminalCreateByMutationId: Map<string, Promise<RuntimeMobileSessionCreateTerminalResult>>
  pendingMobileSessionPtyAggregateInventoryRefresh: Promise<PtyControllerInventory | null> | null
  pendingMobileSessionTabsChangeSequenceByWorktree: Map<string, number>
  mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer
  listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult>
  emitMobileSessionTabsSnapshotToClient(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string,
    withHostedPagesHold?: boolean
  ): void
}
