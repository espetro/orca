import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

export type SessionTabsStreamEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | {
      type: 'snapshots'
      snapshots: RuntimeMobileSessionTabsResult[]
      authoritative?: boolean
    }
  | { type: 'end' }

export function shouldBootstrapInitialWebRuntimeTerminal(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedInitialTerminal: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
}): boolean {
  return (
    args.snapshotIsFresh &&
    args.event.type === 'snapshot' &&
    args.event.tabs.length === 0 &&
    args.localTerminalCount === 0 &&
    !args.requestedInitialTerminal &&
    args.activeWorktreeId === args.event.worktree
  )
}

export function shouldRespawnWebRuntimeTerminalAfterWake(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedRespawnAfterWake: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
  hasLiveLocalPty: boolean
  skipWakeRespawn?: boolean
}): boolean {
  if (
    !args.snapshotIsFresh ||
    args.requestedRespawnAfterWake ||
    args.skipWakeRespawn === true ||
    args.localTerminalCount === 0 ||
    args.hasLiveLocalPty ||
    (args.event.type !== 'snapshot' && args.event.type !== 'updated')
  ) {
    return false
  }
  if (args.activeWorktreeId !== args.event.worktree) {
    return false
  }
  const hostTerminalTabCount = args.event.tabs.filter((tab) => tab.type === 'terminal').length
  return hostTerminalTabCount === 0
}

export function shouldSyncRuntimeSessionTabs(args: {
  activeWorktreeId?: string | null
  activeWorktreeRuntimeEnvironmentId?: string | null
  workspaceSessionReady: boolean
}): boolean {
  const environmentId = args.activeWorktreeRuntimeEnvironmentId?.trim()
  if (!environmentId || !args.workspaceSessionReady) {
    return false
  }
  return Boolean(args.activeWorktreeId?.trim())
}

export function shouldSyncAllRuntimeSessionTabs(args: {
  activeRuntimeEnvironmentId: string | null | undefined
  workspaceSessionReady: boolean
}): boolean {
  const environmentId = args.activeRuntimeEnvironmentId?.trim()
  return Boolean(environmentId && args.workspaceSessionReady)
}
