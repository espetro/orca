import type { OrchestrationDb } from './orchestration/db'
import type { Store } from '../../shared/store'
import type { RuntimeLeafTerminal, RuntimePtyWorktreeRecord } from '../../shared/runtime-types'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../shared/orchestration-compatibility-evidence'
import type { OrchestrationMailboxNotificationCoordinator } from './orchestration/mailbox-notification-coordinator'
import type { AgentSessionPtyWriteAdmittance } from './agent-session-pty-write-gate'

export type RuntimeOrchestrationCommandsDeps = {
  store: Store | null | undefined
  orchestrationDb: OrchestrationDb | null
  orchestrationMailboxNotifications: OrchestrationMailboxNotificationCoordinator
  orchestrationPointerAdmissionByPtyId: Map<string, AgentSessionPtyWriteAdmittance>
  orchestrationCompatibilitySshAttachments: Map<
    string,
    OrchestrationCompatibilityTerminalAuthority['hostScope'] & {
      connectionIncarnation: string
      attachmentId: string
    }
  >
  restoredOrchestrationAuthorityByPtyId: Map<string, OrchestrationCompatibilityTerminalAuthority>
  ptyController: {
    write?: (ptyId: string, data: string) => boolean
    writeWithSettlement?: (ptyId: string, data: string) => Promise<boolean>
  } | null
  leaves: Map<string, RuntimeLeafTerminal>
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  recordFeatureInteraction?: (id: string, details?: Record<string, unknown>) => void
  issueHandle: (leaf: RuntimeLeafTerminal) => string
  issuePtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  makeRuntimePaneKey: (leaf: RuntimeLeafTerminal) => string
  getRecentSettledDispatchForTerminal: (
    handle: string,
    db: OrchestrationDb | null | undefined
  ) => unknown
  getWorktreeIdForTerminalHandle: (handle: string) => string | null
  getTerminalHandleForPaneKey: (paneKey: string) => string | null
  getPaneKeyForTerminalHandle: (handle: string) => string | undefined
  getOrchestrationDispatchAuthority: (
    handle: string
  ) => OrchestrationCompatibilityTerminalAuthority | null
  getLeavesForPty: (ptyId: string) => RuntimeLeafTerminal[]
  getLeafKey: (tabId: string, leafId: string) => string
  handleByLeafKey: Map<string, string>
}
