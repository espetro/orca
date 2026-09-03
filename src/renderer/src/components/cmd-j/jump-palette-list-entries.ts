import { CREATE_WORKTREE_ITEM_ID } from '@/lib/worktree-palette-create-action'
import type { MultiPrimarySectionLayout } from './palette-section-render-cap'
import type { CmdJTaskSourceUrl } from '@/lib/worktree-palette-task-url-match'
import { translate } from '@/i18n/i18n'
import { appendPaletteListEntries } from './palette-row-components'
import type { PaletteItem, PaletteListEntry } from '../WorktreeJumpPalette'

// Why: the interleaved layout emits a section header twice; the second copy needs a distinct entry id.
export const CONTINUED_SECTION_HEADER_ID_SUFFIX = '__continued'

type PaletteSectionInputs = {
  visibleWorktreeItems: PaletteItem[]
  visibleProjectTargetItems: PaletteItem[]
  visibleMiddleItems: PaletteItem[]
  visibleOpenTabItems: PaletteItem[]
  worktreeOverflowCount: number
  projectTargetOverflowCount: number
  middleOverflowCount: number
  openTabOverflowCount: number
  multiPrimaryFirstScreen: boolean
  multiPrimaryLayout: MultiPrimarySectionLayout<PaletteItem> | null
}

/** Pure section-layout builder: ordered palette rows from capped sections + layout flags. */
export function buildJumpPaletteListEntries({
  paletteSections,
  hasQuery,
  middleLeadsSections,
  openTabsLeadSections,
  showCreateAction,
  taskSourceUrl,
  handleExpandSection
}: {
  paletteSections: PaletteSectionInputs
  hasQuery: boolean
  middleLeadsSections: boolean
  openTabsLeadSections: boolean
  showCreateAction: boolean
  taskSourceUrl: CmdJTaskSourceUrl | null
  handleExpandSection: (key: 'worktrees' | 'open-tabs' | 'projects' | 'middle') => void
}): PaletteListEntry[] {
  const entries: PaletteListEntry[] = []
  const {
    visibleWorktreeItems,
    visibleProjectTargetItems,
    visibleMiddleItems,
    visibleOpenTabItems,
    worktreeOverflowCount,
    projectTargetOverflowCount,
    middleOverflowCount,
    openTabOverflowCount,
    multiPrimaryFirstScreen,
    multiPrimaryLayout
  } = paletteSections
  const pushOverflowHint = (id: string, overflowCount: number, onSeeMore?: () => void): void => {
    if (overflowCount > 0) {
      entries.push({
        id,
        type: 'hint',
        label: translate('worktreeJumpPalette.renderCapOverflow', '{{value0}} more', {
          value0: overflowCount
        }),
        onSeeMore
      })
    }
  }
  // Why always: a lone search section still needs its label (mock single-section Open Tabs);
  // empty sections stay unlabeled because their push helpers short-circuit on zero rows.
  const showWorktreeHeader = visibleWorktreeItems.length > 0
  const showOpenTabsHeader = visibleOpenTabItems.length > 0
  const showProjectTargetHeader = visibleProjectTargetItems.length > 0
  const showMiddleHeader = visibleMiddleItems.length > 0

  // idSuffix: the interleaved layout re-emits a header for the section's remainder, which needs its own key.
  const pushOpenTabsHeader = (idSuffix = ''): void => {
    if (!showOpenTabsHeader) {
      return
    }
    entries.push({
      id: `__header_open_tabs__${idSuffix}`,
      type: 'section-header',
      label: hasQuery
        ? translate('auto.components.WorktreeJumpPalette.50a1d11d5b', 'Open Tabs')
        : translate(
            'auto.components.WorktreeJumpPalette.recentChatsTerminalsHeader',
            'Recent Chats & Terminals'
          )
    })
  }

  const pushWorktreesHeader = (idSuffix = ''): void => {
    if (!showWorktreeHeader) {
      return
    }
    entries.push({
      id: `__header_worktrees__${idSuffix}`,
      type: 'section-header',
      label: hasQuery
        ? translate('auto.components.WorktreeJumpPalette.worktreesHeader', 'Worktrees')
        : translate('auto.components.WorktreeJumpPalette.recentWorktreesHeader', 'Recent Worktrees')
    })
  }

  const pushWorktreeSection = (): void => {
    if (visibleWorktreeItems.length === 0) {
      return
    }
    pushWorktreesHeader()
    appendPaletteListEntries(entries, visibleWorktreeItems)
    pushOverflowHint('__hint_worktree_overflow__', worktreeOverflowCount, () =>
      handleExpandSection('worktrees')
    )
  }

  const pushOpenTabSection = (): void => {
    if (visibleOpenTabItems.length === 0) {
      return
    }
    pushOpenTabsHeader()
    appendPaletteListEntries(entries, visibleOpenTabItems)
    pushOverflowHint('__hint_open_tab_overflow__', openTabOverflowCount, () =>
      handleExpandSection('open-tabs')
    )
  }

  const pushProjectAndMiddleSections = (): void => {
    if (visibleProjectTargetItems.length > 0) {
      if (showProjectTargetHeader) {
        entries.push({
          id: '__header_projects_groups__',
          type: 'section-header',
          label: translate(
            'auto.components.WorktreeJumpPalette.projectsGroupsHeader',
            'Projects & Groups'
          )
        })
      }
      appendPaletteListEntries(entries, visibleProjectTargetItems)
      pushOverflowHint('__hint_project_overflow__', projectTargetOverflowCount, () =>
        handleExpandSection('projects')
      )
    }
    if (visibleMiddleItems.length > 0) {
      if (showMiddleHeader) {
        entries.push({
          id: '__header_actions_settings__',
          type: 'section-header',
          label: translate('auto.components.WorktreeJumpPalette.088d66d980', 'Actions & Settings')
        })
      }
      appendPaletteListEntries(entries, visibleMiddleItems)
      pushOverflowHint('__hint_middle_overflow__', middleOverflowCount, () =>
        handleExpandSection('middle')
      )
    }
  }

  // Why: a pasted issue/PR URL is decisive. Show linked worktrees first so
  // Enter jumps; keep create available underneath when the user wants a new one.
  if (taskSourceUrl) {
    if (visibleWorktreeItems.length > 0) {
      pushWorktreeSection()
    }
    if (showCreateAction) {
      entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
    }
    return entries
  }

  if (!hasQuery) {
    // Why: the recent section leads the empty-query view; nothing else in this branch is populated.
    pushOpenTabSection()
    pushWorktreeSection()
    return entries
  }

  // Typed query with both open tabs and worktrees: soft-split so the trailing
  // primary is not buried under ~50 leading rows (see tmp/cmd-j-recommended.html).
  if (multiPrimaryFirstScreen && multiPrimaryLayout) {
    const leadingSectionKey = openTabsLeadSections ? 'open-tabs' : 'worktrees'
    const trailingSectionKey = openTabsLeadSections ? 'worktrees' : 'open-tabs'

    const leadingHintId = openTabsLeadSections
      ? '__hint_open_tab_overflow__'
      : '__hint_worktree_overflow__'
    const trailingHintId = openTabsLeadSections
      ? '__hint_worktree_overflow__'
      : '__hint_open_tab_overflow__'

    const pushLeadingHeader = (idSuffix = ''): void => {
      if (openTabsLeadSections) {
        pushOpenTabsHeader(idSuffix)
      } else {
        pushWorktreesHeader(idSuffix)
      }
    }
    const pushTrailingHeader = (idSuffix = ''): void => {
      if (openTabsLeadSections) {
        pushWorktreesHeader(idSuffix)
      } else {
        pushOpenTabsHeader(idSuffix)
      }
    }

    pushLeadingHeader()
    appendPaletteListEntries(entries, multiPrimaryLayout.leadingPreview)
    // Soft more for the leading section (rows resuming below + hard-cap tail).
    // Why: reveals the next batch into the leading preview so the user can
    // keep browsing tabs without having to scroll past the worktrees section.
    pushOverflowHint(leadingHintId, multiPrimaryLayout.leadingMoreCount, () =>
      handleExpandSection(leadingSectionKey)
    )
    pushTrailingHeader()
    // Floor first, then remaining leading rows, then trailing rest — same order
    // as orderMultiPrimaryPaletteItems / keyboard selection. Each remainder
    // re-emits its own header so no row sits under the other section's label.
    appendPaletteListEntries(entries, multiPrimaryLayout.trailingFloor)
    const hasLeadingRest = multiPrimaryLayout.leadingRest.length > 0
    if (hasLeadingRest) {
      pushLeadingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
      appendPaletteListEntries(entries, multiPrimaryLayout.leadingRest)
      pushOverflowHint(`${leadingHintId}_tail`, multiPrimaryLayout.leadingHardOverflowCount, () =>
        handleExpandSection(leadingSectionKey)
      )
    }
    if (multiPrimaryLayout.trailingRest.length > 0) {
      // Only re-label when the leading remainder split the trailing section.
      if (hasLeadingRest) {
        pushTrailingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
      }
      appendPaletteListEntries(entries, multiPrimaryLayout.trailingRest)
    }
    // Trailing rest is already on screen; only hard-cap overflow needs a hint.
    pushOverflowHint(trailingHintId, multiPrimaryLayout.trailingHardOverflowCount, () =>
      handleExpandSection(trailingSectionKey)
    )
    pushProjectAndMiddleSections()
    if (showCreateAction) {
      entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
    }
    return entries
  }

  if (middleLeadsSections) {
    pushProjectAndMiddleSections()
  }
  if (openTabsLeadSections) {
    pushOpenTabSection()
  }
  pushWorktreeSection()
  if (!middleLeadsSections) {
    pushProjectAndMiddleSections()
  }
  if (!openTabsLeadSections) {
    pushOpenTabSection()
  }
  if (showCreateAction) {
    // Why: creating a workspace is the fallback for "nothing here matches", so it sits below every
    // real result — never above them, where it would steal the default selection from a match.
    entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
  }
  return entries
}
