import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { normalizeCompatibleAgentTitleForOwner } from '../../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { getRemoteRuntimePtyEnvironmentId, toRemoteRuntimePtyId } from './runtime-terminal-stream'
import { resolveTerminalLayoutRoot } from './remote-terminal-layout-resolution'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from './web-runtime-session'
import { sanitizeTerminalLayoutPaneTitlesForLabels } from '@/lib/terminal-pane-title-sanitization'
import { normalizeTerminalLayoutPtyOwnership } from '@/components/terminal-pane/terminal-layout-pty-ownership'
import {
  isTerminalSurfaceTab,
  type ReadyTerminalSurface,
  type TerminalSurface
} from './web-session-tabs-surface-guards'

export type MirroredTerminalTab = {
  tab: TerminalTab
  hostTabId: string
  ptyIds: string[]
  layout: TerminalLayoutSnapshot
  retainedSurfaceByPrunedLeafId?: ReadonlyMap<string, TerminalSurface>
}
export function isRuntimeTerminalTabForEnvironment(
  tab: TerminalTab,
  environmentId: string
): boolean {
  if (!tab.ptyId) {
    return false
  }
  return getRemoteRuntimePtyEnvironmentId(tab.ptyId) === environmentId
}

export function isMirroredTerminalSurfaceId(tabId: string): boolean {
  return (
    tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX) ||
    tabId.includes(HOST_TERMINAL_SURFACE_SEPARATOR)
  )
}

export function chooseRemoteTerminalLayout(
  surfaces: readonly TerminalSurface[],
  ptyIdsByLeafId: Record<string, string>,
  existingLayout?: TerminalLayoutSnapshot,
  requestedActiveLeafId?: string
): TerminalLayoutSnapshot {
  const leafIds = surfaces.map((surface) => surface.leafId)
  const knownLeafIds = new Set(leafIds)
  const parentLayoutSource = surfaces.find((surface) => surface.parentLayout)
  const parentLayout = parentLayoutSource?.parentLayout
    ? sanitizeTerminalLayoutPaneTitlesForLabels(parentLayoutSource.parentLayout, [
        parentLayoutSource.title
      ])
    : undefined
  const activeLeafId =
    (requestedActiveLeafId && knownLeafIds.has(requestedActiveLeafId)
      ? requestedActiveLeafId
      : null) ??
    // Why: host title/status snapshots may still mark an agent pane active after this client selected a different split pane.
    (existingLayout?.activeLeafId && knownLeafIds.has(existingLayout.activeLeafId)
      ? existingLayout.activeLeafId
      : null) ??
    (parentLayout?.activeLeafId && knownLeafIds.has(parentLayout.activeLeafId)
      ? parentLayout.activeLeafId
      : null) ??
    surfaces.find((surface) => surface.isActive)?.leafId ??
    leafIds[0] ??
    null
  const expandedLeafId =
    requestedActiveLeafId &&
    (Boolean(existingLayout?.expandedLeafId) || Boolean(parentLayout?.expandedLeafId))
      ? requestedActiveLeafId
      : parentLayout?.expandedLeafId && knownLeafIds.has(parentLayout.expandedLeafId)
        ? parentLayout.expandedLeafId
        : null
  return {
    // Why: host parentLayout is authoritative for split direction; else keep the prior client tree, then degenerate — never re-guess a direction.
    root: resolveTerminalLayoutRoot({
      authoritativeRoot: parentLayout?.root,
      existingRoot: existingLayout?.root,
      leafIds,
      onSynthesize: (leafCount) =>
        console.warn(
          `[web-session-tabs-sync] synthesized layout for ${leafCount} leaves; no authoritative or prior tree covered them`
        )
    }),
    activeLeafId,
    expandedLeafId,
    ptyIdsByLeafId,
    // Why: surface.title is the tab/PTY label, not a pane title; restoring it as one renders a fake title bar. Only host layout titles are real pane titles.
    ...(parentLayout?.titlesByLeafId ? { titlesByLeafId: parentLayout.titlesByLeafId } : {})
  }
}

export function shouldReplaceTerminalTab(
  tab: TerminalTab,
  environmentId: string,
  nextRemotePtyIds: ReadonlySet<string>,
  nextMirroredTerminalIds: ReadonlySet<string>,
  exactProvisionalHandoffs: ReadonlySet<string>
): boolean {
  if (exactProvisionalHandoffs.has(tab.id)) {
    // Why: agent kind is not session identity; retire only the provisional tab
    // whose request or structured response identifies this exact host surface.
    return true
  }
  if (isMirroredTerminalSurfaceId(tab.id)) {
    // Why: host snapshots are authoritative for mirrored tabs; replace old mirrors even when the next surface still awaits a stream handle, else parity drifts.
    return true
  }
  if (tab.pendingActivationSpawn && tab.ptyId === null && nextRemotePtyIds.size > 0) {
    return true
  }
  if (!isRuntimeTerminalTabForEnvironment(tab, environmentId)) {
    return false
  }
  // Why: web-created remote tabs use local UUIDs until the host publishes their surface; only retire them once their PTY appears in the snapshot.
  return (
    tab.ptyId !== null &&
    (nextRemotePtyIds.has(tab.ptyId) ||
      nextMirroredTerminalIds.has(toWebTerminalSurfaceTabId(tab.id)))
  )
}

/** Constructs mirrored terminal tabs from the mobile session status payload, normalising Pi-compatible agent titles under launch ownership. */
export function buildMirroredTerminalTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  existingById: ReadonlyMap<string, TerminalTab>,
  existingLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot>>,
  sortOffset: number,
  now: number,
  focusTarget?: { parentTabId: string; leafId: string },
  terminalPtyMode: 'local' | 'remote' = 'remote'
): MirroredTerminalTab[] {
  const groups = new Map<string, TerminalSurface[]>()
  for (const tab of snapshot.tabs.filter(isTerminalSurfaceTab)) {
    const group = groups.get(tab.parentTabId) ?? []
    group.push(tab)
    groups.set(tab.parentTabId, group)
  }

  return [...groups.entries()].map(([parentTabId, surfaces], index) => {
    const localTabId = toWebTerminalSurfaceTabId(parentTabId)
    const existingLayout = existingLayoutsByTabId[localTabId]
    const requestedActiveLeafId =
      focusTarget?.parentTabId === parentTabId ? focusTarget.leafId : undefined
    const activeSurface =
      (requestedActiveLeafId
        ? surfaces.find((surface) => surface.leafId === requestedActiveLeafId)
        : undefined) ??
      (existingLayout?.activeLeafId
        ? surfaces.find((surface) => surface.leafId === existingLayout.activeLeafId)
        : undefined) ??
      surfaces.find((surface) => surface.isActive) ??
      surfaces[0]!
    const ptyIdForSurface = (handle: string): string =>
      terminalPtyMode === 'local' ? handle : toRemoteRuntimePtyId(handle, environmentId)
    const ptyIdsByLeafId = Object.fromEntries(
      surfaces
        .filter((surface): surface is ReadyTerminalSurface => surface.status === 'ready')
        .map((surface) => [surface.leafId, ptyIdForSurface(surface.terminal)])
    )
    const layout = normalizeTerminalLayoutPtyOwnership(
      chooseRemoteTerminalLayout(surfaces, ptyIdsByLeafId, existingLayout, requestedActiveLeafId)
    ).snapshot
    const layoutPtyEntries = Object.entries(layout.ptyIdsByLeafId ?? {})
    const ptyIds = layoutPtyEntries.map(([, ptyId]) => ptyId)
    let retainedSurfaceByPrunedLeafId: Map<string, TerminalSurface> | undefined
    if (layoutPtyEntries.length < Object.keys(ptyIdsByLeafId).length) {
      const retainedLeafIdByPtyId = new Map(
        layoutPtyEntries.map(([leafId, ptyId]) => [ptyId, leafId])
      )
      const surfaceByLeafId = new Map(surfaces.map((surface) => [surface.leafId, surface]))
      retainedSurfaceByPrunedLeafId = new Map()
      for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
        const retainedLeafId = retainedLeafIdByPtyId.get(ptyId)
        if (retainedLeafId && retainedLeafId !== leafId) {
          const retainedSurface = surfaceByLeafId.get(retainedLeafId)
          if (retainedSurface) {
            retainedSurfaceByPrunedLeafId.set(leafId, retainedSurface)
          }
        }
      }
    }
    const launchAgent =
      activeSurface.launchAgent ?? surfaces.find((surface) => surface.launchAgent)?.launchAgent
    const ownerAgent = resolvePaneAgentOwner({
      launchAgent,
      hookAgent: activeSurface.agentStatus?.agentType,
      siblingHookAgent: surfaces.find((surface) => surface.agentStatus?.agentType)?.agentStatus
        ?.agentType
    })
    const title = normalizeCompatibleAgentTitleForOwner(
      activeSurface.title.trim() || surfaces[0]?.title.trim() || 'Terminal',
      ownerAgent
    )
    const existing =
      existingById.get(localTabId) ??
      existingById.get(parentTabId) ??
      surfaces
        .map((surface) => existingById.get(toWebTerminalSurfaceTabId(surface.id)))
        .find((tab): tab is TerminalTab => Boolean(tab))
    const quickCommandLabel =
      activeSurface.quickCommandLabel?.trim() ||
      surfaces.find((surface) => surface.quickCommandLabel?.trim())?.quickCommandLabel?.trim() ||
      existing?.quickCommandLabel?.trim()
    // Why: startupCwd is host-owned launch metadata; once the host omits it, don't resurrect stale subdirectory intent.
    const startupCwd =
      activeSurface.startupCwd || surfaces.find((surface) => surface.startupCwd)?.startupCwd
    // Why: color/pin echo back through host snapshots, so prefer the client's own record and fall back to host only without a prior tab (avoids echo-window reverts).
    const hostColorSurface = surfaces.find((surface) => surface.color != null)
    const color = existing ? (existing.color ?? null) : (hostColorSurface?.color ?? null)
    const isPinned = existing
      ? existing.isPinned === true
      : surfaces.some((surface) => surface.isPinned)
    // Why: viewMode echoes back through host snapshots, so prefer the client's record during the echo window and adopt the host value only without a prior tab.
    const hostViewModeSurface = surfaces.find((surface) => surface.viewMode)
    const viewMode = existing ? existing.viewMode : hostViewModeSurface?.viewMode
    return {
      tab: {
        id: localTabId,
        ptyId: ptyIdsByLeafId[activeSurface.leafId] ?? null,
        worktreeId: snapshot.worktree,
        title,
        defaultTitle: existing?.defaultTitle ?? title,
        // Why: the host transport carries no generated title, so rebuilding the tab
        // without this dropped the client's agent-prompt label on every snapshot.
        ...(existing?.generatedTitle ? { generatedTitle: existing.generatedTitle } : {}),
        ...(existing?.aiVaultTitle ? { aiVaultTitle: existing.aiVaultTitle } : {}),
        ...(quickCommandLabel ? { quickCommandLabel } : {}),
        ...(startupCwd ? { startupCwd } : {}),
        customTitle: existing?.customTitle ?? null,
        color,
        isPinned,
        ...(viewMode ? { viewMode } : {}),
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + index,
        // Why: launchAgent is host-owned lifecycle metadata; once the host omits it, don't resurrect stale startup intent.
        ...(launchAgent ? { launchAgent } : {})
      },
      hostTabId: parentTabId,
      ptyIds,
      layout,
      ...(retainedSurfaceByPrunedLeafId ? { retainedSurfaceByPrunedLeafId } : {})
    }
  })
}

export function toMirroredPaneKey(
  surface: TerminalSurface,
  leafId = surface.leafId
): string | null {
  if (!isTerminalLeafId(leafId)) {
    return null
  }
  return makePaneKey(toWebTerminalSurfaceTabId(surface.parentTabId), leafId)
}
