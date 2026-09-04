import type {
  RuntimePtyWorktreeRecord,
  RuntimeAgentRowSnapshot,
  AgentStatusIpcPayload,
  AgentStatusEntry
} from '../../shared/runtime-types'
import type { RuntimeOrchestrationCommands } from './runtime-orchestration-commands'
import type { RuntimeLeafRecord } from '../providers/types'

export type RuntimeHookAgentRowResolutionCommandsDeps = {
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  leaves: Map<string, RuntimeLeafRecord>
  latestAgentStatusByPaneKey: Map<string, RuntimeAgentRowSnapshot>
  handles: Map<string, unknown>
  tabs: Map<string, unknown>
  runtimeId: string
  getLeafKey: (tabId: string, leafId: string) => string
  getLivePtyForHandle: (handle: string) => unknown
  parsePaneKey: (paneKey: string) => { tabId: string; leafId: string } | null
  isTerminalLeafId: (leafId: string) => boolean
  makePaneKey: (tabId: string, leafId: string) => string
  pickParsedAgentStatusPayload: (payload: AgentStatusIpcPayload) => unknown
  getUnpersistedTrackedTitleForPty: (ptyId: string | null) => string | null
  getLatestAgentCandidateTitle: (
    a: { title?: string | null; updatedAt?: number } | null,
    b: { title?: string | null; updatedAt?: number } | null
  ) => string | null
  getLatestPtyTitle: (pty: RuntimePtyWorktreeRecord) => string | null
  classifyAgentTitle: (title: string | null) => string
  terminalTitleBlocksExplicitAgentStatus: (title: string | null | undefined) => boolean
  resolvePaneAgentOwner: (opts: {
    launchAgent: string | null
    hookAgent: string | null | undefined
  }) => string | null
  normalizeCompatibleAgentTitleForOwner: (title: string | null, agent: string | null) => string
  normalizeCompatibleAgentStatusEntryForOwner: (
    entry: unknown,
    agent: string | null
  ) => AgentStatusEntry
  orchestrationCommands?: RuntimeOrchestrationCommands | null
}
