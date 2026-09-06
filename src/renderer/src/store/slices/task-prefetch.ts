import type { AppState } from '../types'
import type { TaskPageData } from './ui-page-navigation'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { PER_REPO_FETCH_LIMIT } from '../../../../shared/work-items'
import { presetToQuery } from './task-preset-query'

const LINEAR_TASK_PREFETCH_LIMIT = 36

/** Warm the work-item list SWR cache during openTaskPage so the page's first effect hits an in-flight/ready cache. */
export function warmTaskPagePrefetch(get: () => AppState, data: TaskPageData): void {
  const state = get()
  const preferredVisibleTaskProviders = normalizeVisibleTaskProviders(
    state.settings?.visibleTaskProviders
  )
  const visibleTaskProviders = restoreAvailableDefaultTaskProvider(
    preferredVisibleTaskProviders,
    {
      gitlabInstalled: state.preflightStatus?.glab?.installed === true,
      linearConnected: state.linearStatus?.connected === true
    },
    state.settings?.defaultTaskSource
  )
  const resolvedSource = resolveVisibleTaskProvider(
    data.taskSource ?? state.settings?.defaultTaskSource,
    visibleTaskProviders
  )
  const resolvedMode = state.taskResumeState?.githubMode ?? 'items'
  if (resolvedSource === 'github' && resolvedMode === 'items') {
    const eligibleRepos = state.repos.filter((repo) => isGitRepoKind(repo) && repo.path)
    const selectedRepos = (() => {
      const preferred = data.preselectedRepoId
      if (preferred) {
        const repo = eligibleRepos.find((r) => r.id === preferred)
        return repo ? [repo] : []
      }
      const persisted = state.settings?.defaultRepoSelection
      if (Array.isArray(persisted)) {
        const selected = eligibleRepos.filter((repo) => persisted.includes(repo.id))
        if (selected.length > 0) {
          return selected
        }
      }
      return eligibleRepos
    })()

    const resume = state.taskResumeState
    const defaultPreset = state.settings?.defaultTaskViewPreset ?? 'all'
    // Why: must match the query TaskPage's resume effect mounts with, else the warm cache key misses and prefetch is wasted.
    const query =
      resume?.githubItemsPreset === null
        ? (resume.githubItemsQuery ?? '').trim()
        : presetToQuery(resume?.githubItemsPreset ?? defaultPreset)
    for (const repo of selectedRepos) {
      state.prefetchWorkItems(repo.id, repo.path, PER_REPO_FETCH_LIMIT, query, {
        sourceContext:
          data.openGitHubSourceContext?.provider === 'github' &&
          data.openGitHubSourceContext.repoId === repo.id
            ? data.openGitHubSourceContext
            : null
      })
    }
  }
  if (resolvedSource === 'linear' && typeof state.prefetchLinearIssues === 'function') {
    const resume = state.taskResumeState
    const query = (resume?.linearQuery ?? '').trim()
    const sourceContext =
      data.openLinearSourceContext?.provider === 'linear' ? data.openLinearSourceContext : null
    if (query) {
      state.prefetchLinearIssues(
        { kind: 'search', query, limit: LINEAR_TASK_PREFETCH_LIMIT },
        { sourceContext }
      )
    } else {
      // Why: TaskPage no longer exposes Linear preset filters; keep prefetch aligned with the default unsearched issue list.
      state.prefetchLinearIssues(
        {
          kind: 'list',
          filter: 'all',
          limit: LINEAR_TASK_PREFETCH_LIMIT
        },
        { sourceContext }
      )
    }
  }
}
