import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import {
  getAgentRowGeneratedTitleText,
  orchestrationLabelsMatchLiveDispatch
} from '@/lib/agent-row-primary-text'
import {
  retireAgentPaneAuthorityReducer,
  restoreAgentPaneAuthorityReducer,
  transferAgentPaneAuthorityReducer
} from './agent-pane-authority-actions'
import {
  mergeCurrentOrchestrationContext,
  orchestrationMapsEqual
} from './agent-status-orchestration'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key'
import {
  copyLaunchConfig,
  launchConfigRegistryEntriesEqual,
  normalizeLaunchConfigRegistrationMetadata,
  registryEntryMatchesStatus
} from './agent-launch-config-registry'
import { sleepingRecordFromEntry } from './agent-sleeping-sessions'
import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata
} from './agent-status-types'
import type { AgentStatusGetFn, AgentStatusSetFn } from './agent-status-action-context'

export function retireAgentPaneAuthorityAction(
  paneKey: string,
  options: { preserveSleepingAgentSession?: boolean } | undefined,
  scheduleFreshness: () => void,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  let hadLive = false
  let ownerPaneKey = paneKey
  set((s) => {
    const result = retireAgentPaneAuthorityReducer(s, paneKey, options)
    hadLive = result.hadLive
    ownerPaneKey = result.ownerPaneKey
    return result.patch
  })
  if (hadLive) {
    queueMicrotask(() => scheduleFreshness())
  }
  if (typeof window !== 'undefined') {
    window.api?.agentStatus?.retirePaneAuthority?.(ownerPaneKey)
  }
}

export function restoreAgentPaneAuthorityAction(
  paneKey: string,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  let ownerPaneKey = paneKey
  set((s) => {
    const result = restoreAgentPaneAuthorityReducer(s, paneKey)
    ownerPaneKey = result.ownerPaneKey
    return result.patch ?? s
  })
  if (typeof window !== 'undefined') {
    window.api?.agentStatus?.restorePaneAuthority?.(ownerPaneKey)
  }
}

export function transferAgentPaneAuthorityAction(
  {
    fromPaneKey,
    toPaneKey,
    ptyId
  }: {
    fromPaneKey: string
    toPaneKey: string
    ptyId?: string | null
  },
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  type TransferHit = { from: string; to: string; ptyId?: string | null }
  const captured: { value: TransferHit | null } = { value: null }
  set((s) => {
    const result = transferAgentPaneAuthorityReducer(s, { fromPaneKey, toPaneKey, ptyId })
    if (!result) {
      return s
    }
    captured.value = { from: result.from, to: result.to, ptyId: result.ptyId }
    return result.patch
  })
  const transferResult = captured.value
  if (typeof window !== 'undefined' && transferResult) {
    window.api?.agentStatus?.transferPaneAuthority?.({
      fromPaneKey: transferResult.from,
      toPaneKey: transferResult.to,
      ...(transferResult.ptyId ? { ptyId: transferResult.ptyId } : {})
    })
  }
}

export function setRuntimeAgentOrchestrationByPaneKeyAction(
  entries: Record<string, AgentStatusOrchestrationContext>,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  const generatedTitleUpdates: AgentStatusEntry[] = []
  set((s) => {
    const runtimeMapChanged = !orchestrationMapsEqual(s.runtimeAgentOrchestrationByPaneKey, entries)
    let nextLive = s.agentStatusByPaneKey
    let liveChanged = false
    let nextRetained = s.retainedAgentsByPaneKey
    let retainedChanged = false

    for (const [paneKey, runtimeOrchestration] of Object.entries(entries)) {
      const liveEntry = nextLive[paneKey]
      if (liveEntry) {
        const merged = mergeCurrentOrchestrationContext(
          liveEntry.orchestration,
          runtimeOrchestration
        )
        if (merged !== liveEntry.orchestration) {
          if (!liveChanged) {
            nextLive = { ...nextLive }
            liveChanged = true
          }
          const nextEntry = { ...liveEntry, orchestration: merged }
          nextLive[paneKey] = nextEntry
          // Why: only replace titles when labels match the live dispatch taskId; sticky completed context must not rename a later turn.
          if (
            (merged.displayName?.trim() || merged.taskTitle?.trim()) &&
            orchestrationLabelsMatchLiveDispatch({
              prompt: nextEntry.prompt,
              orchestration: merged
            })
          ) {
            generatedTitleUpdates.push(nextEntry)
          }
        }
      }

      const retainedEntry = nextRetained[paneKey]
      if (retainedEntry) {
        const merged = mergeCurrentOrchestrationContext(
          retainedEntry.entry.orchestration,
          runtimeOrchestration
        )
        if (merged !== retainedEntry.entry.orchestration) {
          if (!retainedChanged) {
            nextRetained = { ...nextRetained }
            retainedChanged = true
          }
          nextRetained[paneKey] = {
            ...retainedEntry,
            entry: { ...retainedEntry.entry, orchestration: merged }
          }
        }
      }
    }

    if (!runtimeMapChanged && !liveChanged && !retainedChanged) {
      return s
    }

    return {
      ...(runtimeMapChanged ? { runtimeAgentOrchestrationByPaneKey: entries } : {}),
      ...(liveChanged ? { agentStatusByPaneKey: nextLive } : {}),
      ...(retainedChanged ? { retainedAgentsByPaneKey: nextRetained } : {}),
      ...(liveChanged ? { agentStatusEpoch: s.agentStatusEpoch + 1 } : {})
    }
  })
  for (const entry of generatedTitleUpdates) {
    get().setGeneratedTabTitleFromAgentPrompt(entry.paneKey, getAgentRowGeneratedTitleText(entry), {
      replaceExistingGeneratedTitle: true
    })
  }
}

export function registerAgentLaunchConfigAction(
  paneKey: string,
  launchConfig: SleepingAgentLaunchConfig,
  metadata: AgentLaunchConfigRegistrationMetadata | undefined,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    const copiedLaunchConfig = copyLaunchConfig(launchConfig)
    const nextRegistryEntry: AgentLaunchConfigRegistryEntry = {
      launchConfig: copiedLaunchConfig,
      registeredAt: Date.now(),
      identity: normalizeLaunchConfigRegistrationMetadata(paneKey, metadata)
    }
    const existingRegistryEntry = s.agentLaunchConfigByPaneKey[paneKey]
    const registryChanged = !launchConfigRegistryEntriesEqual(
      existingRegistryEntry,
      nextRegistryEntry
    )
    const existingEntry = s.agentStatusByPaneKey[paneKey]
    const entryMatchesRegistry = registryEntryMatchesStatus({
      entry: nextRegistryEntry,
      paneKey,
      agentType: existingEntry?.agentType,
      tabId: existingEntry?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined,
      terminalHandle: existingEntry?.terminalHandle,
      launchToken: metadata?.launchToken,
      providerSession: existingEntry?.providerSession,
      existingProviderSession: existingEntry?.providerSession,
      providerSessionChanged: false
    })
    const existingSleepingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
    let nextSleepingAgentSessions = s.sleepingAgentSessionsByPaneKey
    if (existingSleepingRecord && entryMatchesRegistry && existingEntry) {
      const worktreeId =
        existingEntry.worktreeId ??
        existingSleepingRecord.worktreeId ??
        findAgentPaneWorktreeId(s, paneKey)
      const refreshedRecord = worktreeId
        ? sleepingRecordFromEntry({
            state: s,
            entry: existingEntry,
            worktreeId,
            capturedAt: existingSleepingRecord.capturedAt,
            launchConfig: copiedLaunchConfig,
            origin: existingSleepingRecord.origin
          })
        : null
      if (refreshedRecord) {
        nextSleepingAgentSessions = {
          ...s.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            ...refreshedRecord,
            capturedAt: existingSleepingRecord.capturedAt
          }
        }
      }
    }
    if (!registryChanged && nextSleepingAgentSessions === s.sleepingAgentSessionsByPaneKey) {
      return s
    }
    return {
      ...(registryChanged
        ? {
            agentLaunchConfigByPaneKey: {
              ...s.agentLaunchConfigByPaneKey,
              [paneKey]: nextRegistryEntry
            }
          }
        : {}),
      ...(nextSleepingAgentSessions !== s.sleepingAgentSessionsByPaneKey
        ? { sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions }
        : {})
    }
  })
}

export function clearAgentLaunchConfigAction(
  paneKey: string,
  get: AgentStatusGetFn,
  set: AgentStatusSetFn
): void {
  set((s) => {
    if (!(paneKey in s.agentLaunchConfigByPaneKey)) {
      return s
    }
    const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
    delete nextLaunchConfigs[paneKey]
    return { agentLaunchConfigByPaneKey: nextLaunchConfigs }
  })
}
