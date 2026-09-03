import type { PaletteSearchResult } from '@/lib/worktree-palette-search'
import type { CREATE_WORKTREE_ITEM_ID } from '@/lib/worktree-palette-create-action'
import type { BrowserPaletteSearchResult } from '@/lib/browser-palette-search'
import type { SimulatorPaletteSearchResult } from '@/lib/simulator-palette-search'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-search'
import type {
  CmdJRankedMiddleResult,
  CmdJActionResult,
  CmdJSettingsResult
} from '@/components/cmd-j/palette-results'
import type { CmdJRankedProjectSearchResult } from '@/components/cmd-j/palette-project-results'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type WorktreePaletteItem = {
  id: string
  type: 'worktree'
  match: PaletteSearchResult
  worktree: Worktree
}

export type BrowserPaletteItem = {
  id: string
  type: 'browser-page'
  result: BrowserPaletteSearchResult
}

export type SimulatorPaletteItem = {
  id: string
  type: 'simulator-tab'
  result: SimulatorPaletteSearchResult
}

export type WorkspaceTabPaletteItem = {
  id: string
  type: 'workspace-tab'
  result: WorkspaceTabPaletteSearchResult
}

export type OpenTabPaletteItem = BrowserPaletteItem | SimulatorPaletteItem | WorkspaceTabPaletteItem

export type SettingsPaletteItem = {
  id: string
  type: 'settings'
  result: CmdJSettingsResult & Pick<CmdJRankedMiddleResult, 'qualityClass'>
}

export type QuickActionPaletteItem = {
  id: string
  type: 'quick-action'
  result: CmdJActionResult & Pick<CmdJRankedMiddleResult, 'qualityClass'>
}

export type ProjectTargetPaletteItem = {
  id: string
  type: 'project-target'
  result: CmdJRankedProjectSearchResult
}

export type SectionHeader = {
  id: string
  type: 'section-header'
  label: string
}

export type HintRow = {
  id: string
  type: 'hint'
  label: string
  onSeeMore?: () => void
}

export type CreateWorktreePaletteItem = {
  id: typeof CREATE_WORKTREE_ITEM_ID
  type: 'create-worktree'
}

export type CmdJLinearIssuePreview = {
  query: string
  issue: LinearIssue | null
  loading: boolean
  initialRepoId: string | null
  sourceContext: TaskSourceContext | null
}

export type CmdJGitHubWorkItemPreview = {
  query: string
  item: GitHubWorkItem | null
  loading: boolean
  initialRepoId: string | null
  sourceContext: TaskSourceContext | null
}

// Why: keep quick actions curated — Cmd+J is a fast intent surface, not a dump of every setup button.
export type PaletteItem =
  | WorktreePaletteItem
  | ProjectTargetPaletteItem
  | SettingsPaletteItem
  | QuickActionPaletteItem
  | BrowserPaletteItem
  | SimulatorPaletteItem
  | WorkspaceTabPaletteItem

export type PaletteListEntry = PaletteItem | CreateWorktreePaletteItem | SectionHeader | HintRow
