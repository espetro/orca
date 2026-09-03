import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { isWindowsUserAgent } from './pane-helpers'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import { useNotificationDispatch } from './use-notification-dispatch'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

type UseTerminalPaneStoreActionsArgs = {
  tabId: string
  worktreeId: string
  setupSplit: unknown
  issueCommandSplit: unknown
  setSessionStateSaveFailureOpen: (open: boolean) => void
}

export function useTerminalPaneStoreActions({ tabId, worktreeId, setupSplit, issueCommandSplit, setSessionStateSaveFailureOpen }: UseTerminalPaneStoreActionsArgs) {
  const setTabLayout = useAppStore((store) => store.setTabLayout)
  const updateTabTitle = useAppStore((store) => store.updateTabTitle)
  const setRuntimePaneTitle = useAppStore((store) => store.setRuntimePaneTitle)
  const clearRuntimePaneTitle = useAppStore((store) => store.clearRuntimePaneTitle)
  const updateTabPtyId = useAppStore((store) => store.updateTabPtyId)
  const clearTabPtyId = useAppStore((store) => store.clearTabPtyId)
  const markWorktreeUnread = useAppStore((store) => store.markWorktreeUnread)
  const markTerminalTabUnread = useAppStore((store) => store.markTerminalTabUnread)
  const markTerminalPaneUnread = useAppStore((store) => store.markTerminalPaneUnread)
  const clearWorktreeUnread = useAppStore((store) => store.clearWorktreeUnread)
  const clearTerminalTabUnread = useAppStore((store) => store.clearTerminalTabUnread)
  const clearTerminalPaneUnread = useAppStore((store) => store.clearTerminalPaneUnread)
  const openSpacePage = useAppStore((store) => store.openSpacePage)
  const refreshWorkspaceSpace = useAppStore((store) => store.refreshWorkspaceSpace)
  const settings = useAppStore((store) => store.settings)
  const updateSettings = useAppStore((store) => store.updateSettings)
  const requestLinkRoutingPreference = useLinkRoutingPreferenceDialog()
  const keybindings = useAppStore((store) => store.keybindings)
  const rightClickToPaste = settings?.terminalRightClickToPaste ?? isWindowsUserAgent()
  // Why: Windows ConPTY doesn't forward DECSET 2004 from TUIs, so xterm may not know multi-line paste needs bracketed protection.
  const forceBracketedMultilineTextPaste = isWindowsUserAgent()
  const consumeTabStartupCommand = useAppStore((store) => store.consumeTabStartupCommand)
  const consumeTabSetupSplit = useAppStore((store) => store.consumeTabSetupSplit)
  const consumeTabIssueCommandSplit = useAppStore((store) => store.consumeTabIssueCommandSplit)
  const settingsRef = useRef<GlobalSettings | null | undefined>(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  // Why: 'auto' resolves to true/false by keyboard layout (US → alt); the ref tracks that effective value, not the raw setting.
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const macOptionAsAltRef = useRef<MacOptionAsAlt>(effectiveMacOptionAsAlt)
  macOptionAsAltRef.current = effectiveMacOptionAsAlt
  const systemPrefersDark = useSystemPrefersDark()
  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureOpen(false)
    openSpacePage()
    void refreshWorkspaceSpace().catch((err: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', err)
    })
  }, [openSpacePage, refreshWorkspaceSpace, setSessionStateSaveFailureOpen])
  const dispatchNotification = useNotificationDispatch(worktreeId)

  useEffect(() => {
    if (setupSplit) {
      consumeTabSetupSplit(tabId)
    }
  }, [setupSplit, tabId, consumeTabSetupSplit])

  // Clear the queued issue-command split once this tab has captured it for initial mount.
  useEffect(() => {
    if (issueCommandSplit) {
      consumeTabIssueCommandSplit(tabId)
    }
  }, [issueCommandSplit, tabId, consumeTabIssueCommandSplit])
  const setCacheTimerStartedAt = useAppStore((store) => store.setCacheTimerStartedAt)

  return {
    setTabLayout,
    updateTabTitle,
    setRuntimePaneTitle,
    clearRuntimePaneTitle,
    updateTabPtyId,
    clearTabPtyId,
    markWorktreeUnread,
    markTerminalTabUnread,
    markTerminalPaneUnread,
    clearWorktreeUnread,
    clearTerminalTabUnread,
    clearTerminalPaneUnread,
    openSpacePage,
    refreshWorkspaceSpace,
    settings,
    settingsRef,
    updateSettings,
    requestLinkRoutingPreference,
    keybindings,
    rightClickToPaste,
    forceBracketedMultilineTextPaste,
    consumeTabStartupCommand,
    consumeTabSetupSplit,
    consumeTabIssueCommandSplit,
    openDiskSpaceAnalyzer,
    effectiveMacOptionAsAlt,
    macOptionAsAltRef,
    systemPrefersDark,
    dispatchNotification,
    setCacheTimerStartedAt
  }
}
