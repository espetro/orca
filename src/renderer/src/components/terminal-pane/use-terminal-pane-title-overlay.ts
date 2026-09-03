import { useCallback, useLayoutEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  arePaneTitleOverlayRectsEqual,
  clearPaneTitleOverlayRects
} from './pane-title-overlay-rects'
import type { PaneTitleOverlayRect } from './TerminalPaneHeaderOverlay'

export function useTerminalPaneTitleOverlay(args: {
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedPaneId: number | null
  isolatedPaneKey: string | null | undefined
  isVisible: boolean | undefined
  paneCount: number
  paneLayoutRevision: number
  paneTitles: Record<number, string>
  renamingPaneId: number | null
  sessionRestoredBannerPaneIds: Set<number>
  setPaneTitleOverlayRects: (rects: Record<number, PaneTitleOverlayRect> | null) => void
}): void {
  const {
    managerRef,
    containerRef,
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    setPaneTitleOverlayRects
  } = args

  const syncPaneTitleOverlayRects = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
      return
    }
    const containerRect = container.getBoundingClientRect()
    const nextRects: Record<number, PaneTitleOverlayRect> = {}
    for (const pane of manager.getPanes()) {
      const paneRect = pane.container.getBoundingClientRect()
      if (paneRect.width <= 0 || paneRect.height <= 0) {
        continue
      }
      nextRects[pane.id] = {
        left: paneRect.left - containerRect.left,
        top: paneRect.top - containerRect.top,
        width: paneRect.width
      }
    }
    setPaneTitleOverlayRects((prev) =>
      arePaneTitleOverlayRectsEqual(prev, nextRects) ? prev : nextRects
    )
  }, [managerRef, containerRef, setPaneTitleOverlayRects])

  useLayoutEffect(() => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
      return
    }

    let frame: number | null = null
    const scheduleSync = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = null
        syncPaneTitleOverlayRects()
      })
    }

    // Why: the title UI is React-owned (outside the xterm DOM), so track pane geometry to keep it attached without xterm/Radix focus fights.
    syncPaneTitleOverlayRects()
    const resizeObserver = new ResizeObserver(scheduleSync)
    resizeObserver.observe(container)
    for (const pane of manager.getPanes()) {
      resizeObserver.observe(pane.container)
    }
    return () => {
      resizeObserver.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    syncPaneTitleOverlayRects
  ])
}
