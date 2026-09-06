import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { agentKindForAgentType, formatAgentTypeLabel } from '../../lib/agent-status'
import {
  deriveRunningAgentSendTargets,
  resolveRunningAgentSendTarget
} from '../../lib/running-agent-targets'
import { translate } from '@/i18n/i18n'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type AgentSendPopoverTargetMode = {
  id: string
  instanceId: string
  worktreeId: string
  source: 'diff-notes' | 'browser-annotations'
  prompt: string
  label: string
  launchSource: LaunchSource
  eligiblePaneKeys: string[]
  disabledPaneKeys: Record<string, string>
  status: 'open' | 'sending' | 'error'
  sendingPaneKey?: string
  error?: string
  onPromptDelivered?: () => void
}

export type OpenAgentSendPopoverTargetModeArgs = {
  id: string
  worktreeId: string
  source: AgentSendPopoverTargetMode['source']
  prompt: string
  label: string
  launchSource: LaunchSource
  onPromptDelivered?: () => void
}

let agentSendTargetModeInstanceCounter = 0

function createAgentSendTargetModeInstanceId(): string {
  agentSendTargetModeInstanceCounter += 1
  return `${Date.now()}:${agentSendTargetModeInstanceCounter}`
}

export type UIAgentSendSlice = {
  agentSendPopoverTargetMode: AgentSendPopoverTargetMode | null
  openAgentSendPopoverTargetMode: (args: OpenAgentSendPopoverTargetModeArgs) => void
  closeAgentSendPopoverTargetMode: (id?: string, instanceId?: string) => void
  sendPromptToSidebarAgentTarget: (paneKey: string) => Promise<boolean>
  /** Bumped to ask the active worktree's Source Control notes send menu to open (keyboard shortcut). `issuedAt` bounds staleness so a request the menu never consumed can't reopen it much later. */
  diffNotesSendMenuOpenRequest: { worktreeId: string; nonce: number; issuedAt: number } | null
  /** Reveal Source Control and request its notes send menu open; returns false (no-op) when the active worktree has no unsent notes. */
  openDiffNotesSendMenuForActiveWorktree: () => boolean
  consumeDiffNotesSendMenuOpenRequest: (worktreeId: string) => void
  /** Per-agent "I've looked at this" timestamps (paneKey → ts). A row is unvisited when no ack exists or stateStartedAt is newer than the last ack. Persisted so visited rows don't return bold on relaunch. */
  acknowledgedAgentsByPaneKey: Record<string, number>
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
}

function resolvePaneKeyWorktreeIdFromTabs(state: AppState, paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    if (tabs.some((tab) => tab.id === parsed.tabId)) {
      return worktreeId
    }
  }
  return null
}

function collectAcknowledgedAgentNotificationId({
  ids,
  worktreeId,
  paneKey,
  stateStartedAt,
  previousAckAt
}: {
  ids: Set<string>
  worktreeId: string | null | undefined
  paneKey: string
  stateStartedAt: number | null | undefined
  previousAckAt: number
}): void {
  if (typeof stateStartedAt !== 'number' || previousAckAt >= stateStartedAt) {
    return
  }
  const id = buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt })
  if (id) {
    ids.add(id)
  }
}

function usableTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Newest turn timestamp an unread check can compare against for one agent row. */
function latestAgentTurnTimestamp(entry: {
  stateStartedAt?: number
  stateHistory?: { startedAt?: number }[]
}): number {
  let latest = usableTimestamp(entry.stateStartedAt)
  // Why history too: Activity renders one event per stateHistory entry, each with its own unread check.
  for (const history of entry.stateHistory ?? []) {
    latest = Math.max(latest, usableTimestamp(history.startedAt))
  }
  return latest
}

export const createUIAgentSendSlice: StateCreator<AppState, [], [], UIAgentSendSlice> = (
  set,
  get
) => ({
  agentSendPopoverTargetMode: null,
  openAgentSendPopoverTargetMode: (args) => {
    const targets = deriveRunningAgentSendTargets(get(), args.worktreeId)
    const previousMode = get().agentSendPopoverTargetMode
    if (previousMode?.id === args.id && previousMode.status === 'sending') {
      return
    }
    const disabledPaneKeys: Record<string, string> = {}
    for (const target of targets) {
      if (target.status === 'disabled' && target.disabledReason) {
        disabledPaneKeys[target.paneKey] = target.disabledReason
      }
    }
    set({
      agentSendPopoverTargetMode: {
        ...args,
        instanceId: createAgentSendTargetModeInstanceId(),
        eligiblePaneKeys: targets
          .filter((target) => target.status === 'eligible')
          .map((target) => target.paneKey),
        disabledPaneKeys,
        status: 'open'
      }
    })
    if (
      targets.some((target) => target.status === 'eligible') &&
      (previousMode?.id !== args.id || previousMode.worktreeId !== args.worktreeId)
    ) {
      get().revealWorktreeInSidebar(args.worktreeId, { behavior: 'auto', highlight: true })
    }
  },
  diffNotesSendMenuOpenRequest: null,
  openDiffNotesSendMenuForActiveWorktree: () => {
    const worktreeId = get().activeWorktreeId
    if (!worktreeId) {
      return false
    }
    // Why: no unsent notes means nothing to send, so don't hijack focus or reveal the panel.
    if (
      !get()
        .getDiffComments(worktreeId)
        .some((comment) => !comment.sentAt)
    ) {
      return false
    }
    get().setRightSidebarTab('source-control')
    get().setRightSidebarOpen(true)
    const nonce = (get().diffNotesSendMenuOpenRequest?.nonce ?? 0) + 1
    set({ diffNotesSendMenuOpenRequest: { worktreeId, nonce, issuedAt: Date.now() } })
    return true
  },
  consumeDiffNotesSendMenuOpenRequest: (worktreeId) =>
    set((s) =>
      s.diffNotesSendMenuOpenRequest?.worktreeId === worktreeId
        ? { diffNotesSendMenuOpenRequest: null }
        : s
    ),
  closeAgentSendPopoverTargetMode: (id, instanceId) =>
    set((s) => {
      if (!s.agentSendPopoverTargetMode) {
        return s
      }
      if (id && s.agentSendPopoverTargetMode.id !== id) {
        return s
      }
      if (instanceId && s.agentSendPopoverTargetMode.instanceId !== instanceId) {
        return s
      }
      return { agentSendPopoverTargetMode: null }
    }),
  sendPromptToSidebarAgentTarget: async (paneKey) => {
    const mode = get().agentSendPopoverTargetMode
    if (!mode || mode.status === 'sending') {
      return false
    }

    const target = resolveRunningAgentSendTarget(get(), mode.worktreeId, paneKey)
    if (!target || target.status !== 'eligible' || !target.ptyId) {
      // Why: eligibility can drop after the menu opened; keep the picker open (row title explains) rather than adding toast noise.
      return false
    }

    set((s) =>
      s.agentSendPopoverTargetMode?.id === mode.id &&
      s.agentSendPopoverTargetMode.instanceId === mode.instanceId
        ? {
            agentSendPopoverTargetMode: {
              ...s.agentSendPopoverTargetMode,
              status: 'sending',
              sendingPaneKey: paneKey,
              error: undefined
            }
          }
        : s
    )

    const label = formatAgentTypeLabel(target.entry.agentType)
    const { activeAgentNotesSendFailureMessage, sendNotesToActiveAgentSession } =
      await import('@/lib/active-agent-note-send')
    const result = await sendNotesToActiveAgentSession({
      worktreeId: mode.worktreeId,
      prompt: mode.prompt,
      noteTarget: { tabId: target.tabId, leafId: target.leafId }
    }).catch((error) => {
      console.error('Failed to send notes to sidebar agent target:', error)
      return { status: 'no-active-terminal' as const }
    })

    const stillCurrent = (): boolean => {
      const current = get().agentSendPopoverTargetMode
      return current?.id === mode.id && current.instanceId === mode.instanceId
    }

    if (!stillCurrent()) {
      return false
    }

    if (result.status !== 'sent') {
      const message = activeAgentNotesSendFailureMessage(result.status, { explicitTarget: true })
      set((s) =>
        s.agentSendPopoverTargetMode?.id === mode.id &&
        s.agentSendPopoverTargetMode.instanceId === mode.instanceId
          ? {
              agentSendPopoverTargetMode: {
                ...s.agentSendPopoverTargetMode,
                status: 'error',
                sendingPaneKey: undefined,
                error: message
              }
            }
          : s
      )
      const { toast } = await import('sonner')
      if (!stillCurrent()) {
        return false
      }
      toast.error(
        translate('auto.store.slices.ui.53883b7bc3', "Couldn't send to {{value0}}", {
          value0: label
        }),
        { description: message }
      )
      return false
    }

    const [{ toast }, { track }] = await Promise.all([import('sonner'), import('@/lib/telemetry')])
    if (!stillCurrent()) {
      return false
    }
    mode.onPromptDelivered?.()
    track('agent_prompt_sent', {
      agent_kind: agentKindForAgentType(target.entry.agentType),
      launch_source: mode.launchSource,
      request_kind: 'followup'
    })
    toast.success(
      translate('auto.store.slices.ui.66e3bd7ce6', 'Sent to {{value0}}', { value0: label })
    )
    get().closeAgentSendPopoverTargetMode(mode.id, mode.instanceId)
    return true
  },

  acknowledgedAgentsByPaneKey: {},
  acknowledgeAgents: (paneKeys) => {
    const notificationIdsToDismiss = new Set<string>()
    set((s) => {
      if (paneKeys.length === 0) {
        return s
      }
      const now = Date.now()
      const migrationUnsupported = Object.values(s.migrationUnsupportedByPtyId ?? {})
      // Why: only reallocate if an ack advances; compare prev<stamp not !== — the stamp ticks every ms and !== would rewrite the map every call.
      let next: Record<string, number> | null = null
      for (const key of paneKeys) {
        const prev = s.acknowledgedAgentsByPaneKey[key] ?? 0
        // Why not plain Date.now(): a remote/SSH execution host can stamp a turn ahead of this clock,
        // and every unread rule is `ackAt < turnTimestamp`. A behind-the-turn ack can never clear the
        // row, so its auto-ack effect re-fires on each new millisecond forever (React #185).
        let stamp = now
        const liveEntry = s.agentStatusByPaneKey?.[key]
        if (liveEntry) {
          collectAcknowledgedAgentNotificationId({
            ids: notificationIdsToDismiss,
            worktreeId: resolvePaneKeyWorktreeIdFromTabs(s, key) ?? liveEntry.worktreeId,
            paneKey: key,
            stateStartedAt: liveEntry.stateStartedAt,
            previousAckAt: prev
          })
          stamp = Math.max(stamp, latestAgentTurnTimestamp(liveEntry))
        }
        const retained = s.retainedAgentsByPaneKey?.[key]
        if (retained) {
          collectAcknowledgedAgentNotificationId({
            ids: notificationIdsToDismiss,
            worktreeId: retained.worktreeId,
            paneKey: key,
            stateStartedAt: retained.entry.stateStartedAt,
            previousAckAt: prev
          })
          stamp = Math.max(stamp, latestAgentTurnTimestamp(retained.entry))
        }
        for (const unsupported of migrationUnsupported) {
          // Why: Activity synthesizes a blocked row from this entry, stamped by the pane's host like any turn.
          if (unsupported.paneKey === key) {
            stamp = Math.max(stamp, usableTimestamp(unsupported.updatedAt))
          }
        }
        if (prev < stamp) {
          if (next === null) {
            next = { ...s.acknowledgedAgentsByPaneKey }
          }
          next[key] = stamp
        }
      }
      return next ? { acknowledgedAgentsByPaneKey: next } : s
    })
    const notificationIds = [...notificationIdsToDismiss]
    if (notificationIds.length > 0 && typeof window !== 'undefined') {
      void window.api?.notifications?.dismiss?.(notificationIds)
    }
  },
  unacknowledgeAgents: (paneKeys) =>
    set((s) => {
      if (paneKeys.length === 0) {
        return s
      }
      let next: Record<string, number> | null = null
      for (const key of paneKeys) {
        if (s.acknowledgedAgentsByPaneKey[key] !== undefined) {
          if (next === null) {
            next = { ...s.acknowledgedAgentsByPaneKey }
          }
          delete next[key]
        }
      }
      return next ? { acknowledgedAgentsByPaneKey: next } : s
    })
})
