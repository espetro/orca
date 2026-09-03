import { useEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  isTerminalBackgroundLight,
  normalizeColor,
  resolveOpaqueTerminalBackground,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  pruneSessionRestoredBannerPaneIds
} from './session-restored-banner-pane-state'
import { nativeChatLaunchAgentForLeaf } from '../native-chat/native-chat-send-eligibility'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneRenderPrepArgs = {
  tabId: string
  worktreeId: string
  renameContainerRef: React.MutableRefObject<HTMLDivElement | null>
  managerRef: React.MutableRefObject<PaneManager | null>
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  setSessionRestoredBannerPaneIds: (
    update: (prev: number[]) => number[]
  ) => void
  paneCount: number
  settings: GlobalSettings | null | undefined
  systemPrefersDark: boolean
  isVisible: boolean
  shouldMeasureHiddenStartup: boolean
  isActive: boolean
  sshReconnectTargetId: string | null | undefined
  sshReconnectStatus: string | null | undefined
  chatLeafId: string | null
  isChatViewMode: boolean
  structuredSessionAgent: string | null
  contextMenuLeafId: number | null
  getContextMenuCanContinueInNewSession: (leafId: number | null) => boolean
  resolveTitleAgentForLeaf: (leafId: string | null) => string | null
  getTabWideAgentHintLeafId: () => string | null
  getNativeChatLeafIds: () => string[]
  paneTitles: Record<number, string>
  contextMenuPaneId: number | null
  terminalTab: ReturnType<typeof getCachedTerminalTabForWorktree> | undefined
}

export function useTerminalPaneRenderPrep(args: UseTerminalPaneRenderPrepArgs) {
  const {
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
    contextMenuPaneId,
    terminalTab
  } = args

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
    contextMenuPaneId !== null && Boolean(paneTitles[contextMenuPaneId])
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

  return {
    effectiveAppearance,
    terminalBackground,
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
  }
}
