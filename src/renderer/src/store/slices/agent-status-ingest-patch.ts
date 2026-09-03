import type {
  AgentStatusEntry,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { AgentStatusGetFn, AgentStatusSetFn } from './agent-status-action-context'
import type {
  AgentStatusMetadata,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-types'
import { buildAgentStatusIngestEntry } from './agent-status-ingest-entry'
import { applyAgentStatusIngestCommit } from './agent-status-ingest-commit'

export function applyAgentStatusIngestPatch(
  paneKey: string,
  payload: ParsedAgentStatusPayload,
  terminalTitle: string | undefined,
  updatedAt: number,
  timing: AgentStatusTiming | undefined,
  routing: AgentStatusRouting | undefined,
  metadata: AgentStatusMetadata | undefined,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn,
  out: {
    completionRefreshWorktreeId: string | null
    suppressedInheritedTerminalStatus: boolean
    generatedTitleEntry: AgentStatusEntry | null
  }
): void {
  set((s) => {
    const existing = s.agentStatusByPaneKey[paneKey]
    // Why: snapshots and live pushes share one timestamp source, so equal timestamps carry
    // identical data; strict < preserves same-millisecond live-after-live updates.
    if (existing && updatedAt < existing.updatedAt) {
      return s
    }
    const inputs = buildAgentStatusIngestEntry(
      paneKey,
      payload,
      existing,
      terminalTitle,
      updatedAt,
      timing,
      routing,
      metadata,
      s,
      out
    )
    if (inputs === null) {
      return s
    }
    return applyAgentStatusIngestCommit(paneKey, updatedAt, s, {
      ...inputs,
      payload,
      existing
    })
  })
}
