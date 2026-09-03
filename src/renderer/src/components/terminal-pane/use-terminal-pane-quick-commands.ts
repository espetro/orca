import { useCallback, useEffect, useMemo } from 'react'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/terminal-quick-command-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  useProjectHostSetupProjection  ,
  useRepoById
} from '@/store/selectors'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../../shared/terminal-quick-commands'
import { terminalQuickCommandMatchesWorkspaceProject } from '@/lib/terminal-quick-command-project-scope'
import { createTerminalQuickCommandDraft } from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { useTerminalQuickCommandHosts } from '@/hooks/use-terminal-quick-command-hosts'
import { useAppStore } from '../../store'

type UseTerminalPaneQuickCommandsArgs = {
  worktreeId: string
  contextMenuOpen: boolean
  quickCommandEditorHostId: ExecutionHostId
  setQuickCommandEditorOpen: (open: boolean) => void
  setQuickCommandEditorHostId: (hostId: ExecutionHostId) => void
  setQuickCommandDraft: (draft: TerminalQuickCommand) => void
}

export function useTerminalPaneQuickCommands(args: UseTerminalPaneQuickCommandsArgs) {
  const {
    worktreeId,
    contextMenuOpen,
    quickCommandEditorHostId,
    setQuickCommandEditorOpen,
    setQuickCommandEditorHostId,
    setQuickCommandDraft
  } = args

  const quickCommandRepoId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const quickCommandRepo = useRepoById(quickCommandRepoId)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const quickCommandRepoLabel = quickCommandRepo
    ? quickCommandRepo.displayName || quickCommandRepo.path
    : quickCommandRepoId
      ? 'This Repo'
      : null
  const openQuickCommandEditor = useCallback(
    (scope: TerminalQuickCommandScope, hostId: ExecutionHostId): void => {
      setQuickCommandDraft(createTerminalQuickCommandDraft(scope))
      setQuickCommandEditorHostId(hostId)
      setQuickCommandEditorOpen(true)
    },
    [setQuickCommandDraft, setQuickCommandEditorHostId, setQuickCommandEditorOpen]
  )

  const saveQuickCommand = useCallback(
    (command: TerminalQuickCommand): void => {
      void useAppStore.getState().upsertTerminalQuickCommand(quickCommandEditorHostId, command)
    },
    [quickCommandEditorHostId]
  )

  const {
    executionHostId: quickCommandExecutionHostId,
    hosts: quickCommandHosts,
    refreshRemoteHost: refreshQuickCommandRemoteHost,
    remoteHostLoadFailed: quickCommandHostLoadFailed,
    remoteHostPending: quickCommandHostOwnershipPending
  } = useTerminalQuickCommandHosts(worktreeId, contextMenuOpen)
  const visibleQuickCommandHosts = useMemo(
    () =>
      quickCommandHosts.map((host) => {
        const commands = host.commands.filter(isTerminalQuickCommandComplete)
        return {
          globalCommands: commands.filter(
            (command) => getTerminalQuickCommandScope(command).type === 'global'
          ),
          hostId: host.hostId,
          label: host.label,
          repoCommands: commands.filter((command) => {
            const scope = getTerminalQuickCommandScope(command)
            return (
              scope.type === 'repo' &&
              terminalQuickCommandMatchesWorkspaceProject(command, {
                commandHostId: host.hostId,
                projectHostSetups: projectHostSetupProjection.setups,
                targetHostId: quickCommandExecutionHostId,
                targetRepoId: quickCommandRepoId
              })
            )
          })
        }
      }),
    [
      projectHostSetupProjection.setups,
      quickCommandExecutionHostId,
      quickCommandHosts,
      quickCommandRepoId
    ]
  )
  useEffect(() => {
    if (contextMenuOpen) {
      refreshQuickCommandRemoteHost()
    }
  }, [contextMenuOpen, refreshQuickCommandRemoteHost])

  return {
    quickCommandRepoId,
    quickCommandRepoLabel,
    openQuickCommandEditor,
    saveQuickCommand,
    visibleQuickCommandHosts,
    quickCommandHostLoadFailed,
    quickCommandHostOwnershipPending
  }
}
