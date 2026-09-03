import { useCallback } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'

type MenuContextState = {
  menuPaneId: number | null
}

type UseTerminalPaneMenuContextDeps = {
  contextMenu: MenuContextState
  managerRef: React.MutableRefObject<PaneManager | null>
  paneTransportsRef: React.MutableRefObject<Map<number, any>>
  paneCwdRef: React.MutableRefObject<Map<number, { cwd: string; confirmed: boolean }>>
  cwd?: string
}

type UseTerminalPaneMenuContextResult = {
  getContextMenuLeafId: () => string | null
  activatePaneTitleInteraction: (paneId: number) => void
  splitTerminalPaneFromHeader: (pane: ManagedPane, direction: 'vertical' | 'horizontal') => void
  beginPaneDragFromHeader: (paneId: number, handle: HTMLElement, event: PointerEvent) => void
}

export function useTerminalPaneMenuContext({
  contextMenu,
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  cwd
}: UseTerminalPaneMenuContextDeps): UseTerminalPaneMenuContextResult {
  const getContextMenuLeafId = useCallback((): string | null => {
    const paneId = contextMenu.menuPaneId
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    if (paneId !== null) {
      return manager.getPanes().find((pane) => pane.id === paneId)?.leafId ?? null
    }
    return manager.getActivePane()?.leafId ?? null
  }, [contextMenu.menuPaneId, managerRef])

  const activatePaneTitleInteraction = useCallback((paneId: number): void => {
    managerRef.current?.setActivePane(paneId, { focus: false })
  }, [managerRef])

  const splitTerminalPaneFromHeader = useCallback(
    (pane: ManagedPane, direction: 'vertical' | 'horizontal') => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      splitTerminalPaneWithInheritedCwd({
        manager,
        getManager: () => managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneCwdMap: paneCwdRef.current,
        fallbackCwd: cwd ?? '',
        pane,
        direction,
        source: 'context_menu'
      })
    },
    [cwd, managerRef, paneTransportsRef, paneCwdRef]
  )

  const beginPaneDragFromHeader = useCallback(
    (paneId: number, handle: HTMLElement, event: PointerEvent) => {
      managerRef.current?.beginPaneDragFromPointerDown(paneId, handle, event)
    },
    [managerRef]
  )

  return {
    getContextMenuLeafId,
    activatePaneTitleInteraction,
    splitTerminalPaneFromHeader,
    beginPaneDragFromHeader
  }
}
