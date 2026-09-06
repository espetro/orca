/* eslint-disable max-lines -- Why: one row renderer per palette entry type; splitting further would fragment shared row chrome. */
import React from 'react'
import {
  FileText,
  FolderTree,
  Globe,
  Server,
  ServerOff,
  Smartphone,
  SquareTerminal
} from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { PaletteSearchResult } from '@/lib/worktree-palette-search'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { isPaletteCurrentWorktree } from '@/lib/palette-repo-resolution'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import {
  PaletteRowShortcutBadge,
  HighlightedText,
  PaletteOpenTabPrimaryLine,
  PaletteOpenTabWorktreeRailLabel
} from '@/components/cmd-j/palette-row-components'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import {
  PaletteRecentTabStatusDot,
  PaletteWorktreeStatusDot
} from '@/components/cmd-j/palette-live-status'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import type { PaletteListEntry } from './worktree/types'
import { JUMP_PALETTE_ITEM_CLASSNAME } from './worktree/constants'
import type { RecentWorkspaceTabRow } from '@/lib/recent-workspace-tab-rows'

function getPaletteSupportingTextLabel(
  labelKind: NonNullable<PaletteSearchResult['supportingText']>['labelKind']
): string {
  switch (labelKind) {
    case 'comment':
      return translate('worktreeJumpPalette.matchLabel.comment', 'Comment')
    case 'issue':
      return translate('worktreeJumpPalette.matchLabel.issue', 'Issue')
    case 'port':
      return translate('worktreeJumpPalette.matchLabel.port', 'Port')
    case 'pr':
      return translate('worktreeJumpPalette.matchLabel.pr', 'PR')
    case 'mr':
      return translate('worktreeJumpPalette.matchLabel.mr', 'MR')
    case 'task':
      return translate('worktreeJumpPalette.matchLabel.task', 'Task')
    case 'automation':
      return translate('worktreeJumpPalette.matchLabel.automation', 'Run')
  }
}

export type WorktreeJumpListEntryRowProps = {
  entry: PaletteListEntry
  renderKey: string
  paletteNowMs: number
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  sshConnectionStates: Map<string, { status: string }>
  recentTabShortcutIndexByItem: Map<PaletteListEntry, number>
  digitShortcutModifiers: string[]
  recentTabRowByItem: Map<PaletteListEntry, RecentWorkspaceTabRow>
  resolveWorktree: (worktreeId: string, hostId: ExecutionHostId | undefined) => Worktree | undefined
  resolveRepoForWorktree: (worktree: Worktree) => Repo | undefined
  onSelect: (item: PaletteListEntry) => void
}

/** Renders one non-header, non-hint palette row (worktree, project, settings/action, open tab). */
export function WorktreeJumpListEntryRow({
  entry,
  renderKey,
  paletteNowMs,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  sshConnectionStates,
  recentTabShortcutIndexByItem,
  digitShortcutModifiers,
  recentTabRowByItem,
  resolveWorktree,
  resolveRepoForWorktree,
  onSelect
}: WorktreeJumpListEntryRowProps): React.JSX.Element | null {
  if (entry.type === 'worktree') {
    const worktree = entry.worktree
    const repo = resolveRepoForWorktree(worktree)
    const repoName = repo?.displayName ?? ''
    // Why: both must match searchWorktrees' resolution, or highlight ranges land on
    // the wrong text — and a branch-less row would throw here before search ever ran.
    const branch = resolveWorktreeBranchLabel(worktree)
    const worktreeLabel = resolveWorktreeDisplayName(worktree)
    const isCurrentWorktree = isPaletteCurrentWorktree(
      worktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
    // Why: runtime-owned SSH targets have relay health owned by the runtime layer — don't show a false disconnected.
    const sshConnectionId =
      repo?.connectionId && !isRuntimeOwnedSshTargetId(repo.connectionId) ? repo.connectionId : null
    const sshStatus = sshConnectionId
      ? (sshConnectionStates.get(sshConnectionId)?.status ?? 'disconnected')
      : null
    const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
    const sessionAge = formatPaletteSessionAge(worktree.lastActivityAt, paletteNowMs)
    return (
      <CommandItem
        key={renderKey}
        value={renderKey}
        onSelect={() => onSelect(entry)}
        data-current={isCurrentWorktree ? 'true' : undefined}
        className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
      >
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
          <PaletteWorktreeStatusDot worktree={worktree} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                {sshConnectionId && (
                  <span
                    aria-label={
                      isSshDisconnected
                        ? translate(
                            'auto.components.WorktreeJumpPalette.63c2be1914',
                            'SSH disconnected'
                          )
                        : translate('auto.components.WorktreeJumpPalette.34c8fbb46e', 'SSH remote')
                    }
                    className="shrink-0 inline-flex items-center"
                  >
                    {isSshDisconnected ? (
                      <ServerOff className="size-3.5 text-red-400" aria-hidden="true" />
                    ) : (
                      <Server className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    )}
                  </span>
                )}
                <PaletteOpenTabWorktreeRailLabel
                  name={worktreeLabel}
                  matchRanges={entry.match.displayNameRanges}
                  worktree={worktree}
                  slot="palette-worktree-name"
                  className="truncate text-[14px] font-semibold text-foreground"
                />
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
                {isCurrentWorktree && (
                  <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                    {translate('auto.components.WorktreeJumpPalette.556e7232ca', 'Current')}
                  </span>
                )}
                {worktree.isMainWorktree && (
                  <span className="shrink-0 self-center rounded border border-muted-foreground/30 bg-muted-foreground/5 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground">
                    {translate('auto.components.WorktreeJumpPalette.739bda980c', 'primary')}
                  </span>
                )}
                {branch.trim().length > 0 ? (
                  <>
                    <span className="shrink-0 text-muted-foreground/45">·</span>
                    <PaletteOpenTabWorktreeRailLabel
                      name={branch}
                      matchRanges={entry.match.branchRanges}
                      worktree={worktree}
                      slot="palette-worktree-branch"
                      className="truncate text-[12px] font-medium text-muted-foreground/92"
                    />
                  </>
                ) : null}
              </div>
              {entry.match.supportingText && (
                <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-muted-foreground/88">
                  <span
                    aria-label={entry.match.supportingText.accessibilityLabel}
                    className="inline-flex h-[18px] shrink-0 items-center rounded border border-border bg-foreground/[0.04] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {getPaletteSupportingTextLabel(entry.match.supportingText.labelKind)}
                  </span>
                  <span className="truncate">
                    <HighlightedText
                      text={entry.match.supportingText.text}
                      matchRanges={entry.match.supportingText.matchRanges}
                    />
                  </span>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {repoName && (
                <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                  <RepoBadgeMark color={repo?.badgeColor} />
                  <span className="truncate">
                    <HighlightedText text={repoName} matchRanges={entry.match.repoRanges} />
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
      </CommandItem>
    )
  }

  if (entry.type === 'project-target') {
    const result = entry.result
    const isProject = result.kind === 'project'
    const badgeLabel = isProject
      ? translate('auto.components.WorktreeJumpPalette.projectBadge', 'Project')
      : translate('auto.components.WorktreeJumpPalette.repoGroupBadge', 'Repo group')
    return (
      <CommandItem
        key={renderKey}
        value={renderKey}
        onSelect={() => onSelect(entry)}
        className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
      >
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
          <FolderTree className="size-3.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[14px] font-semibold text-foreground">
                  {result.title}
                </span>
                <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                  {badgeLabel}
                </span>
              </div>
            </div>
            {isProject ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                  <RepoBadgeMark color={result.repo.badgeColor} />
                  <span className="truncate">{result.repo.displayName}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </CommandItem>
    )
  }

  if (entry.type === 'settings' || entry.type === 'quick-action') {
    const result = entry.result
    const Icon = result.icon
    const kindLabel =
      entry.type === 'settings'
        ? translate('auto.components.WorktreeJumpPalette.settingsBadge', 'Settings')
        : translate('auto.components.WorktreeJumpPalette.actionBadge', 'Action')
    return (
      <CommandItem
        key={renderKey}
        value={renderKey}
        onSelect={() => onSelect(entry)}
        className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
      >
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
          <Icon className="size-3.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
              {result.title}
            </span>
            <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
              {kindLabel}
            </span>
          </div>
          <div className="mt-1 truncate text-[12px] leading-5 text-muted-foreground/88">
            {result.description}
          </div>
        </div>
      </CommandItem>
    )
  }

  if (entry.type === 'workspace-tab') {
    const result = entry.result
    const sessionAge = formatPaletteSessionAge(result.lastActiveAt, paletteNowMs)
    const workspaceTabWorktree = resolveWorktree(result.worktreeId, result.executionHostId)
    const workspaceTabRepo = workspaceTabWorktree
      ? resolveRepoForWorktree(workspaceTabWorktree)
      : undefined
    const workspaceTabRepoName = workspaceTabRepo?.displayName ?? result.repoName
    const workspaceTabFallback =
      result.contentType === 'terminal' && result.occupantAgent ? (
        <span className="inline-flex" data-agent-icon={result.occupantAgent} aria-hidden="true">
          <AgentIcon agent={result.occupantAgent} size={14} />
        </span>
      ) : result.contentType === 'terminal' ? (
        <SquareTerminal className="size-3.5" aria-hidden="true" />
      ) : (
        <FileText className="size-3.5" aria-hidden="true" />
      )
    // Why regardless of query: a searched-for tab is exactly when you need to know it's
    // still working — the map covers every open tab, not just the recent section.
    const recentRow = recentTabRowByItem.get(entry) ?? null

    return (
      <CommandItem
        key={renderKey}
        value={renderKey}
        onSelect={() => onSelect(entry)}
        className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
      >
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
          <PaletteRecentTabStatusDot row={recentRow} fallback={workspaceTabFallback} />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-between gap-2.5">
            <div className="min-w-0 flex-1 overflow-hidden">
              <PaletteOpenTabPrimaryLine
                title={result.title}
                titleRanges={result.titleRanges}
                secondaryText={result.secondaryText}
                secondaryRanges={result.secondaryRanges}
                sessionAge={sessionAge}
                leadingBadges={
                  <>
                    {result.isCurrentTab && (
                      <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                        {translate('auto.components.WorktreeJumpPalette.52404f8096', 'Current Tab')}
                      </span>
                    )}
                    {!result.isCurrentTab && result.isCurrentWorktree && (
                      <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                        {translate(
                          'auto.components.WorktreeJumpPalette.c5081f2814',
                          'Current Worktree'
                        )}
                      </span>
                    )}
                  </>
                }
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <PaletteOpenTabWorktreeRailLabel
                name={result.worktreeName}
                matchRanges={result.worktreeRanges}
                worktree={workspaceTabWorktree}
                className="max-w-[280px] truncate text-[12px] font-medium text-muted-foreground"
              />
              {workspaceTabRepoName && (
                <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                  <RepoBadgeMark color={workspaceTabRepo?.badgeColor} />
                  <span className="truncate">
                    <HighlightedText text={workspaceTabRepoName} matchRanges={result.repoRanges} />
                  </span>
                </span>
              )}
              <PaletteRowShortcutBadge
                index={recentTabShortcutIndexByItem.get(entry)}
                modifierKeys={digitShortcutModifiers}
              />
            </div>
          </div>
        </div>
      </CommandItem>
    )
  }

  if (entry.type === 'simulator-tab') {
    const result = entry.result
    const simulatorWorktree = resolveWorktree(result.worktreeId, result.executionHostId)
    const simulatorRepo = simulatorWorktree ? resolveRepoForWorktree(simulatorWorktree) : undefined
    const simulatorRepoName = simulatorRepo?.displayName ?? result.repoName
    const sessionAge = formatPaletteSessionAge(result.lastActiveAt ?? null, paletteNowMs)

    return (
      <CommandItem
        key={renderKey}
        value={renderKey}
        onSelect={() => onSelect(entry)}
        className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
      >
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
          <Smartphone className="size-3.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-between gap-2.5">
            <div className="min-w-0 flex-1 overflow-hidden">
              <PaletteOpenTabPrimaryLine
                title={result.title}
                titleRanges={result.titleRanges}
                secondaryText={result.secondaryText}
                secondaryRanges={result.secondaryRanges}
                sessionAge={sessionAge}
                leadingBadges={
                  <>
                    {result.isCurrentTab && (
                      <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                        {translate('auto.components.WorktreeJumpPalette.52404f8096', 'Current Tab')}
                      </span>
                    )}
                    {!result.isCurrentTab && result.isCurrentWorktree && (
                      <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                        {translate(
                          'auto.components.WorktreeJumpPalette.c5081f2814',
                          'Current Worktree'
                        )}
                      </span>
                    )}
                  </>
                }
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <PaletteOpenTabWorktreeRailLabel
                name={result.worktreeName}
                matchRanges={result.worktreeRanges}
                worktree={simulatorWorktree}
                className="max-w-[280px] truncate text-[12px] font-medium text-muted-foreground"
              />
              {simulatorRepoName && (
                <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                  <RepoBadgeMark color={simulatorRepo?.badgeColor} />
                  <span className="truncate">
                    <HighlightedText text={simulatorRepoName} matchRanges={result.repoRanges} />
                  </span>
                </span>
              )}
              <PaletteRowShortcutBadge
                index={recentTabShortcutIndexByItem.get(entry)}
                modifierKeys={digitShortcutModifiers}
              />
            </div>
          </div>
        </div>
      </CommandItem>
    )
  }

  if (entry.type === 'browser-page') {
    const result = entry.result
    const browserWorktree = resolveWorktree(result.worktreeId, result.executionHostId)
    const browserRepo = browserWorktree ? resolveRepoForWorktree(browserWorktree) : undefined
    const browserRepoName = browserRepo?.displayName ?? result.repoName
    const sessionAge = formatPaletteSessionAge(result.lastActiveAt ?? null, paletteNowMs)

    return (
      <CommandItem
        key={renderKey}
        value={renderKey}
        onSelect={() => onSelect(entry)}
        className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
      >
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
          <Globe className="size-3.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-between gap-2.5">
            <div className="min-w-0 flex-1 overflow-hidden">
              <PaletteOpenTabPrimaryLine
                title={result.title}
                titleRanges={result.titleRanges}
                secondaryText={result.secondaryText}
                secondaryRanges={result.secondaryRanges}
                sessionAge={sessionAge}
                leadingBadges={
                  <>
                    {result.isCurrentPage && (
                      <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                        {translate('auto.components.WorktreeJumpPalette.52404f8096', 'Current Tab')}
                      </span>
                    )}
                    {!result.isCurrentPage && result.isCurrentWorktree && (
                      <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                        {translate(
                          'auto.components.WorktreeJumpPalette.c5081f2814',
                          'Current Worktree'
                        )}
                      </span>
                    )}
                  </>
                }
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <PaletteOpenTabWorktreeRailLabel
                name={result.worktreeName}
                matchRanges={result.worktreeRanges}
                worktree={browserWorktree}
                className="max-w-[280px] truncate text-[12px] font-medium text-muted-foreground"
              />
              {browserRepoName && (
                <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                  <RepoBadgeMark color={browserRepo?.badgeColor} />
                  <span className="truncate">
                    <HighlightedText text={browserRepoName} matchRanges={result.repoRanges} />
                  </span>
                </span>
              )}
              <PaletteRowShortcutBadge
                index={recentTabShortcutIndexByItem.get(entry)}
                modifierKeys={digitShortcutModifiers}
              />
            </div>
          </div>
        </div>
      </CommandItem>
    )
  }
  return null
}
