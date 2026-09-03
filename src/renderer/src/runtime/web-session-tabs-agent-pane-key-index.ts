import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { WebSessionTabsBatchContext } from './web-session-tabs-batch-records'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'

export function batchAgentPaneKeysForTabs(
  state: WebSessionTabsSyncState,
  tabIds: ReadonlySet<string>,
  batchContext?: WebSessionTabsBatchContext
): string[] {
  if (!batchContext) {
    return Object.keys(state.agentStatusByPaneKey)
  }
  if (!batchContext.agentPaneKeysByTabId) {
    batchContext.agentPaneKeysByTabId = new Map()
    for (const paneKey of Object.keys(state.agentStatusByPaneKey)) {
      const tabId = parsePaneKey(paneKey)?.tabId
      if (!tabId) {
        continue
      }
      const paneKeys = batchContext.agentPaneKeysByTabId.get(tabId) ?? new Set<string>()
      paneKeys.add(paneKey)
      batchContext.agentPaneKeysByTabId.set(tabId, paneKeys)
    }
  }
  return [...tabIds].flatMap((tabId) => [...(batchContext.agentPaneKeysByTabId?.get(tabId) ?? [])])
}

export function updateBatchAgentPaneKey(
  paneKey: string,
  present: boolean,
  batchContext?: WebSessionTabsBatchContext
): void {
  const tabId = parsePaneKey(paneKey)?.tabId
  const index = batchContext?.agentPaneKeysByTabId
  if (!tabId || !index) {
    return
  }
  if (present) {
    const paneKeys = index.get(tabId) ?? new Set<string>()
    paneKeys.add(paneKey)
    index.set(tabId, paneKeys)
    return
  }
  const paneKeys = index.get(tabId)
  paneKeys?.delete(paneKey)
  if (paneKeys?.size === 0) {
    index.delete(tabId)
  }
}
