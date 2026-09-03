import type { SearchableSimulatorTab } from '@renderer/lib/simulator-palette-search'
import type { Worktree } from '../../../../shared/worktree/types'
import { CREATE_WORKSPACE_QUICK_ACTION_ID } from '../cmd-j/quick-actions'
import type { SearchableBrowserPage } from '@renderer/lib/browser-palette-search'
import type { SearchableWorkspaceTab } from '@renderer/lib/workspace-tab-palette-search'

export const CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID = `quick-action:${CREATE_WORKSPACE_QUICK_ACTION_ID}`

// Why: outlast the CommandDialog close animation so its rows do not disappear mid-fade.
export const PALETTE_CLOSE_LINGER_MS = 300
// Why `jump-palette-item`: selection chrome lives in main.css — flat accent is invisible on light popovers.
export const JUMP_PALETTE_ITEM_CLASSNAME =
  'jump-palette-item group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 text-left outline-none transition-[background-color,box-shadow]'

// Why: while the palette is open the workspace digit chord addresses recent rows, so it labels them.
export const DIGIT_INDEX_ACTION_ID = 'workspace.selectByIndex' as const
// Why: this is also the ⌘N ceiling — any deeper and RECENT WORKTREES falls below the first screenful.
export const EMPTY_QUERY_RECENT_TAB_CAP = 6
// Why: hold total empty-query rows at the pre-existing 10 so the worktree header stays above the fold.
export const EMPTY_QUERY_ROW_BUDGET = 10
export const EMPTY_QUERY_WORKTREE_CAP = 5
export const EMPTY_RECENT_TAB_ORDER: readonly string[] = []
export const EMPTY_SORTED_WORKTREES: Worktree[] = []
export const EMPTY_BROWSER_PAGE_ENTRIES: SearchableBrowserPage[] = []
export const EMPTY_SIMULATOR_TAB_ENTRIES: SearchableSimulatorTab[] = []
export const EMPTY_WORKSPACE_TAB_ENTRIES: SearchableWorkspaceTab[] = []
// Why: the interleaved layout emits a section header twice; the second copy needs a distinct entry id.
