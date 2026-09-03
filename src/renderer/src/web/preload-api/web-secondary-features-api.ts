import type { AutomationsApi } from '../../../../preload/api/automation-api'
import type { CrashReportsApi, FeedbackApi } from '../../../../preload/api/crash-report-api'
import type { DashboardApi, TerminalPreviewApi } from '../../../../preload/api/dashboard-api'
import type { DocPreviewApi } from '../../../../preload/api/doc-preview-api'
import type { EphemeralVmApi } from '../../../../preload/api/ephemeral-vm-api'
import type { ExportApi, FilesystemApi } from '../../../../preload/api/filesystem-api'
import type { PetApi } from '../../../../preload/api/pet-api'
import type { PluginHostListEntry, PluginsApi } from '../../../../preload/api/plugin-host-api'
import type { SpeechApi } from '../../../../preload/api/speech-api'
import type { LocalhostWorktreeLabelsApi } from '../../../../preload/api/workspace-port-api'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../../../shared/plugins/plugin-panel-bridge'
import { callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

export function createDocPreviewApi(): DocPreviewApi['docPreview'] {
  return {
    mintGrant: async (req) => ({
      grantId: 'grant-1',
      url: `/preview?root=${encodeURIComponent(req.root)}&entry=${encodeURIComponent(req.entryRelativePath)}`
    }),
    revokeGrant: async () => true,
    authorizeDirectory: async () => true,
    onExternalLink: () => noopUnsubscribe,
    onLoadFailure: () => noopUnsubscribe
  }
}

export function createSpeechDegradedApi(): SpeechApi {
  return {
    getCatalog: async () => [],
    getModelStates: async () => [],
    getOpenAiApiKeyStatus: async () => ({ configured: false }),
    saveOpenAiApiKey: async () => ({ configured: false }),
    clearOpenAiApiKey: async () => ({ configured: false }),
    downloadModel: async () => {},
    cancelDownload: async () => {},
    deleteModel: async () => {},
    startDictation: async () => {},
    feedAudio: async () => {},
    stopDictation: async () => {},
    onPartialTranscript: () => noopUnsubscribe,
    onFinalTranscript: () => noopUnsubscribe,
    onDownloadProgress: () => noopUnsubscribe,
    onReady: () => noopUnsubscribe,
    onStopped: () => noopUnsubscribe,
    onError: () => noopUnsubscribe
  }
}

export function createPetDegradedApi(): PetApi {
  return {
    import: async () => null,
    importPetBundle: async () => null,
    read: async () => null,
    delete: async () => {}
  }
}

export function createDashboardDegradedApi(): DashboardApi {
  return {
    openPopout: async (view) => {
      if (typeof window !== 'undefined') {
        window.open(view ? `/dashboard?view=${view}` : '/dashboard', '_blank')
      }
    },
    publishSnapshot: async () => {},
    getPopoutOpen: async () => false,
    onPopoutOpenChanged: () => noopUnsubscribe,
    onSnapshotRequested: () => noopUnsubscribe,
    onRevealAgent: () => noopUnsubscribe,
    onAckAgent: () => noopUnsubscribe,
    onSpawnAgent: () => noopUnsubscribe,
    onSleepWorkspace: () => noopUnsubscribe,
    requestSnapshot: async () => {},
    onSnapshot: () => noopUnsubscribe,
    onViewRequested: () => noopUnsubscribe,
    revealAgent: async () => {},
    ackAgent: async () => {},
    spawnAgent: async () => {},
    sleepWorkspace: async () => {}
  }
}

export function createTerminalPreviewDegradedApi(): TerminalPreviewApi {
  return {
    connect: async () => ({ snapshot: null, replay: [] }),
    input: async () => false,
    fit: async (_ptyId, cols, rows) => ({ cols, rows }),
    ack: async () => {},
    unsubscribe: async () => {},
    onData: () => noopUnsubscribe
  }
}

export function createLocalhostWorktreeLabelsDegradedApi(): LocalhostWorktreeLabelsApi {
  return {
    register: async (args) => ({ url: args.targetUrl, label: '' })
  }
}

export function createFeedbackDegradedApi(): FeedbackApi {
  return {
    submit: async () => ({ ok: true, imagesDelivered: false })
  }
}

export function createCrashReportsDegradedApi(): CrashReportsApi {
  return {
    getLatestPending: async () => null,
    getLatestReport: async () => null,
    dismiss: async () => null,
    recordRendererError: async () => ({ ok: false, error: 'unsupported' }),
    recordBreadcrumb: () => {},
    submit: async () => ({ ok: false, status: 0, error: 'unsupported' }),
    copyLatestDiagnostics: async () => ({ ok: false, error: 'unsupported' }),
    readHeapStatistics: () => null,
    readProcessMemory: async () => null
  }
}

export function createExportDegradedApi(): ExportApi {
  return {
    htmlToPdf: async () => {
      if (typeof window !== 'undefined') {
        window.print()
      }
      return { success: true, filePath: '' }
    }
  }
}

export function createNotebookDegradedApi(): FilesystemApi['notebook'] {
  return {
    runPythonCell: async () => ({
      stdout: '',
      stderr: 'Python notebook execution is unavailable in browser mode',
      exitCode: 1
    })
  }
}

export function createEphemeralVmDegradedApi(): EphemeralVmApi {
  return {
    listRecipes: async () => ({ status: 'ok', repoPath: null, recipes: [], diagnostics: [] }),
    listRecipeCatalog: async () => [],
    doctor: async (args) => ({ recipeId: args.recipeId, repoPath: '', ok: false, checks: [] }),
    provision: async () => ({
      ok: false,
      error: 'Ephemeral VMs are unsupported in browser mode',
      stderr: '',
      stdout: ''
    }),
    cancelProvision: async () => ({ cancelled: false }),
    onProvisionEvent: () => noopUnsubscribe,
    listRuntimes: async () => [],
    attachWorkspace: async () => {
      throw new Error('Ephemeral VMs are unsupported in browser mode')
    },
    suspendWorkspace: async () => null,
    resumeWorkspace: async () => null,
    cleanup: async () => {
      throw new Error('Ephemeral VMs are unsupported in browser mode')
    },
    stopCleanup: async () => {
      throw new Error('Ephemeral VMs are unsupported in browser mode')
    },
    getCleanupCommand: async () => ({
      runtimeId: '',
      command: null,
      payloadJson: '{}',
      cleanupDisabled: true
    })
  }
}

export function createAutomationsApi(): AutomationsApi {
  return {
    listExternalManagerForOwner: async () => ({
      manager: null,
      error: null,
      updatedAt: Date.now()
    }),
    listExternalRunsForOwner: async (args) => ({
      managerId: '',
      provider: args.provider,
      target: { type: 'local' },
      jobId: args.jobId,
      page: args.page,
      pageSize: args.pageSize,
      total: 0,
      runs: []
    }),
    createExternalForOwner: async () => {},
    updateExternalForOwner: async () => {},
    runExternalActionForOwner: async () => {},
    retainExternalScopes: async () => {},
    runPrecheck: async () => null,
    markDispatchResult: async () => {
      throw new Error('markDispatchResult unavailable in web client')
    },
    snapshotWorkspaceName: async () => Date.now(),
    rendererReady: async () => {},
    onDispatchRequested: () => noopUnsubscribe,
    onChanged: () => noopUnsubscribe
  }
}

export function createPluginsApi(): PluginsApi {
  return {
    list: async () => callRuntimeResult<PluginHostListEntry[]>('plugins.list'),
    listLanguagePacks: async () => [],
    consent: async (args) => callRuntimeResult<PluginHostListEntry[]>('plugins.consent', args),
    setEnabled: async (args) =>
      callRuntimeResult<PluginHostListEntry[]>('plugins.setEnabled', args),
    readPanelEntry: async (args) =>
      callRuntimeResult<PluginPanelEntry | null>('plugins.readPanelEntry', args),
    invokeCommand: async (args) => callRuntimeResult('plugins.invokeCommand', args),
    panelAction: async (args) =>
      callRuntimeResult<PluginPanelActionOutcome>('plugins.panelAction', args),
    install: async () => ({ ok: false, error: 'Plugin installation unavailable in web client' }),
    listMarketplaces: async () => [],
    addMarketplace: async () => {
      throw new Error('Unavailable in web client')
    },
    removeMarketplace: async () => [],
    refreshMarketplaces: async () => [],
    listMarketplacePlugins: async () => [],
    previewMarketplacePlugin: async () => {
      throw new Error('Unavailable in web client')
    },
    installMarketplacePlugin: async () => ({ ok: false, error: 'Unavailable in web client' }),
    previewMarketplaceUpdate: async () => {
      throw new Error('Unavailable in web client')
    },
    rollbackMarketplacePlugin: async () => ({ ok: false, error: 'Unavailable in web client' }),
    remove: async () => [],
    getLogs: async () => [],
    refresh: async () => callRuntimeResult<PluginHostListEntry[]>('plugins.list'),
    onChanged: () => noopUnsubscribe
  }
}
