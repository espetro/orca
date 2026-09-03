import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import type { PaneExternalDropTarget, PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import {
  closeTerminalLinkActionRequest,
  type TerminalLinkActionRequest
} from './terminal-link-action-request'

type Args = {
  tabId: string
  worktreeId: string
  managerRef: React.MutableRefObject<PaneManager | null>
  paneTransportsRef: React.MutableRefObject<Map<number, { getPtyId: () => string | null }>>
  isActive: boolean
  isRendererVisible: boolean
  paneLayoutRevision: number
  settings: { openLinksInApp?: boolean; openLinksInAppPreferencePrompted?: boolean } | null
  setTerminalLinkActionRequest: React.Dispatch<
    React.SetStateAction<TerminalLinkActionRequest | null>
  >
  persistLayoutSnapshot: () => void
}

type Result = {
  requestTerminalLinkAction: (request: TerminalLinkActionRequest) => void
  closeTerminalLinkActions: (dismissed?: TerminalLinkActionRequest) => void
  requestOpenLinksInAppPreference: (url: string) => Promise<boolean> | null
  resolveExternalPaneDropTarget: (args: {
    sourcePaneId: number
    clientX: number
    clientY: number
  }) => PaneExternalDropTarget | null
  handleExternalPaneDrop: (sourcePaneId: number, target: PaneExternalDropTarget) => boolean
}

export function useTerminalPaneLinkRouting({
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
}: Args): Result {
  const updateSettings = useAppStore((store) => store.updateSettings)
  const requestLinkRoutingPreference = useLinkRoutingPreferenceDialog()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const openLinksInAppPreferencePromiseRef = useRef<Promise<boolean> | null>(null)

  const requestTerminalLinkAction = useCallback((request: TerminalLinkActionRequest) => {
    setTerminalLinkActionRequest(request)
  }, [setTerminalLinkActionRequest])

  const closeTerminalLinkActions = useCallback((dismissed?: TerminalLinkActionRequest) => {
    setTerminalLinkActionRequest((current) => closeTerminalLinkActionRequest(current, dismissed))
  }, [setTerminalLinkActionRequest])

  const requestOpenLinksInAppPreference = useCallback(
    (url: string): Promise<boolean> | null => {
      if (settingsRef.current?.openLinksInAppPreferencePrompted === true) {
        return null
      }
      if (!settingsRef.current) {
        return null
      }
      if (openLinksInAppPreferencePromiseRef.current) {
        return openLinksInAppPreferencePromiseRef.current
      }
      const preferencePromise = (async () => {
        const openInOrca = await requestLinkRoutingPreference({
          openLinksInAppDefault: settingsRef.current?.openLinksInApp === true,
          url
        })
        await updateSettings({
          openLinksInApp: openInOrca,
          openLinksInAppPreferencePrompted: true
        })
        return openInOrca
      })()
      openLinksInAppPreferencePromiseRef.current = preferencePromise
      void preferencePromise.finally(() => {
        openLinksInAppPreferencePromiseRef.current = null
      })
      return preferencePromise
    },
    [requestLinkRoutingPreference, updateSettings]
  )

  const resolveExternalPaneDropTarget = useCallback(
    ({
      sourcePaneId,
      clientX,
      clientY
    }: {
      sourcePaneId: number
      clientX: number
      clientY: number
    }): PaneExternalDropTarget | null => {
      const manager = managerRef.current
      const panes = manager?.getPanes() ?? []
      if (panes.length <= 1 || !panes.some((pane) => pane.id === sourcePaneId)) {
        return null
      }
      return resolveTerminalTabStripDropTarget({
        clientX,
        clientY,
        groupsByWorktree: useAppStore.getState().groupsByWorktree,
        worktreeId
      })
    },
    [worktreeId]
  )

  const handleExternalPaneDrop = useCallback(
    (sourcePaneId: number, target: PaneExternalDropTarget): boolean => {
      if (!isTerminalTabStripDropTarget(target)) {
        return false
      }
      const fallbackPtyId = paneTransportsRef.current.get(sourcePaneId)?.getPtyId() ?? null
      return (
        detachTerminalPaneToTab({
          fallbackPtyId,
          getStore: useAppStore.getState,
          manager: managerRef.current,
          persistLayoutSnapshot,
          sourcePaneId,
          sourceTabId: tabId,
          targetGroupId: target.groupId,
          targetIndex: target.insertionIndex,
          worktreeId
        }) !== null
      )
    },
    [persistLayoutSnapshot, tabId, worktreeId]
  )

  useEffect(() => {
    closeTerminalLinkActions()
  }, [closeTerminalLinkActions, isActive, isRendererVisible, paneLayoutRevision])

  return {
    requestTerminalLinkAction,
    closeTerminalLinkActions,
    requestOpenLinksInAppPreference,
    resolveExternalPaneDropTarget,
    handleExternalPaneDrop
  }
}
