import { Suspense, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingsSwitch } from './SettingsFormControls'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { lazyWithRetry } from '@/lib/lazy-with-retry'

const TerminalSettingsTerminalView = lazyWithRetry(() => import('./TerminalSettingsTerminalView'))

type PreviewMode = 'dark' | 'light'

type TerminalSettingsPreviewProps = {
  title: string
  description?: string
  settings: GlobalSettings
  systemPrefersDark: boolean
  /** Override for `settings.terminalFontFamily`; set by the font picker on hover to preview a font before committing. */
  previewFontFamily?: string | null
  /** Force the preview into this mode regardless of app settings; hides the in-header theme toggle when set. */
  modeOverride?: PreviewMode
  /** Render a Moon/Sun header toggle to flip the preview theme without changing the app theme. Ignored when `modeOverride` is set. */
  showThemeToggle?: boolean
}

function resolveAppMode(
  settings: Pick<GlobalSettings, 'theme'>,
  systemPrefersDark: boolean
): PreviewMode {
  if (settings.theme === 'system') {
    return systemPrefersDark ? 'dark' : 'light'
  }
  return settings.theme
}

export function TerminalSettingsPreview({
  title,
  description,
  settings,
  systemPrefersDark,
  previewFontFamily,
  modeOverride,
  showThemeToggle
}: TerminalSettingsPreviewProps): React.JSX.Element {
  // Why: lazy-init from the active app theme; after mount the toggle is independent of later app-theme changes.
  const [togglePreviewMode, setTogglePreviewMode] = useState<PreviewMode>(() =>
    resolveAppMode(settings, systemPrefersDark)
  )
  const [previewPaneDividerVisible, setPreviewPaneDividerVisible] = useState(false)

  // Why: recomputed each render so plain previews (no override/toggle) track live app-theme changes.
  const effectiveMode: PreviewMode =
    modeOverride ??
    (showThemeToggle ? togglePreviewMode : resolveAppMode(settings, systemPrefersDark))

  const showToggle = showThemeToggle && modeOverride === undefined

  return (
    <Card className="gap-4 overflow-hidden py-0">
      <CardHeader className="gap-0 border-b border-border/50 px-4 py-3 !pb-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1">
              <span className="text-xs font-medium text-muted-foreground">
                {translate(
                  'auto.components.settings.TerminalSettingsPreview.50419052fe',
                  'Pane divider'
                )}
              </span>
              <SettingsSwitch
                checked={previewPaneDividerVisible}
                onChange={() => setPreviewPaneDividerVisible((visible) => !visible)}
                ariaLabel={translate(
                  'auto.components.settings.TerminalSettingsPreview.f8931d407d',
                  'Show pane divider in preview'
                )}
              />
            </div>
            {showToggle ? (
              <div
                className="flex gap-0.5 rounded-md border border-border/50 p-0.5"
                role="group"
                aria-label={translate(
                  'auto.components.settings.TerminalSettingsPreview.2c248fcc27',
                  'Preview theme'
                )}
              >
                {(['dark', 'light'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTogglePreviewMode(mode)}
                    aria-pressed={togglePreviewMode === mode}
                    aria-label={translate(
                      'auto.components.settings.TerminalSettingsPreview.a63953a48a',
                      'Preview {{value0}} theme',
                      { value0: mode }
                    )}
                    title={translate(
                      'auto.components.settings.TerminalSettingsPreview.a63953a48a',
                      'Preview {{value0}} theme',
                      { value0: mode }
                    )}
                    className={`rounded-sm p-1 transition-colors ${
                      togglePreviewMode === mode
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {mode === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {/* Why: stub pane on the right keeps inactive-pane opacity visible; divider is opt-in to keep the default preview clean. */}
        <Suspense
          fallback={
            <div className="flex h-[300px] flex-col overflow-hidden rounded-md border border-border/50 bg-background/50" />
          }
        >
          <TerminalSettingsTerminalView
            settings={settings}
            systemPrefersDark={systemPrefersDark}
            previewFontFamily={previewFontFamily}
            effectiveMode={effectiveMode}
            previewPaneDividerVisible={previewPaneDividerVisible}
          />
        </Suspense>
      </CardContent>
    </Card>
  )
}
