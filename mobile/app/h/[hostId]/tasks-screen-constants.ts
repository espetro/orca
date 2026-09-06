import type { GitHubProjectSettings } from '../../../src/tasks/github-project-reference'

export const PROJECT_VIEW_DEFAULT_SORT = '__view_default__'
export const GITHUB_REPO_CONCURRENCY = 3
export const GITLAB_PER_PAGE = 50
export const LINEAR_LIMIT = 50
// Why: task detail drawers can launch child sheets; children must layer above
// the still-mounted parent while its dismissal animation/state remains alive.
export const TASK_SECONDARY_DRAWER_Z_INDEX = 1100
// Why: the mobile detail drawer should support quick triage and core actions.
// Desktop keeps the broad metadata editing surface for dense issue/PR work.
export const SHOW_MOBILE_DETAIL_LABEL_CHIPS = false
export const SHOW_MOBILE_DETAIL_METADATA_EDITORS = false
export const SHOW_MOBILE_DETAIL_REVIEW_PANELS = false
export const SHOW_MOBILE_LINEAR_DETAIL_TOOLS = false
export const SHOW_MOBILE_COMMENT_THREAD_TOOLS = false
export const SHOW_MOBILE_PROJECT_METADATA_EDITORS = false
export const SHOW_MOBILE_PROJECT_REVIEW_PANELS = false
export const EMPTY_GITHUB_PROJECT_SETTINGS: GitHubProjectSettings = {
  pinned: [],
  recent: [],
  lastViewByProject: {},
  activeProject: null
}
