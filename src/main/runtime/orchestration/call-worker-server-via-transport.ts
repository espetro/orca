import { OrchestrationError } from './orchestration-error'
import {
  isOrchestrationMutation,
  orchestrationMigrationData
} from '../../../shared/orchestration-rpc-contract'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../../shared/protocol-version'
import type { RuntimeOrchestrationEnvelope } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import type { OrchestrationEnvironmentTransport } from './environment-transport'

export type CallOrchestrationWorkerServerArgs = {
  transport: OrchestrationEnvironmentTransport | null
  selector: string
  method: string
  params: unknown
  timeoutMs?: number
  envelope?: RuntimeOrchestrationEnvelope
  internal?: { contractVerified?: boolean }
}

export async function callOrchestrationWorkerServerViaTransport(
  args: CallOrchestrationWorkerServerArgs
): Promise<unknown> {
  const { transport, selector, method, params, timeoutMs, envelope, internal } = args
  if (!transport) {
    throw new OrchestrationError(
      'server_required',
      'Connected-server orchestration is unavailable in this runtime.'
    )
  }
  if (isOrchestrationMutation(method, params) && !internal?.contractVerified) {
    const statusResponse = await transport.call(selector, 'status.get', undefined, timeoutMs)
    if (statusResponse.ok === false) {
      throw new OrchestrationError(
        statusResponse.error.code,
        statusResponse.error.message,
        statusResponse.error.data
      )
    }
    const status = statusResponse.result as RuntimeStatus
    if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
      throw new OrchestrationError(
        'orchestration_migration_required',
        'The connected worker server does not support the current orchestration contract. No effects were applied.',
        orchestrationMigrationData('runtime_capability_missing')
      )
    }
  }
  const response = await transport.call(
    selector,
    method,
    params,
    timeoutMs,
    method.startsWith('orchestration.')
      ? { ...envelope, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
      : envelope
  )
  if (response.ok === false) {
    throw new OrchestrationError(response.error.code, response.error.message, response.error.data)
  }
  return response.result
}
