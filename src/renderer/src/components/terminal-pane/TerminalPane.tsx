/* eslint-disable max-lines -- Why: terminal pane component co-locates title state, layout serialization, and portal rendering to keep pane lifecycle consistent. */
import {
  forwardRef,
  useImperativeHandle,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../store'
import {
  DaemonActionDialog  ,
  useDaemonActions
} from '@/components/shared/useDaemonActions'
import TerminalSearch from '@/components/TerminalSearch'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  useExpandCollapseActions
} from './expand-collapse'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'
import { useTerminalFontZoom } from './useTerminalFontZoom'
import CloseTerminalDialog from './CloseTerminalDialog'
import CodexRestartChip from '../CodexRestartChip'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { TerminalErrorToast } from './TerminalErrorToast'
import { TerminalProcessExitOverlay } from './TerminalProcessExitOverlay'
import { TerminalSessionStateSaveFailureDialog } from './TerminalSessionStateSaveFailureDialog'
import TerminalContextMenu from './TerminalContextMenu'
import TerminalPaneHeaderOverlay from './TerminalPaneHeaderOverlay'
import NativeChatView from '../native-chat/NativeChatView'
import { TerminalAgentSessionForkDialog } from './TerminalAgentSessionForkDialog'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import { useTerminalPanePasteEffects } from './use-terminal-pane-paste-effects'
import { usePaneStateSubscriptions } from './use-terminal-pane-pane-state'
import { useCloseFlowState } from './use-terminal-pane-close-flow'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneFocus } from './use-terminal-pane-focus'
import { useTerminalPaneLayoutBindings } from './use-terminal-pane-layout-bindings'
import { useTerminalPaneFitSync } from './use-terminal-pane-fit-sync'
import { useTerminalPaneTitleOverlay } from './use-terminal-pane-title-overlay'
import { useTerminalPaneShutdownCapture } from './use-terminal-pane-shutdown-capture'
import { useTerminalPaneRenameTitle } from './use-terminal-pane-rename-title'
import { useTerminalPaneMobileSelection } from './use-terminal-pane-mobile-selection'
import { useTerminalPaneLifecycleHandlers } from './use-terminal-pane-lifecycle-handlers'
import { useTerminalPaneMenuContext } from './use-terminal-pane-menu-context'
import { useTerminalPaneExpandLayout } from './use-terminal-pane-expand-layout'
import { useTerminalPaneCodexRestart } from './use-terminal-pane-codex-restart'
import { TerminalLinkActionPopover } from './TerminalLinkActionPopover'
import { useTerminalPaneLinkRouting } from './use-terminal-pane-link-routing'
import { useTerminalPaneErrorEffects } from './use-terminal-pane-error-effects'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import { useTerminalPaneSearchKeyboard } from './use-terminal-pane-search-keyboard'
import { useTerminalPaneChatSession } from './use-terminal-pane-chat-session'
import { useTerminalPaneRenderPrep } from './use-terminal-pane-render-prep'
import { useTerminalPanePaneBootstrap } from './use-terminal-pane-pane-bootstrap'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { useTerminalPaneRemoteLayoutSync } from './use-terminal-pane-remote-layout-sync'
import {
  getFitOverrideForPty
} from '@/lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { shouldChatTakeOverMobileSurface } from '../native-chat/native-chat-send-eligibility'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'
import {
  WORKSPACE_FILE_PATH_MIME  ,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import { TerminalQuickCommandEditorDialog } from './TerminalQuickCommandEditorDialog'
import { useTerminalPaneQuickCommands } from './use-terminal-pane-quick-commands'
import { getCachedTerminalGroupIdForWorktree } from './terminal-unified-tab-lookup'
import { useVisibleTerminalTabClaim } from './use-visible-terminal-tab-claim'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { TerminalRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'

// Why: registry lives in a leaf module to break the slice → TerminalPane → store → slice import cycle that leaves createTerminalSlice undefined at init.

type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  isWorktreeActive?: boolean
  // When set (Activity portal), isolates one split pane as a transient override that doesn't touch expandedPaneId or persist the layout.
  isolatedPaneKey?: string | null
  // Why: ephemeral one-off command terminals don't need the header's prominent split affordance (split shortcuts still work).
  showSplitButton?: boolean
  onPtyExit: (ptyId: string) => void
  onCloseTab: () => void
}

export type TerminalPaneHandle = {
  closeActivePane: () => void
}

function TerminalPane(
  {
    tabId,
    worktreeId,
    cwd,
    isActive,
    isVisible = true,
    isWorktreeActive = isVisible,
    isolatedPaneKey = null,
    showSplitButton = true,
    onPtyExit,
    onCloseTab
  }: TerminalPaneProps,
  ref: React.ForwardedRef<TerminalPaneHandle>
): React.JSX.Element {
  const {
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
    expectedLayoutLeafIdsAttr,
    initialLayoutRef,
    startup,
    shouldMeasureHiddenStartup,
    sessionRestoredBannerPaneIds,
    setSessionRestoredBannerPaneIds,
    setupSplit,
    issueCommandSplit,
    onPtyExitRef,
    settleTabStartupCommand
  } = useTerminalPanePaneBootstrap({ tabId, worktreeId, isActive, isVisible, isWorktreeActive, onPtyExit })
  const {
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
    settings,
    settingsRef,
    keybindings,
    rightClickToPaste,
    openDiskSpaceAnalyzer,
    effectiveMacOptionAsAlt,
    macOptionAsAltRef,
    dispatchNotification,
    setCacheTimerStartedAt
  } = useTerminalPaneStoreActions({
    tabId,
    worktreeId,
    setupSplit,
    issueCommandSplit,
    setSessionStateSaveFailureOpen
  })

  useVisibleTerminalTabClaim({ isVisible, tabId })

  const paneStateSubscriptions = usePaneStateSubscriptions({ tabId, worktreeId, chatLeafId })
  // Why: each Add action starts with a fresh draft so the terminal menu doesn't reuse cancelled quick-command text.
  const [quickCommandDraft, setQuickCommandDraft] = useState(createTerminalQuickCommandDraft)
  const daemonActions = useDaemonActions()
  const { refreshMobileOverlays } = useMobileOverlayTicks({ managerRef, paneTransportsRef })

  const {
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    pendingCodexPaneRestartIds,
    consumePendingCodexPaneRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    nativeChatEnabled,
    effectiveChatViewMode,
    chatPaneDispatchStatus,
    unifiedTabLabel,
    setTabViewMode,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    savedLayout,
    terminalTab
  } = paneStateSubscriptions

  const chatSessionHandlers = useTerminalPaneChatSession({
    chatLeafId,
    setChatLeafId,
    tabWideAgentHintLeafId,
    setTabWideAgentHintLeafId,
    agentSessionFork,
    setAgentSessionFork,
    agentSessionContinuation,
    setAgentSessionContinuation,
    paneCount,
    managerRef,
    nativeChatEnabled,
    nativeChatTranscriptIsLocalReadable,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    unifiedTabId,
    setTabViewMode,
    tabAgentTypeByLeaf,
    terminalTab,
    runtimePaneTitlesByPaneId,
    unifiedTabLabel,
    expectedLayoutLeafIds
  })

  const {
    onAgentExitedRef,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    isChatEligibleForLeaf,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen,
    resolveAgentForLeaf,
    activePaneCanContinueInNewSession,
    getContextMenuCanContinueInNewSession
  } = chatSessionHandlers

  const { persistLayoutSnapshot } = useTerminalPaneLayoutPersistence({
    managerRef,
    getRenameContainerRef: () => renameContainerRef,
    expandedPaneIdRef,
    paneTransportsRef,
    clearedScrollbackLeafIdsRef,
    removedTitleLeafIdsRef,
    remotePaneLayoutPusherRef,
    paneTitlesRef,
    paneTitles,
    setPaneTitles,
    tabId,
    worktreeId,
    savedLayout,
    terminalTab,
    paneCount
  })

  const {
    handlePaneProcessDied,
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    clearPaneScrollback,
    removePaneTitle,
    handleClearPaneTitleShortcut
  } = useTerminalPaneLifecycleHandlers({
    managerRef,
    paneTransportsRef,
    paneTitlesRef,
    paneTitlesState: [paneTitles, setPaneTitles],
    sessionRestoredBannerPaneIdsState: [sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds],
    paneProcessExitsByPaneIdState: [paneProcessExitsByPaneId, setPaneProcessExitsByPaneId],
    clearedScrollbackLeafIdsRef,
    removedTitleLeafIdsRef,
    persistLayoutSnapshot
  })

  const {
    renameContainerRef,
    setContainerRef,
    renamingPaneId,
    setRenamingPaneId,
    renameValue,
    setRenameValue,
    renameInputRef,
    handleStartRename,
    handleRenameSubmit,
    handleRenameCancel,
    handleRenameBlur,
    handleRemoveTitle
  } = useTerminalPaneRenameTitle({
    removePaneTitle,
    paneTitlesRef,
    managerRef,
    removedTitleLeafIdsRef,
    persistLayoutSnapshot,
    setPaneTitles
  })


  const {
    searchOpen,
    setSearchOpen,
    searchOpenRef,
    searchStateRef,
    handleSearchSelectedText
  } = useTerminalPaneSearchKeyboard()

  const {
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding
  } = useTerminalPaneLayoutBindings({
    tabId,
    managerRef
  })

  const {
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    syncExpandedLayout,
    toggleExpandPane
  } = useExpandCollapseActions({
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    renameContainerRef,
    managerRef,
    pendingPaneSizeRefreshFrameIdsRef,
    setExpandedPaneId,
    setTabPaneExpanded,
    tabId,
    persistLayoutSnapshot
  })

  const closeFlow = useCloseFlowState({
    managerRef,
    paneTransportsRef,
    onCloseTab,
    tabId,
    clearSessionRestoredBannerForPane,
    syncPanePtyLayoutBinding
  })
  const { pendingCloseConfirmation, handleConfirmClose, handleCancelClose, handleRequestClosePane, closeActivePane, executeClosePane } = closeFlow

  useImperativeHandle(
    ref,
    () => ({
      closeActivePane
    }),
    [closeActivePane]
  )

  const {
    requestTerminalLinkAction,
    closeTerminalLinkActions,
    requestOpenLinksInAppPreference,
    resolveExternalPaneDropTarget,
    handleExternalPaneDrop
  } = useTerminalPaneLinkRouting({
    tabId,
    worktreeId,
    managerRef,
    paneTransportsRef,
    isActive,
    isRendererVisible,
    paneLayoutRevision,
    setTerminalLinkActionRequest,
    persistLayoutSnapshot
  })

  useTerminalPaneLifecycle({
    tabId,
    worktreeId,
    cwd,
    startup,
    setupSplit,
    issueCommandSplit,
    isActive,
    isVisible: isRendererVisible,
    systemPrefersDark,
    requestOpenLinksInAppPreference,
    requestTerminalLinkAction,
    effectiveMacOptionAsAlt,
    effectiveMacOptionAsAltRef: macOptionAsAltRef,
    initialLayoutRef,
    managerRef,
    getTabWideAgentHintLeafId: () => getTabWideAgentHintLeafIdRef.current(),
    renameContainerRef,
    expandedStyleSnapshotRef,
    paneFontSizesRef,
    paneTransportsRef,
    paneCwdRef,
    paneMode2031Ref,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    panePtyBindingsRef,
    replayingPanesRef,
    isActiveRef,
    isVisibleRef,
    onPtyExitRef,
    onAgentExitedRef,
    onPtyErrorRef,
    onPaneProcessDied: handlePaneProcessDied,
    onPtyRecoveryStateRef,
    consumeSuppressedPtyExit: useAppStore((store) => store.consumeSuppressedPtyExit),
    isPtyShutdownPending: useAppStore((store) => store.isPtyShutdownPending),
    onShowSessionRestoredBanner: showRestoredSessionBanner,
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding,
    onStartupBound: settleTabStartupCommand,
    setTabPaneExpanded,
    setTabCanExpandPane,
    setExpandedPane,
    syncExpandedLayout,
    persistLayoutSnapshot,
    setPaneTitles,
    paneTitlesRef,
    setRenamingPaneId,
    setPaneCount,
    setPaneLayoutRevision,
    resolveExternalPaneDropTarget,
    onExternalPaneDrop: handleExternalPaneDrop
  })

  useTerminalPaneRemoteLayoutSync({
    managerRef,
    renameContainerRef,
    activityIsolationSnapshotRef,
    pendingPaneSizeRefreshFrameIdsRef,
    tabId,
    isActive,
    paneCount,
    isolatedPaneKey,
    restoredLayout,
    persistLayoutSnapshot
  })

  useTerminalFontZoom({ isActive, renameContainerRef, managerRef, paneFontSizesRef, settingsRef })

  useTerminalKeyboardShortcuts({
    tabId,
    worktreeId,
    isActive,
    keyboardScopeRef: renameContainerRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneCwdRef,
    fallbackCwd: cwd ?? '',
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onSearchSelectedText: handleSearchSelectedText,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onClearPaneTitle: handleClearPaneTitleShortcut,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef,
    paneKittyKeyboardModesRef,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy ?? 'orca-first'
  })

  useTerminalPaneGlobalEffects({
    tabId,
    // Why: use the pane's own worktreeId prop, not global activeWorktreeId, so terminal-drop routes to this PTY's worktree without racing worktree switches.
    worktreeId,
    cwd,
    isActive,
    isVisible,
    isWorktreeActive,
    // Why: hidden startup probes are opacity-hidden but measurable; ordinary hidden tabs are display:none and refit on visibility resume.
    isSyncFitEnabled: isRendererVisible || shouldMeasureHiddenStartup,
    paneCount,
    managerRef,
    renameContainerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    isActiveRef,
    isVisibleRef,
    toggleExpandPane
  })

  useTerminalPaneFitSync({
    isActive,
    isVisible,
    managerRef,
    paneTransportsRef
  })

  useTerminalPaneFocus({
    renameContainerRef
  })

  useTerminalPanePasteEffects({
    isActive,
    worktreeId,
    tabId,
    renameContainerRef,
    managerRef,
    paneTransportsRef,
    setTerminalError
  })

  const { clearPaneProcessExit } = useTerminalPaneExpandLayout({
    tabId,
    paneCount,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup,
    paneLayoutRevision,
    managerRef,
    setPaneProcessExitsByPaneId
  })

  const { handleRestartExitedPane, handleCloseExitedPane } = useTerminalPaneCodexRestart({
    tabId,
    worktreeId,
    cwd,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneMode2031Ref,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    replayingPanesRef,
    isActiveRef,
    isVisibleRef,
    onPtyExitRef,
    onAgentExitedRef,
    onPtyErrorRef,
    onPtyRecoveryStateRef,
    handlePaneProcessDied,
    clearPaneProcessExit,
    executeClosePane,
    suppressPtyExit,
    clearCodexRestartNotice,
    clearTabPtyId,
    updateTabTitle,
    setRuntimePaneTitle,
    clearRuntimePaneTitle,
    updateTabPtyId,
    markWorktreeUnread,
    markTerminalTabUnread,
    markTerminalPaneUnread,
    clearWorktreeUnread,
    clearTerminalTabUnread,
    clearTerminalPaneUnread,
    showRestoredSessionBanner,
    dispatchNotification,
    setCacheTimerStartedAt,
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding,
    setTerminalError,
    pendingCodexPaneRestartIds,
    consumePendingCodexPaneRestart,
    savedLayout
  })

  useTerminalPaneTitleOverlay({
    managerRef,
    renameContainerRef,
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    setPaneTitleOverlayRects
  })

  useTerminalPaneShutdownCapture({
    tabId,
    worktreeId,
    managerRef,
    renameContainerRef,
    expandedPaneIdRef,
    paneTransportsRef,
    paneTitlesRef,
    clearedScrollbackLeafIdsRef,
    setTabLayout
  })

  const {
    quickCommandRepoId,
    quickCommandRepoLabel,
    openQuickCommandEditor,
    saveQuickCommand,
    visibleQuickCommandHosts,
    quickCommandHostLoadFailed,
    quickCommandHostOwnershipPending
  } = useTerminalPaneQuickCommands({
    worktreeId,
    contextMenuOpen: contextMenu.open,
    quickCommandEditorHostId,
    setQuickCommandEditorOpen,
    setQuickCommandEditorHostId,
    setQuickCommandDraft
  })

  const quickCommandGroupId =
    useAppStore(
      (s) =>
        getCachedTerminalGroupIdForWorktree(s.unifiedTabsByWorktree, worktreeId, tabId) ??
        s.activeGroupIdByWorktree[worktreeId] ??
        null
    ) ?? null

  const contextMenu = useTerminalPaneContextMenu({
    tabId,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    renameContainerRef,
    worktreeId,
    groupId: quickCommandGroupId,
    fallbackCwd: cwd ?? '',
    toggleExpandPane,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onClearPaneTitle: handleClearPaneTitleShortcut,
    onPasteError: setTerminalError,
    onAgentSessionForkReady: setAgentSessionFork,
    onAgentSessionContinuationReady: setAgentSessionContinuation,
    rightClickToPaste
  })
  const {
    getContextMenuLeafId,
    activatePaneTitleInteraction,
    splitTerminalPaneFromHeader,
    beginPaneDragFromHeader
  } = useTerminalPaneMenuContext({
    contextMenu,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    cwd
  })
  const contextMenuLeafId = getContextMenuLeafId()

  const {
    restorePaneTerminalFit,
    restoreAllTerminalFits,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick
  } = useTerminalPaneMobileSelection({
    paneTransportsRef,
    managerRef,
    tabId,
    worktreeId,
    refreshMobileOverlays,
    setTerminalError
  })

  const {
    titleUsesLightSurface,
    paneTitleBackground,
    terminalContentVisible,
    hiddenStartupStyle,
    terminalContainerStyle,
    activePane,
    managedPanes,
    showSshReconnectOverlay,
    menuPaneHasCustomTitle,
    chatLeafStillMounted,
    chatPane,
    chatPanePtyId,
    chatPaneResolvedAgent,
    chatPaneLaunchAgent,
    structuredChatAgent,
    structuredChatTarget,
    contextMenuCanContinueInNewSession
  } = useTerminalPaneRenderPrep({
    tabId,
    worktreeId,
    renameContainerRef,
    managerRef,
    paneTransportsRef,
    clearTerminalTabUnread,
    clearTerminalPaneUnread,
    clearWorktreeUnread,
    setSessionRestoredBannerPaneIds,
    paneCount,
    settings,
    systemPrefersDark,
    isVisible,
    shouldMeasureHiddenStartup,
    isActive,
    sshReconnectTargetId,
    sshReconnectStatus,
    chatLeafId,
    isChatViewMode,
    structuredSessionAgent,
    contextMenuLeafId,
    getContextMenuCanContinueInNewSession,
    resolveTitleAgentForLeaf,
    getTabWideAgentHintLeafId,
    getNativeChatLeafIds,
    paneTitles,
    contextMenuPaneId: contextMenu.menuPaneId,
    terminalTab
  })

  const { dismissTerminalError } = useTerminalPaneErrorEffects({
    terminalError,
    setTerminalError,
    showSshReconnectOverlay,
    isChatViewMode,
    chatLeafId,
    activeLeafId: activePane?.leafId ?? null,
    chatLeafStillMounted,
    applyNativeChatLeafRoute,
    isChatEligibleForLeaf,
    structuredSessionId,
    paneTransportsRef
  })

  return (
    <>
      <div
        ref={setContainerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        data-native-file-drop-target="terminal"
        data-terminal-tab-id={tabId}
        data-terminal-layout-leaf-ids={expectedLayoutLeafIdsAttr}
        data-pane-title-surface={titleUsesLightSurface ? 'light' : 'dark'}
        style={terminalContainerStyle}
        onContextMenuCapture={contextMenu.onContextMenuCapture}
        onMouseDownCapture={handlePrimarySelectionMiddleMouseDown}
        onAuxClickCapture={handlePrimarySelectionAuxClick}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) ||
            e.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
          ) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
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
        }}
      />
      {managedPanes.map((pane) => {
        const ptyId =
          paneTransportsRef.current.get(pane.id)?.getPtyId() ??
          savedLayout.ptyIdsByLeafId?.[pane.leafId]
        if (!ptyId) {
          return null
        }
        return createPortal(
          <CodexRestartChip
            key={`codex-restart-${pane.id}-${ptyId}`}
            isVisible={isVisible}
            ptyId={ptyId}
            shouldFocus={isActive && isVisible && activePane?.id === pane.id}
          />,
          pane.container,
          `codex-restart-${pane.id}`
        )
      })}
      {/* Why: the reconnect banner already owns SSH recovery UX; the z-50 error
          toast was painting over it (same bottom strip) with the raw ssh:connect failure. */}
      {terminalError && isActive && !showSshReconnectOverlay ? (
        <TerminalErrorToast
          error={terminalError}
          onDismiss={dismissTerminalError}
          onRestartDaemon={() => daemonActions.setPending('restart')}
        />
      ) : null}
      {isActive
        ? managedPanes.map((pane) => {
            const processExit = paneProcessExitsByPaneId[pane.id]
            return processExit
              ? createPortal(
                  <TerminalProcessExitOverlay
                    processExit={processExit}
                    onRestart={() => handleRestartExitedPane(processExit)}
                    onClose={() => handleCloseExitedPane(pane.id)}
                  />,
                  pane.container,
                  `process-exit-${pane.id}`
                )
              : null
          })
        : null}
      {/* Why: portal into the pane so the banner stacks above the xterm canvas (sibling mount painted under WebGL). */}
      {showSshReconnectOverlay && sshReconnectTargetId && sshReconnectStatus
        ? managedPanes.map((pane) =>
            createPortal(
              <TerminalSshReconnectOverlay
                targetId={sshReconnectTargetId}
                targetLabel={sshReconnectTargetLabel}
                status={sshReconnectStatus}
                error={sshReconnectError}
                targetRemoved={sshReconnectTargetRemoved}
                worktreeId={worktreeId}
                sshOwnerEnvironmentId={sshReconnectEnvironmentId}
              />,
              pane.container,
              `ssh-reconnect-${pane.id}`
            )
          )
        : null}
      <DaemonActionDialog api={daemonActions} />
      {isActive && (
        <TerminalSessionStateSaveFailureDialog
          open={sessionStateSaveFailureOpen}
          onDismiss={() => setSessionStateSaveFailureOpen(false)}
          onOpenSpaceAnalyzer={openDiskSpaceAnalyzer}
        />
      )}
      {activePane?.container &&
        createPortal(
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activePane.searchAddon ?? null}
            searchStateRef={searchStateRef}
          />,
          activePane.container
        )}
      <SessionRestoredBannerPortals
        panes={managerRef.current?.getPanes() ?? []}
        paneIds={sessionRestoredBannerPaneIds}
      />
      {effectiveChatViewMode && chatPane?.container
        ? createPortal(
            <div className="native-chat-pane-shell absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background">
              {structuredSessionId && structuredChatAgent ? (
                <NativeChatView
                  mode="structured"
                  tabId={unifiedTabId ?? tabId}
                  sessionId={structuredSessionId}
                  agent={structuredChatAgent}
                  isVisible={isRendererVisible}
                  target={structuredChatTarget}
                  allowFileUriLinks
                  orchestrationDispatchStatus={chatPaneDispatchStatus}
                />
              ) : (
                <NativeChatView
                  terminalTabId={tabId}
                  isVisible={isRendererVisible}
                  paneKey={makePaneKey(tabId, chatPane.leafId)}
                  targetPtyId={chatPanePtyId}
                  launchAgent={chatPaneLaunchAgent}
                  resolvedAgent={chatPaneResolvedAgent}
                  onSwitchToTerminal={switchNativeChatToTerminal}
                  readTerminalScreen={readNativeChatTerminalScreen}
                  contextMenuActions={{
                    onSplitRight: () =>
                      contextMenu.runForPane(chatPane.id, contextMenu.onSplitRight),
                    onSplitDown: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitDown),
                    canEqualizePaneSizes: managedPanes.length > 1 && expandedPaneId === null,
                    onEqualizePaneSizes: () =>
                      contextMenu.runForPane(chatPane.id, contextMenu.onEqualizePaneSizes),
                    canExpandPane: managedPanes.length > 1,
                    isPaneExpanded: expandedPaneId === chatPane.id,
                    onToggleExpand: () =>
                      contextMenu.runForPane(chatPane.id, contextMenu.onToggleExpand),
                    canContinueAgentSessionInNewSession: canContinueAgentSessionInNewSession(
                      resolveAgentForLeaf(chatPane.leafId)
                    ),
                    onContinueAgentSessionInNewSession: () =>
                      contextMenu.runForPane(
                        chatPane.id,
                        contextMenu.onContinueAgentSessionInNewSession
                      ),
                    onForkAgentSession: () =>
                      void contextMenu.runForPane(chatPane.id, contextMenu.onForkAgentSession),
                    onSetTitle: () => contextMenu.runForPane(chatPane.id, contextMenu.onSetTitle),
                    onCopyTerminalId: () =>
                      void contextMenu.runForPane(chatPane.id, contextMenu.onCopyTerminalId),
                    onCopyPaneId: () =>
                      void contextMenu.runForPane(chatPane.id, contextMenu.onCopyPaneId),
                    canClosePane: managedPanes.length > 1,
                    onClosePane: () => contextMenu.runForPane(chatPane.id, contextMenu.onClosePane)
                  }}
                  orchestrationDispatchStatus={chatPaneDispatchStatus}
                />
              )}
            </div>,
            chatPane.container,
            `native-chat-${tabId}-${chatPane.leafId}`
          )
        : null}
      <TerminalContextMenu
        open={contextMenu.open}
        onOpenChange={contextMenu.setOpen}
        menuPoint={contextMenu.point}
        menuOpenedAtRef={contextMenu.menuOpenedAtRef}
        canClosePane={contextMenu.paneCount > 1}
        canExpandPane={contextMenu.paneCount > 1}
        canEqualizePaneSizes={contextMenu.paneCount > 1 && expandedPaneId === null}
        menuPaneIsExpanded={
          contextMenu.menuPaneId !== null && contextMenu.menuPaneId === expandedPaneId
        }
        onCopy={() => void contextMenu.onCopy()}
        onSelectAll={contextMenu.onSelectAll}
        onPaste={() => void contextMenu.onPaste()}
        onSplitRight={contextMenu.onSplitRight}
        onSplitDown={contextMenu.onSplitDown}
        keybindings={keybindings}
        onEqualizePaneSizes={contextMenu.onEqualizePaneSizes}
        onClosePane={contextMenu.onClosePane}
        onClearScreen={contextMenu.onClearScreen}
        canContinueAgentSessionInNewSession={contextMenuCanContinueInNewSession}
        onContinueAgentSessionInNewSession={contextMenu.onContinueAgentSessionInNewSession}
        onForkAgentSession={() => void contextMenu.onForkAgentSession()}
        onCopyAgentSessionContext={() => void contextMenu.onCopyAgentSessionContext()}
        quickCommandHosts={visibleQuickCommandHosts}
        quickCommandHostLoadFailed={quickCommandHostLoadFailed}
        quickCommandHostOwnershipPending={quickCommandHostOwnershipPending}
        quickCommandRepoLabel={quickCommandRepoLabel}
        onQuickCommand={contextMenu.onQuickCommand}
        onAddQuickCommand={(hostId) =>
          quickCommandRepoId
            ? openQuickCommandEditor({ type: 'repo', repoId: quickCommandRepoId }, hostId)
            : openQuickCommandEditor({ type: 'global' }, hostId)
        }
        onToggleExpand={contextMenu.onToggleExpand}
        onSetTitle={contextMenu.onSetTitle}
        onClearPaneTitle={contextMenu.onClearPaneTitle}
        canClearPaneTitle={menuPaneHasCustomTitle}
        onCopyTerminalId={() => void contextMenu.onCopyTerminalId()}
        onCopyPaneId={contextMenu.onCopyPaneId}
      />
      <TerminalLinkActionPopover
        request={terminalLinkActionRequest}
        onClose={closeTerminalLinkActions}
      />
      {/* Why: repos is a broad store slice; only subscribe while the editor is visible. */}
      {quickCommandEditorOpen ? (
        <TerminalQuickCommandEditorDialog
          command={quickCommandDraft}
          hostId={quickCommandEditorHostId}
          onOpenChange={setQuickCommandEditorOpen}
          onSave={saveQuickCommand}
        />
      ) : null}
      <TerminalAgentSessionForkDialog
        open={agentSessionFork !== null}
        fork={agentSessionFork}
        onOpenChange={(open) => {
          if (!open) {
            setAgentSessionFork(null)
          }
        }}
      />
      {agentSessionContinuation ? (
        <AgentSessionContinuationDialog
          open
          request={agentSessionContinuation}
          onOpenChange={(open) => {
            if (!open) {
              setAgentSessionContinuation(null)
            }
          }}
        />
      ) : null}
      <TerminalPaneHeaderOverlay
        tabId={tabId}
        worktreeId={worktreeId}
        cwd={cwd ?? ''}
        showAlwaysOnHeaders={isActive && terminalContentVisible}
        showSplitButton={showSplitButton}
        paneCount={paneCount}
        activePaneId={activePane?.id}
        panes={managedPanes}
        paneTitles={paneTitles}
        paneTitleOverlayRects={paneTitleOverlayRects}
        renamingPaneId={renamingPaneId}
        renameValue={renameValue}
        renameInputRef={renameInputRef}
        titleUsesLightSurface={titleUsesLightSurface}
        paneTitleBackground={paneTitleBackground}
        terminalContentVisible={terminalContentVisible}
        hiddenStartupStyle={hiddenStartupStyle}
        managerRef={managerRef}
        paneTransportsRef={paneTransportsRef}
        canContinueAgentSessionInNewSession={activePaneCanContinueInNewSession}
        onContinueAgentSessionInNewSession={(pane) =>
          contextMenu.runForPane(pane.id, contextMenu.onContinueAgentSessionInNewSession)
        }
        onSplitPane={splitTerminalPaneFromHeader}
        onBeginPaneDrag={beginPaneDragFromHeader}
        onActivatePaneTitleInteraction={activatePaneTitleInteraction}
        onPaneTitleContextMenu={contextMenu.onPaneTitleContextMenu}
        onStartRename={handleStartRename}
        onRemoveTitle={handleRemoveTitle}
        onClosePane={handleRequestClosePane}
        onRenameValueChange={setRenameValue}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={handleRenameCancel}
        onRenameBlur={handleRenameBlur}
      />
      {!showSshReconnectOverlay
        ? managedPanes.map((pane) => {
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
        : null}
      {managedPanes.map((pane) => {
        // Why: pane IDs collide across tabs, so key overlays by the transport's actual ptyId to avoid wrong-pane banners.
        const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
        if (!ptyId) {
          return null
        }
        // Why: two-state lock — mobile driver → presence-lock (docs/mobile-presence-lock.md); phone-fit override → indefinite hold (docs/mobile-fit-hold.md).
        const driver = getDriverForPty(ptyId)
        const fitMode = getFitOverrideForPty(ptyId)?.mode ?? null
        const hasFitOverride = fitMode === 'mobile-fit'
        if (!shouldShowMobileDriverOverlay(driver.kind, fitMode)) {
          return null
        }
        // Why: only the chat-replaced pane hides presence-lock/phone-fit chrome; sibling splits stay normal terminals.
        const paneSurface =
          effectiveChatViewMode && pane.leafId === chatLeafId ? 'chat' : 'terminal'
        if (shouldChatTakeOverMobileSurface(paneSurface)) {
          return null
        }
        return createPortal(
          <MobileDriverOverlay
            key={`mobile-driver-${pane.id}-${ptyId}`}
            driver={driver}
            hasFitOverride={hasFitOverride}
            rootClassName="mobile-driver-banner"
            onAction={() => restorePaneTerminalFit(pane, ptyId)}
            onAllAction={() => restoreAllTerminalFits(pane)}
          />,
          pane.container,
          `mobile-driver-banner-${pane.id}`
        )
      })}
      <CloseTerminalDialog
        open={pendingCloseConfirmation !== null}
        copyKind={pendingCloseConfirmation?.copyKind}
        onCancel={handleCancelClose}
        onConfirm={handleConfirmClose}
      />
    </>
  )
}

export default forwardRef(TerminalPane)
