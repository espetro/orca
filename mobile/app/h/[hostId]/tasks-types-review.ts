import type { TaskItem } from './tasks-types-core'
import type { GitHubProjectRow } from './tasks-types-project'

export type HostedReviewMergeMethod = 'merge' | 'squash' | 'rebase'
export type HostedReviewItem =
  | Extract<TaskItem, { provider: 'github' }>
  | Extract<TaskItem, { provider: 'gitlab' }>
export type PendingHostedMerge = {
  item: HostedReviewItem
  method: HostedReviewMergeMethod
}
export type PendingProjectGitHubMerge = {
  row: GitHubProjectRow
  method: HostedReviewMergeMethod
}
export type PendingHostedStateChange =
  | {
      source: 'task'
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
      nextState: 'open' | 'opened' | 'closed'
    }
  | {
      source: 'project'
      row: GitHubProjectRow
      nextState: 'open' | 'closed'
    }
