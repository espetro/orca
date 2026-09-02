import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { replayIntoTerminal, type ReplayingPanesRef } from './replay-guard'
import type { RestoredViewportBlankingPanesRef } from './terminal-restored-viewport'
import { isXtermInstanceDisposed } from '@/lib/pane-manager/xterm-instance-disposed'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  POST_REPLAY_MODE_RESET,
  RESET_GRAPHIC_RENDITION
} from '../../../../shared/terminal-mode-reset-profiles'

/**
 * Write saved scrollback buffers into restored panes so the user sees prior
 * output after a restart. Exits alt-screen first if a buffer ended mid-TUI.
 */
export function restoreScrollbackBuffers(
  manager: PaneManager,
  savedBuffers: Record<string, string> | undefined,
  restoredPaneByLeafId: Map<string, number>,
  replayingPanesRef: ReplayingPanesRef,
  restoredViewportBlankingPanesRef?: RestoredViewportBlankingPanesRef
): void {
  if (!savedBuffers) {
    return
  }
  const ALT_SCREEN_ON = '\x1b[?1049h'
  const ALT_SCREEN_OFF = '\x1b[?1049l'
  for (const [oldLeafId, buffer] of Object.entries(savedBuffers)) {
    const newPaneId = restoredPaneByLeafId.get(oldLeafId)
    if (newPaneId == null || !buffer) {
      continue
    }
    const pane = manager.getPanes().find((p) => p.id === newPaneId)
    if (!pane) {
      continue
    }
    // Breadcrumb: writes into a disposed xterm are silent (no throw), the suspected source of startup zombie panes.
    if (isXtermInstanceDisposed(pane.terminal)) {
      recordRendererCrashBreadcrumb('terminal_restore_write_target_disposed', {
        paneId: pane.id
      })
      continue
    }
    try {
      const renderOptions = {
        shouldRefreshViewportSynchronously: () => !manager.hasWebglRenderer(pane.id)
      }
      let buf = buffer
      // If the buffer ends in alt-screen (agent TUI at shutdown), exit it so the terminal is usable.
      const lastOn = buf.lastIndexOf(ALT_SCREEN_ON)
      const lastOff = buf.lastIndexOf(ALT_SCREEN_OFF)
      if (lastOn > lastOff) {
        buf = buf.slice(0, lastOn)
      }
      if (buf.length > 0) {
        // replayIntoTerminal: buffer queries (DA1/DECRQM/CPR) would auto-reply into the new shell's stdin. See replay-guard.ts.
        replayIntoTerminal(
          pane,
          replayingPanesRef,
          `${RESET_GRAPHIC_RENDITION}${buf}${RESET_GRAPHIC_RENDITION}\r\n`,
          renderOptions
        )
        // The grounded newline avoids both the prompt marker and background-color erase from the captured pen.
        // Clear mode bits the buffer replayed: the fresh shell has no TUI to consume them. See POST_REPLAY_MODE_RESET.
        replayIntoTerminal(pane, replayingPanesRef, POST_REPLAY_MODE_RESET, renderOptions)
        // Why: connection resolution runs after layout replay; only fresh-shell paths move these rows into scrollback.
        restoredViewportBlankingPanesRef?.current.add(pane.id)
      }
    } catch (error: unknown) {
      // Breadcrumb: this catch was silent while zombie panes went undiagnosed.
      recordRendererCrashBreadcrumb('terminal_restore_write_failed', {
        paneId: pane.id,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
