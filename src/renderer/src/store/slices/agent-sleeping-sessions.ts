import type { DropAgentStatusByWorktreeOptions } from './agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '@/lib/live-resume-anchor-record'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '../types'
import { findTabForAgentEntry } from './agent-status-retention'
import {
  copyLaunchConfig,
  getLaunchConfigForEntry,
  launchConfigsEqual
} from './agent-launch-config-registry'

export function paneKeyMatchesAnyTabPrefix(paneKey: string, tabPrefixes: string[]): boolean {
  for (const prefix of tabPrefixes) {
    if (paneKey.startsWith(prefix)) {
      return true
    }
  }
  return false
}

export function normalizePaneKeySet(
  paneKeys: DropAgentStatusByWorktreeOptions['sleepingPaneKeys']
): ReadonlySet<string> | null {
  if (!paneKeys) {
    return null
  }
  return paneKeys instanceof Set ? paneKeys : new Set(paneKeys)
}

export function sleepingRecordFromEntry(args: {
  state: AppState
  entry: AgentStatusEntry
  worktreeId: string
  tab?: TerminalTab
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
}): SleepingAgentSessionRecord | null {
  const agent = args.entry.agentType
  if (
    args.entry.terminalResumeEligible === false ||
    !isResumableTuiAgent(agent) ||
    !args.entry.providerSession ||
    !getAgentResumeArgv(agent, args.entry.providerSession)
  ) {
    return null
  }
  const tab = args.tab ?? findTabForAgentEntry(args.state, args.worktreeId, args.entry)
  return {
    paneKey: args.entry.paneKey,
    ...(tab ? { tabId: tab.id } : {}),
    worktreeId: args.worktreeId,
    agent,
    providerSession: args.entry.providerSession,
    ...(args.entry.connectionId !== undefined ? { connectionId: args.entry.connectionId } : {}),
    prompt: args.entry.prompt,
    state: args.entry.state,
    capturedAt: args.capturedAt,
    updatedAt: args.entry.updatedAt,
    ...((args.entry.terminalTitle ?? tab?.title)
      ? { terminalTitle: (args.entry.terminalTitle ?? tab?.title)! }
      : {}),
    ...(args.entry.lastAssistantMessage
      ? { lastAssistantMessage: args.entry.lastAssistantMessage }
      : {}),
    ...(args.launchConfig ? { launchConfig: copyLaunchConfig(args.launchConfig) } : {}),
    ...(args.entry.interrupted ? { interrupted: true } : {}),
    ...(args.origin ? { origin: args.origin } : {})
  }
}

export type CollectSleepingAgentSessionRecordsOptions = {
  paneKeys?: readonly string[]
  captureMode?: 'manual-worktree-sleep' | 'completed-agent-hibernation'
}

export function normalizeSleepingAgentSessionCollectOptions(
  options: readonly string[] | CollectSleepingAgentSessionRecordsOptions | undefined
): CollectSleepingAgentSessionRecordsOptions {
  if (!options) {
    return {}
  }
  return Array.isArray(options)
    ? { paneKeys: options }
    : (options as CollectSleepingAgentSessionRecordsOptions)
}

export function isValidCompletedAgentHibernationEntry(entry: AgentStatusEntry): boolean {
  return entry.state === 'done' && entry.interrupted !== true
}

export function markManualSleepLazyRestore(record: SleepingAgentSessionRecord): void {
  if (record.state === 'done') {
    record.restoreOnTabOpenOnly = true
  }
}

export function isDurableSleepingCapture(record: SleepingAgentSessionRecord): boolean {
  return record.origin === 'worktree-sleep' || record.origin === 'quit'
}

export function manualSleepCaptureEntry(
  entry: AgentStatusEntry,
  capturedAt: number
): AgentStatusEntry {
  return { ...entry, updatedAt: capturedAt, interrupted: false }
}

export function carryOverAutomaticResumeBlock(
  record: SleepingAgentSessionRecord,
  previous: SleepingAgentSessionRecord | undefined
): void {
  if (
    previous?.automaticResumeBlockedBy === 'legacy-orchestration-worker' &&
    previous.agent === record.agent &&
    agentProviderSessionsEqual(record.agent, previous.providerSession, record.providerSession)
  ) {
    record.automaticResumeBlockedBy = previous.automaticResumeBlockedBy
  }
}

export function removeSleepingRecordsReplacedByManualWorktreeSleep(
  records: Record<string, SleepingAgentSessionRecord>,
  worktreeId: string,
  paneKeys?: readonly string[],
  replacements?: Readonly<Record<string, SleepingAgentSessionRecord>>
): { records: Record<string, SleepingAgentSessionRecord>; changed: boolean } {
  const allowedPaneKeys = paneKeys ? new Set(paneKeys) : null
  let next = records
  let changed = false
  for (const [paneKey, record] of Object.entries(records)) {
    if (record.worktreeId !== worktreeId || (allowedPaneKeys && !allowedPaneKeys.has(paneKey))) {
      continue
    }
    if (!replacements?.[paneKey] && isDurableSleepingCapture(record)) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    delete next[paneKey]
    changed = true
  }
  return { records: next, changed }
}

function collectLiveRecoveryRecordsForWorktree(
  state: AppState,
  worktreeId: string,
  allowedPaneKeys: ReadonlySet<string> | null,
  capturedAt: number,
  records: Record<string, SleepingAgentSessionRecord>,
  promotedKeys: Set<string>
): void {
  for (const existing of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    const liveEntry = state.agentStatusByPaneKey[existing.paneKey]
    if (
      existing.worktreeId !== worktreeId ||
      existing.origin !== 'live' ||
      (liveEntry !== undefined &&
        !isCompletedPiCompatibleAgentWithLiveRecoveryRecord(liveEntry, existing)) ||
      (allowedPaneKeys && !allowedPaneKeys.has(existing.paneKey)) ||
      !getAgentResumeArgv(existing.agent, existing.providerSession)
    ) {
      continue
    }
    records[existing.paneKey] = {
      ...existing,
      state: 'working',
      capturedAt,
      updatedAt: capturedAt,
      origin: 'worktree-sleep'
    }
    promotedKeys.add(existing.paneKey)
  }
}

export function collectSleepingAgentSessionRecordsForWorktree(
  state: AppState,
  worktreeId: string,
  options?: readonly string[] | CollectSleepingAgentSessionRecordsOptions
): Record<string, SleepingAgentSessionRecord> {
  const capturedAt = Date.now()
  const collectOptions = normalizeSleepingAgentSessionCollectOptions(options)
  const allowedPaneKeys = collectOptions.paneKeys ? new Set(collectOptions.paneKeys) : null
  const isManualWorktreeSleep = collectOptions.captureMode === 'manual-worktree-sleep'
  const isCompletedAgentHibernation = collectOptions.captureMode === 'completed-agent-hibernation'
  const isWorktreeOwnedCapture = isManualWorktreeSleep || isCompletedAgentHibernation
  const origin: SleepingAgentSessionRecord['origin'] | undefined = isWorktreeOwnedCapture
    ? 'worktree-sleep'
    : undefined
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const records: Record<string, SleepingAgentSessionRecord> = {}
  const promotedLiveRecoveryPaneKeys = new Set<string>()

  if (isManualWorktreeSleep) {
    collectLiveRecoveryRecordsForWorktree(
      state,
      worktreeId,
      allowedPaneKeys,
      capturedAt,
      records,
      promotedLiveRecoveryPaneKeys
    )
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (
      isCompletedAgentHibernation ||
      (allowedPaneKeys && !allowedPaneKeys.has(retained.entry.paneKey))
    ) {
      continue
    }
    if (
      retained.worktreeId !== worktreeId ||
      promotedLiveRecoveryPaneKeys.has(retained.entry.paneKey)
    ) {
      continue
    }
    const record = sleepingRecordFromEntry({
      state,
      entry: isManualWorktreeSleep
        ? manualSleepCaptureEntry(retained.entry, capturedAt)
        : retained.entry,
      worktreeId,
      tab: retained.tab,
      capturedAt,
      launchConfig: getLaunchConfigForEntry(state, retained.entry),
      origin
    })
    if (record) {
      if (isManualWorktreeSleep) {
        markManualSleepLazyRestore(record)
        carryOverAutomaticResumeBlock(
          record,
          state.sleepingAgentSessionsByPaneKey[retained.entry.paneKey]
        )
      }
      records[record.paneKey] = record
    }
  }

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (
      (allowedPaneKeys && !allowedPaneKeys.has(paneKey)) ||
      promotedLiveRecoveryPaneKeys.has(paneKey)
    ) {
      continue
    }
    const belongsToWorktree =
      entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
    if (
      !belongsToWorktree ||
      (isCompletedAgentHibernation && !isValidCompletedAgentHibernationEntry(entry))
    ) {
      continue
    }
    const record = sleepingRecordFromEntry({
      state,
      entry: isManualWorktreeSleep ? manualSleepCaptureEntry(entry, capturedAt) : entry,
      worktreeId,
      capturedAt,
      launchConfig: getLaunchConfigForEntry(state, entry),
      origin
    })
    if (record) {
      if (isManualWorktreeSleep) {
        markManualSleepLazyRestore(record)
        carryOverAutomaticResumeBlock(record, state.sleepingAgentSessionsByPaneKey[paneKey])
      }
      records[record.paneKey] = record
    }
  }

  return records
}

export function sleepingRecordsEquivalentIgnoringCaptureTime(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.paneKey === next.paneKey &&
    existing.tabId === next.tabId &&
    existing.worktreeId === next.worktreeId &&
    existing.agent === next.agent &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    existing.prompt === next.prompt &&
    existing.state === next.state &&
    existing.updatedAt === next.updatedAt &&
    existing.terminalTitle === next.terminalTitle &&
    existing.lastAssistantMessage === next.lastAssistantMessage &&
    existing.interrupted === next.interrupted &&
    existing.origin === next.origin &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

export function recoveryRecordMatches(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.origin === next.origin &&
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    existing.state === next.state &&
    existing.interrupted === next.interrupted &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

export function recoveryRecordTargetsSameSession(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession)
  )
}
