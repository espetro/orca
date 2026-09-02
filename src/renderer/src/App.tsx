import { Suspense, useCallback, useEffect } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from './components/confirmation-dialog'
import { lazyWithRetry } from '@/lib/lazy-with-retry'

const BrowserWebAuthnAccountDialog = lazyWithRetry(() =>
  import('./components/browser-webauthn-account-dialog').then((m) => ({
    default: m.BrowserWebAuthnAccountDialog
  }))
)
const DocPreviewExternalLinkConfirmation = lazyWithRetry(() =>
  import('./components/browser-pane/workspace-doc/doc-preview-external-link-confirmation').then(
    (m) => ({ default: m.DocPreviewExternalLinkConfirmation })
  )
)
const LinkRoutingPreferenceDialogProvider = lazyWithRetry(() =>
  import('./components/link-routing-preference-dialog').then((m) => ({
    default: m.LinkRoutingPreferenceDialogProvider
  }))
)
const SkillFreshnessNudge = lazyWithRetry(() =>
  import('./components/skills/SkillFreshnessNudge').then((m) => ({
    default: m.SkillFreshnessNudge
  }))
)
const PinnedTabCloseDialog = lazyWithRetry(
  () => import('./components/terminal-pane/PinnedTabCloseDialog')
)
const RunningTerminalCloseDialog = lazyWithRetry(
  () => import('./components/terminal-pane/RunningTerminalCloseDialog')
)
const WorktreeBaseFallbackDialog = lazyWithRetry(
  () => import('./components/WorktreeBaseFallbackDialog')
)
import { useUnreadDockBadge } from './hooks/useUnreadDockBadge'
import { AppBackgroundServices } from './app-shell/AppBackgroundServices'
import { AppRootSurfaces } from './app-shell/AppRootSurfaces'
import { AppWorkspaceShell } from './app-shell/AppWorkspaceShell'
import { WindowControls } from './app-shell/WindowControls'
import {
  MAC_TRAFFIC_LIGHTS_WIDTH,
  WINDOW_CONTROLS_HEIGHT,
  WINDOW_CONTROLS_WIDTH,
  hasCustomTitleBar
} from './app-shell/app-window-chrome'
import { useAppChromeLayout } from './app-shell/use-app-chrome-layout'
import { useAppSessionPersistence } from './app-shell/use-app-session-persistence'
import { useAppShellServices } from './app-shell/use-app-shell-services'
import { useAppStartupHydration } from './app-shell/use-app-startup-hydration'
import { useDocumentAppearance } from './app-shell/use-document-appearance'
import { useFloatingWorkspacePanel } from './app-shell/use-floating-workspace-panel'
import { useGlobalKeybindings } from './app-shell/use-global-keybindings'
import { useOnboardingAndFeatureTips } from './app-shell/use-onboarding-and-feature-tips'
import { usePersistedUIWriter } from './app-shell/use-persisted-ui-writer'
import { useRuntimeGraphSync } from './app-shell/use-runtime-graph-sync'
import { useWindowVisibilityEffects } from './app-shell/use-window-visibility-effects'

function App(): React.JSX.Element {
  const layout = useAppChromeLayout()
  const floatingWorkspace = useFloatingWorkspacePanel()
  const onboardingGate = useOnboardingAndFeatureTips()
  const clearUnreadDockBadge = useUnreadDockBadge()

  // Why enabled && open: the overlay only renders while the feature is on, and its panel is
  // aria-hidden while closed — so that pair is what "on screen" means for the floating workspace.
  useAppShellServices({
    floatingPanelVisible: floatingWorkspace.enabled && floatingWorkspace.open
  })
  useAppStartupHydration(onboardingGate.applyStartupOnboardingState)
  useAppSessionPersistence()
  useRuntimeGraphSync()
  usePersistedUIWriter()
  useDocumentAppearance()
  useWindowVisibilityEffects()
  useGlobalKeybindings({ layout, floatingWorkspace })

  // Why: the same vars are set inline on .app-layout below, but portaled surfaces
  // (sheets, dialogs) mount outside it and would otherwise fall back to 0px and
  // render their controls under the Windows/Linux window-controls overlay.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--window-controls-width', WINDOW_CONTROLS_WIDTH)
    root.setProperty('--window-controls-height', WINDOW_CONTROLS_HEIGHT)
    root.setProperty('--mac-traffic-lights-width', MAC_TRAFFIC_LIGHTS_WIDTH)
  }, [])

  const { cancelReturnFocusFrame } = floatingWorkspace
  const setAppRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: these best-effort App chrome cleanups share the App root lifetime.
      if (!node) {
        cancelReturnFocusFrame()
        clearUnreadDockBadge()
      }
    },
    [cancelReturnFocusFrame, clearUnreadDockBadge]
  )

  return (
    <div
      ref={setAppRootNode}
      className="app-layout"
      style={
        {
          '--collapsed-sidebar-header-width': `${layout.collapsedSidebarHeaderWidth}px`,
          // Shared so surfaces can avoid the Windows/Linux window-controls overlay without hardcoding 138px everywhere.
          '--window-controls-width': WINDOW_CONTROLS_WIDTH,
          // Side-position activity bar uses this to push icons below the Windows/Linux window-controls overlay.
          '--window-controls-height': WINDOW_CONTROLS_HEIGHT,
          // Full-bleed surfaces use this to keep the macOS traffic lights uncovered.
          '--mac-traffic-lights-width': MAC_TRAFFIC_LIGHTS_WIDTH
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        <ConfirmationDialogProvider>
          <Suspense fallback={null}>
            <DocPreviewExternalLinkConfirmation />
            <LinkRoutingPreferenceDialogProvider>
              <AppBackgroundServices />
              <AppWorkspaceShell layout={layout} floatingWorkspace={floatingWorkspace} />
              <AppRootSurfaces
                floatingWorkspace={floatingWorkspace}
                onboardingGate={onboardingGate}
              />
              <BrowserWebAuthnAccountDialog />
            </LinkRoutingPreferenceDialogProvider>
          </Suspense>
        </ConfirmationDialogProvider>
      </TooltipProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <Suspense fallback={null}>
        <SkillFreshnessNudge />
        <WorktreeBaseFallbackDialog />
        <PinnedTabCloseDialog />
        <RunningTerminalCloseDialog />
      </Suspense>
      {/* Why: Electron's drag-region hit-test is DOM-order-based (ignores z-index); render last so WindowControls stay clickable. */}
      {hasCustomTitleBar && <WindowControls />}
    </div>
  )
}

export default App
