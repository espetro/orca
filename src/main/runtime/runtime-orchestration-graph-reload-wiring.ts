import type { RuntimeOrchestrationGraphReloadCommandsDeps } from './runtime-orchestration-graph-reload-commands-deps'

// Why: the deps literal is transplanted verbatim from the OrcaRuntimeService
// constructor and reads host-internal state; the keyed view is the wiring seam.
/* oxlint-disable typescript/no-explicit-any -- single scoped wiring seam */

import type { OrcaRuntimeService } from './orca-runtime'

export function buildOrchestrationGraphReloadDepsImpl(
  runtime: OrcaRuntimeService
): RuntimeOrchestrationGraphReloadCommandsDeps {
  const rt = runtime as OrcaRuntimeService & Record<string, any>
  return {
    store: rt['store'],
    graphReloadLifecycle: rt['graphReloadLifecycle'],
    getRendererGraphEpoch: () => rt['rendererGraphEpoch'],
    setRendererGraphEpoch: (value) => {
      rt['rendererGraphEpoch'] = value
    },
    getGraphStatus: () => rt['graphStatus'],
    setGraphStatus: (value) => {
      rt['graphStatus'] = value
    },
    getAuthoritativeWindowId: () => rt['authoritativeWindowId'],
    setAuthoritativeWindowId: (value) => {
      rt['authoritativeWindowId'] = value
    },
    isHeadlessGraphFallbackAvailable: () => rt['headlessGraphFallbackAvailable'],
    setHeadlessGraphFallbackAvailable: (value) => {
      rt['headlessGraphFallbackAvailable'] = value
    },
    getPendingHeadlessPromotionWindowId: () => rt['pendingHeadlessPromotionWindowId'],
    setPendingHeadlessPromotionWindowId: (value) => {
      rt['pendingHeadlessPromotionWindowId'] = value
    },
    getRendererGeneration: () => rt['rendererGeneration'],
    setRendererGeneration: (value) => {
      rt['rendererGeneration'] = value
    },
    getSessionTabsInventoryPublicationEpoch: () => rt['sessionTabsInventoryPublicationEpoch'],
    setSessionTabsInventoryPublicationEpoch: (value) => {
      rt['sessionTabsInventoryPublicationEpoch'] = value
    },
    tabs: rt['tabs'],
    leaves: rt['leaves'],
    leavesByPtyId: rt['leavesByPtyId'],
    handles: rt['handles'],
    handleByLeafKey: rt['handleByLeafKey'],
    handleByPtyId: rt['handleByPtyId'],
    handleByPtyIncarnation: rt['handleByPtyIncarnation'],
    detachedPreAllocatedLeaves: rt['detachedPreAllocatedLeaves'],
    waitersByHandle: rt['waitersByHandle'],
    ptysById: rt['ptysById'],
    setTerminalSideEffectConsumerAvailable: (available) =>
      rt['setTerminalSideEffectConsumerAvailable'](available),
    rememberDetachedPreAllocatedLeaves: () => rt['rememberDetachedPreAllocatedLeaves'](),
    refreshWritableFlags: () => rt['refreshWritableFlags'](),
    adoptPreAllocatedHandle: (leaf) => rt['adoptPreAllocatedHandle'](leaf),
    rejectWaitersForHandle: (handle, reason) => rt['rejectWaitersForHandle'](handle, reason),
    rejectAllWaiters: (reason) => rt['rejectAllWaiters'](reason),
    reconcilePtyIncarnationHandles: () => rt['reconcilePtyIncarnationHandles'](),
    clearPtyIncarnationHandles: () => rt['clearPtyIncarnationHandles'](),
    markSessionTabsInventoryPublished: () => rt['markSessionTabsInventoryPublished'](),
    attachWindow: (windowId) => rt['attachWindow'](windowId)
  }
}
