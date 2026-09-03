import type { ProjectGroupsApi, ProjectsApi } from '../../../../preload/api/repository-api'
import type {
  WorkspaceCleanupApi,
  WorkspaceSpaceApi
} from '../../../../preload/api/workspace-cleanup-api'
import type { WorkspaceSessionApi } from '../../../../preload/api/workspace-session-api'
import type { FolderWorkspacesApi, SparsePresetsApi } from '../../../../preload/api/worktree-api'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import type {
  NestedRepoScanResult,
  ProjectGroup,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateResult
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import { callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

export function createProjectsApi(): ProjectsApi {
  return {
    list: async () => (await callRuntimeResult<{ projects: Project[] }>('project.list')).projects,
    update: async (args) =>
      (await callRuntimeResult<{ project: Project | null }>('project.update', args)).project,
    listHostSetups: async () =>
      (await callRuntimeResult<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')).setups,
    createHostSetup: async (args) =>
      (
        await callRuntimeResult<{ result: ProjectHostSetupCreateResult }>(
          'projectHostSetup.create',
          args
        )
      ).result,
    setupExistingFolder: async (args) =>
      (
        await callRuntimeResult<{ result: ProjectHostSetupResult }>(
          'projectHostSetup.setupExistingFolder',
          args
        )
      ).result,
    updateHostSetup: async (args) =>
      (
        await callRuntimeResult<{ result: ProjectHostSetupUpdateResult }>(
          'projectHostSetup.update',
          args
        )
      ).result,
    deleteHostSetup: async (args) =>
      (
        await callRuntimeResult<{ result: ProjectHostSetupDeleteResult }>(
          'projectHostSetup.delete',
          args
        )
      ).result
  }
}

export function createFolderWorkspacesApi(): FolderWorkspacesApi {
  return {
    list: async () =>
      (await callRuntimeResult<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list'))
        .folderWorkspaces,
    getPathStatus: async (args) =>
      (
        await callRuntimeResult<{ status: FolderWorkspacePathStatus }>(
          'folderWorkspace.getPathStatus',
          args
        )
      ).status,
    create: async (args) =>
      (
        await callRuntimeResult<{ folderWorkspace: FolderWorkspace }>(
          'folderWorkspace.create',
          args
        )
      ).folderWorkspace,
    update: async (args) =>
      (
        await callRuntimeResult<{ folderWorkspace: FolderWorkspace | null }>(
          'folderWorkspace.update',
          args
        )
      ).folderWorkspace,
    delete: async (args) => callRuntimeResult<boolean>('folderWorkspace.delete', args)
  }
}

export function createProjectGroupsApi(): ProjectGroupsApi {
  return {
    list: async () =>
      (await callRuntimeResult<{ groups: ProjectGroup[] }>('projectGroup.list')).groups,
    create: async (args) =>
      (await callRuntimeResult<{ group: ProjectGroup }>('projectGroup.create', args)).group,
    update: async (args) =>
      (await callRuntimeResult<{ group: ProjectGroup | null }>('projectGroup.update', args)).group,
    delete: async (args) => callRuntimeResult<boolean>('projectGroup.delete', args),
    moveProject: async (args) =>
      (
        await callRuntimeResult<{ repo: Repo | null }>('projectGroup.moveProject', {
          repo: args.projectId,
          groupId: args.groupId,
          order: args.order
        })
      ).repo,
    scanNested: async (args) =>
      callRuntimeResult<NestedRepoScanResult>('projectGroup.scanNested', args),
    cancelNestedScan: async () => false,
    onNestedScanProgress: () => noopUnsubscribe,
    importNested: async (args) =>
      callRuntimeResult<ProjectGroupImportResult>('projectGroup.importNested', args)
  }
}

export function createSparsePresetsApi(): SparsePresetsApi {
  return {
    list: async ({ repoId }) =>
      (await callRuntimeResult<{ presets: SparsePreset[] }>('repo.sparsePresets', { repo: repoId }))
        .presets,
    save: async () => {
      throw new Error('Sparse preset modifications are not supported in web client')
    },
    remove: async () => {
      throw new Error('Sparse preset removal is not supported in web client')
    },
    onChanged: () => noopUnsubscribe
  }
}

export function createWorkspaceCleanupApi(): WorkspaceCleanupApi {
  return {
    scan: async () => ({
      scannedAt: Date.now(),
      candidates: [],
      errors: []
    }),
    cancelScan: async () => false,
    getCachedScan: async () => null,
    dismiss: async () => {},
    clearDismissals: async () => {},
    hasKillableLocalProcesses: async () => ({ hasKillableProcesses: false, processes: [] })
  }
}

export function createWorkspaceSpaceApi(): WorkspaceSpaceApi {
  return {
    analyze: async () => ({
      ok: false,
      cancelled: true
    }),
    getCachedAnalysis: async () => null,
    cancel: async () => false,
    onProgress: () => noopUnsubscribe
  }
}

export function createRemoteWorkspaceDegradedApi(): WorkspaceSessionApi['remoteWorkspace'] {
  return {
    get: async () => null,
    setForConnectedTargets: async () => [],
    listEnabledConnectedTargets: async () => [],
    listConnectedClients: async () => [],
    clientId: async () => 'web-client',
    onChanged: () => noopUnsubscribe
  }
}

export {
  createAgentAwakeDegradedApi,
  createAgentTrustDegradedApi,
  createResourcesDegradedApi,
  createUsageApi
} from './web-agent-telemetry-api'

export {
  createAutomationsApi,
  createCrashReportsDegradedApi,
  createDashboardDegradedApi,
  createDocPreviewApi,
  createEphemeralVmDegradedApi,
  createExportDegradedApi,
  createFeedbackDegradedApi,
  createLocalhostWorktreeLabelsDegradedApi,
  createNotebookDegradedApi,
  createPetDegradedApi,
  createPluginsApi,
  createSpeechDegradedApi,
  createTerminalPreviewDegradedApi
} from './web-secondary-features-api'
