import type { Store } from '../../shared/store-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimeNotifier } from '../../shared/runtime-notifier-types'
import type { RuntimeWorktreeLifecycleEvent } from '../../shared/runtime-types'

export type RuntimeClientEventPublishingCommandsDeps = {
  store: Store | null
  notifier: RuntimeNotifier | null
  clientEventListeners: Set<(event: RuntimeClientEvent) => void>
  terminalSideEffectExcludedClientEventListeners: Set<(event: RuntimeClientEvent) => void>
  terminalSideEffectTitleGateKeysByClientEventListener: Map<
    (event: RuntimeClientEvent) => void,
    Map<string, string>
  >
  terminalSleepStateByWorktreeId: Map<string, unknown>
  nativeChatLaunchDraftResolutionByTabId: Map<string, unknown>
  mobileSessionTabsByWorktree: Map<string, unknown>
  sshRelayRecoveryGenerationByTargetId: Map<string, number>
  worktreeLifecycleListeners: Set<(event: RuntimeWorktreeLifecycleEvent) => void>
  makeDecorativeTitleGateKey: (rawTitle: string, normalizedTitle: string) => string
  notifyRuntimeListeners: (
    listeners: Set<(event: RuntimeClientEvent) => void>,
    handler: (listener: (event: RuntimeClientEvent) => void) => void,
    label: string
  ) => void
  notifyMobileSessionTabsChangedNow: (worktreeId: string, changeSequence: number) => void
  scheduleMobileSessionTabsChanged: (worktreeId: string) => void
  handles: Map<string, unknown>
  ptysById: Map<string, unknown>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
    worktreeId: string,
    options: unknown
  ) => void
  getKnownWorkspaceSessionWorktreeIds: () => string[]
  refreshMobileSessionPtyRecords: () => Promise<void>
  runtimeWorktreeIdsEqual: (id1: unknown, id2: unknown) => boolean
  parsePaneKey: (paneKey: string) => unknown
  splitWorktreeId: (worktreeId: string) => unknown
  getPublicSshState: (state: unknown) => unknown
  wakeFolderRepoGitUpgradeWatch: () => void
}
