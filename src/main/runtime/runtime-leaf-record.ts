import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeSyncedLeaf } from '../../shared/runtime-types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { RetainedTailRedrawCursor } from './runtime-tail-redraw'
import type { TerminalTailWaitState } from './runtime-tail-read'

export type RuntimeLeafRecord = RuntimeSyncedLeaf & {
  ptyGeneration: number
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  lastExitCode: number | null
  lastExitCause: TerminalExitCause | null
  tailBuffer: string[]
  tailTranscriptBuffer: string[]
  tailTranscriptChars: number
  tailPartialLine: string
  tailPendingAnsi: string
  tailRedrawCursor: RetainedTailRedrawCursor | null
  tailTruncated: boolean
  tailLinesTotal: number
  preview: string
  waitBlockedAt: number | null
  // Why: memoized wait scan of the current retained tail so the next PTY chunk
  // reuses it as its "previous" state instead of rebuilding + rescanning the
  // full tail. See computeTerminalTailWaitState.
  tailWaitState?: TerminalTailWaitState
  lastAgentStatus: AgentStatus | null
  // Why: seeded status is a historical title replayed on restore, so it cannot
  // authorize a PTY write. Only a live OSC observation sets this true; push
  // delivery reads it so a cold-restored `idle` never types into a working agent.
  lastAgentStatusObservedLive: boolean
  // Why: the most recent OSC title observed on this leaf's PTY data. Used by
  // worktree.ps so daemon-hosted terminals (no renderer pushing pane titles)
  // still recompute working/idle from the live title each call instead of
  // serving a stale `lastAgentStatus` after the agent process exits and the
  // shell takes over the title — the bug behind issue #1437.
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  paneTitleUpdatedAt: number | null
}
