import { createPortal } from 'react-dom'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { TerminalProcessExitOverlay } from './TerminalProcessExitOverlay'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

import type { PaneProcessExit } from './pty-connection-types'

type PaneProcessExitOverlaysProps = {
  panes: ManagedPane[]
  paneProcessExitsByPaneId: Record<number, PaneProcessExit>
  onRestartExitedPane: (processExit: PaneProcessExit) => void
  onCloseExitedPane: (paneId: number) => void
}

/** Portals one process-exit overlay per exited pane, mounted into the pane container. */
export function PaneProcessExitOverlays({
  panes,
  paneProcessExitsByPaneId,
  onRestartExitedPane,
  onCloseExitedPane
}: PaneProcessExitOverlaysProps): React.JSX.Element[] {
  return panes.map((pane) => {
    const processExit = paneProcessExitsByPaneId[pane.id]
    return processExit
      ? createPortal(
          <TerminalProcessExitOverlay
            processExit={processExit}
            onRestart={() => onRestartExitedPane(processExit)}
            onClose={() => onCloseExitedPane(pane.id)}
          />,
          pane.container,
          `process-exit-${pane.id}`
        )
      : null
  })
}

type TerminalPaneSshReconnectOverlaysProps = {
  panes: ManagedPane[]
  targetId: string
  targetLabel: string | null | undefined
  status: SshConnectionStatus
  error: string | null | undefined
  targetRemoved: boolean | undefined
  worktreeId: string
  sshOwnerEnvironmentId: string | null
}

/** Portals the SSH reconnect overlay into every pane container. */
export function TerminalPaneSshReconnectOverlays({
  panes,
  targetId,
  targetLabel,
  status,
  error,
  targetRemoved,
  worktreeId,
  sshOwnerEnvironmentId
}: TerminalPaneSshReconnectOverlaysProps): React.JSX.Element[] {
  return panes.map((pane) =>
    createPortal(
      <TerminalSshReconnectOverlay
        targetId={targetId}
        targetLabel={targetLabel}
        status={status}
        error={error}
        targetRemoved={targetRemoved}
        worktreeId={worktreeId}
        sshOwnerEnvironmentId={sshOwnerEnvironmentId}
      />,
      pane.container,
      `ssh-reconnect-${pane.id}`
    )
  )
}
