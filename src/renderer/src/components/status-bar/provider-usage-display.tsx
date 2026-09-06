import React from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import {
  getDisplayedUsagePercentage,
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { ProviderIcon, barColor, clampUsedPercent, getProviderUsageStatusLabel } from './tooltip'
import { getTightestUsageSection } from './UsageRosterPanel'

export function MiniBar({
  usedPct,
  display
}: {
  usedPct: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div
      data-usage-bar
      className="w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0"
    >
      <div
        className="h-full rounded-full transition-all duration-300 bg-muted-foreground/40"
        style={{ width: `${getDisplayedUsagePercentage(usedPct, display)}%` }}
      />
    </div>
  )
}

// Compact usage bars for inactive accounts in the switcher.
export function InlineUsageBars({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element {
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  // Why: tick the session countdown live via one boundary-scheduled clock, not just the usage poll (#5399).
  const now = useResetCountdownClock([limits.session?.resetsAt])
  const usageWindows = [
    limits.session
      ? {
          key: 'session',
          used: clampUsedPercent(limits.session.usedPercent),
          // Why: live reset countdown (matches popover); '5h' window length only when resetsAt is unknown (#5399).
          label: formatRateLimitWindowChipLabel(limits.session, now)
        }
      : null,
    limits.weekly
      ? {
          key: 'weekly',
          used: clampUsedPercent(limits.weekly.usedPercent),
          label: translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
        }
      : null,
    limits.fableWeekly
      ? {
          key: 'fableWeekly',
          used: clampUsedPercent(limits.fableWeekly.usedPercent),
          label: translate('auto.components.status.bar.StatusBar.54e8d6bb2d', 'Fable')
        }
      : null
  ].filter((window): window is { key: string; used: number; label: string } => window !== null)

  return (
    <div
      className={`grid w-full items-center gap-1.5 ${isFetching ? 'animate-pulse' : ''}`}
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, usageWindows.length)}, minmax(0, 1fr))`
      }}
    >
      {usageWindows.map((window) => (
        <div key={window.key} className="flex min-w-0 items-center gap-1">
          <div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
            <div
              className={`h-full rounded-full ${barColor(window.used)}`}
              style={{ width: `${getDisplayedUsagePercentage(window.used, display)}%` }}
            />
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatUsagePercentageLabel(window.used, display)} {window.label}
          </span>
        </div>
      ))}
      {usageWindows.length === 0 && limits.status === 'error' ? (
        <span className="text-[10px] text-muted-foreground">
          {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
        </span>
      ) : null}
    </div>
  )
}

export function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return limits?.status === 'error' && !limits.session && !limits.weekly && !limits.fableWeekly
}

export function InlineUsageSignInAction({
  isFetching,
  isSigningIn,
  disabled,
  onSignInPointerDown,
  onSignIn
}: {
  isFetching: boolean
  isSigningIn: boolean
  disabled: boolean
  onSignInPointerDown?: () => void
  onSignIn: () => void
}): React.JSX.Element {
  return (
    <div className={`flex w-full items-center gap-2 ${isFetching ? 'animate-pulse' : ''}`}>
      <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        className="h-6 shrink-0 px-2 text-muted-foreground hover:text-foreground"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignInPointerDown?.()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignIn()
        }}
      >
        {isSigningIn ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
      </Button>
    </div>
  )
}

export function InlineUsageSkeleton(): React.JSX.Element {
  return (
    <div className="flex w-full animate-pulse items-center gap-2">
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
    </div>
  )
}

export function WindowLabel({
  w,
  label,
  display,
  showLabel = true
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
}): React.JSX.Element {
  return (
    <span className="tabular-nums">
      {formatUsagePercentageLabel(w.usedPercent, display)}
      {showLabel ? ` ${label}` : ''}
    </span>
  )
}

// Single-letter provider badge for the icon-only (narrow) status bar. Shared by
// the roster trigger and ProviderDetailsMenu so the dot's has-data condition
// and markup can't drift between the two.
export function ProviderLetterBadge({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  const hasData = Boolean(p.session || p.weekly || p.fableWeekly || p.monthly || p.buckets?.length)
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span
        className={`inline-block h-2 w-2 rounded-full ${hasData ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
      />
      {getProviderLetter(p.provider)}
    </span>
  )
}

function getProviderLetter(provider: ProviderRateLimits['provider']): string {
  switch (provider) {
    case 'claude':
      return 'C'
    case 'gemini':
      return 'G'
    case 'opencode-go':
      return 'O'
    case 'kimi':
      return 'K'
    case 'antigravity':
      return 'A'
    case 'minimax':
      return 'M'
    case 'grok':
      return 'R'
    case 'codex':
      return 'X'
  }
}
// Why: Gemini exposes extra experimental buckets that made the pre-existing verbose footer noisy.
const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

function VerboseProviderUsage({
  p,
  display
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
}): React.JSX.Element {
  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets = p.buckets.filter((bucket) => STATUS_BAR_BUCKET_NAMES.has(bucket.name))
    return (
      <>
        {visibleBuckets.map((bucket, index) => (
          <React.Fragment key={bucket.name}>
            {index > 0 ? <span className="text-muted-foreground">·</span> : null}
            <span className="tabular-nums">
              {bucket.name} {formatUsagePercentageLabel(bucket.usedPercent, display)}
            </span>
          </React.Fragment>
        ))}
        {visibleBuckets.length === 0 && p.session ? (
          <WindowLabel
            w={p.session}
            label={formatRateLimitWindowChipLabel(p.session)}
            display={display}
          />
        ) : null}
      </>
    )
  }

  const visibleWindows = [
    p.session
      ? {
          key: 'session',
          window: p.session,
          label: formatRateLimitWindowChipLabel(p.session)
        }
      : null,
    p.weekly
      ? {
          key: 'weekly',
          window: p.weekly,
          label: formatRateLimitWindowChipLabel(p.weekly)
        }
      : null,
    p.fableWeekly
      ? {
          key: 'fableWeekly',
          window: p.fableWeekly,
          label: translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        }
      : null,
    // Why: monthly stays inline for monthly-only providers; otherwise the detail panel carries it.
    p.monthly && !p.session && !p.weekly
      ? {
          key: 'monthly',
          window: p.monthly,
          label: formatRateLimitWindowChipLabel(p.monthly)
        }
      : null
  ].filter((window): window is { key: string; window: RateLimitWindow; label: string } => {
    return window !== null
  })

  return (
    <>
      {visibleWindows.map((window, index) => (
        <React.Fragment key={window.key}>
          {index > 0 ? <span className="text-muted-foreground">·</span> : null}
          <WindowLabel w={window.window} label={window.label} display={display} />
        </React.Fragment>
      ))}
    </>
  )
}

export function ProviderSegment({
  p,
  compact,
  display,
  mode = 'verbose'
}: {
  p: ProviderRateLimits | null
  compact: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  const statusLabel = p ? getProviderUsageStatusLabel(p) : ''

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  const tightest = getTightestUsageSection(p)

  // Fetching with no prior data
  if (p.status === 'fetching' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (p.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50">
        <ProviderIcon provider={provider} /> --
      </span>
    )
  }

  // Error with no data
  if (p.status === 'error' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <AlertTriangle size={11} className="text-muted-foreground/80" />
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = p.status === 'error'

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {mode === 'verbose' ? (
        <>
          {tightest && !compact ? (
            <MiniBar usedPct={clampUsedPercent(tightest.window.usedPercent)} display={display} />
          ) : null}
          <VerboseProviderUsage p={p} display={display} />
        </>
      ) : tightest ? (
        <WindowLabel
          w={tightest.window}
          label={tightest.label}
          display={display}
          showLabel={!compact}
        />
      ) : null}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}
