export function getTabIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  return paneKey.slice(0, separator)
}

export function getLeafIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  const leafId = paneKey.slice(separator + 1)
  return leafId.length > 0 ? leafId : null
}

export function findAgentPaneWorktreeId(
  state: { tabsByWorktree: Record<string, readonly { id: string }[]> },
  paneKey: string
): string | null {
  const tabId = getTabIdFromPaneKey(paneKey)
  if (!tabId) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}
