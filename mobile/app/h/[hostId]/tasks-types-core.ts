import type { RpcClient } from '../../../src/transport/rpc-client'
import type { GitHubProjectSettings } from '../../../src/tasks/github-project-reference'
import type { TaskProvider } from '../../../src/tasks/mobile-task-providers'
import type {
  GitHubOwnerRepo,
  ProviderCheckSummary
} from '../../../../src/shared/github/pull-request-types'
import type { TuiAgent } from '../../../../src/shared/tui-agent'
import type { HostedReviewDecision } from '../../../../src/shared/hosted-review'
import type { GitHubPreset, LinearFilter } from './tasks-types-filters'
import type { LinearIssue } from './tasks-types-linear'

export type RepoSummary = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  kind?: 'git' | 'folder'
  connectionId?: string | null
  issueSourcePreference?: IssueSourcePreference
  /** Fork parent resolved by the host; drives upstream Project row matching. */
  upstream?: { owner: string; repo: string; host?: string } | null
}

export type IssueSourcePreference = 'upstream' | 'origin' | 'auto'

export type GitHubWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  repoId: string
  repoName: string
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  checksSummary?: ProviderCheckSummary
  mergeable?: GitHubPRMergeableState
  mergeStateStatus?: string | null
}
export type GitHubAssignableUser = {
  login: string
  name?: string | null
  avatarUrl?: string | null
}
export type GitHubPRReviewSummary = {
  login: string
  state?: string | null
  avatarUrl?: string | null
}
export type GitHubPRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type GitHubPRReviewerRow = {
  login: string
  name?: string | null
  avatarUrl?: string | null
  stateLabel: string
}
export type GitHubRepoSources = {
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  upstreamCandidate: GitHubOwnerRepo | null
}
export type TaskRuntimeStatus = {
  capabilities?: string[]
}

export type TasksSupportState =
  | { kind: 'unknown'; client: RpcClient | null }
  | { kind: 'supported'; client: RpcClient }
  | { kind: 'unsupported'; client: RpcClient }
export type GitLabWorkItem = {
  id: string
  type: 'issue' | 'mr'
  number: number
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  projectRef?: { host: string; path: string }
  checksSummary?: ProviderCheckSummary
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision?: HostedReviewDecision
  reviewerCount?: number
  repoId: string
  repoName: string
}

export type GitLabTodo = {
  id: number
  actionName: string
  targetType: string
  targetIid: number | null
  targetTitle: string
  targetUrl: string
  projectPath: string
  authorUsername: string
  updatedAt: string
  state: 'pending' | 'done'
}

export type GitPushTarget = {
  remoteName: string
  branchName: string
  remoteUrl?: string
}

export type SetupDecision = 'inherit' | 'run' | 'skip'
export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'

export type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: {
    contentHash: string
    scriptContent: string
  }
}
export type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: GitHubPreset | 'all' | null
  githubItemsQuery?: string
  githubProjectHiddenFieldIdsByView?: Record<string, string[]>
  linearPreset?: LinearFilter
  linearQuery?: string
}
export type RuntimeTaskSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
  agentCmdOverrides?: Record<string, string>
  defaultTaskSource?: TaskProvider
  defaultTaskViewPreset?: GitHubPreset | 'all'
  visibleTaskProviders?: TaskProvider[]
  defaultRepoSelection?: string[] | null
  defaultLinearTeamSelection?: string[] | null
  githubProjects?: GitHubProjectSettings
}
export type TaskItem =
  | {
      key: string
      provider: 'github'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitHubWorkItem
    }
  | {
      key: string
      provider: 'gitlab'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabWorkItem
    }
  | {
      key: string
      provider: 'gitlabTodo'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabTodo
    }
  | {
      key: string
      provider: 'linear'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: LinearIssue
    }

export type ActionableTaskItem = Exclude<TaskItem, { provider: 'gitlabTodo' }>
export type TaskListEntry =
  | { type: 'section'; key: string; label: string; color: string }
  | { type: 'item'; key: string; item: TaskItem }
