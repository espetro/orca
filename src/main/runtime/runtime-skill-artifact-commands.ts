import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { RateLimitService } from '../rate-limits/service'
import type { IPtyProvider } from '../providers/types'

type RuntimeSkillArtifactAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

type RuntimeSkillArtifactCommandsDeps = {
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

export class RuntimeSkillArtifactCommands {
  private readonly deps: RuntimeSkillArtifactCommandsDeps
  private artifactService: ArtifactCloudService | null = null
  private skillCloudService: SkillCloudService | null = null
  private agentSkillShareInProgress = false
  private skillUploadSessions: SkillUploadSessionService | null = null
  private skillUploadSessionsDisposed = false

  constructor(deps: RuntimeSkillArtifactCommandsDeps) {
    this.deps = deps
  }

  setArtifactService(service: ArtifactCloudService): void {
    this.artifactService = service
  }

  setSkillCloudService(service: SkillCloudService): void {
    this.skillCloudService = service
  }

  private async executeSharedSkillInstall(
    request: SkillInstallRequest,
    signal: AbortSignal
  ): Promise<SkillInstallResult> {
    const runtimeId = this.deps.getStatus().runtimeId
    const sshTarget = await this.resolveSkillSshTarget(request.destination)
    if (sshTarget) {
      return installSkillOnSshHost({
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
        signal
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
    return executeSkillInstallRequest(request, {
      authority: this.skillInstallDestinationAuthority(runtimeId),
      stateDirectory: getAppEnvironment().getPath('userData'),
      allowedDownloadOrigins: [...new Set(allowedDownloadOrigins)],
      requireHttps: getAppEnvironment().isPackaged(),
      resolveStagedUpload: (uploadId, identity) =>
        this.requireSkillUploadSessions().take(uploadId, identity),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) =>
        this.resolveSkillProviderRootOverrides(destination),
      signal
    })
  }

  async previewSharedSkillInstallRequest(
    request: SkillInstallPreviewRequest
  ): Promise<SkillInstallPreview> {
    const runtimeId = this.deps.getStatus().runtimeId
    const sshTarget = await this.resolveSkillSshTarget(request.destination)
    if (sshTarget) {
      return previewSkillInstallOnSshHost({
        provider: sshTarget.provider,
        request: {
          ...request,
          destination:
            request.destination.scope === 'global'
              ? { scope: 'global', executionTarget: { kind: 'host' } }
              : request.destination
        },
        workspace: sshTarget.workspace
      })
    }
    await this.deps.skillTransactionRecovery
    return previewSharedSkillInstall(request, {
      authority: this.skillInstallDestinationAuthority(runtimeId),
      stateDirectory: getAppEnvironment().getPath('userData'),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) =>
        this.resolveSkillProviderRootOverrides(destination)
    })
  }

  async previewSharedSkillBundleInstallRequest(
    request: SkillBundleInstallPreviewRequest
  ): Promise<SkillBundleInstallPreview> {
    const sshTarget = await this.resolveSkillSshTarget(request.destination)
    if (sshTarget) {
      return previewSkillBundleInstallOnSshHost({
        provider: sshTarget.provider,
        request: {
          ...request,
          destination:
            request.destination.scope === 'global'
              ? { scope: 'global', executionTarget: { kind: 'host' } }
              : request.destination
        },
        workspace: sshTarget.workspace
      })
    }
    await this.deps.skillTransactionRecovery
    const runtimeId = this.deps.getStatus().runtimeId
    return previewSharedSkillBundleInstall(request, {
      authority: this.skillInstallDestinationAuthority(runtimeId),
      stateDirectory: getAppEnvironment().getPath('userData'),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) =>
        this.resolveSkillProviderRootOverrides(destination)
    })
  }

  async removeSharedSkillInstallRequest(request: SkillRemoveRequest): Promise<SkillInstallResult> {
    const runtimeId = this.deps.getStatus().runtimeId
    const sshTarget = await this.resolveSkillSshTarget(request.destination)
    if (sshTarget) {
      return removeSkillInstallOnSshHost({
        provider: sshTarget.provider,
        request: {
          ...request,
          destination:
            request.destination.scope === 'global'
              ? { scope: 'global', executionTarget: { kind: 'host' } }
              : request.destination
        },
        workspace: sshTarget.workspace
      })
    }
    await this.deps.skillTransactionRecovery
    return removeSharedSkillInstall(request, {
      authority: this.skillInstallDestinationAuthority(runtimeId),
      stateDirectory: getAppEnvironment().getPath('userData'),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) =>
        this.resolveSkillProviderRootOverrides(destination)
    })
  }

  async listManagedSkillInstalls(connectionId?: string): Promise<ManagedSkillInstall[]> {
    if (connectionId) {
      const provider = this.requireSkillSshProvider(connectionId)
      return listSkillInstallsOnSshHost({
        provider,
        connectionId,
        workspaces: await this.listSkillSshWorkspaces(connectionId)
      })
    }
    await this.deps.skillTransactionRecovery
    const runtimeId = this.deps.getStatus().runtimeId
    const [installs, worktrees] = await Promise.all([
      listManagedSkillInstalls(join(getAppEnvironment().getPath('userData'), 'skill-installs'), {
        observeReceipt: async (receipt) => {
          if (!receipt.wslDistro) {
            return nativeSkillInstallFilesystem.observeSkill(
              receipt.canonicalPath,
              receipt.fileModes
            )
          }
          const filesystem = new WslSkillInstallFilesystem(receipt.wslDistro, [
            dirname(receipt.canonicalPath)
          ])
          return filesystem.observeSkill(receipt.canonicalPath, receipt.fileModes)
        }
      }),
      this.deps.listResolvedWorktrees()
    ])
    const folderWorkspaces = this.deps.listFolderWorkspaces()
    return installs.flatMap((install): ManagedSkillInstall[] => {
      if (install.scope === 'global') {
        const wslPrefix = `global:${runtimeId}:wsl:`
        return [
          {
            ...install,
            destination: install.destinationIdentity.startsWith(wslPrefix)
              ? {
                  scope: 'global',
                  executionTarget: {
                    kind: 'wsl',
                    distro: install.destinationIdentity.slice(wslPrefix.length)
                  }
                }
              : { scope: 'global' }
          }
        ]
      }
      const worktree = worktrees.find(
        (candidate) => install.destinationIdentity === `workspace:${runtimeId}:${candidate.id}`
      )
      if (worktree) {
        return [{ ...install, destination: { scope: 'workspace', worktreeId: worktree.id } }]
      }
      const folder = folderWorkspaces.find(
        (candidate) => install.destinationIdentity === `workspace:${runtimeId}:${candidate.id}`
      )
      return folder
        ? [{ ...install, destination: { scope: 'workspace', folderWorkspaceId: folder.id } }]
        : []
    })
  }

  async publishDiscoveredSkillsFromAgent(
    request: AgentSkillShareRequest,
    discoveredSkills: readonly DiscoveredSkill[],
    signal?: AbortSignal
  ): Promise<AgentSkillShareOperation> {
    this.deps.assertAgentSkillSharingAllowed()
    if (this.agentSkillShareInProgress) {
      throw new AgentSkillSharingError(
        AGENT_SKILL_SHARING_BUSY_CODE,
        'Another agent skill bundle is being published. Wait for it to finish and try again.'
      )
    }

    this.agentSkillShareInProgress = true
    try {
      return await this.executeAgentSkillShare(request, discoveredSkills, signal)
    } finally {
      this.agentSkillShareInProgress = false
    }
  }

  private async executeAgentSkillShare(
    request: AgentSkillShareRequest,
    discoveredSkills: readonly DiscoveredSkill[],
    signal?: AbortSignal
  ): Promise<AgentSkillShareOperation> {
    const selectedSkills = selectDiscoveredSkills(discoveredSkills, request.skillSelectors)
    const operationRoot = join(
      getAppEnvironment().getPath('userData'),
      'agent-skill-share-operations'
    )
    const cloud = this.requireSkillCloudService()
    const preparations = new SkillSharePreparationService(
      operationRoot,
      {
        publishVersion: (input) => cloud.publishVersion(input),
        createShare: (packageId, input) => cloud.createShare(packageId, input)
      },
      {
        installStateDirectory: join(getAppEnvironment().getPath('userData'), 'skill-installs')
      }
    )
    let preparationId: string | null = null
    const cancel = (): void => {
      if (preparationId) {
        preparations.cancel(preparationId)
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('skill-share-cancelled')
      }
      const preview = await preparations
        .prepare({
          sources: selectedSkills.map((skill) => ({
            id: skill.name,
            sourceDirectory: skill.directoryPath
          })),
          bundleName: request.bundleName,
          description:
            selectedSkills.length === 1
              ? (selectedSkills[0].description ?? '')
              : `${selectedSkills.length} shared skills`
        })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            ['skill-package-skill-name-required', 'skill-package-skill-name-invalid'].includes(
              error.message
            )
          ) {
            throw new AgentSkillSharingError(
              AGENT_SKILL_NOT_SHAREABLE_CODE,
              'A selected skill cannot be shared. Its SKILL.md must declare a lowercase name containing only letters, numbers, and hyphens.'
            )
          }
          throw error
        })
      preparationId = preview.preparationId
      if (signal?.aborted) {
        throw signal.reason ?? new Error('skill-share-cancelled')
      }
      this.deps.assertAgentSkillSharingAllowed()
      const published = await preparations.publish({
        preparationId,
        releaseNotes: request.releaseNotes
      })
      return published.status === 'ok'
        ? {
            status: 'ok',
            value: {
              ...published.value,
              selectedSkills: selectedSkills.map(({ id, name, description }) => ({
                id,
                name,
                description
              }))
            }
          }
        : published
    } finally {
      signal?.removeEventListener('abort', cancel)
      await preparations.dispose()
    }
  }

  publishSkillPackage(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudPublishResult>> {
    return this.requireSkillCloudService().publish(request)
  }

  publishSkillPackageVersion(
    request: SkillCloudPublishRequest
  ): Promise<SkillCloudOperation<SkillCloudVersion>> {
    return this.requireSkillCloudService().publishVersion(request)
  }

  createSkillPackageShare(
    packageId: string,
    request: SkillCloudOptions & {
      pinnedVersionId?: string
      idempotencyKey?: string
    }
  ) {
    return this.requireSkillCloudService().createShare(packageId, request)
  }

  resolveSkillShare(
    shareId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<{ id: string; version: SkillCloudVersion }>> {
    return this.requireSkillCloudService().resolveShare(shareId, options)
  }

  createSkillDownloadGrant(
    shareId: string,
    options: SkillCloudOptions & {
      versionId?: string
      installTarget?: 'local' | 'remote'
    }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>> {
    return this.requireSkillCloudService().createDownloadGrant(shareId, options)
  }

  createSkillPackageVersionDownloadGrant(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions & { installTarget?: 'local' | 'remote' }
  ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>> {
    return this.requireSkillCloudService().createPackageVersionDownloadGrant(
      packageId,
      versionId,
      options
    )
  }

  getSkillPackage(
    packageId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<SkillCloudPackageDetails>> {
    return this.requireSkillCloudService().getPackage(packageId, options)
  }

  listOwnedSkillShares(options: SkillCloudOptions) {
    return this.requireSkillCloudService().listOwnedShares(options)
  }

  revokeSkillShare(
    shareId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.requireSkillCloudService().revokeShare(shareId, options)
  }

  deleteSkillPackageVersion(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.requireSkillCloudService().deleteVersion(packageId, versionId, options)
  }

  deleteSkillPackage(
    packageId: string,
    options: SkillCloudOptions
  ): Promise<SkillCloudOperation<void>> {
    return this.requireSkillCloudService().deletePackage(packageId, options)
  }
  beginSkillUpload(request: SkillUploadBeginRequest): Promise<{
    uploadId: string
    chunkBytes: number
    acknowledgedOffset: number
  }> {
    return this.requireSkillUploadSessions().begin(request)
  }

  appendSkillUploadChunk(
    request: SkillUploadChunkRequest
  ): Promise<{ acknowledgedOffset: number }> {
    return this.requireSkillUploadSessions().append(request)
  }

  commitSkillUpload(uploadId: string): Promise<{ uploadId: string }> {
    return this.requireSkillUploadSessions().commit(uploadId)
  }

  cancelSkillUpload(uploadId: string): Promise<void> {
    return this.requireSkillUploadSessions().cancel(uploadId)
  }

  listArtifacts(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.requireArtifactService().list(options)
  }

  getPublishedArtifactLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.requireArtifactService().getPublishedLink(request)
  }

  shareArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.requireArtifactService().share(request)
  }

  publishArtifact(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    return this.requireArtifactService().publish(request)
  }

  updateArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.requireArtifactService().update(request)
  }

  unshareArtifact(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.requireArtifactService().unshare(request)
  }

  deleteArtifact(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.requireArtifactService().delete(id, options)
  }

  private requireArtifactService(): ArtifactCloudService {
    if (!this.artifactService) {
      throw new Error('Artifact service is unavailable.')
    }
    return this.artifactService
  }

  private requireSkillCloudService(): SkillCloudService {
    if (!this.skillCloudService) {
      throw new Error('Skill Cloud service is unavailable.')
    }
    return this.skillCloudService
  }

  private requireSkillUploadSessions(): SkillUploadSessionService {
    if (this.skillUploadSessionsDisposed) {
      throw new Error('skill-upload-service-disposed')
    }
    this.skillUploadSessions ??= new SkillUploadSessionService(
      join(
        getAppEnvironment().getPath('userData'),
        'skill-installs',
        SKILL_UPLOAD_STAGING_ROOT_NAME
      )
    )
    return this.skillUploadSessions
  }

  async disposeSkillUploadSessions(): Promise<void> {
    this.skillUploadSessionsDisposed = true
    const sessions = this.skillUploadSessions
    this.skillUploadSessions = null
    await sessions?.dispose()
  }}
