import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import type { Repo } from '../../../../../shared/repo-types'
import type { WorkItemsCacheEntry } from '@/store/slices/work-items-cache'

type RetryRefreshDeps = {
  taskSource: string
  selectedRepos: readonly Repo[]
  selectedWorkItemsCacheEntries: readonly (WorkItemsCacheEntry | undefined)[]
  perRepoSourceState: TaskPageRepoSourceState[]
  setTaskRefreshNonce: (updater: (n: number) => number) => void
  setTasksRefreshing: (loading: boolean) => void
}

// Why: partial-failure retry leaves the cache populated so tasksLoading never flips, giving no feedback; track retry-in-flight per source so only the clicked banner shows "Retrying…".
export function useTaskPageRetryRefresh(deps: RetryRefreshDeps) {
  const {
    taskSource,
    selectedRepos,
    selectedWorkItemsCacheEntries,
    perRepoSourceState,
    setTaskRefreshNonce,
    setTasksRefreshing
  } = deps

  const fellBackToastedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (taskSource !== 'github') {
      return
    }
    for (const [index, r] of selectedRepos.entries()) {
      const entry = selectedWorkItemsCacheEntries[index]
      if (!entry?.issueSourceFellBack) {
        continue
      }
      if (fellBackToastedRef.current.has(r.id)) {
        continue
      }
      const prSlug = entry.sources?.prs
        ? `${entry.sources.prs.owner}/${entry.sources.prs.repo}`
        : r.displayName
      toast.message(
        translate(
          'auto.components.TaskPage.f4374519ae',
          'Your preferred issue source (upstream) is no longer configured for {{value0}}. Using origin.',
          { value0: prSlug }
        )
      )
      fellBackToastedRef.current.add(r.id)
    }
  }, [selectedRepos, selectedWorkItemsCacheEntries, taskSource])

  const [retryingSourceKeys, setRetryingSourceKeys] = useState<ReadonlySet<string>>(() => new Set())

  const handleRetryIssuesFetch = useCallback(
    (sourceKey: string) => {
      const source = perRepoSourceState.find((s) => s.sourceKey === sourceKey)
      if (!source) {
        return
      }
      // Why: nonce bump reuses the fetch path as force=true so retry doesn't dedupe onto a still-failing in-flight request (refreshes all repos; Retrying… stays scoped to the clicked source).
      setRetryingSourceKeys((prev) => {
        const next = new Set(prev)
        next.add(source.sourceKey)
        return next
      })
      setTaskRefreshNonce((n) => n + 1)
    },
    [perRepoSourceState, setTaskRefreshNonce]
  )

  const handleRefreshGithubTasks = useCallback((): void => {
    setTasksRefreshing(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [setTasksRefreshing, setTaskRefreshNonce])

  return {
    retryingSourceKeys,
    handleRetryIssuesFetch,
    handleRefreshGithubTasks
  }
}
