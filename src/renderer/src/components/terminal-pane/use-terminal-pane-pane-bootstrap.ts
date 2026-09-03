import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { IDisposable } from '@xterm/xterm'
import { isWindowsUserAgent } from './pane-helpers'
import { hydrateRuntimeEnvironmentSshState } from '@/runtime/runtime-environment-ssh-state'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'
import type { TerminalLinkActionRequest } from './terminal-link-action-request'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { isTerminalSessionStateSaveFailure } from '../../../../shared/terminal-session-state-save-failure'
import { isTerminalZeroDimensionsDiagnostic } from '../../../../shared/terminal-zero-dimensions-diagnostic'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import { collectLeafIdsInOrder, EMPTY_LAYOUT } from './layout-serialization'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { createTerminalQuickCommandDraft } from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { createRemotePaneLayoutPusher, type RemotePaneLayoutPusher } from './remote-pane-layout-push'
import type { PaneTitleOverlayRect } from './TerminalPaneHeaderOverlay'
import { appendTerminalErrorMessage } from './terminal-error-accumulation'
import {
  updateTerminalRemoteRuntimeRecoveryUiState,
  type VisiblePtyRecoveryState
} from './terminal-remote-runtime-recovery-ui-state'
import type { PaneProcessExit } from './pty-connection-types'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'
import type { SessionRestoredBannerDismissEvent } from './session-restored-banner-pane-state'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useSessionRestoredBannerDismiss } from './useSessionRestoredBannerDismiss'
import { useNotificationDispatch } from './use-notification-dispatch'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

type UseTerminalPanePaneBootstrapArgs = {
  tabId: string
  worktreeId: string
  isActive: boolean
  isVisible: boolean
  isWorktreeActive: boolean
  onPtyExit: (ptyId: string) => void
}

export function useTerminalPanePaneBootstrap({
  tabId,
  worktreeId,
  isActive,
  isVisible,
  isWorktreeActive,
  onPtyExit
}: UseTerminalPanePaneBootstrapArgs) {
  const managerRef = useRef<PaneManager | null>(null)
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const pendingPaneSizeRefreshFrameIdsRef = useRef<number[]>([])
  // Separate from expandedStyleSnapshotRef so Activity's transient isolation override doesn't collide with the user's expanded-pane state or layout snapshot.
  const activityIsolationSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  // Why: per-pane live cwd via OSC 7 for split-pane cwd inheritance; split actions read it at dispatch. See docs/ssh-split-pane-inherit-cwd.md.
  const paneCwdRef = useRef<Map<number, { cwd: string; confirmed: boolean }>>(new Map())
  const paneMode2031Ref = useRef<Map<number, boolean>>(new Map())
  // Why: per-pane mirror of kitty keyboard flags; the keyboard policy reads it to encode Option chords as kitty CSI-u for opted-in TUIs.
  const paneKittyKeyboardModesRef = useRef<Map<number, TerminalKittyKeyboardModeTracker>>(new Map())
  const paneLastThemeModeRef = useRef<Map<number, 'dark' | 'light'>>(new Map())
  const panePtyBindingsRef = useRef<Map<number, IDisposable>>(new Map())
  // Why: panes replaying recorded PTY bytes; while non-zero, pty-connection drops xterm onData so auto-replies don't leak to the shell. See replay-guard.ts.
  const replayingPanesRef = useRef<Map<number, number>>(new Map())
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const isRendererVisible = isVisible && isWorktreeActive
  const isVisibleRef = useRef(isRendererVisible)
  isVisibleRef.current = isRendererVisible
  const {
    nativeChatTranscriptIsLocalReadable,
    sshReconnectEnvironmentId,
    sshReconnectError,
    sshReconnectStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel,
    sshReconnectTargetRemoved
  } = useAppStore(useShallow((store) => selectTerminalPaneHostState(store, worktreeId)))
  useEffect(() => {
    if (!sshReconnectEnvironmentId) {
      return
    }
    // Why: an SSH workspace can mirror before its environment bucket hydrated; overlay state must come from fetched evidence, not an empty default.
    void hydrateRuntimeEnvironmentSshState(sshReconnectEnvironmentId).catch(() => {})
  }, [sshReconnectEnvironmentId])

  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  // Why: React state (not the imperative managerRef) so the render re-runs on split/close; managerRef alone doesn't trigger React deps.
  const [paneCount, setPaneCount] = useState<number>(0)
  // Why: pane reorders can move panes without changing count or size, so overlay rects need an explicit layout-change render trigger.
  const [paneLayoutRevision, setPaneLayoutRevision] = useState(0)
  const [terminalLinkActionRequest, setTerminalLinkActionRequest] =
    useState<TerminalLinkActionRequest | null>(null)
  const [quickCommandEditorOpen, setQuickCommandEditorOpen] = useState(false)
  const [quickCommandEditorHostId, setQuickCommandEditorHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [chatLeafId, setChatLeafId] = useState<string | null>(null)
  const [tabWideAgentHintLeafId, setTabWideAgentHintLeafId] = useState<string | null | undefined>(
    undefined
  )
  const [agentSessionFork, setAgentSessionFork] = useState<PreparedAgentSessionFork | null>(null)
  const [agentSessionContinuation, setAgentSessionContinuation] =
    useState<AgentSessionContinuationRequest | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [paneProcessExitsByPaneId, setPaneProcessExitsByPaneId] = useState<
    Record<number, PaneProcessExit>
  >({})
  const [ptyRecoveryStatesByPaneId, setPtyRecoveryStatesByPaneId] = useState<
    Record<number, VisiblePtyRecoveryState>
  >({})
  const [sessionStateSaveFailureOpen, setSessionStateSaveFailureOpen] = useState(false)

  // Pane title state keyed by ephemeral paneId, persisted via titlesByLeafId; ref keeps persistLayoutSnapshot closures fresh.
  const [paneTitles, setPaneTitles] = useState<Record<number, string>>({})
  const paneTitlesRef = useRef<Record<number, string>>({})
  paneTitlesRef.current = paneTitles
  const removedTitleLeafIdsRef = useRef<Set<string>>(new Set())
  const clearedScrollbackLeafIdsRef = useRef<Set<string>>(new Set())
  const remotePaneLayoutPusherRef = useRef<RemotePaneLayoutPusher | null>(null)
  remotePaneLayoutPusherRef.current ??= createRemotePaneLayoutPusher()
  const [paneTitleOverlayRects, setPaneTitleOverlayRects] = useState<
    Record<number, PaneTitleOverlayRect>
  >({})
  const onPtyErrorRef = useRef((_paneId: number, message: string) => {
    if (isTerminalSessionStateSaveFailure(message)) {
      setTerminalError(null)
      setSessionStateSaveFailureOpen(true)
      return
    }
    setTerminalError((prev) => appendTerminalErrorMessage(prev, message))
  })
  const onPtyRecoveryStateRef = useRef(
    (paneId: number, state: PtyTransportRecoveryState | null) => {
      setPtyRecoveryStatesByPaneId((previous) =>
        updateTerminalRemoteRuntimeRecoveryUiState(previous, paneId, state)
      )
    }
  )

  // Why: this hook runs before usePaneStateSubscriptions in TerminalPane, so it re-selects the same slices; identical selectors keep referential equality, so downstream memos behave the same.
  const savedLayout = useAppStore(
    (store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
  )
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )

  const setTabLayout = useAppStore((store) => store.setTabLayout)
  const expectedLayoutLeafIdsAttr =
    expectedLayoutLeafIds.length > 0 ? expectedLayoutLeafIds.join(' ') : undefined
  const initialLayoutRef = useRef(restoredLayout)
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
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
  const [shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup] = useState(
    () => startup !== undefined && !isVisible
  )
  const [sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds] = useState<
    Map<number, SessionRestoredBannerReason>
  >(() => new Map())
  const consumeTabStartupCommand = useAppStore((store) => store.consumeTabStartupCommand)
  const [setupSplit] = useState(() => useAppStore.getState().pendingSetupSplitByTabId[tabId])
  const consumeTabSetupSplit = useAppStore((store) => store.consumeTabSetupSplit)
  const [issueCommandSplit] = useState(
    () => useAppStore.getState().pendingIssueCommandSplitByTabId[tabId]
  )
  const consumeTabIssueCommandSplit = useAppStore((store) => store.consumeTabIssueCommandSplit)

  const settingsRef = useRef<GlobalSettings | null | undefined>(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useLayoutEffect(() => {
    if (isVisible && shouldMeasureHiddenStartup) {
      // Why: hidden startup measurement is first-launch only; keeping it past first visibility would let inactive tabs refit and SIGWINCH.
      setShouldMeasureHiddenStartup(false)
    }
    if (isVisible) {
      // Why: a hidden 0×0 pane self-heals once shown; clear only the stale zero-dims diagnostic so real errors survive.
      setTerminalError((prev) => (prev && isTerminalZeroDimensionsDiagnostic(prev) ? null : prev))
    }
  }, [isVisible, shouldMeasureHiddenStartup])

  // Why: renameContainerRef/dismissSessionRestoredBanner are produced by hooks that run after this one, so the component binds them here each render (latest-ref pattern).
  const sessionRestoredBannerContainerSourceRef = useRef<React.RefObject<
    HTMLElement | null
  > | null>(null)
  const dismissSessionRestoredBannerRef = useRef(
    (_event: SessionRestoredBannerDismissEvent): void => {}
  )
  const sessionRestoredBannerContainerRef = useMemo<
    React.RefObject<HTMLElement | null>
  >(
    () => ({
      get current(): HTMLElement | null {
        return sessionRestoredBannerContainerSourceRef.current?.current ?? null
      },
      set current(_value: HTMLElement | null) {
        // Why: read-through proxy; the source ref object is bound by the component after the rename hook runs.
      }
    }),
    []
  )
  const bindSessionRestoredBannerDismiss = useCallback(
    (
      containerRef: React.RefObject<HTMLElement | null>,
      dismiss: (event: SessionRestoredBannerDismissEvent) => void
    ) => {
      sessionRestoredBannerContainerSourceRef.current = containerRef
      dismissSessionRestoredBannerRef.current = dismiss
    },
    []
  )
  useSessionRestoredBannerDismiss(
    sessionRestoredBannerPaneIds.size > 0,
    sessionRestoredBannerContainerRef,
    (event) => dismissSessionRestoredBannerRef.current(event)
  )

  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureOpen(false)
    openSpacePage()
    void refreshWorkspaceSpace().catch((err: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', err)
    })
  }, [openSpacePage, refreshWorkspaceSpace])

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

  // Why: 'auto' resolves to true/false by keyboard layout (US → alt); the ref tracks that effective value, not the raw setting.
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const macOptionAsAltRef = useRef<MacOptionAsAlt>(effectiveMacOptionAsAlt)
  macOptionAsAltRef.current = effectiveMacOptionAsAlt
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  const systemPrefersDark = useSystemPrefersDark()
  const dispatchNotification = useNotificationDispatch(worktreeId)
  const setCacheTimerStartedAt = useAppStore((store) => store.setCacheTimerStartedAt)

  return {
    managerRef,
    paneFontSizesRef,
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    pendingPaneSizeRefreshFrameIdsRef,
    activityIsolationSnapshotRef,
    paneTransportsRef,
    paneCwdRef,
    paneMode2031Ref,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    panePtyBindingsRef,
    replayingPanesRef,
    isActiveRef,
    isVisibleRef,
    isRendererVisible,
    nativeChatTranscriptIsLocalReadable,
    sshReconnectEnvironmentId,
    sshReconnectError,
    sshReconnectStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel,
    sshReconnectTargetRemoved,
    expandedPaneId,
    setExpandedPaneId,
    paneCount,
    setPaneCount,
    paneLayoutRevision,
    setPaneLayoutRevision,
    terminalLinkActionRequest,
    setTerminalLinkActionRequest,
    quickCommandEditorOpen,
    setQuickCommandEditorOpen,
    quickCommandEditorHostId,
    setQuickCommandEditorHostId,
    chatLeafId,
    setChatLeafId,
    tabWideAgentHintLeafId,
    setTabWideAgentHintLeafId,
    agentSessionFork,
    setAgentSessionFork,
    agentSessionContinuation,
    setAgentSessionContinuation,
    terminalError,
    setTerminalError,
    paneProcessExitsByPaneId,
    setPaneProcessExitsByPaneId,
    ptyRecoveryStatesByPaneId,
    setPtyRecoveryStatesByPaneId,
    sessionStateSaveFailureOpen,
    setSessionStateSaveFailureOpen,
    paneTitles,
    setPaneTitles,
    paneTitlesRef,
    removedTitleLeafIdsRef,
    clearedScrollbackLeafIdsRef,
    remotePaneLayoutPusherRef,
    paneTitleOverlayRects,
    setPaneTitleOverlayRects,
    onPtyErrorRef,
    onPtyRecoveryStateRef,
    restoredLayout,
    expectedLayoutLeafIds,
    setTabLayout,
    expectedLayoutLeafIdsAttr,
    initialLayoutRef,
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
    startup,
    shouldMeasureHiddenStartup,
    setShouldMeasureHiddenStartup,
    sessionRestoredBannerPaneIds,
    setSessionRestoredBannerPaneIds,
    consumeTabStartupCommand,
    setupSplit,
    consumeTabSetupSplit,
    issueCommandSplit,
    consumeTabIssueCommandSplit,
    bindSessionRestoredBannerDismiss,
    openDiskSpaceAnalyzer,
    effectiveMacOptionAsAlt,
    macOptionAsAltRef,
    onPtyExitRef,
    systemPrefersDark,
    dispatchNotification,
    setCacheTimerStartedAt
  }
}
