import { useCallback, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '../../store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { CloseTerminalDialogCopyKind } from './CloseTerminalDialog'
import { resolveLeafCloseCopyKind } from '../terminal/terminal-close-copy-kind'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from '../terminal/running-terminal-close-guard'
import { closeWebRuntimeTerminal, inspectRuntimeTerminalProcess } from '@/lib/runtime-inspector'
import type { PtyTransport } from './pty-transport'

export type CloseFlowState = {
  pendingCloseConfirmation: { paneId: number; copyKind: CloseTerminalDialogCopyKind } | null
  setPendingCloseConfirmation: (confirmation: { paneId: number; copyKind: CloseTerminalDialogCopyKind } | null) => void
  handleConfirmClose: (dontAskAgain: boolean) => void
  handleCancelClose: () => void
  handleRequestClosePane: (paneId: number) => void
  closeActivePane: () => void
  executeClosePane: (paneId: number) => void
}

export function useCloseFlowState(args: {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  onCloseTab: () => void
  tabId: string
  updateSettings: (settings: Partial<unknown>) => Promise<void>
  clearSessionRestoredBannerForPane: (paneId: number) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
}): CloseFlowState {
  const [pendingCloseConfirmation, setPendingCloseConfirmation] = useState<{
    paneId: number
    copyKind: CloseTerminalDialogCopyKind
  } | null>(null)

  const executeClosePane = useCallback(
    (paneId: number) => {
      const manager = args.managerRef.current
      if (!manager) {
        return
      }
      if (manager.getPanes().length <= 1) {
        args.onCloseTab()
      } else {
        const ptyId = args.paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
        closeWebRuntimeTerminal(ptyId)
        args.clearSessionRestoredBannerForPane(paneId)
        const leafId = manager.getLeafId(paneId)
        if (leafId) {
          useAppStore.getState().setCacheTimerStartedAt(makePaneKey(args.tabId, leafId), null)
          useAppStore.getState().dropAgentStatus(makePaneKey(args.tabId, leafId))
        }
        args.syncPanePtyLayoutBinding(paneId, null)
        manager.closePane(paneId)
      }
    },
    [args.clearSessionRestoredBannerForPane, args.onCloseTab, args.syncPanePtyLayoutBinding, args.tabId, args.managerRef, args.paneTransportsRef]
  )

  const getCloseDialogCopyKind = useCallback(
    (paneId: number): CloseTerminalDialogCopyKind =>
      resolveLeafCloseCopyKind(args.tabId, args.managerRef.current?.getLeafId(paneId)),
    [args.tabId, args.managerRef]
  )

  const handleRequestClosePane = useCallback(
    (paneId: number) => {
      if ((args.managerRef.current?.getPanes().length ?? 0) <= 1) {
        executeClosePane(paneId)
        return
      }
      const transport = args.paneTransportsRef.current.get(paneId)
      const ptyId = transport?.getPtyId()
      if (!ptyId) {
        executeClosePane(paneId)
        return
      }
      const settings = useAppStore.getState().settings
      let decided = false
      const decide = (act: () => void): void => {
        if (decided) {
        return
      }
        decided = true
        act()
      }
      const confirmClose = (): void =>
        setPendingCloseConfirmation({ paneId, copyKind: getCloseDialogCopyKind(paneId) })
      const probeTimeout = setTimeout(() => decide(confirmClose), RUNNING_CLOSE_PROBE_TIMEOUT_MS)
      void inspectRuntimeTerminalProcess(settings, ptyId)
        .then((process) => {
          clearTimeout(probeTimeout)
          decide(() => {
            if (!process.hasChildProcesses || settings?.skipCloseTerminalWithRunningProcessConfirm) {
              executeClosePane(paneId)
            } else {
              confirmClose()
            }
          })
        })
        .catch(() => {
          clearTimeout(probeTimeout)
          decide(() => executeClosePane(paneId))
        })
    },
    [executeClosePane, getCloseDialogCopyKind, args.managerRef, args.paneTransportsRef]
  )

  const handleConfirmClose = useCallback(
    (dontAskAgain: boolean) => {
      if (pendingCloseConfirmation === null) {
      return
    }
      const paneId = pendingCloseConfirmation.paneId
      setPendingCloseConfirmation(null)
      if (dontAskAgain) {
        void args.updateSettings({ skipCloseTerminalWithRunningProcessConfirm: true })
      }
      executeClosePane(paneId)
    },
    [executeClosePane, pendingCloseConfirmation, args.updateSettings]
  )

  const handleCancelClose = useCallback(() => {
    setPendingCloseConfirmation(null)
  }, [])

  const closeActivePane = useCallback(() => {
    const manager = args.managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    if (pane) {
      handleRequestClosePane(pane.id)
    }
  }, [handleRequestClosePane, args.managerRef])

  return {
    executeClosePane,
    pendingCloseConfirmation,
    setPendingCloseConfirmation,
    handleConfirmClose,
    handleCancelClose,
    handleRequestClosePane,
    closeActivePane
  }
}
