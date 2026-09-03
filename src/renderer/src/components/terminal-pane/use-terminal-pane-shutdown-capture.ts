import { useEffect } from 'react'
import { useAppStore } from '../../store'
import { captureTerminalShutdownLayout } from './terminal-shutdown-layout-capture'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../shared/workspace-session-terminal-buffers'
import { shutdownBufferCaptures } from './shutdown-buffer-captures'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

export function useTerminalPaneShutdownCapture(args: {
  tabId: string
  worktreeId: string
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedPaneIdRef: React.MutableRefObject<number | null>
  paneTransportsRef: React.RefObject<Map<number, unknown>>
  paneTitlesRef: React.MutableRefObject<Record<number, string>>
  clearedScrollbackLeafIdsRef: React.MutableRefObject<Set<string>>
  setTabLayout: (tabId: string, layout: unknown) => void
}): void {
  const { tabId, worktreeId, managerRef, containerRef, expandedPaneIdRef, paneTransportsRef, paneTitlesRef, clearedScrollbackLeafIdsRef, setTabLayout } = args

  useEffect(() => {
    const captureBuffers = (options?: { includeLocalBuffers?: boolean }): void => {
      const manager = managerRef.current
      const container = containerRef.current
      if (!manager || !container) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      // Why: setTabLayout REPLACES, not merges; a transient empty capture (xterm not yet rendered) would wipe a known-good buffer, so merge prior state for empty leaves.
      const state = useAppStore.getState()
      const existing = state.terminalLayoutsByTabId[tabId]
      const includeLocalBuffers = options?.includeLocalBuffers ?? true
      const shouldCaptureScrollbackBuffers = includeLocalBuffers
        ? true
        : shouldPreserveTerminalScrollbackBuffers(worktreeId, state.repos)
      const layout = captureTerminalShutdownLayout({
        manager,
        container,
        expandedPaneId: expandedPaneIdRef.current,
        paneTransports: paneTransportsRef.current,
        paneTitlesByPaneId: paneTitlesRef.current,
        existingLayout: existing,
        // Why: beforeunload skips local/floating bytes (session payloads prune them); worktree sleep keeps them as defense-in-depth.
        captureBuffers: shouldCaptureScrollbackBuffers,
        clearedScrollbackLeafIds: clearedScrollbackLeafIdsRef.current
      })
      setTabLayout(tabId, layout)
      for (const pane of panes) {
        clearedScrollbackLeafIdsRef.current.delete(pane.leafId)
      }
    }
    shutdownBufferCaptures.set(tabId, captureBuffers)
    return () => {
      // Why: only remove if the entry still points at this closure; a remount may have replaced it first.
      if (shutdownBufferCaptures.get(tabId) === captureBuffers) {
        shutdownBufferCaptures.delete(tabId)
      }
    }
  }, [tabId, worktreeId, managerRef, containerRef, expandedPaneIdRef, paneTransportsRef, paneTitlesRef, clearedScrollbackLeafIdsRef, setTabLayout])
}
