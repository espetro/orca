import { useEffect } from 'react'
import type { ReadClipboardTextOptions } from '../../../../shared/clipboard-text'
import { assertClipboardTextWithinLimitWithYield } from '../../../../shared/clipboard-text'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'
import { isEditableTarget } from '@/lib/editable-target'
import { useAppStore } from '../../store'
import type { PtyTransport } from './pty-transport'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import {
  firesNativePasteEvent,
  getClipboardEventText,
  isClipboardEventPasteRequired
} from './terminal-clipboard-event-paste'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'
import { copyTerminalSelection } from './terminal-selection-copy'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'
import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteSource,
  type TerminalPasteTextOptions
} from './terminal-paste-coordinator'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import {
  isTerminalPanePasteFocusCurrent,
  isTerminalPanePasteTargetCurrent
} from './terminal-paste-target-state'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

function isInsideNativeChatRoot(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_CHAT_ROOT_SELECTOR) !== null
}

function formatClipboardImagePasteError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Image paste failed: ${detail}`
}

type UseTerminalPanePasteEffectsArgs = {
  isActive: boolean
  worktreeId: string
  tabId: string
  keybindings: KeybindingOverrides
  forceBracketedMultilineTextPaste: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  setTerminalError: (value: string | null) => void
}

export function useTerminalPanePasteEffects({
  isActive,
  worktreeId,
  tabId,
  keybindings,
  forceBracketedMultilineTextPaste,
  containerRef,
  managerRef,
  paneTransportsRef,
  setTerminalError
}: UseTerminalPanePasteEffectsArgs): void {
  // Intercept paste at keydown: Chromium fires no paste event for image-only clipboard on a textarea (xterm's focus target), so image pastes would be lost.
  // Paste-event handler is a fallback for non-keyboard triggers; it also bypasses Chromium's clipboard pipeline that intermittently fails concurrent CLI reads.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'

    const isPanePasteTargetMounted = (
      pane: ManagedPane,
      transport: PtyTransport | undefined,
      ptyId: string | null
    ): boolean => {
      return isTerminalPanePasteTargetCurrent({
        manager: managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneId: pane.id,
        leafId: pane.leafId,
        transport,
        ptyId
      })
    }

    const executePanePasteText = async (
      pane: ManagedPane,
      source: TerminalPasteSource,
      activeElementAtDispatch: Element | null,
      text: string,
      options?: TerminalPasteTextOptions
    ): Promise<void> => {
      const connectionId = getConnectionId(worktreeId) ?? null
      const transport = paneTransportsRef.current.get(pane.id)
      const ptyId = transport?.getPtyId() ?? null
      const keyboardOwnedPaste =
        source === 'keyboard' || source === 'paste-event' || source === 'app-menu'
      const plan = await planTerminalPasteWithYield({
        text,
        source,
        target: {
          kind: 'terminal',
          paneId: pane.id,
          leafId: pane.leafId,
          ptyId,
          runtime: resolveTerminalPasteRuntime({
            platform: shortcutPlatform,
            ptyId,
            connectionId,
            remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
            transport,
            isWindowsConpty: forceBracketedMultilineTextPaste
          })
        },
        forceBracketedPaste: options?.forceBracketedPaste,
        forceBracketedPasteForMultiline: options?.forceBracketedPasteForMultiline,
        windowsInputRecordNewline: options?.windowsInputRecordNewline,
        terminalBracketedPasteMode: pane.terminal.modes.bracketedPasteMode
      })
      const execution = await executeTerminalPastePlan(plan, {
        pasteText: (pasteText, pasteOptions) =>
          pasteTerminalText(pane.terminal, pasteText, pasteOptions),
        writePty: (data) => writeTerminalPastePtyInput(transport, data),
        isTargetCurrent: () => {
          if (!isPanePasteTargetMounted(pane, transport, ptyId)) {
            return false
          }
          return isTerminalPanePasteFocusCurrent({
            requireSameFocusedElement: keyboardOwnedPaste,
            activeElementAtDispatch,
            paneContainer: pane.container
          })
        },
        canContinue: () => isPanePasteTargetMounted(pane, transport, ptyId)
      })
      if (execution.status !== 'pasted') {
        setTerminalError(formatTerminalPasteExecutionError(execution.reason))
        return
      }
      if (text) {
        recordTerminalUserInputForLeaf(tabId, pane.leafId)
      }
      if (options?.recoverImagePasteWebglAtlas) {
        scheduleImagePasteWebglAtlasRecovery()
      }
    }

    // Why: resolved per pane and PTY host; split siblings and remote hosts can need
    // different multiline paste protocols.
    const resolvePaneProtectedMultilinePasteOptions = (
      pane: ManagedPane
    ): TerminalPasteTextOptions | undefined => {
      const state = useAppStore.getState()
      const transport = paneTransportsRef.current.get(pane.id) ?? null
      return resolveProtectedMultilinePasteOptionsForPane({
        isWindowsClient: forceBracketedMultilineTextPaste,
        hostPlatform: resolveTerminalInputHostPlatform({
          clientPlatform: shortcutPlatform,
          state,
          worktreeId,
          transport
        }),
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
        tabId,
        leafId: pane.leafId
      })
    }

    const pasteFromClipboard = (
      pane: ManagedPane,
      source: Extract<TerminalPasteSource, 'keyboard' | 'paste-event'>,
      readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string> = window.api.ui
        .readClipboardText
    ): void => {
      const connectionId = getConnectionId(worktreeId) ?? null
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      const activeElementAtDispatch = document.activeElement
      void pasteTerminalClipboard({
        readClipboardText,
        saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
        connectionId,
        runtimeEnvironmentId,
        protectedMultilineTextPasteOptions: resolvePaneProtectedMultilinePasteOptions(pane),
        pasteText: (text, options) =>
          executePanePasteText(pane, source, activeElementAtDispatch, text, options),
        onTextPasteError: () =>
          setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
        onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
      }).catch(() => {
        setTerminalError('Paste failed.')
      })
    }

    let suppressNextNativePaste = false
    let pasteSuppressionTimerId: number | null = null
    const shouldSuppressNativePaste = (e: KeyboardEvent): boolean => {
      const key = e.key.toLowerCase()
      return (
        (isMac && key === 'v' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) ||
        (!isMac && key === 'v' && e.ctrlKey && !e.metaKey && !e.altKey) ||
        (!isMac && e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      )
    }
    const onKeyPaste = (e: KeyboardEvent): void => {
      const target = e.target
      if (
        (target instanceof Element && target.closest('[data-terminal-search-root]')) ||
        isInsideNativeChatRoot(target)
      ) {
        return
      }
      const matchesPaste = keybindingMatchesAction(
        'terminal.paste',
        e,
        shortcutPlatform,
        keybindings,
        { context: 'terminal' }
      )
      if (!matchesPaste) {
        if (shouldSuppressNativePaste(e)) {
          // Why: bare Ctrl+V is readline's quote-insert on Windows/Linux; suppress the native paste Chromium may add while letting xterm keep the keydown.
          suppressNextNativePaste = true
          if (pasteSuppressionTimerId !== null) {
            window.clearTimeout(pasteSuppressionTimerId)
          }
          pasteSuppressionTimerId = window.setTimeout(() => {
            pasteSuppressionTimerId = null
            suppressNextNativePaste = false
          }, 0)
        }
        return
      }
      if (isClipboardEventPasteRequired() && firesNativePasteEvent(e, isMac)) {
        // Why: without navigator.clipboard the chord's native paste event is the
        // only clipboard access — let its default fire and handle it in onPaste.
        // A remapped chord (e.g. Ctrl+Y) fires no paste event, so keep consuming it
        // below instead of letting xterm encode it to the PTY as a raw control char.
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      suppressNextNativePaste = true
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
      }
      pasteSuppressionTimerId = window.setTimeout(() => {
        pasteSuppressionTimerId = null
        suppressNextNativePaste = false
      }, 0)
      pasteFromClipboard(pane, 'keyboard')
    }

    // Fallback: paste events from non-keyboard sources (Edit > Paste menu, programmatic paste, etc.).
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target
      if (
        (target instanceof Element && target.closest('[data-terminal-search-root]')) ||
        isInsideNativeChatRoot(target)
      ) {
        return
      }
      if (suppressNextNativePaste) {
        suppressNextNativePaste = false
        if (pasteSuppressionTimerId !== null) {
          window.clearTimeout(pasteSuppressionTimerId)
          pasteSuppressionTimerId = null
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      if (isClipboardEventPasteRequired()) {
        const eventText = getClipboardEventText(e)
        pasteFromClipboard(pane, 'paste-event', (options) =>
          assertClipboardTextWithinLimitWithYield(eventText, options)
        )
        return
      }
      pasteFromClipboard(pane, 'paste-event')
    }

    const onAppMenuPaste = (event: Event): void => {
      const activeElementAtDispatch = document.activeElement
      if (
        !(activeElementAtDispatch instanceof Element) ||
        !container.contains(activeElementAtDispatch) ||
        activeElementAtDispatch.closest('[data-terminal-search-root]') ||
        isInsideNativeChatRoot(activeElementAtDispatch)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      const connectionId = getConnectionId(worktreeId) ?? null
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      void pasteTerminalClipboard({
        readClipboardText: window.api.ui.readClipboardText,
        saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
        connectionId,
        runtimeEnvironmentId,
        protectedMultilineTextPasteOptions: resolvePaneProtectedMultilinePasteOptions(pane),
        pasteText: (text, options) =>
          executePanePasteText(pane, 'app-menu', activeElementAtDispatch, text, options),
        onTextPasteError: () =>
          setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
        onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
      }).catch(() => {
        setTerminalError('Paste failed.')
      })
    }

    const onAppMenuSelectionAction = (event: Event): void => {
      const activeElement = document.activeElement
      if (
        !(activeElement instanceof Element) ||
        !container.contains(activeElement) ||
        isEditableTarget(activeElement) ||
        activeElement.closest('[data-terminal-search-root]') ||
        isInsideNativeChatRoot(activeElement)
      ) {
        return
      }
      const manager = managerRef.current
      const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!pane) {
        return
      }
      const action = (event as CustomEvent<AppMenuSelectionAction>).detail
      if (action === 'copy') {
        if (!pane.terminal.getSelection()) {
          return
        }
        event.preventDefault()
        void copyTerminalSelection({
          terminal: pane.terminal,
          writeClipboardText: window.api.ui.writeTerminalClipboardText
        }).catch(() => undefined)
        return
      }
      if (action === 'select-all') {
        event.preventDefault()
        pane.terminal.selectAll()
      }
    }

    container.addEventListener('keydown', onKeyPaste, { capture: true })
    container.addEventListener('paste', onPaste, { capture: true })
    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
    return () => {
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
      }
      container.removeEventListener('keydown', onKeyPaste, { capture: true })
      container.removeEventListener('paste', onPaste, { capture: true })
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
      window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
    }
  }, [isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])
}
