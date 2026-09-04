import type { StatsCollector } from '../stats/collector'
import type { IPtyProvider } from '../providers/types'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import type {
  ResolvedWorktree,
  RuntimeStore,
  RuntimePtyController
} from './runtime-repo-git-commands-shared-types'

// Why: narrow closure surface over OrcaRuntimeService so repo/git commands stay
// unit-testable without constructing the full runtime (pattern of runtime-linear-command-host).
export type RuntimeRepoGitCommandsDeps = {
  store: RuntimeStore | null
  stats: StatsCollector | null
  ptyController: RuntimePtyController | null
  terminalTopologyRevisionByRepoId: Map<string, number>
  getSshProviderFn: ((connectionId: string) => IPtyProvider | undefined) | null
  onPtyStopped: ((ptyId: string) => void) | null
  resolveRepoSelector: (selector: string) => Promise<Repo>
  selectReposBySelector: (selector: string) => Repo[]
  requireStore: () => Store
  notifyReposChanged: () => void
  invalidateResolvedWorktreeCache: () => void
  invalidateWorktreeScanCacheForRepo: (repoId: string) => void
  resolveLiveLeafForHandle: (handle: string) => { ptyId: string | null } | null
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  listRepoWorktreesForResolution: (
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ) => Promise<RuntimeWorktreeScanResult>
  getLocalProvider: () => IPtyProvider | null
}
