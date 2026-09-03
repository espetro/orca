import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveWebAgentSessionHandoff } from './web-agent-session-handoff'
import { toWebTerminalSurfaceTabId } from './web-runtime-session'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync-state'
import {
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree
} from './web-session-tabs-sync-state'
import type { MirroredBrowserTab } from './web-session-tabs-mirrored-browser-tabs'
import type { MirroredEditorTab } from './web-session-tabs-mirrored-editor-tabs'
import type { MirroredAgentTab } from './web-session-tabs-mirrored-agent-tabs'
import type { TerminalSurface } from './web-session-tabs-surface-guards'

export function hostSessionTabMappingKey(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string {
  return `${args.environmentId}:${args.worktreeId}:${args.tabId}`
}

export function clearHostSessionTabIdMappings(environmentId: string, worktreeId: string): void {
  const mappingKeysByWorktree = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)
  const mappingKeys = mappingKeysByWorktree?.get(worktreeId)
  if (!mappingKeys) {
    return
  }
  for (const mappingKey of mappingKeys) {
    hostSessionTabIdByLocalKey.delete(mappingKey)
  }
  mappingKeysByWorktree?.delete(worktreeId)
  if (mappingKeysByWorktree?.size === 0) {
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(environmentId)
  }
}

export function setHostSessionTabIdMapping(
  args: { environmentId: string; worktreeId: string; tabId: string },
  hostTabId: string
): void {
  const mappingKey = hostSessionTabMappingKey(args)
  hostSessionTabIdByLocalKey.set(mappingKey, hostTabId)
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(args.environmentId) ?? new Map()
  const mappingKeys = mappingKeysByWorktree.get(args.worktreeId) ?? new Set<string>()
  mappingKeys.add(mappingKey)
  mappingKeysByWorktree.set(args.worktreeId, mappingKeys)
  hostSessionTabMappingKeysByEnvironmentAndWorktree.set(args.environmentId, mappingKeysByWorktree)
}

export function resolveHostSessionTabIdForWebSessionTab(
  _state: WebSessionTabsSyncState,
  args: {
    environmentId: string
    worktreeId: string
    tabId: string
  }
): string | null {
  return (
    hostSessionTabIdByLocalKey.get(hostSessionTabMappingKey(args)) ??
    // Why: structured create returns canonical identity before its confirming
    // snapshot; an immediate user close must already target that host tab.
    resolveWebAgentSessionHandoff({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      provisionalTabId: args.tabId
    })
  )
}
export function updateHostSessionTabIdMappings(args: {
  environmentId: string
  worktreeId: string
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
  agentTabs: readonly MirroredAgentTab[]
}): void {
  clearHostSessionTabIdMappings(args.environmentId, args.worktreeId)

  const mirroredTerminalIds = new Set(args.terminalTabs.map((tab) => tab.id))
  for (const surface of args.terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (mirroredTerminalIds.has(localId)) {
      setHostSessionTabIdMapping({ ...args, tabId: localId }, surface.parentTabId)
    }
  }
  for (const entry of args.browserTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.editorTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.agentTabs) {
    hostSessionTabIdByLocalKey.set(
      hostSessionTabMappingKey({ ...args, tabId: entry.unifiedTab.id }),
      entry.hostTabId
    )
  }
}
