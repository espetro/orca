import { homedir } from 'node:os'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { IPtyProvider } from '../providers/types'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ResolvedWorktree } from './runtime-tail-shared'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { RateLimitService } from '../rate-limits/service'
import type { SkillInstallDestinationAuthority } from '../skills/skill-install-destinations'
import type { SkillProviderRootOverrides } from '../skills/skill-provider-destinations'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslGrokSkillProviderRoot,
  withClaudeSkillProviderRoot
} from '../skills/skill-provider-runtime-roots'
import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'

type RuntimeSkillArtifactAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

type RuntimeSkillInstallCommandsDeps = {
  getStatus: () => RuntimeStatus
  skillTransactionRecovery: Promise<unknown>
  listRepos: () => Repo[]
  listFolderWorkspaces: () => FolderWorkspace[]
  assertAgentSkillSharingAllowed: () => void
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  showManagedWorktree: (selector: string) => Promise<ResolvedWorktree>
  resolveProjectRuntimeForWorktree: (
    worktreeId: string | null | undefined
  ) => ProjectExecutionRuntimeResolution | undefined
  accountServices: () => RuntimeSkillArtifactAccountServices | null
  getSshProviderFn: ((connectionId: string) => IPtyProvider | undefined) | null
}

export class RuntimeSkillInstallCommands {
  private readonly deps: RuntimeSkillInstallCommandsDeps
  private readonly skillInstallOperations = new Map<string, AbortController>()
  private readonly skillInstallProgress = new Map<string, SkillBundleInstallProgress>()

  constructor(deps: RuntimeSkillInstallCommandsDeps) {
    this.deps = deps
  }

  async installSharedSkillRequest(
    request: SkillInstallRequest,
    signal?: AbortSignal
  ): Promise<SkillInstallResult> {
    if (this.skillInstallOperations.has(request.operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) {
      abort()
    } else {
      signal?.addEventListener('abort', abort, { once: true })
    }
    this.skillInstallOperations.set(request.operationId, controller)
    try {
      return await this.executeSharedSkillInstall(request, controller.signal)
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.skillInstallOperations.get(request.operationId) === controller) {
        this.skillInstallOperations.delete(request.operationId)
      }
    }
  }

  async installSharedSkillBundleRequest(
    request: SkillBundleInstallRequest,
    signal?: AbortSignal,
    onProgress?: (progress: SkillBundleInstallProgress) => void
  ): Promise<SkillBundleInstallResult> {
    if (this.skillInstallOperations.has(request.operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) {
      abort()
    } else {
      signal?.addEventListener('abort', abort, { once: true })
    }
    this.skillInstallOperations.set(request.operationId, controller)
    const reportProgress = (progress: SkillBundleInstallProgress): void => {
      this.skillInstallProgress.set(request.operationId, progress)
      try {
        onProgress?.(progress)
      } catch {
        // Why: renderer teardown must not change the host-owned install outcome.
      }
    }
    try {
      const runtimeId = this.deps.getStatus().runtimeId
      const sshTarget = await this.resolveSkillSshTarget(request.destination)
      if (sshTarget) {
        return installSkillBundleOnSshHost({
          provider: sshTarget.provider,
          userDataPath: getAppEnvironment().getPath('userData'),
          request: {
            ...request,
            destination:
              request.destination.scope === 'global'
                ? { scope: 'global', executionTarget: { kind: 'host' } }
                : request.destination
          },
          workspace: sshTarget.workspace,
          requireHttps: getAppEnvironment().isPackaged(),
          signal: controller.signal,
          onProgress: reportProgress
        })
      }
      await this.deps.skillTransactionRecovery
      const allowedDownloadOrigins = ['https://storage.googleapis.com']
      if (!getAppEnvironment().isPackaged() && process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
        allowedDownloadOrigins.push(
          ...process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
        )
      }
      return await executeSkillBundleInstallRequest(request, {
        authority: this.skillInstallDestinationAuthority(runtimeId),
        stateDirectory: getAppEnvironment().getPath('userData'),
        allowedDownloadOrigins: [...new Set(allowedDownloadOrigins)],
        requireHttps: getAppEnvironment().isPackaged(),
        resolveStagedUpload: (uploadId, identity) =>
          this.requireSkillUploadSessions().take(uploadId, identity),
        detectProviders: detectInstalledAgentsWithShellPathHydration,
        resolveProviderRootOverrides: (destination) =>
          this.resolveSkillProviderRootOverrides(destination),
        signal: controller.signal,
        onProgress: reportProgress
      })
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.skillInstallOperations.get(request.operationId) === controller) {
        this.skillInstallOperations.delete(request.operationId)
      }
      this.skillInstallProgress.delete(request.operationId)
    }
  }

  getSharedSkillInstallProgress(operationId: string): SkillBundleInstallProgress | null {
    return this.skillInstallProgress.get(operationId) ?? null
  }

  cancelSharedSkillInstall(operationId: string): boolean {
    const operation = this.skillInstallOperations.get(operationId)
    operation?.abort()
    return Boolean(operation)
  }
  async skillInstallDestinationUsesSsh(
    destination: SkillInstallRequest['destination']
  ): Promise<boolean> {
    return Boolean(await this.resolveSkillSshTarget(destination))
  }

  async resolveSkillDiscoveryProviderRoots(target: {
    kind: 'native-host' | 'wsl'
    distro?: string
  }): Promise<SkillProviderRootOverrides> {
    const roots = await this.resolveSkillProviderRootOverrides({
      scope: 'global',
      homeDirectory: homedir(),
      ...(target.kind === 'wsl' && target.distro ? { wslDistro: target.distro } : {})
    })
    if (target.kind !== 'wsl') {
      return roots
    }
    return Object.fromEntries(
      Object.entries(roots).map(([provider, root]) => [provider, toLinuxPath(root)])
    )
  }

  private async resolveSkillProviderRootOverrides(destination: {
    scope: 'global' | 'workspace'
    homeDirectory: string
    workspaceDirectory?: string
    wslDistro?: string
  }): Promise<SkillProviderRootOverrides> {
    if (destination.scope !== 'global') {
      return {}
    }
    const wslGrokRoot = destination.wslDistro
      ? await resolveWslGrokSkillProviderRoot(destination.wslDistro)
      : null
    const roots: SkillProviderRootOverrides = destination.wslDistro
      ? wslGrokRoot
        ? { grok: wslGrokRoot }
        : {}
      : resolveEnvironmentSkillProviderRoots()
    const claudeConfigDirectory = this.deps.accountServices()?.claudeAccounts.getRuntimeConfigDir(
      destination.wslDistro
        ? { runtime: 'wsl', wslDistro: destination.wslDistro }
        : { runtime: 'host' }
    )
    return withClaudeSkillProviderRoot(roots, claudeConfigDirectory)
  }

  private skillInstallDestinationAuthority(runtimeId: string): SkillInstallDestinationAuthority {
    return {
      environmentId: runtimeId,
      homeDirectory: homedir(),
      resolveWorktree: async (id) => {
        const repo = this.deps.listRepos().find(
          (candidate) => candidate.id === getRepoIdFromWorktreeId(id)
        )
        if (repo?.connectionId) {
          throw new Error('skill-install-ssh-dispatch-required')
        }
        const projectRuntime = this.deps.resolveProjectRuntimeForWorktree(id)
        const worktree = await this.deps.showManagedWorktree(`id:${id}`)
        if (worktree.id !== id) {
          return null
        }
        return {
          id,
          path: worktree.path,
          ...(projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
            ? { wslDistro: projectRuntime.runtime.distro }
            : {})
        }
      },
      resolveFolderWorkspace: async (id) => {
        const workspace = this.deps.listFolderWorkspaces().find((candidate) => candidate.id === id)
        if (!workspace || workspace.connectionId) {
          return null
        }
        return {
          id,
          path: workspace.folderPath,
          ...(parseWslUncPath(workspace.folderPath)?.distro
            ? { wslDistro: parseWslUncPath(workspace.folderPath)!.distro }
            : {})
        }
      },
      resolveWsl: async (distro) => {
        if (process.platform !== 'win32') {
          return null
        }
        const homeDirectory = getWslHome(distro)
        return homeDirectory ? { homeDirectory } : null
      }
    }
  }

  private async resolveSkillSshTarget(destination: SkillInstallRequest['destination']): Promise<{
    provider: () => IPtyProvider
    workspace?: SkillSshWorkspaceAuthority
  } | null> {
    if (destination.scope === 'global') {
      if (destination.executionTarget?.kind !== 'ssh') {
        return null
      }
      const connectionId = destination.executionTarget.connectionId
      return { provider: () => this.requireSkillSshProvider(connectionId) }
    }
    if (destination.worktreeId) {
      const repo = this.deps.listRepos().find(
        (candidate) => candidate.id === getRepoIdFromWorktreeId(destination.worktreeId!)
      )
      if (!repo?.connectionId) {
        return null
      }
      const worktree = await this.deps.showManagedWorktree(`id:${destination.worktreeId}`)
      if (worktree.id !== destination.worktreeId) {
        throw new Error('skill-install-workspace-not-found')
      }
      return {
        provider: () => this.requireSkillSshProvider(repo.connectionId!),
        workspace: { kind: 'worktree', id: worktree.id, path: worktree.path }
      }
    }
    const folder = this.deps.listFolderWorkspaces().find(
      (candidate) => candidate.id === destination.folderWorkspaceId
    )
    if (!folder?.connectionId) {
      return null
    }
    return {
      provider: () => this.requireSkillSshProvider(folder.connectionId!),
      workspace: { kind: 'folder', id: folder.id, path: folder.folderPath }
    }
  }

  private requireSkillSshProvider(connectionId: string): IPtyProvider {
    const provider = this.deps.getSshProviderFn?.(connectionId)
    if (!provider?.requestHostRpc) {
      throw new Error('skill-install-ssh-relay-unavailable')
    }
    return provider
  }

  private async listSkillSshWorkspaces(
    connectionId: string
  ): Promise<SkillSshWorkspaceAuthority[]> {
    const repos = new Map(
      this.deps.listRepos()
        .filter((repo) => repo.connectionId === connectionId)
        .map((repo) => [repo.id, repo])
    )
    const worktrees = (await this.deps.listResolvedWorktrees())
      .filter((worktree) => repos.has(getRepoIdFromWorktreeId(worktree.id)))
      .map(
        (worktree): SkillSshWorkspaceAuthority => ({
          kind: 'worktree',
          id: worktree.id,
          path: worktree.path
        })
      )
    const folders = this.deps.listFolderWorkspaces()
      .filter((folder) => folder.connectionId === connectionId)
      .map(
        (folder): SkillSshWorkspaceAuthority => ({
          kind: 'folder',
          id: folder.id,
          path: folder.folderPath
        })
      )
    return [...worktrees, ...folders]
  }
}
