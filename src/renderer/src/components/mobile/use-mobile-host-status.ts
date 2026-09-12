import { useEffect, useState } from 'react'
import { callRuntimeResult } from '@/web/preload-api/web-runtime-calls'
import type { RuntimeDesktopWindowStatus } from '../../../../shared/runtime-session-contracts'

// Why inline: Subagent 1 owns the canonical `mobile-pairing-rpc-contract.ts`; the renderer
// only needs the four fields the UI gate branches on, so duplicating them here keeps the
// gate hook independent until the shared module lands.
export type MobileHostStatus = {
  desktopWindowStatus: RuntimeDesktopWindowStatus | null
  hostMode: 'desktop' | 'serve'
  relayAvailable: boolean
  webSocketEndpoint: string | null
}

export type MobileHostStatusState =
  | { state: 'loading' }
  | { state: 'loaded'; status: MobileHostStatus }
  | { state: 'unavailable' }

export function useMobileHostStatus(): MobileHostStatusState {
  const [state, setState] = useState<MobileHostStatusState>({ state: 'loading' })

  // Why one fetch on mount: hostMode/desktopWindowStatus do not flip while the page is
  // open, so re-querying would only churn renders. A reconnect/reopen re-mounts the hook.
  useEffect(() => {
    let cancelled = false
    void callRuntimeResult<MobileHostStatus>('mobile.hostStatus')
      .then((status) => {
        if (!cancelled) {
          setState({ state: 'loaded', status })
        }
      })
      .catch(() => {
        // Why: older hosts answer `method_not_found`; the gate then renders the
        // pre-gate "unavailable" surface so we never blank a current page.
        if (!cancelled) {
          setState({ state: 'unavailable' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
