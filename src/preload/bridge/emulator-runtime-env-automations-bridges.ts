import { ipcRenderer } from 'electron'
import { subscribeRuntimeEnvironmentFromPreload } from '../runtime-environment-subscriptions'
import type { RuntimeEnvironmentSubscriptionHandle } from '../runtime-environment-subscriptions'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../shared/remote-pairing-verification'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationRunsPage,
  AutomationRun,
  AutomationPrecheckResult
} from '../../shared/automations-types'
import type { ExternalAutomationManagerResult } from '../api/automation-api'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
} from '../../shared/external-automation-scope'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import type { PreloadApi } from '../api-types'

export const emulatorBridge: PreloadApi['emulator'] = {
  startFrameStream: (args: {
    streamUrl: string
    streamKey?: string
  }): Promise<{
    streamId: string
  }> => ipcRenderer.invoke('emulator:frameStreamStart', args),
  stopFrameStream: (args: { streamId: string }): Promise<void> =>
    ipcRenderer.invoke('emulator:frameStreamStop', args),
  onFrameStreamFrame: (
    callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; bytes: ArrayBuffer }
    ) => callback(data)
    ipcRenderer.on('emulator:frameStreamFrame', listener)
    return () => ipcRenderer.removeListener('emulator:frameStreamFrame', listener)
  },
  onFrameStreamError: (
    callback: (data: { streamId: string; message: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; message: string }
    ) => callback(data)
    ipcRenderer.on('emulator:frameStreamError', listener)
    return () => ipcRenderer.removeListener('emulator:frameStreamError', listener)
  },
  startVideoStream: (args: { deviceId: string; streamId: string }): Promise<{ streamId: string }> =>
    ipcRenderer.invoke('emulator:videoStreamStart', args),
  stopVideoStream: (args: { streamId: string }): Promise<void> =>
    ipcRenderer.invoke('emulator:videoStreamStop', args),
  onVideoStreamMeta: (
    callback: (data: {
      streamId: string
      deviceId: string
      meta: { codecId: string; width: number; height: number }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string
        deviceId: string
        meta: { codecId: string; width: number; height: number }
      }
    ) => callback(data)
    ipcRenderer.on('emulator:videoStreamMeta', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamMeta', listener)
  },
  onVideoStreamFrame: (
    callback: (data: {
      streamId: string
      deviceId: string
      config: boolean
      keyFrame: boolean
      bytes: ArrayBuffer
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string
        deviceId: string
        config: boolean
        keyFrame: boolean
        bytes: ArrayBuffer
      }
    ) => callback(data)
    ipcRenderer.on('emulator:videoStreamFrame', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamFrame', listener)
  },
  onPaneFocus: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
      callback(data)
    ipcRenderer.on('emulator:pane-focus', listener)
    return () => ipcRenderer.removeListener('emulator:pane-focus', listener)
  },
  onAutoAttach: (
    callback: (data: {
      worktreeId: string
      info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
      }
    ) => callback(data)
    ipcRenderer.on('ui:emulatorAutoAttach', listener)
    return () => ipcRenderer.removeListener('ui:emulatorAutoAttach', listener)
  }
}

export const runtimeEnvironmentsBridge: PreloadApi['runtimeEnvironments'] = {
  list: (): Promise<{
    environments: PublicKnownRuntimeEnvironment[]
    activeEnvironmentId: string | null
  }> => ipcRenderer.invoke('runtimeEnvironments:list'),
  setActive: (args: { id: string }): Promise<{ environment: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:setActive', args),
  addFromPairingCode: (args: {
    name: string
    pairingCode: string
  }): Promise<{ environment: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:addFromPairingCode', args),
  verifyAndAddFromPairingCode: (args: {
    name: string
    pairingCode: string
    allowLoopback?: boolean
  }): Promise<VerifyAndAddRuntimeEnvironmentResult> =>
    ipcRenderer.invoke('runtimeEnvironments:verifyAndAddFromPairingCode', args),
  resolve: (args: { selector: string }): Promise<PublicKnownRuntimeEnvironment> =>
    ipcRenderer.invoke('runtimeEnvironments:resolve', args),
  remove: (args: { selector: string }): Promise<{ removed: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:remove', args),
  disconnect: (args: {
    selector: string
  }): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> =>
    ipcRenderer.invoke('runtimeEnvironments:disconnect', args),
  connect: (args: {
    selector: string
    timeoutMs?: number
  }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
    ipcRenderer.invoke('runtimeEnvironments:connect', args),
  getStatus: (args: {
    selector: string
    timeoutMs?: number
  }): Promise<RuntimeRpcResponse<RuntimeStatus>> =>
    ipcRenderer.invoke('runtimeEnvironments:getStatus', args),
  prepareBrowserClientHostPlacement: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:prepareBrowserClientHostPlacement', args),
  retryConnectionsNow: (): Promise<void> =>
    ipcRenderer.invoke('runtimeEnvironments:retryConnectionsNow'),
  call: (args: {
    selector: string
    method: string
    params?: unknown
    timeoutMs?: number
    expectedEnvironmentPairingRevision?: number
  }): Promise<RuntimeRpcResponse<unknown>> => ipcRenderer.invoke('runtimeEnvironments:call', args),
  subscribe: async (
    args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
      expectedEnvironmentPairingRevision?: number
    },
    callbacks: {
      onResponse: (response: RuntimeRpcResponse<unknown>) => void
      onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
      onError?: (error: { code: string; message: string }) => void
      onClose?: () => void
    }
  ): Promise<RuntimeEnvironmentSubscriptionHandle> =>
    subscribeRuntimeEnvironmentFromPreload(ipcRenderer, args, callbacks)
}

export const automationsBridge: PreloadApi['automations'] = {
  listExternalManagerForOwner: (
    request: ScopedExternalManagerListRequest
  ): Promise<ExternalAutomationManagerResult> =>
    ipcRenderer.invoke('automations:listExternalManagerForOwner', request),
  listExternalRunsForOwner: (
    request: ScopedExternalManagerRunsRequest
  ): Promise<ExternalAutomationRunsPage> =>
    ipcRenderer.invoke('automations:listExternalRunsForOwner', request),
  createExternalForOwner: (request: ScopedExternalManagerCreateRequest): Promise<void> =>
    ipcRenderer.invoke('automations:createExternalForOwner', request),
  updateExternalForOwner: (request: ScopedExternalManagerUpdateRequest): Promise<void> =>
    ipcRenderer.invoke('automations:updateExternalForOwner', request),
  runExternalActionForOwner: (request: ScopedExternalManagerActionRequest): Promise<void> =>
    ipcRenderer.invoke('automations:runExternalActionForOwner', request),
  retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }): Promise<void> =>
    ipcRenderer.invoke('automations:retainExternalScopes', request),
  runPrecheck: (args: {
    automationId: string
    runId: string
  }): Promise<AutomationPrecheckResult | null> =>
    ipcRenderer.invoke('automations:runPrecheck', args),
  markDispatchResult: (result: AutomationDispatchResult): Promise<AutomationRun> =>
    ipcRenderer.invoke('automations:markDispatchResult', result),
  snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }): Promise<number> =>
    ipcRenderer.invoke('automations:snapshotWorkspaceName', args),
  rendererReady: (): Promise<void> => ipcRenderer.invoke('automations:rendererReady'),
  onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: AutomationDispatchRequest) =>
      callback(request)
    ipcRenderer.on('automations:dispatchRequested', listener)
    return () => ipcRenderer.removeListener('automations:dispatchRequested', listener)
  },
  onChanged: (callback: (payload: AutomationsChangedPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AutomationsChangedPayload) =>
      callback(payload)
    ipcRenderer.on('automations:changed', listener)
    return () => ipcRenderer.removeListener('automations:changed', listener)
  }
}
