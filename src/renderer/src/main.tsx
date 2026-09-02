// Why first, and why the import-free shim: react-dom reads
// __REACT_DEVTOOLS_GLOBAL_HOOK__ once at module evaluation, so the global has to
// exist before it. The observer below only wraps a property react-dom re-reads
// per commit, so its own import graph can evaluate whenever it likes.
import './lib/react-devtools-commit-hook-shim'
import './lib/react-commit-cascade-observer'
import './assets/main.css'

import { StrictMode, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import App from './App'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  installRendererCrashDiagnostics,
  recordRendererCrashBreadcrumb
} from './lib/crash-diagnostics'
import { shouldEnableReactGrab } from './lib/react-grab-dev-gate'
import { I18nProvider } from './i18n/I18nProvider'
import { translate } from './i18n/i18n'
import { getOrCreateRendererRoot } from './lib/react-renderer-root'
import { lazyWithRetry } from './lib/lazy-with-retry'

const SkillWarningPreviewLauncher = lazyWithRetry(() =>
  import('./components/skills/SkillWarningPreviewLauncher').then((m) => ({
    default: m.SkillWarningPreviewLauncher
  }))
)

recordRendererCrashBreadcrumb('renderer_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics()

if (
  import.meta.env.DEV &&
  shouldEnableReactGrab({
    dev: import.meta.env.DEV,
    enableFlag: import.meta.env.VITE_ENABLE_REACT_GRAB
  })
) {
  void import('react-grab').then(({ init }) => init())
  void import('react-grab/styles.css')
}

// Why: instant pre-paint theme class prevents white flash before full theme engine loads.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  document.documentElement.classList.toggle(
    'dark',
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  document.documentElement.classList.toggle(
    'light',
    !window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

const schedulePostPaint = (callback: () => void): void => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback)
  } else if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(callback, 0))
  } else {
    setTimeout(callback, 0)
  }
}

schedulePostPaint(() => {
  void import('./lib/document-theme').then(({ applyDocumentTheme }) => {
    applyDocumentTheme('system', { disableTransitions: false })
  })
  void import('./lib/typing-latency-diagnostic').then(({ installTypingLatencyDiagnostic }) => {
    installTypingLatencyDiagnostic()
  })
  void import('./components/automations/automation-host-diagnostics').then(
    ({ installAutomationHostDiagnostic }) => {
      installAutomationHostDiagnostic()
    }
  )
  void import('./lib/resource-e2e-bridge').then(({ installResourceE2EBridge }) => {
    installResourceE2EBridge()
  })
  void import('./components/browser-pane/browser-client-page-renderer-installation').then(
    ({ installBrowserClientPageRenderer }) => {
      const browserClientPageRenderer = installBrowserClientPageRenderer()
      import.meta.hot?.dispose(() => browserClientPageRenderer?.dispose())
    }
  )
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('renderer_root_missing')
  throw new Error('Renderer root element not found.')
}

function RendererRoot(): React.JSX.Element {
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title={translate('app.recoverableError.rootTitle', 'Orca hit a renderer error.')}
      description={translate(
        'app.recoverableError.rootDescription',
        'The app shell could not finish rendering. Retry to remount it, or relaunch Orca if the error persists.'
      )}
    >
      <App />
      <Suspense fallback={null}>
        <SkillWarningPreviewLauncher />
      </Suspense>
    </RecoverableRenderErrorBoundary>
  )
}

getOrCreateRendererRoot(rootElement, import.meta.hot?.data).render(
  <StrictMode>
    <I18nProvider>
      <RendererRoot />
    </I18nProvider>
  </StrictMode>
)
recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')
