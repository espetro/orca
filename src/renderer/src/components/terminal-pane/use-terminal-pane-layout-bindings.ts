import { useCallback } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '../../store'
import { EMPTY_LAYOUT, resolveTerminalLayoutActiveLeafId } from './layout-serialization'

export type LayoutBindingsHandlers = {
  writePanePtyLayoutBinding: (paneId: number, ptyId: string | null, repairActiveLeafOnClear: boolean) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  clearExitedPanePtyLayoutBinding: (paneId: number, exitedPtyId: string) => void
}

export function useTerminalPaneLayoutBindings(args: {
  tabId: string
  managerRef: React.RefObject<PaneManager | null>
}): LayoutBindingsHandlers {
  const { tabId, managerRef } = args
  const setTabLayout = useAppStore((store) => store.setTabLayout)

  const writePanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null, repairActiveLeafOnClear: boolean): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId) {
        return
      }

      if (ptyId) {
        setTabLayout(tabId, {
          ...layoutWithoutPtyBindings,
          // Why: PTY ownership changes after the mount-time layout snapshot, so persist the live pane→PTY binding here for correct remount attachment.
          ptyIdsByLeafId: {
            ...existingBindings,
            [leafId]: ptyId
          }
        })
        return
      }

      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      const nextLayout = {
        ...layoutWithoutPtyBindings,
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      }
      if (
        repairActiveLeafOnClear &&
        existingLayout.activeLeafId === leafId &&
        Object.keys(nextBindings).length > 0
      ) {
        // Why: repair focus off an active pane that lost its PTY (it would swallow input); restart bookkeeping opts out to keep the pane getting a fresh PTY.
        nextLayout.activeLeafId = resolveTerminalLayoutActiveLeafId({
          root: nextLayout.root,
          activeLeafId: nextLayout.activeLeafId,
          ptyIdsByLeafId: nextBindings
        })
      }
      setTabLayout(tabId, nextLayout)
    },
    [setTabLayout, tabId]
  )

  const syncPanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null): void => {
      writePanePtyLayoutBinding(paneId, ptyId, false)
    },
    [writePanePtyLayoutBinding]
  )

  const clearExitedPanePtyLayoutBinding = useCallback(
    (paneId: number, exitedPtyId: string): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId || existingBindings[leafId] !== exitedPtyId) {
        return
      }

      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      // Why: a focused pane that lost its PTY swallows input while a live sibling exists, so repair focus to a bound leaf on unexpected exit.
      setTabLayout(tabId, {
        ...layoutWithoutPtyBindings,
        activeLeafId: resolveTerminalLayoutActiveLeafId({
          root: existingLayout.root,
          activeLeafId: existingLayout.activeLeafId,
          ptyIdsByLeafId: nextBindings
        }),
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      })
    },
    [setTabLayout, tabId]
  )

  return {
    writePanePtyLayoutBinding,
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding
  }
}
