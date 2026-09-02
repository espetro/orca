import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import '@xterm/xterm/css/xterm.css'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { buildFontFamily } from '@/components/terminal-pane/layout-serialization'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { clampNumber, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { PREVIEW_BUFFER } from './terminal-preview-content'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why: pinned so PREVIEW_BUFFER never wraps; 36 cols fits the 32-char longest line + margin.
const PREVIEW_COLS = 36
const PREVIEW_ROWS = 15

// Why: color-only stub pane; 40px is wide enough to read inactive-pane opacity dim.
const STUB_PANE_PX = 40

export type PreviewMode = 'dark' | 'light'

export type TerminalSettingsTerminalViewProps = {
  settings: GlobalSettings
  systemPrefersDark: boolean
  previewFontFamily?: string | null
  effectiveMode: PreviewMode
  previewPaneDividerVisible: boolean
}

export function TerminalSettingsTerminalView({
  settings,
  systemPrefersDark,
  previewFontFamily,
  effectiveMode,
  previewPaneDividerVisible
}: TerminalSettingsTerminalViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const ligaturesAddonRef = useRef<LigaturesAddon | null>(null)
  const skipInitialOptionMutationRef = useRef(false)
  const skipInitialThemeRewriteRef = useRef(false)

  const effectiveFontFamily = previewFontFamily || settings.terminalFontFamily
  const terminalLineHeight = normalizeTerminalLineHeight(settings.terminalLineHeight)

  const appearance = useMemo(
    () =>
      resolveEffectiveTerminalAppearance({ ...settings, theme: effectiveMode }, systemPrefersDark),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      effectiveMode,
      settings.terminalThemeDark,
      settings.terminalThemeLight,
      settings.terminalCustomThemes,
      settings.terminalUseSeparateLightTheme,
      settings.terminalDividerColorDark,
      settings.terminalDividerColorLight,
      systemPrefersDark
    ]
  )

  const composedTheme = useMemo(
    () => composeActiveTerminalTheme(appearance.theme, settings),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      appearance,
      settings.terminalColorOverrides,
      settings.terminalBackgroundOpacity,
      settings.terminalCursorOpacity
    ]
  )

  const dividerThicknessPx = clampNumber(settings.terminalDividerThicknessPx, 1, 32)
  const inactivePaneOpacity = clampNumber(settings.terminalInactivePaneOpacity, 0, 1)
  const paneBackground = composedTheme?.background ?? '#000'

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const weights = resolveTerminalFontWeights(
      settings.terminalFontWeight,
      settings.terminalFontWeightBold
    )
    skipInitialOptionMutationRef.current = true
    skipInitialThemeRewriteRef.current = true
    const terminal = new Terminal({
      ...buildDefaultTerminalOptions(),
      disableStdin: true,
      cursorInactiveStyle: settings.terminalCursorStyle,
      cursorStyle: settings.terminalCursorStyle,
      cursorBlink: settings.terminalCursorBlink,
      fontSize: settings.terminalFontSize,
      fontFamily: buildFontFamily(effectiveFontFamily),
      fontWeight: weights.fontWeight,
      fontWeightBold: weights.fontWeightBold,
      lineHeight: terminalLineHeight,
      theme: composedTheme ?? undefined,
      allowTransparency:
        settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1,
      cols: PREVIEW_COLS,
      rows: PREVIEW_ROWS
    })
    terminalRef.current = terminal

    try {
      terminal.open(container)
      terminal.write(PREVIEW_BUFFER)
    } catch (err) {
      terminalRef.current = null
      terminal.dispose()
      throw err
    }

    return () => {
      ligaturesAddonRef.current?.dispose()
      ligaturesAddonRef.current = null
      terminal.dispose()
      terminalRef.current = null
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    if (skipInitialOptionMutationRef.current) {
      skipInitialOptionMutationRef.current = false
      return
    }
    const weights = resolveTerminalFontWeights(
      settings.terminalFontWeight,
      settings.terminalFontWeightBold
    )
    terminal.options.fontSize = settings.terminalFontSize
    terminal.options.fontFamily = buildFontFamily(effectiveFontFamily)
    terminal.options.fontWeight = weights.fontWeight
    terminal.options.fontWeightBold = weights.fontWeightBold
    terminal.options.lineHeight = terminalLineHeight
    terminal.options.cursorStyle = settings.terminalCursorStyle
    terminal.options.cursorInactiveStyle = settings.terminalCursorStyle
    terminal.options.cursorBlink = settings.terminalCursorBlink
  }, [
    settings.terminalFontSize,
    settings.terminalFontWeightBold,
    effectiveFontFamily,
    settings.terminalFontWeight,
    terminalLineHeight,
    settings.terminalCursorStyle,
    settings.terminalCursorBlink
  ])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !composedTheme) {
      return
    }
    terminal.options.theme = composedTheme
    terminal.options.minimumContrastRatio = resolveTerminalMinimumContrastRatio(
      composedTheme.background,
      effectiveMode
    )
    terminal.options.allowTransparency =
      settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
    if (skipInitialThemeRewriteRef.current) {
      skipInitialThemeRewriteRef.current = false
      return
    }
    terminal.reset()
    terminal.write(PREVIEW_BUFFER)
  }, [composedTheme, effectiveMode, settings.terminalBackgroundOpacity])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    const enabled = resolveTerminalLigaturesEnabled(settings.terminalLigatures, effectiveFontFamily)
    const current = ligaturesAddonRef.current
    if (enabled && !current) {
      const addon = new LigaturesAddon()
      try {
        terminal.loadAddon(addon)
        ligaturesAddonRef.current = addon
        terminal.refresh(0, terminal.rows - 1)
      } catch (err) {
        addon.dispose()
        console.warn('[settings preview] ligatures addon failed to attach', err)
        ligaturesAddonRef.current = null
      }
    } else if (!enabled && current) {
      current.dispose()
      ligaturesAddonRef.current = null
    }
  }, [settings.terminalLigatures, effectiveFontFamily])

  return (
    <div className="flex h-[300px] flex-col overflow-hidden rounded-md border border-border/50">
      <div className="flex min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        <div
          ref={containerRef}
          className="min-w-0 flex-1 overflow-hidden p-2"
          style={{ backgroundColor: paneBackground }}
          tabIndex={-1}
        />
        {previewPaneDividerVisible ? (
          <div
            className="shrink-0"
            style={{
              width: `${dividerThicknessPx}px`,
              backgroundColor: appearance.dividerColor
            }}
          />
        ) : null}
        <div
          className="shrink-0"
          style={{
            width: `${STUB_PANE_PX}px`,
            backgroundColor: paneBackground,
            opacity: inactivePaneOpacity
          }}
        />
      </div>
    </div>
  )
}

export default TerminalSettingsTerminalView
