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
import {
  collectLeafIdsInOrder,
  EMPTY_LAYOUT,
  serializeTerminalLayout
} from './layout-serialization'
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
import { useNativeChatHandlers } from './use-terminal-pane-native-chat'
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
import { TerminalLinkActionPopover } from './TerminalLinkActionPopover'
import { type TerminalLinkActionRequest } from './terminal-link-action-request'
import { useTerminalPaneLinkRouting } from './use-terminal-pane-link-routing'
import { useTerminalPaneErrorEffects } from './use-terminal-pane-error-effects'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { useNotificationDispatch } from './use-notification-dispatch'
import { connectPanePty } from './pty-connection'
import type { PaneProcessExit, PtyConnectionDeps } from './pty-connection-types'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
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
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  armPrimarySelectionNativePasteSuppression,
  isPrimarySelectionEnabled,
  readPrimarySelectionText
} from '@/lib/primary-selection'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { isTerminalSessionStateSaveFailure } from '../../../../shared/terminal-session-state-save-failure'
import { isTerminalZeroDimensionsDiagnostic } from '../../../../shared/terminal-zero-dimensions-diagnostic'
import {
  isSyntheticSinglePaneTitle,
  sanitizeTerminalLayoutPaneTitles
} from '@/lib/terminal-pane-title-sanitization'
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
import { canContinueAgentSessionInNewSession } from './terminal-agent-session-continuation'
import {
  updateTerminalRemoteRuntimeRecoveryUiState,
  type VisiblePtyRecoveryState
} from './terminal-remote-runtime-recovery-ui-state'

// Why: registry lives in a leaf module to break the slice → TerminalPane → store → slice import cycle that leaves createTerminalSlice undefined at init.
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
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
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
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

  useVisibleTerminalTabClaim({ isVisible, tabId })

  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  // Why: React state (not the imperative managerRef) so the render re-runs on split/close; managerRef alone doesn't trigger React deps.
  const [paneCount, setPaneCount] = useState<number>(0)
  // Why: pane reorders can move panes without changing count or size, so overlay rects need an explicit layout-change render trigger.
  const [paneLayoutRevision, setPaneLayoutRevision] = useState(0)
  const [terminalLinkActionRequest, setTerminalLinkActionRequest] =
    useState<TerminalLinkActionRequest | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const searchStateRef = useRef<SearchState>({ query: '', caseSensitive: false, regex: false })
  const [quickCommandEditorOpen, setQuickCommandEditorOpen] = useState(false)
  const [quickCommandEditorHostId, setQuickCommandEditorHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [chatLeafId, setChatLeafId] = useState<string | null>(null)
  const paneStateSubscriptions = usePaneStateSubscriptions({ tabId, worktreeId, chatLeafId })
  const onAgentExitedRef = useRef<(leafId: string) => void>(() => {})
  const [tabWideAgentHintLeafId, setTabWideAgentHintLeafId] = useState<string | null | undefined>(
    undefined
  )
  // Why: each Add action starts with a fresh draft so the terminal menu doesn't reuse cancelled quick-command text.
  const [quickCommandDraft, setQuickCommandDraft] = useState(createTerminalQuickCommandDraft)
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
  const daemonActions = useDaemonActions()
  const { refreshMobileOverlays } = useMobileOverlayTicks({ managerRef, paneTransportsRef })

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
  /** Dismissal is the only signal that the user has seen the surface, so it must also release the transports' repeat-suppression memory. */
  const dismissTerminalError = useCallback(() => {
    setTerminalError(null)
    for (const transport of paneTransportsRef.current.values()) {
      transport.notifyErrorSurfaceDismissed?.()
    }
  }, [])
  const onPtyRecoveryStateRef = useRef(
    (paneId: number, state: PtyTransportRecoveryState | null) => {
      setPtyRecoveryStatesByPaneId((previous) =>
        updateTerminalRemoteRuntimeRecoveryUiState(previous, paneId, state)
      )
    }
  )

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
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )
  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane) => pane.leafId) ?? []
    // Why: a partially hydrated manager can expose one pane of a restored split; union both sources so tab-wide evidence stays disabled.
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
  }, [expectedLayoutLeafIds])
  const getTabWideAgentHintLeafId = useCallback((): string | null => {
    if (tabWideAgentHintLeafId !== undefined) {
      return tabWideAgentHintLeafId
    }
    const leafIds = getNativeChatLeafIds()
    return leafIds.length === 1 ? leafIds[0] : null
  }, [getNativeChatLeafIds, tabWideAgentHintLeafId])
  const getTabWideAgentHintLeafIdRef = useRef(getTabWideAgentHintLeafId)
  useEffect(() => {
    getTabWideAgentHintLeafIdRef.current = getTabWideAgentHintLeafId
  }, [getTabWideAgentHintLeafId])
  useEffect(() => {
    if (tabWideAgentHintLeafId !== undefined) {
      return
    }
    const leafIds = getNativeChatLeafIds()
    if (leafIds.length === 0) {
      return
    }
    // Why: tab-wide launch/title metadata predates leaf ownership; bind it only when the first topology proves the sole leaf it describes.
    setTabWideAgentHintLeafId(leafIds.length === 1 ? leafIds[0] : null)
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId])
  const resolveTitleAgentForLeaf = useCallback(
    (leafId: string | null) => {
      const hasSingleKnownLeaf =
        getNativeChatLeafIds().length === 1 && getTabWideAgentHintLeafId() === leafId
      return resolveNativeChatLeafTitleAgent({
        leafId,
        panes: managerRef.current?.getPanes() ?? [],
        runtimePaneTitlesByPaneId,
        tabLabel: hasSingleKnownLeaf ? unifiedTabLabel : null,
        terminalTitle: hasSingleKnownLeaf ? terminalTab?.title : null
      })
    },
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel
    ]
  )
  const nativeChatHandlers = useNativeChatHandlers({
    chatLeafId,
    setChatLeafId,
    managerRef,
    onAgentExitedRef,
    nativeChatEnabled,
    nativeChatTranscriptIsLocalReadable,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    unifiedTabId,
    setTabViewMode,
    tabAgentTypeByLeaf,
    terminalTab,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    resolveTitleAgentForLeaf
  })
  const {
    isChatEligibleForLeaf,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen
  } = nativeChatHandlers
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

  useSessionRestoredBannerDismiss(
    sessionRestoredBannerPaneIds.size > 0,
    renameContainerRef,
    dismissSessionRestoredBanner
  )

  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureOpen(false)
    openSpacePage()
    void refreshWorkspaceSpace().catch((err: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', err)
    })
  }, [openSpacePage, refreshWorkspaceSpace])

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

  // Memoized so downstream hooks don't re-register listeners each render; reads only refs/stable values, so deps stay minimal.
  const persistLayoutSnapshot = useCallback((): void => {
    const manager = managerRef.current
    const container = renameContainerRef.current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const leafIdByPaneId = manager.getLeafIdMap()
    const layout = serializeTerminalLayout(
      container,
      activePaneId,
      expandedPaneIdRef.current,
      leafIdByPaneId
    )
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    const currentPanes = manager.getPanes()
    const currentLeafIds = new Set(currentPanes.map((p) => p.leafId))
    const clearedScrollbackLeafIds = clearedScrollbackLeafIdsRef.current
    const scrollbackPreserveLeafIds = new Set(
      [...currentLeafIds].filter((leafId) => !clearedScrollbackLeafIds.has(leafId))
    )
    // Preserve existing buffersByLeafId so layout-only persists don't clobber captured scrollback; drop dead leaves.
    const mergedBuffers = mergeCapturedLeafState({
      prior: existing?.buffersByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedBuffers).length > 0) {
      layout.buffersByLeafId = mergedBuffers
    }
    const mergedScrollbackRefs = mergeCapturedLeafState({
      prior: existing?.scrollbackRefsByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedScrollbackRefs).length > 0) {
      layout.scrollbackRefsByLeafId = mergedScrollbackRefs
    }
    // Why: before PTYs attach (deferred rAF) transports return null; preserve prior leaf→PTY mappings so a fast remount doesn't force fresh spawns.
    const livePtyEntries = currentPanes
      .map((p) => [p.leafId, paneTransportsRef.current.get(p.id)?.getPtyId() ?? null] as const)
      .filter(
        (entry): entry is readonly [(typeof currentPanes)[number]['leafId'], string] =>
          entry[1] !== null
      )
    const mergedPtyIds = mergeCapturedLeafState({
      prior: existing?.ptyIdsByLeafId,
      fresh: Object.fromEntries(livePtyEntries),
      currentLeafIds
    })
    if (Object.keys(mergedPtyIds).length > 0) {
      layout.ptyIdsByLeafId = mergedPtyIds
    }
    layout.activeLeafId = resolveTerminalLayoutActiveLeafId({
      root: layout.root,
      activeLeafId: layout.activeLeafId,
      ptyIdsByLeafId: mergedPtyIds
    })
    // Preserve pane titles from live React state (via ref); Zustand is stale for in-flight edits not yet persisted.
    const titlesByLeafId: Record<string, string> = {}
    const removedTitleLeafIds = removedTitleLeafIdsRef.current
    for (const pane of currentPanes) {
      const existingTitle = existing?.titlesByLeafId?.[pane.leafId]
      if (existingTitle && !removedTitleLeafIds.has(pane.leafId)) {
        titlesByLeafId[pane.leafId] = existingTitle
      }
    }
    // Why: agents can persist layout while pane-title React state lags, so keep existing titles unless removed before overlaying live state.
    const titles = paneTitlesRef.current
    for (const pane of currentPanes) {
      const title = titles[pane.id]
      if (title) {
        titlesByLeafId[pane.leafId] = title
        removedTitleLeafIds.delete(pane.leafId)
      }
    }
    if (Object.keys(titlesByLeafId).length > 0) {
      layout.titlesByLeafId = titlesByLeafId
    }
    setTabLayout(tabId, layout)
    // Why: pane geometry is host-authoritative for remote tabs, so push ratios/expand/titles or they revert on the next snapshot.
    const hasRemotePane = Object.values(mergedPtyIds).some(
      (ptyId) => typeof ptyId === 'string' && isRemoteRuntimePtyId(ptyId)
    )
    if (hasRemotePane) {
      remotePaneLayoutPusherRef.current?.push({ worktreeId, tabId, layout })
    }
    for (const leafId of currentLeafIds) {
      clearedScrollbackLeafIds.delete(leafId)
    }
  }, [tabId, setTabLayout, worktreeId])



  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const sanitized = sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab)
    if (sanitized !== savedLayout) {
      setTabLayout(tabId, sanitized)
    }
  }, [savedLayout, setTabLayout, tabId, terminalTab])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length !== 1) {
      return
    }
    const paneId = panes[0].id
    const currentTitle = paneTitlesRef.current[paneId]
    if (!currentTitle || !isSyntheticSinglePaneTitle(currentTitle, terminalTab)) {
      return
    }
    const nextTitles = { ...paneTitlesRef.current }
    delete nextTitles[paneId]
    paneTitlesRef.current = nextTitles
    setPaneTitles((prev) => {
      if (!prev[paneId] || !isSyntheticSinglePaneTitle(prev[paneId], terminalTab)) {
        return prev
      }
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    persistLayoutSnapshot()
  }, [paneCount, paneTitles, persistLayoutSnapshot, terminalTab])

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

  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    const state = useAppStore.getState()
    state.showRightSidebarSearch({ query: selectedText })
  }, [])

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

  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !restoredLayout.root) {
      return
    }
    // Why: host-owned split layouts (web / remote-server) arrive via snapshot, so the reconciler materializes their panes; local tabs split directly.
    if (
      !isHostAuthoritativeLayout({
        isWebClient: !!(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__,
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ) {
      return
    }
    const insertions = planTerminalLiveLayoutInsertions(
      restoredLayout.root,
      manager.getPanes().map((pane) => pane.leafId)
    )
    if (insertions.length === 0) {
      return
    }

    let appliedInsertion = false
    for (const insertion of insertions) {
      const ptyId = restoredLayout.ptyIdsByLeafId?.[insertion.newLeafId]
      const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
      if (!ptyId || sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId)) {
        continue
      }
      // Why: host split-pane snapshots for paired web terminals arrive after mount, so adopt the host leaf + PTY instead of spawning a local-only web pane.
      // Before-placement swaps [source, new] after splitPane, so invert the host first-child ratio for the temporary order.
      const splitRatio =
        insertion.ratio === undefined
          ? undefined
          : insertion.placement === 'before'
            ? 1 - insertion.ratio
            : insertion.ratio
      const createdPane = manager.splitPaneAroundLeafIds(
        insertion.sourceLeafIds,
        sourcePaneId,
        insertion.direction,
        {
          ...(splitRatio !== undefined && { ratio: splitRatio }),
          leafId: insertion.newLeafId,
          ptyId,
          placement: insertion.placement
        }
      )
      if (!createdPane) {
        continue
      }
      appliedInsertion = true
    }

    if (appliedInsertion) {
      persistLayoutSnapshot()
    }

    const activePaneId = restoredLayout.activeLeafId
      ? manager.getNumericIdForLeaf(restoredLayout.activeLeafId)
      : null
    const fallbackActivePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const nextActivePaneId = activePaneId ?? fallbackActivePaneId
    if (nextActivePaneId !== null) {
      manager.setActivePane(nextActivePaneId, { focus: isActive })
    }
  }, [isActive, paneCount, persistLayoutSnapshot, restoredLayout])

  // Activity-only isolation: when portaled into Activity for one agent pane, hide split siblings via a separate snapshot ref (independent of expand state).
  // useLayoutEffect so style writes land before paint (no flash); paneCount in deps re-applies after splits/closes.
  useLayoutEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    // Why: refit on rAF so xterm measures the post-layout DOM; both apply and restore paths must refit or xterm stays sized for the isolated single-pane geometry.
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          renameContainerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = renameContainerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        // Why: Activity requested an exact pane; if it can't be resolved, fail closed rather than show the whole split terminal.
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const frame = scheduleRefit()
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [isolatedPaneKey, paneCount, tabId])

  // Why: on unmount while isolation is active (e.g. tab closed mid-Activity), restore sibling display/flex so the captured DOM doesn't leak inline styles.
  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
  }, [])

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

  const clearPaneProcessExit = useCallback((paneId: number) => {
    setPaneProcessExitsByPaneId((current) => {
      if (current[paneId] === undefined) {
        return current
      }
      const next = { ...current }
      delete next[paneId]
      return next
    })
  }, [])

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

  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    applyTerminalPaneAttentionToManager(manager, tabId)
  }, [tabId])

  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])

  // Sync title reservation before paint so xterm fits below out-of-DOM banner chrome and never hides the first row.
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    // Reserve title space only for text/status chrome; chromeless controls float over xterm so untitled panes keep their first row.
    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: manager.getPanes(),
      paneTitles,
      renamingPaneId,
      sessionRestoredBannerPaneIds
    })
    if (needsFit && (isVisible || shouldMeasureHiddenStartup)) {
      // Why: fitting hidden geometry changes PTY rows and wakes TUIs via SIGWINCH; the visible resume path owns real layout correction.
      fitPanes(manager)
    }
  }, [
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup
  ])

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

  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const markPointerBlurIntent = (event: PointerEvent): void => {
      const input = renameInputRef.current
      const target = event.target
      if (input && target instanceof Node && input.contains(target)) {
        return
      }
      renameUserRequestedBlurCommitRef.current = true
    }
    const markKeyboardBlurIntent = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        renameUserRequestedBlurCommitRef.current = true
      }
    }

    document.addEventListener('pointerdown', markPointerBlurIntent, true)
    document.addEventListener('keydown', markKeyboardBlurIntent, true)
    return () => {
      document.removeEventListener('pointerdown', markPointerBlurIntent, true)
      document.removeEventListener('keydown', markKeyboardBlurIntent, true)
    }
  }, [renamingPaneId])

  const handleRenameSubmit = useCallback(() => {
    if (renamingPaneId === null || renameSubmittedRef.current) {
      return
    }
    renameSubmittedRef.current = true
    const trimmed = renameValue.trim()
    if (trimmed.length === 0) {
      if (paneTitlesRef.current[renamingPaneId]) {
        removePaneTitle(renamingPaneId)
      }
      closeRenameSession()
      setRenamingPaneId(null)
      return
    }
    setPaneTitles((prev) => ({ ...prev, [renamingPaneId]: trimmed }))
    // Eagerly update the ref so persistLayoutSnapshot sees the new title before React's next render.
    paneTitlesRef.current = { ...paneTitlesRef.current, [renamingPaneId]: trimmed }
    const leafId = managerRef.current?.getPanes().find((pane) => pane.id === renamingPaneId)?.leafId
    if (leafId) {
      removedTitleLeafIdsRef.current.delete(leafId)
    }
    closeRenameSession()
    setRenamingPaneId(null)
    // Persist immediately so the title survives restarts.
    persistLayoutSnapshot()
  }, [closeRenameSession, renamingPaneId, renameValue, removePaneTitle, persistLayoutSnapshot])

  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true
    closeRenameSession()
    setRenamingPaneId(null)
  }, [closeRenameSession])

  const handleRenameBlur = useCallback(() => {
    if (renameSubmittedRef.current) {
      return
    }
    if (renameBlurCommitEnabledRef.current && renameUserRequestedBlurCommitRef.current) {
      handleRenameSubmit()
      return
    }
    if (renamingPaneId === null || renameRefocusFrameRef.current !== null) {
      return
    }

    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    // Why: a delayed Radix/xterm focus handoff after context-menu selection fires a synthetic blur that isn't a title submission.
    renameRefocusFrameRef.current = requestAnimationFrame(() => {
      renameRefocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        renameBlurCommitEnabledRef.current = true
        return
      }
      input.focus()
      input.select()
      // Why: even if the OS refuses this focus, don't submit — synthetic focus loss isn't a title-commit signal.
      renameBlurCommitEnabledRef.current = true
    })
  }, [handleRenameSubmit, renamingPaneId])

  const handleRemoveTitle = useCallback(
    (paneId: number) => removePaneTitle(paneId),
    [removePaneTitle]
  )

  // Auto-focus/select-all the rename input on open and reset the submit guard for the new session.
  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    renameSubmittedRef.current = false
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
      renameEnableBlurFrameRef.current = requestAnimationFrame(() => {
        renameEnableBlurFrameRef.current = null
        if (
          renameSessionIdRef.current === sessionId &&
          renamingPaneId === paneId &&
          renameInputRef.current === input &&
          document.activeElement === input
        ) {
          renameBlurCommitEnabledRef.current = true
        }
      })
    })
    return () => cancelPendingRenameFrames()
  }, [cancelPendingRenameFrames, renamingPaneId])

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
  // A split can host different agents, so continuation resolves the specific leaf before using tab-wide hints.
  const resolveAgentForLeaf = (leafId: string | null): string | null => {
    const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
    if (detectedAgent) {
      return detectedAgent
    }
    return (
      nativeChatLaunchAgentForLeaf({
        launchAgent: terminalTab?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      }) ?? resolveTitleAgentForLeaf(leafId)
    )
  }
  const activePaneCanContinueInNewSession = canContinueAgentSessionInNewSession(
    resolveAgentForLeaf(activePane?.leafId ?? null)
  )
  const contextMenuCanContinueInNewSession = canContinueAgentSessionInNewSession(
    resolveAgentForLeaf(contextMenuLeafId)
  )
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
