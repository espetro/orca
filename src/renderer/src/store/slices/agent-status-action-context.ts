import type { AppState } from '../types'

// Deliberately narrower than zustand's `set`: no `replace` parameter, so no call
// site in this slice family can compile into a REPLACE the batch commit is
// unable to express.
export type AgentStatusSetFn = (update: (state: AppState) => AppState | Partial<AppState>) => void

export type AgentStatusGetFn = () => AppState

// Injected into every extracted slice action so reducers stay pure with respect
// to the store shape while effects (freshness scheduling, IPC) stay at the
// slice-composer boundary.
export type AgentStatusActionContext = {
  get: AgentStatusGetFn
  set: AgentStatusSetFn
}
