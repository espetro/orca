import type { PreloadApi } from '../../../../preload/api-types'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { verifyRemotePairingRuntimeStatus } from '../../../../shared/remote-pairing-verification'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { parseWebPairingInput } from '../web-pairing'
import { WebRuntimeClient } from '../web-runtime-client'
import { isWebRuntimeUnauthorizedError } from '../web-runtime-client-error'
import {
  addEnvironmentOnServer,
  removeEnvironmentOnServer,
  syncEnvironmentsFromServer
} from '../web-environment-sync'
import {
  createStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment
} from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'
import { translateHostAccessLinkError } from '@/lib/remote-pairing-copy'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import {
  closeActiveRuntimeClients,
  subscribeWebRuntimeStatus,
  readWebRuntimeStatusSnapshots,
  observeWebRuntimeStatus,
  disconnectActiveRuntimeEnvironment,
  getClientForEnvironment,
  getStoredRuntimeEnvironmentById,
  listStoredRuntimeEnvironments,
  manuallyDisconnectedEnvironmentIds,
  removeStoredRuntimeEnvironment,
  resolveEnvironment,
  setActiveRuntimeEnvironment,
  upsertStoredRuntimeEnvironment,
  webRuntimeState
} from './web-runtime-session'

export function createRuntimeEnvironmentsApi(): NonNullable<
  Partial<PreloadApi>['runtimeEnvironments']
> {
  return {
    onStatusChanged: subscribeWebRuntimeStatus,
    getStatusSnapshots: async () => readWebRuntimeStatusSnapshots(),
    list: async () => {
      // Why: try the server-backed list first; older orcad builds without
      // environmentStore.* fall back to the localStorage registry untouched.
      try {
        await syncEnvironmentsFromServer()
      } catch {
        // fall through to local registry
      }
      return {
        environments: listStoredRuntimeEnvironments().map(redactStoredWebRuntimeEnvironment),
        activeEnvironmentId: webRuntimeState.activeEnvironment?.id ?? null
      }
    },
    addFromPairingCode: async ({ name, pairingCode }) => {
      const offer = parseWebPairingInput(pairingCode)
      if (!offer) {
        throw new Error('Invalid Orca pairing code.')
      }
      const nextEnvironment = createStoredWebRuntimeEnvironment({
        name,
        offer,
        previousEnvironment: webRuntimeState.activeEnvironment
      })
      upsertStoredRuntimeEnvironment(nextEnvironment)
      // Why: persist to the server store too so the CLI and other browsers see it.
      // Best-effort: the local registry already has the entry, so a server failure
      // must not block pairing.
      try {
        await addEnvironmentOnServer({ environment: nextEnvironment, pairingCode })
      } catch {
        // keep the locally paired environment usable
      }
      setActiveRuntimeEnvironment(nextEnvironment.id)
      return { environment: redactStoredWebRuntimeEnvironment(nextEnvironment) }
    },
    verifyAndAddFromPairingCode: async ({ name, pairingCode, allowLoopback }) => {
      const parsed = parseHostAccessLink(pairingCode)
      if (!parsed.ok) {
        return {
          ok: false,
          kind: 'access-link-invalid',
          message: translateHostAccessLinkError(parsed.kind)
        }
      }
      if (parsed.value.endpointKind === 'loopback' && !allowLoopback) {
        return {
          ok: false,
          kind: 'host-unreachable',
          message: translate(
            'auto.web.webPreloadApi.loopbackPairingBlocked',
            'This access link points back to this device.'
          )
        }
      }
      let client: WebRuntimeClient | null = null
      let runtimeStatus: RuntimeStatus
      try {
        client = new WebRuntimeClient(parsed.value.pairing)
        const response = (await client.call('status.get', undefined, {
          timeoutMs: 15_000
        })) as RuntimeRpcResponse<RuntimeStatus>
        if (!response.ok) {
          return {
            ok: false,
            kind: 'connection-interrupted',
            message: response.error.message
          }
        }
        const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
        if (!statusVerification.ok) {
          return statusVerification
        }
        runtimeStatus = statusVerification.runtimeStatus
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid public key')) {
          return {
            ok: false,
            kind: 'access-link-invalid',
            message: translate(
              'auto.web.webPreloadApi.remotePairingInvalidDetails',
              'This access link contains invalid connection details.'
            )
          }
        }
        if (
          isWebRuntimeUnauthorizedError(error) ||
          (error instanceof Error && error.message.startsWith('Unauthorized.'))
        ) {
          return {
            ok: false,
            kind: 'access-link-invalid',
            message: error.message
          }
        }
        return {
          ok: false,
          kind: 'host-unreachable',
          message: translate(
            'auto.web.webPreloadApi.remotePairingUnreachable',
            'Cannot reach Orca at {{endpoint}}.',
            { endpoint: parsed.value.displayEndpoint }
          )
        }
      } finally {
        client?.close()
      }
      const usesSshTunnel = parsed.value.endpointKind === 'loopback' && allowLoopback === true
      const nextEnvironment = {
        ...createStoredWebRuntimeEnvironment({
          name,
          offer: parsed.value.pairing,
          previousEnvironment: webRuntimeState.activeEnvironment,
          ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
        }),
        ...(runtimeStatus.pairedDeviceId ? { pairedDeviceId: runtimeStatus.pairedDeviceId } : {})
      }
      // Why: a browser storage failure must leave the currently active host usable.
      try {
        upsertStoredRuntimeEnvironment(nextEnvironment)
      } catch {
        return {
          ok: false,
          kind: 'environment-save-failed',
          message: translate(
            'auto.web.webPreloadApi.remotePairingSaveFailed',
            'Orca verified the host but could not save it. Check browser storage and try again.'
          )
        }
      }
      // Why: mirror to the server store when available; the verified pairing code is
      // exactly what the CLI stores, so both registries converge on the same record.
      try {
        await addEnvironmentOnServer({ environment: nextEnvironment, pairingCode })
      } catch {
        // the local pairing remains usable
      }
      setActiveRuntimeEnvironment(nextEnvironment.id)
      getClientForEnvironment(nextEnvironment).statusOwner?.acceptVerified({
        id: 'status.get',
        ok: true,
        result: runtimeStatus,
        _meta: { runtimeId: runtimeStatus.runtimeId }
      })
      return {
        ok: true,
        environment: redactStoredWebRuntimeEnvironment(nextEnvironment),
        runtimeStatus
      }
    },
    resolve: async ({ selector }) =>
      redactStoredWebRuntimeEnvironment(resolveEnvironment(selector)),
    setActive: async ({ id }) => {
      const environment = getStoredRuntimeEnvironmentById(id)
      if (!environment) {
        throw new Error(`Unknown Orca runtime environment: ${id}`)
      }
      return { environment: redactStoredWebRuntimeEnvironment(setActiveRuntimeEnvironment(id)) }
    },
    remove: async ({ selector }) => {
      // Why: active-first resolution, with a stored-env fallback so non-active hosts stay removable.
      let environment
      try {
        environment = resolveEnvironment(selector)
      } catch {
        environment = getStoredRuntimeEnvironmentById(selector)
      }
      if (!environment) {
        throw new Error(`Unknown Orca runtime environment: ${selector}`)
      }
      removeStoredRuntimeEnvironment(environment.id)
      try {
        await removeEnvironmentOnServer(environment.id)
      } catch {
        // local removal already applied; server may be older or offline
      }
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return { removed: redactStoredWebRuntimeEnvironment(environment) }
    },
    disconnect: async ({ selector }) => {
      let environment
      try {
        environment = resolveEnvironment(selector)
      } catch {
        // Why: per-env disconnect must work for non-active hosts too.
        environment = getStoredRuntimeEnvironmentById(selector)
      }
      if (!environment) {
        throw new Error(`Unknown Orca runtime environment: ${selector}`)
      }
      manuallyDisconnectedEnvironmentIds.add(environment.id)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        disconnectActiveRuntimeEnvironment()
      }
      return { disconnected: redactStoredWebRuntimeEnvironment(environment) }
    },
    connect: ({ selector, timeoutMs }) => {
      const environment = resolveEnvironment(selector)
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      closeActiveRuntimeClients()
      return callEnvironmentEnvelope<RuntimeStatus>(
        environment.id,
        'status.get',
        undefined,
        timeoutMs
      )
    },
    getStatus: ({ selector, timeoutMs, observeOnly }) =>
      observeOnly
        ? observeWebRuntimeStatus(selector, timeoutMs)
        : callEnvironmentEnvelope<RuntimeStatus>(selector, 'status.get', undefined, timeoutMs),
    retryControlConnection: () => Promise.resolve(),
    prepareBrowserClientHostPlacement: async () => ({ kind: 'server' }),
    call: ({ selector, method, params, timeoutMs }) =>
      callEnvironmentEnvelope(selector, method, params, timeoutMs),
    subscribe: async ({ selector, method, params, timeoutMs }, callbacks) => {
      const environment = resolveEnvironment(selector)
      const client = getClientForEnvironment(environment)
      const subscription = await client.subscribe(method, params, callbacks, { timeoutMs })
      if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
        subscription.unsubscribe()
        throw new Error('runtime_manually_disconnected')
      }
      return subscription
    }
  }
}
