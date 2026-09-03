import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { useAppStore } from '@/store'
import { taskPageGitHubResumeCache } from '@/components/task-page-github-resume-cache'

type ScrollRestoreDeps = {
  pages: (GitHubWorkItem[] | null)[]
  currentPage: number
  taskResumeApplied: boolean
  taskSource: string
  githubMode: string
  githubResumeContextKey: string
  githubListScrollTopRef: RefObject<number>
  openGitHubWorkItem: boolean
  pendingGithubScrollRestoreRef: RefObject<number | null>
}

// Why: keep the cached resume page and last scroll position in sync while the GitHub list is mounted.
export function useTaskPageGithubListResumeTracking(
  deps: ScrollRestoreDeps
): RefObject<{
  contextKey: string
  page: number
  scrollTop: number
} | null> {
  const {
    pages,
    currentPage,
    taskResumeApplied,
    taskSource,
    githubMode,
    githubResumeContextKey,
    githubListScrollTopRef,
    openGitHubWorkItem,
    pendingGithubScrollRestoreRef
  } = deps

  const taskListPositionRef = useRef<{
    contextKey: string
    page: number
    scrollTop: number
  } | null>(null)

  useEffect(() => {
    const page = pages[currentPage]
    if (!taskResumeApplied || taskSource !== 'github' || githubMode !== 'items' || !page) {
      return
    }
    taskPageGitHubResumeCache.write(githubResumeContextKey, currentPage, page)
  }, [currentPage, githubMode, githubResumeContextKey, pages, taskResumeApplied, taskSource])

  useLayoutEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      openGitHubWorkItem ||
      pendingGithubScrollRestoreRef.current !== null
    ) {
      return
    }
    taskListPositionRef.current = {
      contextKey: githubResumeContextKey,
      page: currentPage,
      scrollTop: githubListScrollTopRef.current
    }
  }, [
    currentPage,
    githubMode,
    githubResumeContextKey,
    taskSource,
    githubListScrollTopRef,
    openGitHubWorkItem,
    pendingGithubScrollRestoreRef
  ])

  useEffect(
    () => () => {
      const position = taskListPositionRef.current
      const state = useAppStore.getState()
      if (position && !state.taskPageData.openGitHubWorkItem) {
        state.setTaskListPosition({
          contextKey: position.contextKey,
          page: position.page,
          scrollTop: position.scrollTop
        })
      }
    },
    []
  )

  return taskListPositionRef
}
