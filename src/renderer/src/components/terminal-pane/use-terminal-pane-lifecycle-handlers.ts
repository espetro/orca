import type { useCallback } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { clearTerminalScrollbackAndFollowOutput } from '@/lib/pane-manager/terminal-scrollback-clear'
import { clearWebRuntimeTerminalBuffer } from '@/runtime/web-runtime-session'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  type SessionRestoredBannerDismissEvent,
  type SessionRestoredBannerReason
} from './session-restored-banner-pane-state'
import type { PaneProcessExit } from './pty-connection-types'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneLifecycleHandlersOptions = {
  managerRef: React.MutableRefObject<PaneManager | null>
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  paneTitlesRef: React.MutableRefObject<Record<number, string>>
  paneTitlesState: [
    Record<number, string>,
    (value: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>)) => void
  ]
  sessionRestoredBannerPaneIdsState: [
    Map<number, SessionRestoredBannerReason>,
    (value: Map<number, SessionRestoredBannerReason> | ((prev: Map<number, SessionRestoredBannerReason>) => Map<number, SessionRestoredBannerReason>)) => void
  ]
  paneProcessExitsByPaneIdState: [
    Record<number, PaneProcessExit>,
    (value: Record<number, PaneProcessExit> | ((prev: Record<number, PaneProcessExit>) => Record<number, PaneProcessExit>)) => void
  ]
  clearedScrollbackLeafIdsRef: React.MutableRefObject<Set<string>>
  removedTitleLeafIdsRef: React.MutableRefObject<Set<string>>
  persistLayoutSnapshot: () => void
}

export type UseTerminalPaneLifecycleHandlers = ReturnType<typeof useTerminalPaneLifecycleHandlers>

export function useTerminalPaneLifecycleHandlers(
  options: UseTerminalPaneLifecycleHandlersOptions
): {
  handlePaneProcessDied: (processExit: PaneProcessExit) => void
  clearSessionRestoredBannerForPane: (paneId: number) => void
  showRestoredSessionBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
  dismissSessionRestoredBanner: (event: SessionRestoredBannerDismissEvent) => void
  clearPaneScrollback: (pane: ManagedPane) => void
  removePaneTitle: (paneId: number) => void
  handleClearPaneTitleShortcut: (paneId: number) => void
} {
  const {
    managerRef,
    paneTransportsRef,
    paneTitlesRef,
    paneTitlesState: [, setPaneTitles],
    sessionRestoredBannerPaneIdsState: [, setSessionRestoredBannerPaneIds],
    paneProcessExitsByPaneIdState: [, setPaneProcessExitsByPaneId],
    clearedScrollbackLeafIdsRef,
    removedTitleLeafIdsRef,
    persistLayoutSnapshot
  } = options

  const handlePaneProcessDied = (processExit: PaneProcessExit) => {
    setPaneProcessExitsByPaneId((current) => ({
      ...current,
      [processExit.paneId]: processExit
    }))
  }

  const clearSessionRestoredBannerForPane = (paneId: number): void => {
    setSessionRestoredBannerPaneIds((prev) => {
      const next = removeSessionRestoredBannerPaneId(prev, paneId)
      return next === prev ? prev : next
    })
  }

  const showRestoredSessionBanner = (
    paneId: number,
    reason: SessionRestoredBannerReason = 'restored'
  ): void => {
    setSessionRestoredBannerPaneIds((prev) => {
      const next = addSessionRestoredBannerPaneId(prev, paneId, reason)
      return next === prev ? prev : next
    })
  }

  const dismissSessionRestoredBanner = (event: SessionRestoredBannerDismissEvent): void => {
    setSessionRestoredBannerPaneIds((prev) =>
      dismissSessionRestoredBannerPaneIds(prev, event, managerRef.current?.getPanes() ?? [])
    )
  }

  const clearPaneScrollback = (pane: ManagedPane): void => {
    clearedScrollbackLeafIdsRef.current.add(pane.leafId)
    clearTerminalScrollbackAndFollowOutput(pane.terminal)
    const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
    const clearedRemoteHostBuffer = clearWebRuntimeTerminalBuffer(ptyId)
    if (!clearedRemoteHostBuffer && ptyId) {
      window.api.pty.clearBuffer(ptyId)
    }
    persistLayoutSnapshot()
  }

  const removePaneTitle = (paneId: number) => {
    setPaneTitles((prev) => {
      if (!(paneId in prev)) {
        return prev
      }
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    if (paneId in paneTitlesRef.current) {
      const next = { ...paneTitlesRef.current }
      delete next[paneId]
      paneTitlesRef.current = next
    }
    const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
    if (leafId) {
      removedTitleLeafIdsRef.current.add(leafId)
    }
    persistLayoutSnapshot()
  }

  const handleClearPaneTitleShortcut = (paneId: number) => {
    if (!paneTitlesRef.current[paneId]) {
      return
    }
    removePaneTitle(paneId)
  }

  return {
    handlePaneProcessDied,
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    dismissSessionRestoredBanner,
    clearPaneScrollback,
    removePaneTitle,
    handleClearPaneTitleShortcut
  }
}
