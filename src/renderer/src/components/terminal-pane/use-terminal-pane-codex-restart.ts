import { useCallback, useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { PaneProcessExit, PtyConnectionDeps } from './pty-connection-types'
import { connectPanePty } from './pty-connection'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import type { ReplayingPanesRef } from './replay-guard'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '../../store'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

type UseTerminalPaneCodexRestartArgs = {
  tabId: string
  worktreeId: string
  cwd?: string
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  paneKittyKeyboardModesRef: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  paneLastThemeModeRef: React.RefObject<Map<number, TerminalColorSchemeMode>>
  replayingPanesRef: ReplayingPanesRef
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onAgentExitedRef: React.RefObject<(leafId: string) => void>
  onPtyErrorRef: React.RefObject<(paneId: number, message: string) => void>
  onPtyRecoveryStateRef: React.RefObject<
    (paneId: number, state: PtyTransportRecoveryState | null) => void
  >
  handlePaneProcessDied: (processExit: PaneProcessExit) => void
  clearPaneProcessExit: (paneId: number) => void
  executeClosePane: (paneId: number) => void
  suppressPtyExit: (ptyId: string) => void
  clearCodexRestartNotice: (ptyId: string) => void
  clearTabPtyId: PtyConnectionDeps['clearTabPtyId']
  updateTabTitle: PtyConnectionDeps['updateTabTitle']
  setRuntimePaneTitle: PtyConnectionDeps['setRuntimePaneTitle']
  clearRuntimePaneTitle: PtyConnectionDeps['clearRuntimePaneTitle']
  updateTabPtyId: PtyConnectionDeps['updateTabPtyId']
  markWorktreeUnread: PtyConnectionDeps['markWorktreeUnread']
  markTerminalTabUnread: PtyConnectionDeps['markTerminalTabUnread']
  markTerminalPaneUnread: PtyConnectionDeps['markTerminalPaneUnread']
  clearWorktreeUnread: PtyConnectionDeps['clearWorktreeUnread']
  clearTerminalTabUnread: PtyConnectionDeps['clearTerminalTabUnread']
  clearTerminalPaneUnread: PtyConnectionDeps['clearTerminalPaneUnread']
  showRestoredSessionBanner: PtyConnectionDeps['onShowSessionRestoredBanner']
  dispatchNotification: PtyConnectionDeps['dispatchNotification']
  setCacheTimerStartedAt: PtyConnectionDeps['setCacheTimerStartedAt']
  syncPanePtyLayoutBinding: PtyConnectionDeps['syncPanePtyLayoutBinding']
  clearExitedPanePtyLayoutBinding: PtyConnectionDeps['clearExitedPanePtyLayoutBinding']
  setTerminalError: (value: string | null) => void
  pendingCodexPaneRestartIds: Record<string, boolean>
  consumePendingCodexPaneRestart: (ptyId: string) => boolean
  savedLayout: TerminalLayoutSnapshot
}

export function useTerminalPaneCodexRestart(args: UseTerminalPaneCodexRestartArgs) {
  const {
    tabId,
    worktreeId,
    cwd,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneMode2031Ref,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    replayingPanesRef,
    isActiveRef,
    isVisibleRef,
    onPtyExitRef,
    onAgentExitedRef,
    onPtyErrorRef,
    onPtyRecoveryStateRef,
    handlePaneProcessDied,
    clearPaneProcessExit,
    executeClosePane,
    suppressPtyExit,
    clearCodexRestartNotice,
    clearTabPtyId,
    updateTabTitle,
    setRuntimePaneTitle,
    clearRuntimePaneTitle,
    updateTabPtyId,
    markWorktreeUnread,
    markTerminalTabUnread,
    markTerminalPaneUnread,
    clearWorktreeUnread,
    clearTerminalTabUnread,
    clearTerminalPaneUnread,
    showRestoredSessionBanner,
    dispatchNotification,
    setCacheTimerStartedAt,
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding,
    setTerminalError,
    pendingCodexPaneRestartIds,
    consumePendingCodexPaneRestart,
    savedLayout
  } = args

  const handleRestartCodexPane = useCallback(
    (
      paneId: number,
      restartStartup: PtyConnectionDeps['startup'] = CODEX_ACCOUNT_RESTART_STARTUP
    ) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }

      const transport = paneTransportsRef.current.get(paneId)
      const panePtyBinding = panePtyBindingsRef.current.get(paneId)
      const existingPtyId = transport?.getPtyId()

      if (existingPtyId) {
        suppressPtyExit(existingPtyId)
        clearCodexRestartNotice(existingPtyId)
        // Why: keep the pane mounted (clear binding, consume the suppressed exit) so a fresh PTY reconnects in place under the newly selected Codex account.
        clearTabPtyId(tabId, existingPtyId)
      }

      panePtyBinding?.dispose()
      panePtyBindingsRef.current.delete(paneId)
      syncPanePtyLayoutBinding(paneId, null)
      transport?.destroy?.()
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)

      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: restartStartup,
        mountFollowsTerminalPark: false,
        paneTransportsRef,
        paneMode2031Ref,
        paneKittyKeyboardModesRef,
        paneLastThemeModeRef,
        replayingPanesRef,
        isActiveRef,
        isVisibleRef,
        onPtyExitRef,
        onAgentExitedRef,
        onPtyErrorRef,
        onPaneProcessDied: handlePaneProcessDied,
        onPtyRecoveryStateRef,
        clearTabPtyId,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        isPtyShutdownPending: useAppStore.getState().isPtyShutdownPending,
        updateTabTitle,
        setRuntimePaneTitle,
        clearRuntimePaneTitle,
        updateTabPtyId,
        markWorktreeUnread,
        markTerminalTabUnread,
        markTerminalPaneUnread,
        clearWorktreeUnread,
        clearTerminalTabUnread,
        clearTerminalPaneUnread,
        onShowSessionRestoredBanner: showRestoredSessionBanner,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      manager.setActivePane(paneId, { focus: true })
    },
    [
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearRuntimePaneTitle,
      clearTabPtyId,
      cwd,
      dispatchNotification,
      handlePaneProcessDied,
      markWorktreeUnread,
      markTerminalTabUnread,
      markTerminalPaneUnread,
      clearWorktreeUnread,
      clearTerminalTabUnread,
      clearTerminalPaneUnread,
      showRestoredSessionBanner,
      onAgentExitedRef,
      onPtyExitRef,
      setCacheTimerStartedAt,
      setRuntimePaneTitle,
      suppressPtyExit,
      syncPanePtyLayoutBinding,
      tabId,
      updateTabPtyId,
      updateTabTitle,
      worktreeId
    ]
  )

  const handleRestartExitedPane = useCallback(
    (processExit: PaneProcessExit) => {
      clearPaneProcessExit(processExit.paneId)
      handleRestartCodexPane(
        processExit.paneId,
        resolveTerminalProcessExitRestartStartup(processExit)
      )
    },
    [clearPaneProcessExit, handleRestartCodexPane]
  )

  const handleCloseExitedPane = useCallback(
    (paneId: number) => {
      clearPaneProcessExit(paneId)
      executeClosePane(paneId)
    },
    [clearPaneProcessExit, executeClosePane]
  )

  // Why leaf bindings are a dep: a parked or deferred tab mounts with no
  // transport, so a queued restart has no ptyId to match on the mount pass. The
  // reconnected PTY rewrites this map when it binds — `ptyIdsByTabId` does not,
  // because a restored id is already listed there before the pane ever mounts.
  // Panes with no mounted TerminalPane at all are executed by the detached
  // driver instead (codex-detached-pane-restart), which leaves anything a live
  // transport owns to this effect.
  const panePtyLayoutBindings = savedLayout.ptyIdsByLeafId
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }

    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !pendingCodexPaneRestartIds[ptyId]) {
        continue
      }
      // Why: the status-bar switcher requests a global Codex restart, but execution stays pane-scoped so a split tab doesn't lose unrelated non-Codex panes.
      if (consumePendingCodexPaneRestart(ptyId)) {
        handleRestartCodexPane(pane.id)
      }
    }
  }, [
    consumePendingCodexPaneRestart,
    handleRestartCodexPane,
    panePtyLayoutBindings,
    pendingCodexPaneRestartIds
  ])

  return { handleRestartExitedPane, handleCloseExitedPane }
}
