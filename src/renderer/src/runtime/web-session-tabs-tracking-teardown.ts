import {
  clearWebAgentSessionHandoffsForEnvironment,
  clearWebAgentSessionHandoffsForWorktree
} from './web-agent-session-handoff'
import {
  clearWebSessionBrowserPlacementsForEnvironment,
  clearWebSessionBrowserPlacementsForWorktree,
  resetWebSessionBrowserPlacementsForTests
} from './web-session-browser-placement'
import { clearWebSessionCloseIntentsForWorktree } from './web-session-close-intent'
import { clearWebSessionReorderIntentsForWorktree } from './web-session-reorder-intent'
import {
  clearWebSessionTerminalPlacementsForEnvironment,
  clearWebSessionTerminalPlacementsForWorktree
} from './web-session-terminal-placement'
import { clearHostSessionMirrorHydration } from './host-session-mirror-hydration'
import {
  clearAllWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForWorktree
} from './web-runtime-wake-terminal-respawn'
import { clearHostSessionTabIdMappings } from './web-session-tabs-tab-id-mapping'
import {
  sessionTabsFreshnessKey,
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree,
  hostWorkingClientBoundaryByPaneKey,
  lastHostTerminalTabCountByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  resetReceivedSessionTabsFrameSequenceForTests,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsRecoveryStateByWorktree,
  sessionTabsTrackingGenerationByEnvironment,
  trackedSessionTabsWorktreeIdsByEnvironment
} from './web-session-tabs-sync-state'
import {
  removeWebSessionTabsEnvironment,
  untrackWebSessionTabsWorktree
} from './web-session-tabs-tracking'

export function clearWebSessionTabsTrackingForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  latestSessionTabsSnapshotByWorktree.delete(key)
  replayableSessionTabsSnapshotByWorktree.delete(key)
  latestReceivedSessionTabsSnapshotByWorktree.delete(key)
  untrackWebSessionTabsWorktree(environmentId, worktreeId)
  removeWebSessionTabsEnvironment(environmentId, worktreeId)
  clearWebRuntimeWakeTerminalRespawnForWorktree(worktreeId)
  clearWebSessionReorderIntentsForWorktree({ environmentId }, worktreeId)
  clearWebSessionCloseIntentsForWorktree({ environmentId }, worktreeId)
  clearWebAgentSessionHandoffsForWorktree(environmentId, worktreeId)
  clearHostSessionTabIdMappings(environmentId, worktreeId)
  clearWebSessionBrowserPlacementsForWorktree(environmentId, worktreeId)
  clearWebSessionTerminalPlacementsForWorktree(environmentId, worktreeId)
}

export function clearWebSessionTabsTrackingForEnvironment(environmentId: string): void {
  const trimmedEnvironmentId = environmentId.trim()
  if (!trimmedEnvironmentId) {
    return
  }
  const keyPrefix = `${trimmedEnvironmentId}:`
  sessionTabsTrackingGenerationByEnvironment.set(
    trimmedEnvironmentId,
    (sessionTabsTrackingGenerationByEnvironment.get(trimmedEnvironmentId) ?? 0) + 1
  )
  for (const key of latestSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of replayableSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      replayableSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of latestReceivedSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestReceivedSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of latestSessionTabsRemovalFenceByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsRemovalFenceByWorktree.delete(key)
    }
  }
  for (const key of sessionTabsRecoveryStateByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      sessionTabsRecoveryStateByWorktree.delete(key)
    }
  }
  trackedSessionTabsWorktreeIdsByEnvironment.delete(trimmedEnvironmentId)
  for (const worktreeId of sessionTabsEnvironmentsByWorktree.keys()) {
    removeWebSessionTabsEnvironment(trimmedEnvironmentId, worktreeId)
  }
  for (const key of lastHostTerminalTabCountByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      lastHostTerminalTabCountByWorktree.delete(key)
    }
  }
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(trimmedEnvironmentId)
  if (mappingKeysByWorktree) {
    for (const mappingKeys of mappingKeysByWorktree.values()) {
      for (const mappingKey of mappingKeys) {
        hostSessionTabIdByLocalKey.delete(mappingKey)
      }
    }
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(trimmedEnvironmentId)
  }
  clearWebAgentSessionHandoffsForEnvironment(trimmedEnvironmentId)
  clearWebSessionBrowserPlacementsForEnvironment(trimmedEnvironmentId)
  clearWebSessionTerminalPlacementsForEnvironment(trimmedEnvironmentId)
  clearHostSessionMirrorHydration(trimmedEnvironmentId)
  clearAllWebRuntimeWakeTerminalRespawn()
}

export function getWebSessionTabsTrackingGeneration(environmentId: string): number {
  return sessionTabsTrackingGenerationByEnvironment.get(environmentId.trim()) ?? 0
}

export function resetWebSessionTabsSnapshotFreshnessForTests(): void {
  latestSessionTabsSnapshotByWorktree.clear()
  replayableSessionTabsSnapshotByWorktree.clear()
  latestReceivedSessionTabsSnapshotByWorktree.clear()
  latestSessionTabsRemovalFenceByWorktree.clear()
  sessionTabsRecoveryStateByWorktree.clear()
  trackedSessionTabsWorktreeIdsByEnvironment.clear()
  sessionTabsEnvironmentsByWorktree.clear()
  resetReceivedSessionTabsFrameSequenceForTests()
  lastHostTerminalTabCountByWorktree.clear()
  hostSessionTabIdByLocalKey.clear()
  hostSessionTabMappingKeysByEnvironmentAndWorktree.clear()
  hostWorkingClientBoundaryByPaneKey.clear()
  resetWebSessionBrowserPlacementsForTests()
}
