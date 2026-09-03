/* eslint-disable max-lines -- Why: the agent-status slice co-locates live map, retained snapshots, retention-suppression, and tab-prefix sweep so the teardown contract stays readable end-to-end. Splitting across files would scatter the drop/remove/retain interactions that must stay in lockstep. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  getAgentRowGeneratedTitleText,
  orchestrationLabelsMatchLiveDispatch
} from '@/lib/agent-row-primary-text'
import { retireAgentPaneAuthorityAliasesByOwnerTab } from './agent-pane-authority'
import {
  retireAgentPaneAuthorityReducer,
  restoreAgentPaneAuthorityReducer,
  transferAgentPaneAuthorityReducer
} from './agent-pane-authority-actions'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'
import { capRetainedAgents } from './agent-status-retention'
import {
  mergeCurrentOrchestrationContext,
  orchestrationMapsEqual
} from './agent-status-orchestration'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key'
import {
  copyLaunchConfig,
  getLaunchConfigForEntry,
  getLaunchConfigForStatusMetadata,
  launchConfigRegistryEntriesEqual,
  normalizeLaunchConfigRegistrationMetadata,
  registryEntryMatchesStatus
} from './agent-launch-config-registry'
import { sleepingRecordFromEntry } from './agent-sleeping-sessions'
import {
  removeAgentStatusAction,
  removeAgentStatusByTabPrefixAction,
  clearTransientAgentStatusesAction,
  dropAgentStatusAction,
  dropAgentStatusByTabPrefixAction,
  dropHibernatedAgentStatusPaneAction,
  dropAgentStatusByWorktreeAction
} from './agent-status-drop-actions'
import { recordAgentProviderSessionAction } from './agent-status-provider-session'
import { setAgentStatusAction } from './agent-status-ingest'
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
import {
  captureSleepingAgentSessionsByWorktreeAction,
  captureAllSleepingAgentSessionsAction,
  clearSleepingAgentSessionsByPaneKeyAction,
  setSleepingAgentAutomaticResumeBlockedAction,
  clearSleepingAgentSessionsByWorktreeAction,
  pruneSleepingAgentSessionsAction
} from './agent-status-sleeping-capture'
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
      recordAgentProviderSessionAction(
        paneKey,
        agent,
        providerSession,
        requestAgentStatusFreshness,
        get,
        set,
        timing,
        routing,
        metadata
      )
    },

    setAgentStatus: (paneKey, payload, terminalTitle, timing, routing, metadata) => {
      setAgentStatusAction(
        paneKey,
        payload,
        applyGeneratedTabTitleUpdate,
        requestAgentStatusFreshness,
        get,
        set,
        terminalTitle,
        timing,
        routing,
        metadata
      )
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
      const hadLive = removeAgentStatusAction(paneKey, get, set)
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      const hadLive = removeAgentStatusByTabPrefixAction(tabIdPrefix, get, set)
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    clearTransientAgentStatuses: (connectionId, clearedAt) => {
      const removed = clearTransientAgentStatusesAction(connectionId, clearedAt, get, set)
      if (removed) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatus: (paneKey) => {
      const hadLive = dropAgentStatusAction(paneKey, get, set)
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.drop?.(paneKey)
      }
    },

    dropAgentStatusByTabPrefix: (tabIdPrefix, opts) => {
      const retiredAliasPaneKeys = retireAgentPaneAuthorityAliasesByOwnerTab(tabIdPrefix)
      const hadLive = dropAgentStatusByTabPrefixAction(
        tabIdPrefix,
        retiredAliasPaneKeys,
        opts,
        get,
        set
      )
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.dropByTabPrefix?.(tabIdPrefix)
      }
    },

    dropHibernatedAgentStatusPane: (worktreeId, paneKey, opts) => {
      const hadLive = dropHibernatedAgentStatusPaneAction(worktreeId, paneKey, opts, get, set)
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatusByWorktree: (worktreeId, opts) => {
      const hadLive = dropAgentStatusByWorktreeAction(worktreeId, opts, get, set)
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    captureSleepingAgentSessionsByWorktree: (worktreeId, paneKeys) =>
      captureSleepingAgentSessionsByWorktreeAction(worktreeId, paneKeys, get, set),

    captureAllSleepingAgentSessions: (mode) =>
      captureAllSleepingAgentSessionsAction(mode, get, set),

    clearSleepingAgentSession: (paneKey) =>
      clearSleepingAgentSessionsByPaneKeyAction([paneKey], get, set),
    clearSleepingAgentSessionsByPaneKey: (paneKeys) =>
      clearSleepingAgentSessionsByPaneKeyAction(paneKeys, get, set),
    setSleepingAgentAutomaticResumeBlocked: (paneKey, blocked) =>
      setSleepingAgentAutomaticResumeBlockedAction(paneKey, blocked, get, set),

    clearSleepingAgentSessionsByWorktree: (worktreeId) =>
      clearSleepingAgentSessionsByWorktreeAction(worktreeId, get, set),

    pruneSleepingAgentSessions: (validWorktreeIds) =>
      pruneSleepingAgentSessionsAction(validWorktreeIds, get, set),

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

export { removeSleepingRecordsReplacedByManualWorktreeSleep } from './agent-sleeping-sessions'
export { collectHibernatedCompletionEvidenceForWorktree } from './agent-status-retention'
export {
  buildAgentStatusTabPrefixDropPatch,
  type AgentStatusTabPrefixDropState
} from './agent-status-tab-prefix'
