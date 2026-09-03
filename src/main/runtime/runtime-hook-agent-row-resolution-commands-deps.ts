import type { RuntimePtyWorktreeRecord } from '../providers/types'

export type RuntimeHookAgentRowResolutionCommandsDeps = {
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  leaves: Map<string, any>
  latestAgentStatusByPaneKey: Map<string, any>
  handles: Map<string, any>
  runtimeId: string
  titleObservationSequence: number
  tabs: Map<string, any>
  getLeafKey: (tabId: string, leafId: string) => string
  issueHandle: (leaf: any) => string
  issuePtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  getLivePtyForHandle: (handle: string) => any
  getLiveLeafForHandle: (handle: string) => any
}
