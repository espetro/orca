/* eslint-disable max-lines -- Why: terminal pane component co-locates title state, layout serialization, and portal rendering to keep pane lifecycle consistent. */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { useAppStore } from '../../store'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import { DaemonActionDialog, useDaemonActions } from '@/components/shared/useDaemonActions'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  isTerminalBackgroundLight,
  normalizeColor,
  resolveOpaqueTerminalBackground,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import type {
  ManagedPane,
  PaneExternalDropTarget,
  PaneManager
} from '@/lib/pane-manager/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'
import type { PtyTransport } from './pty-transport'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import { fitPanes, isWindowsUserAgent } from './pane-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { hydrateRuntimeEnvironmentSshState } from '@/runtime/runtime-environment-ssh-state'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { collectLeafIdsInOrder } from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  restoreExpandedLayoutFrom,
  useExpandCollapseActions
} from './expand-collapse'
import { useTerminalKeyboardShortcuts, type SearchState } from './keyboard-handlers'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useTerminalFontZoom } from './useTerminalFontZoom'
import CloseTerminalDialog from './CloseTerminalDialog'
import CodexRestartChip from '../CodexRestartChip'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { stripSshReconnectOwnedErrorLines, TerminalErrorToast } from './TerminalErrorToast'
import { TerminalProcessExitOverlay } from './TerminalProcessExitOverlay'
import { TerminalSessionStateSaveFailureDialog } from './TerminalSessionStateSaveFailureDialog'
import TerminalContextMenu from './TerminalContextMenu'
import TerminalPaneHeaderOverlay, { type PaneTitleOverlayRect } from './TerminalPaneHeaderOverlay'
import NativeChatView from '../native-chat/NativeChatView'
import { TerminalAgentSessionForkDialog } from './TerminalAgentSessionForkDialog'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import { useSessionRestoredBannerDismiss } from './useSessionRestoredBannerDismiss'
import {
  pruneSessionRestoredBannerPaneIds,
  syncSessionRestoredBannerTitleSpace,
  type SessionRestoredBannerReason
} from './session-restored-banner-pane-state'
import { useSystemPrefersDark } from './use-system-prefers-dark'
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
import { TerminalLinkActionPopover } from './TerminalLinkActionPopover'
import { type TerminalLinkActionRequest } from './terminal-link-action-request'
import { useTerminalPaneLinkRouting } from './use-terminal-pane-link-routing'
import { useTerminalPaneErrorEffects } from './use-terminal-pane-error-effects'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import { useTerminalPaneSearchKeyboard } from './use-terminal-pane-search-keyboard'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { useNotificationDispatch } from './use-notification-dispatch'
import { useTerminalPaneChatSession } from './use-terminal-pane-chat-session'
import { useTerminalPanePaneBootstrap } from './use-terminal-pane-pane-bootstrap'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { useTerminalPaneRemoteLayoutSync } from './use-terminal-pane-remote-layout-sync'
import { connectPanePty } from './pty-connection'
import type { PaneProcessExit, PtyConnectionDeps } from './pty-connection-types'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import {
  getMobileFitOverridePtyIds,
  getFitOverrideForPty
} from '@/lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { getAllDrivers, getDriverForPty, isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { shouldChatTakeOverMobileSurface } from '../native-chat/native-chat-send-eligibility'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'
import {
  armPrimarySelectionNativePasteSuppression,
  isPrimarySelectionEnabled,
  readPrimarySelectionText
} from '@/lib/primary-selection'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { isTerminalSessionStateSaveFailure } from '../../../../shared/terminal-session-state-save-failure'
import { isTerminalZeroDimensionsDiagnostic } from '../../../../shared/terminal-zero-dimensions-diagnostic'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions
} from './terminal-live-layout-reconciliation'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/terminal-quick-command-types'
import {
  createRemotePaneLayoutPusher,
  type RemotePaneLayoutPusher
} from './remote-pane-layout-push'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { useProjectHostSetupProjection, useRepoById } from '@/store/selectors'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../../shared/terminal-quick-commands'
import { terminalQuickCommandMatchesWorkspaceProject } from '@/lib/terminal-quick-command-project-scope'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'
import { useVisibleTerminalTabClaim } from './use-visible-terminal-tab-claim'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { TerminalRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'
import {
  updateTerminalRemoteRuntimeRecoveryUiState,
  type VisiblePtyRecoveryState
} from './terminal-remote-runtime-recovery-ui-state'

// Why: registry lives in a leaf module to break the slice → TerminalPane → store → slice import cycle that leaves createTerminalSlice undefined at init.
import { pasteTerminalText } from './terminal-bracketed-paste'
import { executeTerminalPastePlan, planTerminalPasteWithYield } from './terminal-paste-coordinator'
import { appendTerminalErrorMessage } from './terminal-error-accumulation'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import {
  applyTerminalPaneAttentionToManager,
  subscribeTerminalPaneAttention
} from './terminal-pane-attention-subscriptions'
import { getCachedTerminalGroupIdForWorktree } from './terminal-unified-tab-lookup'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'
import { useTerminalQuickCommandHosts } from '@/hooks/use-terminal-quick-command-hosts'

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

type TerminalQuickCommandEditorDialogProps = {
  command: TerminalQuickCommand
  hostId: ExecutionHostId
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

function TerminalQuickCommandEditorDialog({
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
  } = useTerminalPanePaneBootstrap({ tabId, worktreeId, isActive, isVisible, isWorktreeActive, onPtyExit })

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
    setTabLayout,
    savedLayout,
    terminalTab,
    paneCount
  })

  const {
    handlePaneProcessDied,
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    dismissSessionRestoredBanner,
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
    renameContainerRef: renameContainerRef,
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

  const quickCommandRepoId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const quickCommandRepo = useRepoById(quickCommandRepoId)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const quickCommandRepoLabel = quickCommandRepo
    ? quickCommandRepo.displayName || quickCommandRepo.path
    : quickCommandRepoId
      ? 'This Repo'
      : null
  const quickCommandGroupId =
    useAppStore(
      (s) =>
        getCachedTerminalGroupIdForWorktree(s.unifiedTabsByWorktree, worktreeId, tabId) ??
        s.activeGroupIdByWorktree[worktreeId] ??
        null
    ) ?? null

  const openQuickCommandEditor = useCallback(
    (scope: TerminalQuickCommandScope, hostId: ExecutionHostId): void => {
      setQuickCommandDraft(createTerminalQuickCommandDraft(scope))
      setQuickCommandEditorHostId(hostId)
      setQuickCommandEditorOpen(true)
    },
    []
  )

  const saveQuickCommand = useCallback(
    (command: TerminalQuickCommand): void => {
      void useAppStore.getState().upsertTerminalQuickCommand(quickCommandEditorHostId, command)
    },
    [quickCommandEditorHostId]
  )

  const {
    searchOpen,
    setSearchOpen,
    searchOpenRef,
    searchStateRef,
    handleSearchSelectedText
  } = useTerminalPaneSearchKeyboard()

  const {
    writePanePtyLayoutBinding,
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
    updateSettings,
    clearSessionRestoredBannerForPane,
    syncPanePtyLayoutBinding
  })
  const { pendingCloseConfirmation, handleConfirmClose, handleCancelClose, handleRequestClosePane, closeActivePane } = closeFlow

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
    settings,
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
    settings,
    settingsRef,
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
    clearTabPtyId,
    consumeSuppressedPtyExit: useAppStore((store) => store.consumeSuppressedPtyExit),
    isPtyShutdownPending: useAppStore((store) => store.isPtyShutdownPending),
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
    onShowSessionRestoredBanner: showRestoredSessionBanner,
    dispatchNotification,
    setCacheTimerStartedAt,
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

  const handleRestartCodexPane = useCallback(
    (
      paneId: number,
      restartStartup: PtyConnectionDeps['startup'] = CODEX_ACCOUNT_RESTART_STARTUP
    ) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }

      const transport = paneTransportsRef.current.get(paneId)
      const panePtyBinding = panePtyBindingsRef.current.get(paneId)
      const existingPtyId = transport?.getPtyId()

      if (existingPtyId) {
        suppressPtyExit(existingPtyId)
        clearCodexRestartNotice(existingPtyId)
        // Why: keep the pane mounted (clear binding, consume the suppressed exit) so a fresh PTY reconnects in place under the newly selected Codex account.
        clearTabPtyId(tabId, existingPtyId)
      }

      panePtyBinding?.dispose()
      panePtyBindingsRef.current.delete(paneId)
      syncPanePtyLayoutBinding(paneId, null)
      transport?.destroy?.()
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)

      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: restartStartup,
        mountFollowsTerminalPark: false,
        paneTransportsRef,
        paneMode2031Ref,
        paneKittyKeyboardModesRef,
        paneLastThemeModeRef,
        replayingPanesRef,
        isActiveRef,
        isVisibleRef,
        onPtyExitRef,
        onAgentExitedRef,
        onPtyErrorRef,
        onPaneProcessDied: handlePaneProcessDied,
        onPtyRecoveryStateRef,
        clearTabPtyId,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        isPtyShutdownPending: useAppStore.getState().isPtyShutdownPending,
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
        onShowSessionRestoredBanner: showRestoredSessionBanner,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      manager.setActivePane(paneId, { focus: true })
    },
    [
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearRuntimePaneTitle,
      clearTabPtyId,
      cwd,
      dispatchNotification,
      handlePaneProcessDied,
      markWorktreeUnread,
      markTerminalTabUnread,
      markTerminalPaneUnread,
      clearWorktreeUnread,
      clearTerminalTabUnread,
      clearTerminalPaneUnread,
      showRestoredSessionBanner,
      onAgentExitedRef,
      onPtyExitRef,
      setCacheTimerStartedAt,
      setRuntimePaneTitle,
      suppressPtyExit,
      syncPanePtyLayoutBinding,
      tabId,
      updateTabPtyId,
      updateTabTitle,
      worktreeId
    ]
  )


  const handleRestartExitedPane = useCallback(
    (processExit: PaneProcessExit) => {
      clearPaneProcessExit(processExit.paneId)
      handleRestartCodexPane(
        processExit.paneId,
        resolveTerminalProcessExitRestartStartup(processExit)
      )
    },
    [clearPaneProcessExit, handleRestartCodexPane]
  )

  const handleCloseExitedPane = useCallback(
    (paneId: number) => {
      clearPaneProcessExit(paneId)
      executeClosePane(paneId)
    },
    [clearPaneProcessExit, executeClosePane]
  )

  // Why leaf bindings are a dep: a parked or deferred tab mounts with no
  // transport, so a queued restart has no ptyId to match on the mount pass. The
  // reconnected PTY rewrites this map when it binds — `ptyIdsByTabId` does not,
  // because a restored id is already listed there before the pane ever mounts.
  // Panes with no mounted TerminalPane at all are executed by the detached
  // driver instead (codex-detached-pane-restart), which leaves anything a live
  // transport owns to this effect.
  const panePtyLayoutBindings = savedLayout.ptyIdsByLeafId
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }

    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !pendingCodexPaneRestartIds[ptyId]) {
        continue
      }
      // Why: the status-bar switcher requests a global Codex restart, but execution stays pane-scoped so a split tab doesn't lose unrelated non-Codex panes.
      if (consumePendingCodexPaneRestart(ptyId)) {
        handleRestartCodexPane(pane.id)
      }
    }
  }, [
    consumePendingCodexPaneRestart,
    handleRestartCodexPane,
    panePtyLayoutBindings,
    pendingCodexPaneRestartIds
  ])

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
    keybindings,
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
    keybindings,
    forceBracketedMultilineTextPaste,
    renameContainerRef,
    managerRef,
    paneTransportsRef,
    setTerminalError
  })

  // Dismiss the pane's attention indicator on click (ghostty "show until interact"); pointerdown covers the mouse path onData doesn't.
  // NOT gated on isActive: clicking a visible-but-inactive split pane must clear the worktree dot before focusGroup re-renders it active.
  useEffect(() => {
    const container = renameContainerRef.current
    if (!container) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      clearTerminalTabUnread(tabId)
      clearWorktreeUnread(worktreeId)
      const paneElement =
        event.target instanceof Element ? event.target.closest('.pane[data-leaf-id]') : null
      const leafId = paneElement?.getAttribute('data-leaf-id')
      if (leafId) {
        clearTerminalPaneUnread(makePaneKey(tabId, leafId))
      }
    }
    container.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [tabId, worktreeId, clearTerminalTabUnread, clearTerminalPaneUnread, clearWorktreeUnread])

  const { clearPaneProcessExit, applyTerminalPaneAttention } = useTerminalPaneExpandLayout({
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

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    setSessionRestoredBannerPaneIds((prev) => {
      const next = pruneSessionRestoredBannerPaneIds(prev, manager.getPanes())
      return next === prev ? prev : next
    })
  }, [paneCount])

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
    forceBracketedMultilineTextPaste,
    rightClickToPaste
  })
  const {
    executionHostId: quickCommandExecutionHostId,
    hosts: quickCommandHosts,
    refreshRemoteHost: refreshQuickCommandRemoteHost,
    remoteHostLoadFailed: quickCommandHostLoadFailed,
    remoteHostPending: quickCommandHostOwnershipPending
  } = useTerminalQuickCommandHosts(worktreeId, contextMenu.open)
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
    if (contextMenu.open) {
      refreshQuickCommandRemoteHost()
    }
  }, [contextMenu.open, refreshQuickCommandRemoteHost])
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
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits,
    terminalShouldHandleMiddleClick,
    getPrimarySelectionMiddleClickPane,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick
  } = useTerminalPaneMobileSelection({
    paneTransportsRef,
    managerRef,
    settingsRef,
    tabId,
    worktreeId,
    forceBracketedMultilineTextPaste,
    refreshMobileOverlays,
    setTerminalError
  })

  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalBackground =
    settings?.terminalColorOverrides?.background ?? effectiveAppearance?.theme?.background
  // Why: app light/dark can diverge from the terminal theme, so pane-title contrast follows the effective terminal surface.
  const titleUsesLightSurface = isTerminalBackgroundLight(terminalBackground, {
    appSurface: effectiveAppearance?.mode,
    backgroundOpacity: settings?.terminalBackgroundOpacity
  })
  const paneTitleBackground =
    resolveOpaqueTerminalBackground(terminalBackground, {
      appSurface: effectiveAppearance?.mode,
      backgroundOpacity: settings?.terminalBackgroundOpacity
    }) ?? (titleUsesLightSurface ? '#ffffff' : '#000000')

  const terminalContentVisible = isVisible || shouldMeasureHiddenStartup
  const hiddenStartupStyle: CSSProperties = shouldMeasureHiddenStartup
    ? { opacity: 0, pointerEvents: 'none' }
    : {}
  const terminalContainerStyle: CSSProperties = {
    // Why: unfocused split groups keep a terminal visible; gating on isActive blanked the prior pane and exposed the white group body.
    display: terminalContentVisible ? 'flex' : 'none',
    // Why: split dividers overdraw into the pane, so overflow:hidden clips that pseudo-element paint at the terminal body.
    overflow: 'hidden',
    ...hiddenStartupStyle,
    ['--orca-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--orca-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }

  const activePane = managerRef.current?.getActivePane()
  const managedPanes = managerRef.current?.getPanes() ?? []
  const showSshReconnectOverlay = Boolean(
    isActive &&
    isVisible &&
    sshReconnectTargetId &&
    sshReconnectStatus &&
    sshReconnectStatus !== 'connected'
  )
  const menuPaneHasCustomTitle =
    contextMenu.menuPaneId !== null && Boolean(paneTitles[contextMenu.menuPaneId])
  const chatLeafStillMounted = chatLeafId
    ? managedPanes.some((pane) => pane.leafId === chatLeafId)
    : false
  const chatPane =
    isChatViewMode && chatLeafId
      ? (managedPanes.find((pane) => pane.leafId === chatLeafId) ?? null)
      : null
  const chatPanePtyId = chatPane
    ? (paneTransportsRef.current.get(chatPane.id)?.getPtyId() ?? null)
    : null
  const chatPaneResolvedAgent = chatPane ? resolveTitleAgentForLeaf(chatPane.leafId) : null
  const chatPaneLaunchAgent = nativeChatLaunchAgentForLeaf({
    launchAgent: terminalTab?.launchAgent,
    launchAgentLeafId: getTabWideAgentHintLeafId(),
    leafId: chatPane?.leafId ?? null,
    leafIds: getNativeChatLeafIds()
  })
  const structuredChatAgent = structuredSessionAgent ?? chatPaneResolvedAgent ?? chatPaneLaunchAgent
  const structuredChatTarget = useMemo(() => ({ kind: 'local' as const }), [])
  const contextMenuCanContinueInNewSession = getContextMenuCanContinueInNewSession(contextMenuLeafId)

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
