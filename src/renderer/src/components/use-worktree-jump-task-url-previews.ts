import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getComposerDefaultWorkspaceTarget } from '@/components/cmd-j/palette-row-components'
import { lookupCmdJGitHubUrlWorkItem } from '@/lib/cmd-j-github-url-lookup'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import { withResolvedCmdJGitHubPreview } from '@/lib/worktree-palette-task-url-match'
import type { CmdJTaskUrlCreatePreview } from '@/lib/worktree-palette-task-url-match'
import type { LinearIssueUrlIntent } from '../../../shared/linear/links'
import type { GitHubIssueOrPRLink } from '../../../shared/github/links'
import { buildTaskSourceContextFromRepo } from '../../../shared/task-source-context'
import type { CmdJLinearIssuePreview, CmdJGitHubWorkItemPreview } from './worktree/types'

export type WorktreeJumpTaskUrlPreviews = {
  linearIssuePreview: CmdJLinearIssuePreview | null
  githubWorkItemPreview: CmdJGitHubWorkItemPreview | null
  currentLinearIssuePreview: CmdJLinearIssuePreview | null
  currentGitHubWorkItemPreview: CmdJGitHubWorkItemPreview | null
  linearIssueLookupRef: React.RefObject<{
    query: string
    promise: Promise<CmdJLinearIssuePreview>
  } | null>
  githubLookupRef: React.RefObject<{
    query: string
    promise: Promise<CmdJGitHubWorkItemPreview>
  } | null>
  taskUrlCreatePreview: CmdJTaskUrlCreatePreview | null
  showLinearLoadingFeedback: boolean
}

/** Resolves Linear/GitHub previews for a pasted task URL; stale lookups never render. */
export function useWorktreeJumpTaskUrlPreviews({
  visible,
  createWorktreeName,
  parsedTaskUrlCreatePreview,
  linearIssueUrlIntent,
  githubUrlLink
}: {
  visible: boolean
  createWorktreeName: string
  parsedTaskUrlCreatePreview: CmdJTaskUrlCreatePreview | null
  linearIssueUrlIntent: LinearIssueUrlIntent | null
  githubUrlLink: GitHubIssueOrPRLink | null
}): WorktreeJumpTaskUrlPreviews {
  const [linearIssuePreview, setLinearIssuePreview] = useState<CmdJLinearIssuePreview | null>(null)
  const [githubWorkItemPreview, setGithubWorkItemPreview] =
    useState<CmdJGitHubWorkItemPreview | null>(null)
  const githubLookupGenerationRef = useRef(0)
  const githubLookupRef = useRef<{
    query: string
    promise: Promise<CmdJGitHubWorkItemPreview>
  } | null>(null)
  const linearIssueLookupGenerationRef = useRef(0)
  const linearIssueLookupRef = useRef<{
    query: string
    promise: Promise<CmdJLinearIssuePreview>
  } | null>(null)

  // Why: arm the lookup before Enter can target the newly rendered Linear row.
  useLayoutEffect(() => {
    const generation = ++linearIssueLookupGenerationRef.current
    linearIssueLookupRef.current = null
    if (!visible || !linearIssueUrlIntent) {
      // oxlint-disable-next-line react/set-state-in-effect -- clear a stale preview before the new lookup arms.
      setLinearIssuePreview(null)
      return
    }

    const state = useAppStore.getState()
    const workspaceTarget = getComposerDefaultWorkspaceTarget(state)
    const initialRepoId = workspaceTarget?.repoId ?? null
    const sourceContext = workspaceTarget
      ? buildTaskSourceContextFromRepo({
          provider: 'linear',
          projectId: workspaceTarget.projectId,
          repo: workspaceTarget.repo,
          projectHostSetupId: workspaceTarget.projectHostSetupId
        })
      : null
    const pendingPreview: CmdJLinearIssuePreview = {
      query: createWorktreeName,
      issue: null,
      loading: true,
      initialRepoId,
      sourceContext
    }
    setLinearIssuePreview(pendingPreview)

    const promise = lookupLinearIssueUrl({
      intent: linearIssueUrlIntent,
      knownStatus: state.linearStatus,
      sourceContext,
      fetchLinearIssue: state.fetchLinearIssue
    })
      .catch(() => null)
      .then(
        (issue): CmdJLinearIssuePreview => ({
          ...pendingPreview,
          issue,
          loading: false
        })
      )
    linearIssueLookupRef.current = { query: createWorktreeName, promise }
    void promise.then((preview) => {
      if (linearIssueLookupGenerationRef.current === generation) {
        setLinearIssuePreview(preview)
      }
    })

    return () => {
      if (linearIssueLookupGenerationRef.current === generation) {
        linearIssueLookupGenerationRef.current += 1
      }
    }
  }, [createWorktreeName, linearIssueUrlIntent, visible])

  useLayoutEffect(() => {
    const generation = ++githubLookupGenerationRef.current
    githubLookupRef.current = null
    if (!visible || !githubUrlLink) {
      // oxlint-disable-next-line react/set-state-in-effect -- clear a stale preview before the new lookup arms.
      setGithubWorkItemPreview(null)
      return
    }

    const state = useAppStore.getState()
    const workspaceTarget = getComposerDefaultWorkspaceTarget(state)
    const initialRepoId = workspaceTarget?.repoId ?? null
    const sourceContext = workspaceTarget
      ? buildTaskSourceContextFromRepo({
          provider: 'github',
          projectId: workspaceTarget.projectId,
          repo: workspaceTarget.repo,
          projectHostSetupId: workspaceTarget.projectHostSetupId
        })
      : null
    const pendingPreview: CmdJGitHubWorkItemPreview = {
      query: createWorktreeName,
      item: null,
      loading: true,
      initialRepoId,
      sourceContext
    }
    setGithubWorkItemPreview(pendingPreview)

    const promise = lookupCmdJGitHubUrlWorkItem({
      link: githubUrlLink,
      repo: workspaceTarget?.repo ?? null,
      sourceContext
    })
      .catch(() => null)
      .then(
        (item): CmdJGitHubWorkItemPreview => ({
          ...pendingPreview,
          item: item ?? null,
          loading: false
        })
      )
    githubLookupRef.current = { query: createWorktreeName, promise }
    void promise.then((preview) => {
      if (githubLookupGenerationRef.current === generation) {
        setGithubWorkItemPreview(preview)
      }
    })

    return () => {
      if (githubLookupGenerationRef.current === generation) {
        githubLookupGenerationRef.current += 1
      }
    }
  }, [createWorktreeName, githubUrlLink, visible])

  const taskUrlCreatePreview = parsedTaskUrlCreatePreview
    ? (() => {
        const preview =
          githubWorkItemPreview?.query === createWorktreeName ? githubWorkItemPreview : null
        return withResolvedCmdJGitHubPreview(
          parsedTaskUrlCreatePreview,
          preview?.item?.title ?? null,
          preview?.loading === true
        )
      })()
    : null

  const currentGitHubWorkItemPreview =
    githubWorkItemPreview?.query === createWorktreeName ? githubWorkItemPreview : null
  const currentLinearIssuePreview =
    linearIssuePreview?.query === createWorktreeName ? linearIssuePreview : null

  const [linearLoadingFeedbackQuery, setLinearLoadingFeedbackQuery] = useState<string | null>(null)
  useEffect(() => {
    if (!currentLinearIssuePreview?.loading) {
      // oxlint-disable-next-line react/set-state-in-effect -- reset the delayed-feedback latch when loading ends.
      setLinearLoadingFeedbackQuery(null)
      return
    }
    setLinearLoadingFeedbackQuery(null)
    const timer = window.setTimeout(
      () => setLinearLoadingFeedbackQuery(currentLinearIssuePreview.query),
      200
    )
    return () => window.clearTimeout(timer)
  }, [currentLinearIssuePreview?.loading, currentLinearIssuePreview?.query])
  const showLinearLoadingFeedback =
    currentLinearIssuePreview?.loading === true &&
    linearLoadingFeedbackQuery === currentLinearIssuePreview.query

  return {
    linearIssuePreview,
    githubWorkItemPreview,
    currentLinearIssuePreview,
    currentGitHubWorkItemPreview,
    linearIssueLookupRef,
    githubLookupRef,
    taskUrlCreatePreview,
    showLinearLoadingFeedback
  }
}
