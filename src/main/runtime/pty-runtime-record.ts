import type { AgentStatus } from '../../shared/agent-detection'
import type { TerminalTailWaitState } from '../../shared/terminal-tail-wait-state'
import type { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import type { AgentSessionPtyWriteAdmittance } from './agent-session-pty-write-gate'
import type { ProviderBufferAcquisition } from './runtime-provider-buffer'
import type { RuntimeVisibleTerminalState } from './runtime-visible-terminal-state'
import type { TrackedPtyLivenessVerdict } from './runtime-pty-liveness'
import type { RuntimePtyTitleTrackerEntry } from './runtime-pty-title-tracker'
import type { RestoredOrchestrationAuthorityReceipt } from './runtime-orchestration-stored-authority'
import type { RuntimeLeafRecord } from './runtime-leaf-record'

/** Consolidated record for all pty-keyed state in OrcaRuntime.
 *  Fields are optional to support lazy initialization and deletion on pty exit.
 *  Access via ptyRecordsById.get(ptyId)?.field */
export type PtyRuntimeRecord = {
  agentPromptExplicitStatusFloor?: number
  agentPromptLifecycle?: { status: AgentStatus | null; workingSequence: number; updatedAt: number }
  agentPromptPermissionSequence?: number
  agentPromptSubmissionTail?: Promise<void>
  agentStatusOscProcessor?: unknown
  handle?: string
  leaves?: RuntimeLeafRecord[]
  orchestrationPointerAdmission?: AgentSessionPtyWriteAdmittance
  osc7ScanTail?: string
  oscTitleScanTail?: string
  providerBufferAcquisition?: ProviderBufferAcquisition
  providerModeSnapshotScans?: Set<TerminalKittyKeyboardModeTracker>
  providerModeTracker?: TerminalKittyKeyboardModeTracker
  providerSequenceOffset?: number
  providerVisibleRetryAt?: number
  providerVisibleState?: RuntimeVisibleTerminalState
  ptyExitListeners?: Set<() => void>
  ptyLivenessVerdict?: TrackedPtyLivenessVerdict
  ptyTitleTracker?: RuntimePtyTitleTrackerEntry
  restoredOrchestrationAuthority?: RestoredOrchestrationAuthorityReceipt
  setupCompletionToken?: string
  subscriberDrivenProviderAttach?: Promise<boolean>
  terminalCwd?: string
  terminalFileUriHostname?: string
  terminalSpawnCommand?: string
  waitBlockedCheckState?: {
    lastAt: number
    lastWaitState: TerminalTailWaitState | null
    appended: string
    keywordCarry: string
    timer: ReturnType<typeof setTimeout> | null
  }
  wslDistro?: string
}

export function createPtyRecord(_ptyId: string): PtyRuntimeRecord {
  return {}
}

export function removePtyRecord(record: PtyRuntimeRecord): void {
  // Clean up any resources that need disposal
  if (record.ptyExitListeners) {
    record.ptyExitListeners.clear()
  }
  if (record.waitBlockedCheckState?.timer) {
    clearTimeout(record.waitBlockedCheckState.timer)
  }
  if (record.agentStatusOscProcessor) {
    // Dispose if needed
  }
}
