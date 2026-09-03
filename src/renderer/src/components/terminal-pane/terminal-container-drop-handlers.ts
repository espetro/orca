import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import {
  WORKSPACE_FILE_PATH_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

type TerminalContainerDropHandlersArgs = {
  managerRef: React.MutableRefObject<PaneManager | null>
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  worktreeId: string
  tabId: string
  cwd: string | undefined
}

// Why: workspace-file drags accept (copy effect); anything else falls through to the internal pane-drop router.
export function terminalContainerDragOverHandler(e: React.DragEvent<HTMLDivElement>): void {
  if (
    e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) ||
    e.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
  ) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
}

export function terminalContainerDropHandler({
  managerRef,
  paneTransportsRef,
  worktreeId,
  tabId,
  cwd
}: TerminalContainerDropHandlersArgs) {
  return (e: React.DragEvent<HTMLDivElement>): void => {
    if (
      !e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) &&
      !e.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
    ) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const manager = managerRef.current
    if (!manager) {
      return
    }
    void handleInternalTerminalFileDrop({
      manager,
      paneTransports: paneTransportsRef.current,
      worktreeId,
      tabId,
      cwd,
      dataTransfer: e.dataTransfer,
      dropTarget: e.target
    })
  }
}
