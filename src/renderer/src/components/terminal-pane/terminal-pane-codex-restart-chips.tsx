import { createPortal } from 'react-dom'
import CodexRestartChip from '../CodexRestartChip'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

type TerminalPaneCodexRestartChipsProps = {
  panes: ManagedPane[]
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  savedLayoutPtyIdsByLeafId: Record<string, string> | undefined
  isActive: boolean
  isVisible: boolean
  activePaneId: number | null | undefined
}

/** Portals one Codex restart chip per pane, mounted into the pane container. */
export function TerminalPaneCodexRestartChips({
  panes,
  paneTransportsRef,
  savedLayoutPtyIdsByLeafId,
  isActive,
  isVisible,
  activePaneId
}: TerminalPaneCodexRestartChipsProps): (React.JSX.Element | null)[] {
  return panes.map((pane) => {
    const ptyId =
      paneTransportsRef.current.get(pane.id)?.getPtyId() ??
      savedLayoutPtyIdsByLeafId?.[pane.leafId]
    if (!ptyId) {
      return null
    }
    return createPortal(
      <CodexRestartChip
        key={`codex-restart-${pane.id}-${ptyId}`}
        isVisible={isVisible}
        ptyId={ptyId}
        shouldFocus={isActive && isVisible && activePaneId === pane.id}
      />,
      pane.container,
      `codex-restart-${pane.id}`
    )
  })
}
