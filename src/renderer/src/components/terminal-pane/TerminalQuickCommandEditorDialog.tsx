import React from 'react'
import {
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '../../store'

type TerminalQuickCommandEditorDialogProps = {
  command: TerminalQuickCommand
  hostId: ExecutionHostId
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

export function TerminalQuickCommandEditorDialog({
  command,
  hostId,
  onOpenChange,
  onSave
}: TerminalQuickCommandEditorDialogProps): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)
  const hostRepos = hostId.startsWith('runtime:')
    ? repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    : repos

  return (
    <TerminalQuickCommandDialog
      open
      mode="add"
      command={command}
      repos={hostRepos}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}
