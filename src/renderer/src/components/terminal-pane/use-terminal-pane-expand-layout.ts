import { useCallback, useLayoutEffect } from 'react'
import type { PaneProcessExit } from './pty-connection-types'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { applyTerminalPaneAttentionToManager } from './apply-terminal-pane-attention'
import { subscribeTerminalPaneAttention } from './subscribe-terminal-pane-attention'
import { syncSessionRestoredBannerTitleSpace } from './session-restored-banner-pane-state'
import { fitPanes } from './pane-helpers'

type UseTerminalPaneExpandLayoutParams = {
  tabId: string
  paneCount: number
  paneTitles: Map<number, string>
  renamingPaneId: number | null
  sessionRestoredBannerPaneIds: Set<number>
  isVisible: boolean
  shouldMeasureHiddenStartup: boolean
  paneLayoutRevision: number
  managerRef: React.MutableRefObject<PaneManager | null>
  setPaneProcessExitsByPaneId: React.Dispatch<React.SetStateAction<Record<number, PaneProcessExit>>>
}

type UseTerminalPaneExpandLayoutReturn = {
  clearPaneProcessExit: (paneId: number) => void
  applyTerminalPaneAttention: () => void
}

export function useTerminalPaneExpandLayout({
  tabId,
  paneCount,
  paneTitles,
  renamingPaneId,
  sessionRestoredBannerPaneIds,
  isVisible,
  shouldMeasureHiddenStartup,
  paneLayoutRevision,
  managerRef,
  setPaneProcessExitsByPaneId
}: UseTerminalPaneExpandLayoutParams): UseTerminalPaneExpandLayoutReturn {
  const clearPaneProcessExit = useCallback((paneId: number) => {
    setPaneProcessExitsByPaneId((current) => {
      if (current[paneId] === undefined) {
        return current
      }
      const next = { ...current }
      delete next[paneId]
      return next
    })
  }, [setPaneProcessExitsByPaneId])

  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    applyTerminalPaneAttentionToManager(manager, tabId)
  }, [tabId, managerRef])

  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])

  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: manager.getPanes(),
      paneTitles,
      renamingPaneId,
      sessionRestoredBannerPaneIds
    })
    if (needsFit && (isVisible || shouldMeasureHiddenStartup)) {
      fitPanes(manager)
    }
  }, [
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup,
    managerRef
  ])

  return {
    clearPaneProcessExit,
    applyTerminalPaneAttention
  }
}
