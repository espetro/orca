import React, { useLayoutEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import type { MatchRange } from '@/lib/worktree-palette-search'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId,
  resolveComposerGitRepoId
} from '@/lib/new-workspace-composer-repo'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import type { useAppStore } from '@/store'
import type { PaletteListEntry } from '../WorktreeJumpPalette'

export function PaletteRowShortcutBadge({
  index,
  modifierKeys
}: {
  index: number | undefined
  modifierKeys: readonly string[]
}): React.JSX.Element | null {
  if (index === undefined || modifierKeys.length === 0) {
    return null
  }
  return (
    <ShortcutKeyCombo
      keys={[...modifierKeys, String(index + 1)]}
      className="inline-flex gap-0.5"
      keyCapClassName="min-w-4 border-border/60 bg-background/45 px-1 py-px text-[9px] text-muted-foreground/88 shadow-none"
      separatorClassName="text-[9px] text-muted-foreground/60"
    />
  )
}

export function getComposerPrefetchRepoId(
  state: ReturnType<typeof useAppStore.getState>,
  initialRepoId?: string
): string | null {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  return resolveComposerGitRepoId({
    eligibleRepos,
    initialRepoId,
    activeRepoId: resolveComposerActiveRepoId(state.repos, eligibleRepos, state.activeRepoId),
    focusedHostScope: state.workspaceHostScope
  })
}

export function getComposerDefaultWorkspaceTarget(state: ReturnType<typeof useAppStore.getState>) {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  const activeRepoId = resolveComposerActiveRepoId(state.repos, eligibleRepos, state.activeRepoId)
  const resolution = resolveWorkspaceCreationTarget({
    eligibleRepos,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups,
    activeRepoId,
    focusedHostScope: state.workspaceHostScope
  })
  return resolution.status === 'ready' ? resolution.target : null
}

export function appendPaletteListEntries(
  target: PaletteListEntry[],
  source: readonly PaletteListEntry[]
): void {
  // Why: source can be large enough to hit the argument limit of push(...source).
  for (const entry of source) {
    target.push(entry)
  }
}

/** Multi-keyword matches highlight every covered range; ranges arrive sorted and disjoint. */
export function HighlightedText({
  text,
  matchRanges
}: {
  text: string
  matchRanges: readonly MatchRange[]
}): React.JSX.Element {
  const ranges = matchRanges
  if (!ranges.length) {
    return <>{text}</>
  }
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(cursor, range.start)
    if (start >= range.end) {
      continue
    }
    parts.push(text.slice(cursor, start))
    parts.push(
      <span key={`${range.start}-${range.end}`} className="font-semibold text-foreground">
        {text.slice(start, range.end)}
      </span>
    )
    cursor = range.end
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}

export function PaletteOpenTabPrimaryLine({
  title,
  titleRanges,
  secondaryText,
  secondaryRanges,
  sessionAge,
  leadingBadges
}: {
  title: string
  titleRanges: readonly MatchRange[]
  secondaryText: string
  secondaryRanges: readonly MatchRange[]
  sessionAge?: string
  leadingBadges?: React.ReactNode
}): React.JSX.Element {
  // Why gate on non-empty: empty secondaries (terminals/simulators) used to still
  // render a leftover "·" after the title.
  const showSecondary = secondaryText.trim().length > 0

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <span
        data-slot="palette-open-tab-title"
        className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground"
      >
        <HighlightedText text={title} matchRanges={titleRanges} />
      </span>
      {sessionAge ? (
        <span
          aria-label={translate(
            'auto.components.WorktreeJumpPalette.lastActiveTime',
            'Last active {{value0}} ago',
            { value0: sessionAge }
          )}
          className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70"
        >
          {sessionAge}
        </span>
      ) : null}
      {leadingBadges}
      {showSecondary ? (
        <>
          <span className="shrink-0 text-muted-foreground/45">·</span>
          <span className="min-w-0 max-w-[34%] truncate text-[12px] font-medium text-muted-foreground/92">
            <HighlightedText text={secondaryText} matchRanges={secondaryRanges} />
          </span>
        </>
      ) : null}
    </div>
  )
}

function resolveOpenTabWorktreeRailTooltip({
  isBranch,
  truncated,
  name
}: {
  isBranch: boolean
  truncated: boolean
  name: string
}): string {
  if (truncated) {
    return name
  }
  return isBranch
    ? translate('auto.components.WorktreeJumpPalette.paletteOpenTabBranch', 'Branch name')
    : translate('auto.components.WorktreeJumpPalette.paletteOpenTabWorkspace', 'Workspace name')
}

export function PaletteOpenTabWorktreeRailLabel({
  name,
  matchRanges,
  worktree,
  className,
  slot = 'palette-open-tab-worktree'
}: {
  name: string
  matchRanges: readonly MatchRange[]
  worktree?: Pick<Worktree, 'branch'> | null
  className?: string
  slot?: string
}): React.JSX.Element | null {
  const [truncated, setTruncated] = useState(false)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  // Why: observe in an effect so unmount disconnects the ResizeObserver instead of
  // leaking the callback-ref subscription (react-doctor effect-needs-cleanup).
  useLayoutEffect(() => {
    const node = labelRef.current
    if (!node) {
      setTruncated(false)
      return
    }
    const updateTruncated = (): void => {
      const next = node.scrollWidth > node.clientWidth
      setTruncated((current) => (current === next ? current : next))
    }
    updateTruncated()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(updateTruncated)
    observer.observe(node)
    return () => observer.disconnect()
  }, [name])

  if (name.trim().length === 0) {
    return null
  }
  // Why tag the visible value: a custom display name or folder path is a workspace
  // label, not a branch, even when the workspace sits on one.
  const isBranch = worktree != null && name === resolveWorktreeBranchLabel(worktree)
  const tooltip = resolveOpenTabWorktreeRailTooltip({ isBranch, truncated, name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={labelRef} data-slot={slot} tabIndex={-1} className={className}>
          <HighlightedText text={name} matchRanges={matchRanges} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-80 break-all">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function PaletteState({
  title,
  subtitle
}: {
  title: string
  subtitle: string
}): React.JSX.Element {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
    </div>
  )
}

export function FooterKey({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-foreground/85">
      {children}
    </span>
  )
}

export function getSettingsTargetFromSectionId(sectionId: string): {
  pane: SettingsNavTarget
  repoId: string | null
  sectionId?: string
} {
  if (sectionId.startsWith('repo-')) {
    return { pane: 'repo', repoId: sectionId.slice('repo-'.length) }
  }
  return { pane: sectionId as SettingsNavTarget, repoId: null }
}
