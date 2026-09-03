import { useEffect } from 'react'
import { assertClipboardTextWithinLimitWithYield } from '../../../../shared/clipboard-text'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
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
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import {
  firesNativePasteEvent,
  getClipboardEventText,
  isClipboardEventPasteRequired
} from './terminal-clipboard-event-paste'
import { copyTerminalSelection } from './terminal-selection-copy'
import { createTerminalPanePasteDispatch } from './terminal-pane-paste-dispatch'

const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

function isInsideNativeChatRoot(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_CHAT_ROOT_SELECTOR) !== null
}

function formatClipboardImagePasteError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Image paste failed: ${detail}`
}

function resolveShortcutPlatform(isMac: boolean): NodeJS.Platform {
  return isMac ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
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
    const shortcutPlatform = resolveShortcutPlatform(isMac)

    const { executePanePasteText, resolvePaneProtectedMultilinePasteOptions, pasteFromClipboard } =
      createTerminalPanePasteDispatch({
        worktreeId,
        tabId,
        shortcutPlatform,
        forceBracketedMultilineTextPaste,
        managerRef,
        paneTransportsRef,
        setTerminalError
      })

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
    const armNativePasteSuppression = (): void => {
      suppressNextNativePaste = true
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
      }
      pasteSuppressionTimerId = window.setTimeout(() => {
        pasteSuppressionTimerId = null
        suppressNextNativePaste = false
      }, 0)
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
          armNativePasteSuppression()
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
      armNativePasteSuppression()
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
  }, [
    isActive,
    worktreeId,
    keybindings,
    forceBracketedMultilineTextPaste,
    tabId,
    containerRef,
    managerRef,
    paneTransportsRef,
    setTerminalError
  ])
}
