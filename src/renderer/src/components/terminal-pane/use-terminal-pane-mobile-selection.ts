import { useCallback } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getMobileFitOverridePtyIds, getAllDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'
import {
  armPrimarySelectionNativePasteSuppression,
  isPrimarySelectionEnabled,
  readPrimarySelectionText
} from '@/lib/primary-selection'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '../../store'
import { planTerminalPasteWithYield, executeTerminalPastePlan } from './terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneMobileSelectionDeps = {
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  managerRef: React.MutableRefObject<PaneManager | null>
  settingsRef: React.MutableRefObject<unknown>
  tabId: string
  worktreeId: string
  forceBracketedMultilineTextPaste: boolean
  refreshMobileOverlays: () => void
  setTerminalError: (error: string) => void
}

export function useTerminalPaneMobileSelection(deps: UseTerminalPaneMobileSelectionDeps) {
  const {
    paneTransportsRef,
    managerRef,
    settingsRef,
    tabId,
    worktreeId,
    forceBracketedMultilineTextPaste,
    refreshMobileOverlays,
    setTerminalError
  } = deps

  const getMobileOwnedTerminalPtyIds = useCallback((): string[] => {
    const ptyIds = new Set(getMobileFitOverridePtyIds())
    for (const [ptyId, driver] of getAllDrivers()) {
      if (driver.kind === 'mobile') {
        ptyIds.add(ptyId)
      }
    }
    return [...ptyIds]
  }, [])

  const scheduleRestoredTerminalRefit = useCallback((): void => {
    // Why: desktop-fit events can clear runtime state before xterm repaints, so schedule a settled-frame refit that doesn't depend on focus.
    requestAnimationFrame(refitAndRefreshAllTerminalPanes)
    window.setTimeout(refitAndRefreshAllTerminalPanes, 100)
  }, [])

  const restorePaneTerminalFit = useCallback(
    async (pane: ManagedPane, ptyId: string): Promise<void> => {
      // Why: local and remote runtime PTYs use different transports but share one reclaim behavior.
      // Why: the banner was rendered for this PTY; if the slot now holds a different terminal, bail so a stale portal can't reclaim it.
      const currentPtyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      if (currentPtyId !== ptyId) {
        refreshMobileOverlays()
        return
      }
      const restored = await restoreTerminalFitToDesktop(ptyId, settingsRef.current ?? undefined)
      if (restored) {
        scheduleRestoredTerminalRefit()
        // Why: after the overlay unmounts, refocus the reclaimed terminal instead of the removed button/body.
        pane.terminal.focus()
      }
    },
    [refreshMobileOverlays, scheduleRestoredTerminalRefit, paneTransportsRef, settingsRef]
  )

  const restoreAllTerminalFits = useCallback(
    async (focusPane: ManagedPane): Promise<void> => {
      // Why: bulk restore follows the same reclaim path as the per-pane button for PTYs held at phone size.
      const restored = await restoreTerminalFitsToDesktop(
        getMobileOwnedTerminalPtyIds(),
        settingsRef.current ?? undefined
      )
      if (restored) {
        scheduleRestoredTerminalRefit()
        focusPane.terminal.focus()
      }
    },
    [getMobileOwnedTerminalPtyIds, scheduleRestoredTerminalRefit, settingsRef]
  )

  const terminalShouldHandleMiddleClick = useCallback(
    (target: EventTarget | null): target is Node => {
      if (!(target instanceof Element)) {
        return false
      }
      if (target.closest('[data-terminal-search-root]')) {
        return false
      }
      const editable = target.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"]'
      )
      return !editable || editable.classList.contains('xterm-helper-textarea')
    },
    []
  )

  const getPrimarySelectionMiddleClickPane = useCallback(
    (target: EventTarget | null) => {
      if (!terminalShouldHandleMiddleClick(target)) {
        return null
      }
      const manager = managerRef.current
      if (!manager) {
        return null
      }
      const clickedPane =
        manager.getPanes().find((pane) => pane.container.contains(target)) ??
        manager.getActivePane() ??
        manager.getPanes()[0]
      if (!clickedPane || clickedPane.terminal.modes.mouseTrackingMode !== 'none') {
        return null
      }
      return clickedPane
    },
    [terminalShouldHandleMiddleClick, managerRef]
  )

  const handlePrimarySelectionMiddleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 1 || !isPrimarySelectionEnabled()) {
        return
      }
      const clickedPane = getPrimarySelectionMiddleClickPane(event.target)
      if (!clickedPane) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      // Why: preventDefault on mousedown does not stop Chromium's native
      // middle-click paste follow-up, so arm the shared window to swallow it and
      // avoid inserting text into the PTY twice.
      armPrimarySelectionNativePasteSuppression()
      clickedPane.terminal.focus()
      void readPrimarySelectionText().then(async (text) => {
        if (!text) {
          return
        }
        const transport = paneTransportsRef.current.get(clickedPane.id)
        const ptyId = transport?.getPtyId() ?? null
        const isMac = navigator.userAgent.includes('Mac')
        const shortcutPlatform: NodeJS.Platform = isMac
          ? 'darwin'
          : navigator.userAgent.includes('Windows')
            ? 'win32'
            : 'linux'
        const connectionId = getConnectionId(worktreeId) ?? null
        const pasteState = useAppStore.getState()
        const targetStillMounted = (): boolean => {
          const manager = managerRef.current
          return Boolean(
            manager
              ?.getPanes()
              .some(
                (livePane) =>
                  livePane.id === clickedPane.id && livePane.leafId === clickedPane.leafId
              ) &&
            transport &&
            paneTransportsRef.current.get(clickedPane.id) === transport &&
            transport.isConnected() &&
            transport.getPtyId() === ptyId
          )
        }
        const plan = await planTerminalPasteWithYield({
          text,
          source: 'middle-click',
          target: {
            kind: 'terminal',
            paneId: clickedPane.id,
            leafId: clickedPane.leafId,
            ptyId,
            runtime: resolveTerminalPasteRuntime({
              platform: shortcutPlatform,
              ptyId,
              connectionId,
              remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
              transport
            })
          },
          ...resolveProtectedMultilinePasteOptionsForPane({
            isWindowsClient: forceBracketedMultilineTextPaste,
            hostPlatform: resolveTerminalInputHostPlatform({
              clientPlatform: shortcutPlatform,
              state: pasteState,
              worktreeId,
              transport: transport ?? null
            }),
            agentStatusByPaneKey: pasteState.agentStatusByPaneKey,
            paneForegroundAgentByPaneKey: pasteState.paneForegroundAgentByPaneKey,
            tabId,
            leafId: clickedPane.leafId
          }),
          terminalBracketedPasteMode: clickedPane.terminal.modes.bracketedPasteMode
        })
        const execution = await executeTerminalPastePlan(plan, {
          pasteText: (pasteText, pasteOptions) =>
            pasteTerminalText(clickedPane.terminal, pasteText, pasteOptions),
          writePty: (data) => writeTerminalPastePtyInput(transport, data),
          isTargetCurrent: targetStillMounted,
          canContinue: targetStillMounted
        })
        if (execution.status !== 'pasted') {
          setTerminalError(formatTerminalPasteExecutionError(execution.reason))
          return
        }
        recordTerminalUserInputForLeaf(tabId, clickedPane.leafId)
      })
    },
    [
      getPrimarySelectionMiddleClickPane,
      forceBracketedMultilineTextPaste,
      tabId,
      worktreeId,
      paneTransportsRef,
      managerRef,
      setTerminalError
    ]
  )

  const handlePrimarySelectionAuxClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (
        event.button === 1 &&
        isPrimarySelectionEnabled() &&
        getPrimarySelectionMiddleClickPane(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
        // Why: auxclick fires at button release, when Chromium's native paste is
        // imminent; re-arm here so a slow release past the mousedown window still
        // swallows the follow-up paste.
        armPrimarySelectionNativePasteSuppression()
      }
    },
    [getPrimarySelectionMiddleClickPane]
  )

  return {
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits,
    terminalShouldHandleMiddleClick,
    getPrimarySelectionMiddleClickPane,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick
  }
}
