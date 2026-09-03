import { useEffect, useLayoutEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  restoreExpandedLayoutFrom
} from './expand-collapse'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions
} from './terminal-live-layout-reconciliation'
import type { EMPTY_LAYOUT } from './layout-serialization'

type UseTerminalPaneRemoteLayoutSyncArgs = {
  managerRef: React.RefObject<PaneManager | null>
  renameContainerRef: React.RefObject<HTMLDivElement | null>
  activityIsolationSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  pendingPaneSizeRefreshFrameIdsRef: React.MutableRefObject<number[]>
  tabId: string
  isActive: boolean
  paneCount: number
  isolatedPaneKey: string | null
  restoredLayout: ReturnType<typeof EMPTY_LAYOUT>
  persistLayoutSnapshot: () => void
}

export function useTerminalPaneRemoteLayoutSync({
  managerRef,
  renameContainerRef,
  activityIsolationSnapshotRef,
  pendingPaneSizeRefreshFrameIdsRef,
  tabId,
  isActive,
  paneCount,
  isolatedPaneKey,
  restoredLayout,
  persistLayoutSnapshot
}: UseTerminalPaneRemoteLayoutSyncArgs): void {
  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !restoredLayout.root) {
      return
    }
    // Why: host-owned split layouts (web / remote-server) arrive via snapshot, so the reconciler materializes their panes; local tabs split directly.
    if (
      !isHostAuthoritativeLayout({
        isWebClient: !!(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__,
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ) {
      return
    }
    const insertions = planTerminalLiveLayoutInsertions(
      restoredLayout.root,
      manager.getPanes().map((pane) => pane.leafId)
    )
    if (insertions.length === 0) {
      return
    }

    let appliedInsertion = false
    for (const insertion of insertions) {
      const ptyId = restoredLayout.ptyIdsByLeafId?.[insertion.newLeafId]
      const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
      if (!ptyId || sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId)) {
        continue
      }
      // Why: host split-pane snapshots for paired web terminals arrive after mount, so adopt the host leaf + PTY instead of spawning a local-only web pane.
      // Before-placement swaps [source, new] after splitPane, so invert the host first-child ratio for the temporary order.
      const splitRatio =
        insertion.ratio === undefined
          ? undefined
          : insertion.placement === 'before'
            ? 1 - insertion.ratio
            : insertion.ratio
      const createdPane = manager.splitPaneAroundLeafIds(
        insertion.sourceLeafIds,
        sourcePaneId,
        insertion.direction,
        {
          ...(splitRatio !== undefined && { ratio: splitRatio }),
          leafId: insertion.newLeafId,
          ptyId,
          placement: insertion.placement
        }
      )
      if (!createdPane) {
        continue
      }
      appliedInsertion = true
    }

    if (appliedInsertion) {
      persistLayoutSnapshot()
    }

    const activePaneId = restoredLayout.activeLeafId
      ? manager.getNumericIdForLeaf(restoredLayout.activeLeafId)
      : null
    const fallbackActivePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const nextActivePaneId = activePaneId ?? fallbackActivePaneId
    if (nextActivePaneId !== null) {
      manager.setActivePane(nextActivePaneId, { focus: isActive })
    }
  }, [isActive, paneCount, persistLayoutSnapshot, restoredLayout])

  // Activity-only isolation: when portaled into Activity for one agent pane, hide split siblings via a separate snapshot ref (independent of expand state).
  // useLayoutEffect so style writes land before paint (no flash); paneCount in deps re-applies after splits/closes.
  useLayoutEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    // Why: refit on rAF so xterm measures the post-layout DOM; both apply and restore paths must refit or xterm stays sized for the isolated single-pane geometry.
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          renameContainerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = renameContainerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        // Why: Activity requested an exact pane; if it can't be resolved, fail closed rather than show the whole split terminal.
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const frame = scheduleRefit()
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [isolatedPaneKey, paneCount, tabId])

  // Why: on unmount while isolation is active (e.g. tab closed mid-Activity), restore sibling display/flex so the captured DOM doesn't leak inline styles.
  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
  }, [])
}
