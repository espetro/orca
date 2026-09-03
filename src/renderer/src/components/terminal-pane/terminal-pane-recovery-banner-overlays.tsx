import { createPortal } from 'react-dom'
import { TerminalRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { VisiblePtyRecoveryState } from './terminal-remote-runtime-recovery-ui-state'

type TerminalPaneRecoveryBannerOverlaysProps = {
  panes: ManagedPane[]
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  ptyRecoveryStatesByPaneId: Record<number, VisiblePtyRecoveryState>
}

/** Portals one remote runtime reconnect banner per pane with an active recovery state. */
export function TerminalPaneRecoveryBannerOverlays({
  panes,
  paneTransportsRef,
  ptyRecoveryStatesByPaneId
}: TerminalPaneRecoveryBannerOverlaysProps): (React.JSX.Element | null)[] {
  return panes.map((pane) => {
    const recoveryState = ptyRecoveryStatesByPaneId[pane.id]
    if (!recoveryState) {
      return null
    }
    return createPortal(
      <TerminalRemoteRuntimeReconnectBanner
        key={`remote-runtime-reconnect-${pane.id}-${recoveryState.epoch}`}
        phase={recoveryState.phase}
        onReconnect={() => {
          paneTransportsRef.current.get(pane.id)?.retryRecovery?.()
        }}
      />,
      pane.container,
      `remote-runtime-reconnect-${pane.id}`
    )
  })
}
