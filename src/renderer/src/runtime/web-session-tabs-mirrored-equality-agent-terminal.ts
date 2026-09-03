import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

export function sameAgentStateHistory(
  a: AgentStatusEntry['stateHistory'],
  b: AgentStatusEntry['stateHistory']
): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every(
    (entry, index) =>
      entry.state === b[index]?.state &&
      entry.prompt === b[index]?.prompt &&
      entry.startedAt === b[index]?.startedAt &&
      entry.interrupted === b[index]?.interrupted
  )
}

export function agentStatusEntryEqual(
  a: AgentStatusEntry | undefined,
  b: AgentStatusEntry
): boolean {
  if (!a) {
    return false
  }
  return (
    a.state === b.state &&
    a.workingMode === b.workingMode &&
    a.prompt === b.prompt &&
    a.updatedAt === b.updatedAt &&
    a.stateStartedAt === b.stateStartedAt &&
    a.agentType === b.agentType &&
    a.paneKey === b.paneKey &&
    a.worktreeId === b.worktreeId &&
    a.tabId === b.tabId &&
    a.terminalTitle === b.terminalTitle &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.interactivePrompt === b.interactivePrompt &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.interrupted === b.interrupted &&
    a.promptInteractionKey === b.promptInteractionKey &&
    a.restoredUnconfirmed === b.restoredUnconfirmed &&
    agentProviderSessionsEqual(a.agentType, a.providerSession, b.providerSession) &&
    sameAgentStateHistory(a.stateHistory, b.stateHistory)
  )
}

export function isAgentStatusFresh(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'restoredUnconfirmed'>,
  now: number
): boolean {
  return entry.restoredUnconfirmed !== true && now - entry.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
}

export function isMirroredCommandCodeTurnBump(
  existing: AgentStatusEntry | undefined,
  entry: AgentStatusEntry
): boolean {
  return (
    existing?.agentType === 'command-code' &&
    entry.agentType === 'command-code' &&
    existing.state === 'working' &&
    entry.state === 'working' &&
    entry.stateStartedAt > existing.stateStartedAt
  )
}
export function terminalTabEqual(a: TerminalTab, b: TerminalTab): boolean {
  return (
    a.id === b.id &&
    a.ptyId === b.ptyId &&
    a.worktreeId === b.worktreeId &&
    a.title === b.title &&
    a.defaultTitle === b.defaultTitle &&
    a.quickCommandLabel === b.quickCommandLabel &&
    a.startupCwd === b.startupCwd &&
    a.generatedTitle === b.generatedTitle &&
    a.aiVaultTitle?.agent === b.aiVaultTitle?.agent &&
    a.aiVaultTitle?.sessionId === b.aiVaultTitle?.sessionId &&
    a.aiVaultTitle?.title === b.aiVaultTitle?.title &&
    a.customTitle === b.customTitle &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.generation === b.generation &&
    a.shellOverride === b.shellOverride &&
    a.launchAgent === b.launchAgent &&
    a.pendingActivationSpawn === b.pendingActivationSpawn
  )
}

export function sameTerminalTabs(
  a: readonly TerminalTab[] | undefined,
  b: readonly TerminalTab[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => terminalTabEqual(tab, right[index]!))
}
