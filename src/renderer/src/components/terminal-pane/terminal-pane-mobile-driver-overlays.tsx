import { createPortal } from 'react-dom'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { shouldChatTakeOverMobileSurface } from '../native-chat/native-chat-send-eligibility'

type TerminalPaneMobileDriverOverlaysProps = {
  panes: ManagedPane[]
  paneTransportsRef: React.MutableRefObject<Map<number, PtyTransport>>
  isChatViewMode: boolean
  chatLeafId: string | null
  onRestorePaneTerminalFit: (pane: ManagedPane, ptyId: string) => void | Promise<void>
  onRestoreAllTerminalFits: (pane: ManagedPane) => void | Promise<void>
}

/** Portals one mobile driver/presence-lock banner per pane that has a mobile driver or phone-fit override. */
export function TerminalPaneMobileDriverOverlays({
  panes,
  paneTransportsRef,
  isChatViewMode,
  chatLeafId,
  onRestorePaneTerminalFit,
  onRestoreAllTerminalFits
}: TerminalPaneMobileDriverOverlaysProps): (React.JSX.Element | null)[] {
  return panes.map((pane) => {
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
    const paneSurface = isChatViewMode && pane.leafId === chatLeafId ? 'chat' : 'terminal'
    if (shouldChatTakeOverMobileSurface(paneSurface)) {
      return null
    }
    return createPortal(
      <MobileDriverOverlay
        key={`mobile-driver-${pane.id}-${ptyId}`}
        driver={driver}
        hasFitOverride={hasFitOverride}
        rootClassName="mobile-driver-banner"
        onAction={() => onRestorePaneTerminalFit(pane, ptyId)}
        onAllAction={() => onRestoreAllTerminalFits(pane)}
      />,
      pane.container,
      `mobile-driver-banner-${pane.id}`
    )
  })
}
