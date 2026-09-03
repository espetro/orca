import { handleGlobalSessionTabsOnResponse } from './web-session-tabs-global-stream-on-response'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  WindowVisibilitySubscriptionContext,
  WindowVisibilitySubscriptionSpec
} from './window-visibility-subscription-parking'
import { getWebSessionTabsTrackingGeneration } from './web-session-tabs-tracking'
import { loadInitialWebSessionTabs } from './web-session-tabs-initial-inventory'
import type { WebSessionTabsMirrorEnvironmentSpec } from './web-session-tabs-visibility-resume'
import { shouldSyncAllRuntimeSessionTabs } from './web-session-tabs-stream-predicates'

export function buildGlobalSessionTabsSubscriptionSpecs(
  environments: readonly WebSessionTabsMirrorEnvironmentSpec[],
  workspaceSessionReady: boolean
): {
  specs: WindowVisibilitySubscriptionSpec[]
  environmentIdBySubscriptionSpec: string[]
} {
  const environmentIdBySubscriptionSpec: string[] = []
  const specs: WindowVisibilitySubscriptionSpec[] = []
  // Why: the stream's initial snapshot can land after first render, so a one-shot fetch makes initial parity deterministic.
  for (const {
    environmentId,
    expectedEnvironmentConnectionGeneration,
    expectedEnvironmentPairingRevision
  } of environments) {
    if (
      !shouldSyncAllRuntimeSessionTabs({
        activeRuntimeEnvironmentId: environmentId,
        workspaceSessionReady
      })
    ) {
      continue
    }
    let requestedInitialLoad = false
    const expectedTrackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
    environmentIdBySubscriptionSpec.push(environmentId)
    specs.push({
      subscribe: (isCurrent, context: WindowVisibilitySubscriptionContext) => {
        const visibilityGeneration = context.visibilityGeneration
        const isVisibilityRestart = visibilityGeneration > 0
        let awaitingVisibilityResumeInventory = isVisibilityRestart
        if (!requestedInitialLoad) {
          requestedInitialLoad = true
          loadInitialWebSessionTabs(
            environmentId,
            expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision,
            expectedTrackingGeneration,
            isCurrent
          )
        }
        return window.api.runtimeEnvironments.subscribe(
          {
            selector: environmentId,
            method: 'session.tabs.subscribeAll',
            params: {},
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision
          },
          {
            onResponse: (response: RuntimeRpcResponse<unknown>) =>
              handleGlobalSessionTabsOnResponse({
                response,
                isCurrent,
                environmentId,
                expectedEnvironmentConnectionGeneration,
                awaitingVisibilityResumeInventory,
                setAwaitingVisibilityResumeInventory: (v: boolean) => {
                  awaitingVisibilityResumeInventory = v
                },
                isVisibilityRestart,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration,
                visibilityGeneration
              }),
            onError: (error) => {
              if (isCurrent()) {
                console.warn('[web-session-tabs-sync] global subscription error:', error.message)
              }
            }
          }
        )
      }
    })
  }
  return { specs, environmentIdBySubscriptionSpec }
}
