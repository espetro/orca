/* eslint-disable max-lines -- Why: the agent-status slice co-locates live map, retained snapshots, retention-suppression, and tab-prefix sweep so the teardown contract stays readable end-to-end. Splitting across files would scatter the drop/remove/retain interactions that must stay in lockstep. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  agentSubagentsEqual,
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type MigrationUnsupportedPtyEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../../../shared/command-code-turn-boundary'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  getAgentRowGeneratedTitleText,
  getOrcaDispatchTaskId,
  isOrcaDispatchPrompt,
  orchestrationLabelsMatchLiveDispatch
} from '@/lib/agent-row-primary-text'
import { isCompletedPiCompatibleAgentWithLiveRecoveryRecord } from '@/lib/live-resume-anchor-record'
import { retireAgentPaneAuthorityAliasesByOwnerTab } from './agent-pane-authority'
import {
  retireAgentPaneAuthorityReducer,
  restoreAgentPaneAuthorityReducer,
  transferAgentPaneAuthorityReducer
} from './agent-pane-authority-actions'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'
import {
  capLiveAgentStatusesInPlace,
  capRetainedAgents,
  classifyPaneKeyLiveness,
  isRecentlyClosedAgentStatusTab,
  retainedAgentEntryFromLive,
  shouldReplaceRetainedWithLive
} from './agent-status-retention'
import {
  collectWorktreeIdsForConnection,
  pruneMigrationUnsupportedEntries,
  removePaneKeys
} from './agent-status-record-pruning'
import {
  mergeCurrentOrchestrationContext,
  orchestrationMapsEqual
} from './agent-status-orchestration'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-tab-prefix'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key'
import {
  copyLaunchConfig,
  getLaunchConfigForEntry,
  getLaunchConfigForStatusMetadata,
  launchConfigRegistryEntriesEqual,
  normalizeLaunchConfigRegistrationMetadata,
  registryEntryMatchesStatus
} from './agent-launch-config-registry'
import {
  collectSleepingAgentSessionRecordsForWorktree,
  normalizePaneKeySet,
  recoveryRecordMatches,
  recoveryRecordTargetsSameSession,
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  sleepingRecordFromEntry,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-sleeping-sessions'
import type { RetainedAgentEntry } from './agent-status-types'

import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata,
  AgentLaunchConfigStatusMetadata,
  AgentProviderSessionRecordMetadata,
  AgentProviderSessionRouting,
  AgentProviderSessionTiming,
  AgentStatusBatchTransaction,
  AgentStatusBatchUpdate,
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming,
  DropAgentStatusByTabPrefixOptions,
  DropAgentStatusByWorktreeOptions,
  DropHibernatedAgentPaneOptions
} from './agent-status-types'
import type { AllAgentSessionCaptureMode } from './agent-status-types'
export {
  MAX_LIVE_AGENT_STATUSES,
  RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX
} from './agent-status-retention'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'
export type * from './agent-status-types'
export * from './agent-status-types'

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${leafId}`; real-time only, not persisted. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Main-synced dispatch metadata for live panes that may only have title-derived status in the renderer. */
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext>
  /** PTYs still reporting legacy numeric pane keys but with registry-backed UUID proof; stored separately from normal hook-reported status. */
  migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number
  /** SSH connections whose transient rows were cleared and must reject renderer callbacks
   *  until a later reconnect establishes a new connection lifecycle. */
  transientClearedAgentStatusConnectionIds: Record<string, true>
  /** Arm the shared freshness timer after an external mirror writes live rows. */
  scheduleAgentStatusFreshness: () => void

  /** Retained "done" snapshots of agents gone from `agentStatusByPaneKey`, keyed by paneKey so pane re-appearance overwrites; shared by dashboard and sidebar hover. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Durable agent sessions captured on sleep (not live rows); power the one-click CLI resume on wake. */
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>

  /** Ephemeral launch snapshots keyed by pane; hook payloads lack Orca launch settings, so the renderer supplies them from startup. */
  agentLaunchConfigByPaneKey: Record<string, AgentLaunchConfigRegistryEntry>

  /** Pane keys explicitly torn down, forbidden from re-retention on next disappearance; a one-shot suppressor consumed by the retention sync. */
  retentionSuppressedPaneKeys: Record<string, true>

  /** Terminal tabs explicitly closed this session; used to drop late in-flight IPC statuses and stale main-cache replays. */
  recentlyClosedAgentStatusTabIds: Record<string, true>

  /** Exact pane authorities retired while sibling panes in the tab stay live. */
  recentlyRetiredAgentStatusPaneKeys: Record<string, true>

  retireAgentPaneAuthority: (
    paneKey: string,
    options?: { preserveSleepingAgentSession?: boolean }
  ) => void
  /** Lift a pane's retirement fence once a live PTY re-attaches to it. Closed tabs stay retired. */
  restoreAgentPaneAuthority: (paneKey: string) => void
  transferAgentPaneAuthority: (args: {
    fromPaneKey: string
    toPaneKey: string
    ptyId?: string | null
  }) => void

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: AgentStatusPayload,
    terminalTitle?: string,
    timing?: AgentStatusTiming,
    routing?: AgentStatusRouting,
    metadata?: AgentStatusMetadata
  ) => void

  /** Apply ordered status updates as one status publication (generated titles and tab
   *  titles still publish after it — three total, not 2N). */
  setAgentStatuses: (updates: readonly AgentStatusBatchUpdate[]) => boolean[]

  /** Fold caller-derived updates against exact staged state, committing one status publication. */
  transactAgentStatuses: <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ) => Result

  /** Record resume identity without creating a visible turn-status row. */
  recordAgentProviderSession: (
    paneKey: string,
    agent: ResumableTuiAgent,
    providerSession: AgentProviderSessionMetadata,
    timing?: AgentProviderSessionTiming,
    routing?: AgentProviderSessionRouting,
    metadata?: AgentProviderSessionRecordMetadata
  ) => void

  registerAgentLaunchConfig: (
    paneKey: string,
    launchConfig: SleepingAgentLaunchConfig,
    metadata?: AgentLaunchConfigRegistrationMetadata
  ) => void
  getAgentLaunchConfigForStatusEntry: (
    entry: AgentStatusEntry
  ) => SleepingAgentLaunchConfig | undefined
  getAgentLaunchConfigForStatusMetadata: (
    metadata: AgentLaunchConfigStatusMetadata
  ) => SleepingAgentLaunchConfig | undefined
  clearAgentLaunchConfig: (paneKey: string) => void

  setRuntimeAgentOrchestrationByPaneKey: (
    entries: Record<string, AgentStatusOrchestrationContext>
  ) => void

  setMigrationUnsupportedPty: (entry: MigrationUnsupportedPtyEntry) => void
  clearMigrationUnsupportedPty: (ptyId: string) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix (tab close prefix-sweep). */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove stale live rows while preserving pane launch and resume identity. */
  clearTransientAgentStatuses: (connectionId: string, clearedAt: number) => void

  /** Remove a single entry AND suppress re-retention on its next disappearance (user-initiated teardown: X button, pane close). */
  dropAgentStatus: (paneKey: string) => void

  /** Remove all entries under a tab AND suppress re-retention for each (tab close — no rows may reappear). */
  dropAgentStatusByTabPrefix: (
    tabIdPrefix: string,
    opts?: DropAgentStatusByTabPrefixOptions
  ) => void

  /** Remove one auto-hibernated completed-agent pane while preserving sibling live/retained rows in the same worktree. */
  dropHibernatedAgentStatusPane: (
    worktreeId: string,
    paneKey: string,
    opts?: DropHibernatedAgentPaneOptions
  ) => void

  /** Remove all entries for a worktree AND suppress re-retention for live rows (worktree sleep/remove).
   *  Sweeps live rows by tab prefix and by main-stamped worktree attribution so worker rows that arrive before their tab don't survive. */
  dropAgentStatusByWorktree: (worktreeId: string, opts?: DropAgentStatusByWorktreeOptions) => void

  captureSleepingAgentSessionsByWorktree: (worktreeId: string, paneKeys?: string[]) => void
  /** Capture resumable agent sessions across every worktree for crash recovery or quit; mode sets live/quit precedence. */
  captureAllSleepingAgentSessions: (mode: AllAgentSessionCaptureMode) => void
  clearSleepingAgentSession: (paneKey: string) => void
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
  setSleepingAgentAutomaticResumeBlocked: (paneKey: string, blocked: boolean) => void
  clearSleepingAgentSessionsByWorktree: (worktreeId: string) => void
  pruneSleepingAgentSessions: (validWorktreeIds: Set<string>) => void

  /** Retain agent snapshots. Accepts an array so simultaneous disappearances produce a single set() with no mid-loop intermediate states. */
  retainAgents: (entries: RetainedAgentEntry[]) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void

  /** Clear one-shot teardown suppressors after the retention sync declines to retain the row. */
  clearRetentionSuppressedPaneKeys: (paneKeys: string[]) => void
}

function paneKeyMatchesAnyTabPrefix(paneKey: string, tabPrefixes: string[]): boolean {
  for (const prefix of tabPrefixes) {
    if (paneKey.startsWith(prefix)) {
      return true
    }
  }
  return false
}

function isAgentCompletionState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

/** True when auto-title generation would no-op without replace (custom/quick/generated). */
function agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
  state: AppState,
  tabId: string | null,
  worktreeId?: string | null
): boolean {
  if (!tabId) {
    return false
  }
  const ownerTabs = worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  if (ownerTabs) {
    const tab = ownerTabs.find((candidate) => candidate.id === tabId)
    return Boolean(
      tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.generatedTitle?.trim()
    )
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(
      tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || tab.generatedTitle?.trim()
    )
  }
  return false
}

function buildAgentStatusBatchPatch(
  initialState: AppState,
  nextState: AppState
): Partial<AppState> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(nextState) as (keyof AppState)[]) {
    if (!Object.is(nextState[key], initialState[key])) {
      patch[key as string] = nextState[key]
    }
  }
  return patch as Partial<AppState>
}

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  storeSet,
  storeGet
) => {
  type AgentStatusStateUpdate =
    | AppState
    | Partial<AppState>
    | ((state: AppState) => AppState | Partial<AppState>)

  let batchedAgentStatusState: AppState | null = null
  let batchedAgentStatusEffects: (() => void)[] | null = null
  let batchedGeneratedTabTitleUpdates: GeneratedTabTitleUpdate[] | null = null
  let batchedAgentStatusFreshnessRequested = false
  const get = (): AppState => batchedAgentStatusState ?? storeGet()
  // Deliberately narrower than zustand's `set`: no `replace` parameter, so no call site in
  // this slice can compile into a REPLACE the batch commit is unable to express.
  const set = (update: AgentStatusStateUpdate): void => {
    if (batchedAgentStatusState === null) {
      storeSet(update, false)
      return
    }
    const nextState = typeof update === 'function' ? update(batchedAgentStatusState) : update
    if (Object.is(nextState, batchedAgentStatusState)) {
      return
    }
    batchedAgentStatusState = Object.assign({}, batchedAgentStatusState, nextState)
  }
  const runAfterAgentStatusCommit = (effect: () => void): void => {
    if (batchedAgentStatusEffects) {
      batchedAgentStatusEffects.push(effect)
      return
    }
    effect()
  }
  const applyGeneratedTabTitleUpdate = (update: GeneratedTabTitleUpdate): void => {
    if (batchedGeneratedTabTitleUpdates) {
      batchedGeneratedTabTitleUpdates.push(update)
      return
    }
    if (update.options) {
      get().setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt, update.options)
    } else {
      get().setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt)
    }
  }
  const applyBatchedAgentStatusUpdate = (update: AgentStatusBatchUpdate): boolean => {
    const stateBeforeUpdate = batchedAgentStatusState
    if (!stateBeforeUpdate) {
      return false
    }
    if (update.kind === 'providerSession') {
      get().recordAgentProviderSession(
        update.paneKey,
        update.agent,
        update.providerSession,
        update.timing,
        update.routing,
        update.metadata
      )
    } else {
      get().setAgentStatus(
        update.paneKey,
        update.payload,
        update.terminalTitle,
        update.timing,
        update.routing,
        update.metadata
      )
    }
    return batchedAgentStatusState !== stateBeforeUpdate
  }
  const batchTransaction: AgentStatusBatchTransaction = {
    getState: get,
    apply: applyBatchedAgentStatusUpdate,
    afterCommit: runAfterAgentStatusCommit
  }
  const transactAgentStatuses = <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ): Result => {
    if (batchedAgentStatusState) {
      return operation(batchTransaction)
    }
    const initialState = storeGet()
    batchedAgentStatusState = initialState
    batchedAgentStatusEffects = []
    batchedGeneratedTabTitleUpdates = []
    try {
      const result = operation(batchTransaction)
      const nextState = batchedAgentStatusState
      const effects = batchedAgentStatusEffects
      const generatedTabTitleUpdates = batchedGeneratedTabTitleUpdates
      const freshnessRequested = batchedAgentStatusFreshnessRequested
      batchedAgentStatusState = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
      if (nextState !== initialState) {
        storeSet(buildAgentStatusBatchPatch(initialState, nextState), false)
      }
      if (generatedTabTitleUpdates.length > 0) {
        storeGet().setGeneratedTabTitlesFromAgentPrompts(generatedTabTitleUpdates)
      }
      if (freshnessRequested) {
        queueMicrotask(() => freshness.schedule())
      }
      for (const effect of effects) {
        effect()
      }
      return result
    } finally {
      batchedAgentStatusState = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
    }
  }

  // Why: scheduler is process-lifetime-scoped (no dispose) because the store is a
  // module-level singleton with no teardown lifecycle anywhere in the codebase.
  const freshness = createFreshnessScheduler({
    getEntries: () => Object.values(get().agentStatusByPaneKey),
    bumpEpochs: () => {
      // Why: freshness is time-based — bump both epochs at the stale boundary to force selector
      // recompute and re-sort even with no new output, since staleness can change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })
  const requestAgentStatusFreshness = (acceptedInBatch: boolean): void => {
    if (batchedAgentStatusState !== null) {
      batchedAgentStatusFreshnessRequested ||= acceptedInBatch
      return
    }
    queueMicrotask(() => freshness.schedule())
  }

  const clearSleepingAgentSessionsByPaneKey = (paneKeys: readonly string[]): void => {
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

  return {
    agentStatusByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    agentStatusEpoch: 0,
    transientClearedAgentStatusConnectionIds: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    retentionSuppressedPaneKeys: {},
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: {},
    scheduleAgentStatusFreshness: () => freshness.schedule(),

    retireAgentPaneAuthority: (paneKey, options) => {
      let hadLive = false
      let ownerPaneKey = paneKey
      set((s) => {
        const result = retireAgentPaneAuthorityReducer(s, paneKey, options)
        hadLive = result.hadLive
        ownerPaneKey = result.ownerPaneKey
        return result.patch
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.retirePaneAuthority?.(ownerPaneKey)
      }
    },

    restoreAgentPaneAuthority: (paneKey) => {
      let ownerPaneKey = paneKey
      set((s) => {
        const result = restoreAgentPaneAuthorityReducer(s, paneKey)
        ownerPaneKey = result.ownerPaneKey
        return result.patch ?? s
      })
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.restorePaneAuthority?.(ownerPaneKey)
      }
    },

    transferAgentPaneAuthority: ({ fromPaneKey, toPaneKey, ptyId }) => {
      let transferResult: ReturnType<typeof transferAgentPaneAuthorityReducer> = null
      set((s) => {
        transferResult = transferAgentPaneAuthorityReducer(s, { fromPaneKey, toPaneKey, ptyId })
        return transferResult ? transferResult.patch : s
      })
      if (typeof window !== 'undefined' && transferResult) {
        const res = transferResult as NonNullable<typeof transferResult>
        window.api?.agentStatus?.transferPaneAuthority?.({
          fromPaneKey: res.from,
          toPaneKey: res.to,
          ...(res.ptyId ? { ptyId: res.ptyId } : {})
        })
      }
    },

    setRuntimeAgentOrchestrationByPaneKey: (entries) => {
      const generatedTitleUpdates: AgentStatusEntry[] = []
      set((s) => {
        const runtimeMapChanged = !orchestrationMapsEqual(
          s.runtimeAgentOrchestrationByPaneKey,
          entries
        )
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
        get().setGeneratedTabTitleFromAgentPrompt(
          entry.paneKey,
          getAgentRowGeneratedTitleText(entry),
          {
            replaceExistingGeneratedTitle: true
          }
        )
      }
    },

    registerAgentLaunchConfig: (paneKey, launchConfig, metadata) => {
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
    },
    getAgentLaunchConfigForStatusEntry: (entry) => getLaunchConfigForEntry(get(), entry),
    getAgentLaunchConfigForStatusMetadata: (metadata) =>
      getLaunchConfigForStatusMetadata(get(), metadata),

    clearAgentLaunchConfig: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.agentLaunchConfigByPaneKey)) {
          return s
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        delete nextLaunchConfigs[paneKey]
        return { agentLaunchConfigByPaneKey: nextLaunchConfigs }
      })
    },

    recordAgentProviderSession: (paneKey, agent, providerSession, timing, routing, metadata) => {
      paneKey = resolveAgentPaneAuthorityKey(paneKey)
      const updatedAt = timing?.updatedAt ?? Date.now()
      if (
        paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        ) ||
        !getAgentResumeArgv(agent, providerSession)
      ) {
        return
      }
      let removedLiveStatus = false
      set((s) => {
        const existingStatus = s.agentStatusByPaneKey[paneKey]
        const existingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        if (
          (existingStatus && updatedAt < existingStatus.updatedAt) ||
          (existingRecord && updatedAt < existingRecord.updatedAt)
        ) {
          return s
        }
        const tabId = routing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? existingRecord?.tabId
        const worktreeId =
          routing?.worktreeId ??
          existingStatus?.worktreeId ??
          existingRecord?.worktreeId ??
          findAgentPaneWorktreeId(s, paneKey)
        if (!worktreeId) {
          return s
        }
        const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const registryMatches = registryEntryMatchesStatus({
          entry: registryEntry,
          paneKey,
          agentType: agent,
          tabId,
          terminalHandle: undefined,
          launchToken: metadata?.launchToken,
          providerSession,
          existingProviderSession: existingRecord?.providerSession,
          providerSessionChanged: false
        })
        const existingRecordMatchesProviderSession =
          existingRecord?.agent === agent &&
          agentProviderSessionsEqual(agent, existingRecord.providerSession, providerSession)
        // Why: provider-session heartbeats can arrive after the turn is complete; preserve the
        // completed checkpoint so a late heartbeat cannot make it eligible for ghost resume.
        const preservesCompletedRecoveryRecord =
          existingRecordMatchesProviderSession && existingRecord?.state === 'done'
        // Why: an explicit quit capture must remain the resume handle until a new provider session replaces it.
        const preservesQuitOrigin =
          existingRecordMatchesProviderSession && existingRecord?.origin === 'quit'
        const launchConfig =
          (registryMatches ? registryEntry?.launchConfig : undefined) ??
          (existingRecordMatchesProviderSession ? existingRecord.launchConfig : undefined)
        const record: SleepingAgentSessionRecord = {
          paneKey,
          ...(tabId ? { tabId } : {}),
          worktreeId,
          agent,
          providerSession,
          prompt: '',
          // Why: durable process/session identity, not visible turn state; a non-done value keeps cold restore eligible.
          state: preservesCompletedRecoveryRecord ? 'done' : 'working',
          capturedAt: updatedAt,
          updatedAt,
          ...(existingStatus?.terminalTitle
            ? { terminalTitle: existingStatus.terminalTitle }
            : existingRecord?.terminalTitle
              ? { terminalTitle: existingRecord.terminalTitle }
              : {}),
          ...(routing?.connectionId !== undefined
            ? { connectionId: routing.connectionId }
            : existingRecord?.connectionId !== undefined
              ? { connectionId: existingRecord.connectionId }
              : {}),
          ...(launchConfig ? { launchConfig: copyLaunchConfig(launchConfig) } : {}),
          ...(existingRecordMatchesProviderSession &&
          existingRecord.automaticResumeBlockedBy === 'legacy-orchestration-worker'
            ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' }
            : {}),
          ...(preservesCompletedRecoveryRecord && existingRecord.interrupted !== undefined
            ? { interrupted: existingRecord.interrupted }
            : {}),
          origin: preservesQuitOrigin ? 'quit' : 'live'
        }
        removedLiveStatus = existingStatus !== undefined
        const nextLive = removedLiveStatus ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (removedLiveStatus) {
          delete nextLive[paneKey]
        }
        const nextRetained =
          paneKey in s.retainedAgentsByPaneKey
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        if (nextRetained !== s.retainedAgentsByPaneKey) {
          delete nextRetained[paneKey]
        }
        // Why: on identity mismatch the sleeping record drops its launch config, so clear the stale
        // registry entry too, else a later return to the old identity reuses stale args/env.
        let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
        if (registryMatches && registryEntry) {
          nextLaunchConfigs = {
            ...nextLaunchConfigs,
            [paneKey]: {
              ...registryEntry,
              identity: { ...registryEntry.identity, providerSession }
            }
          }
        } else if (registryEntry) {
          nextLaunchConfigs = { ...nextLaunchConfigs }
          delete nextLaunchConfigs[paneKey]
        }
        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          sleepingAgentSessionsByPaneKey: {
            ...s.sleepingAgentSessionsByPaneKey,
            [paneKey]: record
          },
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          acknowledgedAgentsByPaneKey: removePaneKeys(
            s.acknowledgedAgentsByPaneKey,
            new Set([paneKey])
          ),
          unreadAgentCompletionPanes: removePaneKeys(
            s.unreadAgentCompletionPanes,
            new Set([paneKey])
          ),
          agentStatusEpoch: removedLiveStatus ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: removedLiveStatus ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (removedLiveStatus) {
        requestAgentStatusFreshness(true)
      }
    },

    setAgentStatus: (paneKey, payload, terminalTitle, timing, routing, metadata) => {
      paneKey = resolveAgentPaneAuthorityKey(paneKey)
      const updatedAt = timing?.updatedAt ?? Date.now()
      if (
        paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
        // Why: a closed tab is no longer a valid destination for hook replays or late status events.
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        )
      ) {
        return
      }
      let completionRefreshWorktreeId: string | null = null
      let suppressedInheritedTerminalStatus = false
      const generatedTitleEntry: { current: AgentStatusEntry | null } = { current: null }
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        // Why: snapshots and live pushes share one timestamp source, so equal timestamps carry
        // identical data; strict < preserves same-millisecond live-after-live updates.
        if (existing && updatedAt < existing.updatedAt) {
          return s
        }
        // Why: terminalTitle labels the pane itself, not the turn, so a missing title means "no update" —
        // preserve the prior value to avoid flicker (unlike tool/prompt fields, which clear on a fresh turn).
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Rolling log of state transitions for the dashboard's activity blocks; push only on
        // real state changes to avoid dupes from prompt-only pings within the same state.
        // A session-boundary 'done' (idle connect, STA-3386) is not a turn event — keep it
        // out of history so activity feeds and unread counts never surface it. The inverse
        // also holds: a boundary landing on a REAL done (resume//clear right after a finish)
        // must push that completion into history, or the finished timestamp and unread badge
        // lose the turn the moment the flag overwrites the live entry.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        // Why: a batched burst can fold a whole done→working turn into one publication, so a
        // completion-reactive subscriber never sees `lastAssistantMessage` while state is `done`.
        // One slot per entry, not one per history row — 20 transcripts per live status OOMs (#9872).
        let lastCompletedAssistantMessage = existing?.lastCompletedAssistantMessage
        const boundaryLandsOnRealDone =
          existing?.state === 'done' &&
          existing.sessionBoundary !== true &&
          payload.state === 'done' &&
          payload.sessionBoundary === true
        if (
          existing &&
          (existing.state !== payload.state || boundaryLandsOnRealDone) &&
          !(existing.state === 'done' && existing.sessionBoundary === true)
        ) {
          history = [
            ...history,
            {
              state: existing.state,
              prompt: existing.prompt,
              // Why: use stateStartedAt (not updatedAt) so the row reflects when the state was first reported, not the latest within-state ping.
              startedAt: existing.stateStartedAt,
              // Why: preserve the interrupt flag on the historical `done` entry so activity-block views can render past cancellations.
              interrupted: existing.interrupted
            }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
          if (existing.state === 'done') {
            // The push above just moved this completion out of the live entry; a done that
            // carried no message must clear the slot, or a stale prior turn leaks forward.
            lastCompletedAssistantMessage = existing.lastAssistantMessage
          }
        }

        const identity = resolveAgentStatusIdentity({
          existing: existing
            ? {
                agentType: existing.agentType,
                state: existing.state,
                updatedAt: existing.updatedAt,
                restoredUnconfirmed: existing.restoredUnconfirmed
              }
            : undefined,
          incoming: payload.agentType,
          now: updatedAt
        })
        // Why: Command Code has no UserPromptSubmit; a fresh transcript prompt while still `working` is the smart-sort turn boundary.
        const commandCodeNewTurn =
          existing !== undefined &&
          isCommandCodeNewTurnWhileWorking({
            agentType: identity.agentType,
            previousState: existing.state,
            incomingState: payload.state,
            previousPrompt: existing.prompt,
            incomingPrompt: payload.prompt,
            previousPromptInteractionKey: existing.promptInteractionKey,
            incomingPromptInteractionKey: payload.promptInteractionKey
          })
        const promptInteractionKey =
          payload.promptInteractionKey ??
          (payload.prompt === existing?.prompt ? existing?.promptInteractionKey : undefined)
        // Why: prefer main's authoritative stateStartedAt (attachStatusTiming persists it across
        // same-state pings and restart); fall back to existing only when main sent no timing, updatedAt for a new pane.
        const stateStartedAt =
          timing?.stateStartedAt ??
          (commandCodeNewTurn
            ? updatedAt
            : existing && existing.state === payload.state
              ? existing.stateStartedAt
              : updatedAt)
        if (
          existing &&
          shouldSuppressInheritedTerminalStatus({
            inheritedFromActivePane: identity.inheritedFromActivePane,
            incomingState: payload.state
          })
        ) {
          suppressedInheritedTerminalStatus = true
          return s
        }

        // Why: tool/assistant fields arrive pre-merged and authoritative from main (resolveToolState
        // in server.ts), so write them through directly — no fallback — so UserPromptSubmit clears stale tool lines.
        const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[paneKey]
        const runtimeMergedOrchestration = runtimeOrchestration
          ? mergeCurrentOrchestrationContext(existing?.orchestration, runtimeOrchestration)
          : undefined
        const payloadMergedOrchestration = payload.orchestration
          ? mergeCurrentOrchestrationContext(
              runtimeMergedOrchestration ?? existing?.orchestration,
              payload.orchestration
            )
          : undefined
        const completedFallbackOrchestration =
          payload.state === 'done' ? existing?.orchestration : undefined
        const orchestration =
          payloadMergedOrchestration ?? runtimeMergedOrchestration ?? completedFallbackOrchestration
        // Why: waiting/blocked are still the same resumable turn; child permission hooks omit the root session id.
        // Completing a turn does not end the provider session either — the TUI stays alive and resumable at its
        // prompt — so `done` must carry the id through, including done→done (OSC 9999 repaints and reconnect
        // snapshot replays both re-deliver a metadata-less `done` onto an already-done row). Without that, every
        // surface keyed on the id — mobile Chat UI transcripts, the resumable recovery anchor below — loses the
        // session while the agent sits idle, which is precisely when it is read (#10630). Only a new turn
        // (done→working) still drops it, so a reused pane cannot inherit a finished session.
        const canReuseExistingProviderSession =
          existing?.agentType === identity.agentType &&
          (existing.state !== 'done' || payload.state === 'done')
        const providerSession =
          metadata?.providerSession ??
          (canReuseExistingProviderSession ? existing.providerSession : undefined)
        const existingProviderSession = canReuseExistingProviderSession
          ? existing.providerSession
          : undefined
        const providerSessionChanged =
          Boolean(metadata?.providerSession && existingProviderSession) &&
          !agentProviderSessionsEqual(
            identity.agentType,
            metadata?.providerSession,
            existingProviderSession
          )
        const statusTabId =
          routing?.tabId ?? existing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined
        const statusTerminalHandle = routing?.terminalHandle ?? existing?.terminalHandle
        const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const matchedRegistryLaunchConfig = registryEntryMatchesStatus({
          entry: registryEntry,
          paneKey,
          agentType: identity.agentType,
          tabId: statusTabId,
          terminalHandle: statusTerminalHandle,
          launchToken: metadata?.launchToken,
          providerSession,
          existingProviderSession,
          providerSessionChanged
        })
          ? registryEntry?.launchConfig
          : undefined
        const existingSleepingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        // Why: a completed turn leaves the TUI session alive and resumable at its prompt for any
        // resumable agent (Claude/Codex/Pi/…), not just Pi — so keep its persisted recovery anchor
        // even when done. Else a cold restore after an abrupt app death (macOS logout, #9454) drops
        // the pane to a bare shell instead of `--resume`-ing the agent logged in.
        const retainsResumableRecoveryIdentity =
          payload.state === 'done' &&
          isResumableTuiAgent(identity.agentType) &&
          providerSession !== undefined &&
          getAgentResumeArgv(identity.agentType, providerSession) !== null
        const matchedSleepingLaunchConfig =
          (payload.state !== 'done' || retainsResumableRecoveryIdentity) &&
          existingSleepingRecord?.launchConfig &&
          existingSleepingRecord.agent === identity.agentType &&
          providerSession &&
          agentProviderSessionsEqual(
            identity.agentType,
            existingSleepingRecord.providerSession,
            providerSession
          )
            ? existingSleepingRecord.launchConfig
            : undefined
        // Why: on a reused pane key, once the provider session changes the old launch registry must not bleed options into the new session.
        const launchConfigSource =
          (payload.state !== 'done' && !providerSessionChanged && metadata?.launchToken
            ? metadata?.launchConfig
            : undefined) ??
          matchedRegistryLaunchConfig ??
          matchedSleepingLaunchConfig
        const entry: AgentStatusEntry = {
          state: payload.state,
          workingMode: payload.workingMode,
          prompt: payload.prompt,
          updatedAt,
          stateStartedAt,
          agentType: identity.agentType,
          model:
            payload.model ??
            (existing?.agentType === identity.agentType ? existing.model : undefined),
          paneKey,
          terminalHandle: statusTerminalHandle,
          worktreeId:
            routing?.worktreeId ??
            existing?.worktreeId ??
            findAgentPaneWorktreeId(s, paneKey) ??
            undefined,
          ...(routing?.connectionId !== undefined
            ? { connectionId: routing.connectionId }
            : existing?.connectionId !== undefined
              ? { connectionId: existing.connectionId }
              : s.sleepingAgentSessionsByPaneKey[paneKey]?.connectionId !== undefined
                ? { connectionId: s.sleepingAgentSessionsByPaneKey[paneKey].connectionId }
                : {}),
          tabId: statusTabId,
          terminalTitle: effectiveTitle,
          stateHistory: history,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
          // Why: full untruncated AskUserQuestion JSON so mobile/web can render the live prompt
          // card; parseAgentStatusPayload clears it on tool/state change.
          interactivePrompt: payload.interactivePrompt,
          lastAssistantMessage: payload.lastAssistantMessage,
          ...(lastCompletedAssistantMessage ? { lastCompletedAssistantMessage } : {}),
          // Why: reused panes can start non-orchestrated work; only final done rows keep the
          // previous lineage fallback so completed children stay grouped.
          orchestration,
          // Why: reuse the prior array ref when the roster is unchanged so identity-comparing subscribers skip re-renders.
          subagents: agentSubagentsEqual(existing?.subagents, payload.subagents)
            ? existing?.subagents
            : payload.subagents,
          ...(providerSession ? { providerSession } : {}),
          ...(metadata?.terminalResumeEligible === false
            ? { terminalResumeEligible: false as const }
            : {}),
          ...(promptInteractionKey ? { promptInteractionKey } : {}),
          ...(payload.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
          // Why: `updatedAt` cannot order two writes inside one millisecond — and the accept check
          // above admits equal timestamps — so a deferred process-exit drop needs a token ordered by
          // construction to tell "the pane reported again" from "an unrelated field moved". Every
          // field-level rewrite of a row spreads it forward, so only a real report re-stamps it.
          //
          // Derived from the row it replaces, not from a module counter: there is then nothing for a
          // sibling teardown path to reset (the bug this replaced), and a batched burst lands the
          // same ordinals as the equivalent sequential writes.
          acceptedStatusSeq: (existing?.acceptedStatusSeq ?? 0) + 1,
          // Why: never inherited from `existing` — an unstamped write is an unstamped
          // observation, not the previous one repeated.
          ...(payload.observation ? { observation: payload.observation } : {}),
          // Why: `interrupted` is done-only; parseAgentStatusPayload already clamps it for non-done states, so write it through directly.
          interrupted: payload.interrupted,
          // Why: done→done repaints (OSC 9999, reconnect snapshot replays) re-deliver a
          // metadata-less `done`; preserving the flag there keeps completion-reactive
          // consumers from treating the still-idle session as newly finished. Turn evidence
          // (an assistant message or a changed prompt) proves a REAL completion — never
          // carry the flag over one, or a genuine finish could be silently suppressed.
          sessionBoundary:
            payload.sessionBoundary ??
            (existing?.state === 'done' &&
            payload.state === 'done' &&
            payload.lastAssistantMessage === undefined &&
            payload.prompt === existing.prompt
              ? existing.sessionBoundary
              : undefined)
        }
        // Why: a boundary `done` becoming a REAL completion does not advance
        // `stateStartedAt`, so hibernation would still judge the row by its ancient
        // anchor. Stamp it here, synchronously — sampling on the 60s coordinator tick
        // misses a boundary written and cleared between two samples.
        if (
          entry.state === 'done' &&
          entry.sessionBoundary !== true &&
          existing?.sessionBoundary === true
        ) {
          recordHibernationBoundaryResolved(paneKey, updatedAt)
        }
        generatedTitleEntry.current = entry
        if (
          isAgentCompletionState(entry.state) &&
          entry.sessionBoundary !== true &&
          existing !== undefined &&
          !isAgentCompletionState(existing.state)
        ) {
          completionRefreshWorktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, paneKey)
        }
        // Why: emit a global tick only when an entry appears, changes state, crosses stale→fresh,
        // or is a same-state `done` update — same-state working pings must not fan out to aggregates.
        const wasFresh =
          !!existing && isExplicitAgentStatusFresh(existing, updatedAt, AGENT_STATUS_STALE_AFTER_MS)
        // Why: a late main-process attribution stamp can change which workspace stays visible without changing agent state.
        const attributionChanged =
          existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
        // Why: main can advance stateStartedAt on a same-state turn boundary the renderer
        // missed; treat that as sort-relevant so smart sort never goes stale.
        // Non-Command-Code agents never advance stateStartedAt at a fixed state, so this stays CC-scoped.
        const sameStateStateStartedAtChanged =
          !!existing &&
          existing.state === payload.state &&
          entry.stateStartedAt !== existing.stateStartedAt
        const sameStateDoneAttentionChanged =
          existing?.state === 'done' &&
          entry.state === 'done' &&
          agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
        const workingModeChanged = existing?.workingMode !== entry.workingMode
        const sortRelevantChange =
          !existing ||
          existing.state !== payload.state ||
          !wasFresh ||
          attributionChanged ||
          commandCodeNewTurn ||
          sameStateStateStartedAtChanged ||
          sameStateDoneAttentionChanged
        const doneRetentionFieldsChanged =
          existing?.state === 'done' &&
          entry.state === 'done' &&
          (entry.prompt !== existing.prompt ||
            entry.updatedAt !== existing.updatedAt ||
            entry.stateStartedAt !== existing.stateStartedAt ||
            entry.agentType !== existing.agentType ||
            entry.model !== existing.model ||
            entry.terminalTitle !== existing.terminalTitle ||
            entry.toolName !== existing.toolName ||
            entry.toolInput !== existing.toolInput ||
            entry.lastAssistantMessage !== existing.lastAssistantMessage ||
            entry.orchestration !== existing.orchestration ||
            entry.subagents !== existing.subagents ||
            entry.providerSession !== existing.providerSession ||
            entry.interrupted !== existing.interrupted)
        const retentionRelevantChange =
          sortRelevantChange ||
          attributionChanged ||
          workingModeChanged ||
          doneRetentionFieldsChanged
        // Why: a fresh status means the agent is live again — lift its one-shot retention suppressor.
        // Clone the map only when a suppressor exists, else every high-frequency ping churns the ref.
        const hasSuppressor = paneKey in s.retentionSuppressedPaneKeys
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (hasSuppressor) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          delete nextRetentionSuppressedPaneKeys[paneKey]
        }
        // Why: pane keys are reused across turns, so a fresh live row makes any retained snapshot stale — drop it so it doesn't render beside the live row.
        const hasRetainedSnapshot = paneKey in s.retainedAgentsByPaneKey
        const nextRetainedAgents = hasRetainedSnapshot
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetainedSnapshot) {
          delete nextRetainedAgents[paneKey]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const liveRecoveryWorktreeId =
          entry.state === 'done' && !retainsResumableRecoveryIdentity
            ? null
            : (entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey))
        const liveRecoveryRecord = liveRecoveryWorktreeId
          ? sleepingRecordFromEntry({
              state: s,
              // Why: keep the resume identity of a finished turn without its text,
              // but never restate `done` as pending work — the resume sweep reads
              // that state to tell an interrupted agent from a completed one, and
              // a lie there respawns every finished agent whose pane was killed.
              entry: retainsResumableRecoveryIdentity
                ? { ...entry, prompt: '', lastAssistantMessage: undefined }
                : entry,
              worktreeId: liveRecoveryWorktreeId,
              capturedAt: updatedAt,
              launchConfig: launchConfigSource,
              origin: 'live'
            })
          : null
        let nextSleepingAgentSessions = s.sleepingAgentSessionsByPaneKey
        let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
        if (
          matchedRegistryLaunchConfig &&
          registryEntry &&
          providerSession &&
          !agentProviderSessionsEqual(
            identity.agentType,
            registryEntry.identity.providerSession,
            providerSession
          )
        ) {
          nextLaunchConfigs = {
            ...nextLaunchConfigs,
            [paneKey]: {
              ...registryEntry,
              identity: {
                ...registryEntry.identity,
                providerSession
              }
            }
          }
        }
        // Why: launch tokens can outlive an Orca-started TUI in the shell; once the session is done they must no longer authorize config reuse.
        // A session-boundary done is the session CONNECTING (STA-3386) — deleting here would strip
        // the pane's registered-launch-agent identity evidence the moment a resumed TUI sits idle.
        if (
          (providerSessionChanged || (entry.state === 'done' && entry.sessionBoundary !== true)) &&
          paneKey in s.agentLaunchConfigByPaneKey
        ) {
          nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
          delete nextLaunchConfigs[paneKey]
        }
        if (liveRecoveryRecord) {
          if (!recoveryRecordMatches(existingSleepingRecord, liveRecoveryRecord)) {
            nextSleepingAgentSessions = {
              ...s.sleepingAgentSessionsByPaneKey,
              [paneKey]: liveRecoveryRecord
            }
          }
        } else if (existingSleepingRecord) {
          nextSleepingAgentSessions = { ...s.sleepingAgentSessionsByPaneKey }
          delete nextSleepingAgentSessions[paneKey]
        }
        const nextLive = { ...s.agentStatusByPaneKey, [paneKey]: entry }
        // Why: cap the live map so a huge map's per-ping spread copy can't OOM the renderer (#9872).
        const evictedPaneKeys = capLiveAgentStatusesInPlace(
          nextLive,
          paneKey,
          () => classifyPaneKeyLiveness(s),
          updatedAt
        )
        const evictedOrphans = evictedPaneKeys.length > 0
        if (evictedOrphans) {
          const evictedPaneKeySet = new Set(evictedPaneKeys)
          nextSleepingAgentSessions = removePaneKeys(nextSleepingAgentSessions, evictedPaneKeySet)
          nextLaunchConfigs = removePaneKeys(nextLaunchConfigs, evictedPaneKeySet)
        }
        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetainedAgents,
          sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          agentStatusEpoch:
            retentionRelevantChange || migrationUnsupported.changed || evictedOrphans
              ? s.agentStatusEpoch + 1
              : s.agentStatusEpoch,
          sortEpoch:
            sortRelevantChange || migrationUnsupported.changed || evictedOrphans
              ? s.sortEpoch + 1
              : s.sortEpoch
        }
      })
      if (suppressedInheritedTerminalStatus) {
        return
      }
      const entryForGeneratedTitle = generatedTitleEntry.current
      if (entryForGeneratedTitle) {
        // Why: sticky orchestration (~30m) can outlive the dispatch turn, so replace the title on matching labels or a re-dispatch's mismatched taskId.
        const hasMatchingOrchestrationLabels = Boolean(
          (entryForGeneratedTitle.orchestration?.displayName?.trim() ||
            entryForGeneratedTitle.orchestration?.taskTitle?.trim()) &&
          orchestrationLabelsMatchLiveDispatch(entryForGeneratedTitle)
        )
        const liveIsDispatchPrompt = isOrcaDispatchPrompt(entryForGeneratedTitle.prompt)
        const liveDispatchTaskId = liveIsDispatchPrompt
          ? getOrcaDispatchTaskId(entryForGeneratedTitle.prompt)
          : null
        const stickyOrchestrationTaskId =
          entryForGeneratedTitle.orchestration?.taskId?.trim() || null
        const isNewDispatchAgainstStickyOrchestration = Boolean(
          liveDispatchTaskId &&
          stickyOrchestrationTaskId &&
          liveDispatchTaskId !== stickyOrchestrationTaskId
        )
        const shouldReplaceGeneratedTitle =
          hasMatchingOrchestrationLabels || isNewDispatchAgainstStickyOrchestration
        // Why: setAgentStatus is high-frequency, so only parse dispatch preambles when a title write is actually possible.
        const mayWriteGeneratedTitle =
          get().settings?.tabAutoGenerateTitle === true &&
          (shouldReplaceGeneratedTitle ||
            !agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
              get(),
              entryForGeneratedTitle.tabId ?? getTabIdFromPaneKey(paneKey),
              entryForGeneratedTitle.worktreeId
            ))
        const generatedTitlePrompt =
          liveIsDispatchPrompt && mayWriteGeneratedTitle
            ? getAgentRowGeneratedTitleText(entryForGeneratedTitle)
            : entryForGeneratedTitle.prompt
        if (shouldReplaceGeneratedTitle) {
          applyGeneratedTabTitleUpdate({
            paneKey,
            prompt: generatedTitlePrompt,
            options: {
              replaceExistingGeneratedTitle: true
            }
          })
        } else {
          applyGeneratedTabTitleUpdate({ paneKey, prompt: generatedTitlePrompt })
        }
      }
      // Why: batches coalesce accepted updates; standalone calls keep their existing deferred scheduling.
      requestAgentStatusFreshness(generatedTitleEntry.current !== null)
      if (completionRefreshWorktreeId) {
        const worktreeId = completionRefreshWorktreeId
        // Why: agents can create a PR via `gh pr create`, bypassing Orca's flow and leaving a stale "no PR" cache entry in place.
        queueMicrotask(() => get().refreshGitHubForWorktreeIfStale(worktreeId))
      }
    },

    setAgentStatuses: (updates) =>
      updates.length === 0
        ? []
        : transactAgentStatuses((transaction) => updates.map(transaction.apply)),

    transactAgentStatuses,

    setMigrationUnsupportedPty: (entry) => {
      set((s) => {
        const existing = s.migrationUnsupportedByPtyId[entry.ptyId]
        if (existing && entry.updatedAt < existing.updatedAt) {
          return s
        }
        return {
          migrationUnsupportedByPtyId: {
            ...s.migrationUnsupportedByPtyId,
            [entry.ptyId]: entry
          },
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
    },

    clearMigrationUnsupportedPty: (ptyId) => {
      if (!(ptyId in get().migrationUnsupportedByPtyId)) {
        return
      }
      set((s) => {
        const next = { ...s.migrationUnsupportedByPtyId }
        delete next[ptyId]
        return {
          migrationUnsupportedByPtyId: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
    },

    removeAgentStatus: (paneKey) => {
      if (
        !(paneKey in get().agentStatusByPaneKey) &&
        !(paneKey in get().agentLaunchConfigByPaneKey) &&
        !Object.values(get().migrationUnsupportedByPtyId).some((entry) => entry.paneKey === paneKey)
      ) {
        return
      }
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        const next = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete next[paneKey]
        }
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        // Why: drop the ack entry with the pane so a future paneKey collision can't inherit a stale ack that suppresses "unvisited" signals.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        // Why: bump sortEpoch with agentStatusEpoch — removing an agent can change worktree sort order (same as setAgentStatus).
        return {
          agentStatusByPaneKey: next,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => freshness.schedule())
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      const currentKeys = Object.keys(get().agentStatusByPaneKey)
      const toRemove = currentKeys.filter((k) => k.startsWith(prefix))
      const launchConfigKeys = Object.keys(get().agentLaunchConfigByPaneKey).filter((k) =>
        k.startsWith(prefix)
      )
      const hasMigrationUnsupported = Object.values(get().migrationUnsupportedByPtyId).some(
        (entry) => entry.paneKey?.startsWith(prefix)
      )
      if (toRemove.length === 0 && launchConfigKeys.length === 0 && !hasMigrationUnsupported) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        for (const key of toRemove) {
          delete next[key]
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey?.startsWith(prefix) ?? false
        )
        // See removeAgentStatus for rationale on ack cleanup.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter((k) => k.startsWith(prefix))
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const k of ackKeys) {
            delete nextAck[k]
          }
        }
        // Why: bump sortEpoch with agentStatusEpoch — removing agents can change worktree sort order (same as setAgentStatus).
        return {
          agentStatusByPaneKey: next,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => freshness.schedule())
    },

    clearTransientAgentStatuses: (connectionId, clearedAt) => {
      if (connectionId.length === 0 || !Number.isFinite(clearedAt)) {
        return
      }
      let removed = false
      set((s) => {
        const worktreeIdsOnConnection = collectWorktreeIdsForConnection(s, connectionId)
        let next: Record<string, AgentStatusEntry> | null = null
        for (const [paneKey, existing] of Object.entries(s.agentStatusByPaneKey)) {
          if (existing.updatedAt > clearedAt) {
            continue
          }
          // Why: clear rows stamped for this connection, plus UNSTAMPED (never-stamped) worktree
          // rows unambiguously on it (#9030). An explicit stamp — another host's connectionId, or a
          // local `null` — is authoritative and never overridden by worktree inference.
          const belongsToConnection =
            existing.connectionId === connectionId ||
            (existing.connectionId === undefined &&
              existing.worktreeId !== undefined &&
              worktreeIdsOnConnection.has(existing.worktreeId))
          if (!belongsToConnection) {
            continue
          }
          next ??= { ...s.agentStatusByPaneKey }
          delete next[paneKey]
        }
        const wasAlreadyBlocked = connectionId in s.transientClearedAgentStatusConnectionIds
        if (!next && wasAlreadyBlocked) {
          return s
        }
        removed = next !== null
        // Why: transport loss is reversible. Keep launch, resume, retention,
        // and acknowledgement maps intact for same-pane relay replay.
        return {
          ...(next
            ? {
                agentStatusByPaneKey: next,
                agentStatusEpoch: s.agentStatusEpoch + 1,
                sortEpoch: s.sortEpoch + 1
              }
            : {}),
          transientClearedAgentStatusConnectionIds: wasAlreadyBlocked
            ? s.transientClearedAgentStatusConnectionIds
            : { ...s.transientClearedAgentStatusConnectionIds, [connectionId]: true }
        }
      })
      if (removed) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatus: (paneKey) => {
      // Why: zustand set is synchronous, so capture liveExisted once inside the callback instead of double-reading the store.
      let liveExisted = false
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        liveExisted = hasLive
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        // See removeAgentStatus for ack-cleanup rationale; the ack entry is owned by the pane lifecycle regardless of live/retained state.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        // Why: short-circuit when there's nothing to change, but still flush a pending ack or launch-config cleanup if one is present.
        if (!hasLive && !hasRetained && !migrationUnsupported.changed) {
          if (hasLaunchConfig) {
            return {
              agentLaunchConfigByPaneKey: nextLaunchConfigs,
              ...(nextAck !== s.acknowledgedAgentsByPaneKey
                ? { acknowledgedAgentsByPaneKey: nextAck }
                : {})
            }
          }
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }

        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }
        const nextRetained = hasRetained
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetained) {
          delete nextRetained[paneKey]
        }

        // Why: explicit teardown must not let retention sync resurrect this row — plant a one-shot suppressor, but only when hasLive (a retained-only key has no live→gone transition to consume it, so it leaks) and not already present (re-spreading spuriously re-renders subscribers).
        const needsSuppressorWrite = hasLive && !(paneKey in s.retentionSuppressedPaneKeys)

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(needsSuppressorWrite
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch:
            hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          // Why: mirrors removeAgentStatus — dropping a live agent changes its worktree sort score, so bump sortEpoch to recompute the sidebar smart-sort.
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: freshness.schedule only matters when the live map changed, so gate on the live presence observed inside set() — no-op/retained-only drops skip it.
      if (liveExisted) {
        queueMicrotask(() => freshness.schedule())
      }
      // Why: propagate the dismissal to the main-process hook cache so the on-disk cache doesn't re-hydrate this row on next launch. Fire-and-forget.
      // Why: the typeof window guard keeps the slice usable from the node test env, where window is undefined.
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.drop?.(paneKey)
      }
    },

    dropAgentStatusByTabPrefix: (tabIdPrefix, opts) => {
      const retiredAliasPaneKeys = retireAgentPaneAuthorityAliasesByOwnerTab(tabIdPrefix)
      let hadLive = false
      set((s) => {
        const dropped = buildAgentStatusTabPrefixDropPatch(
          s,
          tabIdPrefix,
          retiredAliasPaneKeys,
          opts
        )
        hadLive = dropped.hadLive
        return dropped.patch
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.dropByTabPrefix?.(tabIdPrefix)
      }
    },

    dropHibernatedAgentStatusPane: (worktreeId, paneKey, opts) => {
      let hadLive = false
      set((s) => {
        const liveEntry = s.agentStatusByPaneKey[paneKey]
        const hasLive = liveEntry !== undefined
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const retainedEvidence = new Map<string, RetainedAgentEntry>()
        for (const retained of opts?.retainedCompletionEvidence ?? []) {
          if (
            retained.entry.paneKey === paneKey &&
            !liveEntry &&
            shouldReplaceRetainedWithLive(retainedEvidence.get(paneKey), retained)
          ) {
            retainedEvidence.set(paneKey, retained)
          }
        }
        if (
          liveEntry?.state === 'done' &&
          liveEntry.agentType !== undefined &&
          liveEntry.interrupted !== true
        ) {
          retainedEvidence.set(
            paneKey,
            retainedAgentEntryFromLive(s, worktreeId, liveEntry, liveEntry.agentType)
          )
        }
        const keepsCompletionEvidence = retainedEvidence.has(paneKey)
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (!keepsCompletionEvidence && paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        if (
          !hasLive &&
          !hasRetained &&
          !hasLaunchConfig &&
          !migrationUnsupported.changed &&
          !keepsCompletionEvidence
        ) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }
        hadLive = hasLive

        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }

        const nextRetained =
          hasRetained || keepsCompletionEvidence
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        if (hasRetained && !keepsCompletionEvidence) {
          delete nextRetained[paneKey]
        }
        for (const [key, retained] of retainedEvidence) {
          if (shouldReplaceRetainedWithLive(nextRetained[key], retained)) {
            nextRetained[key] = retained
          }
        }

        const needsSuppressor =
          hasLive && !keepsCompletionEvidence && !(paneKey in s.retentionSuppressedPaneKeys)

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(needsSuppressor
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch:
            hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatusByWorktree: (worktreeId, opts) => {
      let hadLive = false
      set((s) => {
        const tabPrefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
        const liveEntries = Object.entries(s.agentStatusByPaneKey).filter(
          ([paneKey, entry]) =>
            entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
        )
        const liveKeys = liveEntries.map(([paneKey]) => paneKey)
        const liveKeySet = new Set(liveKeys)
        const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
          (paneKey) => paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes) || liveKeySet.has(paneKey)
        )
        const retainedKeys = Object.entries(s.retainedAgentsByPaneKey)
          .filter(
            ([paneKey, retained]) =>
              retained.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
          )
          .map(([paneKey]) => paneKey)
        const retainedKeySet = new Set(retainedKeys)
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) =>
            entry.worktreeId === worktreeId ||
            (entry.paneKey ? paneKeyMatchesAnyTabPrefix(entry.paneKey, tabPrefixes) : false)
        )
        const allowedPaneKeys = normalizePaneKeySet(opts?.sleepingPaneKeys)
        const preserveHibernatedEvidence =
          opts?.shutdownReason === 'auto-hibernate-completed-agent' &&
          allowedPaneKeys !== null &&
          allowedPaneKeys.size > 0
        const liveEntryByPaneKey = new Map(liveEntries)
        const retainedEvidence = new Map<string, RetainedAgentEntry>()
        if (preserveHibernatedEvidence) {
          for (const retained of opts?.retainedCompletionEvidence ?? []) {
            if (
              allowedPaneKeys.has(retained.entry.paneKey) &&
              !liveEntryByPaneKey.has(retained.entry.paneKey) &&
              shouldReplaceRetainedWithLive(retainedEvidence.get(retained.entry.paneKey), retained)
            ) {
              retainedEvidence.set(retained.entry.paneKey, retained)
            }
          }
          for (const [paneKey, entry] of liveEntries) {
            const agentType = entry.agentType
            if (
              allowedPaneKeys.has(paneKey) &&
              entry.state === 'done' &&
              agentType !== undefined &&
              entry.interrupted !== true
            ) {
              retainedEvidence.set(
                paneKey,
                retainedAgentEntryFromLive(s, worktreeId, entry, agentType)
              )
            }
          }
        }
        const retainedEvidenceKeys = new Set(retainedEvidence.keys())
        // See removeAgentStatus for ack-cleanup rationale; auto-hibernated completion evidence keeps its read state so a slept card doesn't turn bold again.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter(
          (k) =>
            !retainedEvidenceKeys.has(k) &&
            (paneKeyMatchesAnyTabPrefix(k, tabPrefixes) ||
              liveKeySet.has(k) ||
              retainedKeySet.has(k))
        )
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const key of ackKeys) {
            delete nextAck[key]
          }
        }
        // Mirror dropAgentStatusByTabPrefix: when nothing live/retained changed, return just the ack delta (or s) to avoid full-state re-renders.
        if (
          liveKeys.length === 0 &&
          launchConfigKeys.length === 0 &&
          retainedKeys.length === 0 &&
          retainedEvidence.size === 0 &&
          !migrationUnsupported.changed
        ) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }
        hadLive = liveKeys.length > 0

        const nextLive =
          liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        for (const key of liveKeys) {
          delete nextLive[key]
        }
        const nextLaunchConfigs =
          launchConfigKeys.length > 0
            ? { ...s.agentLaunchConfigByPaneKey }
            : s.agentLaunchConfigByPaneKey
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }

        const nextRetained =
          retainedKeys.length > 0 || retainedEvidence.size > 0
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        for (const key of retainedKeys) {
          if (!retainedEvidenceKeys.has(key)) {
            delete nextRetained[key]
          }
        }
        for (const [paneKey, retained] of retainedEvidence) {
          if (shouldReplaceRetainedWithLive(nextRetained[paneKey], retained)) {
            nextRetained[paneKey] = retained
          }
        }

        // Why: suppress live rows on teardown, but skip auto-hibernated `done` rows — they become retained evidence a suppressor would erase next sync.
        const suppressorAdds = liveKeys.filter(
          (k) => !retainedEvidenceKeys.has(k) && !(k in s.retentionSuppressedPaneKeys)
        )
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (suppressorAdds.length > 0) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          for (const key of suppressorAdds) {
            nextRetentionSuppressedPaneKeys[key] = true
          }
        }

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch:
            hadLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    captureSleepingAgentSessionsByWorktree: (worktreeId, paneKeys) => {
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
    },

    captureAllSleepingAgentSessions: (mode) => {
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
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),
    clearSleepingAgentSessionsByPaneKey,
    setSleepingAgentAutomaticResumeBlocked: (paneKey, blocked) => {
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
    },

    clearSleepingAgentSessionsByWorktree: (worktreeId) => {
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
    },

    pruneSleepingAgentSessions: (validWorktreeIds) => {
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
    },

    retainAgents: (entries) => {
      // Why: retained entries are a pure read-overlay (no epoch bump needed); batch into one set so multi-agent disappearance is atomic.
      if (entries.length === 0) {
        return
      }
      set((s) => {
        // Why: skip reallocation when every entry is already present by reference — consumers select on map identity, so a spurious realloc forces re-renders.
        let changed = false
        for (const retained of entries) {
          if (s.retainedAgentsByPaneKey[retained.entry.paneKey] !== retained) {
            changed = true
            break
          }
        }
        if (!changed) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        for (const retained of entries) {
          const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[retained.entry.paneKey]
          const mergedOrchestration = runtimeOrchestration
            ? mergeCurrentOrchestrationContext(retained.entry.orchestration, runtimeOrchestration)
            : retained.entry.orchestration
          const entry =
            mergedOrchestration !== retained.entry.orchestration
              ? { ...retained.entry, orchestration: mergedOrchestration }
              : retained.entry
          // INVARIANT: map key equals retained.entry.paneKey, so callers look up retained rows by the same paneKey as agentStatusByPaneKey.
          next[retained.entry.paneKey] =
            entry === retained.entry ? retained : { ...retained, entry }
        }
        // Why: cap the map so a long multi-agent session can't leak the renderer heap (retainAgents is the only growth path); evicts oldest-retained first.
        return { retainedAgentsByPaneKey: capRetainedAgents(next) }
      })
    },

    dismissRetainedAgent: (paneKey) => {
      // Why: no epoch bump (mirrors retainAgents) — retained rows are a pure read-overlay that don't affect smart-sort; selectors re-render on map identity.
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        // Why: mirror dropAgentStatus — plant a one-shot suppressor only when a live entry coexists, so the retention sync doesn't resurrect this dismissed row (gate on hasLive, else it leaks).
        const hasLive = paneKey in s.agentStatusByPaneKey
        if (!hasLive || paneKey in s.retentionSuppressedPaneKeys) {
          return { retainedAgentsByPaneKey: next }
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: {
            ...s.retentionSuppressedPaneKeys,
            [paneKey]: true
          }
        }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      // Why: collect removed paneKeys inside set, then fan out window.api drop so the on-disk cache doesn't resurrect the dismissed rows on next launch.
      const dismissedPaneKeys: string[] = []
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        // Why: mirror dismissRetainedAgent — plant a suppressor only for dismissed paneKeys that also have a live entry, else the next live→gone transition re-retains the row (a retained-only suppressor leaks).
        const toSuppress: string[] = []
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (ra.worktreeId === worktreeId) {
            changed = true
            dismissedPaneKeys.push(key)
            if (key in s.agentStatusByPaneKey && !(key in s.retentionSuppressedPaneKeys)) {
              toSuppress.push(key)
            }
            continue
          }
          next[key] = ra
        }
        if (!changed) {
          return s
        }
        if (toSuppress.length === 0) {
          return { retainedAgentsByPaneKey: next }
        }
        const nextSuppressed = { ...s.retentionSuppressedPaneKeys }
        for (const key of toSuppress) {
          nextSuppressed[key] = true
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: nextSuppressed
        }
      })
      if (typeof window !== 'undefined') {
        for (const paneKey of dismissedPaneKeys) {
          window.api?.agentStatus?.drop?.(paneKey)
        }
      }
    },

    pruneRetainedAgents: (validWorktreeIds) => {
      // Why: intentionally leaves retentionSuppressedPaneKeys — paneKeys are minted fresh on worktree re-create, so stale suppressors can never match a future live entry.
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (!validWorktreeIds.has(ra.worktreeId)) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    clearRetentionSuppressedPaneKeys: (paneKeys) => {
      set((s) => {
        let changed = false
        const next = { ...s.retentionSuppressedPaneKeys }
        for (const paneKey of paneKeys) {
          if (!(paneKey in next)) {
            continue
          }
          delete next[paneKey]
          changed = true
        }
        return changed ? { retentionSuppressedPaneKeys: next } : s
      })
    }
  }
}

export {
  collectSleepingAgentSessionRecordsForWorktree,
  removeSleepingRecordsReplacedByManualWorktreeSleep
} from './agent-sleeping-sessions'
export { collectHibernatedCompletionEvidenceForWorktree } from './agent-status-retention'
export {
  buildAgentStatusTabPrefixDropPatch,
  type AgentStatusTabPrefixDropState
} from './agent-status-tab-prefix'
