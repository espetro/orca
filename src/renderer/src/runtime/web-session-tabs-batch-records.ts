import type { OpenFile } from '../store/slices/editor'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'

export type WebSessionTabsBatchRecordKey =
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'agentStatusByPaneKey'
  | 'automaticAgentResumeClaimsByTabId'
  | 'browserCertificateFailuresByPageId'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'pendingStartupByTabId'
  | 'ptyIdsByTabId'
  | 'remoteBrowserPageHandlesByPageId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'

/** Open files bucketed by worktree. A snapshot only reconciles its own worktree, so a
 *  batch can decide there is nothing to do without walking every open file in the app.
 *  `source` pins the array it describes; each rebuild updates it in place instead of
 *  re-bucketing, so a batch never pays for the whole array twice. */
export type WebSessionOpenFilesIndex = {
  source: readonly OpenFile[]
  byWorktree: Map<string, OpenFile[]>
}

export type WebSessionTabsBatchContext = {
  agentPaneKeysByTabId: Map<string, Set<string>> | null
  changedRecords: Set<WebSessionTabsBatchRecordKey>
  openFilesIndex: WebSessionOpenFilesIndex | null
}
export function writableWebSessionTabsRecord<K extends WebSessionTabsBatchRecordKey>(
  state: WebSessionTabsSyncState,
  recordKey: K,
  batchContext?: WebSessionTabsBatchContext
): NonNullable<WebSessionTabsSyncState[K]> {
  const record = (state[recordKey] ?? {}) as NonNullable<WebSessionTabsSyncState[K]>
  if (!batchContext) {
    return { ...record } as NonNullable<WebSessionTabsSyncState[K]>
  }
  // Why: one batch owns its record copies, so later snapshots can update them without recopying every workspace.
  if (batchContext.changedRecords.has(recordKey)) {
    return record
  }
  const next = { ...record } as NonNullable<WebSessionTabsSyncState[K]>
  const mutableState = state as unknown as Record<
    WebSessionTabsBatchRecordKey,
    Record<string, unknown>
  >
  mutableState[recordKey] = next as Record<string, unknown>
  batchContext.changedRecords.add(recordKey)
  return next
}

export function withWorktreeEntry<T>(
  state: WebSessionTabsSyncState,
  recordKey: WebSessionTabsBatchRecordKey,
  key: string,
  value: T | null,
  equal: (a: T | undefined, b: T | null) => boolean,
  batchContext?: WebSessionTabsBatchContext,
  deleteNull = true
): Record<string, T> {
  const record = (state[recordKey] ?? {}) as Record<string, T>
  if (equal(record[key], value)) {
    return record
  }
  const next = writableWebSessionTabsRecord(state, recordKey, batchContext) as Record<string, T>
  if (value === null && deleteNull) {
    delete next[key]
  } else {
    next[key] = value as T
  }
  return next
}
/** This worktree's open files — the only scope a snapshot reconciles, so a batch can
 *  answer from here instead of walking every open file in the app. */
export function webSessionOpenFilesForWorktree(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): readonly OpenFile[] {
  if (!batchContext) {
    return state.openFiles.filter((file) => file.worktreeId === worktreeId)
  }
  let index = batchContext.openFilesIndex
  if (!index || index.source !== state.openFiles) {
    const byWorktree = new Map<string, OpenFile[]>()
    for (const file of state.openFiles) {
      const bucket = byWorktree.get(file.worktreeId) ?? []
      bucket.push(file)
      byWorktree.set(file.worktreeId, bucket)
    }
    index = { source: state.openFiles, byWorktree }
    batchContext.openFilesIndex = index
  }
  return index.byWorktree.get(worktreeId) ?? []
}

/** Retargets the index at the array a snapshot just produced, re-bucketing only the
 *  worktree that changed. Rebuilding it wholesale would cost the entire array again on
 *  every snapshot, which is the cost this index exists to avoid. */
export function advanceWebSessionOpenFilesIndex(
  batchContext: WebSessionTabsBatchContext | undefined,
  nextOpenFiles: readonly OpenFile[],
  worktreeId: string
): void {
  const index = batchContext?.openFilesIndex
  if (!index || index.source === nextOpenFiles) {
    return
  }
  const bucket: OpenFile[] = []
  for (const file of nextOpenFiles) {
    if (file.worktreeId === worktreeId) {
      bucket.push(file)
    }
  }
  index.byWorktree.set(worktreeId, bucket)
  index.source = nextOpenFiles
}

/** Mirrors `openFiles.find()` first-wins lookup, which duplicate ids make observable. */
export function firstOpenFileByIdForWorktree(files: readonly OpenFile[]): Map<string, OpenFile> {
  const byId = new Map<string, OpenFile>()
  for (const file of files) {
    if (!byId.has(file.id)) {
      byId.set(file.id, file)
    }
  }
  return byId
}
