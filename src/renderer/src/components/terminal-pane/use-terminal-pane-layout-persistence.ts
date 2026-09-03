import { useCallback, useEffect } from 'react'
import { useAppStore } from '../../store'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { RemotePaneLayoutPusher } from './remote-pane-layout-push'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { serializeTerminalLayout, type EMPTY_LAYOUT } from './layout-serialization'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  isSyntheticSinglePaneTitle,
  sanitizeTerminalLayoutPaneTitles
} from '@/lib/terminal-pane-title-sanitization'
import type { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'

type UseTerminalPaneLayoutPersistenceArgs = {
  managerRef: React.MutableRefObject<PaneManager | null>
  // Why: the rename hook below owns the container ref; a lazy getter breaks the declare-before-use cycle without reordering foreign hook calls.
  getRenameContainerRef: () => React.MutableRefObject<HTMLDivElement | null>
  expandedPaneIdRef: React.MutableRefObject<number | null>
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  clearedScrollbackLeafIdsRef: React.MutableRefObject<Set<string>>
  removedTitleLeafIdsRef: React.MutableRefObject<Set<string>>
  remotePaneLayoutPusherRef: React.MutableRefObject<RemotePaneLayoutPusher | null>
  paneTitlesRef: React.MutableRefObject<Record<number, string>>
  paneTitles: Record<number, string>
  setPaneTitles: (
    value: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>)
  ) => void
  tabId: string
  worktreeId: string
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void
  savedLayout: ReturnType<typeof EMPTY_LAYOUT>
  terminalTab: ReturnType<typeof getCachedTerminalTabForWorktree> | undefined
  paneCount: number
}

export function useTerminalPaneLayoutPersistence(args: UseTerminalPaneLayoutPersistenceArgs) {
  const {
    managerRef,
    getRenameContainerRef,
    expandedPaneIdRef,
    paneTransportsRef,
    clearedScrollbackLeafIdsRef,
    removedTitleLeafIdsRef,
    remotePaneLayoutPusherRef,
    paneTitlesRef,
    paneTitles,
    setPaneTitles,
    tabId,
    worktreeId,
    setTabLayout,
    savedLayout,
    terminalTab,
    paneCount
  } = args

  // Memoized so downstream hooks don't re-register listeners each render; reads only refs/stable values, so deps stay minimal.
  const persistLayoutSnapshot = useCallback((): void => {
    const manager = managerRef.current
    const container = getRenameContainerRef().current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const leafIdByPaneId = manager.getLeafIdMap()
    const layout = serializeTerminalLayout(
      container,
      activePaneId,
      expandedPaneIdRef.current,
      leafIdByPaneId
    )
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    const currentPanes = manager.getPanes()
    const currentLeafIds = new Set(currentPanes.map((p) => p.leafId))
    const clearedScrollbackLeafIds = clearedScrollbackLeafIdsRef.current
    const scrollbackPreserveLeafIds = new Set(
      [...currentLeafIds].filter((leafId) => !clearedScrollbackLeafIds.has(leafId))
    )
    // Preserve existing buffersByLeafId so layout-only persists don't clobber captured scrollback; drop dead leaves.
    const mergedBuffers = mergeCapturedLeafState({
      prior: existing?.buffersByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedBuffers).length > 0) {
      layout.buffersByLeafId = mergedBuffers
    }
    const mergedScrollbackRefs = mergeCapturedLeafState({
      prior: existing?.scrollbackRefsByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedScrollbackRefs).length > 0) {
      layout.scrollbackRefsByLeafId = mergedScrollbackRefs
    }
    // Why: before PTYs attach (deferred rAF) transports return null; preserve prior leaf→PTY mappings so a fast remount doesn't force fresh spawns.
    const livePtyEntries = currentPanes
      .map((p) => [p.leafId, paneTransportsRef.current.get(p.id)?.getPtyId() ?? null] as const)
      .filter(
        (entry): entry is readonly [(typeof currentPanes)[number]['leafId'], string] =>
          entry[1] !== null
      )
    const mergedPtyIds = mergeCapturedLeafState({
      prior: existing?.ptyIdsByLeafId,
      fresh: Object.fromEntries(livePtyEntries),
      currentLeafIds
    })
    if (Object.keys(mergedPtyIds).length > 0) {
      layout.ptyIdsByLeafId = mergedPtyIds
    }
    layout.activeLeafId = resolveTerminalLayoutActiveLeafId({
      root: layout.root,
      activeLeafId: layout.activeLeafId,
      ptyIdsByLeafId: mergedPtyIds
    })
    // Preserve pane titles from live React state (via ref); Zustand is stale for in-flight edits not yet persisted.
    const titlesByLeafId: Record<string, string> = {}
    const removedTitleLeafIds = removedTitleLeafIdsRef.current
    for (const pane of currentPanes) {
      const existingTitle = existing?.titlesByLeafId?.[pane.leafId]
      if (existingTitle && !removedTitleLeafIds.has(pane.leafId)) {
        titlesByLeafId[pane.leafId] = existingTitle
      }
    }
    // Why: agents can persist layout while pane-title React state lags, so keep existing titles unless removed before overlaying live state.
    const titles = paneTitlesRef.current
    for (const pane of currentPanes) {
      const title = titles[pane.id]
      if (title) {
        titlesByLeafId[pane.leafId] = title
        removedTitleLeafIds.delete(pane.leafId)
      }
    }
    if (Object.keys(titlesByLeafId).length > 0) {
      layout.titlesByLeafId = titlesByLeafId
    }
    setTabLayout(tabId, layout)
    // Why: pane geometry is host-authoritative for remote tabs, so push ratios/expand/titles or they revert on the next snapshot.
    const hasRemotePane = Object.values(mergedPtyIds).some(
      (ptyId) => typeof ptyId === 'string' && isRemoteRuntimePtyId(ptyId)
    )
    if (hasRemotePane) {
      remotePaneLayoutPusherRef.current?.push({ worktreeId, tabId, layout })
    }
    for (const leafId of currentLeafIds) {
      clearedScrollbackLeafIds.delete(leafId)
    }
  }, [tabId, setTabLayout, worktreeId])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const sanitized = sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab)
    if (sanitized !== savedLayout) {
      setTabLayout(tabId, sanitized)
    }
  }, [savedLayout, setTabLayout, tabId, terminalTab])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length !== 1) {
      return
    }
    const paneId = panes[0].id
    const currentTitle = paneTitlesRef.current[paneId]
    if (!currentTitle || !isSyntheticSinglePaneTitle(currentTitle, terminalTab)) {
      return
    }
    const nextTitles = { ...paneTitlesRef.current }
    delete nextTitles[paneId]
    paneTitlesRef.current = nextTitles
    setPaneTitles((prev) => {
      if (!prev[paneId] || !isSyntheticSinglePaneTitle(prev[paneId], terminalTab)) {
        return prev
      }
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    persistLayoutSnapshot()
  }, [paneCount, paneTitles, persistLayoutSnapshot, terminalTab])

  return { persistLayoutSnapshot }
}
