import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '@/lib/live-resume-anchor-record'
import { findAgentPaneWorktreeId } from './agent-status-pane-key'
import { getLaunchConfigForEntry } from './agent-launch-config-registry'
import {
  collectSleepingAgentSessionRecordsForWorktree,
  recoveryRecordTargetsSameSession,
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  sleepingRecordFromEntry,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-sleeping-sessions'
import type { AllAgentSessionCaptureMode } from './agent-status-types'
import type { AgentStatusGetFn, AgentStatusSetFn } from './agent-status-action-context'

export function captureSleepingAgentSessionsByWorktreeAction(
  worktreeId: string,
  paneKeys: string[] | undefined,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    const records = collectSleepingAgentSessionRecordsForWorktree(s, worktreeId, {
      paneKeys,
      captureMode: 'manual-worktree-sleep'
    })
    const replaced = removeSleepingRecordsReplacedByManualWorktreeSleep(
      s.sleepingAgentSessionsByPaneKey,
      worktreeId,
      paneKeys,
      records
    )
    const next: Record<string, SleepingAgentSessionRecord> = { ...replaced.records }
    let changed = replaced.changed

    for (const record of Object.values(records)) {
      if (next[record.paneKey] !== record) {
        next[record.paneKey] = record
        changed = true
      }
    }

    return changed ? { sleepingAgentSessionsByPaneKey: next } : s
  })
}

export function captureAllSleepingAgentSessionsAction(
  mode: AllAgentSessionCaptureMode,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  // Why: periodic checkpoints and quit flushes both persist provider ids, but only a confirmed quit may claim quit precedence.
  set((s) => {
    const capturedAt = Date.now()
    const origin = mode === 'quit' ? ('quit' as const) : ('live' as const)
    const next: Record<string, SleepingAgentSessionRecord> = {
      ...s.sleepingAgentSessionsByPaneKey
    }
    let changed = false
    for (const entry of Object.values(s.agentStatusByPaneKey)) {
      if (entry.state === 'done') {
        const existing = next[entry.paneKey]
        if (!isCompletedPiCompatibleAgentWithLiveRecoveryRecord(entry, existing)) {
          continue
        }
        if (mode === 'periodic') {
          continue
        }
        const record = { ...existing, capturedAt, origin }
        if (!sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
          next[entry.paneKey] = record
          changed = true
        }
        continue
      }
      const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey)
      if (!worktreeId) {
        continue
      }
      const record = sleepingRecordFromEntry({
        state: s,
        entry,
        worktreeId,
        capturedAt,
        launchConfig: getLaunchConfigForEntry(s, entry),
        origin
      })
      const existing = next[entry.paneKey]
      // Why: a periodic timer must not downgrade a confirmed-quit shutdown snapshot; a live hook event supersedes it elsewhere.
      if (
        mode === 'periodic' &&
        existing?.origin === 'quit' &&
        record &&
        recoveryRecordTargetsSameSession(existing, record)
      ) {
        continue
      }
      if (record && !sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
        next[record.paneKey] = record
        changed = true
      }
    }
    return changed ? { sleepingAgentSessionsByPaneKey: next } : s
  })
}

export function clearSleepingAgentSessionsByPaneKeyAction(
  paneKeys: readonly string[],
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  if (paneKeys.length === 0) {
    return
  }
  const uniquePaneKeys = new Set(paneKeys)
  set((s) => {
    let nextSleeping = s.sleepingAgentSessionsByPaneKey
    let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
    for (const paneKey of uniquePaneKeys) {
      if (paneKey in nextSleeping) {
        if (nextSleeping === s.sleepingAgentSessionsByPaneKey) {
          nextSleeping = { ...nextSleeping }
        }
        delete nextSleeping[paneKey]
      }
      if (paneKey in nextLaunchConfigs) {
        if (nextLaunchConfigs === s.agentLaunchConfigByPaneKey) {
          nextLaunchConfigs = { ...nextLaunchConfigs }
        }
        delete nextLaunchConfigs[paneKey]
      }
    }
    if (
      nextSleeping === s.sleepingAgentSessionsByPaneKey &&
      nextLaunchConfigs === s.agentLaunchConfigByPaneKey
    ) {
      return s
    }
    return {
      sleepingAgentSessionsByPaneKey: nextSleeping,
      agentLaunchConfigByPaneKey: nextLaunchConfigs
    }
  })
}

export function setSleepingAgentAutomaticResumeBlockedAction(
  paneKey: string,
  blocked: boolean,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    const current = s.sleepingAgentSessionsByPaneKey[paneKey]
    if (
      !current ||
      (blocked
        ? current.automaticResumeBlockedBy === 'legacy-orchestration-worker'
        : current.automaticResumeBlockedBy === undefined)
    ) {
      return s
    }
    const next = { ...current }
    if (blocked) {
      next.automaticResumeBlockedBy = 'legacy-orchestration-worker'
    } else {
      delete next.automaticResumeBlockedBy
    }
    return {
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: next
      }
    }
  })
}

export function clearSleepingAgentSessionsByWorktreeAction(
  worktreeId: string,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    let changed = false
    const next: Record<string, SleepingAgentSessionRecord> = {}
    const launchConfigKeysToRemove: string[] = []
    for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
      if (record.worktreeId === worktreeId) {
        changed = true
        launchConfigKeysToRemove.push(paneKey)
        continue
      }
      next[paneKey] = record
    }
    const nextLaunchConfigs =
      launchConfigKeysToRemove.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : null
    if (nextLaunchConfigs) {
      for (const paneKey of launchConfigKeysToRemove) {
        delete nextLaunchConfigs[paneKey]
      }
    }
    return changed
      ? {
          sleepingAgentSessionsByPaneKey: next,
          ...(nextLaunchConfigs ? { agentLaunchConfigByPaneKey: nextLaunchConfigs } : {})
        }
      : s
  })
}

export function pruneSleepingAgentSessionsAction(
  validWorktreeIds: Set<string>,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    let changed = false
    const next: Record<string, SleepingAgentSessionRecord> = {}
    const launchConfigKeysToRemove: string[] = []
    for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
      if (!validWorktreeIds.has(record.worktreeId)) {
        changed = true
        launchConfigKeysToRemove.push(paneKey)
        continue
      }
      next[paneKey] = record
    }
    const nextLaunchConfigs =
      launchConfigKeysToRemove.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : null
    if (nextLaunchConfigs) {
      for (const paneKey of launchConfigKeysToRemove) {
        delete nextLaunchConfigs[paneKey]
      }
    }
    return changed
      ? {
          sleepingAgentSessionsByPaneKey: next,
          ...(nextLaunchConfigs ? { agentLaunchConfigByPaneKey: nextLaunchConfigs } : {})
        }
      : s
  })
}
