import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingContext
} from '../../../shared/keybindings'
import { matchesRecentTabSwitcherChord } from '../../../shared/window-shortcut-policy'
import type { TuiAgent } from '../../../shared/tui-agent'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  isFloatingWorkspacePanelFocused,
  isEventTargetInsideFloatingWorkspacePanel,
  handleEmptyFloatingWorkspacePanelCloseShortcut,
  createFloatingWorkspaceTerminalTab,
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import { getConnectionId } from '../../lib/connection-context'
import { listBoundAgentTabActions, resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { translate } from '@/i18n/i18n'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from '../editor/editor-autosave'
import { getEditorCmdSaveFileId } from '../editor/editor-cmd-save-target'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '../../hooks/ipc-tab-switch'
import type { KeybindingOverrides, TerminalShortcutPolicy } from '../../../shared/keybindings'
import { useAppStore } from '../../store'
import { getKeybindingContext, showClientCreationActionError } from './client-creation-error'

export type TerminalShortcutHandlers = {
  handleNewTab: (shellOverride?: string) => void
  handleNewAgentTab: (agent: TuiAgent) => void
  handleNewSimulatorTab: () => void
  handleNewBrowserTab: () => void
  handleNewFile: () => void
  handleCloseFile: (fileId: string) => void
  handleCloseBrowserTab: (tabId: string) => void
  handleCloseAllFiles: () => void
}

// Why capture-phase: chords must be consumed before xterm/browser-guest key handlers see them.
export function useTerminalShortcutKeybindings({
  activeWorktreeId,
  keybindings,
  terminalShortcutPolicy,
  mobileEmulatorEnabled,
  handlers
}: {
  activeWorktreeId: string | null
  keybindings: KeybindingOverrides
  terminalShortcutPolicy: TerminalShortcutPolicy | undefined
  mobileEmulatorEnabled: boolean | undefined
  handlers: TerminalShortcutHandlers
}): void {
  const {
    handleNewTab,
    handleNewAgentTab,
    handleNewSimulatorTab,
    handleNewBrowserTab,
    handleNewFile,
    handleCloseFile,
    handleCloseBrowserTab,
    handleCloseAllFiles
  } = handlers
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    const onKeyDown = (e: KeyboardEvent): void => {
      const context = getKeybindingContext(e.target) as KeybindingContext
      const floatingWorkspaceFocused = isFloatingWorkspacePanelFocused()
      const matchShortcut = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, e, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy
        })
      const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
        if (context !== 'terminal' || terminalShortcutPolicy !== 'orca-first') {
          return
        }
        showTerminalShortcutCaptureNotification({
          actionId,
          platform: shortcutPlatform,
          keybindings
        })
      }
      // Why: Cmd/Ctrl+T always opens a terminal regardless of active surface; browser tabs have their own chord (Cmd/Ctrl+Shift+B).
      if (!e.repeat && matchShortcut('tab.newTerminal')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newTerminal')
        if (floatingWorkspaceFocused) {
          void createFloatingWorkspaceTerminalTab(useAppStore.getState())
          return
        }
        handleNewTab()
        return
      }

      // Cmd/Ctrl+Alt+T — launch the default agent in a new tab (per-agent chords launch specific agents).
      // Why: unlike Cmd+T this never targets the floating panel — agent sessions belong to a worktree.
      if (!e.repeat) {
        const state = useAppStore.getState()
        let agentActionId: KeybindingActionId | null = null
        let agentToLaunch: TuiAgent | null = null
        if (matchShortcut('tab.newAgent')) {
          const connectionId = getConnectionId(activeWorktreeId)
          agentActionId = 'tab.newAgent'
          agentToLaunch = resolveDefaultAgentForNewTab({
            defaultTuiAgent: state.settings?.defaultTuiAgent,
            detectedAgentIds:
              typeof connectionId === 'string'
                ? state.remoteDetectedAgentIds[connectionId]
                : state.detectedAgentIds,
            disabledTuiAgents: state.settings?.disabledTuiAgents
          })
        } else {
          for (const bound of listBoundAgentTabActions(
            keybindings,
            state.settings?.disabledTuiAgents
          )) {
            if (matchShortcut(bound.actionId)) {
              agentActionId = bound.actionId
              // Why: a per-agent chord is explicit, so launch even if detection didn't confirm the binary — a missing CLI fails visibly in the tab.
              agentToLaunch = bound.agent
              break
            }
          }
        }
        if (agentActionId) {
          e.preventDefault()
          notifyTerminalCapture(agentActionId)
          if (agentToLaunch) {
            handleNewAgentTab(agentToLaunch)
          } else {
            toast.message(
              translate(
                'auto.components.Terminal.5b2c1a9e44',
                'No agent CLI detected — install one or pick a default agent in Settings.'
              )
            )
          }
          return
        }
      }

      // Cmd/Ctrl+Shift+T — reopen the most recently closed tab (terminal/browser/editor), Chrome-style; repeats walk back through history.
      if (!e.repeat && matchShortcut('tab.reopenClosed')) {
        e.preventDefault()
        notifyTerminalCapture('tab.reopenClosed')
        try {
          useAppStore.getState().reopenClosedTab(activeWorktreeId)
        } catch (error) {
          showClientCreationActionError(error)
        }
        return
      }

      // Cmd/Ctrl+Shift+B - new browser tab
      if (!e.repeat && matchShortcut('tab.newBrowser')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newBrowser')
        const browserAvailability = getClientCreationActionPolicy(
          useAppStore.getState(),
          floatingWorkspaceFocused ? FLOATING_TERMINAL_WORKTREE_ID : activeWorktreeId
        )['managed-browser']
        if (browserAvailability.state !== 'enabled') {
          toast.error(browserAvailability.reason)
          return
        }
        if (floatingWorkspaceFocused) {
          void createFloatingWorkspaceBrowserTab(useAppStore.getState()).catch(
            showClientCreationActionError
          )
          return
        }
        handleNewBrowserTab()
        return
      }

      // Cmd/Ctrl+Shift+E — new mobile emulator tab (macOS only)
      if (!e.repeat && mobileEmulatorEnabled && matchShortcut('tab.newSimulator')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newSimulator')
        const simulatorAvailability = getClientCreationActionPolicy(
          useAppStore.getState(),
          activeWorktreeId
        )['mobile-emulator']
        if (simulatorAvailability.state !== 'enabled') {
          toast.error(simulatorAvailability.reason)
          return
        }
        if (!floatingWorkspaceFocused) {
          handleNewSimulatorTab()
        }
        return
      }

      // Save active editor file — fallback for when focus is outside the editor (tab bar/sidebar); editor-local handlers own save when the editor is focused.
      if (!e.repeat && matchShortcut('editor.save')) {
        const target = e.target as HTMLElement | null
        const inEditor =
          target?.closest('.monaco-editor, [contenteditable]') !== null ||
          target?.closest('textarea:not(.xterm-helper-textarea), input') !== null
        if (!inEditor) {
          const state = useAppStore.getState()
          const floatingPanelOwnsEvent =
            isEventTargetInsideFloatingWorkspacePanel(e.target) || floatingWorkspaceFocused
          const requestedFileId = getEditorCmdSaveFileId(state, floatingPanelOwnsEvent)
          if (requestedFileId) {
            e.preventDefault()
            notifyTerminalCapture('editor.save')
            window.dispatchEvent(
              new CustomEvent<EditorRequestCmdSaveDetail>(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, {
                detail: { fileId: requestedFileId }
              })
            )
            return
          }
        }
      }

      // Why: long/structured files need a discoverable unwrap path without Settings (#9974).
      if (!e.repeat && matchShortcut('editor.toggleWordWrap')) {
        const state = useAppStore.getState()
        if (state.activeTabType === 'editor' && state.activeFileId) {
          e.preventDefault()
          notifyTerminalCapture('editor.toggleWordWrap')
          // Why: diff surfaces use diffWordWrap; plain editors use editorWordWrap (#10086).
          const activeFile = state.openFiles.find((file) => file.id === state.activeFileId)
          if (activeFile?.mode === 'diff') {
            const wrapOn = state.settings?.diffWordWrap === true
            void state.updateSettings({ diffWordWrap: !wrapOn })
          } else {
            const wrapOn = state.settings?.editorWordWrap !== false
            void state.updateSettings({ editorWordWrap: !wrapOn })
          }
          return
        }
      }

      // Cmd/Ctrl+Shift+M - new markdown file
      if (!e.repeat && matchShortcut('tab.newMarkdown')) {
        e.preventDefault()
        notifyTerminalCapture('tab.newMarkdown')
        if (floatingWorkspaceFocused) {
          void createFloatingWorkspaceMarkdownTab(useAppStore.getState()).catch((err) => {
            toast.error(
              err instanceof Error
                ? err.message
                : translate(
                    'auto.components.Terminal.f0600556b3',
                    'Failed to create untitled markdown file.'
                  )
            )
          })
          return
        }
        void handleNewFile()
        return
      }

      if (handleEmptyFloatingWorkspacePanelCloseShortcut(e, shortcutPlatform, keybindings)) {
        return
      }

      // Cmd/Ctrl+W — close active editor/browser tab or terminal pane. Terminal close lives in keyboard-handlers.ts (split panes + confirm dialog).
      // Why: still preventDefault here so Electron doesn't run its default Cmd+W window-close.
      if (!e.repeat && matchShortcut('tab.close')) {
        // The floating panel (L2) and its terminal pane handler (L3) own Cmd+W while the panel is
        // focused. Guard on the event target too — during blur/IME churn activeElement is transiently
        // body/null while a key still targets a floating xterm, and a main editor/browser being active
        // would otherwise close the wrong (main) tab. Yield without preventDefault so L3 runs.
        const floatingPanelOwnsEvent =
          isEventTargetInsideFloatingWorkspacePanel(e.target) || floatingWorkspaceFocused
        if (floatingPanelOwnsEvent) {
          return
        }
        const state = useAppStore.getState()
        if (state.activeTabType === 'terminal' && context === 'terminal') {
          return
        }
        e.preventDefault()
        notifyTerminalCapture('tab.close')
        if (state.activeTabType === 'editor' && state.activeFileId) {
          handleCloseFile(state.activeFileId)
        } else if (state.activeTabType === 'browser' && state.activeBrowserTabId) {
          handleCloseBrowserTab(state.activeBrowserTabId)
        }
        return
      }

      // Cmd/Ctrl+Alt+W — close every editor file tab in the active worktree.
      // Why: reuse the context-menu close-all path so pinned/dirty-file rules stay identical.
      if (!e.repeat && matchShortcut('tab.closeAll')) {
        e.preventDefault()
        notifyTerminalCapture('tab.closeAll')
        handleCloseAllFiles()
        return
      }

      // Ctrl+Tab - quick-toggle to the previously focused tab in this group.
      if (
        matchesRecentTabSwitcherChord(e, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy
        })
      ) {
        return
      }
      if (!e.repeat && matchShortcut('tab.previousRecent')) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        handleSwitchRecentTab()
        return
      }

      // Why: match on e.code, not e.key — macOS Shift+[ reports '{' and Option+[ composes dead-keys, so e.key misses the chord on many layouts.
      const switchSameTypeDirection = matchShortcut('tab.nextSameType')
        ? 1
        : matchShortcut('tab.previousSameType')
          ? -1
          : null
      const switchAllTypesDirection = matchShortcut('tab.nextAllTypes')
        ? 1
        : matchShortcut('tab.previousAllTypes')
          ? -1
          : null
      if (!e.repeat && (switchSameTypeDirection !== null || switchAllTypesDirection !== null)) {
        // Why: share the IPC-path handler and always consume the chord (even single-tab no-op) so it never reaches xterm or the browser guest.
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        notifyTerminalCapture(
          switchAllTypesDirection !== null
            ? switchAllTypesDirection === 1
              ? 'tab.nextAllTypes'
              : 'tab.previousAllTypes'
            : switchSameTypeDirection === 1
              ? 'tab.nextSameType'
              : 'tab.previousSameType'
        )
        if (floatingWorkspaceFocused) {
          switchFloatingWorkspaceTab(
            useAppStore.getState(),
            switchAllTypesDirection ?? switchSameTypeDirection ?? 1,
            switchAllTypesDirection !== null ? 'all-types' : 'same-type'
          )
        } else if (switchAllTypesDirection !== null) {
          handleSwitchTabAcrossAllTypes(switchAllTypesDirection)
        } else {
          handleSwitchTab(switchSameTypeDirection ?? 1)
        }
      }

      // Ctrl+PageDown/PageUp — switch terminal tabs only. Ctrl on every platform since macOS Cmd+PageUp/Down is an OS desktop-switch shortcut.
      // Why: reject Shift too so Ctrl+Shift+PageUp/Down stays free for focused terminal/editor consumers.
      const terminalTabDirection = matchShortcut('tab.nextTerminal')
        ? 1
        : matchShortcut('tab.previousTerminal')
          ? -1
          : null
      if (!e.repeat && terminalTabDirection !== null) {
        // Why: fully consume the chord (preventDefault alone won't stop xterm's listener); else xterm writes \e[5~/\e[6~ escapes to the shell even in the single-terminal no-op case.
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        if (floatingWorkspaceFocused) {
          switchFloatingWorkspaceTab(useAppStore.getState(), terminalTabDirection, 'terminal')
        } else {
          handleSwitchTerminalTab(terminalTabDirection)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeWorktreeId,
    handleNewBrowserTab,
    handleNewSimulatorTab,
    handleNewFile,
    handleNewTab,
    handleNewAgentTab,
    handleCloseBrowserTab,
    handleCloseFile,
    handleCloseAllFiles,
    keybindings,
    mobileEmulatorEnabled,
    terminalShortcutPolicy
  ])
}
